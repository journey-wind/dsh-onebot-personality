import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
import { StageCaller } from '../src/llm/calls.js';
import type { CallBudget, CallContext, SchemaParser } from '../src/llm/calls.js';
import type { Stage } from '../src/config.js';
import { BankCoordinator, memoryIdFor } from '../src/memory/banks.js';
import { KnowledgeAdapter } from '../src/memory/knowledge.js';
import { RecallEngine, RecallError } from '../src/memory/recall.js';
import { LivePolicy } from '../src/policy/live.js';
import { Outbox } from '../src/runtime/outbox.js';
import { OnlinePipeline } from '../src/runtime/online.js';
import { RetainTaskQueue } from '../src/runtime/tasks.js';
import type { OneBotClient, PreparedSend, ReadyIdentity } from '../src/onebot/client.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge, ManualDeadlines } from './helpers/knowledge.js';

interface Output { text: string; finish?: 'stop' | 'max-tokens' }
type Script = Output | ((data: Record<string, unknown>) => Output | Promise<Output>);
class ScriptedLlm implements Pick<LlmRuntime, 'prepareCall'> {
  readonly calls: GenerateOptions[] = [];
  readonly scripts = new Map<string, Script[]>();
  onCall: (model: string) => Promise<void> = async () => {};
  put(model: string, ...outputs: Script[]) { this.scripts.set(model, outputs); }
  prepareCall: LlmRuntime['prepareCall'] = async config => ({
    config, context: { contextWindow: 1_000_000 },
    retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }, adapterDefaults: {},
    stream: async function* (this: ScriptedLlm, options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.calls.push(options);
      const model = String(options.model); await this.onCall(model);
      const content = options.messages[0]?.content;
      assert.ok(Array.isArray(content));
      const block = content[0]; assert.ok(block && block.type === 'text');
      const script = this.scripts.get(model)?.shift();
      if (!script) throw new Error('unexpected script model/call');
      const out = typeof script === 'function' ? await script(JSON.parse(block.text) as Record<string, unknown>) : script;
      yield { type: 'text-delta', index: 0, text: out.text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: out.text } };
      yield { type: 'finish', reason: { kind: out.finish ?? 'stop' } };
    }.bind(this),
  });
}
class Transport implements Pick<OneBotClient, 'identity' | 'prepareTextSend'> {
  identity: ReadyIdentity | undefined = { selfId: '100', connectionEpoch: 'epoch-1' };
  readonly sent: string[] = [];
  private sequence = 0;
  prepareTextSend(_type: 'private' | 'group', _id: string, text: string): PreparedSend {
    const echo = `echo-${++this.sequence}`;
    return { echo, connectionEpoch: 'epoch-1', submit: () => {
      this.sent.push(text); return Promise.resolve({ state: 'succeeded', messageId: `sent-${this.sent.length}` });
    } };
  }
}
const plan = { text: JSON.stringify({ queries: ['红茶'], entities: [] }) };
const noEvidenceDigest = { text: JSON.stringify({ summary: '只保留合法原始证据。', evidenceIds: [], quotes: [] }) };
function digest(data: Record<string, unknown>): Output {
  const evidence = data.evidence as { evidenceId: string; text: string }[];
  return { text: JSON.stringify({ summary: evidence.length ? '原话显示偏好红茶。' : '没有证据，未知。',
    evidenceIds: evidence.map(item => item.evidenceId), quotes: evidence.length ? [{ evidenceId: evidence[0]!.evidenceId, quote: '红茶' }] : [] }) };
}
function reply(data: Record<string, unknown>): Output {
  const evidence = data.evidence as { evidenceId: string; text: string }[];
  return { text: evidence.length ? `你说过喜欢红茶。[[cite:${evidence[0]!.evidenceId}]]` : '没有已授权记忆证据，我不知道。' };
}
async function fixture(seed = false, input: Record<string, unknown> = {}) {
  const f = await runtimeFixture(input);
  const first = await f.admit({ message_id: '1', message: [{ type: 'text', data: { text: seed ? '小忆 我喜欢红茶' : '小忆 你好' } }] });
  assert.equal(first.status, 'accepted');
  if (first.status !== 'accepted' || !first.replyId) throw new Error('fixture missing reply');
  let replyId = first.replyId;
  const service = new InMemoryKnowledge(); const adapter = new KnowledgeAdapter(service);
  let memoryId: string | undefined;
  if (seed) {
    const queue = new RetainTaskQueue(f.repository, { now: () => f.now }); const lease = await queue.claimNext(); assert.ok(lease);
    const guard = queue.guard(lease); const task = f.repository.read().tasks[lease.taskId]!;
    const coordinator = new BankCoordinator(f.repository, adapter, { now: () => f.now, schedule: new ManualDeadlines().schedule });
    await coordinator.ensureBank(task.bankKey, guard);
    memoryId = memoryIdFor(task.bankKey, 'world', 'tea');
    const prepared = await coordinator.planVersion({ bankKey: task.bankKey, memoryId, operationKey: 'tea', kind: 'world',
      text: '用户报告偏好。原话：我喜欢红茶', provenance: guard.provenance, entities: ['qq:200'] }, guard);
    await coordinator.writeVersion(prepared, guard); await coordinator.activate(prepared, guard);
    const second = await f.admit({ message_id: '2', message: [{ type: 'text', data: { text: '小忆 我喜欢什么茶' } }] });
    if (second.status !== 'accepted' || !second.replyId) throw new Error('fixture missing second reply');
    replyId = second.replyId;
  }
  service.calls.length = 0;
  const transport = new Transport(); const abort = new AbortController();
  const policy = new LivePolicy(f.repository, { readConfiguration: () => f.current, now: () => f.now,
    onebot: { get identity() { return transport.identity; }, getGroupMemberInfo: async (groupId, userId) => ({
      selfId: '100', connectionEpoch: 'epoch-1', groupId, userId, checkedAt: f.now,
    }) } });
  const outbox = new Outbox(f.repository, transport, { readConfiguration: () => f.current, now: () => f.now,
    authorizeReply: async (r, force) => {
      abort.signal.throwIfAborted(); const guard = await policy.authorizeReply(r, force);
      return { ...guard, validateLive: () => !abort.signal.aborted && guard.validateLive?.() === true };
    } });
  const llm = new ScriptedLlm();
  const recall = new RecallEngine(f.repository, adapter, policy, { readConfiguration: () => f.current, now: () => f.now });
  const pipeline = new OnlinePipeline(f.repository, policy, recall, new StageCaller(llm), outbox, { signal: abort.signal, now: () => f.now });
  return { f, service, adapter, memoryId, replyId, transport, abort, policy, outbox, llm, recall, pipeline,
    models: () => llm.calls.map(call => call.model) };
}

test('chat uses router then reply only, never waits retain or touches knowledge, and queues confirmed experience', async () => {
  const s = await fixture();
  s.llm.put('router', { text: '{"mode":"chat"}' }); s.llm.put('reply', { text: '你好！[CQ:at,qq=all] 只是文字。' });
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.deepEqual(s.models(), ['router', 'reply']);
  assert.deepEqual(s.service.calls, []);
  assert.equal(s.transport.sent.join(''), '你好！[CQ:at,qq=all] 只是文字。');
  const tasks = Object.values(s.f.repository.read().tasks);
  assert.equal(tasks.find(task => task.kind === 'retain')!.state, 'pending');
  assert.equal(tasks.filter(task => task.kind === 'experience').length, 1);
  assert.ok(s.llm.calls.every(call => call.tools === undefined && call.purpose === undefined));
});

test('recall plans, reads authorized evidence, validates digest and replies on four distinct stage calls', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('recall', plan, digest); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.deepEqual(s.models(), ['router', 'recall', 'recall', 'reply']);
  assert.ok(result.provenance.dependencyVersions.some(dep => dep.memoryId === s.memoryId && dep.version === 1));
  assert.equal(result.provenance.messageKeys.length, 2);
  assert.match(s.transport.sent.join(''), /红茶/);
  assert.equal(s.service.calls.includes('add'), false, 'online retrieval creates no new memory body');
});

test('citation subset cannot shrink dependencies already supplied to recall or router recent history', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('recall', plan, noEvidenceDigest); s.llm.put('reply', { text: '谨慎回答。' });
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed');
  assert.ok(result.provenance.dependencyVersions.some(dep => dep.memoryId === s.memoryId));
  assert.equal(result.provenance.messageKeys.length, 2);
});

test('router malformed output repairs only router once then degrades to recall without provider fallback', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: 'bad' }, { text: '{"mode":"shell","bankId":"private"}' });
  s.llm.put('recall', plan, digest); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.deepEqual(s.models(), ['router', 'router', 'recall', 'recall', 'reply']);
  assert.ok(result.stageErrors?.includes('router:invalid-structured-output'));
});

test('recall planning failure uses bounded literal query, not model-specified bank or document IDs', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: '{"mode":"recall"}' });
  s.llm.put('recall', { text: '{"queries":["红茶"],"docIds":["private"]}' }, { text: 'not JSON' }, digest); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.match(s.transport.sent.join(''), /红茶/);
  assert.deepEqual(s.models(), ['router', 'recall', 'recall', 'recall', 'reply']);
});

test('empty model time range is repaired in recall planning then falls back to a literal query', async () => {
  const s = await fixture(true);
  const invalid = { text: '{"queries":["红茶"],"timeRange":{}}' };
  s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('recall', invalid, invalid, digest); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.match(s.transport.sent.join(''), /红茶/);
  assert.deepEqual(s.models(), ['router', 'recall', 'recall', 'recall', 'reply']);
  assert.ok(result.stageErrors?.includes('recall:invalid-structured-output'));
});

test('fabricated digest citation gets one same-recall repair then raw evidence remains usable', async () => {
  const s = await fixture(true);
  const fake = { text: '{"summary":"fake","evidenceIds":["forged"],"quotes":[]}' };
  s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('recall', plan, fake, fake); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.ok(result.stageErrors?.includes('recall:invalid-structured-output'));
  assert.match(s.transport.sent.join(''), /红茶/);
});

test('reflect requests missing questions but at most three recall rounds use recall, never a sixth model', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: '{"mode":"reflect"}' }); s.llm.put('recall', plan, digest, plan, digest, plan, digest);
  const reflect = (data: Record<string, unknown>): Output => ({ text: JSON.stringify({
    ...JSON.parse(digest(data).text) as Record<string, unknown>, needsMoreEvidence: true, missingQuestions: ['还有其它偏好吗？'],
  }) });
  s.llm.put('reflect', reflect, reflect, reflect); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed');
  assert.deepEqual(s.models(), ['router', 'recall', 'recall', 'reflect', 'recall', 'recall', 'reflect', 'recall', 'recall', 'reflect', 'reply']);
  assert.equal(s.llm.calls.length, 11); assert.equal(s.models().includes('retain'), false);
});

test('reflect failure preserves recall evidence and still uses the independent reply route', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: '{"mode":"reflect"}' }); s.llm.put('recall', plan, digest);
  s.llm.put('reflect', { text: 'bad' }, { text: 'bad' }); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.ok(result.stageErrors?.includes('reflect:invalid-structured-output'));
  assert.deepEqual(s.models(), ['router', 'recall', 'recall', 'reflect', 'reflect', 'reply']);
});

for (const failure of ['incomplete', 'fake-citation'] as const) {
  test(`reply ${failure} never persists a sendable partial or creates experience`, async () => {
    const s = await fixture(); s.llm.put('router', { text: '{"mode":"chat"}' });
    s.llm.put('reply', failure === 'incomplete' ? { text: 'partial', finish: 'max-tokens' } : { text: '伪引用 [[cite:not-provided]]' });
    const result = await s.pipeline.run(s.replyId);
    assert.equal(result.state, 'failed'); assert.equal(s.transport.sent.length, 0);
    assert.equal(Object.keys(s.f.repository.read().segments).length, 0);
    assert.equal(Object.values(s.f.repository.read().tasks).filter(task => task.kind === 'experience').length, 0);
  });
}

test('config change while router is in flight cancels without quality degradation or later model/send', async () => {
  const s = await fixture(); s.llm.put('router', { text: '{"mode":"chat"}' });
  s.llm.onCall = async model => { if (model === 'router') await s.f.changeConfiguration(structuredClone(s.f.current.config)); };
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'cancelled'); assert.deepEqual(s.models(), ['router']); assert.equal(s.transport.sent.length, 0);
});

test('forgetting any actual prior input while reply is in flight prevents output and all experience compensation', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('recall', plan, digest); s.llm.put('reply', reply);
  s.llm.onCall = async model => {
    if (model !== 'reply') return;
    const prior = Object.values(s.f.repository.read().messages).find(message => message.messageId === '1')!;
    await s.f.repository.recordDeletion('forget-prior', { kind: 'messages', messageKeys: [prior.key] });
  };
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'cancelled'); assert.equal(s.transport.sent.length, 0);
  assert.equal(Object.values(s.f.repository.read().tasks).filter(task => task.kind === 'experience').length, 0);
});

test('budget of two calls preserves reply after router; retrieval is code-only and does not reset counts', async () => {
  const s = await fixture(true, { budgets: { onlineMaxLlmCalls: 2 } });
  s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('reply', reply);
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.deepEqual(s.models(), ['router', 'reply']);
  assert.match(s.transport.sent.join(''), /红茶/); assert.ok(result.stageErrors?.includes('recall:call-budget'));
});

test('normalized escaped synthesis still fits reply reservation after all nonreply capacity is consumed', async () => {
  const s = await fixture(true);
  s.llm.put('router', { text: '{"mode":"recall"}' });
  s.llm.put('recall', plan, data => {
    const id = (data.evidence as { evidenceId: string }[])[0]!.evidenceId;
    return { text: JSON.stringify({ summary: '\u0000'.repeat(1000), evidenceIds: Array(100).fill(id), quotes: [] }) };
  });
  s.llm.put('reply', data => {
    assert.equal((data.synthesis as { evidenceIds: string[] }).evidenceIds.length, 1, 'duplicate IDs are not forwarded');
    return { text: 'reservation survived' };
  });
  const actual = new StageCaller(s.llm); let captured: CallBudget | undefined;
  const wrapper: Pick<StageCaller, 'text' | 'structured'> = {
    text: actual.text.bind(actual),
    async structured<T>(stage: Stage, system: string, data: unknown, parser: SchemaParser<T>, ctx: CallContext): Promise<T> {
      const result = await actual.structured(stage, system, data, parser, ctx);
      if (stage === 'recall' && data !== null && typeof data === 'object' && 'evidence' in data) {
        // Model accumulated earlier legitimate input reservations at the exact nonreply ceiling.
        ctx.budget.reservedTokens = ctx.budget.maxReservedTokens - ctx.budget.replyTokenReserve; captured = ctx.budget;
      }
      return result;
    },
  };
  const pipeline = new OnlinePipeline(s.f.repository, s.policy, s.recall, wrapper, s.outbox, { signal: s.abort.signal, now: () => s.f.now });
  assert.equal((await pipeline.run(s.replyId)).state, 'completed');
  assert.ok(captured); assert.ok(captured.reservedTokens <= captured.maxReservedTokens);
  assert.equal(captured.calls, 4); assert.deepEqual(s.transport.sent, ['reservation survived']);
});

test('serialized synthesis overflow repairs only recall then falls back to raw evidence', async () => {
  const s = await fixture(true);
  const oversized: Script = data => ({ text: JSON.stringify({ summary: '\u0000'.repeat(2048),
    evidenceIds: (data.evidence as { evidenceId: string }[]).map(item => item.evidenceId), quotes: [] }) });
  s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('recall', plan, oversized, { text: JSON.stringify({
    summary: '\u0000'.repeat(2048), evidenceIds: [], quotes: [] }) });
  s.llm.put('reply', data => { assert.equal(data.synthesis, null); return reply(data); });
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'completed'); assert.ok(result.stageErrors?.includes('recall:invalid-structured-output'));
  assert.deepEqual(s.models(), ['router', 'recall', 'recall', 'recall', 'reply']);
});

test('complete output exceeding all-segment budget is a specific failed reply, not an authorization cancellation', async () => {
  const s = await fixture(false, { budgets: { sendCodePoints: 2, sendMaxSegments: 1 } });
  s.llm.put('router', { text: '{"mode":"chat"}' }); s.llm.put('reply', { text: 'ABCDE' });
  const result = await s.pipeline.run(s.replyId);
  assert.equal(result.state, 'failed'); assert.equal(result.cancellationCode, 'reply:outgoing-validation-failed');
  assert.ok(result.stageErrors?.includes('reply:outgoing-validation-failed')); assert.equal(s.transport.sent.length, 0);
  assert.equal(Object.keys(s.f.repository.read().segments).length, 0);
  assert.equal(Object.values(s.f.repository.read().tasks).filter(task => task.kind === 'experience').length, 0);
});

test('expired queued job cannot invoke a model, while same-job callers share one execution and never replay', async () => {
  const expired = await fixture(); expired.f.advance(120_001);
  assert.equal((await expired.pipeline.run(expired.replyId)).state, 'cancelled'); assert.equal(expired.llm.calls.length, 0);
  const s = await fixture(); s.llm.put('router', { text: '{"mode":"chat"}' }); s.llm.put('reply', { text: 'once' });
  const results = await Promise.all([s.pipeline.run(s.replyId), s.pipeline.run(s.replyId)]);
  assert.ok(results.every(result => result.state === 'completed')); assert.equal(s.transport.sent.length, 1);
  await s.pipeline.run(s.replyId); assert.equal(s.llm.calls.length, 2); assert.equal(s.transport.sent.length, 1);
});

test('retrieval authorization/read ambiguity is fatal, not a quality fallback with stale evidence', async () => {
  const s = await fixture(true); s.llm.put('router', { text: '{"mode":"recall"}' }); s.llm.put('recall', plan);
  const pipeline = new OnlinePipeline(s.f.repository, s.policy, { retrieve: async () => { throw new RecallError('recall-authorization-or-read-failed'); } },
    new StageCaller(s.llm), s.outbox, { signal: s.abort.signal, now: () => s.f.now });
  const result = await pipeline.run(s.replyId);
  assert.equal(result.state, 'cancelled'); assert.deepEqual(s.models(), ['router', 'recall']); assert.equal(s.transport.sent.length, 0);
});
