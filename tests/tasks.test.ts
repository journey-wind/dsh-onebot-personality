import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture } from './helpers/runtime.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';

async function fixture(input: Record<string, unknown> = {}) {
  const f = await runtimeFixture(input);
  await f.admit();
  const queue = new RetainTaskQueue(f.repository, { now: () => f.now, random: () => 0.5 });
  return { ...f, queue, clock: f };
}

test('claiming is durable, bounded and does not duplicate an active task', async () => {
  const f = await fixture();
  const lease = await f.queue.claimNext();
  assert.ok(lease);
  assert.equal(f.queue.isLive(lease), true);
  assert.equal(await f.queue.claimNext(), undefined);
  const task = f.repository.read().tasks[lease.taskId]!;
  assert.equal(task.state, 'running');
  assert.equal(task.attemptCount, 1);
  assert.equal(task.leaseToken, 1);
  assert.equal(task.fence, f.repository.fence);
});

test('expired same-owner lease gets a new token and rejects old body checkpoints', async () => {
  const f = await fixture();
  const old = await f.queue.claimNext(1000);
  assert.ok(old);
  await f.queue.checkpoint(old, 'raw_active', { memoryIds: ['raw-checkpoint'] });
  f.clock.advance(1001);
  assert.equal(f.queue.isLive(old), false);
  await assert.rejects(f.queue.renew(old), /task-lease-invalid/);
  const fresh = await f.queue.claimNext(1000);
  assert.ok(fresh);
  assert.ok(fresh.leaseToken > old.leaseToken);
  assert.deepEqual(f.repository.read().tasks[fresh.taskId]!.checkpoint, { memoryIds: ['raw-checkpoint'] });
  await assert.rejects(f.queue.checkpoint(old, 'extracted_validated', {}), /task-lease-invalid/);
  await f.queue.fail(old, 'late-failure');
  assert.equal(f.repository.read().tasks[fresh.taskId]!.state, 'running');
});

test('automatic retry count means initial plus configured retries, keeps route/checkpoint/cost history', async () => {
  const f = await fixture({ budgets: { retainMaxRetries: 1 } });
  const first = await f.queue.claimNext();
  assert.ok(first);
  const route = f.repository.read().tasks[first.taskId]!.routeFingerprint;
  await f.queue.reserveCall(first, 100);
  await f.queue.checkpoint(first, 'raw_active', { memoryIds: ['raw-checkpoint'] });
  await f.queue.fail(first, 'provider-error');
  assert.equal(f.repository.read().tasks[first.taskId]!.state, 'retry');
  assert.equal(await f.queue.claimNext(), undefined);
  f.clock.advance(1000);
  const second = await f.queue.claimNext();
  assert.ok(second);
  assert.equal(f.repository.read().tasks[second.taskId]!.attemptCalls, 0);
  await f.queue.reserveCall(second, 200);
  await f.queue.fail(second, 'provider-error');
  const task = f.repository.read().tasks[second.taskId]!;
  assert.equal(task.state, 'dead-letter');
  assert.equal(task.retryCount, 1);
  assert.equal(task.attemptCount, 2);
  assert.equal(task.calls, 2);
  assert.equal(task.reservedTokens, 300);
  assert.equal(task.routeFingerprint, route);
  assert.deepEqual(task.checkpoint, { memoryIds: ['raw-checkpoint'] });
});

test('format repair reservations obey same-attempt call and cumulative task token budgets', async () => {
  const f = await fixture({ budgets: { retainMaxLlmCalls: 1, maxRetainTaskTokens: 2048 } });
  const first = await f.queue.claimNext();
  assert.ok(first);
  await f.queue.reserveCall(first, 1500);
  await assert.rejects(f.queue.reserveCall(first, 1), /retain-attempt-call-budget/);
  await f.queue.fail(first, 'invalid-json');
  f.clock.advance(1000);
  const second = await f.queue.claimNext();
  assert.ok(second);
  await assert.rejects(f.queue.reserveCall(second, 1000), /retain-task-token-budget/);
  assert.equal(f.repository.read().tasks[second.taskId]!.reservedTokens, 1500);
});

test('explicit dead-letter retry keeps historical counters; cancelled forgotten work cannot revive', async () => {
  const f = await fixture({ budgets: { retainMaxRetries: 0 } });
  const first = await f.queue.claimNext();
  assert.ok(first);
  await f.queue.fail(first, 'Bearer SECRET_MUST_NOT_PERSIST');
  assert.deepEqual(f.repository.read().tasks[first.taskId]!.failureCodes, ['worker-failed']);
  await f.queue.retryDeadLetter(first.taskId);
  const second = await f.queue.claimNext();
  assert.ok(second);
  assert.equal(f.repository.read().tasks[second.taskId]!.attemptCount, 2);
  const key = f.repository.read().tasks[second.taskId]!.messageKey!;
  await f.repository.recordDeletion('forget-1', { kind: 'messages', messageKeys: [key] });
  await assert.rejects(f.queue.checkpoint(second, 'raw_active', {}), /task-lease-invalid/);
  await assert.rejects(f.queue.retryDeadLetter(second.taskId), /task-not-retryable/);
  assert.equal(f.repository.read().tasks[second.taskId]!.state, 'cancelled');
});

test('derived activation work serializes per bank while raw work can run beside it', async () => {
  const f = await fixture();
  const raw = Object.values(f.repository.read().tasks)[0]!;
  const bank = f.repository.read().banks[raw.bankKey]!;
  await f.repository.transact({ kind: 'content', fence: f.repository.fence, botId: bank.botId, personalityId: bank.personalityId,
    provenance: structuredClone(raw.provenance) }, draft => {
    draft.tasks['derived-a'] = { ...structuredClone(raw), taskId: 'derived-a', kind: 'mental-model', templateId: 'preferences' };
    draft.tasks['derived-b'] = { ...structuredClone(raw), taskId: 'derived-b', kind: 'observation' };
  });
  const one = await f.queue.claimNext();
  const two = await f.queue.claimNext();
  assert.ok(one && two);
  assert.equal(await f.queue.claimNext(), undefined);
  const running = Object.values(f.repository.read().tasks).filter(task => task.state === 'running');
  assert.equal(running.length, 2);
  assert.equal(running.filter(task => task.kind === 'mental-model' || task.kind === 'observation').length, 1);
});

test('online congestion pauses new retain claims without erasing pending work', async () => {
  const f = await runtimeFixture();
  await f.admit();
  let congested = true;
  const queue = new RetainTaskQueue(f.repository, { now: () => f.now, onlineCongested: () => congested });
  assert.equal(await queue.claimNext(), undefined);
  assert.equal(Object.values(f.repository.read().tasks)[0]!.state, 'pending');
  congested = false;
  assert.ok(await queue.claimNext());
});

test('task route/snapshot and accumulated costs cannot be silently reset by metadata updates', async () => {
  const f = await fixture();
  const lease = await f.queue.claimNext();
  assert.ok(lease);
  await f.queue.reserveCall(lease, 100);
  await assert.rejects(f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    draft.tasks[lease.taskId]!.routeFingerprint = '0'.repeat(64);
  }), /task-identity-and-route-are-immutable/);
  await assert.rejects(f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => {
    draft.tasks[lease.taskId]!.calls = 0;
  }), /task-counters-cannot-roll-back/);
  assert.equal(f.repository.read().tasks[lease.taskId]!.calls, 1);
});

test('completion requires derived enqueue checkpoint, stages cannot regress and stop fences late work', async () => {
  const f = await fixture();
  const lease = await f.queue.claimNext();
  assert.ok(lease);
  await assert.rejects(f.queue.finish(lease), /derived-enqueue-not-confirmed/);
  await f.queue.checkpoint(lease, 'facts_active', {});
  await assert.rejects(f.queue.checkpoint(lease, 'raw_active', {}), /invalid-checkpoint-transition/);
  await f.queue.checkpoint(lease, 'derived_jobs_enqueued', {});
  await f.queue.finish(lease);
  assert.equal(f.repository.read().tasks[lease.taskId]!.state, 'done');
  assert.equal(f.queue.isLive(lease), false);
  f.queue.stop();
  assert.equal(await f.queue.claimNext(), undefined);
});
