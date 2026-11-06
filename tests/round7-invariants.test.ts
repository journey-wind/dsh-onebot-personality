import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { DispatchDeferred, StageCaller } from '../src/llm/calls.js';
import { fingerprint } from '../src/llm/routes.js';
import { BankCoordinator, memoryIdFor } from '../src/memory/banks.js';
import { KnowledgeAdapter } from '../src/memory/knowledge.js';
import { RetainWorker } from '../src/memory/retain.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import { memoryVersionKey } from '../src/storage/model.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge, ManualDeadlines } from './helpers/knowledge.js';

async function fixture() {
  const f = await runtimeFixture(); await f.admit();
  const queue = new RetainTaskQueue(f.repository, { now: () => f.now }); const lease = await queue.claimNext(); assert.ok(lease);
  const guard = queue.guard(lease); const task = f.repository.read().tasks[lease.taskId]!;
  const service = new InMemoryKnowledge();
  const banks = new BankCoordinator(f.repository, new KnowledgeAdapter(service), { now: () => f.now, schedule: new ManualDeadlines().schedule });
  await banks.ensureBank(task.bankKey, guard);
  const plan = await banks.planVersion({ bankKey: task.bankKey, memoryId: memoryIdFor(task.bankKey, 'raw', 'r7'), operationKey: 'r7',
    kind: 'raw', text: 'private evidence', provenance: guard.provenance }, guard);
  await banks.writeVersion(plan, guard); await banks.activate(plan, guard);
  return { f, queue, lease, guard, task, service, banks, plan };
}

test('physical forget is bounded across passes and cannot declare purged with known remaining documents', async () => {
  const s = await fixture(); const original = [...s.service.docs.values()][0]!;
  for (const id of ['duplicate-a', 'duplicate-b', 'duplicate-c']) s.service.docs.set(id, { ...structuredClone(original), id });
  await s.f.repository.recordDeletion('batch-forget', { kind: 'messages', messageKeys: s.guard.provenance.messageKeys });
  assert.equal(await s.banks.purgeForget('batch-forget', 2), 'purging');
  assert.equal(s.service.docs.size, 2);
  const pending = s.f.repository.read().forgetTasks['batch-forget']!;
  assert.equal(pending.docIdsPending.length, 2); assert.equal(pending.externalWriteUnknown, false);
  assert.deepEqual(pending.errorCodes, ['physical-cleanup-pending']);
  assert.equal(pending.retries, 0, 'normal batching is not a failed retry');
  assert.equal(await s.banks.purgeForget('batch-forget', 2), 'purged');
  assert.equal(s.service.docs.size, 0);
});

test('one forget batch shares its deletion cap across multiple persona banks', async () => {
  const s = await fixture(); const config = structuredClone(s.f.current.config);
  config.allow.groupIds.push('301');
  config.personalities.push({ ...structuredClone(config.personalities[0]!), id: 'second-persona', name: '小月', aliases: [] });
  config.bindings.groups.push({ id: '301', personalityId: 'second-persona' }); await s.f.changeConfiguration(config);
  await s.f.admit({ group_id: '301', message_id: 'other-bank-message' });
  const lease = await s.queue.claimNext(); assert.ok(lease); const guard = s.queue.guard(lease);
  const task = s.f.repository.read().tasks[lease.taskId]!; await s.banks.ensureBank(task.bankKey, guard);
  const plan = await s.banks.planVersion({ bankKey: task.bankKey, memoryId: memoryIdFor(task.bankKey, 'raw', 'second'), operationKey: 'second',
    kind: 'raw', text: 'second persona body', provenance: guard.provenance }, guard);
  await s.banks.writeVersion(plan, guard); await s.banks.activate(plan, guard);
  assert.equal(s.service.docs.size, 2);
  await s.f.repository.recordDeletion('multi-bank-forget', { kind: 'messages',
    messageKeys: [...s.guard.provenance.messageKeys, ...guard.provenance.messageKeys] });
  assert.equal(await s.banks.purgeForget('multi-bank-forget', 1), 'purging'); assert.equal(s.service.docs.size, 1);
  assert.equal(s.f.repository.read().forgetTasks['multi-bank-forget']!.docIdsPending.length, 1);
  assert.equal(await s.banks.purgeForget('multi-bank-forget', 1), 'purged'); assert.equal(s.service.docs.size, 0);
});

test('orphan cleanup resumes a partially consumed task and never deletes its active canonical document', async () => {
  const s = await fixture(); const original = [...s.service.docs.values()][0]!;
  for (const id of ['zz-a', 'zz-b', 'zz-c']) s.service.docs.set(id, { ...structuredClone(original), id });
  await s.banks.reconcileBank(s.task.bankKey);
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(await s.banks.runCleanup(s.task.bankKey, 1), 1);
    assert.ok(s.service.docs.has(original.id));
  }
  assert.equal(s.service.docs.size, 1);
  assert.ok(s.f.repository.read().memories[memoryVersionKey(s.plan.memoryId, s.plan.version)]!.active);
  assert.ok(Object.values(s.f.repository.read().maintenance).filter(task => task.kind === 'orphan').every(task => task.state === 'done'));
});

test('admission deferral precedes durable lifetime charges and old deferred callbacks cannot reset a new lease', async () => {
  const s = await fixture(); let prepares = 0;
  const llm: Pick<LlmRuntime, 'prepareCall'> = { prepareCall: async () => { prepares++; throw new Error('must not dispatch'); } };
  const worker = new RetainWorker(s.f.repository, s.queue, s.banks, new StageCaller(llm), { signal: new AbortController().signal,
    now: () => s.f.now, admitCall: async () => { throw new DispatchDeferred('retain', s.f.now + 60_000); },
    derived: { markDirty: async () => { throw new Error('must not finish'); } } });
  await assert.rejects(worker.run(s.lease), error => error instanceof DispatchDeferred);
  const before = s.f.repository.read().tasks[s.lease.taskId]!;
  assert.equal(before.calls, 0); assert.equal(before.reservedTokens, 0); assert.equal(before.retryCount, 0); assert.equal(prepares, 0);
  await s.queue.defer(s.lease, s.f.now + 60_000);
  assert.equal(s.f.repository.read().tasks[s.lease.taskId]!.retryCount, 0);
  s.f.advance(60_000); const next = await s.queue.claimNext(); assert.ok(next);
  const live = structuredClone(s.f.repository.read().tasks[next.taskId]);
  await s.queue.defer(s.lease, s.f.now + 1000);
  assert.deepEqual(s.f.repository.read().tasks[next.taskId], live);
});

test('derived scope/generated metadata persists and cannot be silently changed by same intent replay', async () => {
  const s = await fixture(); const revision = s.f.repository.read().banks[s.task.bankKey]!.revision;
  const input = { bankKey: s.task.bankKey, memoryId: memoryIdFor(s.task.bankKey, 'observation', 'scope'), operationKey: 'scope',
    kind: 'observation' as const, text: 'summary', provenance: s.guard.provenance, expectedBankRevision: revision,
    templateId: 'observation', scopeKey: 'scope-1', generatedAt: s.f.now, coveredRevision: 1 };
  const plan = await s.banks.planVersion(input, s.guard); await s.banks.writeVersion(plan, s.guard); await s.banks.activate(plan, s.guard);
  const memory = s.f.repository.read().memories[memoryVersionKey(plan.memoryId, plan.version)]!;
  assert.equal(memory.scopeKey, 'scope-1'); assert.equal(memory.generatedAt, s.f.now);
  await assert.rejects(s.banks.planVersion({ ...input, generatedAt: s.f.now + 1 }, s.guard), /write-intent-conflict/);
});

test('old-epoch source deletion does not remove the valid newer-epoch refresh intent', async () => {
  const s = await fixture(); const ref = s.guard.provenance.sourceRefs[0]!;
  await s.f.repository.recordDeletion('revoke-old', { kind: 'source', sourceId: ref.sourceId, throughEpoch: ref.sourceEpoch }, 'revoke');
  const admitted = await s.f.admit({ message_id: 'new-epoch' }); assert.equal(admitted.status, 'accepted');
  const lease = await s.queue.claimNext(); assert.ok(lease); const guard = s.queue.guard(lease);
  const task = s.f.repository.read().tasks[lease.taskId]!; const snapshot = s.f.repository.read().snapshots[task.snapshotId]!;
  const newEpoch = guard.provenance.sourceRefs[0]!.sourceEpoch;
  assert.ok(newEpoch > ref.sourceEpoch, 'revocation and reallow may each advance the epoch; it must never reuse the old one');
  await s.f.repository.transact(guard, draft => {
    draft.refresh['refresh-new'] = { key: 'refresh-new', bankKey: task.bankKey, sourceId: ref.sourceId,
      templateId: 'preferences', routeFingerprint: fingerprint(snapshot.routes.retain), snapshotId: task.snapshotId,
      dirtyRevision: 1, coveredRevision: 0, firstDirtyAt: s.f.now, nextRunAt: s.f.now + 60_000,
      scopeKey: 'new-epoch-scope', provenance: guard.provenance };
  });
  await s.f.repository.recordDeletion('forget-old', { kind: 'source', sourceId: ref.sourceId, throughEpoch: ref.sourceEpoch });
  assert.ok(s.f.repository.read().refresh['refresh-new']);
  assert.equal(s.f.repository.read().sources[ref.sourceId]!.allowed, true);
  assert.equal(s.f.repository.read().sources[ref.sourceId]!.sourceEpoch, newEpoch);
});
