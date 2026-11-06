import test from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { OneBotClientOptions, ReadyIdentity, SendOutcome } from '../src/onebot/client.js';
import { RuntimeSession } from '../src/runtime/session.js';
import { ProviderQuota } from '../src/runtime/quota.js';
import { parseConfig } from '../src/config.js';
import type { CurrentConfiguration } from '../src/runtime/configuration.js';
import type { RuntimeTransport } from '../src/runtime/session.js';
import type { ControlState } from '../src/storage/model.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge } from './helpers/knowledge.js';

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
class Scheduler {
  private index = 0;
  fail = false;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  constructor(private readonly f: Fixture) {}
  schedule = (callback: () => void, ms: number) => {
    if (this.fail) throw new Error('untrusted timer exception details');
    const id = ++this.index; this.pending.set(id, { at: this.f.now + ms, callback });
    return () => { this.pending.delete(id); };
  };
  async tick(): Promise<void> {
    this.f.advance(250);
    for (const [id, entry] of [...this.pending]) if (entry.at <= this.f.now) { this.pending.delete(id); entry.callback(); }
    // Deterministic bounded microtask drain, not real time, sockets, sleeps or a background job poll.
    for (let i = 0; i < 400; i++) await Promise.resolve();
  }
}
class Transport implements RuntimeTransport {
  started = 0; disposed = 0;
  readonly sent: string[] = [];
  private sequence = 0;
  onSubmit: (() => void) | undefined;
  constructor(readonly options: OneBotClientOptions, private readonly f: Fixture) {}
  get identity(): ReadyIdentity | undefined { return this.started && !this.disposed ? { selfId: '100', connectionEpoch: 'epoch-1' } : undefined; }
  start(): void { this.started++; }
  dispose(): void { this.disposed++; }
  getStatus(): ReturnType<RuntimeTransport['getStatus']> {
    return { state: this.disposed ? 'stopped' : this.started ? 'ready' : 'disabled', reconnectAttempt: 0,
      pending: 0, lateOutcomes: 0, droppedFrames: 0, ...(this.identity ? { identity: this.identity } : {}) };
  }
  async getGroupMemberInfo(groupId: string, userId: string) {
    return { selfId: '100', connectionEpoch: 'epoch-1', groupId, userId, checkedAt: this.f.now };
  }
  prepareTextSend(_type: 'private' | 'group', _id: string, text: string) {
    const echo = `session-echo-${++this.sequence}`;
    return { echo, connectionEpoch: 'epoch-1', submit: (): Promise<SendOutcome> => {
      const intent = Object.values(this.f.control.get().segments).find(segment => segment.echo === echo);
      assert.equal(intent?.state, 'sending');
      this.sent.push(text); this.onSubmit?.();
      return Promise.resolve({ state: 'succeeded', messageId: `delivered-${this.sent.length}` });
    } };
  }
  async event(message: string, messageId = 'new-message'): Promise<void> {
    const identity = this.identity; assert.ok(identity);
    await this.options.onEvent?.({ post_type: 'message', self_id: '100', message_type: 'group', group_id: '300',
      user_id: '200', message_id: messageId, time: Math.floor(this.f.now / 1000), message: [{ type: 'text', data: { text: message } }] }, identity);
  }
}
class Knowledge extends InMemoryKnowledge { closed = 0; close() { this.closed++; } }
async function fixture(input: Record<string, unknown> = {}, inlineWatch = false, providerQuota?: ProviderQuota) {
  const f = await runtimeFixture(input);
  let current = f.current; let scopeLive = true;
  const scheduler = new Scheduler(f); const external = new AbortController(); const knowledge = new Knowledge();
  let transport: Transport | undefined; let notify: (() => void) | undefined; let unwatch = 0;
  let llmClosed = 0; const calls: string[] = []; let output = 'hello';
  let onModel: ((model: string) => void | Promise<void>) | undefined;
  const llm: Pick<LlmRuntime, 'prepareCall'> & { close(): void } = {
    close() { llmClosed++; },
    prepareCall: async config => ({ config, context: { contextWindow: 1_000_000 }, adapterDefaults: {},
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      stream: async function* (): AsyncIterable<StreamChunk> {
        calls.push(config.model); await onModel?.(config.model);
        const text = config.model === 'router' ? '{"mode":"chat"}' : config.model === 'retain' ? '{"facts":[]}' : output;
        yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  };
  const session = new RuntimeSession(f.repository, llm, knowledge, { readConfiguration: () => current, isScopeLive: () => scopeLive, ...(providerQuota ? { providerQuota } : {}),
    watchConfiguration: callback => { notify = callback; if (inlineWatch) callback(); return () => { unwatch++; }; }, signal: external.signal,
    resolveRoutes: async (config, persona, signal) => {
      const { inheritRoute } = await import('../src/llm/routes.js'); signal.throwIfAborted();
      const { STAGES } = await import('../src/config.js');
      return Object.fromEntries(STAGES.map(stage => [stage, inheritRoute(persona.models[stage], config.models[stage], { provider: 'mock', model: stage }, stage)])) as import('../src/llm/routes.js').FiveRoutes;
    },
    availableDiskBytes: async () => 1_000_000_000_000, now: () => f.now, schedule: scheduler.schedule,
    createTransport: options => { transport = new Transport(options, f); return transport; },
  });
  assert.ok(transport);
  return { f, session, transport, scheduler, external, knowledge, calls,
    setCurrent(value: CurrentConfiguration) { current = value; },
    replaceSilently() { current = { config: structuredClone(current.config), revision: current.revision }; },
    invalidateScope() { scopeLive = false; },
    setOutput(value: string) { output = value; }, setModelHook(value: typeof onModel) { onModel = value; },
    notify() { assert.ok(notify); notify(); },
    get unwatch() { return unwatch; }, get llmClosed() { return llmClosed; } };
}

test('composition is inert, disabled start has no connection/model/knowledge/worker timer', async () => {
  const s = await fixture({ onebot: { enabled: false, expectedSelfId: '100' } });
  assert.equal(s.transport.started, 0); assert.equal(s.scheduler.pending.size, 0); assert.equal(s.knowledge.calls.length, 0);
  await s.session.start();
  assert.equal(s.session.getStatus().phase, 'disabled'); assert.equal(s.transport.started, 0); assert.deepEqual(s.calls, []);
  assert.equal(s.scheduler.pending.size, 0); await s.session.stop();
});

test('owned session connects only on start, normalizes/commits ingress then runs online and confirmed experience', async () => {
  const s = await fixture(); await s.session.start(); assert.equal(s.transport.started, 1);
  await s.transport.event('小忆 hello');
  assert.equal(Object.keys(s.f.control.get().messages).length, 1);
  assert.deepEqual(s.calls, []); assert.equal(s.transport.sent.length, 0);
  await s.scheduler.tick();
  assert.deepEqual(s.calls, ['router', 'reply']); assert.deepEqual(s.transport.sent, ['hello']);
  assert.equal(Object.values(s.f.control.get().tasks).filter(task => task.kind === 'experience').length, 1);
  await s.session.stop();
  assert.equal(s.scheduler.pending.size, 0); assert.equal(s.transport.disposed, 1); assert.equal(s.unwatch, 1);
  assert.equal(s.knowledge.closed, 0); assert.equal(s.llmClosed, 0); assert.equal(s.f.repository.getHealth().state, 'ready');
});

test('observed withdrawal B is durably audited before stop even if C reallows before the first audit microtask', async () => {
  const s = await fixture(); await s.session.start(); await s.transport.event('old retained source', 'old-before-withdrawal');
  const old = Object.values(s.f.repository.read().messages)[0]!;
  const initial = s.f.current.config;
  s.setCurrent({ config: parseConfig({ ...initial, allow: { groupIds: [], privateUserIds: ['200'] } }), revision: 'observed-B' });
  s.session.getStatus(); // Pull guard observes B and publishes audit before abort/teardown.
  s.setCurrent({ config: parseConfig(initial), revision: 'newer-C' });
  await s.session.stop();
  assert.equal(s.f.repository.read().sources[old.sourceRef.sourceId]!.allowed, false);
  assert.notEqual(s.f.repository.read().messages[old.key]!.state, 'active');
  assert.ok(s.f.ledger.get().entries.some(entry => entry.target.kind === 'source' && entry.target.sourceId === old.sourceRef.sourceId));
  await s.f.changeConfiguration(initial); await s.f.admit({ message_id: 'fresh-after-reallow' });
  const fresh = Object.values(s.f.repository.read().messages).find(message => message.messageId === 'fresh-after-reallow')!;
  assert.ok(fresh.sourceRef.sourceEpoch > old.sourceRef.sourceEpoch);
  assert.notEqual(s.f.repository.read().messages[old.key]!.state, 'active');
});

test('withdrawal audit failure rejects stop, blocks reads, and never claims a successful revoke', async () => {
  const s = await fixture(); await s.session.start(); await s.transport.event('old source', 'audit-fault');
  s.f.ledger.failAtCommit = s.f.ledger.commits + 1;
  s.setCurrent({ config: parseConfig({ ...s.f.current.config, allow: { groupIds: [], privateUserIds: ['200'] } }), revision: 'failed-B' });
  s.session.getStatus(); await assert.rejects(s.session.stop(), /configuration-withdrawal-audit-failed/);
  assert.notEqual(s.f.repository.getHealth().state, 'ready'); assert.equal(s.transport.sent.length, 0);
});

test('borrowed provider quota survives stopped/replaced sessions without resetting or closing its rolling window', async () => {
  const config = parseConfig(); const quota = new ProviderQuota({ readLimits: () => config.budgets, now: () => 1000 });
  quota.reserve('online', 'registered-provider', 100, 'router');
  for (let i = 0; i < 2; i++) {
    const s = await fixture({ onebot: { enabled: false, expectedSelfId: '100' } }, false, quota);
    await s.session.start(); await s.session.stop();
    assert.equal(quota.getStatus().stopped, false);
    assert.equal(quota.getStatus().providers[0]!.requests, i + 1);
    quota.reserve('online', 'registered-provider', 100, 'router');
  }
  quota.stop(); assert.equal(quota.getStatus().stopped, true);
});

test('silent immutable replacement or public fiber invalidation blocks all next model/send effects without notification', async () => {
  for (const kind of ['snapshot', 'scope'] as const) {
    const s = await fixture(); await s.session.start();
    s.setModelHook(model => { if (model === 'router') { if (kind === 'snapshot') s.replaceSilently(); else s.invalidateScope(); } });
    await s.transport.event('小忆 hello'); await s.scheduler.tick(); await s.session.stop();
    assert.deepEqual(s.calls, ['router']); assert.equal(s.transport.sent.length, 0);
    assert.equal(Object.values(s.f.control.get().tasks).filter(task => task.kind === 'experience').length, 0);
    assert.equal(s.session.getStatus().phase, 'stopped');
  }
});

test('configuration invalidation fences an in-flight reply and requires a new session, never a hidden restart', async () => {
  const s = await fixture(); await s.session.start();
  s.setModelHook(model => { if (model === 'reply') s.notify(); });
  await s.transport.event('小忆 hello'); await s.scheduler.tick(); await s.session.stop();
  assert.equal(s.transport.sent.length, 0); assert.equal(s.session.getStatus().phase, 'stopped');
  assert.equal(s.transport.started, 1); assert.equal(s.transport.disposed, 1); assert.equal(s.unwatch, 1);
  await assert.rejects(s.session.start(), /runtime-already-started/);
});

test('abort after durable sending intent but before synchronous submission emits no network and no experience', async () => {
  const s = await fixture(); await s.session.start();
  const original = s.f.control.set.bind(s.f.control); let fired = false;
  s.f.control.set = async (value: ControlState) => {
    await original(value);
    if (!fired && Object.values(value.segments).some(segment => segment.state === 'sending')) { fired = true; s.external.abort(); }
  };
  await s.transport.event('小忆 hello'); await s.scheduler.tick(); await s.session.stop();
  assert.equal(fired, true); assert.equal(s.transport.sent.length, 0);
  assert.equal(Object.values(s.f.control.get().tasks).filter(task => task.kind === 'experience').length, 0);
  assert.equal(s.transport.disposed, 1);
});

test('abort after first submitted successful segment prevents every next segment and cannot pretend delivery was undone', async () => {
  const s = await fixture({ budgets: { sendCodePoints: 2 } }); s.setOutput('AABBCC'); await s.session.start();
  s.transport.onSubmit = () => s.external.abort();
  await s.transport.event('小忆 hello'); await s.scheduler.tick(); await s.session.stop();
  assert.deepEqual(s.transport.sent, ['AA']);
  const segments = Object.values(s.f.control.get().segments);
  assert.equal(segments.filter(segment => segment.state === 'succeeded').length, 1);
  assert.ok(segments.slice(1).every(segment => segment.state === 'cancelled'));
});

test('internal source forget acknowledges durable blocking, not premature physical purge', async () => {
  const s = await fixture(); await s.session.start(); await s.transport.event('ordinary retained-only');
  const source = Object.values(s.f.repository.read().sources)[0]!;
  const status = await s.session.forgetBySource(source.sourceId, 'admin-forget');
  assert.equal(status.logicallyBlocked, true); assert.equal(status.state, 'blocked');
  assert.equal(s.f.ledger.get().sequence, 1);
  assert.equal(Object.values(s.f.repository.read().messages)[0]!.text, undefined);
  assert.equal(s.transport.sent.length, 0); assert.equal(s.calls.length, 0); await s.session.stop();
});

test('scheduler startup failure and inline watch invalidation fully stop and clean the owned subscription', async () => {
  for (const failure of ['timer', 'inline-watch'] as const) {
    const s = await fixture({}, failure === 'inline-watch');
    if (failure === 'timer') s.scheduler.fail = true;
    await assert.rejects(s.session.start(), /runtime-startup-failed/);
    await s.session.stop();
    assert.equal(s.session.getStatus().phase, 'stopped'); assert.equal(s.unwatch, 1);
    assert.equal(s.transport.disposed, 1); assert.equal(s.scheduler.pending.size, 0);
    assert.equal(s.knowledge.closed, 0); assert.equal(s.llmClosed, 0);
  }
});

test('internal scheduler stop cancels coordinator deadline timers but retains unresolved external-write tracking', async () => {
  const s = await fixture(); let entered = false; let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  s.knowledge.beforeAdd = async () => { entered = true; await held; };
  await s.session.start(); await s.transport.event('ordinary retained-only statement'); await s.scheduler.tick();
  assert.equal(entered, true);
  assert.ok(Object.values(s.f.control.get().intents).some(intent => intent.externalWrite === 'in_flight'));
  s.scheduler.fail = true; await s.scheduler.tick(); await s.session.stop();
  assert.equal(s.session.getStatus().phase, 'stopped'); assert.equal(s.scheduler.pending.size, 0); assert.equal(s.unwatch, 1);
  assert.ok(Object.values(s.f.control.get().intents).every(intent => intent.externalWrite === 'unknown'));
  assert.deepEqual(s.calls, []); assert.equal(s.transport.sent.length, 0);
  finish();
  for (let i = 0; i < 400; i++) await Promise.resolve();
  assert.equal(Object.keys(s.f.control.get().activeMemory).length, 0);
  assert.equal(s.scheduler.pending.size, 0); assert.equal(s.knowledge.closed, 0);
});

test('startup revalidates withdrawals even if a restarted reader reused the persisted revision label', async () => {
  const f = await runtimeFixture(); await f.admit();
  const config = structuredClone(f.current.config); config.allow.groupIds = [];
  const current = { config, revision: f.current.revision }; const scheduler = new Scheduler(f);
  let calls = 0; let transport!: Transport;
  const llm: Pick<LlmRuntime, 'prepareCall'> = { prepareCall: async () => { calls++; throw new Error('withdrawn input must not dispatch'); } };
  const session = new RuntimeSession(f.repository, llm, new Knowledge(), { readConfiguration: () => current,
    watchConfiguration: () => () => {}, now: () => f.now, schedule: scheduler.schedule,
    resolveRoutes: async () => { throw new Error('no new ingress expected'); }, availableDiskBytes: async () => 1_000_000_000_000,
    createTransport: options => { transport = new Transport(options, f); return transport; } });
  await session.start(); await scheduler.tick();
  assert.equal(f.ledger.get().sequence, 1); assert.ok(Object.values(f.repository.read().sources).every(source => !source.allowed));
  assert.ok(Object.values(f.repository.read().tasks).every(task => task.state === 'cancelled')); assert.equal(calls, 0);
  assert.equal(transport.sent.length, 0); await session.stop();
});

test('status and stop never expose configured token or inbound body, and borrowed Host services stay open', async () => {
  const s = await fixture({ onebot: { enabled: true, expectedSelfId: '100', token: 'TOKEN_MUST_NOT_ESCAPE' } });
  await s.session.start(); await s.transport.event('PRIVATE_BODY_DO_NOT_LOG');
  await s.transport.event('x'.repeat(17_000), 'oversized');
  assert.equal(s.session.getStatus().rejectedEvents, 1);
  const status = JSON.stringify(s.session.getStatus());
  assert.equal(status.includes('TOKEN_MUST_NOT_ESCAPE'), false); assert.equal(status.includes('PRIVATE_BODY_DO_NOT_LOG'), false);
  assert.equal(s.transport.options.token, 'TOKEN_MUST_NOT_ESCAPE', 'credential reaches ONLY transport config');
  await Promise.all([s.session.stop(), s.session.stop()]);
  assert.equal(s.transport.disposed, 1); assert.equal(s.unwatch, 1); assert.equal(s.llmClosed, 0); assert.equal(s.knowledge.closed, 0);
});
