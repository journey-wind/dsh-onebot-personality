import test from 'node:test';
import assert from 'node:assert/strict';
import { BankCoordinator, memoryIdFor } from '../src/memory/banks.js';
import { EmbeddingRepairRunner } from '../src/memory/embedding-repair.js';
import { KnowledgeAdapter } from '../src/memory/knowledge.js';
import type { PreparedRepair } from '../src/memory/knowledge.js';
import { memoryVersionKey } from '../src/storage/model.js';
import type { ControlState } from '../src/storage/model.js';
import { ControlRepository } from '../src/storage/repository.js';
import { MaintenanceRunner } from '../src/runtime/maintenance.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge, ManualDeadlines } from './helpers/knowledge.js';

function gate<T = void>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function commitWhen(cell: Awaited<ReturnType<typeof runtimeFixture>>['control'], repository: ControlRepository,
  predicate: (value: ControlState) => boolean): Promise<void> {
  const done = gate(); const original = cell.set.bind(cell);
  cell.set = async value => { await original(value); if (predicate(value)) done.resolve(); };
  // Cell.set is still inside commitUnlocked: wait for its authoritative publication/ACK,
  // not merely the durable-cell hook or an arbitrary number of microtasks.
  return done.promise.then(() => repository.barrier.run(async () => {}));
}
async function fixture() {
  const runtime = await runtimeFixture(); await runtime.admit();
  const queue = new RetainTaskQueue(runtime.repository, { now: () => runtime.now });
  const lease = await queue.claimNext(); assert.ok(lease);
  const guard = queue.guard(lease); const task = runtime.repository.read().tasks[lease.taskId]!;
  const service = new InMemoryKnowledge(); service.configProvider = 'mock'; service.failEmbedding = true;
  const adapter = new KnowledgeAdapter(service); const timers = new ManualDeadlines();
  const banks = new BankCoordinator(runtime.repository, adapter, { now: () => runtime.now, schedule: timers.schedule });
  await banks.ensureBank(task.bankKey, guard);
  const plan = await banks.planVersion({ bankKey: task.bankKey, memoryId: memoryIdFor(task.bankKey, 'raw', 'repair'),
    operationKey: 'repair', kind: 'raw', text: 'PRIVATE_REPAIR_BODY', provenance: guard.provenance }, guard);
  await banks.writeVersion(plan, guard); await banks.activate(plan, guard);
  const memoryKey = memoryVersionKey(plan.memoryId, plan.version);
  const repair = Object.values(runtime.repository.read().maintenance).find(value => value.kind === 'embedding'); assert.ok(repair);
  let live = true;
  const runner = new EmbeddingRepairRunner(runtime.repository, adapter, { now: () => runtime.now, schedule: timers.schedule,
    isLive: () => live, signal: runtime.abort.signal });
  const maintenance = new MaintenanceRunner(runtime.repository, banks, { signal: runtime.abort.signal, now: () => runtime.now,
    isLive: () => live, embeddingRepair: runner });
  return { runtime, queue, lease, guard, task, service, adapter, timers, banks, plan, memoryKey, repair, runner, maintenance,
    revokeRoot: () => { live = false; }, get mutation() { return runtime.repository.read().maintenance[repair.taskId]!.mutation; } };
}

test('failed vector metadata schedules independent repair; successful exact rechunk repairs without append or pointer changes', async () => {
  const f = await fixture();
  const retainBefore = structuredClone(f.runtime.repository.read().tasks[f.lease.taskId]);
  const bankRevision = f.runtime.repository.read().banks[f.task.bankKey]!.revision;
  f.service.onReindex = (id, options) => {
    assert.deepEqual(options, { mode: 'rechunk' });
    assert.equal(f.mutation?.externalWrite, 'in_flight'); assert.equal(f.mutation?.generation, 1);
    assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.retries, 1);
    assert.ok(f.mutation?.provenance.dependencyVersions.some(dep => dep.memoryId === f.plan.memoryId && dep.version === f.plan.version));
    f.service.statuses.set(id, { embedded: true, status: 'completed' });
    return Promise.resolve(f.service.docs.get(id)!);
  };
  await f.maintenance.tick(10);
  const state = f.runtime.repository.read(); const work = state.maintenance[f.repair.taskId]!;
  assert.equal(state.memories[f.memoryKey]!.vectorState, 'ready'); assert.equal(work.state, 'done');
  assert.equal(work.mutation?.externalWrite, 'settled'); assert.equal(work.mutation?.outcome, 'fulfilled');
  assert.equal(state.activeMemory[f.plan.memoryId], f.memoryKey); assert.equal(state.banks[f.task.bankKey]!.revision, bankRevision);
  assert.deepEqual(state.tasks[f.lease.taskId], retainBefore);
  assert.equal(f.service.calls.filter(value => value === 'add').length, 1); assert.equal(f.service.reindexCalls.length, 1);
  assert.equal(JSON.stringify(work).includes('PRIVATE_REPAIR_BODY'), false);
  await f.runner.run(f.repair.taskId); assert.equal(f.service.reindexCalls.length, 1);
});

test('maintenance in metadataResult-to-activation gap defers without cost, then repairs the activated replacement', async () => {
  const f = await fixture();
  const replacement = await f.banks.planVersion({ bankKey: f.task.bankKey, memoryId: f.plan.memoryId, operationKey: 'pending-activation',
    kind: 'raw', text: 'REPLACEMENT_BODY', provenance: f.guard.provenance }, f.guard);
  await f.banks.writeVersion(replacement, f.guard);
  const task = Object.values(f.runtime.repository.read().maintenance).find(value => value.kind === 'embedding' && value.intentId === replacement.intentId)!;
  assert.ok(task);
  const beforeReads = f.service.calls.filter(value => value.startsWith('read:')).length;
  await f.runner.run(task.taskId);
  let work = f.runtime.repository.read().maintenance[task.taskId]!;
  assert.equal(work.state, 'retry'); assert.equal(work.retries, 0); assert.equal(work.mutation, undefined);
  assert.equal(f.service.calls.filter(value => value.startsWith('read:')).length, beforeReads);
  assert.equal(f.service.reindexCalls.length, 0);
  assert.equal(f.runtime.repository.read().activeMemory[f.plan.memoryId], f.memoryKey);
  await f.banks.activate(replacement, f.guard); f.runtime.advance(work.nextRunAt - f.runtime.now);
  await f.runner.run(task.taskId); work = f.runtime.repository.read().maintenance[task.taskId]!;
  assert.equal(work.state, 'done'); assert.equal(work.retries, 1); assert.equal(f.service.reindexCalls.length, 1);
  assert.equal(f.runtime.repository.read().activeMemory[f.plan.memoryId], memoryVersionKey(replacement.memoryId, replacement.version));
});

test('raw SDK rejection is positive termination and retries have separate durable cost/generation', async () => {
  const f = await fixture();
  f.service.onReindex = () => Promise.reject(new Error('PRIVATE_PROVIDER_CREDENTIAL'));
  await f.runner.run(f.repair.taskId);
  let work = f.runtime.repository.read().maintenance[f.repair.taskId]!;
  assert.equal(work.state, 'retry'); assert.equal(work.retries, 1); assert.equal(work.mutation?.outcome, 'rejected');
  const oldAttempt = work.mutation?.attemptId;
  assert.equal(JSON.stringify(work).includes('PRIVATE_PROVIDER_CREDENTIAL'), false);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.retryCount, 0);
  await f.runner.run(f.repair.taskId); assert.equal(f.service.reindexCalls.length, 1, 'not yet due');
  f.runtime.advance(work.nextRunAt - f.runtime.now); f.service.onReindex = undefined;
  await f.runner.run(f.repair.taskId); work = f.runtime.repository.read().maintenance[f.repair.taskId]!;
  assert.equal(work.state, 'done'); assert.equal(work.retries, 2); assert.equal(work.mutation?.generation, 2);
  assert.notEqual(work.mutation?.attemptId, oldAttempt); assert.equal(f.service.reindexCalls.length, 2);
});

test('synchronous SDK throw is invoked rejection, never an unsubmitted or unknown attempt', async () => {
  const f = await fixture();
  f.service.onReindex = () => { throw new Error('PRIVATE_PROVIDER_THROW'); };
  await f.runner.run(f.repair.taskId);
  assert.equal(f.mutation?.externalWrite, 'settled'); assert.equal(f.mutation?.outcome, 'rejected');
  assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.state, 'retry');
  assert.equal(f.service.reindexCalls.length, 1);
});

test('pending SDK timeout stays unknown/dead-letter and never resubmits despite marker reconciliation or absence', async () => {
  const f = await fixture(); const entered = gate(); const pending = gate<ReturnType<InMemoryKnowledge['getDocument']>>();
  f.service.onReindex = () => { entered.resolve(); return pending.promise; };
  const running = f.runner.run(f.repair.taskId); await entered.promise; f.timers.expireAll(); await running;
  assert.equal(f.mutation?.externalWrite, 'unknown');
  const saved = structuredClone(f.mutation);
  await f.runner.run(f.repair.taskId); await f.banks.reconcileBank(f.task.bankKey);
  await f.runner.run(f.repair.taskId);
  assert.deepEqual(f.mutation, saved); assert.equal(f.service.reindexCalls.length, 1);
  await f.runtime.repository.recordDeletion('timeout-forget', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  assert.equal(await f.banks.purgeForget('timeout-forget'), 'purging'); assert.equal(f.service.docs.size, 0);
  assert.equal(f.mutation?.externalWrite, 'unknown');
  const settled = commitWhen(f.runtime.control, f.runtime.repository, state => state.maintenance[f.repair.taskId]?.mutation?.externalWrite === 'settled');
  pending.reject(new Error('private reject')); await settled;
  assert.equal(f.mutation?.outcome, 'rejected'); assert.equal(await f.banks.purgeForget('timeout-forget'), 'purged');
});

test('forget after dispatch blocks purge until raw late success, which writes metadata only and cannot restore body/pointer', async () => {
  const f = await fixture(); const entered = gate(); const pending = gate<ReturnType<InMemoryKnowledge['getDocument']>>();
  const doc = structuredClone([...f.service.docs.values()][0]!);
  f.service.onReindex = () => { entered.resolve(); return pending.promise; };
  const running = f.runner.run(f.repair.taskId); await entered.promise;
  await f.runtime.repository.recordDeletion('in-flight-forget', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  assert.equal(f.runtime.repository.read().forgetTasks['in-flight-forget']!.externalWriteUnknown, true);
  assert.equal(await f.banks.purgeForget('in-flight-forget'), 'purging');
  f.service.docs.set(doc.id, doc); // Model an SDK late write after the first physical deletion.
  pending.resolve(doc); await running;
  assert.equal(f.mutation?.externalWrite, 'settled'); assert.equal(f.mutation?.outcome, 'fulfilled');
  assert.equal(f.runtime.repository.read().activeMemory[f.plan.memoryId], undefined);
  assert.equal(JSON.stringify(f.runtime.repository.read()).includes('PRIVATE_REPAIR_BODY'), false);
  assert.equal(f.runtime.repository.read().memories[f.memoryKey]!.vectorState, 'failed');
  assert.equal(await f.banks.purgeForget('in-flight-forget'), 'purged'); assert.equal(f.service.docs.size, 0);
  assert.equal(f.service.reindexCalls.length, 1);
});

test('forget before dispatch performs no repair or content preparation; source revocation also cancels safely', async () => {
  for (const action of ['forget', 'revoke'] as const) {
    const f = await fixture(); const beforeReads = f.service.calls.filter(value => value.startsWith('read:')).length;
    await f.runtime.repository.recordDeletion(`before-${action}`, { kind: 'messages', messageKeys: f.guard.provenance.messageKeys }, action);
    await f.runner.run(f.repair.taskId);
    assert.equal(f.service.reindexCalls.length, 0); assert.equal(f.mutation, undefined);
    assert.equal(f.service.calls.filter(value => value.startsWith('read:')).length, beforeReads);
    assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.state, 'dead-letter');
  }
});

test('root fence cancels local wait without canceling raw work; late same-owner settlement remains metadata only', async () => {
  const f = await fixture(); const entered = gate(); const pending = gate<ReturnType<InMemoryKnowledge['getDocument']>>();
  const doc = [...f.service.docs.values()][0]!;
  f.service.onReindex = () => { entered.resolve(); return pending.promise; };
  const running = f.runner.run(f.repair.taskId); await entered.promise;
  f.runtime.abort.abort(); await f.runner.stop(); await running;
  assert.equal(f.mutation?.externalWrite, 'unknown'); assert.equal(f.service.reindexCalls.length, 1);
  const settled = commitWhen(f.runtime.control, f.runtime.repository, state => state.maintenance[f.repair.taskId]?.mutation?.externalWrite === 'settled');
  pending.resolve(doc); await settled;
  assert.equal(f.mutation?.outcome, 'fulfilled');
  assert.equal(f.runtime.repository.read().memories[f.memoryKey]!.vectorState, 'failed');
  assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.state, 'dead-letter');
});

test('cold recovered in-flight becomes unknown and old closed-owner callback cannot confirm or resubmit it', async () => {
  const f = await fixture(); const entered = gate(); const pending = gate<ReturnType<InMemoryKnowledge['getDocument']>>();
  const doc = [...f.service.docs.values()][0]!;
  f.service.onReindex = () => { entered.resolve(); return pending.promise; };
  const running = f.runner.run(f.repair.taskId); await entered.promise;
  f.runner.fence(); await f.runtime.repository.close(); await assert.rejects(running);
  const next = await ControlRepository.open(f.runtime.control, f.runtime.ledger, { ownerId: 'new-owner', isHeld: () => true });
  const recovered = next.read().maintenance[f.repair.taskId]!;
  assert.equal(recovered.mutation?.externalWrite, 'unknown'); assert.equal(recovered.state, 'dead-letter');
  const runner = new EmbeddingRepairRunner(next, new KnowledgeAdapter(f.service));
  await runner.run(f.repair.taskId); assert.equal(f.service.reindexCalls.length, 1);
  pending.resolve(doc);
  // A deterministic barrier/microtask drain, not a timer or external polling operation.
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  assert.equal(next.read().maintenance[f.repair.taskId]!.mutation?.externalWrite, 'unknown');
  await next.recordDeletion('cold-forget', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  const banks = new BankCoordinator(next, new KnowledgeAdapter(f.service));
  assert.equal(await banks.purgeForget('cold-forget'), 'purging');
});

test('new active version fences old target and repair never reactivates old memory', async () => {
  const f = await fixture();
  f.service.failEmbedding = false;
  const replacement = await f.banks.planVersion({ bankKey: f.task.bankKey, memoryId: f.plan.memoryId, operationKey: 'replacement',
    kind: 'raw', text: 'NEW_VERSION', provenance: f.guard.provenance }, f.guard);
  await f.banks.writeVersion(replacement, f.guard); await f.banks.activate(replacement, f.guard);
  await f.runner.run(f.repair.taskId);
  assert.equal(f.service.reindexCalls.length, 0); assert.equal(f.mutation, undefined);
  assert.equal(f.runtime.repository.read().activeMemory[f.plan.memoryId], memoryVersionKey(replacement.memoryId, replacement.version));
  assert.equal(f.runtime.repository.read().memories[f.memoryKey]!.active, false);
});

test('version replacement while repair is in flight denies verification without restoring old pointer', async () => {
  const f = await fixture(); const entered = gate(); const pending = gate<ReturnType<InMemoryKnowledge['getDocument']>>();
  const doc = [...f.service.docs.values()][0]!;
  f.service.onReindex = () => { entered.resolve(); return pending.promise; };
  const running = f.runner.run(f.repair.taskId); await entered.promise;
  f.service.failEmbedding = false;
  const replacement = await f.banks.planVersion({ bankKey: f.task.bankKey, memoryId: f.plan.memoryId, operationKey: 'replacement',
    kind: 'raw', text: 'NEW_VERSION', provenance: f.guard.provenance }, f.guard);
  await f.banks.writeVersion(replacement, f.guard); await f.banks.activate(replacement, f.guard);
  pending.resolve(doc); await running;
  assert.equal(f.mutation?.outcome, 'fulfilled');
  assert.equal(f.runtime.repository.read().activeMemory[f.plan.memoryId], memoryVersionKey(replacement.memoryId, replacement.version));
  assert.equal(f.runtime.repository.read().memories[f.memoryKey]!.vectorState, 'failed');
});

test('metadata cannot create/replace repair identity, shrink provenance, clear unknown, or forge settlement/purged', async () => {
  const f = await fixture(); const entered = gate(); const pending = gate<ReturnType<InMemoryKnowledge['getDocument']>>();
  f.service.onReindex = () => { entered.resolve(); return pending.promise; };
  const running = f.runner.run(f.repair.taskId); await entered.promise; f.timers.expireAll(); await running;
  const metadata = { kind: 'metadata' as const, fence: f.runtime.repository.fence };
  await assert.rejects(f.runtime.repository.transact(metadata, draft => { delete draft.maintenance[f.repair.taskId]!.mutation; }), /history-cannot-be-deleted/);
  await assert.rejects(f.runtime.repository.transact(metadata, draft => { draft.maintenance[f.repair.taskId]!.mutation!.attemptId = 'replacement'; }), /unsettled-attempt-cannot-be-replaced/);
  await assert.rejects(f.runtime.repository.transact(metadata, draft => { draft.maintenance[f.repair.taskId]!.mutation!.provenance.dependencyVersions = []; }), /closure-cannot-shrink/);
  await assert.rejects(f.runtime.repository.transact(metadata, draft => { draft.maintenance[f.repair.taskId]!.mutation!.externalWrite = 'not_started'; }), /no-submission-proof-required|unknown-cannot-be-cleared/);
  await assert.rejects(f.runtime.repository.transact(metadata, draft => {
    const mutation = draft.maintenance[f.repair.taskId]!.mutation!;
    mutation.externalWrite = 'settled'; mutation.outcome = 'fulfilled'; mutation.settledAt = f.runtime.now;
  }), /raw-settlement-proof-required/);
  await f.runtime.repository.recordDeletion('forge-purge', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  await assert.rejects(f.runtime.repository.transact(metadata, draft => {
    const task = draft.forgetTasks['forge-purge']!; task.state = 'purged'; task.docIdsPending = []; task.externalWriteUnknown = false;
    task.purgeProof = { ledgerSequence: task.ledgerSequence, allBanksEnumerated: true, enumeratedAt: f.runtime.now };
  }), /external-write-not-settled/);
});

test('metadata cannot create even a body-free repair mutation without a content guard', async () => {
  const f = await fixture();
  await assert.rejects(f.runtime.repository.transact({ kind: 'metadata', fence: f.runtime.repository.fence }, draft => {
    draft.maintenance[f.repair.taskId]!.mutation = { attemptId: 'forged', generation: 1, memoryId: f.plan.memoryId, version: f.plan.version,
      contentHash: f.plan.contentHash, docId: draft.memories[f.memoryKey]!.docId!, ownerFence: f.runtime.repository.fence,
      provenance: { ...structuredClone(f.guard.provenance), dependencyVersions: [{ memoryId: f.plan.memoryId, version: f.plan.version }] },
      externalWrite: 'in_flight', startedAt: f.runtime.now };
  }), /content-guard-required/);
  assert.equal(f.service.reindexCalls.length, 0);
});

test('failed durable cost/in-flight commit cannot dispatch a zero-cost SDK call', async () => {
  const f = await fixture();
  f.runtime.control.failAtCommit = f.runtime.control.commits + 1;
  await assert.rejects(f.runner.run(f.repair.taskId), /storage-or-owner-unavailable/);
  assert.equal(f.service.reindexCalls.length, 0);
  assert.equal(f.runtime.control.value.maintenance[f.repair.taskId]!.retries, 0);
  assert.equal(f.runtime.control.value.maintenance[f.repair.taskId]!.mutation, undefined);
});

test('guard denied at prepared submit has positive no-invocation proof, not an unresolved write', async () => {
  const f = await fixture(); const actual = f.adapter.prepareRepair.bind(f.adapter);
  f.adapter.prepareRepair = async (...args) => {
    const prepared = await actual(...args);
    return { get docId() { return prepared.docId; }, get invoked() { return prepared.invoked; },
      submit: () => { f.revokeRoot(); return prepared.submit(); } } satisfies PreparedRepair;
  };
  await f.runner.run(f.repair.taskId);
  assert.equal(f.service.reindexCalls.length, 0); assert.equal(f.mutation?.externalWrite, 'not_started');
  assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.retries, 1);
  await f.runtime.repository.recordDeletion('not-invoked-forget', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  assert.equal(await f.banks.purgeForget('not-invoked-forget'), 'purged');
});

test('root invalidation between prepare and transaction prevents durable attempt and SDK mutation', async () => {
  const f = await fixture(); const actual = f.adapter.prepareRepair.bind(f.adapter);
  f.adapter.prepareRepair = async (...args) => { const prepared = await actual(...args); f.revokeRoot(); return prepared; };
  await f.runner.run(f.repair.taskId);
  assert.equal(f.service.reindexCalls.length, 0); assert.equal(f.mutation, undefined);
  assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.retries, 0);
});

test('prepare readiness wait is bounded and fencing clears its local timer without dispatch', async () => {
  const f = await fixture(); const entered = gate(); const pending = gate();
  f.service.whenReady = async () => { entered.resolve(); await pending.promise; };
  const running = f.runner.run(f.repair.taskId); await entered.promise; f.timers.expireAll(); await running;
  assert.equal(f.service.reindexCalls.length, 0); assert.equal(f.mutation, undefined);
  assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.state, 'dead-letter');
  pending.resolve();
});

test('successful SDK settlement alone cannot claim repaired vectors if metadata remains failed', async () => {
  const f = await fixture(); f.service.onReindex = id => Promise.resolve(f.service.docs.get(id)!);
  await f.runner.run(f.repair.taskId);
  assert.equal(f.mutation?.outcome, 'fulfilled'); assert.equal(f.mutation?.externalWrite, 'settled');
  assert.equal(f.runtime.repository.read().memories[f.memoryKey]!.vectorState, 'failed');
  assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.state, 'retry');
  assert.equal(f.runtime.repository.read().activeMemory[f.plan.memoryId], f.memoryKey);
});

test('pending/not-requested metadata does not schedule repairs and legacy no-adapter maintenance is explicit unsupported', async () => {
  const f = await fixture();
  const second = await f.banks.planVersion({ bankKey: f.task.bankKey, memoryId: memoryIdFor(f.task.bankKey, 'world', 'no-vector'),
    operationKey: 'no-vector', kind: 'world', text: 'NO_VECTOR_BODY', provenance: f.guard.provenance }, f.guard);
  f.service.failEmbedding = false; f.service.configProvider = 'none';
  await f.banks.writeVersion(second, f.guard); await f.banks.activate(second, f.guard);
  assert.equal(Object.values(f.runtime.repository.read().maintenance).filter(task => task.kind === 'embedding').length, 1);
  const maintenance = new MaintenanceRunner(f.runtime.repository, f.banks, { signal: f.runtime.abort.signal, now: () => f.runtime.now });
  await maintenance.tick(10);
  assert.equal(f.runtime.repository.read().maintenance[f.repair.taskId]!.state, 'dead-letter');
  assert.deepEqual(f.runtime.repository.read().maintenance[f.repair.taskId]!.errorCodes, ['embedding-repair-unavailable']);
  assert.equal(f.service.reindexCalls.length, 0);
});

test('optional missing public reindex capability is fixed unsupported and has no durable attempt cost', async () => {
  const f = await fixture();
  Object.defineProperty(f.service, 'reindexDocument', { value: undefined });
  await f.runner.run(f.repair.taskId);
  const task = f.runtime.repository.read().maintenance[f.repair.taskId]!;
  assert.equal(task.state, 'dead-letter'); assert.equal(task.retries, 0); assert.equal(task.mutation, undefined);
  assert.deepEqual(task.errorCodes, ['embedding-repair-unsupported']); assert.equal(f.service.reindexCalls.length, 0);
});
