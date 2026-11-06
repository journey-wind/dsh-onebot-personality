import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  OneBotClient, OneBotTransportError,
  type LateSendOutcome, type OneBotClientOptions, type OneBotSocket, type ReadyIdentity,
  type SocketOptions, type TransportClock, type TransportErrorCode,
} from '../src/onebot/client.js';

/** No real timers/sleeps, sockets, Context, secrets, storage or test-time network. */
class FakeClock implements TransportClock {
  time = 0;
  sample = 1;
  sequence = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  random(): number { return this.sample; }
  setTimeout(callback: () => void, delayMs: number): () => void {
    const key = ++this.sequence;
    this.timers.set(key, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(key); };
  }
  advance(ms: number): void {
    const end = this.time + ms;
    let iterations = 0;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
      if (!next) break;
      assert.ok(++iterations < 10_000, 'bounded deterministic timer progression');
      const [key, timer] = next;
      this.timers.delete(key); this.time = timer.at; timer.callback();
    }
    this.time = end;
  }
}
type EventName = Parameters<OneBotSocket['on']>[0];
type Listener = Parameters<OneBotSocket['on']>[1];
interface WireAction { action: string; echo: string; params: Record<string, unknown> }
class MockSocket implements OneBotSocket {
  readyState = 0;
  terminated = 0;
  readonly listeners = new Map<EventName, Set<Listener>>();
  readonly sent: string[] = [];
  readonly sendCallbacks: ((error?: Error) => void)[] = [];
  readonly pings: string[] = [];
  sendHook: ((payload: string, callback: (error?: Error) => void) => void) | undefined;
  pingHook: ((nonce: string, callback: (error?: Error) => void) => void) | undefined;
  on(event: EventName, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener); return this;
  }
  off(event: EventName, listener: Listener): this { this.listeners.get(event)?.delete(listener); return this; }
  snapshot(event: EventName): Listener[] { return [...(this.listeners.get(event) ?? [])]; }
  emit(event: EventName, ...args: unknown[]): void { for (const listener of this.snapshot(event)) listener(...args); }
  open(): void { this.readyState = 1; this.emit('open'); }
  frame(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  send(payload: string, callback: (error?: Error) => void): void {
    this.sent.push(payload); this.sendCallbacks.push(callback);
    if (this.sendHook) this.sendHook(payload, callback); else callback();
  }
  ping(nonce: string, callback: (error?: Error) => void): void {
    this.pings.push(nonce);
    if (this.pingHook) this.pingHook(nonce, callback); else callback();
  }
  terminate(): void { this.terminated++; this.readyState = 3; }
  close(): void { this.readyState = 3; this.emit('close', 1006, Buffer.from('untrusted close reason')); }
  action(index = this.sent.length - 1): WireAction { return JSON.parse(this.sent[index]!) as WireAction; }
  reply(index: number, data: unknown, extra: Record<string, unknown> = {}): void {
    this.frame({ echo: this.action(index).echo, status: 'ok', retcode: 0, data, ...extra });
  }
}
function harness(overrides: Partial<OneBotClientOptions> = {}) {
  const clock = new FakeClock();
  const sockets: MockSocket[] = [];
  const connections: { url: string; options: SocketOptions }[] = [];
  const events: { event: Readonly<Record<string, unknown>>; identity: ReadyIdentity }[] = [];
  const late: LateSendOutcome[] = [];
  const client = new OneBotClient({
    enabled: true, wsUrl: 'ws://127.0.0.1:3001', expectedSelfId: '10001', token: 'fixture-only-secret',
    clock, socketFactory: (url, options) => {
      connections.push({ url, options }); const socket = new MockSocket(); sockets.push(socket); return socket;
    },
    connectTimeoutMs: 100, actionTimeoutMs: 50, heartbeatTimeoutMs: 1000,
    reconnectInitialMs: 10, reconnectMaxMs: 80, stableConnectionMs: 100,
    onEvent: (event, identity) => { events.push({ event, identity }); },
    onLateSendOutcome: outcome => { late.push(outcome); }, ...overrides,
  });
  return { client, clock, sockets, connections, events, late };
}
type Harness = ReturnType<typeof harness>;
function ready(h: Harness): MockSocket {
  h.client.start();
  const socket = h.sockets.at(-1)!;
  assert.equal(h.client.getStatus().state, 'connecting');
  socket.open();
  assert.equal(h.client.getStatus().state, 'authenticating');
  assert.equal(socket.action().action, 'get_login_info');
  assert.deepEqual(socket.action().params, {});
  socket.reply(0, { user_id: 10001, nickname: 'untrusted ignored field' });
  assert.equal(h.client.getStatus().state, 'ready');
  assert.equal(h.client.identity?.selfId, '10001');
  return socket;
}
function code(expected: TransportErrorCode): (error: unknown) => boolean {
  return error => error instanceof OneBotTransportError && error.code === expected && error.message === expected;
}
const event = (selfId: unknown = 10001) => ({
  post_type: 'message', self_id: selfId, message_type: 'private', user_id: 20002,
  message_id: 7, time: 1, message: 'ordinary untrusted message',
});

test('disabled is inert; start is idempotent; disposal is terminal', () => {
  const h = harness({ enabled: false, expectedSelfId: '' });
  assert.equal(h.client.getStatus().state, 'disabled');
  h.client.start(); h.client.start();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.client.identity, undefined);
  h.client.dispose(); h.client.dispose(); h.client.start(); h.clock.advance(100_000);
  assert.equal(h.client.getStatus().state, 'stopped');
  assert.equal(h.sockets.length, 0);
  assert.equal(h.clock.timers.size, 0);
});

test('forward WS sends Bearer header only, uses bounded verified TLS options, and authenticates before events', () => {
  const h = harness();
  h.client.start(); h.client.start();
  assert.equal(h.sockets.length, 1);
  const connection = h.connections[0]!;
  assert.equal(connection.url, 'ws://127.0.0.1:3001/');
  assert.equal(connection.options.headers.Authorization, 'Bearer fixture-only-secret');
  assert.equal(connection.options.maxPayload, 256 * 1024);
  assert.equal(connection.options.rejectUnauthorized, true);
  assert.equal(connection.options.followRedirects, false);
  assert.equal(connection.options.perMessageDeflate, false);
  assert.ok(!connection.url.includes('fixture-only-secret'));
  const socket = h.sockets[0]!;
  socket.frame(event()); assert.equal(h.events.length, 0);
  socket.open(); socket.frame(event()); assert.equal(h.events.length, 0);
  socket.reply(0, { user_id: '10001' });
  socket.frame(event('010001'));
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.identity, h.client.identity);
  assert.ok(Object.isFrozen(h.client.identity));
  const metadata = JSON.stringify(h.client.getStatus());
  assert.ok(!metadata.includes('fixture-only-secret'));
  assert.ok(!metadata.includes('ordinary untrusted'));
  assert.ok(!socket.sent.join('').includes('fixture-only-secret'));
  h.client.dispose();
});

test('options reject credential URLs, remote plaintext, bad headers, unsafe identities and invalid limits', () => {
  for (const wsUrl of [
    'https://localhost/', 'ws://user:password@localhost/', 'ws://localhost/?access_token=secret',
    'ws://localhost/#token', 'ws://example.invalid/',
  ]) assert.throws(() => harness({ wsUrl }), code('INVALID_OPTIONS'));
  assert.throws(() => harness({ token: 'x\r\nInjected: bad' }), code('INVALID_OPTIONS'));
  assert.throws(() => harness({ expectedSelfId: '-1' }), code('INVALID_ID'));
  assert.throws(() => harness({ expectedSelfId: '1'.repeat(33) }), code('INVALID_ID'));
  assert.throws(() => harness({ maxActionBytes: 127 }), code('INVALID_OPTIONS'));
  assert.throws(() => harness({ maxPayloadBytes: 1024 * 1024 + 1 }), code('INVALID_OPTIONS'));
  assert.throws(() => harness({ reconnectInitialMs: 81 }), code('INVALID_OPTIONS'));
  assert.throws(() => harness({ actionTimeoutMs: Number.NaN }), code('INVALID_OPTIONS'));
  const h = harness({ wsUrl: 'ws://example.invalid', allowInsecureRemoteWs: true, token: '' });
  h.client.start(); assert.deepEqual(h.connections[0]!.options.headers, {}); h.client.dispose();
});

test('login identity mismatch blocks without reconnect and event identity mismatch revokes readiness', () => {
  for (const user_id of ['10002', Number.MAX_SAFE_INTEGER + 1, undefined]) {
    const h = harness(); h.client.start(); const socket = h.sockets[0]!; socket.open();
    socket.reply(0, { user_id });
    assert.equal(h.client.getStatus().state, 'blocked');
    assert.equal(h.client.getStatus().lastError, 'IDENTITY_MISMATCH');
    assert.equal(h.client.identity, undefined);
    h.clock.advance(10_000); assert.equal(h.sockets.length, 1); assert.equal(socket.terminated, 1);
    h.client.start(); assert.equal(h.sockets.length, 1); h.client.dispose();
  }
  const h = harness(); const socket = ready(h);
  socket.frame(event(10002));
  assert.equal(h.events.length, 0); assert.equal(h.client.getStatus().state, 'blocked');
  assert.equal(h.client.identity, undefined); h.client.dispose();
});

test('event identity change blocks and settles in-flight sends as unknown without delivery claims', async () => {
  const h = harness(); const socket = ready(h);
  const send = h.client.prepareTextSend('group', '30003', 'in flight').submit();
  const member = assert.rejects(h.client.getGroupMemberInfo('30003', '20002'), code('IDENTITY_MISMATCH'));
  socket.frame(event('10002')); await member;
  assert.deepEqual(await send, { state: 'unknown', code: 'IDENTITY_MISMATCH' });
  assert.equal(h.client.identity, undefined); assert.equal(h.client.getStatus().state, 'blocked');
  assert.equal(h.client.getStatus().pending, 0); assert.equal(h.client.getStatus().lateOutcomes, 0);
  h.clock.advance(100_000); assert.equal(h.sockets.length, 1); assert.equal(socket.sent.length, 3);
  h.client.dispose();
});

test('login refusal blocks while malformed login and authentication timeout reconnect safely', () => {
  const refused = harness(); refused.client.start(); const a = refused.sockets[0]!; a.open();
  a.reply(0, {}, { status: 'failed', retcode: 1401, wording: 'fixture-only-secret sensitive error' });
  assert.equal(refused.client.getStatus().state, 'blocked');
  assert.equal(refused.client.getStatus().lastError, 'AUTH_FAILED');
  assert.ok(!JSON.stringify(refused.client.getStatus()).includes('sensitive')); refused.client.dispose();
  const malformed = harness(); malformed.client.start(); const b = malformed.sockets[0]!; b.open();
  b.reply(0, { user_id: 10001 }, { status: 'async' });
  assert.equal(malformed.client.getStatus().state, 'reconnecting');
  assert.equal(malformed.client.getStatus().lastError, 'MALFORMED_RESPONSE'); malformed.client.dispose();
  const timeout = harness(); timeout.client.start(); timeout.sockets[0]!.open(); timeout.clock.advance(50);
  assert.equal(timeout.client.getStatus().lastError, 'TIMEOUT');
  assert.equal(timeout.client.identity, undefined); timeout.client.dispose();
});

test('member observation is fixed uncached action and returns verified metadata only', async () => {
  const h = harness(); const socket = ready(h);
  const promise = h.client.getGroupMemberInfo('030003', '20002');
  assert.deepEqual(socket.action().params, { group_id: '30003', user_id: '20002', no_cache: true });
  assert.equal(socket.action().action, 'get_group_member_info');
  socket.reply(1, { group_id: 30003, user_id: '20002', card: 'not returned', nickname: 'not returned' });
  assert.deepEqual(await promise, { ...h.client.identity, groupId: '30003', userId: '20002', checkedAt: 0 });
  assert.ok(Object.isFrozen(await promise)); h.client.dispose();
});

test('member wrong group/user, absent data, retcode and action mismatch fail closed with fixed codes', async () => {
  const cases: { data: unknown; extra?: Record<string, unknown>; expected: TransportErrorCode }[] = [
    { data: { group_id: 30004, user_id: 20002 }, expected: 'MEMBER_MISMATCH' },
    { data: { group_id: 30003, user_id: 20003 }, expected: 'MEMBER_MISMATCH' },
    { data: { group_id: 30003 }, expected: 'MEMBER_MISMATCH' },
    { data: null, expected: 'MALFORMED_RESPONSE' },
    { data: {}, extra: { status: 'failed', retcode: 100, message: 'raw secret failure' }, expected: 'ACTION_REJECTED' },
    { data: { group_id: 30003, user_id: 20002 }, extra: { action: 'send_group_msg' }, expected: 'ACTION_MISMATCH' },
  ];
  for (const c of cases) {
    const h = harness(); const socket = ready(h);
    const promise = h.client.getGroupMemberInfo('30003', '20002');
    const rejected = assert.rejects(promise, code(c.expected));
    socket.reply(1, c.data, c.extra); await rejected; h.client.dispose();
  }
});

test('member timeout, disconnect, invalid identity and stopped state reject without raw errors', async () => {
  const h = harness(); const socket = ready(h);
  await assert.rejects(h.client.getGroupMemberInfo('bad', '20002'), code('INVALID_ID'));
  assert.equal(socket.sent.length, 1);
  const timed = assert.rejects(h.client.getGroupMemberInfo('30003', '20002'), code('TIMEOUT'));
  h.clock.advance(50); await timed;
  const disconnected = assert.rejects(h.client.getGroupMemberInfo('30003', '20002'), code('DISCONNECTED'));
  socket.close(); await disconnected;
  await assert.rejects(h.client.getGroupMemberInfo('30003', '20002'), code('NOT_READY'));
  h.client.dispose(); await assert.rejects(h.client.getGroupMemberInfo('30003', '20002'), code('NOT_READY'));
});

test('prepared text sends reserve epoch/unique echo and do not submit until barrier invocation', async () => {
  const h = harness(); const socket = ready(h);
  const text = '[CQ:at,qq=all][CQ:image,file=https://evil.invalid/] & < > " \\ \n😀';
  const group = h.client.prepareTextSend('group', '30003', text);
  const privateSend = h.client.prepareTextSend('private', '20002', 'private text');
  assert.notEqual(group.echo, privateSend.echo);
  assert.ok(group.echo.startsWith(`${h.client.identity!.connectionEpoch}:`));
  assert.equal(group.connectionEpoch, h.client.identity!.connectionEpoch);
  assert.ok(Object.isFrozen(group));
  assert.equal(socket.sent.length, 1); assert.equal(h.client.getStatus().pending, 0);
  const promise = group.submit();
  // This assertion is deliberately before any await: mandatory network entry under shared barrier.
  assert.equal(socket.sent.length, 2);
  assert.equal(group.submit(), promise); assert.equal(socket.sent.length, 2);
  assert.deepEqual(socket.action().params, { group_id: '30003', message: [{ type: 'text', data: { text } }] });
  assert.equal(socket.action().action, 'send_group_msg'); assert.equal(socket.action().echo, group.echo);
  socket.reply(1, { message_id: -900 });
  assert.deepEqual(await promise, { state: 'succeeded', messageId: '-900' });
  const privatePromise = privateSend.submit();
  assert.equal(socket.action().action, 'send_private_msg');
  assert.deepEqual(socket.action().params, { user_id: '20002', message: [{ type: 'text', data: { text: 'private text' } }] });
  socket.reply(2, { message_id: 'opaque:message-2' });
  assert.deepEqual(await privatePromise, { state: 'succeeded', messageId: 'opaque:message-2' }); h.client.dispose();
});

test('prepare rejects invalid Unicode/empty text/target, and counts the entire escaped action envelope', () => {
  const h = harness({ maxActionBytes: 256 }); const socket = ready(h);
  for (const text of ['', '   ', '\ud800']) assert.throws(() => h.client.prepareTextSend('group', '30003', text), code('INVALID_TEXT'));
  assert.throws(() => h.client.prepareTextSend('private', '0', 'hello'), code('INVALID_ID'));
  // Raw text fits 256 bytes, but escaped text plus fixed action/echo envelope does not.
  assert.throws(() => h.client.prepareTextSend('group', '30003', '"'.repeat(80)), code('ACTION_TOO_LARGE'));
  assert.throws(() => h.client.prepareTextSend('group', '30003', '😀'.repeat(80)), code('ACTION_TOO_LARGE'));
  assert.equal(socket.sent.length, 1); assert.equal(h.client.getStatus().pending, 0); h.client.dispose();
});

test('only explicit status/retcode success with valid message_id confirms a send', async () => {
  const cases: { data: unknown; extra?: Record<string, unknown>; state: string; error?: string }[] = [
    { data: { message_id: '1' }, state: 'succeeded' },
    { data: {}, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: null }, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: Number.MAX_SAFE_INTEGER + 1 }, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: 'unsafe\nsecret' }, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: null, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: 1 }, extra: { status: 'failed', retcode: 100 }, state: 'failed', error: 'ACTION_REJECTED' },
    { data: { message_id: 1 }, extra: { status: 'ok', retcode: 100 }, state: 'failed', error: 'ACTION_REJECTED' },
    { data: { message_id: 1 }, extra: { status: 'failed', retcode: 0 }, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: 1 }, extra: { status: 'ok', retcode: '0' }, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: 1 }, extra: { status: 'async', retcode: 0 }, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: 1 }, extra: { status: undefined }, state: 'unknown', error: 'MALFORMED_RESPONSE' },
    { data: { message_id: 1 }, extra: { action: 'send_group_msg' }, state: 'unknown', error: 'ACTION_MISMATCH' },
  ];
  for (const c of cases) {
    const h = harness(); const socket = ready(h);
    const promise = h.client.prepareTextSend('private', '20002', 'body must not appear in outcomes').submit();
    socket.reply(1, c.data, { wording: 'raw gateway secret', ...c.extra });
    const outcome = await promise;
    assert.equal(outcome.state, c.state); assert.equal(outcome.code, c.error);
    assert.ok(!JSON.stringify(outcome).includes('secret')); assert.ok(!JSON.stringify(outcome).includes('body'));
    h.client.dispose();
  }
});

test('echo matching is strict, independent concurrent replies settle only their own request', async () => {
  const h = harness(); const socket = ready(h);
  const a = h.client.prepareTextSend('private', '20002', 'a');
  const b = h.client.prepareTextSend('private', '20003', 'b');
  const first = a.submit(); const second = b.submit();
  socket.frame({ echo: { value: a.echo }, status: 'ok', retcode: 0, data: { message_id: 99 } });
  socket.frame({ echo: `${a.echo}-wrong`, status: 'ok', retcode: 0, data: { message_id: 99 } });
  assert.equal(h.client.getStatus().pending, 2);
  socket.reply(2, { message_id: 22 }); assert.equal(h.client.getStatus().pending, 1);
  socket.reply(1, { message_id: 11 });
  assert.deepEqual(await first, { state: 'succeeded', messageId: '11' });
  assert.deepEqual(await second, { state: 'succeeded', messageId: '22' });
  assert.equal(h.client.getStatus().pending, 0); h.client.dispose();
});

test('timeout yields unknown once; reliable late replies emit metadata without re-sending', async () => {
  const h = harness(); const socket = ready(h);
  const prepared = h.client.prepareTextSend('group', '30003', 'VERY_PRIVATE_BODY');
  const promise = prepared.submit(); h.clock.advance(50);
  assert.deepEqual(await promise, { state: 'unknown', code: 'TIMEOUT' });
  assert.equal(h.client.getStatus().lateOutcomes, 1);
  // Wrong action is not a reliable late confirmation, even when status/echo/message_id match.
  socket.reply(1, { message_id: 44 }, { action: 'send_private_msg' });
  assert.equal(h.late.length, 0);
  socket.reply(1, { message_id: 44 }, { action: 'send_group_msg', wording: 'do not expose' });
  assert.deepEqual(h.late, [{ echo: prepared.echo, connectionEpoch: prepared.connectionEpoch,
    outcome: { state: 'succeeded', messageId: '44' } }]);
  assert.ok(!JSON.stringify(h.late).includes('VERY_PRIVATE_BODY'));
  assert.ok(!JSON.stringify(h.late).includes('do not expose'));
  socket.reply(1, { message_id: 44 }); assert.equal(h.late.length, 1);
  assert.deepEqual(await promise, { state: 'unknown', code: 'TIMEOUT' });
  assert.equal(prepared.submit(), promise); assert.equal(socket.sent.length, 2); h.client.dispose();
});

test('malformed send can be resolved by a later explicit refusal without text or raw errors', async () => {
  const h = harness(); const socket = ready(h);
  const promise = h.client.prepareTextSend('private', '20002', 'body').submit();
  socket.reply(1, {}, { status: 'async' });
  assert.deepEqual(await promise, { state: 'unknown', code: 'MALFORMED_RESPONSE' });
  socket.reply(1, {}, { status: 'failed', retcode: 500, message: 'secret' });
  assert.deepEqual(h.late[0]!.outcome, { state: 'failed', code: 'ACTION_REJECTED' });
  h.client.dispose();
});

test('late tracking is count/TTL bounded, expires without traffic, and can be disabled', async () => {
  const h = harness({ maxLateOutcomes: 1, lateOutcomeTtlMs: 20 }); const socket = ready(h);
  const a = h.client.prepareTextSend('private', '20002', 'first');
  const b = h.client.prepareTextSend('private', '20002', 'second');
  const p = a.submit(); const q = b.submit(); h.clock.advance(50); await p; await q;
  assert.equal(h.client.getStatus().lateOutcomes, 1);
  socket.reply(1, { message_id: 1 }); assert.equal(h.late.length, 0);
  h.clock.advance(20); assert.equal(h.client.getStatus().lateOutcomes, 0);
  socket.reply(2, { message_id: 2 }); assert.equal(h.late.length, 0); h.client.dispose();
  const disabled = harness({ maxLateOutcomes: 0 }); const s = ready(disabled);
  const r = disabled.client.prepareTextSend('private', '20002', 'body').submit(); disabled.clock.advance(50); await r;
  s.reply(1, { message_id: 1 }); assert.equal(disabled.late.length, 0);
  assert.equal(disabled.client.getStatus().lateOutcomes, 0); disabled.client.dispose();
});

test('send callback error and throw after socket entry are unknown, never falsely unsent or retried', async () => {
  for (const mode of ['callback', 'throw']) {
    const h = harness(); const socket = ready(h);
    socket.sendHook = (_payload, callback) => {
      if (mode === 'callback') callback(new Error('sensitive raw transport error'));
      else throw new Error('sensitive raw transport error');
    };
    const prepared = h.client.prepareTextSend('private', '20002', 'body');
    const promise = prepared.submit();
    assert.deepEqual(await promise, { state: 'unknown', code: 'SEND_ERROR' });
    assert.equal(prepared.submit(), promise); assert.equal(socket.sent.length, 2);
    socket.reply(1, { message_id: 10 }); assert.equal(h.late[0]!.outcome.state, 'succeeded');
    assert.ok(!JSON.stringify(h.client.getStatus()).includes('sensitive')); h.client.dispose();
  }
});

test('synchronous send reply is correlated and reentrant submit remains single-use', async () => {
  const h = harness(); const socket = ready(h);
  const prepared = h.client.prepareTextSend('private', '20002', 'body');
  let reentrant: Promise<unknown> | undefined;
  socket.sendHook = (_payload, callback) => {
    reentrant = prepared.submit(); socket.reply(1, { message_id: 10 }); callback();
  };
  const promise = prepared.submit();
  assert.equal(reentrant, promise); assert.equal(socket.sent.length, 2);
  assert.deepEqual(await promise, { state: 'succeeded', messageId: '10' }); h.client.dispose();
});

test('pending cap fails before network; handle is single-use even after capacity recovers', async () => {
  const h = harness({ maxPending: 1 }); const socket = ready(h);
  const inFlight = h.client.getGroupMemberInfo('30003', '20002');
  const prepared = h.client.prepareTextSend('private', '20002', 'body');
  const refused = prepared.submit();
  assert.deepEqual(await refused, { state: 'failed', code: 'TOO_MANY_PENDING' });
  assert.equal(socket.sent.length, 2);
  await assert.rejects(h.client.getGroupMemberInfo('30004', '20002'), code('TOO_MANY_PENDING'));
  socket.reply(1, { group_id: 30003, user_id: 20002 }); await inFlight;
  assert.equal(prepared.submit(), refused); assert.equal(socket.sent.length, 2); h.client.dispose();
});

test('disconnect invalidates epoch, rejects member read, settles submitted unknown and never replays', async () => {
  const h = harness(); const socket = ready(h);
  const oldIdentity = h.client.identity!;
  const oldCallbacks = socket.snapshot('message');
  const unsubmitted = h.client.prepareTextSend('private', '20002', 'never submitted');
  const submitted = h.client.prepareTextSend('group', '30003', 'once only');
  const send = submitted.submit();
  const member = assert.rejects(h.client.getGroupMemberInfo('30003', '20002'), code('DISCONNECTED'));
  socket.close(); await member;
  assert.deepEqual(await send, { state: 'unknown', code: 'DISCONNECTED' });
  assert.equal(h.client.identity, undefined); assert.equal(h.client.getStatus().pending, 0);
  h.clock.advance(10); const next = h.sockets[1]!; next.open(); next.reply(0, { user_id: 10001 });
  assert.equal(next.sent.length, 1); assert.equal(h.client.getStatus().state, 'ready');
  assert.notEqual(h.client.identity!.connectionEpoch, oldIdentity.connectionEpoch);
  assert.deepEqual(await unsubmitted.submit(), { state: 'failed', code: 'STALE_CONNECTION' });
  assert.equal(submitted.submit(), send); assert.equal(next.sent.length, 1);
  const newPrepared = h.client.prepareTextSend('group', '30003', 'new request');
  const newSend = newPrepared.submit();
  assert.notEqual(newPrepared.echo, submitted.echo);
  // A retired socket cannot complete anything, even when given a forged new epoch/echo.
  for (const callback of oldCallbacks) callback(Buffer.from(JSON.stringify({ echo: newPrepared.echo,
    status: 'ok', retcode: 0, data: { message_id: 999 } })), false);
  next.frame({ echo: submitted.echo, status: 'ok', retcode: 0, data: { message_id: 999 } });
  assert.equal(h.client.getStatus().pending, 1); assert.equal(h.late.length, 0);
  next.reply(1, { message_id: 20 }); assert.deepEqual(await newSend, { state: 'succeeded', messageId: '20' });
  h.client.dispose();
});

test('disposal cancels all timers, member promises, submitted sends, listeners and unsubmitted handles', async () => {
  const h = harness(); const socket = ready(h);
  const prepared = h.client.prepareTextSend('private', '20002', 'do not submit');
  const send = h.client.prepareTextSend('private', '20002', 'already submitted').submit();
  const member = assert.rejects(h.client.getGroupMemberInfo('30003', '20002'), code('STOPPED'));
  h.client.dispose(); await member;
  assert.deepEqual(await send, { state: 'unknown', code: 'STOPPED' });
  assert.deepEqual(await prepared.submit(), { state: 'failed', code: 'STALE_CONNECTION' });
  assert.equal(h.client.getStatus().state, 'stopped'); assert.equal(h.client.identity, undefined);
  assert.equal(h.clock.timers.size, 0); assert.equal(socket.snapshot('message').length, 0);
  assert.equal(socket.snapshot('open').length, 0); assert.equal(socket.snapshot('pong').length, 0);
  assert.equal(socket.snapshot('error').length, 1); // noncapturing safety sink only
  h.clock.advance(100_000); assert.equal(h.sockets.length, 1);
  socket.reply(1, { message_id: 1 }); assert.equal(h.late.length, 0);
  assert.throws(() => h.client.prepareTextSend('private', '20002', 'stopped'), code('NOT_READY'));
});

test('connection timeout and exponential capped jitter backoff reset only after stable ready duration', () => {
  const h = harness(); h.client.start(); h.clock.advance(100);
  assert.equal(h.client.getStatus().lastError, 'CONNECT_TIMEOUT');
  assert.equal(h.client.getStatus().reconnectAttempt, 1);
  h.clock.advance(9); assert.equal(h.sockets.length, 1);
  h.clock.advance(1); assert.equal(h.sockets.length, 2);
  h.sockets[1]!.close(); h.clock.advance(19); assert.equal(h.sockets.length, 2);
  h.clock.advance(1); const third = h.sockets[2]!; third.open(); third.reply(0, { user_id: 10001 });
  h.clock.advance(99); assert.equal(h.client.getStatus().reconnectAttempt, 2);
  h.clock.advance(1); assert.equal(h.client.getStatus().reconnectAttempt, 0);
  third.close(); h.clock.advance(10); assert.equal(h.sockets.length, 4); h.client.dispose();
  const jittered = harness(); jittered.clock.sample = 0; jittered.client.start(); jittered.sockets[0]!.close();
  jittered.clock.advance(4); assert.equal(jittered.sockets.length, 1);
  jittered.clock.advance(1); assert.equal(jittered.sockets.length, 2); jittered.client.dispose();
  const capped = harness({ reconnectInitialMs: 10, reconnectMaxMs: 10 }); capped.client.start();
  for (let i = 0; i < 6; i++) { capped.sockets[i]!.close(); capped.clock.advance(10); }
  assert.equal(capped.sockets.length, 7); capped.client.dispose();
});

test('heartbeat requires matching pong or verified gateway heartbeat, not arbitrary activity', () => {
  const dead = harness({ heartbeatTimeoutMs: 100 }); const a = ready(dead);
  dead.clock.advance(50); assert.equal(a.pings.length, 1);
  a.emit('pong', Buffer.from('not-the-nonce'));
  a.frame(event()); dead.clock.advance(50);
  assert.equal(dead.client.getStatus().lastError, 'HEARTBEAT_TIMEOUT');
  assert.equal(dead.client.identity, undefined); dead.client.dispose();
  const live = harness({ heartbeatTimeoutMs: 100 }); const b = ready(live);
  live.clock.advance(50); b.emit('pong', Buffer.from(b.pings[0]!));
  live.clock.advance(50); assert.equal(live.client.getStatus().state, 'ready');
  b.frame({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 10001 });
  live.clock.advance(50); assert.equal(live.client.getStatus().state, 'ready');
  b.emit('pong', Buffer.from(b.pings.at(-1)!)); live.clock.advance(50);
  assert.equal(live.client.getStatus().state, 'ready'); live.client.dispose();
});

test('heartbeat socket errors reconnect and cannot leak raw exception content', () => {
  const h = harness({ heartbeatTimeoutMs: 100 }); const socket = ready(h);
  socket.pingHook = () => { throw new Error('Bearer secret sensitive ping error'); };
  h.clock.advance(50); assert.equal(h.client.getStatus().lastError, 'SOCKET_ERROR');
  assert.ok(!JSON.stringify(h.client.getStatus()).includes('secret')); h.client.dispose();
});

test('bounded incoming frames reject oversized bodies before callbacks and reconnect safely', () => {
  const h = harness({ maxPayloadBytes: 256 }); const socket = ready(h);
  socket.emit('message', Buffer.alloc(257), false);
  assert.equal(h.events.length, 0); assert.equal(h.client.getStatus().state, 'reconnecting');
  assert.equal(h.client.getStatus().lastError, 'PAYLOAD_TOO_LARGE');
  assert.equal(h.client.getStatus().droppedFrames, 1); h.client.dispose();
  for (const payload of ['x'.repeat(257), [Buffer.alloc(150), Buffer.alloc(150)], new ArrayBuffer(257)]) {
    const next = harness({ maxPayloadBytes: 256 }); const s = ready(next); s.emit('message', payload, false);
    assert.equal(next.client.getStatus().lastError, 'PAYLOAD_TOO_LARGE'); next.client.dispose();
  }
});

test('invalid JSON, binary, invalid UTF-8, primitive JSON and invalid buffer data never enter callbacks', () => {
  const h = harness(); const socket = ready(h);
  socket.emit('message', '{ secret invalid JSON', false);
  socket.emit('message', Buffer.from(JSON.stringify(event())), true);
  socket.emit('message', Buffer.from([0xff]), false);
  socket.emit('message', '[]', false);
  socket.emit('message', 'null', false);
  socket.emit('message', 42, false);
  socket.emit('message', [Buffer.from('{}'), 'bad'], false);
  assert.equal(h.events.length, 0); assert.equal(h.client.getStatus().droppedFrames, 7);
  assert.equal(h.client.getStatus().state, 'ready');
  assert.ok(!JSON.stringify(h.client.getStatus()).includes('secret'));
  // Valid ws fragmentation buffers and ArrayBuffer views remain accepted and bounded.
  const encoded = Buffer.from(JSON.stringify(event()));
  socket.emit('message', [encoded.subarray(0, 4), encoded.subarray(4)], false);
  socket.emit('message', new Uint8Array(encoded), false);
  socket.emit('message', new Uint8Array(encoded).buffer, false);
  assert.equal(h.events.length, 3); h.client.dispose();
});

test('callback failure is contained as fixed metadata and factory errors never expose URL/token/cause', async () => {
  const h = harness({ onEvent: () => { throw new Error('private body'); } }); const socket = ready(h);
  socket.frame(event()); assert.equal(h.client.getStatus().lastError, 'CALLBACK_FAILED');
  assert.equal(h.client.getStatus().state, 'ready'); h.client.dispose();
  const asyncFailure = harness({ onLateSendOutcome: async () => { throw new Error('private callback error'); } });
  const s = ready(asyncFailure); const p = asyncFailure.client.prepareTextSend('private', '20002', 'body').submit();
  asyncFailure.clock.advance(50); await p; s.reply(1, { message_id: 1 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(asyncFailure.client.getStatus().lastError, 'CALLBACK_FAILED'); asyncFailure.client.dispose();
  const thrown = harness({ socketFactory: () => { throw new Error('Bearer fixture-only-secret raw URL'); } });
  thrown.client.start(); assert.equal(thrown.client.getStatus().lastError, 'SOCKET_ERROR');
  assert.ok(!JSON.stringify(thrown.client.getStatus()).includes('fixture-only-secret')); thrown.client.dispose();
});
