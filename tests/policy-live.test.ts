import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { fingerprint } from '../src/llm/routes.js';
import { bankIdentity, encodePluginDocument, KnowledgeAdapter } from '../src/memory/knowledge.js';
import type { PublicKnowledgeService, VerifiedPluginDocument } from '../src/memory/knowledge.js';
import { OneBotClient } from '../src/onebot/client.js';
import type { OneBotSocket, VerifiedMember } from '../src/onebot/client.js';
import { LivePolicy } from '../src/policy/live.js';
import { bankKeyFor, sourceIdFor } from '../src/runtime/ingress.js';
import { memoryVersionKey } from '../src/storage/model.js';
import type { MemoryVersion, MessageRecord, Provenance, ReplyRecord } from '../src/storage/model.js';
import { runtimeFixture } from './helpers/runtime.js';

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
const text = (value: string) => [{ type: 'text', data: { text: value } }];
function rawProvenance(message: MessageRecord): Provenance {
  return { complete: true, sourceRefs: [{ ...message.sourceRef }], messageKeys: [message.key], dependencyVersions: [] };
}
function combine(...inputs: Provenance[]): Provenance {
  return { complete: true, sourceRefs: inputs.flatMap(p => p.sourceRefs), messageKeys: inputs.flatMap(p => p.messageKeys),
    dependencyVersions: inputs.flatMap(p => p.dependencyVersions) };
}
function currentReply(f: Fixture, messageKey: string): ReplyRecord {
  const reply = Object.values(f.repository.read().replies).find(item => item.messageKey === messageKey);
  assert.ok(reply);
  return structuredClone(reply);
}
async function admit(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await f.admit({ message: text('小忆 test input'), ...overrides });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') throw new Error('fixture admission failed');
  return result.messageKey;
}

/** In-process gateway, not a proof stub: exercises the actual fixed member action + no_cache. */
class FakeGateway implements OneBotSocket {
  readonly readyState = 1;
  readonly actions: { action: string; params: Record<string, unknown>; echo: string }[] = [];
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  memberReply: (params: Record<string, unknown>) => { status: string; retcode: number; data: unknown } = params => ({
    status: 'ok', retcode: 0, data: { group_id: params.group_id, user_id: params.user_id, nickname: 'UNTRUSTED NICKNAME' },
  });
  on(event: string, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set(); set.add(listener); this.listeners.set(event, set);
  }
  off(event: string, listener: (...args: unknown[]) => void): void { this.listeners.get(event)?.delete(listener); }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  send(data: string, callback: (error?: Error) => void): void {
    const action = JSON.parse(data) as { action: string; params: Record<string, unknown>; echo: string };
    this.actions.push(action); callback();
    const reply = action.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: '100' } }
      : this.memberReply(action.params);
    this.emit('message', JSON.stringify({ ...reply, echo: action.echo }), false);
  }
  ping(_data: string, callback: (error?: Error) => void): void { callback(); }
  terminate(): void {}
  get memberActions() { return this.actions.filter(action => action.action === 'get_group_member_info'); }
}
function policyFor(f: Fixture) {
  const gateway = new FakeGateway();
  const client = new OneBotClient({ enabled: true, wsUrl: 'ws://127.0.0.1:1', expectedSelfId: '100',
    socketFactory: () => gateway,
    clock: { now: () => f.now, random: () => 0.5, setTimeout: () => () => {} },
  });
  client.start(); gateway.emit('open');
  assert.equal(client.identity?.selfId, '100');
  const policy = new LivePolicy(f.repository, { readConfiguration: () => f.current, onebot: client, now: () => f.now });
  return { policy, client, gateway };
}

async function addMemory(f: Fixture, messageKey: string, memoryId: string, options: {
  version?: number; body?: string; provenance?: Provenance;
} = {}): Promise<MemoryVersion> {
  const message = f.repository.read().messages[messageKey]!;
  const bankKey = bankKeyFor(message.botId, message.personalityId);
  const provenance = options.provenance ?? rawProvenance(message);
  const version = options.version ?? 1;
  const encoded = encodePluginDocument({ memoryId, version, writeIntentId: `intent-${memoryId}-${version}`,
    provenance, text: options.body ?? `MARKER-${memoryId}` });
  await f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    const bank = draft.banks[bankKey]!; bank.state = 'ready'; bank.baseId = `base-${bankKey}`;
  });
  const memory: MemoryVersion = {
    memoryId, version, botId: message.botId, personalityId: message.personalityId, bankKey,
    kind: 'world', provenance, contentHash: encoded.hash, writeIntentId: encoded.header.writeIntentId,
    state: 'active', vectorState: 'not_requested', docId: `doc-${memoryId}-${version}`, text: encoded.text,
    active: true, tombstoned: false, stale: false, createdAt: f.now, entities: [],
  };
  await f.repository.transact({ kind: 'content', fence: f.repository.fence, botId: message.botId,
    personalityId: message.personalityId, provenance }, draft => {
    const oldKey = draft.activeMemory[memoryId];
    if (oldKey) { draft.memories[oldKey]!.active = false; draft.memories[oldKey]!.state = 'superseded'; }
    const key = memoryVersionKey(memoryId, version); draft.memories[key] = memory; draft.activeMemory[memoryId] = key;
  });
  return f.repository.read().memories[memoryVersionKey(memoryId, version)]!;
}
function withDependency(reply: ReplyRecord, memory: MemoryVersion): ReplyRecord {
  return { ...reply, provenance: combine(reply.provenance, memory.provenance,
    { complete: true, sourceRefs: [], messageKeys: [], dependencyVersions: [{ memoryId: memory.memoryId, version: memory.version }] }) };
}

async function fourSources() {
  const f = await runtimeFixture({ allow: { groupIds: ['300', '301'], privateUserIds: ['200', '201'] } });
  const group = await admit(f, { message_id: 'group-300' });
  const otherGroup = await admit(f, { message_id: 'group-301', group_id: '301' });
  const privateOwn = await admit(f, { message_id: 'private-200', message_type: 'private', user_id: '200' });
  const privateOther = await admit(f, { message_id: 'private-201', message_type: 'private', user_id: '201' });
  const memories = {
    group: await addMemory(f, group, 'group'), otherGroup: await addMemory(f, otherGroup, 'other-group'),
    privateOwn: await addMemory(f, privateOwn, 'private-own'), privateOther: await addMemory(f, privateOther, 'private-other'),
  };
  return { f, group, privateOwn, memories };
}

test('restricted group/private candidate privacy uses the real fixed uncached member action', async () => {
  const { f, group, privateOwn } = await fourSources();
  const { policy, gateway } = policyFor(f);
  const groupScope = await policy.captureScope(group);
  assert.equal(groupScope.requesterQQ, '200');
  assert.deepEqual(policy.candidates(groupScope).map(m => m.memoryId), ['group']);
  assert.equal(gateway.memberActions.length, 0);
  const privateScope = await policy.captureScope(privateOwn);
  assert.deepEqual(new Set(policy.candidates(privateScope).map(m => m.memoryId)), new Set(['group', 'other-group', 'private-own']));
  assert.deepEqual(gateway.memberActions.map(action => action.params), [
    { group_id: '300', user_id: '200', no_cache: true }, { group_id: '301', user_id: '200', no_cache: true },
  ]);
  const candidates = policy.candidates(privateScope);
  assert.ok(candidates.every(memory => !Object.hasOwn(memory, 'text')));
  await policy.captureScope(privateOwn);
  assert.equal(gateway.memberActions.length, 2, 'short positive cache avoids a second query');
});

test('fully shared explicitly confirmed mode may read private sources, never another persona or bot', async () => {
  const f = await runtimeFixture({ allow: { groupIds: ['300', '301'], privateUserIds: ['200'] },
    personalities: [
      { id: 'assistant-main', name: '小忆', systemPrompt: 'main', visibility: 'fully-shared' },
      { id: 'other', name: '小二', systemPrompt: 'other' },
    ], bindings: { groups: [{ id: '301', personalityId: 'other' }] }, security: { confirmSharedPrivateToGroups: true },
  });
  const group = await admit(f, { message_id: 'group' });
  const privateKey = await admit(f, { message_id: 'private', message_type: 'private' });
  const otherPersona = await admit(f, { message_id: 'other', group_id: '301', message: text('小二 input') });
  await addMemory(f, group, 'group'); await addMemory(f, privateKey, 'private'); await addMemory(f, otherPersona, 'other-persona');
  const original = f.repository.read().messages[group]!;
  const foreignKey = 'foreign-bot-message';
  const foreignSource = sourceIdFor('101', original.personalityId, 'group', '300');
  const foreignBank = bankKeyFor('101', original.personalityId);
  await f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    draft.sources[foreignSource] = { sourceId: foreignSource, sourceEpoch: 1, botId: '101', personalityId: original.personalityId,
      conversationType: 'group', conversationId: '300', allowed: true, forgotten: false };
    draft.banks[foreignBank] = { bankKey: foreignBank, botId: '101', personalityId: original.personalityId,
      provisionMarker: 'foreign-marker', state: 'unmapped', revision: 0, generation: 0 };
  });
  const foreignProvenance: Provenance = { complete: true, sourceRefs: [{ sourceId: foreignSource, sourceEpoch: 1 }],
    messageKeys: [foreignKey], dependencyVersions: [] };
  await f.repository.transact({ kind: 'content', fence: f.repository.fence, botId: '101', personalityId: original.personalityId,
    provenance: foreignProvenance, newMessageKeys: [foreignKey] }, draft => {
    draft.messages[foreignKey] = { ...original, key: foreignKey, botId: '101', sourceRef: foreignProvenance.sourceRefs[0]!,
      sequence: draft.nextMessageSequence++, messageId: 'foreign', text: 'OTHER BOT SECRET' };
  });
  await addMemory(f, foreignKey, 'other-bot');
  const { policy, gateway } = policyFor(f);
  const scope = await policy.captureScope(group);
  assert.deepEqual(policy.candidates(scope).map(memory => memory.memoryId), ['group', 'private']);
  const secondScope = await policy.captureScope(otherPersona);
  assert.deepEqual(policy.candidates(secondScope).map(memory => memory.memoryId), ['other-persona']);
  assert.equal(gateway.memberActions.length, 0);
});

test('forced authorization refreshes ONLY actual dependency groups and fails rather than reusing cache', async () => {
  const { f, privateOwn, memories } = await fourSources();
  const { policy, gateway } = policyFor(f);
  await policy.captureScope(privateOwn); // Both permitted groups now have positive cache entries.
  gateway.actions.length = 0;
  const reply = withDependency(currentReply(f, privateOwn), memories.group);
  const guard = await policy.authorizeReply(reply, true);
  assert.equal(guard.validateLive?.(), true);
  assert.deepEqual(gateway.memberActions.map(action => action.params.group_id), ['300']);
  assert.ok(guard.provenance.messageKeys.includes(privateOwn), 'current private input cannot be omitted');
  gateway.memberReply = () => ({ status: 'failed', retcode: 100, data: {} });
  await assert.rejects(policy.authorizeReply(reply, true), /live-authorization-invalid/);
  assert.equal(guard.validateLive?.(), false, 'forced failed observation fences previously captured guards');
  assert.deepEqual(gateway.memberActions.map(action => action.params.group_id), ['300', '300']);
});

test('zero member cache disables reuse but gives each fresh proof a bounded usable lifetime', async () => {
  const f = await runtimeFixture({ security: { membershipCacheMs: 0 } });
  const group = await admit(f, { message_id: 'cache-zero-group' });
  const privateKey = await admit(f, { message_id: 'cache-zero-private', message_type: 'private' });
  const memory = await addMemory(f, group, 'cache-zero-memory');
  const { policy, gateway } = policyFor(f);
  const reply = withDependency(currentReply(f, privateKey), memory);
  const first = await policy.authorizeReply(reply, false);
  assert.equal(gateway.memberActions.length, 1);
  f.advance(10);
  assert.equal(first.validateLive?.(), true, 'a durable intent taking more than 1ms must not invalidate a fresh observation');
  const second = await policy.authorizeReply(reply, false);
  assert.equal(gateway.memberActions.length, 2, 'cache zero queries again even while the first guard remains valid');
  assert.equal(first.validateLive?.(), true);
  assert.equal(second.validateLive?.(), true);
  await policy.authorizeReply(reply, true);
  const forced = await policy.authorizeReply(reply, true);
  assert.equal(gateway.memberActions.length, 4, 'every forced segment authorization remains a fresh query');
  assert.ok(gateway.memberActions.every(action => action.params.no_cache === true));
  f.advance(10);
  assert.equal(forced.validateLive?.(), true);
  f.advance(29_989);
  assert.equal(forced.validateLive?.(), true);
  f.advance(1);
  assert.equal(forced.validateLive?.(), false, 'fresh proof expires at 30 seconds despite cache reuse being disabled');
});

test('membership budget excludes unqueried groups and gateway mismatched IDs grant no membership', async () => {
  const f = await runtimeFixture({ allow: { groupIds: ['300', '301'], privateUserIds: ['200'] }, budgets: { membershipMaxQueries: 1 } });
  const g300 = await admit(f, { message_id: 'g300' });
  const g301 = await admit(f, { message_id: 'g301', group_id: '301' });
  const privateKey = await admit(f, { message_id: 'p200', message_type: 'private' });
  await addMemory(f, g300, 'g300'); await addMemory(f, g301, 'g301');
  const { policy, gateway } = policyFor(f);
  let scope = await policy.captureScope(privateKey);
  assert.deepEqual(policy.candidates(scope).map(m => m.memoryId), ['g300']);
  assert.equal(gateway.memberActions.length, 1);
  policy.invalidateMembers('300');
  gateway.memberReply = params => ({ status: 'ok', retcode: 0, data: { group_id: params.group_id, user_id: '999', nickname: '200' } });
  scope = await policy.captureScope(privateKey);
  assert.deepEqual(policy.candidates(scope), []);
  assert.equal(gateway.memberActions.length, 2);
});

test('member events invalidate both cached proofs and captured scopes/guards; proof expiry is synchronous', async () => {
  const { f, privateOwn, memories } = await fourSources();
  const { policy, gateway } = policyFor(f);
  const reply = withDependency(currentReply(f, privateOwn), memories.group);
  const guard = await policy.authorizeReply(reply, false);
  const scope = await policy.captureScope(privateOwn);
  policy.invalidateMembers('300', '200');
  assert.equal(guard.validateLive?.(), false);
  assert.throws(() => policy.candidates(scope), /live-authorization-invalid/);
  const refreshed = await policy.authorizeReply(reply, false);
  assert.equal(refreshed.validateLive?.(), true);
  const count = gateway.memberActions.length;
  f.advance(30_000);
  assert.equal(refreshed.validateLive?.(), false);
  await policy.authorizeReply(reply, false);
  assert.ok(gateway.memberActions.length > count);
});

test('rejects stale/wrong connection member API observations, not nicknames or user assertions', async () => {
  const { f, privateOwn, memories } = await fourSources();
  const identity = { selfId: '100', connectionEpoch: 'verified' };
  let checkedAt = f.now - 1;
  let epoch = 'verified';
  let calls = 0;
  const policy = new LivePolicy(f.repository, { readConfiguration: () => f.current, now: () => f.now,
    onebot: { identity, async getGroupMemberInfo(groupId, userId) {
      calls++; return { selfId: '100', connectionEpoch: epoch, groupId, userId, checkedAt };
    } },
  });
  const reply = withDependency(currentReply(f, privateOwn), memories.group);
  await assert.rejects(policy.authorizeReply(reply, true));
  checkedAt = f.now; epoch = 'old-connection';
  await assert.rejects(policy.authorizeReply(reply, true));
  assert.equal(calls, 2);
  epoch = 'verified';
  const guard = await policy.authorizeReply(reply, true);
  identity.connectionEpoch = 'different';
  assert.equal(guard.validateLive?.(), false);
});

test('an event during a member query prevents a late successful response from reviving authorization', async () => {
  const { f, privateOwn, memories } = await fourSources();
  let finish!: (member: VerifiedMember) => void;
  let calls = 0;
  const identity = { selfId: '100', connectionEpoch: 'verified' };
  const policy = new LivePolicy(f.repository, { readConfiguration: () => f.current, now: () => f.now,
    onebot: { identity, getGroupMemberInfo() {
      calls++;
      return new Promise<VerifiedMember>(resolve => { finish = resolve; });
    } },
  });
  const pending = policy.authorizeReply(withDependency(currentReply(f, privateOwn), memories.group), true);
  assert.equal(calls, 1);
  policy.invalidateMembers('300', '200');
  finish({ ...identity, groupId: '300', userId: '200', checkedAt: f.now });
  await assert.rejects(pending, /live-authorization-invalid/);
});

test('source epoch conflicts and unknown dependency versions fail closed', async () => {
  const f = await runtimeFixture();
  const key = await admit(f);
  const { policy } = policyFor(f);
  const reply = currentReply(f, key);
  const wrongEpoch = structuredClone(reply);
  wrongEpoch.provenance.sourceRefs[0]!.sourceEpoch++;
  await assert.rejects(policy.authorizeReply(wrongEpoch, true));
  const unknownVersion = structuredClone(reply);
  unknownVersion.provenance.dependencyVersions.push({ memoryId: 'not-current', version: 1 });
  await assert.rejects(policy.authorizeReply(unknownVersion, true));
  const guard = await policy.authorizeReply(reply, true);
  await f.repository.recordDeletion('revoke-epoch', { kind: 'source', sourceId: reply.provenance.sourceRefs[0]!.sourceId,
    throughEpoch: reply.provenance.sourceRefs[0]!.sourceEpoch }, 'revoke', f.now);
  assert.equal(guard.validateLive?.(), false);
});

test('original message and source always survive empty/subset reply provenance', async () => {
  const f = await runtimeFixture();
  const key = await admit(f);
  const { policy } = policyFor(f);
  const reply = currentReply(f, key);
  reply.provenance = { complete: true, sourceRefs: [], messageKeys: [], dependencyVersions: [] };
  const guard = await policy.authorizeReply(reply, true);
  assert.deepEqual(guard.provenance, rawProvenance(f.repository.read().messages[key]!));
  assert.equal(guard.validateLive?.(), true);
  const bad = { ...reply, authEpoch: reply.authEpoch - 1 };
  await assert.rejects(policy.authorizeReply(bad));
  await f.repository.recordDeletion('forget-original', { kind: 'messages', messageKeys: [key] }, 'forget', f.now);
  assert.equal(guard.validateLive?.(), false);
});

test('canonical anonymous group requester is null and has no member queries', async () => {
  const f = await runtimeFixture();
  const key = await admit(f, { anonymous: { id: 'anon-local-1', name: '200' }, sub_type: 'anonymous' });
  const { policy, gateway } = policyFor(f);
  const scope = await policy.captureScope(key);
  assert.equal(scope.requesterQQ, null);
  assert.equal((await policy.authorizeReply(currentReply(f, key), true)).validateLive?.(), true);
  assert.equal(gateway.memberActions.length, 0);
  const privateKey = await admit(f, { message_id: 'private', message_type: 'private' });
  await f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    draft.messages[privateKey]!.author = { kind: 'anonymous', localId: 'not-a-QQ' };
  });
  await assert.rejects(policy.captureScope(privateKey));
});

test('host config reference changes invalidate guards before repository reconciliation', async () => {
  const f = await runtimeFixture();
  const key = await admit(f);
  const { client } = policyFor(f);
  let observed = f.current;
  const policy = new LivePolicy(f.repository, { readConfiguration: () => observed, onebot: client, now: () => f.now });
  const guard = await policy.authorizeReply(currentReply(f, key), true);
  observed = { config: parseConfig(observed.config), revision: observed.revision };
  assert.equal(guard.validateLive?.(), false, 'same revision but a different config reference is not the captured context');
  observed = { config: parseConfig({ ...f.current.config, onebot: { ...f.current.config.onebot, enabled: false } }), revision: 'unreconciled' };
  await assert.rejects(policy.captureScope(key));
});

test('binding/config/auth changes never move old memories into a different persona', async () => {
  const f = await runtimeFixture({ personalities: [
    { id: 'assistant-main', name: '小忆', systemPrompt: 'main' }, { id: 'other', name: '小二', systemPrompt: 'other' },
  ] });
  const old = await admit(f, { message_id: 'old' });
  const memory = await addMemory(f, old, 'old-persona-memory');
  const { policy } = policyFor(f);
  const guard = await policy.authorizeReply(withDependency(currentReply(f, old), memory), true);
  await f.changeConfiguration({ ...f.current.config, bindings: { ...f.current.config.bindings,
    groups: [{ id: '300', personalityId: 'other' }] } });
  assert.equal(guard.validateLive?.(), false);
  await assert.rejects(policy.captureScope(old));
  const next = await admit(f, { message_id: 'next', message: text('小二 input') });
  const scope = await policy.captureScope(next);
  assert.deepEqual(policy.candidates(scope), []);
  assert.deepEqual(policy.recentWindow(next, scope), [], 'old persona inbound cannot follow a new binding');
  assert.equal(f.repository.read().memories[memoryVersionKey(memory.memoryId, 1)]!.personalityId, 'assistant-main');
});

test('dependency active-version replacement invalidates old guards without a source epoch change', async () => {
  const f = await runtimeFixture();
  const key = await admit(f);
  const memory = await addMemory(f, key, 'versioned');
  const { policy } = policyFor(f);
  const guard = await policy.authorizeReply(withDependency(currentReply(f, key), memory), true);
  await addMemory(f, key, 'versioned', { version: 2, body: 'new current version' });
  assert.equal(guard.validateLive?.(), false);
  await assert.rejects(policy.authorizeReply(withDependency(currentReply(f, key), memory), true));
});

test('candidate authorization precedes body reads; empty docs perform zero knowledge service I/O', async () => {
  const { f, group, memories } = await fourSources();
  const { policy } = policyFor(f);
  const scope = await policy.captureScope(group);
  const bank = f.repository.read().banks[memories.group.bankKey]!;
  assert.ok(bank.baseId);
  const target = { bankKey: bank.bankKey, provisionMarker: bank.provisionMarker, baseId: bank.baseId };
  const serviceCalls: string[] = [];
  const authorizedBeforeRead = new Set<string>();
  const documents = new Map<string, ReturnType<typeof encodePluginDocument>>();
  for (const memory of Object.values(memories)) documents.set(memory.docId!, encodePluginDocument({
    memoryId: memory.memoryId, version: memory.version, writeIntentId: memory.writeIntentId,
    provenance: memory.provenance, text: memory.text!,
  }));
  const unexpected = () => { serviceCalls.push('unexpected'); throw new Error('unexpected service I/O'); };
  const service = {
    async whenReady() { serviceCalls.push('ready'); },
    listBases() { serviceCalls.push('bases'); return [{ id: bank.baseId, ...bankIdentity(target) }]; },
    getConfigFor() { serviceCalls.push('config'); return { autoRetrieve: false, injectUsagePrompt: false,
      autoRetrieveWeight: 0, embeddingProvider: 'none' }; },
    getDocument(docId: string) {
      serviceCalls.push(`body:${docId}`);
      assert.ok(authorizedBeforeRead.has(docId), 'candidate/source ACL must precede every body read');
      assert.equal(docId, memories.group.docId, 'private/other-group marker cannot be exposed to retrieval');
      const encoded = documents.get(docId)!;
      return { id: docId, baseId: bank.baseId, sourceType: 'text', title: encoded.title,
        rawText: encoded.content, rawTextTruncated: false, charCount: encoded.content.length };
    },
    createBase: unexpected, listDocuments: unexpected, addTextDocument: unexpected,
    readDocumentText: unexpected, deleteDocument: unexpected,
  } as unknown as PublicKnowledgeService;
  const adapter = new KnowledgeAdapter(service);
  const emptyScope = { ...scope, allowedSources: [] };
  policy.authorizeDocuments(emptyScope, []);
  assert.deepEqual(policy.candidates(emptyScope), []);
  assert.deepEqual((await adapter.retrieveLexical({ bank: target, docIds: [], query: 'MARKER',
    authorize: (ids, docs) => policy.authorizeDocuments(emptyScope, ids, docs) })).hits, []);
  assert.deepEqual(serviceCalls, []);
  await assert.rejects(adapter.retrieveLexical({ bank: target, docIds: [memories.privateOwn.docId!], query: 'MARKER',
    authorize: (ids, docs) => policy.authorizeDocuments(scope, ids, docs) }));
  assert.deepEqual(serviceCalls, [], 'unknown/unauthorized candidate is rejected even before readiness');
  const result = await adapter.retrieveLexical({ bank: target, docIds: policy.candidates(scope).map(memory => memory.docId!), query: 'MARKER',
    authorize(ids, docs) { policy.authorizeDocuments(scope, ids, docs); ids.forEach(id => authorizedBeforeRead.add(id)); },
  });
  assert.equal(result.hits.length, 1);
  const doc: VerifiedPluginDocument = result.hits[0]!;
  assert.throws(() => policy.authorizeDocuments(scope, ['unknown-document']));
  assert.throws(() => policy.authorizeDocuments(scope, [doc.docId], [{ ...doc, header: { ...doc.header, version: 999 } }]));
  assert.throws(() => policy.authorizeDocuments(scope, [doc.docId], [{ ...doc, hash: 'f'.repeat(64) }]));
  assert.throws(() => policy.authorizeDocuments(scope, [doc.docId], [{ ...doc,
    header: { ...doc.header, provenance: memories.privateOwn.provenance } }]));
  await f.repository.recordDeletion('forget-after-body-read', { kind: 'messages', messageKeys: [group] }, 'forget', f.now);
  assert.throws(() => policy.authorizeDocuments(scope, [doc.docId], [doc]));
});

test('recent window uses committed pending-retain inbound, filters private-derived bot history and wrong binding', async () => {
  const f = await runtimeFixture({ personalities: [{ id: 'assistant-main', name: '小忆', systemPrompt: 'main', visibility: 'fully-shared' }],
    security: { confirmSharedPrivateToGroups: true }, budgets: { recentMessages: 100 } });
  const old = await admit(f, { message_id: 'old-group', message: text('小忆 public inbound still pending retain') });
  const privateKey = await admit(f, { message_id: 'private', message_type: 'private', message: text('private marker') });
  const oldReply = currentReply(f, old);
  const provenance = combine(rawProvenance(f.repository.read().messages[old]!), rawProvenance(f.repository.read().messages[privateKey]!));
  await f.repository.transact({ kind: 'content', fence: f.repository.fence, botId: '100', personalityId: 'assistant-main', provenance }, draft => {
    draft.replies[oldReply.replyId]!.provenance = provenance; draft.replies[oldReply.replyId]!.state = 'completed';
    draft.segments['old-success'] = { segmentId: 'old-success', replyId: oldReply.replyId, index: 0,
      provenance, bodyHash: fingerprint('PRIVATE-DERIVED ROBOT MARKER'), text: 'PRIVATE-DERIVED ROBOT MARKER', state: 'succeeded' };
    draft.segments['old-unknown'] = { segmentId: 'old-unknown', replyId: oldReply.replyId, index: 1,
      provenance, bodyHash: fingerprint('UNKNOWN ROBOT MARKER'), text: 'UNKNOWN ROBOT MARKER', state: 'unknown' };
  });
  const { policy } = policyFor(f);
  const sharedCurrent = await admit(f, { message_id: 'shared-current' });
  const sharedHistory = policy.recentWindow(sharedCurrent, await policy.captureScope(sharedCurrent));
  assert.ok(sharedHistory.some(entry => entry.segmentId === 'old-success'));
  assert.ok(sharedHistory.every(entry => entry.segmentId !== 'old-unknown'));
  assert.ok(Object.values(f.repository.read().tasks).every(task => task.state === 'pending'));
  await f.changeConfiguration({ ...f.current.config,
    personalities: [{ ...f.current.config.personalities[0]!, visibility: 'source-restricted' }] });
  const current = await admit(f, { message_id: 'restricted-current', message: text('小忆 FULL CURRENT INPUT MUST NOT BE TRUNCATED') });
  const history = policy.recentWindow(current, await policy.captureScope(current));
  assert.ok(history.some(entry => entry.messageKey === old && entry.role === 'user'));
  assert.ok(history.every(entry => entry.role === 'user' && !entry.text.includes('PRIVATE-DERIVED') && entry.messageKey !== current));
  await f.repository.recordDeletion('forget-recent-inbound', { kind: 'messages', messageKeys: [old] }, 'forget', f.now);
  // authEpoch changed, so old current reply/scope must be recaptured using a fresh admission.
  const next = await admit(f, { message_id: 'post-forget-current' });
  assert.ok(policy.recentWindow(next, await policy.captureScope(next)).every(entry => entry.messageKey !== old));
  assert.equal(f.repository.read().messages[current]!.text, '小忆 FULL CURRENT INPUT MUST NOT BE TRUNCATED');
});

test('recent window has a hard twenty-entry/byte limit and never waits for retain', async () => {
  const f = await runtimeFixture({ budgets: { recentMessages: 100, recentMaxBytes: 60 } });
  for (let index = 0; index < 25; index++) await admit(f, { message_id: `past-${index}`, message: text('abc') });
  const current = await admit(f, { message_id: 'current', message: text('小忆 complete current input') });
  const { policy } = policyFor(f);
  const history = policy.recentWindow(current, await policy.captureScope(current));
  assert.equal(history.length, 20);
  assert.equal(history.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text, 'utf8'), 0), 60);
  assert.ok(history.every(entry => entry.messageKey !== current));
});

test('deadline blocks online/forced output; only submitted false-force confirmation may create a late guard', async () => {
  const f = await runtimeFixture();
  const key = await admit(f);
  const { policy, client } = policyFor(f);
  const reply = currentReply(f, key);
  const guard = await policy.authorizeReply(reply, true);
  f.advance(f.current.config.budgets.onlineDeadlineMs);
  assert.equal(guard.validateLive?.(), false);
  await assert.rejects(policy.captureScope(key));
  await assert.rejects(policy.authorizeReply(reply, false));
  await f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => { draft.replies[reply.replyId]!.state = 'sending'; });
  const submitted = currentReply(f, key);
  assert.equal((await policy.authorizeReply(submitted, false)).validateLive?.(), true);
  await assert.rejects(policy.authorizeReply(submitted, true));
  client.dispose();
  await assert.rejects(policy.authorizeReply(submitted, false));
});

test('repository owner closure invalidates captured guards synchronously', async () => {
  const f = await runtimeFixture();
  const key = await admit(f);
  const { policy } = policyFor(f);
  const guard = await policy.authorizeReply(currentReply(f, key), true);
  await f.repository.close();
  assert.equal(guard.validateLive?.(), false);
});

test('synchronous document validator uses existing proofs and metadata only, rejecting expired or invalidated proof without remote refresh', async () => {
  const { f, privateOwn, memories } = await fourSources();
  const { policy, gateway } = policyFor(f);
  const scope = await policy.captureScope(privateOwn);
  const ids = [memories.group.docId!];
  const before = gateway.memberActions.length;
  assert.equal(policy.validateDocumentsLive(scope, ids), true);
  const memory = memories.group;
  const value = encodePluginDocument({ memoryId: memory.memoryId, version: memory.version,
    writeIntentId: memory.writeIntentId, provenance: memory.provenance, text: memory.text! });
  const doc: VerifiedPluginDocument = { docId: memory.docId!, baseId: f.repository.read().banks[memory.bankKey]!.baseId!,
    header: value.header, hash: value.hash, text: value.text };
  assert.equal(policy.validateDocumentsLive(scope, ids, [doc]), true);
  assert.equal(policy.validateDocumentsLive(scope, ids, [{ ...doc, hash: '0'.repeat(64) }]), false);
  assert.equal(policy.validateDocumentsLive(scope, ['unknown']), false);
  assert.equal(gateway.memberActions.length, before);
  f.advance(30_000);
  assert.equal(policy.validateDocumentsLive(scope, ids), false);
  assert.equal(gateway.memberActions.length, before, 'final synchronous check must never query to revive expired proofs');
});

for (const change of ['identity', 'revision'] as const) {
  test(`document validator rejects silent configuration ${change} replacement without a watcher`, async () => {
    const f = await runtimeFixture(); const key = await admit(f);
    const memory = await addMemory(f, key, 'silent-config-memory');
    const { client, gateway } = policyFor(f);
    let observed = f.current;
    const policy = new LivePolicy(f.repository, { readConfiguration: () => observed, onebot: client, now: () => f.now });
    const scope = await policy.captureScope(key); const ids = [memory.docId!];
    assert.equal(policy.validateDocumentsLive(scope, ids), true);
    const before = gateway.actions.length;
    observed = change === 'identity' ? { config: parseConfig(observed.config), revision: observed.revision }
      : { config: observed.config, revision: 'silent-local-revision' };
    assert.equal(policy.validateDocumentsLive(scope, ids), false);
    assert.equal(gateway.actions.length, before);
  });
}

test('document validator sees pending deletion before ledger/projection commit, including the current original input', async () => {
  const f = await runtimeFixture();
  const evidenceKey = await admit(f, { message_id: 'evidence-before-current' });
  const memory = await addMemory(f, evidenceKey, 'pending-delete-memory');
  const currentKey = await admit(f, { message_id: 'current-input' });
  const { policy, gateway } = policyFor(f);
  const scope = await policy.captureScope(currentKey); const ids = [memory.docId!];
  assert.equal(policy.validateDocumentsLive(scope, ids), true);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const set = f.ledger.set.bind(f.ledger);
  f.ledger.set = async value => { entered(); await gate; await set(value); };
  const operation = f.repository.recordDeletion('pending-original-delete', { kind: 'messages', messageKeys: [currentKey] }, 'forget', f.now);
  await waiting;
  try {
    const before = gateway.actions.length;
    assert.equal(f.repository.read().messages[currentKey]!.state, 'active', 'projection is intentionally still old');
    assert.equal(policy.validateDocumentsLive(scope, ids), false, 'pending original-input block is not in candidate provenance');
    assert.equal(gateway.actions.length, before);
  } finally { release(); await operation; }
});
