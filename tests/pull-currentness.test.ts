import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { CallBudget, StageCaller } from '../src/llm/calls.js';
import { configurationReader } from '../src/runtime/reference.js';
import { materializeSnapshot } from '../src/runtime/snapshots.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import { runtimeFixture } from './helpers/runtime.js';

// Tests use ordinary detached frozen snapshots, never the SDK's @internal volatile writer.
test('reference reader caches direct immutable values and changes a nonsensitive boot-unique revision by identity', async () => {
  const f = await runtimeFixture({ onebot: { enabled: true, expectedSelfId: '100', token: 'KEEP_TOKEN_PRIVATE' } });
  let snapshot = Object.freeze(structuredClone(f.current.config));
  const source = { get: () => snapshot }; const read = configurationReader(source);
  const first = read(); assert.equal(read(), first); assert.ok(Object.isFrozen(first.config));
  snapshot = Object.freeze(structuredClone(f.current.config));
  const second = read(); assert.notEqual(second.config, first.config); assert.notEqual(second.revision, first.revision);
  assert.equal(second.revision.includes('KEEP_TOKEN_PRIVATE'), false);
  assert.notEqual(configurationReader(source)().revision, second.revision);
});

test('queued microtask invalidation after async authorization blocks body serialization and even SDK preparation', async () => {
  const f = await runtimeFixture(); await f.admit();
  const task = Object.values(f.repository.read().tasks)[0]!;
  const snapshot = materializeSnapshot(f.repository.read().snapshots[task.snapshotId]);
  let valid = true; let prepared = 0; let bodyReads = 0;
  const llm: Pick<LlmRuntime, 'prepareCall'> = { prepareCall: async () => { prepared++; throw new Error('must not prepare'); } };
  const payload = { get text() { bodyReads++; return 'private evidence'; } };
  await assert.rejects(new StageCaller(llm).text('retain', 'extract', payload, {
    snapshot, budget: new CallBudget(Date.now() + 20_000, 8, 100_000, false), signal: new AbortController().signal,
    authorize: async () => { queueMicrotask(() => { valid = false; }); }, validateLive: () => valid,
  }), /authorization-invalid/);
  assert.equal(bodyReads, 0); assert.equal(prepared, 0);
});

test('queued capacity callback cannot claim a task after authoritative root invalidation before its transaction', async () => {
  const f = await runtimeFixture(); await f.admit(); let valid = true; let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; }); let entered = false;
  const original = f.control.set.bind(f.control);
  f.control.set = async state => { if (!entered) { entered = true; await held; } await original(state); };
  const blocker = f.repository.transact({ kind: 'metadata', fence: f.repository.fence }, () => {});
  // Drain only the deterministic initial setup microtasks, not a wall-clock polling loop.
  for (let i = 0; i < 10; i++) await Promise.resolve(); assert.equal(entered, true);
  const queue = new RetainTaskQueue(f.repository, { now: () => f.now, isLive: () => valid });
  const claim = queue.claimNext(); const rejected = assert.rejects(claim);
  valid = false; finish(); await blocker; await rejected;
  const task = Object.values(f.repository.read().tasks)[0]!;
  assert.equal(task.state, 'pending'); assert.equal(task.leaseToken, 0); assert.equal(task.attemptCount, 0);
});
