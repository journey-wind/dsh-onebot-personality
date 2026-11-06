import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { encodePluginDocument, KnowledgeAdapter } from '../src/memory/knowledge.js';
import type { VerifiedPluginDocument } from '../src/memory/knowledge.js';
import { RecallEngine, validateCitations } from '../src/memory/recall.js';
import type { RecallPlan } from '../src/memory/recall.js';
import { LivePolicy } from '../src/policy/live.js';
import { bankKeyFor } from '../src/runtime/ingress.js';
import { memoryVersionKey } from '../src/storage/model.js';
import type { MemoryVersion, Provenance } from '../src/storage/model.js';
import { InMemoryKnowledge } from './helpers/knowledge.js';
import { runtimeFixture } from './helpers/runtime.js';

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
type ReadAdapter = Pick<KnowledgeAdapter, 'readAuthorizedDocuments'>;
const text = (value: string) => [{ type: 'text', data: { text: value } }];
async function admit(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await f.admit({ message: text('小忆 current complete input'), ...overrides });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') throw new Error('fixture admission failed');
  return result.messageKey;
}
function provenance(f: Fixture, messageKey: string): Provenance {
  const message = f.repository.read().messages[messageKey]!;
  return { complete: true, sourceRefs: [{ ...message.sourceRef }], messageKeys: [messageKey], dependencyVersions: [] };
}
interface MemoryInput {
  id: string; body: string; messageKey?: string; version?: number; kind?: MemoryVersion['kind'];
  entities?: string[]; eventStart?: number; eventEnd?: number; provenance?: Provenance;
}
async function setup(input: Record<string, unknown> = {}) {
  const f = await runtimeFixture(input);
  const messageKey = await admit(f);
  const message = f.repository.read().messages[messageKey]!;
  const bankKey = bankKeyFor(message.botId, message.personalityId);
  const service = new InMemoryKnowledge();
  const adapter = new KnowledgeAdapter(service);
  const record = f.repository.read().banks[bankKey]!;
  const bank = await adapter.provisionBank({ bankKey, provisionMarker: record.provisionMarker });
  await f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    draft.banks[bankKey]!.baseId = bank.baseId; draft.banks[bankKey]!.state = 'ready';
  });
  const identity = { selfId: '100', connectionEpoch: 'epoch-1' };
  const policy = new LivePolicy(f.repository, { readConfiguration: () => f.current, now: () => f.now,
    onebot: { identity, async getGroupMemberInfo(groupId, userId) {
      return { ...identity, groupId, userId, checkedAt: f.now };
    } },
  });
  const engineFor = (knowledge: ReadAdapter = adapter) => new RecallEngine(f.repository, knowledge, policy,
    { readConfiguration: () => f.current, now: () => f.now });
  async function add(inputs: MemoryInput[]): Promise<MemoryVersion[]> {
    const memories: MemoryVersion[] = inputs.map(input => {
      const sourceMessage = f.repository.read().messages[input.messageKey ?? messageKey]!;
      const p = input.provenance ?? provenance(f, sourceMessage.key);
      const version = input.version ?? 1;
      const encoded = encodePluginDocument({ memoryId: input.id, version, writeIntentId: `intent-${input.id}-${version}`,
        text: input.body, provenance: p });
      const docId = `doc-${input.id}-${version}`;
      service.docs.set(docId, { id: docId, baseId: bank.baseId, title: encoded.title, sourceType: 'text',
        rawText: encoded.content, charCount: encoded.content.length, chunkCount: 0, createdAt: f.now });
      return { memoryId: input.id, version, botId: sourceMessage.botId, personalityId: sourceMessage.personalityId,
        bankKey, kind: input.kind ?? 'world', provenance: p, contentHash: encoded.hash, writeIntentId: encoded.header.writeIntentId,
        state: 'active', vectorState: 'not_requested', docId, text: encoded.text, active: true, tombstoned: false,
        stale: false, createdAt: f.now, entities: input.entities ?? [],
        ...(input.eventStart === undefined ? {} : { eventStart: input.eventStart }),
        ...(input.eventEnd === undefined ? {} : { eventEnd: input.eventEnd }) };
    });
    // Explicit guarded test insertion; production writes/activation belong to BankCoordinator.
    const groups = new Map<string, MemoryVersion[]>();
    for (const memory of memories) {
      const identity = JSON.stringify(memory.provenance);
      const group = groups.get(identity) ?? []; group.push(memory); groups.set(identity, group);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      await f.repository.transact({ kind: 'content', fence: f.repository.fence, botId: first.botId,
        personalityId: first.personalityId, provenance: first.provenance }, draft => {
        for (const memory of group) {
          const previous = draft.activeMemory[memory.memoryId];
          if (previous) { draft.memories[previous]!.active = false; draft.memories[previous]!.state = 'superseded'; }
          const id = memoryVersionKey(memory.memoryId, memory.version);
          draft.memories[id] = memory; draft.activeMemory[memory.memoryId] = id;
        }
      });
    }
    service.calls.length = 0;
    return memories;
  }
  service.calls.length = 0;
  return { f, messageKey, bank, service, adapter, policy, engineFor, add };
}

test('empty authorized metadata performs zero knowledge calls, even with lexical/entity/time conditions', async () => {
  const s = await setup();
  const result = await s.engineFor().retrieve(s.messageKey, { queries: ['secret'], entities: ['secret'], timeRange: { start: -100, end: 100 } });
  assert.deepEqual(result.evidence, []);
  assert.equal(result.provenance, undefined);
  assert.deepEqual(s.service.calls, []);
  assert.equal(result.mode, 'local-lexical');
});

test('private bodies, entities and time metadata are never consulted by local lanes or evidence', async () => {
  const s = await setup();
  const privateKey = await admit(s.f, { message_type: 'private', message_id: 'private-secret' });
  await s.add([
    ...Array.from({ length: 101 }, (_, index) => ({ id: `public-${String(index).padStart(3, '0')}`, body: 'public unrelated' })),
    { id: 'public-match', body: 'PUBLIC needle', entities: ['public-seed'] },
    { id: 'private-secret', messageKey: privateKey, body: 'PRIVATE_SECRET needle needle', entities: ['public-seed', 'SECRET_EDGE'], eventStart: 0, eventEnd: 10 },
  ]);
  const originalRead = s.f.repository.read.bind(s.f.repository);
  const state = originalRead();
  const secretKey = memoryVersionKey('private-secret', 1);
  const secret = state.memories[secretKey]!;
  let secretAccess = 0;
  const secretProxy = new Proxy(secret, { get(target, property, receiver) {
    if (['text', 'entities', 'eventStart', 'eventEnd'].includes(String(property))) {
      secretAccess++; throw new Error('unauthorized metadata/body read');
    }
    return Reflect.get(target, property, receiver);
  } });
  const memories = new Proxy({ ...state.memories }, { get(target, property, receiver) {
    return property === secretKey ? secretProxy : Reflect.get(target, property, receiver);
  } });
  const projected = new Proxy({ ...state }, { get(target, property, receiver) {
    return property === 'memories' ? memories : Reflect.get(target, property, receiver);
  } });
  s.f.repository.read = () => { originalRead(); return projected; };
  const result = await s.engineFor().retrieve(s.messageKey,
    { queries: ['needle'], entities: ['SECRET_EDGE'], timeRange: { start: 0, end: 10 } });
  assert.equal(secretAccess, 0);
  assert.deepEqual(result.evidence.map(item => item.memoryId), ['public-match']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET'));
  assert.ok(!s.service.calls.includes('read:doc-private-secret-1'));
  assert.deepEqual(result.evidence[0]!.lanes, ['lexical']);
});

test('full authorized corpus over 100 finds an older target outside arbitrary first-100', async () => {
  const s = await setup();
  await s.add([
    ...Array.from({ length: 125 }, (_, index) => ({ id: `a-${String(index).padStart(3, '0')}`, body: 'ordinary recent unrelated text' })),
    { id: 'z-older-target', body: 'uniqueolderneedle original raw conversation', kind: 'raw' },
  ]);
  const result = await s.engineFor().retrieve(s.messageKey, { queries: ['uniqueolderneedle'] });
  assert.deepEqual(result.evidence.map(item => item.memoryId), ['z-older-target']);
  assert.equal(result.evidence[0]!.kind, 'raw');
  assert.deepEqual(s.service.calls.filter(call => call.startsWith('read:')), ['read:doc-z-older-target-1']);
  assert.deepEqual(result.provenance!.dependencyVersions, [{ memoryId: 'z-older-target', version: 1 }],
    'authorized local ranking bodies must NOT inflate model-input provenance');
});

test('raw evidence is usable without facts; no empty-query lexical filter drops graph/time-only evidence', async () => {
  const s = await setup();
  await s.add([
    { id: 'raw', body: 'casual ORIGINAL chatter with no extracted facts', kind: 'raw', entities: ['seed', 'bridge'] },
    { id: 'hop-only', body: 'NO LEXICAL MATCH indirect authorized record', entities: ['bridge'] },
    { id: 'time-only', body: 'historical event with no lexical overlap', eventStart: -200, eventEnd: -100 },
    { id: 'unknown-time', body: 'unknown event time, written now' },
  ]);
  const result = await s.engineFor().retrieve(s.messageKey,
    { queries: ['nonexistentquery'], entities: ['seed'], timeRange: { start: -200, end: -100 } });
  assert.deepEqual(new Set(result.evidence.map(item => item.memoryId)), new Set(['raw', 'hop-only', 'time-only']));
  assert.deepEqual(result.evidence.find(item => item.memoryId === 'raw')!.lanes, ['entity']);
  assert.deepEqual(result.evidence.find(item => item.memoryId === 'time-only')!.lanes, ['time']);
  assert.ok(result.evidence.every(item => item.memoryId !== 'unknown-time'));
});

test('independent lexical/entity/time RRF lanes each vote once and repeated queries never duplicate a memory', async () => {
  const s = await setup();
  await s.add([
    { id: 'all-lanes', body: 'needle', entities: ['seed'], eventStart: 0, eventEnd: 10 },
    { id: 'lexical-only', body: 'needle needle needle' },
    { id: 'entity-only', body: 'unrelated', entities: ['seed'] },
  ]);
  const one = await s.engineFor().retrieve(s.messageKey, { queries: ['needle'], entities: ['seed'], timeRange: { start: 0, end: 10 } });
  const repeated = await s.engineFor().retrieve(s.messageKey, { queries: ['needle', 'needle', 'needle'], entities: ['seed'], timeRange: { start: 0, end: 10 } });
  assert.equal(one.evidence[0]!.memoryId, 'all-lanes');
  assert.deepEqual(one.evidence[0]!.lanes, ['lexical', 'entity', 'time']);
  assert.equal(one.evidence[0]!.score, 1 / 62 + 1 / 61 + 1 / 61);
  assert.deepEqual(repeated.evidence, one.evidence);
  assert.equal(new Set(one.evidence.map(item => `${item.memoryId}:${item.version}`)).size, one.evidence.length);
});

test('a large pool remains capped at 100, and entity cooccurrence is confined to authorized records', async () => {
  const s = await setup();
  await s.add(Array.from({ length: 130 }, (_, index) => ({ id: `m-${String(index).padStart(3, '0')}`,
    body: 'needle', entities: ['seed', `edge-${index}`] })));
  const result = await s.engineFor().retrieve(s.messageKey, { queries: ['needle'], entities: ['seed'] });
  assert.equal(result.candidateCount, 100);
  assert.ok(s.service.calls.filter(call => call.startsWith('read:')).length <= 100);
  assert.ok(result.evidence.length <= 100);
  assert.ok(result.estimatedTokens <= result.tokenBudget);
});

test('evidence budget includes metadata, union provenance and explicit exact quote windows', async () => {
  const s = await setup();
  const body = 'long prefix '.repeat(5000) + 'needle EXACT QUOTE suffix';
  await s.add([{ id: 'long-raw', body, kind: 'raw' }]);
  const before = s.f.repository.read().messages[s.messageKey]!.text;
  const result = await s.engineFor().retrieve(s.messageKey, { queries: ['needle'] });
  assert.equal(result.evidence.length, 1);
  const item = result.evidence[0]!;
  assert.ok(item.snippet);
  assert.equal(item.text, body.slice(item.snippet.start, item.snippet.end));
  assert.equal(item.snippet.totalChars, body.length);
  assert.ok(item.text.includes('needle EXACT QUOTE'));
  const payload = { evidence: result.evidence, provenance: result.provenance };
  assert.equal(result.estimatedTokens, Buffer.byteLength(JSON.stringify(payload), 'utf8'));
  assert.ok(result.estimatedTokens <= 4096);
  assert.equal(s.f.repository.read().messages[s.messageKey]!.text, before, 'current input is never truncated or even consumed by engine');
  assert.deepEqual(result.provenance!.dependencyVersions, [{ memoryId: 'long-raw', version: 1 }]);
});

test('metadata that cannot fit is rejected as a whole, not silently removed from evidence', async () => {
  const s = await setup({ budgets: { evidenceMaxTokens: 128 } });
  await s.add([{ id: 'normal', body: 'needle tiny body' }]);
  const result = await s.engineFor().retrieve(s.messageKey, { queries: ['needle'] });
  assert.deepEqual(result.evidence, []);
  assert.equal(result.provenance, undefined);
  assert.ok(result.estimatedTokens <= result.tokenBudget);
});

test('active version replacement excludes old text and invalidates dependents of the old version', async () => {
  const s = await setup();
  await s.add([{ id: 'base', body: 'oldversionneedle' }]);
  const p = provenance(s.f, s.messageKey);
  await s.add([{ id: 'derived', body: 'derivedoldneedle', provenance: { ...p, dependencyVersions: [{ memoryId: 'base', version: 1 }] } }]);
  await s.add([{ id: 'base', version: 2, body: 'newversionneedle' }]);
  const old = await s.engineFor().retrieve(s.messageKey, { queries: ['oldversionneedle', 'derivedoldneedle'] });
  assert.deepEqual(old.evidence, []);
  assert.ok(!s.service.calls.includes('read:doc-base-1'));
  assert.ok(!s.service.calls.includes('read:doc-derived-1'));
  const current = await s.engineFor().retrieve(s.messageKey, { queries: ['newversionneedle'] });
  assert.deepEqual(current.evidence.map(item => [item.memoryId, item.version]), [['base', 2]]);
});

test('every selected input includes its own version and full transitive dependency closure', async () => {
  const s = await setup();
  const p = provenance(s.f, s.messageKey);
  await s.add([{ id: 'root', body: 'root ordinary' }]);
  await s.add([{ id: 'middle', body: 'middle ordinary', provenance: { ...p, dependencyVersions: [{ memoryId: 'root', version: 1 }] } }]);
  await s.add([{ id: 'selected', body: 'selectedneedle', provenance: { ...p, dependencyVersions: [
    { memoryId: 'root', version: 1 }, { memoryId: 'middle', version: 1 },
  ] } }]);
  const result = await s.engineFor().retrieve(s.messageKey, { queries: ['selectedneedle'] });
  assert.deepEqual(result.evidence.map(item => item.memoryId), ['selected']);
  assert.deepEqual(result.provenance!.dependencyVersions, [
    { memoryId: 'middle', version: 1 }, { memoryId: 'root', version: 1 }, { memoryId: 'selected', version: 1 },
  ]);
});

test('fabricated IDs/quotes, cross-ID quotes and unknown citation properties reject', async () => {
  const s = await setup();
  await s.add([{ id: 'raw', body: 'needle actual original quote', kind: 'raw' }]);
  const result = await s.engineFor().retrieve(s.messageKey, { queries: ['needle'] });
  const id = result.evidence[0]!.evidenceId;
  assert.deepEqual(validateCitations({ evidenceIds: [id], quotes: [{ evidenceId: id, quote: 'actual original' }] }, result.evidence),
    { evidenceIds: [id], quotes: [{ evidenceId: id, quote: 'actual original' }] });
  assert.throws(() => validateCitations({ evidenceIds: ['ev-fabricated'] }, result.evidence), /invalid-citations/);
  assert.throws(() => validateCitations({ evidenceIds: [id], quotes: [{ evidenceId: id, quote: 'fabricated content' }] }, result.evidence), /invalid-citations/);
  assert.throws(() => validateCitations({ evidenceIds: [], quotes: [{ evidenceId: id, quote: 'actual' }] }, result.evidence), /invalid-citations/);
  assert.throws(() => validateCitations({ evidenceIds: [id], docIds: ['model-chosen'] }, result.evidence), /invalid-citations/);
});

test('model plans cannot inject identity, bank or document IDs', async () => {
  const s = await setup();
  await s.add([{ id: 'raw', body: 'needle' }]);
  for (const forbidden of ['bank', 'bankKey', 'docIds', 'botId', 'personalityId', 'scope']) {
    await assert.rejects(s.engineFor().retrieve(s.messageKey, { queries: ['needle'], [forbidden]: 'model-input' } as RecallPlan), /invalid-recall-plan/);
  }
  assert.deepEqual(s.service.calls, []);
});

test('schema boundary normalizes explicit undefined optional plan fields, but rejects empty ranges', async () => {
  const s = await setup();
  await s.add([{ id: 'event', body: 'needle', eventStart: -100, eventEnd: 0 }]);
  const engine = s.engineFor();
  const ordinary = await engine.retrieve(s.messageKey, { queries: ['needle'] });
  const explicit = await engine.retrieve(s.messageKey,
    { queries: ['needle'], entities: undefined, timeRange: undefined } as unknown as RecallPlan);
  assert.deepEqual(explicit.evidence, ordinary.evidence);
  const startOnly = await engine.retrieve(s.messageKey,
    { queries: ['needle'], timeRange: { start: -100 } });
  const undefinedEnd = await engine.retrieve(s.messageKey,
    { queries: ['needle'], entities: undefined, timeRange: { start: -100, end: undefined } } as unknown as RecallPlan);
  assert.deepEqual(undefinedEnd.evidence, startOnly.evidence);
  const endOnly = await engine.retrieve(s.messageKey, { queries: ['needle'], timeRange: { end: 0 } });
  const undefinedStart = await engine.retrieve(s.messageKey,
    { queries: ['needle'], timeRange: { start: undefined, end: 0 } } as unknown as RecallPlan);
  assert.deepEqual(undefinedStart.evidence, endOnly.evidence);
  await assert.rejects(engine.retrieve(s.messageKey, { queries: ['needle'], timeRange: {} }), /invalid-recall-plan/);
  await assert.rejects(engine.retrieve(s.messageKey,
    { queries: ['needle'], timeRange: { start: undefined, end: undefined } } as unknown as RecallPlan), /invalid-recall-plan/);
});

test('local corpus hash mismatch fails closed, rather than returning unverified index text', async () => {
  const s = await setup();
  await s.add(Array.from({ length: 101 }, (_, index) => ({ id: `m-${index}`, body: 'needle' })));
  await s.f.repository.transact({ kind: 'content', fence: s.f.repository.fence, botId: '100',
    personalityId: s.f.personality().id, provenance: provenance(s.f, s.messageKey) }, draft => {
    draft.memories[memoryVersionKey('m-0', 1)]!.text = 'tampered secret content';
  });
  await assert.rejects(s.engineFor().retrieve(s.messageKey, { queries: ['needle'] }), /recall-local-index-integrity/);
  assert.deepEqual(s.service.calls, []);
});

function afterRead(adapter: KnowledgeAdapter, work: (documents: readonly VerifiedPluginDocument[]) => void | Promise<void>): ReadAdapter {
  return { async readAuthorizedDocuments(request) {
    const documents = await adapter.readAuthorizedDocuments(request);
    await work(documents);
    return documents;
  } };
}

test('membership proof expiry or member revocation after selected body read cancels return', async () => {
  for (const revoke of [false, true]) {
    const s = await setup();
    await s.add([{ id: 'group-evidence', body: 'needle' }]);
    const privateKey = await admit(s.f, { message_type: 'private', message_id: `private-${revoke}` });
    const wrapped = afterRead(s.adapter, () => {
      if (revoke) s.policy.invalidateMembers('300', '200');
      else s.f.advance(30_000);
    });
    await assert.rejects(s.engineFor(wrapped).retrieve(privateKey, { queries: ['needle'] }));
    assert.ok(s.service.calls.includes('read:doc-group-evidence-1'), 'invalidation is injected after the actual verified read');
  }
});

test('source revoke/forget, config mode tightening and version change during awaits cancel stale evidence', async () => {
  for (const operation of ['revoke', 'forget', 'tighten', 'version'] as const) {
    const s = await setup({ personalities: [{ id: 'assistant-main', name: '小忆', systemPrompt: 'main', visibility: 'fully-shared' }],
      security: { confirmSharedPrivateToGroups: true } });
    const [memory] = await s.add([{ id: 'evidence', body: 'needle' }]);
    const wrapped = afterRead(s.adapter, async () => {
      if (operation === 'revoke' || operation === 'forget') {
        const ref = memory!.provenance.sourceRefs[0]!;
        await s.f.repository.recordDeletion(`op-${operation}`, { kind: 'source', sourceId: ref.sourceId, throughEpoch: ref.sourceEpoch }, operation, s.f.now);
      } else if (operation === 'tighten') {
        await s.f.changeConfiguration({ ...s.f.current.config,
          personalities: [{ ...s.f.current.config.personalities[0]!, visibility: 'source-restricted' }] });
      } else await s.add([{ id: 'evidence', version: 2, body: 'new body' }]);
    });
    await assert.rejects(s.engineFor(wrapped).retrieve(s.messageKey, { queries: ['needle'] }), operation);
  }
});

test('public document header/hash/version/provenance are all checked through LivePolicy callback', async () => {
  for (const field of ['hash', 'version', 'source'] as const) {
    const s = await setup();
    await s.add([{ id: 'evidence', body: 'needle' }]);
    const wrapped: ReadAdapter = { async readAuthorizedDocuments(request) {
      const docs = structuredClone(await s.adapter.readAuthorizedDocuments(request));
      if (field === 'hash') docs[0]!.hash = 'f'.repeat(64);
      else if (field === 'version') docs[0]!.header.version++;
      else docs[0]!.header.provenance.sourceRefs[0]!.sourceEpoch++;
      await request.authorize(request.docIds, docs);
      return docs;
    } };
    await assert.rejects(s.engineFor(wrapped).retrieve(s.messageKey, { queries: ['needle'] }));
  }
});

for (const change of ['identity', 'revision', 'scope-live'] as const) {
  test(`recall final synchronous validator blocks ${change} changed in queued authorization microtask before public body read`, async () => {
    const s = await setup(); await s.add([{ id: 'evidence', body: 'needle private evidence' }]);
    let observed = s.f.current; let scopeLive = true; let authorizations = 0;
    const identity = { selfId: '100', connectionEpoch: 'epoch-1' };
    const policy = new LivePolicy(s.f.repository, { readConfiguration: () => observed, now: () => s.f.now,
      onebot: { identity, async getGroupMemberInfo(groupId, userId) { return { ...identity, groupId, userId, checkedAt: s.f.now }; } } });
    const adapter = new KnowledgeAdapter(s.service, { isLive: () => scopeLive });
    const wrapped: ReadAdapter = { readAuthorizedDocuments(request) {
      assert.equal(typeof request.validateLive, 'function', 'production recall must pass a separate synchronous validator');
      return adapter.readAuthorizedDocuments({ ...request, async authorize(ids, docs) {
        await request.authorize(ids, docs);
        if (++authorizations === 3) queueMicrotask(() => {
          if (change === 'scope-live') scopeLive = false;
          else observed = change === 'identity' ? { config: parseConfig(observed.config), revision: observed.revision }
            : { config: observed.config, revision: 'silent-local-revision' };
        });
      } });
    } };
    const engine = new RecallEngine(s.f.repository, wrapped, policy, { readConfiguration: () => observed, now: () => s.f.now });
    await assert.rejects(engine.retrieve(s.messageKey, { queries: ['needle'] }));
    assert.equal(authorizations, 3);
    assert.equal(s.service.calls.some(call => call.startsWith('read:')), false);
    assert.equal(s.service.calls.includes('add'), false);
  });
}

test('recall final synchronous authorization rejects pending original deletion while persisted metadata is still active', async () => {
  const s = await setup(); await s.add([{ id: 'evidence', body: 'needle' }]);
  const currentKey = await admit(s.f, { message_id: 'separate-current-input' });
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const set = s.f.ledger.set.bind(s.f.ledger);
  s.f.ledger.set = async value => { entered(); await gate; await set(value); };
  let deletion: Promise<string> | undefined; let authorizations = 0;
  const wrapped: ReadAdapter = { readAuthorizedDocuments(request) {
    return s.adapter.readAuthorizedDocuments({ ...request, async authorize(ids, docs) {
      await request.authorize(ids, docs);
      if (++authorizations === 3) {
        deletion = s.f.repository.recordDeletion('pending-recall-current', { kind: 'messages', messageKeys: [currentKey] }, 'forget', s.f.now);
        await waiting;
      }
    } });
  } };
  try {
    await assert.rejects(s.engineFor(wrapped).retrieve(currentKey, { queries: ['needle'] }));
    assert.equal(authorizations, 3);
    assert.equal(s.f.repository.read().messages[currentKey]!.state, 'active');
    assert.equal(s.service.calls.some(call => call.startsWith('read:')), false);
  } finally { release(); await deletion; }
});
