import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { normalizeMessageId, normalizeQQId } from './protocol.js';

export type ConnectionState = 'disabled' | 'connecting' | 'authenticating' | 'ready'
  | 'reconnecting' | 'blocked' | 'stopping' | 'stopped';
export interface ReadyIdentity { readonly selfId: string; readonly connectionEpoch: string }
export interface SendOutcome {
  readonly state: 'succeeded' | 'failed' | 'unknown';
  readonly messageId?: string;
  readonly code?: string;
}
export interface PreparedSend {
  readonly echo: string;
  readonly connectionEpoch: string;
  /** Starts socket.send in this call stack. Never await/queue between the auth barrier and submit. */
  submit(): Promise<SendOutcome>;
}
export interface LateSendOutcome {
  readonly echo: string;
  readonly connectionEpoch: string;
  readonly outcome: SendOutcome;
}
export interface VerifiedMember extends ReadyIdentity {
  readonly groupId: string;
  readonly userId: string;
  readonly checkedAt: number;
}
export type TransportErrorCode = 'INVALID_OPTIONS' | 'NOT_READY' | 'STALE_CONNECTION'
  | 'STOPPED' | 'IDENTITY_MISMATCH' | 'IDENTITY_CHANGED' | 'AUTH_FAILED'
  | 'ACTION_TOO_LARGE' | 'TOO_MANY_PENDING' | 'INVALID_TEXT' | 'INVALID_ID'
  | 'ACTION_REJECTED' | 'MALFORMED_RESPONSE' | 'ACTION_MISMATCH' | 'MEMBER_MISMATCH'
  | 'TIMEOUT' | 'CONNECT_TIMEOUT' | 'DISCONNECTED' | 'SOCKET_ERROR' | 'SEND_ERROR'
  | 'INVALID_FRAME' | 'PAYLOAD_TOO_LARGE' | 'HEARTBEAT_TIMEOUT' | 'CALLBACK_FAILED';
/** Fixed codes only: no gateway error strings, URLs, response bodies or credential causes. */
export class OneBotTransportError extends Error {
  override readonly name = 'OneBotTransportError';
  constructor(readonly code: TransportErrorCode) { super(code); }
}

type Cancel = () => void;
export interface TransportClock {
  now(): number;
  random(): number;
  /** Must schedule, not invoke inline; cancellation is idempotent. */
  setTimeout(callback: () => void, delayMs: number): Cancel;
}
const systemClock: TransportClock = {
  now: () => Date.now(), random: () => Math.random(),
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
type SocketEvent = 'open' | 'message' | 'pong' | 'error' | 'close';
type SocketListener = (...args: unknown[]) => void;
/** Minimal ws surface, deliberately injectable. Factories must not emit events before returning. */
export interface OneBotSocket {
  readonly readyState: number;
  on(event: SocketEvent, listener: SocketListener): unknown;
  off(event: SocketEvent, listener: SocketListener): unknown;
  send(data: string, callback: (error?: Error) => void): void;
  ping(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
}
export interface SocketOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly maxPayload: number;
  readonly handshakeTimeout: number;
  readonly followRedirects: false;
  readonly perMessageDeflate: false;
  readonly rejectUnauthorized: true;
}
export type SocketFactory = (url: string, options: SocketOptions) => OneBotSocket;
export const defaultSocketFactory: SocketFactory = (url, options) => {
  const socket = new WebSocket(url, options);
  return {
    get readyState() { return socket.readyState; },
    on: (event, listener) => socket.on(event, listener),
    off: (event, listener) => socket.off(event, listener),
    send: (data, callback) => socket.send(data, callback),
    // ws exposes mask before its callback; do not pretend its native shape is our narrow transport port.
    ping: (data, callback) => socket.ping(data, undefined, callback),
    terminate: () => socket.terminate(),
  };
};

export interface OneBotClientOptions {
  enabled: boolean;
  wsUrl: string;
  expectedSelfId: string;
  token?: string;
  authMode?: 'bearer';
  allowInsecureRemoteWs?: boolean;
  connectTimeoutMs?: number;
  actionTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  stableConnectionMs?: number;
  /** Entire incoming WS message, before JSON parsing. Default 256 KiB; hard maximum 1 MiB. */
  maxPayloadBytes?: number;
  /** Entire serialized action including params, message, action and echo. Default 16 KiB. */
  maxActionBytes?: number;
  maxPending?: number;
  maxLateOutcomes?: number;
  lateOutcomeTtlMs?: number;
  socketFactory?: SocketFactory;
  clock?: TransportClock;
  /** Transient untrusted protocol data. Parent must normalize, sanitize and authorize before storing. */
  onEvent?: (event: Readonly<Record<string, unknown>>, identity: ReadyIdentity) => void | Promise<void>;
  onLateSendOutcome?: (result: LateSendOutcome) => void | Promise<void>;
}
export interface TransportStatus {
  readonly state: ConnectionState;
  readonly identity?: ReadyIdentity;
  readonly lastError?: TransportErrorCode;
  readonly reconnectAttempt: number;
  readonly pending: number;
  readonly lateOutcomes: number;
  readonly droppedFrames: number;
}

type Action = 'get_login_info' | 'get_group_member_info' | 'send_private_msg' | 'send_group_msg';
type Result = { readonly reply: Record<string, unknown> } | { readonly error: TransportErrorCode };
interface Pending {
  readonly action: Action;
  readonly epoch: string;
  readonly cancel: Cancel;
  readonly finish: (result: Result) => void;
}
interface Connection {
  readonly socket: OneBotSocket;
  readonly epoch: string;
  readonly listeners: [SocketEvent, SocketListener][];
  connectCancel?: Cancel;
  heartbeatCancel?: Cancel;
  stableCancel?: Cancel;
  lastLiveness: number;
  pingNonce?: string;
}
interface LateEntry { readonly epoch: string; readonly action: Action; readonly expiresAt: number }
const noop = (): void => {};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code: TransportErrorCode): never { throw new OneBotTransportError(code); }
function bounded(value: number | undefined, fallback: number, min = 1, max = 2_147_483_647): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) fail('INVALID_OPTIONS');
  return result;
}
function id(value: unknown): string {
  try {
    const result = normalizeQQId(value);
    if (result.length > 32) fail('INVALID_ID');
    return result;
  } catch { fail('INVALID_ID'); }
}
/** Only a consistent explicit error is a refusal. Contradictory/unrecognizable replies are uncertain. */
function replyError(reply: Record<string, unknown>, action: Action): TransportErrorCode | undefined {
  if (reply.action !== undefined && reply.action !== action) return 'ACTION_MISMATCH';
  if ((reply.status === 'ok' || reply.status === 'failed') && Number.isSafeInteger(reply.retcode)
    && (reply.retcode as number) !== 0) return 'ACTION_REJECTED';
  if (reply.status !== 'ok' || reply.retcode !== 0 || !record(reply.data)) return 'MALFORMED_RESPONSE';
  return undefined;
}
function sendOutcome(result: Result, action: Action): SendOutcome {
  if ('error' in result) return Object.freeze({ state: 'unknown', code: result.error });
  const error = replyError(result.reply, action);
  if (error) return Object.freeze({ state: error === 'ACTION_REJECTED' ? 'failed' : 'unknown', code: error });
  try {
    const messageId = normalizeMessageId((result.reply.data as Record<string, unknown>).message_id);
    return Object.freeze({ state: 'succeeded', messageId });
  } catch { return Object.freeze({ state: 'unknown', code: 'MALFORMED_RESPONSE' }); }
}

/**
 * One forward WS connection. No Context, storage, logging, arbitrary actions or send replay.
 * Preparation retains text only in the caller-owned handle; late tracking contains IDs/times only.
 * Parent owns authorization and persistence; submit must run inside its shared commit barrier.
 */
export class OneBotClient {
  private readonly options: Readonly<OneBotClientOptions>;
  private readonly clock: TransportClock;
  private readonly factory: SocketFactory;
  private readonly expectedSelfId: string;
  private readonly url: string;
  private readonly connectTimeout: number;
  private readonly actionTimeout: number;
  private readonly heartbeatTimeout: number;
  private readonly reconnectInitial: number;
  private readonly reconnectMax: number;
  private readonly stableMs: number;
  private readonly payloadCap: number;
  private readonly actionCap: number;
  private readonly pendingCap: number;
  private readonly lateCap: number;
  private readonly lateTtl: number;
  private state: ConnectionState = 'disabled';
  private readyIdentity: ReadyIdentity | undefined;
  private connection: Connection | undefined;
  private reconnectCancel: Cancel | undefined;
  private lateExpiryCancel: Cancel | undefined;
  private lastError: TransportErrorCode | undefined;
  private attempt = 0;
  private epochSequence = 0;
  private dropped = 0;
  private started = false;
  private readonly pending = new Map<string, Pending>();
  private readonly late = new Map<string, LateEntry>();

  constructor(options: OneBotClientOptions) {
    this.options = Object.freeze({ ...options });
    this.clock = options.clock ?? systemClock;
    this.factory = options.socketFactory ?? defaultSocketFactory;
    this.expectedSelfId = options.enabled ? id(options.expectedSelfId) : '';
    let url: URL;
    try { url = new URL(options.wsUrl); } catch { fail('INVALID_OPTIONS'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || options.wsUrl.length > 8192 || (options.authMode !== undefined && options.authMode !== 'bearer')) fail('INVALID_OPTIONS');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol === 'ws:' && !loopback && !options.allowInsecureRemoteWs) fail('INVALID_OPTIONS');
    if (options.token && (!/^[\x21-\x7e]+$/.test(options.token) || options.token.length > 4096)) fail('INVALID_OPTIONS');
    this.url = url.href;
    this.connectTimeout = bounded(options.connectTimeoutMs, 10_000);
    this.actionTimeout = bounded(options.actionTimeoutMs, 10_000);
    this.heartbeatTimeout = bounded(options.heartbeatTimeoutMs, 60_000, 2);
    this.reconnectInitial = bounded(options.reconnectInitialMs, 1000);
    this.reconnectMax = bounded(options.reconnectMaxMs, 60_000);
    this.stableMs = bounded(options.stableConnectionMs, 60_000);
    if (this.reconnectInitial > this.reconnectMax) fail('INVALID_OPTIONS');
    this.payloadCap = bounded(options.maxPayloadBytes, 256 * 1024, 1, 1024 * 1024);
    this.actionCap = bounded(options.maxActionBytes, 16 * 1024, 128, 1024 * 1024);
    this.pendingCap = bounded(options.maxPending, 128, 1, 4096);
    this.lateCap = bounded(options.maxLateOutcomes, 128, 0, 4096);
    this.lateTtl = bounded(options.lateOutcomeTtlMs, 120_000);
  }

  get identity(): ReadyIdentity | undefined { return this.readyIdentity; }
  getStatus(): TransportStatus {
    this.pruneLate();
    return Object.freeze({ state: this.state,
      ...(this.readyIdentity ? { identity: this.readyIdentity } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      reconnectAttempt: this.attempt, pending: this.pending.size,
      lateOutcomes: this.late.size, droppedFrames: this.dropped });
  }
  /** Explicit start only. disabled/blocked/stopped never silently start or restart. */
  start(): void {
    if (this.started || this.state === 'stopped') return;
    this.started = true;
    if (this.options.enabled) this.connect();
  }

  private connect(): void {
    if (this.state === 'blocked' || this.state === 'stopping' || this.state === 'stopped') return;
    this.state = 'connecting';
    let socket: OneBotSocket;
    try {
      socket = this.factory(this.url, {
        headers: Object.freeze(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        maxPayload: this.payloadCap, handshakeTimeout: this.connectTimeout,
        followRedirects: false, perMessageDeflate: false, rejectUnauthorized: true,
      });
    } catch { this.scheduleReconnect('SOCKET_ERROR'); return; }
    const connection: Connection = {
      socket, epoch: `${randomUUID()}:${++this.epochSequence}`, listeners: [], lastLiveness: this.clock.now(),
    };
    this.connection = connection;
    // Leave a noncapturing error sink after retirement: ws can emit an error after terminate.
    socket.on('error', noop);
    const listen = (event: SocketEvent, listener: SocketListener): void => {
      connection.listeners.push([event, listener]); socket.on(event, listener);
    };
    listen('open', () => this.opened(connection));
    listen('message', (data, binary) => this.received(connection, data, binary === true));
    listen('pong', data => {
      if (this.connection !== connection || this.state !== 'ready' || !connection.pingNonce) return;
      let pong: string;
      try { pong = this.frameText(data, 125); } catch { return; }
      if (pong === connection.pingNonce) {
        connection.lastLiveness = this.clock.now(); delete connection.pingNonce;
      }
    });
    listen('error', () => { if (this.connection === connection) this.disconnect(connection, 'SOCKET_ERROR'); });
    listen('close', () => { if (this.connection === connection) this.disconnect(connection, 'DISCONNECTED'); });
    connection.connectCancel = this.clock.setTimeout(() => {
      if (this.connection === connection) this.disconnect(connection, 'CONNECT_TIMEOUT');
    }, this.connectTimeout);
  }

  private opened(connection: Connection): void {
    if (this.connection !== connection || this.state !== 'connecting') return;
    connection.connectCancel?.(); delete connection.connectCancel;
    this.state = 'authenticating';
    const echo = this.echo(connection);
    this.request(connection, 'get_login_info', {}, echo, result => {
      if (this.connection !== connection || this.state !== 'authenticating') return;
      if ('error' in result) { this.disconnect(connection, result.error); return; }
      const error = replyError(result.reply, 'get_login_info');
      if (error) {
        if (error === 'ACTION_REJECTED') this.block(connection, 'AUTH_FAILED');
        else this.disconnect(connection, error);
        return;
      }
      let selfId: string;
      try { selfId = id((result.reply.data as Record<string, unknown>).user_id); }
      catch { this.block(connection, 'IDENTITY_MISMATCH'); return; }
      if (selfId !== this.expectedSelfId) { this.block(connection, 'IDENTITY_MISMATCH'); return; }
      this.readyIdentity = Object.freeze({ selfId, connectionEpoch: connection.epoch });
      this.state = 'ready'; this.lastError = undefined;
      connection.lastLiveness = this.clock.now();
      connection.stableCancel = this.clock.setTimeout(() => {
        if (this.connection === connection && this.state === 'ready') this.attempt = 0;
      }, this.stableMs);
      this.heartbeat(connection);
    });
  }

  private echo(connection: Connection): string { return `${connection.epoch}:${randomUUID()}`; }
  private encode(action: Action, params: Record<string, unknown>, echo: string): string {
    const payload = JSON.stringify({ action, params, echo });
    if (Buffer.byteLength(payload, 'utf8') > this.actionCap) fail('ACTION_TOO_LARGE');
    return payload;
  }
  /** All requests are registered before send, including synchronous mock replies. */
  private request(connection: Connection, action: Action, params: Record<string, unknown>, echo: string,
    finish: (result: Result) => void, encoded?: string): void {
    if (this.connection !== connection || connection.socket.readyState !== 1) { finish({ error: 'DISCONNECTED' }); return; }
    if (this.pending.size >= this.pendingCap) { finish({ error: 'TOO_MANY_PENDING' }); return; }
    let payload: string;
    try { payload = encoded ?? this.encode(action, params, echo); }
    catch { finish({ error: 'ACTION_TOO_LARGE' }); return; }
    const cancel = this.clock.setTimeout(() => this.complete(echo, { error: 'TIMEOUT' }), this.actionTimeout);
    this.pending.set(echo, { action, epoch: connection.epoch, cancel, finish });
    try {
      connection.socket.send(payload, error => {
        if (error && this.connection === connection) this.complete(echo, { error: 'SEND_ERROR' });
      });
    } catch { this.complete(echo, { error: 'SEND_ERROR' }); }
  }
  private complete(echo: string, result: Result): void {
    const pending = this.pending.get(echo);
    if (!pending) return;
    this.pending.delete(echo); pending.cancel(); pending.finish(result);
  }

  /** Fixed uncached observation; no profile/nickname/raw gateway fields are returned. */
  getGroupMemberInfo(groupId: string, userId: string): Promise<VerifiedMember> {
    const identity = this.identity;
    const connection = this.connection;
    if (!identity || !connection || this.state !== 'ready') return Promise.reject(new OneBotTransportError('NOT_READY'));
    let group: string; let user: string;
    try { group = id(groupId); user = id(userId); }
    catch { return Promise.reject(new OneBotTransportError('INVALID_ID')); }
    return new Promise<VerifiedMember>((resolve, reject) => {
      this.request(connection, 'get_group_member_info', { group_id: group, user_id: user, no_cache: true }, this.echo(connection), result => {
        if ('error' in result) { reject(new OneBotTransportError(result.error)); return; }
        if (this.identity !== identity || this.state !== 'ready') { reject(new OneBotTransportError('IDENTITY_CHANGED')); return; }
        const error = replyError(result.reply, 'get_group_member_info');
        if (error) { reject(new OneBotTransportError(error)); return; }
        const data = result.reply.data as Record<string, unknown>;
        try {
          if (id(data.group_id) !== group || id(data.user_id) !== user) fail('MEMBER_MISMATCH');
        } catch { reject(new OneBotTransportError('MEMBER_MISMATCH')); return; }
        resolve(Object.freeze({ ...identity, groupId: group, userId: user, checkedAt: this.clock.now() }));
      });
    });
  }

  prepareTextSend(type: 'group' | 'private', targetId: string, text: string): PreparedSend {
    const connection = this.connection;
    if (this.state !== 'ready' || !this.identity || !connection) fail('NOT_READY');
    if (type !== 'group' && type !== 'private') fail('INVALID_OPTIONS');
    const target = id(targetId);
    if (typeof text !== 'string') fail('INVALID_TEXT');
    // An unescaped body already larger than the complete cap cannot fit; reject before copying/encoding it.
    if (Buffer.byteLength(text, 'utf8') > this.actionCap) fail('ACTION_TOO_LARGE');
    if (!text.trim()) fail('INVALID_TEXT');
    for (const point of text) {
      const code = point.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff) fail('INVALID_TEXT');
    }
    const action: Action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const echo = this.echo(connection);
    // NEVER parse CQ. The full escaped JSON, target and echo count against the cap.
    const params = { [type === 'group' ? 'group_id' : 'user_id']: target, message: [{ type: 'text', data: { text } }] };
    let payload: string | undefined = this.encode(action, params, echo);
    let submitted: Promise<SendOutcome> | undefined;
    const connectionEpoch = connection.epoch;
    return Object.freeze({ echo, connectionEpoch, submit: (): Promise<SendOutcome> => {
      if (submitted) return submitted;
      if (this.state !== 'ready' || this.connection !== connection || this.identity?.connectionEpoch !== connectionEpoch
        || connection.socket.readyState !== 1) {
        payload = undefined;
        submitted = Promise.resolve(Object.freeze({ state: 'failed', code: 'STALE_CONNECTION' }));
        return submitted;
      }
      if (this.pending.size >= this.pendingCap) {
        payload = undefined;
        submitted = Promise.resolve(Object.freeze({ state: 'failed', code: 'TOO_MANY_PENDING' }));
        return submitted;
      }
      // Assign the promise BEFORE network entry for idempotence under reentrant factories.
      let resolve!: (outcome: SendOutcome) => void;
      submitted = new Promise<SendOutcome>(done => { resolve = done; });
      const encoded = payload!; payload = undefined;
      this.request(connection, action, {}, echo, result => {
        const outcome = sendOutcome(result, action);
        if (outcome.state === 'unknown') this.trackLate(echo, connectionEpoch, action);
        resolve(outcome);
      }, encoded);
      return submitted;
    } });
  }

  private frameText(data: unknown, cap: number): string {
    if (typeof data === 'string') {
      if (Buffer.byteLength(data, 'utf8') > cap) fail('PAYLOAD_TOO_LARGE');
      return data;
    }
    let bytes: Uint8Array;
    if (Array.isArray(data)) {
      let size = 0;
      for (const part of data) {
        if (!Buffer.isBuffer(part)) fail('INVALID_FRAME');
        size += part.length; if (size > cap) fail('PAYLOAD_TOO_LARGE');
      }
      bytes = Buffer.concat(data as Buffer[], size);
    } else if (data instanceof ArrayBuffer) {
      if (data.byteLength > cap) fail('PAYLOAD_TOO_LARGE');
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      if (data.byteLength > cap) fail('PAYLOAD_TOO_LARGE');
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else fail('INVALID_FRAME');
    if (bytes.byteLength > cap) fail('PAYLOAD_TOO_LARGE');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('INVALID_FRAME'); }
  }
  private received(connection: Connection, data: unknown, binary: boolean): void {
    if (this.connection !== connection) return;
    let parsed: unknown;
    try {
      if (binary) fail('INVALID_FRAME');
      parsed = JSON.parse(this.frameText(data, this.payloadCap)) as unknown;
      if (!record(parsed)) fail('INVALID_FRAME');
    } catch (error) {
      const code = error instanceof OneBotTransportError ? error.code : 'INVALID_FRAME';
      this.dropped++; this.lastError = code;
      if (code === 'PAYLOAD_TOO_LARGE') this.disconnect(connection, code);
      return;
    }
    if (typeof parsed.echo === 'string') {
      const pending = this.pending.get(parsed.echo);
      if (pending?.epoch === connection.epoch) this.complete(parsed.echo, { reply: parsed });
      else this.lateReply(connection, parsed.echo, parsed);
      return;
    }
    // No identity from events is ever used to select/create a bot or enter ready.
    if (this.state !== 'ready' || !this.readyIdentity || typeof parsed.post_type !== 'string') return;
    let selfId: string;
    try { selfId = id(parsed.self_id); }
    catch { this.block(connection, 'IDENTITY_MISMATCH'); return; }
    if (selfId !== this.readyIdentity.selfId) { this.block(connection, 'IDENTITY_MISMATCH'); return; }
    if (parsed.post_type === 'meta_event' && parsed.meta_event_type === 'heartbeat') connection.lastLiveness = this.clock.now();
    this.callback(this.options.onEvent, parsed, this.readyIdentity);
  }

  private callback<T extends unknown[]>(callback: ((...args: T) => void | Promise<void>) | undefined, ...args: T): void {
    try {
      const result = callback?.(...args);
      if (result) void Promise.resolve(result).catch(() => { this.lastError = 'CALLBACK_FAILED'; });
    } catch { this.lastError = 'CALLBACK_FAILED'; }
  }
  private heartbeat(connection: Connection): void {
    connection.heartbeatCancel = this.clock.setTimeout(() => {
      if (this.connection !== connection || this.state !== 'ready') return;
      if (this.clock.now() - connection.lastLiveness >= this.heartbeatTimeout) {
        this.disconnect(connection, 'HEARTBEAT_TIMEOUT'); return;
      }
      connection.pingNonce = randomUUID();
      try {
        connection.socket.ping(connection.pingNonce, error => {
          if (error && this.connection === connection) this.disconnect(connection, 'SOCKET_ERROR');
        });
      } catch { this.disconnect(connection, 'SOCKET_ERROR'); return; }
      if (this.connection === connection) this.heartbeat(connection);
    }, Math.max(1, Math.floor(this.heartbeatTimeout / 2)));
  }
  private trackLate(echo: string, epoch: string, action: Action): void {
    if (!this.options.onLateSendOutcome || this.lateCap === 0 || this.state === 'stopping' || this.state === 'stopped'
      || this.connection?.epoch !== epoch) return;
    this.pruneLate();
    while (this.late.size >= this.lateCap) this.late.delete(this.late.keys().next().value!);
    this.late.set(echo, { epoch, action, expiresAt: this.clock.now() + this.lateTtl });
    this.scheduleLateExpiry();
  }
  private pruneLate(): void {
    const now = this.clock.now();
    for (const [echo, entry] of this.late) if (entry.expiresAt <= now) this.late.delete(echo);
  }
  private scheduleLateExpiry(): void {
    this.lateExpiryCancel?.(); this.lateExpiryCancel = undefined;
    const first = this.late.values().next().value;
    if (!first) return;
    this.lateExpiryCancel = this.clock.setTimeout(() => { this.pruneLate(); this.scheduleLateExpiry(); }, Math.max(1, first.expiresAt - this.clock.now()));
  }
  private lateReply(connection: Connection, echo: string, reply: Record<string, unknown>): void {
    this.pruneLate();
    const late = this.late.get(echo);
    if (!late || late.epoch !== connection.epoch || this.state !== 'ready') return;
    const outcome = sendOutcome({ reply }, late.action);
    if (outcome.state === 'unknown') return;
    this.late.delete(echo); this.scheduleLateExpiry();
    this.callback(this.options.onLateSendOutcome, Object.freeze({ echo, connectionEpoch: late.epoch, outcome }));
  }
  private retire(connection: Connection, reason: TransportErrorCode): void {
    if (this.connection !== connection) return;
    this.connection = undefined; this.readyIdentity = undefined;
    connection.connectCancel?.(); connection.heartbeatCancel?.(); connection.stableCancel?.();
    for (const [event, listener] of connection.listeners) connection.socket.off(event, listener);
    // Invalidate identity before settling callbacks; no callback may start a new ready request.
    for (const [echo, pending] of this.pending) {
      if (pending.epoch === connection.epoch) this.complete(echo, { error: reason });
    }
    this.late.clear(); this.lateExpiryCancel?.(); this.lateExpiryCancel = undefined;
    try { connection.socket.terminate(); } catch { /* Only fixed reason metadata is exposed. */ }
  }
  private disconnect(connection: Connection, reason: TransportErrorCode): void {
    if (this.connection !== connection) return;
    this.retire(connection, reason); this.scheduleReconnect(reason);
  }
  private block(connection: Connection, reason: TransportErrorCode): void {
    this.state = 'blocked'; this.lastError = reason;
    this.reconnectCancel?.(); this.reconnectCancel = undefined;
    this.retire(connection, reason);
  }
  private scheduleReconnect(reason: TransportErrorCode): void {
    if (this.state === 'blocked' || this.state === 'stopping' || this.state === 'stopped') return;
    this.state = 'reconnecting'; this.lastError = reason;
    const base = Math.min(this.reconnectMax, this.reconnectInitial * 2 ** Math.min(this.attempt++, 30));
    const sample = this.clock.random();
    const random = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
    const delay = Math.max(1, Math.floor(base * (0.5 + random * 0.5)));
    this.reconnectCancel?.();
    this.reconnectCancel = this.clock.setTimeout(() => { this.reconnectCancel = undefined; this.connect(); }, delay);
  }
  /** Cancels all timers and read requests; submitted sends settle unknown, never replay. */
  dispose(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    this.reconnectCancel?.(); this.reconnectCancel = undefined;
    if (this.connection) this.retire(this.connection, 'STOPPED');
    this.late.clear(); this.lateExpiryCancel?.(); this.lateExpiryCancel = undefined;
    this.readyIdentity = undefined; this.state = 'stopped';
  }
}
