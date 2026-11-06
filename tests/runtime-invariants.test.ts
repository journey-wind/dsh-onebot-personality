import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { CallBudget, StageCaller } from '../src/llm/calls.js';
import { materializeSnapshot } from '../src/runtime/snapshots.js';
import { memorySchema, memoryVersionKey } from '../src/storage/model.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import { BankCoordinator, memoryIdFor } from '../src/memory/banks.js';
import { KnowledgeAdapter } from '../src/memory/knowledge.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge, ManualDeadlines } from './helpers/knowledge.js';

async function admitted() {
  const f = await runtimeFixture();
  await f.admit();
  const snapshot = Object.values(f.repository.read().snapshots)[0]!;
  return { f, snapshot };
}

test('durable snapshot materialization omits undefined route fields and remains deeply immutable', async () => {
  const { snapshot } = await admitted();
  const input = structuredClone(snapshot);
  input.routes.router.reasoningEffort = undefined;
  const result = materializeSnapshot(input);
  assert.equal(Object.hasOwn(result.routes.router, 'reasoningEffort'), false);
  assert.equal(result.id, snapshot.id); assert.equal(result.configRevision, snapshot.configRevision);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.routes)); assert.ok(Object.isFrozen(result.personality));
});

test('invalid durable snapshot errors expose no raw fields, credentials or schema details', async () => {
  const { snapshot } = await admitted();
  assert.throws(() => materializeSnapshot({ ...snapshot, token: 'DO_NOT_LEAK_SECRET' }), error => {
    assert.match(String(error), /invalid-persisted-snapshot/);
    assert.equal(String(error).includes('DO_NOT_LEAK_SECRET'), false);
    return true;
  });
});

test('nonreply token reservation preserves capacity for reply without resetting accumulated costs', () => {
  const budget = new CallBudget(Date.now() + 10_000, 3, 1000, true, 700);
  budget.claim('router', 100, 100);
  assert.throws(() => budget.claim('recall', 100, 100), /token-budget/);
  assert.equal(budget.calls, 1); assert.equal(budget.reservedTokens, 200);
  budget.claim('reply', 400, 200);
  assert.equal(budget.calls, 2); assert.equal(budget.reservedTokens, 800);
});

test('tighter nonreply deadline prevents dispatch while sharing the original cumulative budget', async () => {
  const { snapshot } = await admitted();
  let prepares = 0;
  const llm: Pick<LlmRuntime, 'prepareCall'> = { prepareCall: async () => { prepares++; throw new Error('must not prepare'); } };
  const caller = new StageCaller(llm);
  const budget = new CallBudget(Date.now() + 10_000, 12, 100_000);
  await assert.rejects(caller.text('router', 'route', {}, { snapshot: materializeSnapshot(snapshot), budget,
    signal: new AbortController().signal, deadlineAt: Date.now() - 1, authorize: async () => {} }), /deadline/);
  assert.equal(prepares, 0); assert.equal(budget.calls, 0);
});

test('forget scrubs local entity/time indices and rejects metadata-only late restoration', async () => {
  const { f } = await admitted();
  const queue = new RetainTaskQueue(f.repository, { now: () => f.now }); const lease = await queue.claimNext(); assert.ok(lease);
  const guard = queue.guard(lease); const task = f.repository.read().tasks[lease.taskId]!;
  const service = new InMemoryKnowledge();
  const coordinator = new BankCoordinator(f.repository, new KnowledgeAdapter(service), { now: () => f.now, schedule: new ManualDeadlines().schedule });
  await coordinator.ensureBank(task.bankKey, guard);
  const plan = await coordinator.planVersion({ bankKey: task.bankKey, memoryId: memoryIdFor(task.bankKey, 'world', 'old-date'),
    operationKey: 'old-date', kind: 'world', text: 'original personal date', provenance: guard.provenance,
    entities: ['qq:200'], eventStart: -631_152_000_000, eventEnd: -631_065_600_001 }, guard);
  await coordinator.writeVersion(plan, guard); await coordinator.activate(plan, guard);
  const key = memoryVersionKey(plan.memoryId, plan.version);
  const memory = f.repository.read().memories[key]!;
  assert.ok(memory.eventStart! < 0, 'pre-1970 event times are valid independently of acquisition time');
  assert.equal(memorySchema.safeParse({ ...memory, createdAt: -1 }).success, false);
  await f.repository.recordDeletion('forget-date', { kind: 'messages', messageKeys: guard.provenance.messageKeys });
  const scrubbed = f.repository.read().memories[key]!;
  assert.deepEqual(scrubbed.entities, []); assert.equal(scrubbed.eventStart, undefined); assert.equal(scrubbed.eventEnd, undefined);
  assert.equal(scrubbed.text, undefined);
  await assert.rejects(f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    draft.memories[key]!.entities = ['qq:200'];
  }), /content-guard-required/);
  await assert.rejects(f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    draft.memories[key]!.eventStart = -631_152_000_000;
  }), /content-guard-required/);
  assert.equal(await coordinator.purgeForget('forget-date'), 'purged');
  assert.equal(service.docs.size, 0);
});
