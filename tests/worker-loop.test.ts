import test from 'node:test';
import assert from 'node:assert/strict';
import { StageError } from '../src/llm/calls.js';
import type { ReplyRecord } from '../src/storage/model.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import type { TaskLease } from '../src/runtime/tasks.js';
import { ProviderQuota } from '../src/runtime/quota.js';
import { WorkerLoop } from '../src/runtime/worker-loop.js';
import type { DerivedWorker, WorkerLoopOptions } from '../src/runtime/worker-loop.js';
import { runtimeFixture } from './helpers/runtime.js';

// AUTHORED ONLY / UNEXECUTED. No real scheduler timers, Host services or network adapters are used.
type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
function gate() {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Test gates may reject after stop/lease replacement; always attach a rejection handler immediately.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function settle(): Promise<void> {
  // A bounded deterministic microtask drain, NOT a wall-clock timer or production polling loop.
  for (let turn = 0; turn < 200; turn++) await Promise.resolve();
}
class ManualScheduler {
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  readonly delays: number[] = [];
  lastCallback: (() => void) | undefined;
  private sequence = 0;
  constructor(private readonly clock: Fixture) {}
  readonly schedule = (callback: () => void, ms: number): (() => void) => {
    assert.ok(ms > 0); this.delays.push(ms); this.lastCallback = callback;
    const key = ++this.sequence; this.timers.set(key, { at: this.clock.now + ms, callback });
    return () => { this.timers.delete(key); };
  };
  async tick(ms = 250): Promise<void> {
    this.clock.advance(ms);
    // Only timers owned at the beginning of this clock step fire; rescheduling remains positive-delay.
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.clock.now);
    for (const [key, timer] of due) { this.timers.delete(key); timer.callback(); }
    await settle();
  }
}
async function fixture(input: Record<string, unknown> = {}) {
  const f = await runtimeFixture({ allow: { groupIds: ['300', '301'], privateUserIds: ['200'] }, ...input });
  const queue = new RetainTaskQueue(f.repository, { now: () => f.now, random: () => 0.5 });
  const scheduler = new ManualScheduler(f);
  let stopped = 0;
  const options: WorkerLoopOptions = { signal: f.abort.signal, readConfiguration: () => f.current,
    now: () => f.now, schedule: scheduler.schedule, stopOwnedWork: () => { stopped++; f.abort.abort(); } };
  const derived: DerivedWorker = { enqueueDue: async () => 0, run: async () => {} };
  const online = { run: async (replyId: string) => f.repository.read().replies[replyId]! };
  const retain = { run: async (_lease: TaskLease) => {} };
  return { f, queue, scheduler, options, derived, online, retain, stopCount: () => stopped };
}
async function reply(f: Fixture, messageId: string, groupId = '300') {
  const admitted = await f.admit({ message_id: messageId, group_id: groupId,
    message: [{ type: 'at', data: { qq: '100' } }, { type: 'text', data: { text: 'hello' } }] });
  assert.equal(admitted.status, 'accepted');
  assert.ok('replyId' in admitted && admitted.replyId);
  return admitted.replyId;
}
async function replyState(f: Fixture, replyId: string, state: ReplyRecord['state']): Promise<ReplyRecord> {
  await f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, draft => { draft.replies[replyId]!.state = state; });
  return f.repository.read().replies[replyId]!;
}
async function finish(queue: RetainTaskQueue, lease: TaskLease): Promise<void> {
  await queue.checkpoint(lease, 'derived_jobs_enqueued', {}); await queue.finish(lease);
}

test('constructor/requestTick are inert until explicit start; requests coalesce and stop clears only its timer', async () => {
  const { f, queue, scheduler, options, derived, online, retain, stopCount } = await fixture();
  let reads = 0;
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined,
    { ...options, readConfiguration: () => { reads++; return f.current; } });
  assert.equal(reads, 0); assert.equal(scheduler.timers.size, 0);
  loop.requestTick(); assert.equal(scheduler.timers.size, 0);
  loop.start(); loop.start(); loop.requestTick(); loop.requestTick();
  assert.equal(scheduler.timers.size, 1);
  const cancelledCallback = scheduler.lastCallback!;
  await loop.stop(); await loop.stop();
  assert.equal(stopCount(), 1); assert.equal(f.abort.signal.aborted, true); assert.equal(scheduler.timers.size, 0);
  cancelledCallback(); await settle();
  assert.equal(reads, 0); assert.equal(loop.getStatus().state, 'stopped');
  assert.throws(() => loop.start(), /worker-loop-stopped/);
  // The repository/owner/Host handles are NOT the loop's resources to close.
  assert.ok(f.repository.read().ownerActive);
});

test('FIFO receivedAt/sequence per conversation includes outbox completion; other conversations make progress', async () => {
  const { f, queue, scheduler, options, derived, retain } = await fixture({ budgets: { onlineConcurrency: 2 } });
  const a1 = await reply(f, '1'); const a2 = await reply(f, '2');
  const b1 = await reply(f, '3', '301'); const b2 = await reply(f, '4', '301');
  const gates = new Map([a1, a2, b1, b2].map(id => [id, gate()])); const started: string[] = [];
  const online = { run: async (id: string) => {
    started.push(id); await replyState(f, id, 'generating');
    await gates.get(id)!.promise; // Represents both generation and the entire outbox send.
    return replyState(f, id, 'completed');
  } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options); loop.start();
  await scheduler.tick(); assert.deepEqual(started, [a1, b1]);
  assert.equal(loop.getStatus().onlineActive, 2); assert.equal(loop.getStatus().backgroundActive, 0);
  gates.get(b1)!.resolve(); await settle(); await scheduler.tick();
  assert.deepEqual(started, [a1, b1, b2]); // A2 cannot bypass still-sending A1; B2 need not wait for A1.
  gates.get(a1)!.resolve(); await settle(); await scheduler.tick();
  assert.deepEqual(started, [a1, b1, b2, a2]);
  gates.get(a2)!.resolve(); gates.get(b2)!.resolve(); await settle(); await loop.stop();
  assert.equal(loop.getStatus().onlineActive, 0); assert.ok(scheduler.delays.every(ms => ms >= 250));
});

test('current onlineConcurrency limits new launches without cancelling already-running conversations', async () => {
  const { f, queue, scheduler, options, derived, retain } = await fixture();
  const a = await reply(f, '1'); const b = await reply(f, '2', '301');
  const cAdmission = await f.admit({ message_type: 'private', message_id: '3', user_id: '200' });
  assert.ok('replyId' in cAdmission && cAdmission.replyId); const c = cAdmission.replyId;
  let cap = 2; const hold = gate(); const started: string[] = [];
  const online = { run: async (id: string) => {
    started.push(id); await replyState(f, id, 'generating'); await hold.promise; return replyState(f, id, 'completed');
  } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, { ...options,
    readConfiguration: () => ({ ...f.current, config: { ...f.current.config,
      budgets: { ...f.current.config.budgets, onlineConcurrency: cap } } }) });
  loop.start(); await scheduler.tick(); assert.deepEqual(started, [a, b]);
  cap = 1; await scheduler.tick(); assert.deepEqual(started, [a, b]);
  hold.resolve(); await settle(); await scheduler.tick(); assert.deepEqual(started, [a, b, c]);
  await loop.stop();
});

test('expired pending jobs reach Online.run for cancellation; generating jobs are never resumed', async () => {
  const { f, queue, scheduler, options, derived, retain } = await fixture();
  const expired = await reply(f, '1'); const old = await reply(f, '2', '301');
  await replyState(f, old, 'generating');
  f.advance(f.current.config.budgets.onlineDeadlineMs + 1);
  const seen: string[] = []; let llmCalls = 0;
  const online = { run: async (id: string) => {
    seen.push(id);
    if (f.repository.read().replies[id]!.deadlineAt <= f.now) return replyState(f, id, 'cancelled');
    llmCalls++; return replyState(f, id, 'completed');
  } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick();
  assert.deepEqual(seen, [expired]); assert.equal(llmCalls, 0);
  assert.equal(f.repository.read().replies[old]!.state, 'generating'); await loop.stop();
});

test('online pressure pauses NEW background claims but active background work does not occupy online slots', async () => {
  const { f, queue, scheduler, options, derived } = await fixture();
  await f.admit({ message_id: '1' }); const backgroundHold = gate(); const onlineHold = gate();
  const leases: TaskLease[] = [];
  const retain = { run: async (lease: TaskLease) => { leases.push(lease); await backgroundHold.promise; await finish(queue, lease); } };
  const online = { run: async (id: string) => {
    await replyState(f, id, 'generating'); await onlineHold.promise; return replyState(f, id, 'completed');
  } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.equal(leases.length, 1);
  const liveReply = await reply(f, '2', '301'); await scheduler.tick();
  assert.equal(loop.getStatus().onlineActive, 1); assert.equal(leases.length, 1);
  assert.equal(Object.values(f.repository.read().tasks).filter(task => task.state === 'pending').length, 1);
  onlineHold.resolve(); await settle(); assert.equal(f.repository.read().replies[liveReply]!.state, 'completed');
  await scheduler.tick(); assert.equal(leases.length, 2); // Original background slot is still held.
  backgroundHold.resolve(); await settle(); await loop.stop();
});

test('claimNext enforces ORIGINAL snapshot retainConcurrency rather than current settings', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture({ budgets: { retainConcurrency: 1 } });
  await f.admit({ message_id: '1' }); await f.admit({ message_id: '2' });
  const hold = gate(); const leases: TaskLease[] = [];
  const retain = { run: async (lease: TaskLease) => { leases.push(lease); await hold.promise; await finish(queue, lease); } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, { ...options,
    readConfiguration: () => ({ ...f.current, config: { ...f.current.config,
      budgets: { ...f.current.config.budgets, retainConcurrency: 32 } } }) });
  loop.start(); await scheduler.tick(); assert.equal(leases.length, 1);
  await scheduler.tick(); assert.equal(leases.length, 1);
  hold.resolve(); await settle(); await scheduler.tick(); assert.equal(leases.length, 2);
  await loop.stop();
});

test('derived work routes to derived.run and same-bank activation serializes while raw work runs beside it', async () => {
  const { f, queue, scheduler, options, online } = await fixture(); await f.admit();
  const raw = Object.values(f.repository.read().tasks)[0]!; const bank = f.repository.read().banks[raw.bankKey]!;
  await f.repository.transact({ kind: 'content', fence: f.repository.fence, botId: bank.botId,
    personalityId: bank.personalityId, provenance: raw.provenance }, draft => {
    draft.tasks['derived-a'] = { ...structuredClone(raw), taskId: 'derived-a', kind: 'observation' };
    draft.tasks['derived-b'] = { ...structuredClone(raw), taskId: 'derived-b', kind: 'mental-model', templateId: 'preferences' };
  });
  const hold = gate(); const rawLeases: TaskLease[] = []; const derivedLeases: TaskLease[] = [];
  const retain = { run: async (lease: TaskLease) => { rawLeases.push(lease); await hold.promise; await finish(queue, lease); } };
  const derived = { enqueueDue: async () => 0,
    run: async (lease: TaskLease) => { derivedLeases.push(lease); await hold.promise; await finish(queue, lease); } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.equal(rawLeases.length, 1); assert.equal(derivedLeases.length, 1);
  assert.equal(loop.getStatus().backgroundActive, 2);
  hold.resolve(); await settle(); await scheduler.tick(); assert.equal(derivedLeases.length, 2); await loop.stop();
});

test('120-second leases renew at the default 30-second heartbeat while model work remains unsettled', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture(); await f.admit();
  const hold = gate(); let lease: TaskLease | undefined;
  const retain = { run: async (value: TaskLease) => { lease = value; await hold.promise; await finish(queue, value); } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.ok(lease);
  const initial = f.repository.read().tasks[lease.taskId]!.leaseUntil!;
  await scheduler.tick(29_750); assert.equal(f.repository.read().tasks[lease.taskId]!.leaseUntil, initial);
  await scheduler.tick(250); assert.equal(f.repository.read().tasks[lease.taskId]!.leaseUntil, initial + 30_000);
  await scheduler.tick(30_000); assert.equal(f.repository.read().tasks[lease.taskId]!.leaseUntil, initial + 60_000);
  assert.equal(queue.isLive(lease), true); hold.resolve(); await settle(); await loop.stop();
});

test('lost lease denies old body callbacks and old failures cannot mutate a newly claimed lease', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture(); await f.admit();
  const hold = gate(); let old: TaskLease | undefined;
  const retain = { run: async (lease: TaskLease) => { old = lease; await hold.promise; } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.ok(old);
  f.advance(120_001); const fresh = await queue.claimNext(); assert.ok(fresh);
  assert.ok(fresh.leaseToken > old.leaseToken); await scheduler.tick(); assert.equal(loop.getStatus().leasesLost, 1);
  await assert.rejects(queue.checkpoint(old, 'raw_active', { memoryIds: ['forbidden-late-body'] }), /task-lease-invalid/);
  hold.reject(new StageError('retain', 'provider-error')); await settle();
  const task = f.repository.read().tasks[fresh.taskId]!;
  assert.equal(task.state, 'running'); assert.equal(task.leaseToken, fresh.leaseToken); assert.equal(task.retryCount, 0);
  assert.equal(task.failureCodes.length, 0); await loop.stop();
});

test('an unresolved expired operation is not dispatched twice; replacement lease is deferred without retry cost', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture(); await f.admit();
  const hold = gate(); let runs = 0;
  const retain = { run: async (_lease: TaskLease) => { runs++; await hold.promise; } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); await scheduler.tick(120_001);
  const task = Object.values(f.repository.read().tasks)[0]!;
  assert.equal(runs, 1); assert.equal(task.state, 'retry'); assert.equal(task.retryCount, 0);
  assert.equal(task.nextRunAt, f.now + 120_000); assert.equal(loop.getStatus().leasesLost, 1);
  hold.resolve(); await settle(); await loop.stop();
});

test('unsettled expired operations still occupy original-snapshot slots instead of flooding distinct tasks', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture({ budgets: { retainConcurrency: 1 } });
  await f.admit({ message_id: '1' }); await f.admit({ message_id: '2' }); const hold = gate(); let runs = 0;
  const retain = { run: async (_lease: TaskLease) => { runs++; await hold.promise; } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.equal(runs, 1);
  await scheduler.tick(120_001); await scheduler.tick();
  assert.equal(runs, 1); assert.equal(loop.getStatus().backgroundActive, 1);
  assert.ok(Object.values(f.repository.read().tasks).every(task => task.state === 'retry' && task.retryCount === 0));
  hold.resolve(); await settle(); await loop.stop();
});

test('source invalidation immediately fences late checkpoints; submitted work is not falsely marked remotely cancelled', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture(); await f.admit();
  const hold = gate(); let lease: TaskLease | undefined; let externalSettled = false;
  const retain = { run: async (value: TaskLease) => {
    lease = value; await hold.promise; externalSettled = true; await queue.checkpoint(value, 'raw_active', { memoryIds: ['late'] });
  } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.ok(lease);
  const task = f.repository.read().tasks[lease.taskId]!;
  await f.repository.recordDeletion('forget-while-model-running', { kind: 'messages', messageKeys: task.provenance.messageKeys });
  await scheduler.tick(); assert.equal(loop.getStatus().leasesLost, 1);
  assert.equal(externalSettled, false); assert.equal(loop.getStatus().backgroundActive, 1);
  hold.resolve(); await settle();
  assert.equal(externalSettled, true); assert.equal(f.repository.read().tasks[lease.taskId]!.state, 'cancelled');
  assert.deepEqual(f.repository.read().tasks[lease.taskId]!.checkpoint, {}); await loop.stop();
});

test('DispatchDeferred happens BEFORE durable task cost, preserving budget/history and using retryAt without busy looping', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture({ budgets: {
    onlineRequestsPerMinute: 2, retainRequestsPerMinute: 1, onlineTokensPerMinute: 1000, retainTokensPerMinute: 500,
  } }); await f.admit();
  const quota = new ProviderQuota({ readLimits: () => f.current.config.budgets, now: () => f.now });
  const retryAt = f.now + 60_000; quota.reserve('retain', 'mock', 100, 'retain', f.abort.signal);
  let charged = 0;
  const retain = { run: async (lease: TaskLease) => {
    await queue.checkpoint(lease, 'raw_active', { memoryIds: ['existing-raw'] });
    quota.reserve('retain', 'mock', 100, 'retain', f.abort.signal); // RetainWorker.admitCall ordering contract.
    await queue.reserveCall(lease, 100); charged++; await finish(queue, lease);
  } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick();
  let task = Object.values(f.repository.read().tasks)[0]!;
  assert.equal(task.state, 'retry'); assert.equal(task.nextRunAt, retryAt); assert.equal(task.retryCount, 0);
  assert.equal(task.calls, 0); assert.equal(task.reservedTokens, 0); assert.equal(charged, 0);
  assert.deepEqual(task.checkpoint, { memoryIds: ['existing-raw'] }); assert.deepEqual(task.failureCodes, ['dispatch-deferred']);
  const attempts = task.attemptCount; await scheduler.tick();
  assert.equal(Object.values(f.repository.read().tasks)[0]!.attemptCount, attempts);
  assert.equal(scheduler.timers.size, 1); assert.ok(scheduler.delays.every(delay => delay >= 250));
  await scheduler.tick(retryAt - f.now);
  task = Object.values(f.repository.read().tasks)[0]!;
  assert.equal(task.state, 'done'); assert.equal(task.retryCount, 0); assert.equal(task.calls, 1);
  assert.equal(task.reservedTokens, 100); assert.equal(charged, 1); assert.equal(task.attemptCount, 2); await loop.stop();
});

test('fixed task failures use queue.fail and sanitize unknown exceptions without leaking bodies', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture(); await f.admit({ message_id: '1' }); await f.admit({ message_id: '2' });
  let runs = 0;
  const retain = { run: async (_lease: TaskLease) => { if (++runs === 1) throw new StageError('retain', 'invalid-structured-output');
    throw new Error('SECRET prompt and Authorization Bearer credential'); } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick();
  const tasks = Object.values(f.repository.read().tasks);
  assert.ok(tasks.every(task => task.state === 'retry' && task.retryCount === 1));
  assert.deepEqual(tasks.flatMap(task => task.failureCodes).sort(), ['retain:invalid-structured-output', 'worker-failed'].sort());
  assert.equal(JSON.stringify(loop.getStatus()).includes('SECRET'), false); await loop.stop();
});

test('bounded enqueue/maintenance lanes are single-flight and retry independently without task/LLM quota', async () => {
  const { f, queue, scheduler, options, online, retain } = await fixture({ memory: { cleanupBatch: 3, retryInitialMs: 1000 } });
  const maintenanceHold = gate(); let enqueueCalls = 0; const maintenanceLimits: number[] = []; const dueLimits: number[] = [];
  const derived = { enqueueDue: async (limit?: number) => {
    enqueueCalls++; dueLimits.push(limit!); if (enqueueCalls === 1) throw new Error('SECRET'); return 0;
  }, run: async (_lease: TaskLease) => {} };
  const maintenance = { tick: async (limit: number) => { maintenanceLimits.push(limit); await maintenanceHold.promise; } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, maintenance, options);
  loop.start(); await scheduler.tick(); assert.deepEqual(dueLimits, [3]); assert.deepEqual(maintenanceLimits, [3]);
  await scheduler.tick(); await scheduler.tick(); await scheduler.tick(); assert.equal(enqueueCalls, 1);
  await scheduler.tick(); assert.equal(enqueueCalls, 2); assert.equal(maintenanceLimits.length, 1);
  assert.equal(Object.values(f.repository.read().tasks).length, 0); assert.equal(loop.getStatus().maintenanceActive, true);
  maintenanceHold.resolve(); await settle(); await scheduler.tick(); assert.equal(maintenanceLimits.length, 2); await loop.stop();
});

test('stop during a task aborts the shared root and fences late writes without waiting for unabortable work', async () => {
  const { f, queue, scheduler, options, derived, online, stopCount } = await fixture(); await f.admit();
  const hold = gate(); let lease: TaskLease | undefined;
  const retain = { run: async (value: TaskLease) => { lease = value; await hold.promise; await queue.checkpoint(value, 'raw_active', { memoryIds: ['late-body'] }); } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.ok(lease);
  const stopped = loop.stop(); assert.equal(f.abort.signal.aborted, true); assert.equal(queue.isLive(lease), false);
  await stopped; assert.equal(stopCount(), 1); assert.equal(scheduler.timers.size, 0);
  assert.equal(loop.getStatus().backgroundActive, 1); assert.ok(loop.getStatus().trackedPromises >= 1);
  assert.ok(f.repository.read().ownerActive); // No repository/owner/shared service handles were closed.
  hold.resolve(); await settle(); assert.equal(loop.getStatus().backgroundActive, 0); assert.equal(loop.getStatus().trackedPromises, 0);
  assert.deepEqual(f.repository.read().tasks[lease.taskId]!.checkpoint, {}); assert.equal(scheduler.timers.size, 0);
});

test('stop while claim is awaiting storage prevents late claim completion from launching work or rescheduling', async () => {
  const { f, queue, scheduler, options, derived, online } = await fixture(); await f.admit();
  const hold = gate(); const original = queue.claimNext.bind(queue); let claimed: TaskLease | undefined; let runs = 0;
  queue.claimNext = async duration => { claimed = await original(duration); await hold.promise; return claimed; };
  const retain = { run: async (_lease: TaskLease) => { runs++; } };
  const loop = new WorkerLoop(f.repository, queue, online, retain, derived, undefined, options);
  loop.start(); await scheduler.tick(); assert.ok(claimed); assert.equal(loop.getStatus().ticking, true);
  await loop.stop(); assert.equal(queue.isLive(claimed), false); hold.resolve(); await settle();
  assert.equal(runs, 0); assert.equal(scheduler.timers.size, 0); assert.equal(loop.getStatus().trackedPromises, 0);
});

test('abort before start and owner/repository loss fail closed without touching shared resources', async () => {
  const before = await fixture(); before.f.abort.abort(new Error('SECRET'));
  const idleLoop = new WorkerLoop(before.f.repository, before.queue, before.online, before.retain, before.derived, undefined, before.options);
  idleLoop.start(); assert.equal(idleLoop.getStatus().state, 'stopped'); assert.equal(before.scheduler.timers.size, 0);
  const live = await fixture(); const loop = new WorkerLoop(live.f.repository, live.queue, live.online, live.retain, live.derived, undefined, live.options);
  loop.start(); live.f.repository.read = () => { throw new Error('SECRET owner/adapter detail'); };
  await live.scheduler.tick(); assert.equal(loop.getStatus().state, 'stopped'); assert.equal(live.f.abort.signal.aborted, true);
  assert.equal(JSON.stringify(loop.getStatus()).includes('SECRET'), false); assert.equal(live.scheduler.timers.size, 0);
});
