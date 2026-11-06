// AUTHORED, UNEXECUTED: deterministic integration specifications; no external model/service access.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
import { STAGES } from '../src/config.js';
import { DispatchDeferred, StageCaller } from '../src/llm/calls.js';
import { fingerprint } from '../src/llm/routes.js';
import { BankCoordinator, memoryIdFor } from '../src/memory/banks.js';
import { DERIVED_TEMPLATES, MENTAL_TEMPLATES, DerivedManager, derivedScopeKey, validateDerivedOutput } from '../src/memory/derived.js';
import type { DerivedEvidence, DerivedManagerOptions } from '../src/memory/derived.js';
import { KnowledgeAdapter } from '../src/memory/knowledge.js';
import { RetainWorker } from '../src/memory/retain.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import type { TaskLease } from '../src/runtime/tasks.js';
import { memoryVersionKey } from '../src/storage/model.js';
import type { ExtractedFact, MemoryVersion, Provenance, TaskRecord } from '../src/storage/model.js';
import { ControlRepository } from '../src/storage/repository.js';
import { InMemoryKnowledge, ManualDeadlines } from './helpers/knowledge.js';
import { runtimeFixture } from './helpers/runtime.js';

type InputFact = { evidenceId: string; originalEvidenceId: string; fact: ExtractedFact };
type ModelInput = { text?: string; template?: string; evidence?: InputFact[]; allowedQQIds?: string[] };
function fact(text: string, index = 0): ExtractedFact {
  return { content: `报告${index}：${text}`, quote: text, confidence: 'reported', inferred: false,
    eventTime: { expression: '', precision: 'unknown', ambiguous: true }, entities: [], relations: [] };
}
function summary(input: ModelInput) {
  const evidence = input.evidence![0]!;
  return { summary: '有一条明确报告；未确认其他身份或承诺。', confidence: 'reported', inferred: false,
    support: [{ evidenceId: evidence.evidenceId, quote: evidence.fact.quote }], opposition: [] };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { resolve, promise };
}
function fakeModel() {
  const calls: { options: GenerateOptions; input: ModelInput }[] = [];
  let factCount = 1;
  let hook = async (_input: ModelInput): Promise<void> => {};
  let output = (input: ModelInput): unknown => input.evidence ? summary(input)
    : { facts: Array.from({ length: factCount }, (_, index) => fact(input.text!, index)) };
  const runtime: Pick<LlmRuntime, 'prepareCall'> = { prepareCall: async config => ({
    config, context: { contextWindow: 2_000_000 },
    retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }, adapterDefaults: {},
    stream: async function* (options): AsyncIterable<StreamChunk> {
      const messages = options.messages as unknown as { content: { text: string }[] }[];
      const payload = JSON.parse(messages[0]!.content[0]!.text) as ModelInput & { task?: ModelInput };
      const input = payload.task ?? payload; calls.push({ options, input }); await hook(input);
      const value = output(input); const text = typeof value === 'string' ? value : JSON.stringify(value);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  }) };
  return { calls, caller: new StageCaller(runtime), setFactCount(count: number) { factCount = count; },
    setHook(next: typeof hook) { hook = next; }, setOutput(next: typeof output) { output = next; } };
}
async function fixture(input: Record<string, unknown> = {}) {
  const runtime = await runtimeFixture({ allow: { groupIds: ['300', '301'], privateUserIds: ['200'] },
    models: Object.fromEntries(STAGES.map(stage => [stage, { selection: 'explicit', provider: `original-${stage}`, model: `model-${stage}` }])),
    budgets: { evidenceMaxTokens: 16384, maxRetainTaskTokens: 1_000_000 }, ...input });
  const service = new InMemoryKnowledge(); const adapter = new KnowledgeAdapter(service); const timers = new ManualDeadlines();
  const queue = new RetainTaskQueue(runtime.repository, { now: () => runtime.now, random: () => 0.5 });
  const banks = new BankCoordinator(runtime.repository, adapter, { now: () => runtime.now, schedule: timers.schedule });
  const model = fakeModel();
  const manager = (overrides: Partial<DerivedManagerOptions> = {}) => new DerivedManager(runtime.repository, queue, banks, model.caller,
    { signal: runtime.abort.signal, now: () => runtime.now, ...overrides });
  let messageId = 0;
  const retain = async (text = '我喜欢茶', overrides: Record<string, unknown> = {}) => {
    const admission = await runtime.admit({ message_id: String(++messageId), message: [{ type: 'text', data: { text } }], ...overrides });
    assert.equal(admission.status, 'accepted');
    const lease = await queue.claimNext(); assert.ok(lease);
    assert.equal(runtime.repository.read().tasks[lease.taskId]!.kind, 'retain');
    await new RetainWorker(runtime.repository, queue, banks, model.caller, {
      signal: runtime.abort.signal, now: () => runtime.now, derived: manager(),
    }).run(lease);
    return runtime.repository.read().tasks[lease.taskId]!;
  };
  return { runtime, service, adapter, timers, queue, banks, model, manager, retain };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const derivedCalls = (f: Fixture) => f.model.calls.filter(call => call.input.evidence);
const derivedMemories = (f: Fixture) => Object.values(f.runtime.repository.read().memories)
  .filter(memory => memory.active && (memory.kind === 'observation' || memory.kind === 'mental-model'));
async function due(f: Fixture, limit = 1): Promise<TaskLease> {
  f.runtime.advance(60_000); assert.equal(await f.manager().enqueueDue(limit), limit);
  const lease = await f.queue.claimNext(); assert.ok(lease); return lease;
}
async function confirmedExperience(f: Fixture, original: TaskRecord, text: string, inputs: readonly MemoryVersion[] = []) {
  const index = Object.keys(f.runtime.repository.read().segments).length + 1;
  const taskId = `test-experience-${index}`; const segmentId = `test-segment-${index}`; const replyId = `test-reply-${index}`;
  const closures = [original.provenance, ...inputs.map(item => item.provenance)];
  const provenance: Provenance = { complete: true,
    sourceRefs: [...new Map(closures.flatMap(item => item.sourceRefs).map(ref => [JSON.stringify(ref), ref])).values()],
    messageKeys: [...new Set(closures.flatMap(item => item.messageKeys))],
    dependencyVersions: [...new Map([...closures.flatMap(item => item.dependencyVersions),
      ...inputs.map(item => ({ memoryId: item.memoryId, version: item.version }))].map(dep => [memoryVersionKey(dep.memoryId, dep.version), dep])).values()] };
  const bank = f.runtime.repository.read().banks[original.bankKey]!;
  await f.runtime.repository.transact({ kind: 'content', fence: f.runtime.repository.fence, botId: bank.botId,
    personalityId: bank.personalityId, provenance, validateLive: () => !f.runtime.abort.signal.aborted }, draft => {
    draft.replies[replyId] = { replyId, messageKey: original.messageKey!, snapshotId: original.snapshotId, bankKey: original.bankKey,
      configRevision: draft.configRevision, authEpoch: draft.authEpoch, bindingRevision: draft.bindingRevision,
      provenance, deadlineAt: f.runtime.now + 10000, state: 'completed' };
    draft.segments[segmentId] = { segmentId, replyId, index: 0, provenance, text,
      bodyHash: fingerprint({ encoding: 'outbox-text-v1', text }), state: 'succeeded', qqMessageId: `sent-${index}`, experienceTaskId: taskId };
    draft.tasks[taskId] = { ...original, taskId, kind: 'experience', segmentId, provenance,
      state: 'pending', stage: 'ingress_committed', leaseToken: 0, attemptCount: 0, attemptCalls: 0, retryCount: 0,
      nextRunAt: f.runtime.now, checkpoint: {}, calls: 0, reservedTokens: 0, failureCodes: [] };
    delete draft.tasks[taskId]!.messageKey; delete draft.tasks[taskId]!.ownerId;
    delete draft.tasks[taskId]!.fence; delete draft.tasks[taskId]!.leaseUntil;
  });
  const lease = await f.queue.claimNext(); assert.ok(lease); assert.equal(lease.taskId, taskId);
  await new RetainWorker(f.runtime.repository, f.queue, f.banks, f.model.caller,
    { signal: f.runtime.abort.signal, now: () => f.runtime.now, derived: f.manager() }).run(lease);
  return f.runtime.repository.read().tasks[taskId]!;
}
async function enqueueOneRow(f: Fixture, key: string): Promise<TaskLease> {
  await f.runtime.repository.transact({ kind: 'metadata', fence: f.runtime.repository.fence }, draft => { draft.refresh[key]!.nextRunAt = f.runtime.now; });
  assert.equal(await f.manager().enqueueDue(1), 1);
  const lease = await f.queue.claimNext(); assert.ok(lease); return lease;
}

// These are specification tests, not a claim that the authored source has been compiled or run.
test('scope keys use the exact sourceRef SET plus epochs and separate world from bot experience', () => {
  const a = { sourceId: 'source-a', sourceEpoch: 1 }; const b = { sourceId: 'source-b', sourceEpoch: 2 };
  assert.equal(derivedScopeKey('world', [a, b, a]), derivedScopeKey('world', [b, a]));
  assert.notEqual(derivedScopeKey('world', [a, b]), derivedScopeKey('world', [a]));
  assert.notEqual(derivedScopeKey('world', [a]), derivedScopeKey('world', [{ ...a, sourceEpoch: 2 }]));
  assert.notEqual(derivedScopeKey('world', [a]), derivedScopeKey('bot-experience', [a]));
  assert.deepEqual(MENTAL_TEMPLATES, ['preferences', 'relationships', 'unfinished-tasks']);
});

test('dirtyRecorded is atomic/idempotent and cold retain resume cannot double-increment dirty revisions', async () => {
  const f = await fixture();
  const admitted = await f.runtime.admit({ message: [{ type: 'text', data: { text: '喜欢茶' } }] });
  assert.equal(admitted.status, 'accepted'); const lease = await f.queue.claimNext(); assert.ok(lease);
  await assert.rejects(new RetainWorker(f.runtime.repository, f.queue, f.banks, f.model.caller, {
    signal: f.runtime.abort.signal, now: () => f.runtime.now, derived: { markDirty: async (running, ids) => {
      await f.manager().markDirty(running, ids); await f.manager().markDirty(running, ids);
      throw new Error('crash after dirty transaction before retain stage transition');
    } },
  }).run(lease));
  const before = f.runtime.repository.read();
  assert.equal(before.tasks[lease.taskId]!.checkpoint.dirtyRecorded, true);
  assert.equal(before.tasks[lease.taskId]!.stage, 'facts_active');
  assert.equal(Object.values(before.refresh).length, 4);
  assert.equal(Object.values(before.refresh).every(row => row.dirtyRevision === 1), true);
  assert.equal(Object.values(before.tasks).filter(task => task.kind === 'observation').length, 0);
  const repository = await ControlRepository.open(f.runtime.control, f.runtime.ledger,
    { ownerId: 'cold-owner', isHeld: () => true }, { now: f.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => f.runtime.now }); const retry = await queue.claimNext(); assert.ok(retry);
  const banks = new BankCoordinator(repository, f.adapter, { now: () => f.runtime.now, schedule: f.timers.schedule });
  const manager = new DerivedManager(repository, queue, banks, f.model.caller, { signal: f.runtime.abort.signal, now: () => f.runtime.now });
  await new RetainWorker(repository, queue, banks, f.model.caller,
    { signal: f.runtime.abort.signal, now: () => f.runtime.now, derived: manager }).run(retry);
  assert.equal(repository.read().tasks[lease.taskId]!.checkpoint.dirtyRecorded, true);
  assert.equal(Object.values(repository.read().refresh).every(row => row.dirtyRevision === 1), true);
  assert.equal(f.model.calls.length, 1);
});

test('failed dirty transaction leaves neither checkpoint nor revisions and cold retry commits both exactly once', async () => {
  const f = await fixture(); await f.runtime.admit({ message: [{ type: 'text', data: { text: '事务中断报告' } }] });
  const lease = await f.queue.claimNext(); assert.ok(lease);
  await assert.rejects(new RetainWorker(f.runtime.repository, f.queue, f.banks, f.model.caller, {
    signal: f.runtime.abort.signal, now: () => f.runtime.now, derived: { markDirty: async (running, ids) => {
      f.runtime.control.failAtCommit = f.runtime.control.commits + 1; await f.manager().markDirty(running, ids);
    } },
  }).run(lease));
  assert.equal(f.runtime.control.get().tasks[lease.taskId]!.checkpoint.dirtyRecorded, undefined);
  assert.equal(Object.keys(f.runtime.control.get().refresh).length, 0);
  f.runtime.control.failAtCommit = -1;
  const repository = await ControlRepository.open(f.runtime.control, f.runtime.ledger,
    { ownerId: 'dirty-rollback-owner', isHeld: () => true }, { now: f.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => f.runtime.now }); const retry = await queue.claimNext(); assert.ok(retry);
  const banks = new BankCoordinator(repository, f.adapter, { now: () => f.runtime.now, schedule: f.timers.schedule });
  const manager = new DerivedManager(repository, queue, banks, f.model.caller, { signal: f.runtime.abort.signal, now: () => f.runtime.now });
  await new RetainWorker(repository, queue, banks, f.model.caller,
    { signal: f.runtime.abort.signal, now: () => f.runtime.now, derived: manager }).run(retry);
  assert.equal(Object.values(repository.read().refresh).every(row => row.dirtyRevision === 1), true);
  assert.equal(repository.read().tasks[lease.taskId]!.checkpoint.dirtyRecorded, true); assert.equal(f.model.calls.length, 1);
});

test('ten facts trigger immediately, raw first is excluded, and jobs carry fact own-version closures', async () => {
  const f = await fixture(); f.model.setFactCount(10); const task = await f.retain();
  assert.equal(task.checkpoint.memoryIds!.length, 11);
  assert.equal(Object.values(f.runtime.repository.read().refresh).every(row => row.dirtyRevision === 10 && row.nextRunAt === f.runtime.now), true);
  assert.equal(await f.manager().enqueueDue(), 4); assert.equal(await f.manager().enqueueDue(), 0);
  for (const job of Object.values(f.runtime.repository.read().tasks).filter(item => item.templateId)) {
    assert.equal(job.provenance.dependencyVersions.length, 10);
    assert.equal(job.provenance.dependencyVersions.some(dep => dep.memoryId === task.checkpoint.memoryIds![0]), false);
  }
});

test('CRLF evidence remains valid across knowledge canonicalization without widening quote identity', async () => {
  const f = await fixture(); const raw = await f.retain('我\r\n喜欢茶'); const lease = await due(f); await f.manager().run(lease);
  assert.equal(derivedCalls(f)[0]!.input.evidence![0]!.fact.quote, raw.checkpoint.facts![0]!.quote);
  assert.equal(derivedMemories(f).length, 1);
});

for (const corrupt of ['checkpoint-quote', 'memory-hash'] as const) test(`cold selector rejects ${corrupt} corruption rather than trusting durable fact shape`, async () => {
  const f = await fixture(); const raw = await f.retain(); const stored = f.runtime.control.value;
  if (corrupt === 'checkpoint-quote') stored.tasks[raw.taskId]!.checkpoint.facts![0]!.quote = '不在原文的伪造引文';
  else stored.memories[stored.activeMemory[raw.checkpoint.memoryIds![1]!]!]!.text = 'corrupted saved text';
  f.runtime.advance(60_000);
  const repository = await ControlRepository.open(f.runtime.control, f.runtime.ledger,
    { ownerId: 'corrupt-fact-owner', isHeld: () => true }, { now: f.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => f.runtime.now });
  const manager = new DerivedManager(repository, queue,
    new BankCoordinator(repository, f.adapter, { now: () => f.runtime.now, schedule: f.timers.schedule }), f.model.caller,
    { signal: f.runtime.abort.signal, now: () => f.runtime.now });
  assert.equal(await manager.enqueueDue(), 0); assert.equal(f.model.calls.length, 1);
});

test('sixty-second debounce is capped at snapshot maximum wait despite a continuously busy source', async () => {
  const f = await fixture(); const firstAt = f.runtime.now; await f.retain('报告0');
  for (let index = 1; index <= 6; index++) { f.runtime.advance(50_000); await f.retain(`报告${index}`); }
  const rows = Object.values(f.runtime.repository.read().refresh);
  assert.equal(rows.every(row => row.dirtyRevision === 7 && row.firstDirtyAt === firstAt && row.nextRunAt === firstAt + 300_000), true);
  assert.equal(await f.manager().enqueueDue(), 4);
});

test('one observation and three fixed mental templates use only original retain and explicit version metadata', async () => {
  const f = await fixture(); await f.retain(); await due(f, 4).then(async first => {
    await f.manager().run(first);
    for (let index = 0; index < 3; index++) { const lease = await f.queue.claimNext(); assert.ok(lease); await f.manager().run(lease); }
  });
  const memories = derivedMemories(f); assert.equal(memories.length, 4);
  assert.deepEqual(memories.map(memory => memory.templateId).sort(), [...DERIVED_TEMPLATES].sort());
  for (const memory of memories) {
    assert.equal(memory.coveredRevision, 1); assert.equal(memory.stale, false); assert.ok(memory.scopeKey);
    assert.equal(memory.generatedAt, f.runtime.now); assert.ok(memory.provenance.dependencyVersions.length > 0);
    assert.match(memory.text!, /宿主独立世界证据数：1/);
  }
  assert.equal(derivedCalls(f).length, 4);
  assert.equal(derivedCalls(f).every(call => call.options.provider === 'original-retain'
    && call.options.model === 'model-retain' && call.options.tools === undefined), true);
  assert.equal(Object.values(f.runtime.repository.read().tasks).filter(task => task.templateId).every(task => task.state === 'done' && task.stage === 'done'), true);
});

test('new facts stale only the exact affected source scope, never every model in the bank', async () => {
  const f = await fixture(); await f.retain(); const first = await due(f, 4); await f.manager().run(first);
  for (let index = 0; index < 3; index++) { const lease = await f.queue.claimNext(); assert.ok(lease); await f.manager().run(lease); }
  await f.retain('另一群喜欢咖啡', { group_id: '301' });
  assert.equal(derivedMemories(f).every(memory => !memory.stale), true);
  const oldRows = Object.values(f.runtime.repository.read().refresh).filter(row => row.coveredRevision === 1);
  assert.equal(oldRows.length, 4); assert.equal(oldRows.every(row => row.dirtyRevision === 1), true);
  await f.retain('原群改变偏好');
  assert.equal(derivedMemories(f).every(memory => memory.stale), true);
  assert.equal(Object.values(f.runtime.repository.read().refresh).filter(row => row.coveredRevision === 1).every(row => row.dirtyRevision === 2), true);
});

test('bot experience stays in its own scope, closes transitive facts, and never consumes its previous same-identity summary', async () => {
  const f = await fixture(); const world = await f.retain('用户报告');
  const worldId = world.checkpoint.memoryIds![1]!;
  const worldFact = f.runtime.repository.read().memories[f.runtime.repository.read().activeMemory[worldId]!]!;
  const firstExperience = await confirmedExperience(f, world, '机器人确认第一段经历', [worldFact]);
  const scopeKey = derivedScopeKey('bot-experience', firstExperience.provenance.sourceRefs);
  const row = Object.values(f.runtime.repository.read().refresh).find(item => item.scopeKey === scopeKey && item.templateId === 'observation')!;
  assert.ok(row); assert.equal(Object.keys(f.runtime.repository.read().refresh).length, 8);
  const firstLease = await enqueueOneRow(f, row.key); await f.manager().run(firstLease);
  const previous = derivedMemories(f)[0]!;
  assert.match(previous.text!, /宿主独立世界证据数：0/);
  assert.equal(previous.provenance.dependencyVersions.some(dep => dep.memoryId === worldId), true);
  assert.equal(previous.provenance.dependencyVersions.some(dep => dep.memoryId === firstExperience.checkpoint.memoryIds![1]), true);
  assert.equal(derivedCalls(f)[0]!.input.evidence!.every(item => item.fact.quote === '机器人确认第一段经历'), true);
  // The second experience depends on the previous summary through reply generation.
  // Feeding it back into that identity would make deactivating the previous version impossible.
  await confirmedExperience(f, world, '依赖旧摘要的第二段经历', [previous]);
  assert.equal(derivedMemories(f)[0]!.stale, true);
  const secondLease = await enqueueOneRow(f, row.key); await f.manager().run(secondLease);
  const last = derivedCalls(f).at(-1)!;
  assert.equal(last.input.evidence!.some(item => item.fact.quote === '依赖旧摘要的第二段经历'), false);
  const task = f.runtime.repository.read().tasks[secondLease.taskId]!;
  assert.equal(task.provenance.dependencyVersions.some(dep => dep.memoryId === previous.memoryId), false);
  assert.equal(derivedMemories(f)[0]!.version, 2);
  assert.equal(derivedMemories(f)[0]!.scopeKey, scopeKey);
});

test('a dirty window retains its first trigger snapshot even after route and debounce config changes', async () => {
  const f = await fixture(); const raw = await f.retain();
  await f.runtime.changeConfiguration({ ...f.runtime.current.config, memory: { ...f.runtime.current.config.memory, refreshDebounceMs: 120_000 },
    models: Object.fromEntries(STAGES.map(stage => [stage, { selection: 'explicit', provider: `new-${stage}`, model: `new-model-${stage}` }])) });
  await f.retain('后来补充');
  assert.equal(Object.values(f.runtime.repository.read().refresh).every(row => row.snapshotId === raw.snapshotId), true);
  const lease = await due(f); await f.manager().run(lease);
  assert.equal(derivedCalls(f)[0]!.options.provider, 'original-retain');
  assert.equal(derivedCalls(f)[0]!.options.model, 'model-retain');
});

function evidence(overrides: Partial<DerivedEvidence> = {}): DerivedEvidence {
  const provenance: Provenance = { complete: true, sourceRefs: [{ sourceId: 's', sourceEpoch: 1 }], messageKeys: ['m1'], dependencyVersions: [] };
  return { evidenceId: 'e1', originalEvidenceId: 'retain:m1', memoryId: 'fact1', version: 1,
    family: 'world', author: 'qq:200', independentWorldReport: true, fact: fact('我报告喜欢茶'), provenance, ...overrides };
}
const reported = (items: readonly DerivedEvidence[], confidence = 'reported') => ({ summary: '有证据支持的报告', confidence, inferred: confidence === 'inferred',
  support: items.map(item => ({ evidenceId: item.evidenceId, quote: item.fact.quote })), opposition: [] });
test('host proofcount deduplicates original report, author and copied quote; bot parrots never corroborate world', () => {
  const a = evidence();
  const otherAuthor = evidence({ evidenceId: 'e2', originalEvidenceId: 'retain:m2', author: 'qq:201', fact: fact('另一个独立报告喜欢茶') });
  assert.equal(validateDerivedOutput(reported([a, otherAuthor], 'corroborated'), [a, otherAuthor]).proofCount, 2);
  for (const duplicate of [
    { ...otherAuthor, originalEvidenceId: a.originalEvidenceId },
    { ...otherAuthor, author: a.author },
    { ...otherAuthor, fact: a.fact },
    { ...otherAuthor, family: 'bot-experience' as const, independentWorldReport: false },
    { ...otherAuthor, independentWorldReport: false },
  ]) {
    assert.equal(validateDerivedOutput(reported([a, duplicate]), [a, duplicate]).proofCount, 1);
    assert.throws(() => validateDerivedOutput(reported([a, duplicate], 'corroborated'), [a, duplicate]));
  }
});

for (const variant of ['foreign-id', 'partial-quote', 'fake-quote', 'fake-proof', 'fake-source', 'inferred-report'] as const) {
  test(`invalid derived output ${variant} gets at most one same-route repair and no knowledge write`, async () => {
    const f = await fixture(); await f.retain(); const lease = await due(f); const writes = f.service.docs.size;
    f.model.setOutput(input => {
      const result = summary(input);
      if (variant === 'foreign-id') result.support[0]!.evidenceId = 'unprovided-evidence';
      else if (variant === 'partial-quote') result.support[0]!.quote = '茶';
      else if (variant === 'fake-quote') result.support[0]!.quote = '伪造引文';
      else if (variant === 'inferred-report') return { ...result, inferred: true };
      else if (variant === 'fake-proof') return { ...result, proofCount: 9 };
      else return { ...result, sourceId: 'model-selected-source' };
      return result;
    });
    await assert.rejects(f.manager().run(lease), /invalid-structured-output/);
    assert.equal(derivedCalls(f).length, 2); assert.equal(f.service.docs.size, writes);
    const task = f.runtime.repository.read().tasks[lease.taskId]!;
    assert.equal(task.checkpoint.derived, undefined); assert.equal(task.calls, 2); assert.ok(task.reservedTokens > 0);
  });
}

test('model output checkpoint precedes any intent and cold retry performs no second generation', async () => {
  const f = await fixture(); await f.retain(); const lease = await due(f);
  const plan = f.banks.planVersion.bind(f.banks); let interrupted = false;
  f.banks.planVersion = async (input, guard) => {
    if (input.kind === 'observation' || input.kind === 'mental-model') {
      assert.ok(f.runtime.repository.read().tasks[lease.taskId]!.checkpoint.derived);
      if (!interrupted) { interrupted = true; throw new Error('pre-intent crash'); }
    }
    return plan(input, guard);
  };
  await assert.rejects(f.manager().run(lease)); assert.equal(derivedCalls(f).length, 1);
  const repository = await ControlRepository.open(f.runtime.control, f.runtime.ledger,
    { ownerId: 'derived-cold-owner', isHeld: () => true }, { now: f.runtime.now });
  const queue = new RetainTaskQueue(repository, { now: () => f.runtime.now }); const retry = await queue.claimNext(); assert.ok(retry);
  const banks = new BankCoordinator(repository, f.adapter, { now: () => f.runtime.now, schedule: f.timers.schedule });
  await new DerivedManager(repository, queue, banks, f.model.caller, { signal: f.runtime.abort.signal, now: () => f.runtime.now }).run(retry);
  assert.equal(derivedCalls(f).length, 1); assert.equal(repository.read().tasks[lease.taskId]!.state, 'done');
});

for (const action of ['forget', 'revoke', 'lease', 'abort'] as const) test(`${action} during model execution fences output before checkpoint or knowledge write`, async () => {
  const f = await fixture(); const raw = await f.retain(); const lease = await due(f); const entered = deferred(); const release = deferred();
  f.model.setHook(async input => { if (input.evidence) { entered.resolve(); await release.promise; } });
  const pending = f.manager().run(lease); const rejected = assert.rejects(pending); await entered.promise;
  if (action === 'forget') await f.runtime.repository.recordDeletion('forget-in-flight', { kind: 'messages', messageKeys: raw.provenance.messageKeys }, 'forget', f.runtime.now);
  else if (action === 'revoke') await f.runtime.repository.recordDeletion('revoke-in-flight', { kind: 'source',
    sourceId: raw.provenance.sourceRefs[0]!.sourceId, throughEpoch: raw.provenance.sourceRefs[0]!.sourceEpoch }, 'revoke', f.runtime.now);
  else if (action === 'lease') f.runtime.advance(120_001);
  else f.runtime.abort.abort();
  release.resolve(); await rejected;
  assert.equal(f.runtime.repository.read().tasks[lease.taskId]!.checkpoint.derived, undefined);
  assert.equal(derivedMemories(f).length, 0);
  assert.equal(Object.values(f.runtime.repository.read().memories).some(memory => memory.templateId), false);
});

test('an expired old lease callback cannot checkpoint a reclaimed task attempt', async () => {
  const f = await fixture(); await f.retain(); const oldLease = await due(f); const entered = deferred(); const release = deferred();
  f.model.setHook(async input => { if (input.evidence) { entered.resolve(); await release.promise; } });
  const pending = f.manager().run(oldLease); const rejected = assert.rejects(pending); await entered.promise;
  f.runtime.advance(120_001); const nextLease = await f.queue.claimNext(); assert.ok(nextLease);
  assert.equal(nextLease.taskId, oldLease.taskId); assert.ok(nextLease.leaseToken > oldLease.leaseToken);
  release.resolve(); await rejected;
  assert.equal(f.runtime.repository.read().tasks[nextLease.taskId]!.checkpoint.derived, undefined);
  assert.equal(f.runtime.repository.read().tasks[nextLease.taskId]!.leaseToken, nextLease.leaseToken);
});

test('a newly arrived fact during generation forces recomputation and preserves cumulative calls and all used provenance', async () => {
  const f = await fixture(); const raw = await f.retain('早期报告'); const lease = await due(f); let arrived = false;
  f.model.setHook(async input => {
    if (input.evidence && !arrived) { arrived = true; await f.retain('后来报告', { user_id: '201' }); }
  });
  await f.manager().run(lease);
  assert.equal(derivedCalls(f).length, 2);
  const task = f.runtime.repository.read().tasks[lease.taskId]!;
  assert.equal(task.calls, 2); assert.equal(task.attemptCalls, 2); assert.ok(task.reservedTokens > 0);
  assert.equal(task.provenance.messageKeys.includes(raw.provenance.messageKeys[0]!), true);
  assert.equal(task.provenance.messageKeys.length, 2);
  const output = derivedMemories(f)[0]!;
  assert.equal(output.coveredRevision, 2); assert.equal(output.stale, false);
});

test('old-input deletion during CAS recomputation cancels rather than dropping tainted provenance', async () => {
  const f = await fixture(); const old = await f.retain('最初已被模型使用的报告'); const lease = await due(f); let generation = 0;
  f.model.setHook(async input => {
    if (!input.evidence) return;
    generation++;
    if (generation === 1) await f.retain('新报告', { user_id: '201' });
    else await f.runtime.repository.recordDeletion('forget-old-used-input', { kind: 'messages', messageKeys: old.provenance.messageKeys }, 'forget', f.runtime.now);
  });
  await assert.rejects(f.manager().run(lease));
  const task = f.runtime.repository.read().tasks[lease.taskId]!;
  assert.equal(task.state, 'cancelled');
  assert.equal(task.provenance.messageKeys.includes(old.provenance.messageKeys[0]!), true);
  assert.equal(task.checkpoint.derived, undefined); assert.equal(derivedCalls(f).length, 2); assert.equal(derivedMemories(f).length, 0);
});

test('scope revision changes after knowledge write cannot activate stale output; losing documents are queued for cleanup', async () => {
  const f = await fixture(); await f.retain(); const lease = await due(f); let raced = false;
  const activate = f.banks.activate.bind(f.banks);
  f.banks.activate = async (plan, guard) => {
    if (plan.memoryId.includes('mental-model') || plan.memoryId.includes('observation')) {
      if (!raced) { raced = true; await f.retain('在激活前新增事实'); }
    }
    return activate(plan, guard);
  };
  await f.manager().run(lease);
  assert.equal(derivedCalls(f).length, 2);
  const losing = Object.values(f.runtime.repository.read().memories).find(memory => memory.templateId && !memory.active)!;
  assert.ok(losing); assert.equal(losing.state, 'invalidated'); assert.equal(losing.text, undefined);
  assert.equal(Object.values(f.runtime.repository.read().maintenance).some(task => task.kind === 'cleanup' && task.docIds.includes(losing.docId!)), true);
  assert.equal(derivedMemories(f)[0]!.coveredRevision, 2);
});

test('bank CAS races recompute at most twice per run under original snapshot and retain persistent cost history', async () => {
  const f = await fixture(); await f.retain(); const lease = await due(f); const activate = f.banks.activate.bind(f.banks);
  f.banks.activate = async (plan, guard) => {
    if (plan.memoryId.includes('mental-model') || plan.memoryId.includes('observation')) {
      await f.runtime.repository.transact({ kind: 'metadata', fence: f.runtime.repository.fence }, draft => { draft.banks[plan.bankKey]!.revision++; });
    }
    return activate(plan, guard);
  };
  await assert.rejects(f.manager().run(lease), /derived-cas-recompute-limit/);
  assert.equal(derivedCalls(f).length, 2); const task = f.runtime.repository.read().tasks[lease.taskId]!;
  assert.equal(task.calls, 2); assert.equal(task.checkpoint.derived, undefined); assert.ok(task.reservedTokens > 0);
  assert.equal(derivedMemories(f).length, 0);
  assert.equal(Object.values(f.runtime.repository.read().maintenance).filter(work => work.kind === 'cleanup').length, 2);
  await f.queue.fail(lease, 'derived-cas-recompute-limit');
  assert.equal(f.runtime.repository.read().tasks[lease.taskId]!.calls, 2);
});

test('eight-call attempt ceiling includes repairs and pre-existing persistent reservations', async () => {
  const f = await fixture(); await f.retain(); const lease = await due(f);
  // Simulate seven completed dispatch reservations within this same still-live attempt.
  for (let index = 0; index < 7; index++) await f.queue.reserveCall(lease, 1);
  f.model.setOutput(() => 'not JSON');
  await assert.rejects(f.manager().run(lease), /call-budget/);
  assert.equal(derivedCalls(f).length, 1);
  const task = f.runtime.repository.read().tasks[lease.taskId]!;
  assert.equal(task.calls, 8); assert.equal(task.attemptCalls, 8); assert.equal(task.checkpoint.derived, undefined);
});

test('quota admission defers before durable call reservation and does not spend retry or lifetime token budgets', async () => {
  const f = await fixture(); await f.retain(); const lease = await due(f); const retryAt = f.runtime.now + 60_000;
  let deferredError: unknown;
  try { await f.manager({ admitCall: async () => { throw new DispatchDeferred('retain', retryAt); } }).run(lease); }
  catch (error) { deferredError = error; }
  assert.ok(deferredError instanceof DispatchDeferred);
  await f.queue.defer(lease, deferredError.retryAt);
  const task = f.runtime.repository.read().tasks[lease.taskId]!;
  assert.equal(task.calls, 0); assert.equal(task.reservedTokens, 0); assert.equal(task.retryCount, 0);
  assert.equal(task.nextRunAt, retryAt); assert.equal(derivedCalls(f).length, 0);
});

test('forget one message reconstructs same-source models only from remaining facts, never edited old summaries', async () => {
  const f = await fixture(); const forgotten = await f.retain('要删除的茶报告'); const remaining = await f.retain('保留的咖啡报告');
  const lease = await due(f); await f.manager().run(lease);
  const previous = derivedMemories(f)[0]!;
  const target = { kind: 'messages' as const, messageKeys: forgotten.provenance.messageKeys };
  await f.runtime.repository.recordDeletion('forget-one-report', target, 'forget', f.runtime.now);
  assert.equal(f.runtime.repository.read().memories[memoryVersionKey(previous.memoryId, previous.version)]!.active, false);
  await f.manager().afterDeletion(target);
  const revisions = Object.values(f.runtime.repository.read().refresh).map(row => row.dirtyRevision);
  await f.manager().afterDeletion(target);
  assert.deepEqual(Object.values(f.runtime.repository.read().refresh).map(row => row.dirtyRevision), revisions);
  // Run the newly scheduled recomputation; only one derived job was enqueued before deletion.
  const next = await f.queue.claimNext(); assert.ok(next); await f.manager().run(next);
  const last = derivedCalls(f).at(-1)!;
  assert.equal(last.input.evidence!.every(item => item.fact.quote === '保留的咖啡报告'), true);
  const task = f.runtime.repository.read().tasks[next.taskId]!;
  assert.equal(task.provenance.messageKeys.includes(forgotten.provenance.messageKeys[0]!), false);
  assert.equal(task.provenance.messageKeys.includes(remaining.provenance.messageKeys[0]!), true);
  assert.equal(derivedMemories(f).some(memory => memory.text!.includes('要删除的茶报告')), false);
});

test('forgetting an entire source epoch never reopens it, and unknown writes remain a purge limitation', async () => {
  const f = await fixture(); const raw = await f.retain(); const lease = await due(f); const entered = deferred(); const release = deferred();
  f.service.beforeAdd = async () => { entered.resolve(); await release.promise; };
  const pending = f.manager().run(lease); const rejected = assert.rejects(pending); await entered.promise;
  const target = { kind: 'source' as const, sourceId: raw.provenance.sourceRefs[0]!.sourceId,
    throughEpoch: raw.provenance.sourceRefs[0]!.sourceEpoch };
  await f.runtime.repository.recordDeletion('forget-source', target, 'forget', f.runtime.now);
  await f.manager().afterDeletion(target); release.resolve(); await rejected;
  assert.equal(derivedMemories(f).length, 0); assert.equal(await f.manager().enqueueDue(), 0);
  assert.equal(Object.values(f.runtime.repository.read().refresh).length, 0);
  assert.notEqual(f.runtime.repository.read().forgetTasks['forget-source']!.state, 'purged');
  assert.equal(f.runtime.repository.read().forgottenSources[target.sourceId], target.throughEpoch);
});

test('a derived dispatch sees every actual input own-version in the durable task before the model runs', async () => {
  const f = await fixture(); const raw = await f.retain(); const lease = await due(f);
  f.model.setHook(async input => {
    if (!input.evidence) return;
    const task = f.runtime.repository.read().tasks[lease.taskId]!;
    for (const item of input.evidence) {
      const factIndex = raw.checkpoint.facts!.findIndex(value => value.quote === item.fact.quote);
      assert.ok(factIndex >= 0);
      const id = memoryIdFor(raw.bankKey, 'world', `fact-${raw.taskId}-${factIndex}`);
      assert.equal(task.provenance.dependencyVersions.some(dep => dep.memoryId === id && dep.version === 1), true);
    }
    assert.equal(task.calls, 1);
    assert.equal(task.provenance.dependencyVersions.some(dep => dep.memoryId === raw.checkpoint.memoryIds![0]), false);
  });
  await f.manager().run(lease);
});
