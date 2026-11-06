import { Buffer } from 'node:buffer';

/** Pure OneBot v11 boundary helpers. No network, persistence, clocks or API calls. */
export type ProtocolErrorCode =
  | 'INVALID_ID' | 'UNSAFE_ID_NUMBER' | 'INVALID_MESSAGE_ID' | 'MISSING_MESSAGE_ID'
  | 'INVALID_EVENT' | 'EVENT_TOO_LARGE' | 'BOT_ID_MISMATCH' | 'INVALID_MESSAGE_TYPE'
  | 'INVALID_TIME' | 'INVALID_SEGMENT' | 'INVALID_CQ' | 'TOO_MANY_SEGMENTS'
  | 'TEXT_TOO_LARGE' | 'INVALID_TEXT' | 'INVALID_LIMIT' | 'INVALID_TRIGGER'
  | 'SANITIZER_FAILED' | 'OUTGOING_OVERFLOW';

/** Messages deliberately contain no supplied values, event bodies or authentication data. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export type QQId = string;
export type TextSanitizer = (text: string) => string;
export interface SanitizationOptions {
  /** Exact configured credentials; these are never included in returned events. */
  knownSecrets?: readonly string[];
  /** Optional additional bounded policy. Built-in masking runs before and after it. */
  sanitizeText?: TextSanitizer;
}
export interface InboundLimits {
  maxEventBytes: number;
  maxTextBytes: number;
  maxSegments: number;
}
export const DEFAULT_INBOUND_LIMITS: Readonly<InboundLimits> = Object.freeze({
  maxEventBytes: 256 * 1024,
  maxTextBytes: 16 * 1024,
  maxSegments: 256,
});
export interface NormalizeOptions extends SanitizationOptions {
  expectedSelfId: string | number;
  limits?: Partial<InboundLimits>;
}
export interface SegmentOptions extends SanitizationOptions {
  limits?: Partial<InboundLimits>;
}
export type NormalizedSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'at'; readonly target: QQId | 'all' }
  | { readonly type: 'reply'; readonly messageId: string }
  | { readonly type: 'metadata'; readonly kind: string; readonly placeholder: string };
export type MessageAuthor =
  | { readonly kind: 'qq'; readonly qqId: QQId }
  | { readonly kind: 'anonymous'; readonly localId: string };
export interface OneBotTextSegment {
  readonly type: 'text';
  readonly data: { readonly text: string };
}
export interface SanitizedEvent {
  readonly post_type: 'message';
  readonly self_id: QQId;
  readonly message_type: 'group' | 'private';
  readonly message_id: string;
  readonly time: number;
  readonly user_id?: QQId;
  readonly group_id?: QQId;
  readonly anonymous?: { readonly id: string };
  /** Allowlisted projection, not a lossless dump: no sender, URLs, auth or quoted bodies. */
  readonly message: readonly Record<string, unknown>[];
}
export interface NormalizedMessage {
  readonly botId: QQId;
  readonly conversationType: 'group' | 'private';
  readonly conversationId: QQId;
  readonly messageId: string;
  readonly eventTimeSeconds: number;
  readonly eventTimeMs: number;
  readonly author: MessageAuthor;
  readonly segments: readonly NormalizedSegment[];
  /** Safe display/model text. Metadata placeholders are not eligible to trigger. */
  readonly text: string;
  readonly idempotencyKey: string;
  readonly sanitizedEvent: SanitizedEvent;
}

function fail(code: ProtocolErrorCode, message: string): never {
  throw new ProtocolError(code, message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_LIMIT', 'Limits must be positive safe integers.');
  return value;
}
function inboundLimits(overrides?: Partial<InboundLimits>): InboundLimits {
  const limits = { ...DEFAULT_INBOUND_LIMITS, ...overrides };
  positiveLimit(limits.maxEventBytes);
  positiveLimit(limits.maxTextBytes);
  positiveLimit(limits.maxSegments);
  return limits;
}
function assertUnicode(text: string): void {
  // A lone UTF-16 surrogate is not a Unicode scalar value and would be replaced during UTF-8 encoding.
  for (const point of text) {
    const value = point.codePointAt(0)!;
    if (value >= 0xd800 && value <= 0xdfff) fail('INVALID_TEXT', 'Text contains an unpaired surrogate.');
  }
}

/** QQ identity is canonical positive decimal text. Never round an unsafe JS number. */
export function normalizeQQId(value: unknown): QQId {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('UNSAFE_ID_NUMBER', 'Numeric IDs must be safe integers.');
    if (value <= 0) fail('INVALID_ID', 'QQ IDs must be positive decimal integers.');
    return String(value);
  }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    fail('INVALID_ID', 'QQ IDs must be positive decimal strings or safe integers.');
  }
  const canonical = value.replace(/^0+/, '');
  if (!canonical) fail('INVALID_ID', 'QQ IDs must be positive decimal integers.');
  return canonical;
}

/** v11 integer IDs may be negative; gateway opaque stable ASCII IDs are also accepted. */
export function normalizeMessageId(value: unknown): string {
  if (value === undefined || value === null || value === '') fail('MISSING_MESSAGE_ID', 'A stable message ID is required.');
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('UNSAFE_ID_NUMBER', 'Numeric IDs must be safe integers.');
    return String(value);
  }
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    fail('INVALID_MESSAGE_ID', 'Message IDs must be bounded stable ASCII identifiers.');
  }
  if (/^-?[0-9]+$/.test(value)) {
    const negative = value.startsWith('-');
    const digits = (negative ? value.slice(1) : value).replace(/^0+/, '') || '0';
    return negative && digits !== '0' ? `-${digits}` : digits;
  }
  return value;
}

/** Best effort for known patterns only; this is not a general secret detector. */
export function sanitizeSecrets(text: string, knownSecrets: readonly string[] = []): string {
  // Recognize full patterned secrets before literal replacement can split their syntax.
  let result = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:~-]+/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|token)\b(["']?\s*[:=]\s*)(?!\[REDACTED(?:_[A-Z]+)?\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi, '$1$2[REDACTED]')
    .replace(/(https?:\/\/|wss?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  // Longest first prevents a shorter configured secret exposing the suffix of another.
  for (const secret of [...knownSecrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}
function protectedMessageId(value: unknown, options: SanitizationOptions): string {
  const id = normalizeMessageId(value);
  // Mutating an identity would break deduplication. Reject authentication-shaped or
  // explicitly configured secret IDs instead of retaining them or altering their value.
  if (sanitizeSecrets(id, options.knownSecrets) !== id) fail('INVALID_MESSAGE_ID', 'Stable IDs must not contain credentials.');
  return id;
}
function sanitizedText(text: string, options: SanitizationOptions): string {
  let result = sanitizeSecrets(text, options.knownSecrets);
  if (options.sanitizeText) {
    try {
      result = options.sanitizeText(result);
    } catch {
      fail('SANITIZER_FAILED', 'The configured sanitizer failed.');
    }
    if (typeof result !== 'string') fail('SANITIZER_FAILED', 'The configured sanitizer must return text.');
  }
  result = sanitizeSecrets(result, options.knownSecrets);
  assertUnicode(result);
  return result;
}

/** Decode exactly one CQ escaping layer. Commas are escaped only inside parameters. */
export function decodeCQText(text: string, parameter = false): string {
  return text.replace(/&(?:amp|#91|#93|#44);/g, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&#91;') return '[';
    if (entity === '&#93;') return ']';
    return parameter ? ',' : entity;
  });
}
interface WireSegment { type: string; data: Record<string, unknown> }
function cqWireSegments(message: string, maxSegments: number): WireSegment[] {
  const result: WireSegment[] = [];
  const append = (segment: WireSegment): void => {
    if (result.length >= maxSegments) fail('TOO_MANY_SEGMENTS', 'The message has too many segments.');
    result.push(segment);
  };
  // Recognition happens on the original string, never on decoded text. Unclosed codes
  // stay text. Reject raw nested brackets rather than discovering a forged inner at.
  let cursor = 0;
  while (cursor < message.length) {
    const index = message.indexOf('[CQ:', cursor);
    if (index < 0) {
      append({ type: 'text', data: { text: decodeCQText(message.slice(cursor)) } });
      break;
    }
    if (index > cursor) append({ type: 'text', data: { text: decodeCQText(message.slice(cursor, index)) } });
    const end = message.indexOf(']', index + 4);
    if (end < 0) {
      append({ type: 'text', data: { text: decodeCQText(message.slice(index)) } });
      break;
    }
    const body = message.slice(index + 4, end);
    if (body.includes('[')) fail('INVALID_CQ', 'Nested CQ brackets must be escaped.');
    const [type, ...parameters] = body.split(',');
    if (!type || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(type)) fail('INVALID_CQ', 'CQ segment types must be valid.');
    const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const parameter of parameters) {
      const separator = parameter.indexOf('=');
      if (separator < 1) fail('INVALID_CQ', 'CQ parameters require a key and value.');
      const key = parameter.slice(0, separator);
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || Object.hasOwn(data, key)) {
        fail('INVALID_CQ', 'CQ parameter keys must be valid and unique.');
      }
      data[key] = decodeCQText(parameter.slice(separator + 1), true);
    }
    append({ type, data });
    cursor = end + 1;
  }
  return result;
}
function serializedBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail('INVALID_EVENT', 'The event must be JSON data.');
    return Buffer.byteLength(encoded, 'utf8');
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    fail('INVALID_EVENT', 'The event must be serializable JSON data.');
  }
}
const METADATA_TYPES = new Set([
  'face', 'image', 'record', 'video', 'rps', 'dice', 'shake', 'poke', 'anonymous',
  'share', 'contact', 'location', 'music', 'forward', 'node', 'xml', 'json', 'file',
  'quote', 'markdown', 'mface',
]);
function normalizeWireSegments(wire: unknown[], options: SegmentOptions, limits: InboundLimits): NormalizedSegment[] {
  if (wire.length === 0) fail('INVALID_SEGMENT', 'A message must contain at least one segment.');
  if (wire.length > limits.maxSegments) fail('TOO_MANY_SEGMENTS', 'The message has too many segments.');
  const result: NormalizedSegment[] = [];
  let originalTextBytes = 0;
  let safeTextBytes = 0;
  let textRun = '';
  let hasTextRun = false;
  const flushText = (): void => {
    if (!hasTextRun) return;
    // Sanitize the whole contiguous run so splitting credentials across adjacent text
    // segments cannot bypass known-pattern or exact-secret masking.
    const text = sanitizedText(textRun, options);
    safeTextBytes += Buffer.byteLength(text, 'utf8');
    if (safeTextBytes > limits.maxTextBytes) fail('TEXT_TOO_LARGE', 'The sanitized message text exceeds its byte limit.');
    result.push({ type: 'text', text });
    textRun = ''; hasTextRun = false;
  };
  for (const segment of wire) {
    if (!isRecord(segment) || typeof segment.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(segment.type) || !isRecord(segment.data)) {
      fail('INVALID_SEGMENT', 'Each message segment requires a valid type and data object.');
    }
    const { type, data } = segment;
    if (type === 'text') {
      if (typeof data.text !== 'string') fail('INVALID_SEGMENT', 'A text segment requires text.');
      assertUnicode(data.text);
      originalTextBytes += Buffer.byteLength(data.text, 'utf8');
      if (originalTextBytes > limits.maxTextBytes) fail('TEXT_TOO_LARGE', 'The message text exceeds its byte limit.');
      textRun += data.text; hasTextRun = true;
      continue;
    }
    flushText();
    if (type === 'at') {
      result.push({ type: 'at', target: data.qq === 'all' ? 'all' : normalizeQQId(data.qq) });
    } else if (type === 'reply') {
      result.push({ type: 'reply', messageId: protectedMessageId(data.id, options) });
    } else {
      // Quoted bodies are not traversed/fetched; names, card JSON, URLs and files
      // are discarded. Unknown type strings cannot smuggle credentials into metadata.
      const kind = METADATA_TYPES.has(type) ? type : 'unknown';
      result.push({ type: 'metadata', kind, placeholder: `[${kind}]` });
    }
  }
  flushText();
  return result;
}

/** Arrays are already protocol-decoded; CQ escaping is NOT decoded again in array text. */
export function normalizeSegments(message: unknown, options: SegmentOptions = {}): NormalizedSegment[] {
  const limits = inboundLimits(options.limits);
  if (typeof message === 'string') {
    if (Buffer.byteLength(message, 'utf8') > limits.maxEventBytes) fail('EVENT_TOO_LARGE', 'The message exceeds its byte limit.');
    return normalizeWireSegments(cqWireSegments(message, limits.maxSegments), options, limits);
  }
  if (!Array.isArray(message)) fail('INVALID_SEGMENT', 'The message must be a CQ string or segment array.');
  if (serializedBytes(message) > limits.maxEventBytes) fail('EVENT_TOO_LARGE', 'The message exceeds its byte limit.');
  return normalizeWireSegments(message, options, limits);
}
export function parseCQMessage(message: string, options: SegmentOptions = {}): NormalizedSegment[] {
  if (typeof message !== 'string') fail('INVALID_CQ', 'A CQ message must be text.');
  return normalizeSegments(message, options);
}

function projectedSegments(segments: readonly NormalizedSegment[]): Record<string, unknown>[] {
  return segments.map((segment) => {
    if (segment.type === 'text') return { type: 'text', data: { text: segment.text } };
    if (segment.type === 'at') return { type: 'at', data: { qq: segment.target } };
    if (segment.type === 'reply') return { type: 'reply', data: { id: segment.messageId } };
    return { type: segment.kind, data: { placeholder: segment.placeholder } };
  });
}

/** JSON tuple encoding prevents delimiter collisions in opaque message IDs. Deduplication is external. */
export function messageIdempotencyKey(botId: QQId, type: 'group' | 'private', conversationId: QQId, messageId: string): string {
  if (type !== 'group' && type !== 'private') fail('INVALID_MESSAGE_TYPE', 'Conversation type must be group or private.');
  return JSON.stringify([normalizeQQId(botId), type, normalizeQQId(conversationId), protectedMessageId(messageId, {})]);
}

/**
 * Strict event normalization. Returns null for non-message, group system-notice or own-sender events.
 * Caller must apply allowlists BEFORE persisting any body; this helper does not enqueue,
 * deduplicate, authorize, timestamp receipt or retain raw authentication/network data.
 */
export function normalizeMessageEvent(input: unknown, options: NormalizeOptions): NormalizedMessage | null {
  const botId = normalizeQQId(options.expectedSelfId);
  const limits = inboundLimits(options.limits);
  let event: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > limits.maxEventBytes) fail('EVENT_TOO_LARGE', 'The event exceeds its byte limit.');
    try { event = JSON.parse(input) as unknown; }
    catch { fail('INVALID_EVENT', 'The event must contain valid JSON.'); }
  } else if (serializedBytes(input) > limits.maxEventBytes) {
    fail('EVENT_TOO_LARGE', 'The event exceeds its byte limit.');
  }
  if (!isRecord(event) || typeof event.post_type !== 'string') fail('INVALID_EVENT', 'The event must have a post type.');
  if (normalizeQQId(event.self_id) !== botId) fail('BOT_ID_MISMATCH', 'The event does not belong to the verified bot.');
  if (event.post_type !== 'message') return null;
  if (event.message_type !== 'group' && event.message_type !== 'private') fail('INVALID_MESSAGE_TYPE', 'Only group and private messages are supported.');
  const conversationType = event.message_type;
  if (conversationType === 'group' && event.sub_type === 'notice') return null;
  const anonymous = event.anonymous !== null && event.anonymous !== undefined;
  if (event.sub_type === 'anonymous' && !anonymous) fail('INVALID_EVENT', 'Anonymous messages require a stable local identity.');
  if (anonymous && conversationType !== 'group') fail('INVALID_EVENT', 'Anonymous messages must belong to a group.');
  let author: MessageAuthor;
  let anonymousId: string | undefined;
  // Anonymous gateway user_id is a pseudonym/sentinel, not an authenticated QQ identity (even if it equals self_id).
  const userId = anonymous ? undefined : normalizeQQId(event.user_id);
  if (userId === botId) return null;
  const conversationId = conversationType === 'group' ? normalizeQQId(event.group_id) : userId!;
  if (anonymous) {
    if (!isRecord(event.anonymous)) fail('INVALID_EVENT', 'Anonymous identity must be structured.');
    anonymousId = protectedMessageId(event.anonymous.id, options);
    author = { kind: 'anonymous', localId: JSON.stringify([botId, 'group', conversationId, anonymousId]) };
  } else {
    author = { kind: 'qq', qqId: userId! };
  }
  const messageId = protectedMessageId(event.message_id, options);
  // Time is v11 UNIX seconds, not milliseconds. Bound conversion to JS Date's range.
  if (typeof event.time !== 'number' || !Number.isSafeInteger(event.time) || event.time < 0 || event.time > 8_640_000_000_000) {
    fail('INVALID_TIME', 'The event requires an integer UNIX timestamp in seconds.');
  }
  const segments = normalizeSegments(event.message, { ...options, limits });
  const text = segments.map((segment) => {
    if (segment.type === 'text') return segment.text;
    if (segment.type === 'at') return segment.target === 'all' ? '[at:all]' : `[at:${segment.target}]`;
    if (segment.type === 'reply') return '[reply]';
    return segment.placeholder;
  }).join('');
  if (Buffer.byteLength(text, 'utf8') > limits.maxTextBytes) fail('TEXT_TOO_LARGE', 'The normalized message text exceeds its byte limit.');
  const sanitizedEvent: SanitizedEvent = {
    post_type: 'message', self_id: botId, message_type: conversationType,
    message_id: messageId, time: event.time,
    ...(conversationType === 'group' ? { group_id: conversationId } : {}),
    ...(anonymousId !== undefined ? { anonymous: { id: anonymousId } } : { user_id: userId! }),
    message: projectedSegments(segments),
  };
  return {
    botId, conversationType, conversationId, messageId,
    eventTimeSeconds: event.time, eventTimeMs: event.time * 1000, author, segments, text,
    idempotencyKey: messageIdempotencyKey(botId, conversationType, conversationId, messageId),
    sanitizedEvent,
  };
}

export interface TriggerOptions {
  botId: string | number;
  name: string;
  aliases?: readonly string[];
  /** Names/aliases shorter than this are configuration errors, not universal triggers. Default 2. */
  minAliasCodePoints?: number;
}
/** Deterministic case-sensitive inclusion in contiguous direct text, or an exact bot at. */
export function matchesTrigger(message: Pick<NormalizedMessage, 'botId' | 'segments'>, options: TriggerOptions): boolean {
  const botId = normalizeQQId(options.botId);
  if (message.botId !== botId) fail('BOT_ID_MISMATCH', 'Trigger identity does not match the verified bot.');
  const minimum = positiveLimit(options.minAliasCodePoints ?? 2);
  const names = [options.name, ...(options.aliases ?? [])];
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() !== name || /[\r\n\t]/.test(name) || [...name].length < minimum) {
      fail('INVALID_TRIGGER', 'Trigger names must be nonempty, bounded by the minimum length and unpadded.');
    }
    assertUnicode(name);
  }
  let run = '';
  for (const segment of message.segments) {
    if (segment.type === 'text') {
      run += segment.text;
      if (names.some((name) => run.includes(name))) return true;
    } else {
      run = '';
      if (segment.type === 'at' && segment.target === botId) return true;
    }
  }
  return false;
}

export interface OutgoingLimits {
  maxCodePointsPerSegment: number;
  /** UTF-8 bytes of the unescaped text. */
  maxUtf8BytesPerSegment: number;
  /** UTF-8 bytes of JSON.stringify([segment]); action/echo envelope is excluded. */
  maxPayloadBytesPerSegment: number;
  maxSegments: number;
}
export const DEFAULT_OUTGOING_LIMITS: Readonly<OutgoingLimits> = Object.freeze({
  maxCodePointsPerSegment: 1500,
  maxUtf8BytesPerSegment: 6000,
  maxPayloadBytesPerSegment: 8192,
  maxSegments: 8,
});

/**
 * Return complete fixed pure-text chunks. Wrap each chunk in its own message array.
 * CQ-looking model output is never parsed. Overflow rejects the whole answer; no truncation.
 * Gateway action/echo overhead must be budgeted separately by the transport adapter.
 */
export function splitOutgoingText(text: string, overrides?: Partial<OutgoingLimits>): OneBotTextSegment[] {
  if (typeof text !== 'string' || text.trim().length === 0) fail('INVALID_TEXT', 'Outgoing text must not be empty.');
  assertUnicode(text);
  const limits = { ...DEFAULT_OUTGOING_LIMITS, ...overrides };
  positiveLimit(limits.maxCodePointsPerSegment);
  positiveLimit(limits.maxUtf8BytesPerSegment);
  positiveLimit(limits.maxPayloadBytesPerSegment);
  positiveLimit(limits.maxSegments);
  const overhead = Buffer.byteLength(JSON.stringify([{ type: 'text', data: { text: '' } }]), 'utf8');
  const result: OneBotTextSegment[] = [];
  let chunk = '';
  let points = 0;
  let bytes = 0;
  let payloadBytes = overhead;
  const finish = (): void => {
    if (result.length >= limits.maxSegments) fail('OUTGOING_OVERFLOW', 'The complete reply exceeds its segment budget.');
    result.push({ type: 'text', data: { text: chunk } });
    chunk = ''; points = 0; bytes = 0; payloadBytes = overhead;
  };
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point, 'utf8');
    const escapedBytes = Buffer.byteLength(JSON.stringify(point), 'utf8') - 2;
    if (pointBytes > limits.maxUtf8BytesPerSegment || overhead + escapedBytes > limits.maxPayloadBytesPerSegment) {
      fail('OUTGOING_OVERFLOW', 'A Unicode point cannot fit the outgoing byte budget.');
    }
    if (points >= limits.maxCodePointsPerSegment || bytes + pointBytes > limits.maxUtf8BytesPerSegment || payloadBytes + escapedBytes > limits.maxPayloadBytesPerSegment) {
      finish();
    }
    chunk += point; points++; bytes += pointBytes; payloadBytes += escapedBytes;
  }
  if (chunk) finish();
  return result;
}
