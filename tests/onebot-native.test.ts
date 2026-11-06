import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import test, { type TestContext } from 'node:test';
import NodeWebSocket, { WebSocketServer as NodeWebSocketServer, type RawData } from 'ws';
import {
  defaultSocketFactory, OneBotClient, OneBotTransportError,
  type OneBotSocket, type ReadyIdentity, type TransportClock,
} from '../src/onebot/client.js';

// Real ws transport only: ephemeral IPv4 loopback fixtures, never a Host/profile/QQ/model.
const DEADLINE_MS = 5_000;
async function deadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`deadline: ${label}`)), DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}

class Inbox<T> {
  private readonly values: T[] = [];
  private readonly readers: ((value: T) => void)[] = [];
  push(value: T): void {
    const reader = this.readers.shift();
    if (reader) reader(value); else this.values.push(value);
  }
  next(label: string): Promise<T> {
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    return deadline(new Promise<T>(resolve => { this.readers.push(resolve); }), label);
  }
}

/** Real time, with ownership visible so disposal can prove cancellation without sleeps. */
class OwnedClock implements TransportClock {
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  now(): number { return Date.now(); }
  random(): number { return 0.5; }
  setTimeout(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, delayMs);
    timer.unref(); this.timers.add(timer);
    return () => { clearTimeout(timer); this.timers.delete(timer); };
  }
  clear(): void { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}

interface WireAction { action: string; echo: string; params: Record<string, unknown> }
interface GatewayConnection {
  socket: NodeWebSocket;
  request: IncomingMessage;
  frames: Inbox<{ data: RawData; binary: boolean }>;
  received: { data: RawData; binary: boolean }[];
}
async function action(connection: GatewayConnection): Promise<WireAction> {
  const { data, binary } = await connection.frames.next('gateway action');
  assert.equal(binary, false);
  assert.ok(Buffer.isBuffer(data), 'native ws supplies a Buffer for a text frame');
  const value = JSON.parse(data.toString('utf8')) as WireAction;
  assert.equal(typeof value.action, 'string');
  assert.equal(typeof value.echo, 'string');
  assert.ok(value.echo.length > 0);
  assert.ok(value.params && typeof value.params === 'object' && !Array.isArray(value.params));
  return value;
}
async function send(socket: NodeWebSocket, value: unknown): Promise<void> {
  await deadline(new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(value), error => { if (error) reject(error); else resolve(); });
  }), 'gateway frame write');
}
function reply(socket: NodeWebSocket, request: WireAction, data: unknown): Promise<void> {
  return send(socket, { status: 'ok', retcode: 0, echo: request.echo, data });
}
const message = (messageId: number) => ({
  post_type: 'message', self_id: 10001, message_type: 'private', user_id: 20002,
  message_id: messageId, time: 1, message: [{ type: 'text', data: { text: 'fixture event' } }],
});
const notReady = (error: unknown): boolean => error instanceof OneBotTransportError && error.code === 'NOT_READY';

async function gateway(t: TestContext) {
  const server = new NodeWebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  const connections = new Inbox<GatewayConnection>();
  const accepted: GatewayConnection[] = [];
  const owners: (() => void)[] = [];
  let closing: Promise<void> | undefined;
  server.on('connection', (socket, request) => {
    // A late ws error during terminate must not escape the fixture's cleanup.
    socket.on('error', () => {});
    const connection: GatewayConnection = { socket, request, frames: new Inbox(), received: [] };
    socket.on('message', (data, binary) => {
      const frame = { data, binary }; connection.received.push(frame); connection.frames.push(frame);
    });
    accepted.push(connection); connections.push(connection);
  });
  const close = (): Promise<void> => closing ??= (async () => {
    try {
      for (const dispose of owners.reverse()) dispose();
    } finally {
      const closedClients = [...server.clients].map(socket => {
        if (socket.readyState === NodeWebSocket.CLOSED) return Promise.resolve();
        const closed = once(socket, 'close'); socket.terminate();
        return closed.then(() => {});
      });
      const closedServer = new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve(); });
      });
      await deadline(Promise.all([...closedClients, closedServer]), 'owned clients and server close');
      assert.equal(server.clients.size, 0);
      assert.equal(server.address(), null);
    }
  })();
  t.after(close);
  await deadline(once(server, 'listening'), 'loopback gateway listen');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  assert.ok(address.port > 0);
  return { url: `ws://127.0.0.1:${address.port}/onebot-v11`, connections, accepted, close,
    own(dispose: () => void) { owners.push(dispose); } };
}

function portEvent(socket: OneBotSocket, event: 'open' | 'pong' | 'close'): Promise<unknown[]> {
  let success!: (...args: unknown[]) => void;
  let failure!: (...args: unknown[]) => void;
  const work = new Promise<unknown[]>((resolve, reject) => {
    success = (...args) => resolve(args);
    failure = error => reject(error);
    socket.on(event, success); socket.on('error', failure);
  });
  return deadline(work, `native socket ${event}`).finally(() => {
    socket.off(event, success); socket.off('error', failure);
  });
}

test('native default transport verifies login before events, uncached membership and literal echo-confirmed text',
  { timeout: 30_000 }, async t => {
    const fixture = await gateway(t);
    const clock = new OwnedClock();
    const events = new Inbox<{ event: Readonly<Record<string, unknown>>; identity: ReadyIdentity }>();
    const delivered: Readonly<Record<string, unknown>>[] = [];
    // Deliberately omit socketFactory: exercise OneBotClient's production default.
    const client = new OneBotClient({
      enabled: true, wsUrl: fixture.url, expectedSelfId: '10001', token: 'native-fixture-token',
      authMode: 'bearer', clock, connectTimeoutMs: DEADLINE_MS, actionTimeoutMs: DEADLINE_MS,
      heartbeatTimeoutMs: 60_000,
      onEvent: (event, identity) => { delivered.push(event); events.push({ event, identity }); },
    });
    fixture.own(() => { try { client.dispose(); } finally { clock.clear(); } });
    try {
      client.start(); client.start();
      const connection = await fixture.connections.next('native client connection');
      assert.equal(connection.request.headers.authorization, 'Bearer native-fixture-token');
      assert.equal(connection.request.url, '/onebot-v11');
      const login = await action(connection);
      assert.equal(login.action, 'get_login_info'); assert.deepEqual(login.params, {});
      assert.equal(client.getStatus().state, 'authenticating');
      assert.equal(client.identity === undefined, true);
      assert.throws(() => client.prepareTextSend('private', '20002', 'not yet'), notReady);

      // A pong is an ordered transport barrier: the preceding pre-auth frame was consumed.
      const preAuthPong = deadline(once(connection.socket, 'pong'), 'pre-auth frame barrier');
      await send(connection.socket, message(1));
      connection.socket.ping('pre-auth-barrier');
      assert.equal((await preAuthPong)[0].toString(), 'pre-auth-barrier');
      assert.equal(delivered.length, 0);
      assert.equal(client.identity === undefined, true);
      assert.equal(client.getStatus().state, 'authenticating');

      await reply(connection.socket, login, { user_id: 10001, nickname: 'ignored fixture nickname' });
      await send(connection.socket, message(2));
      const verified = await events.next('verified event');
      assert.equal(verified.event.message_id, 2);
      assert.equal(verified.identity, client.identity);
      assert.equal(verified.identity.selfId, '10001');
      assert.ok(verified.identity.connectionEpoch.length > 0);
      assert.equal(client.getStatus().state, 'ready');
      assert.equal(delivered.length, 1);

      const memberResult = deadline(client.getGroupMemberInfo('30003', '20002'), 'verified member');
      const memberAction = await action(connection);
      assert.equal(memberAction.action, 'get_group_member_info');
      assert.deepEqual(memberAction.params, { group_id: '30003', user_id: '20002', no_cache: true });
      await reply(connection.socket, memberAction, { group_id: 30003, user_id: 20002, card: 'ignored' });
      const member = await memberResult;
      assert.equal(member.selfId, '10001'); assert.equal(member.groupId, '30003');
      assert.equal(member.userId, '20002');
      assert.equal(member.connectionEpoch, verified.identity.connectionEpoch);
      assert.equal(typeof member.checkedAt, 'number');
      assert.deepEqual(Object.keys(member).sort(), ['checkedAt', 'connectionEpoch', 'groupId', 'selfId', 'userId']);

      const text = 'Literal [CQ:at,qq=all] & [CQ:image,file=not-an-image] 中文';
      const prepared = client.prepareTextSend('group', '30003', text);
      assert.equal(connection.received.length, 2, 'preparation alone sends nothing');
      assert.equal(prepared.connectionEpoch, verified.identity.connectionEpoch);
      const submission = prepared.submit();
      assert.equal(prepared.submit(), submission, 'submit is idempotent on the real transport');
      const outcome = deadline(submission, 'echo-confirmed send');
      const sent = await action(connection);
      assert.equal(sent.action, 'send_group_msg'); assert.equal(sent.echo, prepared.echo);
      assert.deepEqual(sent.params, { group_id: '30003', message: [{ type: 'text', data: { text } }] });
      // A valid success with an unrelated echo cannot settle this submission.
      await send(connection.socket, { status: 'ok', retcode: 0, echo: 'unrelated-echo', data: { message_id: 999 } });
      await send(connection.socket, message(3));
      await events.next('unrelated echo barrier');
      assert.equal(client.getStatus().pending, 1);
      await reply(connection.socket, sent, { message_id: -12345 });
      assert.deepEqual(await outcome, { state: 'succeeded', messageId: '-12345' });
      assert.equal(client.getStatus().pending, 0);

      const pendingRead = assert.rejects(client.getGroupMemberInfo('30003', '20002'),
        (error: unknown) => error instanceof OneBotTransportError && error.code === 'STOPPED');
      await action(connection);
      const closed = deadline(once(connection.socket, 'close'), 'dispose terminates owned websocket');
      assert.ok(clock.timers.size > 0);
      client.dispose(); client.dispose();
      await deadline(pendingRead, 'dispose settles pending read');
      await closed;
      assert.equal(clock.timers.size, 0, 'connect/action/heartbeat/stable timers are all cancelled');
      assert.equal(client.getStatus().state, 'stopped'); assert.equal(client.identity === undefined, true);
      assert.equal(client.getStatus().pending, 0);
      client.start(); assert.equal(fixture.accepted.length, 1);
    } finally { await fixture.close(); }
  });

test('defaultSocketFactory adapts native ws ping callback and receives the matching automatic pong',
  { timeout: 20_000 }, async t => {
    const fixture = await gateway(t);
    const socket = defaultSocketFactory(fixture.url, {
      headers: {}, maxPayload: 256 * 1024, handshakeTimeout: DEADLINE_MS,
      followRedirects: false, perMessageDeflate: false, rejectUnauthorized: true,
    });
    fixture.own(() => socket.terminate());
    // Keep the ws error sink after adapter listeners are removed during cleanup.
    socket.on('error', () => {});
    try {
      await portEvent(socket, 'open');
      const connection = await fixture.connections.next('native ping connection');
      const ping = deadline(once(connection.socket, 'ping'), 'server observes native ping');
      const pong = portEvent(socket, 'pong');
      let callbacks = 0;
      const written = deadline(new Promise<void>((resolve, reject) => {
        socket.ping('native-adapter-nonce', error => {
          callbacks++;
          if (error) reject(error); else resolve();
        });
      }), 'native ping write callback');
      const [receivedPing, receivedPong] = await Promise.all([ping, pong, written]);
      assert.equal(receivedPing[0].toString(), 'native-adapter-nonce');
      assert.ok(Buffer.isBuffer(receivedPong[0]));
      assert.equal(receivedPong[0].toString(), 'native-adapter-nonce');
      assert.equal(callbacks, 1);
      assert.equal(socket.readyState, NodeWebSocket.OPEN);
      const closed = portEvent(socket, 'close'); socket.terminate(); await closed;
      assert.equal(socket.readyState, NodeWebSocket.CLOSED);
    } finally { await fixture.close(); }
  });

test('native login identity mismatch blocks without events, message sends or reconnect timers',
  { timeout: 20_000 }, async t => {
    const fixture = await gateway(t);
    const clock = new OwnedClock();
    let events = 0;
    const client = new OneBotClient({
      enabled: true, wsUrl: fixture.url, expectedSelfId: '10001', clock,
      connectTimeoutMs: DEADLINE_MS, actionTimeoutMs: DEADLINE_MS,
      onEvent: () => { events++; },
    });
    fixture.own(() => { try { client.dispose(); } finally { clock.clear(); } });
    try {
      client.start();
      const connection = await fixture.connections.next('wrong identity connection');
      const login = await action(connection);
      assert.equal(login.action, 'get_login_info');
      await send(connection.socket, message(1));
      const closed = deadline(once(connection.socket, 'close'), 'wrong identity closes socket');
      await reply(connection.socket, login, { user_id: 10002 });
      await closed;
      assert.equal(client.getStatus().state, 'blocked');
      assert.equal(client.getStatus().lastError, 'IDENTITY_MISMATCH');
      assert.equal(client.identity === undefined, true); assert.equal(events, 0);
      assert.throws(() => client.prepareTextSend('private', '20002', 'must not send'), notReady);
      await assert.rejects(client.getGroupMemberInfo('30003', '20002'), notReady);
      client.start();
      assert.equal(connection.received.length, 1, 'only get_login_info went onto the wire');
      assert.equal(fixture.accepted.length, 1);
      assert.equal(clock.timers.size, 0, 'blocked identity schedules no reconnect or heartbeat');
    } finally { await fixture.close(); }
  });
