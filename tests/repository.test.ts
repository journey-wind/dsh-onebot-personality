import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, selectPersonality, STAGES } from '../src/config.js';
import { createSnapshot, fingerprint, inheritRoute } from '../src/llm/routes.js';
import type { FiveRoutes } from '../src/llm/routes.js';
import { emptyControlState, emptyLedger, memoryVersionKey } from '../src/storage/model.js';
import type { ControlState, DeletionLedger, Provenance } from '../src/storage/model.js';
import { ControlRepository, validateLedger } from '../src/storage/repository.js';
import type { ContentGuard, DurableCell } from '../src/storage/repository.js';

/** Test-only durable-cell simulation; production never falls back to this implementation. */
class FaultCell<T> implements DurableCell<T> {
  value: T;
  failNext = false;
  commits = 0;
  constructor(value: T) { this.value = structuredClone(value); }
  get(): T { return structuredClone(this.value); }
  async set(value: T): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error('INTERNAL_SECRET must not escape'); }
    this.value = structuredClone(value);
    this.commits++;
  }
}
function snapshot() {
  const config = parseConfig();
  const persona = selectPersonality(config, 'group', '300');
  const routes = Object.fromEntries(STAGES.map(stage => [stage,
    inheritRoute(persona.models[stage], config.models[stage], { provider: 'mock', model: stage }, stage),
  ])) as FiveRoutes;
  return createSnapshot(config, persona, routes, 'config-1');
}
const provenance: Provenance = { complete: true, sourceRefs: [{ sourceId: 's1', sourceEpoch: 1 }], messageKeys: ['m1'], dependencyVersions: [] };
async function fixture() {
  const control = new FaultCell<ControlState>(emptyControlState());
  const ledger = new FaultCell<DeletionLedger>(emptyLedger());
  const owner = { ownerId: 'owner-1', held: true, isHeld() { return this.held; } };
  const repo = await ControlRepository.open(control, ledger, owner, { now: 100 });
  await repo.transact({ kind: 'metadata', fence: repo.fence }, draft => {
    draft.configRevision = 'config-1';
    draft.sources.s1 = { sourceId: 's1', sourceEpoch: 1, botId: '100', personalityId: 'assistant-main',
      conversationType: 'group', conversationId: '300', allowed: true, forgotten: false };
    draft.banks.b1 = { bankKey: 'b1', botId: '100', personalityId: 'assistant-main', provisionMarker: 'bank-marker',
      state: 'ready', baseId: 'base1', revision: 0, generation: 0 };
  });
  const guard: ContentGuard = { kind: 'content', fence: repo.fence, botId: '100', personalityId: 'assistant-main', provenance };
  async function seed(externalWrite: 'settled' | 'in_flight' = 'settled') {
    const snap = snapshot();
    await repo.transact({ ...guard, newMessageKeys: ['m1'] }, draft => {
      draft.snapshots[snap.id] = snap;
      draft.messages.m1 = {
        key: 'm1', botId: '100', personalityId: 'assistant-main', conversationType: 'group', conversationId: '300',
        messageId: '1', sourceRef: { sourceId: 's1', sourceEpoch: 1 }, author: { kind: 'qq', qqId: '200' },
        eventTimeMs: 100, receivedAt: 100, sequence: 1, snapshotId: snap.id,
        bodyHash: fingerprint('PRIVATE_SECRET'), text: 'PRIVATE_SECRET', sanitizedEventJson: '{"text":"PRIVATE_SECRET"}', state: 'active',
      };
      draft.tasks.t1 = {
        taskId: 't1', kind: 'retain', bankKey: 'b1', snapshotId: snap.id, provenance,
        messageKey: 'm1', routeFingerprint: fingerprint(snap.routes.retain), state: 'pending', stage: 'ingress_committed',
        retryCount: 0, nextRunAt: 100, leaseToken: 0, attemptCount: 0, attemptCalls: 0,
        checkpoint: {}, calls: 0, reservedTokens: 0, failureCodes: [],
      };
      draft.memories[memoryVersionKey('raw1', 1)] = {
        memoryId: 'raw1', version: 1, botId: '100', personalityId: 'assistant-main', bankKey: 'b1', kind: 'raw', provenance,
        contentHash: fingerprint('PRIVATE_SECRET'), writeIntentId: 'i1', state: externalWrite === 'settled' ? 'active' : 'writing',
        vectorState: 'unknown', docId: 'doc1', text: 'PRIVATE_SECRET', active: externalWrite === 'settled', tombstoned: false, stale: false,
        createdAt: 100, entities: [],
      };
      if (externalWrite === 'settled') draft.activeMemory.raw1 = memoryVersionKey('raw1', 1);
      draft.intents.i1 = {
        intentId: 'i1', bankKey: 'b1', memoryId: 'raw1', version: 1, marker: 'exact-marker',
        contentHash: fingerprint('PRIVATE_SECRET'), provenance, ownerFence: repo.fence,
        state: externalWrite === 'settled' ? 'active' : 'writing', externalWrite, text: 'PRIVATE_SECRET', docIds: ['doc1'], createdAt: 100,
      };
      draft.replies.r1 = {
        replyId: 'r1', messageKey: 'm1', snapshotId: snap.id, bankKey: 'b1', configRevision: 'config-1',
        authEpoch: 0, bindingRevision: 0, provenance, deadlineAt: 10000, state: 'prepared',
      };
      draft.segments.seg1 = { segmentId: 'seg1', replyId: 'r1', index: 0, provenance,
        bodyHash: fingerprint('PRIVATE_SECRET'), text: 'PRIVATE_SECRET', state: 'prepared' };
      draft.nextMessageSequence = 2;
    });
  }
  return { repo, control, ledger, owner, guard, seed };
}

test('ingress-related records publish in one aggregate commit and cannot be mutated through reads', async () => {
  const f = await fixture();
  const before = f.control.commits;
  await f.seed();
  assert.equal(f.control.commits, before + 1);
  assert.equal(f.repo.read().messages.m1?.text, 'PRIVATE_SECRET');
  assert.equal(Object.keys(f.repo.read().snapshots).length, 1);
  assert.ok(f.repo.read().tasks.t1);
  assert.throws(() => { f.repo.read().messages.m1!.text = 'mutated'; });
});

test('failed commit does not publish half an ingress and quarantines further operations', async () => {
  const f = await fixture();
  f.control.failNext = true;
  await assert.rejects(f.seed(), /control-commit-failed/);
  assert.deepEqual(f.control.value.messages, {});
  assert.deepEqual(f.control.value.tasks, {});
  assert.deepEqual(f.control.value.snapshots, {});
  assert.throws(() => f.repo.read(), /storage-unavailable/);
});

test('metadata callers cannot introduce plaintext or silently invalidate sources outside ledger', async () => {
  const f = await fixture();
  await f.seed();
  await assert.rejects(f.repo.transact({ kind: 'metadata', fence: f.repo.fence }, draft => {
    draft.messages.m1!.text = 'new body';
  }), /content-guard-required/);
  await assert.rejects(f.repo.transact({ kind: 'metadata', fence: f.repo.fence }, draft => {
    draft.sources.s1!.allowed = false;
  }), /source-invalidation-requires-ledger/);
  assert.equal(f.repo.read().messages.m1!.text, 'PRIVATE_SECRET');
});

test('forgiveness is not recovery: forgetting scrubs local copies and blocks late content writes', async () => {
  const f = await fixture();
  await f.seed();
  await f.repo.recordDeletion('forget-1', { kind: 'messages', messageKeys: ['m1'] });
  const state = f.repo.read();
  assert.equal(JSON.stringify(state).includes('PRIVATE_SECRET'), false);
  assert.equal(state.messages.m1!.state, 'forgotten');
  assert.equal(state.memories[memoryVersionKey('raw1', 1)]!.active, false);
  assert.equal(state.segments.seg1!.state, 'cancelled');
  assert.equal(state.forgetTasks['forget-1']!.state, 'blocked');
  await assert.rejects(f.repo.transact(f.guard, draft => { draft.messages.m1!.text = 'PRIVATE_SECRET'; }), /message-forgotten/);
  await assert.rejects(f.repo.transact({ kind: 'metadata', fence: f.repo.fence }, draft => { delete draft.forgottenMessages.m1; }), /tombstone-cannot-roll-back/);
  assert.equal(JSON.stringify(f.ledger.value).includes('PRIVATE_SECRET'), false);
});

test('ledger commit succeeds before failed projection, and next owner replays it before reads', async () => {
  const f = await fixture();
  await f.seed();
  f.control.failNext = true;
  await assert.rejects(f.repo.recordDeletion('forget-1', { kind: 'source', sourceId: 's1', throughEpoch: 1 }), /projection-commit-failed/);
  assert.equal(f.ledger.value.sequence, 1);
  assert.equal(f.control.value.ledgerSequence, 0);
  assert.throws(() => f.repo.read(), /storage-unavailable/);
  f.owner.held = false;
  const next = await ControlRepository.open(f.control, f.ledger, { ownerId: 'owner-2', isHeld: () => true });
  assert.equal(next.read().ledgerSequence, 1);
  assert.equal(JSON.stringify(next.read()).includes('PRIVATE_SECRET'), false);
  assert.equal(next.read().sources.s1!.sourceEpoch, 2);
  assert.ok(next.fence > f.repo.fence);
});

test('failed ledger append pauses rather than claiming forgotten; error details are not exposed', async () => {
  const f = await fixture();
  await f.seed();
  f.ledger.failNext = true;
  await assert.rejects(f.repo.recordDeletion('forget-1', { kind: 'messages', messageKeys: ['m1'] }), error => {
    assert.equal(String(error).includes('INTERNAL_SECRET'), false);
    return /deletion-ledger-commit-failed/.test(String(error));
  });
  assert.equal(f.ledger.value.sequence, 0);
  assert.throws(() => f.repo.read(), /storage-unavailable/);
});

test('projection computation failure after durable ledger also blocks all reads', async () => {
  const f = await fixture();
  await f.seed();
  await f.repo.transact({ kind: 'metadata', fence: f.repo.fence }, draft => { draft.authEpoch = Number.MAX_SAFE_INTEGER; });
  await assert.rejects(f.repo.recordDeletion('op1', { kind: 'messages', messageKeys: ['m1'] }), /counter-overflow/);
  assert.equal(f.ledger.value.sequence, 1);
  assert.equal(f.control.value.ledgerSequence, 0);
  assert.throws(() => f.repo.read(), /storage-unavailable/);
  assert.equal(f.repo.getHealth().state, 'blocked');
});

test('deletion operation IDs are idempotent and cannot be reused with a different target', async () => {
  const f = await fixture();
  await f.seed();
  await f.repo.recordDeletion('op1', { kind: 'messages', messageKeys: ['m1'] });
  await f.repo.recordDeletion('op1', { kind: 'messages', messageKeys: ['m1'] });
  assert.equal(f.ledger.value.sequence, 1);
  await assert.rejects(f.repo.recordDeletion('op1', { kind: 'messages', messageKeys: ['different'] }), /operation-conflict/);
});

test('unknown external writes prevent purged even with a completed enumeration claim', async () => {
  const f = await fixture();
  await f.seed('in_flight');
  await f.repo.recordDeletion('op1', { kind: 'source', sourceId: 's1', throughEpoch: 1 });
  assert.equal(f.repo.read().forgetTasks.op1!.externalWriteUnknown, true);
  await assert.rejects(f.repo.transact({ kind: 'metadata', fence: f.repo.fence }, draft => {
    const task = draft.forgetTasks.op1!;
    task.state = 'purged'; task.docIdsPending = []; task.externalWriteUnknown = false;
    task.purgeProof = { ledgerSequence: task.ledgerSequence, allBanksEnumerated: true, enumeratedAt: 200 };
  }), /external-write-not-settled/);
  assert.equal(f.repo.read().forgetTasks.op1!.state, 'blocked');
});

test('restart recovers retain checkpoint but never replays prepared or possibly submitted sends', async () => {
  const f = await fixture();
  await f.seed();
  await f.repo.transact(f.guard, draft => {
    const task = draft.tasks.t1!;
    task.state = 'running'; task.ownerId = f.owner.ownerId; task.fence = f.repo.fence; task.leaseUntil = 999999;
    task.checkpoint = { memoryIds: ['raw1'] }; task.calls = 2; task.retryCount = 1;
    draft.segments.seg1!.state = 'sending';
    draft.replies.r1!.state = 'sending';
  });
  f.owner.held = false;
  const next = await ControlRepository.open(f.control, f.ledger, { ownerId: 'owner-2', isHeld: () => true }, { now: 300 });
  assert.equal(next.read().tasks.t1!.state, 'retry');
  assert.deepEqual(next.read().tasks.t1!.checkpoint, { memoryIds: ['raw1'] });
  assert.equal(next.read().tasks.t1!.calls, 2);
  assert.equal(next.read().tasks.t1!.retryCount, 1);
  assert.equal(next.read().segments.seg1!.state, 'unknown');
  assert.equal(next.read().replies.r1!.state, 'unknown');
  await assert.rejects(f.repo.transact(f.guard, () => {}), /owner-fenced/);
});

test('rolled-back or tampered deletion watermarks block startup and explicit old-backup restore is refused', async () => {
  const f = await fixture();
  await f.seed();
  await f.repo.recordDeletion('op1', { kind: 'messages', messageKeys: ['m1'] });
  const tampered = structuredClone(f.ledger.value);
  tampered.entries[0]!.at++;
  assert.throws(() => validateLedger(tampered), /ledger-chain-invalid/);
  await assert.rejects(ControlRepository.open(f.control, new FaultCell(emptyLedger()), { ownerId: 'x', isHeld: () => true }), /ledger-rollback-detected/);
  await assert.rejects(ControlRepository.open(f.control, f.ledger, { ownerId: 'x', isHeld: () => true }, { restoreMode: true }), /safe-backup-restore-not-supported/);
});

test('forgetting wins the shared barrier before network submission and no send occurs', async () => {
  const f = await fixture();
  await f.seed();
  let sends = 0;
  const forgetting = f.repo.recordDeletion('op1', { kind: 'messages', messageKeys: ['m1'] });
  const sending = f.repo.commitAndSubmit(f.guard, draft => { draft.segments.seg1!.state = 'sending'; }, async () => { sends++; });
  await forgetting;
  await assert.rejects(sending, /message-forgotten/);
  assert.equal(sends, 0);
  assert.equal(f.repo.read().segments.seg1!.state, 'cancelled');
});

test('submitted network requests do not hold the barrier, and late success cannot recreate forgotten experience', async () => {
  const f = await fixture();
  await f.seed();
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  let sends = 0;
  const submitted = await f.repo.commitAndSubmit(f.guard, draft => {
    draft.segments.seg1!.state = 'sending';
    draft.replies.r1!.state = 'sending';
  }, () => { sends++; return pending; });
  assert.equal(sends, 1);
  await f.repo.recordDeletion('op1', { kind: 'messages', messageKeys: ['m1'] });
  assert.equal(f.repo.read().segments.seg1!.state, 'unknown');
  finish('confirmed');
  assert.equal(await submitted.completion, 'confirmed');
  await f.repo.transact({ kind: 'metadata', fence: f.repo.fence }, draft => {
    draft.segments.seg1!.state = 'succeeded';
    draft.segments.seg1!.qqMessageId = '500';
  });
  assert.equal(JSON.stringify(f.repo.read()).includes('PRIVATE_SECRET'), false);
  assert.equal(Object.values(f.repo.read().tasks).some(task => task.kind === 'experience'), false);
  await assert.rejects(f.repo.transact(f.guard, draft => { draft.segments.seg1!.text = 'PRIVATE_SECRET'; }), /message-forgotten/);
});

test('wrong fence, live config invalidation, asynchronous mutation and close reject future work', async () => {
  const f = await fixture();
  await f.seed();
  await assert.rejects(f.repo.transact({ ...f.guard, fence: f.repo.fence - 1 }, () => {}), /owner-fenced/);
  await assert.rejects(f.repo.transact({ ...f.guard, validateLive: () => false }, () => {}), /live-authorization-invalid/);
  await assert.rejects(f.repo.transact(f.guard, async () => 1), /async-transaction-not-allowed/);
  await f.repo.close();
  await f.repo.close();
  assert.throws(() => f.repo.read(), /owner-fenced/);
  assert.equal(f.control.value.ownerActive, false);
});
