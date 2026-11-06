import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
import { STAGES } from '../src/config.js';
import { StageCaller } from '../src/llm/calls.js';
import { fingerprint } from '../src/llm/routes.js';
import { BankCoordinator, memoryIdFor } from '../src/memory/banks.js';
import { KnowledgeAdapter } from '../src/memory/knowledge.js';
import { RetainWorker } from '../src/memory/retain.js';
import type { RetainWorkerOptions } from '../src/memory/retain.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import { ControlRepository } from '../src/storage/repository.js';
import type { ExtractedFact, Provenance } from '../src/storage/model.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge, ManualDeadlines } from './helpers/knowledge.js';

const TEXT = '我喜欢茶';
function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return { content: 'QQ用户200报告喜欢茶', quote: TEXT, confidence: 'reported', inferred: false,
    eventTime: { expression: '', precision: 'unknown', ambiguous: true },
    entities: [{ key: 'speaker', kind: 'qq', label: '作者', qqId: '200' }], relations: [], ...overrides };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { resolve, promise };
}
function mockModel(outputs: unknown[] = [{ facts: [fact()] }]) {
  const calls: GenerateOptions[] = [];
  let hook = async (_index: number, _options: GenerateOptions): Promise<void> => {};
  const llm: Pick<LlmRuntime, 'prepareCall'> = { prepareCall: async config => ({
    config, context: { contextWindow: 1_000_000 },
    retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }, adapterDefaults: {},
    stream: async function* (options): AsyncIterable<StreamChunk> {
      const index = calls.length; calls.push(options); await hook(index, options);
      const output = outputs[index]; if (output === undefined) throw new Error('unexpected model call');
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  }) };
  return { calls, caller: new StageCaller(llm), setHook(next: typeof hook) { hook = next; } };
}
async function fixture(outputs?: unknown[], budgets: Record<string, unknown> = {}) {
  const runtime = await runtimeFixture({ models: Object.fromEntries(STAGES.map(stage => [stage,
    { selection: 'explicit', provider: `provider-${stage}`, model: `model-${stage}` },
  ])), budgets });
  const admitted = await runtime.admit({ message: [{ type: 'text', data: { text: TEXT } }] });
  assert.equal(admitted.status, 'accepted');
  const queue = new RetainTaskQueue(runtime.repository, { now: () => runtime.now, random: () => 0.5 });
  const lease = await queue.claimNext(); assert.ok(lease);
  const task = runtime.repository.read().tasks[lease.taskId]!;
  const service = new InMemoryKnowledge(); const adapter = new KnowledgeAdapter(service); const timers = new ManualDeadlines();
  const banks = new BankCoordinator(runtime.repository, adapter, { now: () => runtime.now, schedule: timers.schedule });
  const model = mockModel(outputs); const dirty: string[][] = []; const reservations: number[] = [];
  const worker = (overrides: Partial<RetainWorkerOptions> = {}) => new RetainWorker(runtime.repository, queue, banks, model.caller, {
    signal: runtime.abort.signal, now: () => runtime.now,
    derived: { markDirty: async (activeLease, ids) => {
      runtime.repository.assertContentAllowed(queue.guard(activeLease)); dirty.push([...ids]);
    } }, beforeCall: async (activeLease, tokens) => {
      assert.equal(runtime.repository.read().tasks[activeLease.taskId]!.attemptCalls, reservations.length + 1);
      reservations.push(tokens);
    }, ...overrides,
  });
  return { runtime, queue, lease, task, service, adapter, timers, banks, model, dirty, reservations, worker };
}
function active(f: Awaited<ReturnType<typeof fixture>>) {
  return Object.values(f.runtime.repository.read().memories).filter(memory => memory.active);
}

test('uncertain nickname IDs differ across sources/messages in one bank but survive checkpoint retry unchanged', async () => {
  const output = { facts: [fact({ entities: [
    { key: 'speaker', kind: 'qq', label: '作者', qqId: '200' }, { key: 'name', kind: 'uncertain', label: '茶' },
  ] })] };
  const f = await fixture([output, output, output]);
  const worker = () => f.worker({ beforeCall: async () => {} });
  const originalPlan = f.banks.planVersion.bind(f.banks); let interrupted = false;
  f.banks.planVersion = async (input, guard) => {
    if (input.kind === 'world' && !interrupted) { interrupted = true; throw new Error('interrupt after extraction'); }
    return originalPlan(input, guard);
  };
  await assert.rejects(worker().run(f.lease));
  const saved = f.runtime.repository.read().tasks[f.lease.taskId]!.checkpoint.facts!;
  const checkpointKey = saved[0]!.entities.find(entity => entity.kind === 'uncertain')!.key;
  await f.queue.fail(f.lease, 'pre-intent-interrupted'); f.runtime.advance(1000);
  const retry = await f.queue.claimNext(); assert.ok(retry);
  await worker().run(retry);
  assert.equal(f.model.calls.length, 1);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.checkpoint.facts![0]!.entities.find(entity => entity.kind === 'uncertain')!.key, checkpointKey);
  assert.ok(active(f).find(memory => memory.kind === 'world')!.entities.includes(checkpointKey));
  await f.runtime.changeConfiguration({ ...f.runtime.current.config, allow: { groupIds: ['300', '301'], privateUserIds: ['200'] } });
  for (const [groupId, messageId] of [['301', '2'], ['300', '3']] as const) {
    const admitted = await f.runtime.admit({ group_id: groupId, message_id: messageId,
      message: [{ type: 'text', data: { text: TEXT } }] });
    assert.equal(admitted.status, 'accepted');
    const lease = await f.queue.claimNext(); assert.ok(lease); await worker().run(lease);
  }
  const worlds = active(f).filter(memory => memory.kind === 'world');
  assert.equal(new Set(worlds.map(memory => memory.bankKey)).size, 1);
  assert.equal(worlds.length, 3); assert.equal(f.model.calls.length, 3);
  assert.equal(new Set(worlds.map(memory => memory.entities.find(key => key.startsWith('entity-')))).size, 3);
  assert.equal(worlds.every(memory => memory.entities.includes('qq:200')), true);
});

test('plain raw evidence is durable and active before extraction; first-person user facts remain world', async () => {
  const f = await fixture();
  f.model.setHook(async () => {
    assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.stage, 'raw_active');
    const memories = active(f); assert.equal(memories.length, 1); assert.equal(memories[0]!.kind, 'raw');
    assert.equal(memories[0]!.text, TEXT); assert.equal(f.service.docs.size, 1);
    assert.ok([...f.service.docs.values()][0]!.rawText?.includes(TEXT));
    assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.calls, 1);
  });
  await f.worker().run(f.lease);
  const state = f.runtime.repository.read(); const task = state.tasks[f.lease.taskId]!;
  assert.equal(task.state, 'done'); assert.equal(task.stage, 'done'); assert.equal(task.calls, 1);
  assert.deepEqual(active(f).map(memory => memory.kind).sort(), ['raw', 'world']);
  const world = active(f).find(memory => memory.kind === 'world')!;
  assert.deepEqual(world.entities, ['qq:200']); assert.match(world.text!, /原文引文：我喜欢茶/);
  assert.equal(world.text!.startsWith('{'), false);
  assert.equal(f.dirty.length, 1); assert.deepEqual(f.dirty[0], task.checkpoint.memoryIds);
  assert.equal(f.reservations.length, 1); assert.equal(task.reservedTokens, f.reservations[0]);
  assert.equal(Object.keys(state.replies).length, 0); // untriggered group message has no online path
});

test('slow/failed extraction leaves raw retrievable and never creates or depends on an online job', async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred();
  f.model.setHook(async () => { entered.resolve(); await release.promise; throw new Error('SECRET_PROVIDER_ERROR'); });
  const pending = f.worker().run(f.lease); const rejected = assert.rejects(pending, error => {
    assert.equal(String(error).includes('SECRET'), false); return true;
  });
  await entered.promise;
  assert.equal(active(f)[0]!.kind, 'raw'); assert.equal(f.service.docs.size, 1);
  assert.equal(Object.keys(f.runtime.repository.read().replies).length, 0);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.state, 'running');
  release.resolve(); await rejected;
  assert.equal(active(f).length, 1); assert.equal(f.dirty.length, 0);
  await f.queue.fail(f.lease, 'provider-failed');
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.state, 'retry');
});

test('schema and semantic repairs use only original retain route among all five configured slots', async () => {
  const f = await fixture([{ facts: [fact({ quote: '伪造引文' })] }, { facts: [fact()] }]);
  await f.worker().run(f.lease);
  assert.equal(f.model.calls.length, 2);
  for (const call of f.model.calls) {
    assert.equal(call.provider, 'provider-retain'); assert.equal(call.model, 'model-retain'); assert.equal(call.tools, undefined);
  }
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.calls, 2);
  assert.equal(f.reservations.length, 2);
});

for (const [label, output] of [
  ['fake-QQ', { facts: [fact({ entities: [{ key: 'fake', kind: 'qq', label: 'nickname', qqId: '999' }] })] }],
  ['fake-quote', { facts: [fact({ quote: '不存在的原话' })] }],
  ['fake-time', { facts: [fact({ eventTime: { expression: '', start: 0, precision: 'instant', ambiguous: false } })] }],
  ['fake-source', { facts: [{ ...fact(), sourceId: 'untrusted-source' }] }],
  ['single-evidence-corroborated', { facts: [fact({ confidence: 'corroborated' })] }],
  ['bad-schema', { facts: [{ content: TEXT }] }],
] as const) test(`${label} gets at most one same-retain repair, no unvalidated checkpoint or fact intent`, async () => {
  const f = await fixture([output, output]);
  await assert.rejects(f.worker().run(f.lease), /invalid-structured-output/);
  assert.equal(f.model.calls.length, 2); assert.equal(f.reservations.length, 2);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.checkpoint.facts, undefined);
  assert.deepEqual(active(f).map(memory => memory.kind), ['raw']);
  assert.equal(Object.keys(f.runtime.repository.read().intents).length, 1);
});

test('durable facts are checkpointed before any fact append and retry resumes without extracting again', async () => {
  const f = await fixture(); let failed = false;
  f.service.beforeAdd = async () => {
    if (f.service.docs.size === 1 && !failed) {
      assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.stage, 'extracted_validated');
      assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.checkpoint.facts!.length, 1);
      failed = true; throw new Error('simulated knowledge outage');
    }
  };
  await assert.rejects(f.worker().run(f.lease));
  assert.equal(f.model.calls.length, 1);
  // The append outcome is unknown: demonstrate a durable extracted checkpoint even while
  // recovery correctly blocks blind re-append. No new extraction is allowed on retry.
  await f.queue.fail(f.lease, 'knowledge-outcome-unknown'); f.runtime.advance(1000);
  const lease = await f.queue.claimNext(); assert.ok(lease);
  await assert.rejects(f.worker().run(lease), /external-write-unknown/);
  assert.equal(f.model.calls.length, 1); assert.equal(f.service.docs.size, 1);
});

test('extracted checkpoint survives pre-intent failure and resumes facts without any extra model call', async () => {
  const f = await fixture(); const plan = f.banks.planVersion.bind(f.banks); let fail = true;
  f.banks.planVersion = async (input, guard) => {
    if (input.kind === 'world' && fail) { fail = false; throw new Error('simulated pre-intent interruption'); }
    return plan(input, guard);
  };
  await assert.rejects(f.worker().run(f.lease));
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.stage, 'extracted_validated');
  assert.equal(Object.keys(f.runtime.repository.read().intents).length, 1);
  await f.queue.fail(f.lease, 'pre-intent-failed'); f.runtime.advance(1000);
  const lease = await f.queue.claimNext(); assert.ok(lease);
  await f.worker().run(lease);
  assert.equal(f.model.calls.length, 1); assert.equal(f.service.docs.size, 2);
  assert.equal(f.runtime.repository.read().tasks[lease.taskId]!.state, 'done');
});

test('restart from facts_active retries required dirty enqueue without extra extract or document writes', async () => {
  const f = await fixture();
  await assert.rejects(f.worker({ derived: { markDirty: async () => { throw new Error('SECRET_DIRTY_ERROR'); } } }).run(f.lease), /retain-worker-failed/);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.stage, 'facts_active');
  assert.notEqual(f.runtime.repository.read().tasks[f.lease.taskId]!.state, 'done');
  const repository = await ControlRepository.open(f.runtime.control, f.runtime.ledger,
    { ownerId: 'new-owner', isHeld: () => true }, { now: f.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => f.runtime.now }); const lease = await queue.claimNext(); assert.ok(lease);
  const banks = new BankCoordinator(repository, f.adapter, { now: () => f.runtime.now, schedule: f.timers.schedule });
  let enqueued = false;
  await new RetainWorker(repository, queue, banks, f.model.caller, { signal: f.runtime.abort.signal, now: () => f.runtime.now,
    derived: { markDirty: async (running, ids) => {
      await repository.transact(queue.guard(running), draft => {
        const task = draft.tasks[running.taskId]!;
        assert.deepEqual(ids, task.checkpoint.memoryIds); enqueued = true;
      });
    } },
  }).run(lease);
  assert.equal(enqueued, true); assert.equal(repository.read().tasks[lease.taskId]!.state, 'done');
  assert.equal(repository.read().tasks[lease.taskId]!.calls, 1);
  assert.equal(f.model.calls.length, 1); assert.equal(f.service.docs.size, 2);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 2);
});

test('empty extraction retains raw, durably marks dirty before done, and does not fabricate facts', async () => {
  const f = await fixture([{ facts: [] }]); const entered = deferred(); const release = deferred();
  const running = f.worker({ derived: { markDirty: async () => { entered.resolve(); await release.promise; } } }).run(f.lease);
  await entered.promise;
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.stage, 'facts_active');
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.state, 'running');
  release.resolve(); await running;
  assert.equal(active(f).length, 1); assert.equal(active(f)[0]!.kind, 'raw');
  assert.deepEqual(f.runtime.repository.read().tasks[f.lease.taskId]!.checkpoint.facts, []);
});

for (const action of ['forget', 'expired-lease', 'cancel-signal'] as const) {
  test(`${action} during extraction fences late output: no fact checkpoint or fact write intent`, async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    f.model.setHook(async () => { entered.resolve(); await release.promise; });
    const running = f.worker().run(f.lease); const rejected = assert.rejects(running);
    await entered.promise;
    if (action === 'forget') await f.runtime.repository.recordDeletion('forget-during-retain',
      { kind: 'messages', messageKeys: [f.task.messageKey!] }, 'forget', f.runtime.now);
    else if (action === 'expired-lease') f.runtime.advance(120_001);
    else f.runtime.abort.abort();
    release.resolve(); await rejected;
    const state = f.runtime.repository.read();
    assert.equal(state.tasks[f.lease.taskId]!.checkpoint.facts, undefined);
    assert.equal(Object.keys(state.intents).length, 1);
    assert.equal(Object.values(state.memories).some(memory => memory.kind === 'world'), false);
    if (action === 'forget') {
      assert.equal(state.tasks[f.lease.taskId]!.state, 'cancelled');
      assert.equal(Object.values(state.intents)[0]!.text, undefined);
    }
  });
}

test('original snapshot survives route/config changes; fingerprint mismatch dispatches nothing', async () => {
  const f = await fixture();
  await f.runtime.changeConfiguration({ ...f.runtime.current.config, models: Object.fromEntries(STAGES.map(stage => [stage,
    { selection: 'explicit', provider: `new-${stage}`, model: `new-${stage}` },
  ])) });
  await f.worker().run(f.lease);
  assert.equal(f.model.calls[0]!.provider, 'provider-retain'); assert.equal(f.model.calls[0]!.model, 'model-retain');
  assert.equal(f.model.calls.length, 1);
  const other = await fixture();
  // Fault injection directly into the durable test cell, followed by a real repository reload.
  other.runtime.control.value.tasks[other.lease.taskId]!.routeFingerprint = '0'.repeat(64);
  const repository = await ControlRepository.open(other.runtime.control, other.runtime.ledger,
    { ownerId: 'corrupt-route-owner', isHeld: () => true }, { now: other.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => other.runtime.now }); const lease = await queue.claimNext(); assert.ok(lease);
  await assert.rejects(new RetainWorker(repository, queue,
    new BankCoordinator(repository, other.adapter, { schedule: other.timers.schedule }), other.model.caller,
    { signal: other.runtime.abort.signal, derived: { markDirty: async () => {} } }).run(lease), /retain-snapshot-mismatch/);
  assert.equal(other.model.calls.length, 0); assert.equal(other.service.docs.size, 0);
});

test('repair shares per-attempt call budget; persistent calls/tokens do not reset on retry', async () => {
  const f = await fixture(['not JSON', { facts: [] }], { retainMaxLlmCalls: 1 });
  await assert.rejects(f.worker().run(f.lease), /call-budget/);
  assert.equal(f.model.calls.length, 1); assert.equal(f.reservations.length, 1);
  const reserved = f.runtime.repository.read().tasks[f.lease.taskId]!.reservedTokens;
  await f.queue.fail(f.lease, 'format-failed'); f.runtime.advance(1000);
  const lease = await f.queue.claimNext(); assert.ok(lease);
  await f.worker({ beforeCall: async () => {} }).run(lease);
  const task = f.runtime.repository.read().tasks[f.lease.taskId]!;
  assert.equal(task.calls, 2); assert.equal(task.attemptCalls, 1); assert.ok(task.reservedTokens > reserved);
  assert.equal(f.model.calls.every(call => call.provider === 'provider-retain'), true);
});

test('task token ceiling and beforeCall quota rejection dispatch no model, preserving reservation history', async () => {
  const limited = await fixture(undefined, { maxRetainTaskTokens: 2048 });
  await assert.rejects(limited.worker().run(limited.lease), /token-budget/);
  assert.equal(limited.model.calls.length, 0); assert.equal(active(limited)[0]!.kind, 'raw');
  const f = await fixture();
  await assert.rejects(f.worker({ beforeCall: async lease => {
    assert.equal(f.runtime.repository.read().tasks[lease.taskId]!.calls, 1);
    throw new Error('SECRET_QUOTA_DETAIL');
  } }).run(f.lease), error => { assert.equal(String(error).includes('SECRET'), false); return true; });
  assert.equal(f.model.calls.length, 0);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.calls, 1);
  assert.ok(f.runtime.repository.read().tasks[f.lease.taskId]!.reservedTokens > 0);
});

test('source revoke during extraction is authorization failure, not repaired or quality-degraded', async () => {
  const f = await fixture();
  f.model.setHook(async () => { await f.runtime.changeConfiguration({ ...f.runtime.current.config, allow: { groupIds: [], privateUserIds: ['200'] } }); });
  await assert.rejects(f.worker().run(f.lease), /authorization-invalid/);
  assert.equal(f.model.calls.length, 1);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.checkpoint.facts, undefined);
  assert.equal(f.runtime.repository.read().tasks[f.lease.taskId]!.state, 'cancelled');
});

async function experienceFixture(state: 'succeeded' | 'unknown' | 'failed' = 'succeeded') {
  const f = await fixture([{ facts: [fact({ content: '机器人表示喜欢茶', entities: [{ key: 'bot', kind: 'qq', label: '机器人', qqId: '100' }] })] }]);
  const original = f.runtime.repository.read().tasks[f.lease.taskId]!;
  // Use a second source in the complete generation closure to test anti-laundering provenance.
  await f.runtime.admit({ message_type: 'private', user_id: '200', message_id: 'private-1' });
  const privateMessage = Object.values(f.runtime.repository.read().messages).find(message => message.conversationType === 'private')!;
  const provenance: Provenance = { complete: true, sourceRefs: [...original.provenance.sourceRefs, privateMessage.sourceRef],
    messageKeys: [...original.provenance.messageKeys, privateMessage.key], dependencyVersions: [] };
  const experienceId = 'experience-fixture'; const segmentId = 'segment-fixture'; const replyId = 'reply-fixture';
  await f.runtime.repository.transact({ ...f.queue.guard(f.lease), provenance }, draft => {
    draft.tasks[f.lease.taskId]!.state = 'cancelled';
    for (const task of Object.values(draft.tasks)) if (task.kind === 'retain') task.state = 'cancelled';
    draft.replies[replyId] = { replyId, messageKey: original.messageKey!, snapshotId: original.snapshotId, bankKey: original.bankKey,
      configRevision: draft.configRevision, authEpoch: draft.authEpoch, bindingRevision: draft.bindingRevision,
      provenance, deadlineAt: f.runtime.now + 10000, state: 'completed' };
    draft.segments[segmentId] = { segmentId, replyId, index: 0, provenance, text: TEXT,
      bodyHash: fingerprint({ encoding: 'outbox-text-v1', text: TEXT }), state,
      ...(state === 'succeeded' ? { qqMessageId: 'confirmed-123' } : {}), experienceTaskId: experienceId };
    draft.tasks[experienceId] = { ...original, taskId: experienceId, kind: 'experience', segmentId,
      provenance, state: 'pending', stage: 'ingress_committed', leaseToken: 0, attemptCount: 0, attemptCalls: 0,
      checkpoint: {}, calls: 0, reservedTokens: 0 };
    delete draft.tasks[experienceId]!.messageKey; delete draft.tasks[experienceId]!.ownerId;
    delete draft.tasks[experienceId]!.fence; delete draft.tasks[experienceId]!.leaseUntil;
  });
  const lease = await f.queue.claimNext(); assert.ok(lease); assert.equal(lease.taskId, experienceId);
  return { ...f, experienceLease: lease, segmentId, provenance };
}

test('confirmed bot raw and facts are distinct experiences with complete original generation closure', async () => {
  const f = await experienceFixture(); await f.worker().run(f.experienceLease);
  const memories = active(f); assert.equal(memories.length, 2);
  assert.equal(memories.every(memory => memory.kind === 'experience'), true);
  assert.notEqual(memories[0]!.memoryId, memories[1]!.memoryId);
  assert.equal(memories.some(memory => memory.memoryId === memoryIdFor(f.task.bankKey, 'experience', 'raw-experience-fixture')), true);
  const canonical = (provenance: Provenance) => ({ complete: provenance.complete,
    sourceRefs: provenance.sourceRefs.map(ref => JSON.stringify([ref.sourceId, ref.sourceEpoch])).sort(),
    messageKeys: [...provenance.messageKeys].sort(),
    dependencyVersions: provenance.dependencyVersions.map(dep => JSON.stringify([dep.memoryId, dep.version])).sort() });
  // Document encoding canonicalizes set ordering; require the complete same closure, not insertion order.
  for (const memory of memories) assert.deepEqual(canonical(memory.provenance), canonical(f.provenance));
  assert.equal(f.model.calls.length, 1); assert.equal(f.model.calls[0]!.provider, 'provider-retain');
});
for (const state of ['unknown', 'failed'] as const) test(`${state} bot send can never produce experience evidence`, async () => {
  const f = await experienceFixture(state);
  await assert.rejects(f.worker().run(f.experienceLease), /retain-experience-invalid/);
  assert.equal(f.model.calls.length, 0); assert.equal(f.service.docs.size, 0);
});

test('reloaded checkpoint facts are defensively revalidated, not trusted or re-extracted', async () => {
  const f = await fixture();
  await assert.rejects(f.worker({ derived: { markDirty: async () => { throw new Error('stop'); } } }).run(f.lease));
  f.runtime.control.value.tasks[f.lease.taskId]!.checkpoint.facts = [fact({ quote: 'forged checkpoint quote' })];
  const repository = await ControlRepository.open(f.runtime.control, f.runtime.ledger,
    { ownerId: 'reload-invalid-facts', isHeld: () => true }, { now: f.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => f.runtime.now }); const lease = await queue.claimNext(); assert.ok(lease);
  await assert.rejects(new RetainWorker(repository, queue,
    new BankCoordinator(repository, f.adapter, { schedule: f.timers.schedule }), f.model.caller,
    { signal: f.runtime.abort.signal, derived: { markDirty: async () => {} } }).run(lease), /retain-checkpoint-facts-invalid/);
  assert.equal(f.model.calls.length, 1); assert.equal(f.service.docs.size, 2);
});
