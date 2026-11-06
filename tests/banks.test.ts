import test from 'node:test';
import assert from 'node:assert/strict';
import { BankCoordinator, memoryIdFor } from '../src/memory/banks.js';
import { KnowledgeAdapter, encodePluginDocument } from '../src/memory/knowledge.js';
import { memoryVersionKey } from '../src/storage/model.js';
import type { ControlState, MemoryVersion } from '../src/storage/model.js';
import { ControlRepository } from '../src/storage/repository.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge, ManualDeadlines } from './helpers/knowledge.js';

async function fixture(ensure = true) {
  const runtime = await runtimeFixture();
  await runtime.admit();
  const queue = new RetainTaskQueue(runtime.repository, { now: () => runtime.now });
  const lease = await queue.claimNext(); assert.ok(lease);
  const guard = queue.guard(lease);
  const task = runtime.repository.read().tasks[lease.taskId]!;
  const service = new InMemoryKnowledge();
  const adapter = new KnowledgeAdapter(service);
  const timers = new ManualDeadlines();
  const coordinator = new BankCoordinator(runtime.repository, adapter, { now: () => runtime.now, schedule: timers.schedule });
  if (ensure) await coordinator.ensureBank(task.bankKey, guard);
  const plan = (logicalKey: string, body = 'PRIVATE_MEMORY_BODY', kind: MemoryVersion['kind'] = 'raw', expectedBankRevision?: number) => coordinator.planVersion({
    bankKey: task.bankKey, memoryId: memoryIdFor(task.bankKey, kind, logicalKey), operationKey: logicalKey,
    kind, text: body, provenance: structuredClone(guard.provenance),
    ...(expectedBankRevision === undefined ? {} : { expectedBankRevision }),
  }, guard);
  return { runtime, queue, lease, guard, task, service, adapter, timers, coordinator, plan };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Observe deterministic fake durable commits, not a timer/sleep/poll. */
function commitWhen(cell: Awaited<ReturnType<typeof runtimeFixture>>['control'], predicate: (value: ControlState) => boolean): Promise<void> {
  const signal = deferred();
  const original = cell.set.bind(cell);
  cell.set = async value => { await original(value); if (predicate(value)) signal.resolve(); };
  return signal.promise;
}

test('concurrent first bank requests create exactly one proactive-off base and bind it durably', async () => {
  const f = await fixture(false);
  const [one, two] = await Promise.all([f.coordinator.ensureBank(f.task.bankKey, f.guard), f.coordinator.ensureBank(f.task.bankKey, f.guard)]);
  assert.equal(one.baseId, two.baseId);
  assert.equal(f.service.calls.filter(call => call === 'create').length, 1);
  assert.equal(f.runtime.repository.read().banks[f.task.bankKey]!.state, 'ready');
  assert.equal(f.service.bases[0]!.config?.autoRetrieve, false);
  assert.equal(f.service.calls.includes('add'), false);
});

test('uncertain old provisioning never causes a blind fresh base creation', async () => {
  const f = await fixture(false);
  await f.runtime.repository.transact({ kind: 'metadata', fence: f.runtime.repository.fence }, draft => {
    draft.banks[f.task.bankKey]!.state = 'reconciliation_required';
  });
  await assert.rejects(f.coordinator.ensureBank(f.task.bankKey, f.guard), /bank-provision-outcome-unknown/);
  assert.equal(f.service.calls.includes('create'), false);
});

test('write intent precedes public append, text_saved precedes guarded activation, repeated work is idempotent', async () => {
  const f = await fixture();
  const [one, two] = await Promise.all([f.plan('raw-1'), f.plan('raw-1')]);
  assert.deepEqual(one, two);
  assert.equal(Object.keys(f.runtime.repository.read().intents).length, 1);
  assert.equal(f.service.calls.includes('add'), false);
  f.service.beforeAdd = async () => {
    const intent = f.runtime.repository.read().intents[one.intentId]!;
    assert.equal(intent.externalWrite, 'in_flight');
    assert.equal(intent.state, 'writing');
    assert.equal(f.runtime.repository.read().activeMemory[one.memoryId], undefined);
  };
  await Promise.all([f.coordinator.writeVersion(one, f.guard), f.coordinator.writeVersion(two, f.guard)]);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
  assert.equal(f.runtime.repository.read().memories[memoryVersionKey(one.memoryId, one.version)]!.state, 'text_saved');
  await Promise.all([f.coordinator.activate(one, f.guard), f.coordinator.activate(two, f.guard)]);
  assert.equal(f.runtime.repository.read().banks[one.bankKey]!.revision, 1);
  assert.equal(f.runtime.repository.read().activeMemory[one.memoryId], memoryVersionKey(one.memoryId, one.version));
  await f.coordinator.writeVersion(one, f.guard);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
});

test('embedding rejection after saved body remains readable/active with separate failed vector status', async () => {
  const f = await fixture();
  f.service.failEmbedding = true;
  const plan = await f.plan('raw-1');
  await f.coordinator.writeVersion(plan, f.guard);
  await f.coordinator.activate(plan, f.guard);
  const memory = f.runtime.repository.read().memories[memoryVersionKey(plan.memoryId, plan.version)]!;
  assert.equal(memory.active, true);
  assert.equal(memory.vectorState, 'failed');
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
});

test('derived CAS conflict keeps previous active version and schedules only losing text for cleanup', async () => {
  const f = await fixture();
  const old = await f.plan('summary-old', 'old summary', 'mental-model', 0);
  await f.coordinator.writeVersion(old, f.guard); await f.coordinator.activate(old, f.guard);
  const update = await f.coordinator.planVersion({ bankKey: old.bankKey, memoryId: old.memoryId, operationKey: 'summary-update',
    kind: 'mental-model', text: 'computed on revision 1', provenance: f.guard.provenance, expectedBankRevision: 1 }, f.guard);
  await f.coordinator.writeVersion(update, f.guard);
  const independent = await f.plan('new-fact', 'new world fact', 'world');
  await f.coordinator.writeVersion(independent, f.guard); await f.coordinator.activate(independent, f.guard);
  await assert.rejects(f.coordinator.activate(update, f.guard), /activation-cas-conflict/);
  const state = f.runtime.repository.read();
  assert.equal(state.activeMemory[old.memoryId], memoryVersionKey(old.memoryId, old.version));
  assert.equal(state.memories[memoryVersionKey(update.memoryId, update.version)]!.state, 'invalidated');
  assert.equal(state.intents[update.intentId]!.text, undefined);
  await f.coordinator.runCleanup(old.bankKey);
  assert.equal(f.runtime.repository.read().memories[memoryVersionKey(old.memoryId, old.version)]!.active, true);
  assert.equal(f.service.docs.size, 2);
});

test('old superseded plan cannot append or reactivate after a newer version wins', async () => {
  const f = await fixture();
  const old = await f.plan('v1');
  await f.coordinator.writeVersion(old, f.guard); await f.coordinator.activate(old, f.guard);
  const update = await f.coordinator.planVersion({ bankKey: old.bankKey, memoryId: old.memoryId, operationKey: 'v2',
    kind: 'raw', text: 'new version', provenance: f.guard.provenance }, f.guard);
  await f.coordinator.writeVersion(update, f.guard); await f.coordinator.activate(update, f.guard);
  await assert.rejects(f.coordinator.writeVersion(old, f.guard), /memory-version-superseded/);
  assert.equal(f.runtime.repository.read().activeMemory[old.memoryId], memoryVersionKey(old.memoryId, update.version));
  assert.equal(f.service.calls.filter(call => call === 'add').length, 2);
});

test('unknown write with absent exact marker remains blocked and never appends based on absence', async () => {
  const f = await fixture();
  const plan = await f.plan('unknown');
  await f.runtime.repository.transact(f.guard, draft => {
    draft.intents[plan.intentId]!.externalWrite = 'unknown';
    draft.intents[plan.intentId]!.state = 'reconcile_required';
    draft.memories[memoryVersionKey(plan.memoryId, plan.version)]!.state = 'reconcile_required';
  });
  await assert.rejects(f.coordinator.writeVersion(plan, f.guard), /external-write-unknown/);
  assert.equal(f.service.calls.includes('add'), false);
  assert.equal(f.runtime.repository.read().activeMemory[plan.memoryId], undefined);
});

test('timeout tracks the underlying operation; late complete text can be reused without duplicate append', async () => {
  const f = await fixture();
  const plan = await f.plan('slow');
  const entered = deferred(); const finish = deferred();
  f.service.afterAdd = async () => { entered.resolve(); await finish.promise; };
  const writing = f.coordinator.writeVersion(plan, f.guard);
  await entered.promise;
  f.timers.expireAll();
  await assert.rejects(writing, /external-write-unknown/);
  assert.equal(f.runtime.repository.read().intents[plan.intentId]!.externalWrite, 'unknown');
  const committed = commitWhen(f.runtime.control, state => state.intents[plan.intentId]?.externalWrite === 'settled');
  finish.resolve();
  await committed;
  await f.coordinator.writeVersion(plan, f.guard); await f.coordinator.activate(plan, f.guard);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
  assert.equal(f.runtime.repository.read().memories[memoryVersionKey(plan.memoryId, plan.version)]!.active, true);
});

test('text saved before local docId commit failure recovers by full marker reconciliation under a new owner', async () => {
  const f = await fixture();
  const plan = await f.plan('crash');
  const originalSet = f.runtime.control.set.bind(f.runtime.control);
  let fail = true;
  f.runtime.control.set = async value => {
    if (fail && value.intents[plan.intentId]?.state === 'text_saved') { fail = false; throw new Error('commit interrupted'); }
    await originalSet(value);
  };
  await assert.rejects(f.coordinator.writeVersion(plan, f.guard));
  assert.equal(f.service.docs.size, 1);
  assert.equal(f.runtime.repository.getHealth().state, 'blocked');
  const repository = await ControlRepository.open(f.runtime.control, f.runtime.ledger, { ownerId: 'new-owner', isHeld: () => true }, { now: f.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => f.runtime.now });
  const lease = await queue.claimNext(); assert.ok(lease);
  const coordinator = new BankCoordinator(repository, new KnowledgeAdapter(f.service), { now: () => f.runtime.now, schedule: f.timers.schedule });
  await coordinator.writeVersion(plan, queue.guard(lease)); await coordinator.activate(plan, queue.guard(lease));
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
  assert.equal(repository.read().memories[memoryVersionKey(plan.memoryId, plan.version)]!.active, true);
  assert.equal(repository.read().intents[plan.intentId]!.externalWrite, 'unknown', 'finding text is not remote termination proof');
});

test('explicit forgetting deletes settled raw/facts/owned orphans but never reads foreign library bodies', async () => {
  const f = await fixture();
  const plan = await f.plan('forget');
  await f.coordinator.writeVersion(plan, f.guard); await f.coordinator.activate(plan, f.guard);
  const original = [...f.service.docs.values()][0]!;
  f.service.docs.set('orphan-copy', { ...structuredClone(original), id: 'orphan-copy' });
  f.service.docs.set('foreign-admin', { ...structuredClone(original), id: 'foreign-admin', title: 'unrelated admin document', rawText: 'FOREIGN_SECRET', charCount: 14 });
  await f.runtime.repository.recordDeletion('forget-1', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  assert.equal(JSON.stringify(f.runtime.repository.read()).includes('PRIVATE_MEMORY_BODY'), false);
  assert.equal(await f.coordinator.purgeForget('forget-1'), 'purged');
  assert.deepEqual([...f.service.docs.keys()], ['foreign-admin']);
  assert.equal(f.service.calls.includes('read:foreign-admin'), false);
  assert.equal(f.runtime.repository.read().forgetTasks['forget-1']!.state, 'purged');
});

test('late write after forget cannot reactivate/save body and uncertainty prevents purged even after physical deletion', async () => {
  const f = await fixture();
  const plan = await f.plan('late');
  const entered = deferred(); const finish = deferred();
  f.service.beforeAdd = async () => { entered.resolve(); await finish.promise; };
  const writing = f.coordinator.writeVersion(plan, f.guard);
  await entered.promise;
  await f.runtime.repository.recordDeletion('forget-1', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  f.timers.expireAll(); await assert.rejects(writing, /external-write-unknown/);
  assert.equal(await f.coordinator.purgeForget('forget-1'), 'purging');
  const rejected = commitWhen(f.runtime.control, state => state.intents[plan.intentId]?.lastErrorCode === 'knowledge-authorization-rejected');
  finish.resolve(); await rejected;
  assert.equal(f.service.docs.size, 1);
  assert.equal(await f.coordinator.purgeForget('forget-1'), 'purging');
  assert.equal(f.service.docs.size, 0);
  assert.equal(f.runtime.repository.read().forgetTasks['forget-1']!.externalWriteUnknown, true);
  assert.equal(JSON.stringify(f.runtime.repository.read()).includes('PRIVATE_MEMORY_BODY'), false);
  await assert.rejects(f.coordinator.activate(plan, f.guard));
});

test('full reconciliation schedules duplicate orphan cleanup without deleting the active canonical document', async () => {
  const f = await fixture();
  const plan = await f.plan('duplicate');
  await f.coordinator.writeVersion(plan, f.guard); await f.coordinator.activate(plan, f.guard);
  const original = [...f.service.docs.values()][0]!;
  f.service.docs.set('zzz-duplicate', { ...structuredClone(original), id: 'zzz-duplicate' });
  await f.coordinator.reconcileBank(plan.bankKey); await f.coordinator.runCleanup(plan.bankKey);
  assert.deepEqual([...f.service.docs.keys()], [original.id]);
  assert.equal(f.runtime.repository.read().memories[memoryVersionKey(plan.memoryId, plan.version)]!.docId, original.id);
});

test('same recovery marker with conflicting verified hash pauses bank instead of adopting new content', async () => {
  const f = await fixture();
  const plan = await f.plan('conflict');
  await f.coordinator.writeVersion(plan, f.guard); await f.coordinator.activate(plan, f.guard);
  const intent = f.runtime.repository.read().intents[plan.intentId]!;
  const bad = encodePluginDocument({ memoryId: plan.memoryId, version: plan.version, writeIntentId: plan.intentId,
    provenance: intent.provenance, text: 'DIFFERENT_PRIVATE_BODY' });
  const first = [...f.service.docs.values()][0]!;
  f.service.docs.set('conflict-copy', { ...first, id: 'conflict-copy', title: bad.title, rawText: bad.content, charCount: bad.content.length });
  await assert.rejects(f.coordinator.reconcileBank(plan.bankKey), /document-marker-conflict/);
  assert.equal(f.runtime.repository.read().banks[plan.bankKey]!.state, 'blocked');
  assert.equal(JSON.stringify(f.runtime.repository.read()).includes('DIFFERENT_PRIVATE_BODY'), false);
});

test('cleanup retries are separate from retain retry history, and failed physical forget stays blocked', async () => {
  const f = await fixture();
  const plan = await f.plan('cleanup');
  await f.coordinator.writeVersion(plan, f.guard); await f.coordinator.activate(plan, f.guard);
  await f.runtime.repository.recordDeletion('forget-1', { kind: 'messages', messageKeys: f.guard.provenance.messageKeys });
  f.service.failDelete = true;
  await assert.rejects(f.coordinator.purgeForget('forget-1'), /forget-cleanup-failed/);
  const state = f.runtime.repository.read();
  assert.equal(state.forgetTasks['forget-1']!.state, 'retry');
  assert.equal(state.forgetTasks['forget-1']!.retries, 1);
  assert.ok(state.forgetTasks['forget-1']!.docIdsPending.length > 0);
  assert.equal(state.tasks[f.lease.taskId]!.retryCount, 0);
  f.service.failDelete = false;
  assert.equal(await f.coordinator.purgeForget('forget-1'), 'purged');
});

test('global memory identity cannot be reused across persona banks', async () => {
  const f = await fixture();
  const first = await f.plan('same-logical');
  await f.coordinator.writeVersion(first, f.guard); await f.coordinator.activate(first, f.guard);
  const config = structuredClone(f.runtime.current.config);
  config.allow.groupIds.push('301');
  config.personalities.push({ ...structuredClone(config.personalities[0]!), id: 'other-persona', name: '小月', aliases: [] });
  config.bindings.groups.push({ id: '301', personalityId: 'other-persona' });
  await f.runtime.changeConfiguration(config);
  const admitted = await f.runtime.admit({ group_id: '301', message_id: 'other-message' });
  assert.equal(admitted.status, 'accepted');
  const secondLease = await f.queue.claimNext(); assert.ok(secondLease);
  const secondGuard = f.queue.guard(secondLease);
  const secondTask = f.runtime.repository.read().tasks[secondLease.taskId]!;
  assert.notEqual(secondTask.bankKey, first.bankKey);
  await f.coordinator.ensureBank(secondTask.bankKey, secondGuard);
  await assert.rejects(f.coordinator.planVersion({ bankKey: secondTask.bankKey, memoryId: first.memoryId,
    operationKey: 'cross-bank', kind: 'raw', text: 'OTHER_PERSONA_SECRET', provenance: secondGuard.provenance }, secondGuard), /memory-identity-conflict/);
  assert.notEqual(memoryIdFor(first.bankKey, 'raw', 'same-logical'), memoryIdFor(secondTask.bankKey, 'raw', 'same-logical'));
  assert.equal(f.runtime.repository.read().memories[memoryVersionKey(first.memoryId, first.version)]!.bankKey, first.bankKey);
  assert.equal(JSON.stringify(f.runtime.repository.read()).includes('OTHER_PERSONA_SECRET'), false);
});

test('expired lease and stopped coordinator cannot create new sensitive intents', async () => {
  const f = await fixture();
  f.runtime.advance(120001);
  await assert.rejects(f.plan('late-plan'));
  assert.equal(Object.keys(f.runtime.repository.read().intents).length, 0);
  await f.coordinator.stop();
  await assert.rejects(f.coordinator.ensureBank(f.task.bankKey, f.guard), /coordinator-stopped/);
});
