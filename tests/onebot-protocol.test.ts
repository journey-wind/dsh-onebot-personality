import * as assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  DEFAULT_INBOUND_LIMITS,
  DEFAULT_OUTGOING_LIMITS,
  ProtocolError,
  decodeCQText,
  matchesTrigger,
  messageIdempotencyKey,
  normalizeMessageEvent,
  normalizeMessageId,
  normalizeQQId,
  normalizeSegments,
  parseCQMessage,
  sanitizeSecrets,
  splitOutgoingText,
  type NormalizeOptions,
  type NormalizedMessage,
  type ProtocolErrorCode,
} from '../src/onebot/protocol.js';

const BOT = '10001';
const USER = '20002';
const GROUP = '30003';
const persona = { botId: BOT, name: '小月', aliases: ['Moonlight'] };
const textSegment = (text: string) => ({ type: 'text', data: { text } });
function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: 'message', self_id: BOT, message_type: 'group', sub_type: 'normal',
    group_id: GROUP, user_id: USER, message_id: -123, time: 1_800_000_000,
    message: [textSegment('hello')], anonymous: null, ...overrides,
  };
}
function normalized(event: unknown, options: Partial<NormalizeOptions> = {}): NormalizedMessage {
  const result = normalizeMessageEvent(event, { expectedSelfId: BOT, ...options });
  assert.ok(result);
  return result;
}
function expectCode(action: () => unknown, code: ProtocolErrorCode): void {
  assert.throws(action, (error: unknown) => error instanceof ProtocolError && error.code === code);
}

test('QQ IDs retain arbitrary decimal precision and canonicalize safe representations', () => {
  assert.equal(normalizeQQId('90071992547409931234567890'), '90071992547409931234567890');
  assert.equal(normalizeQQId('00010001'), BOT);
  assert.equal(normalizeQQId(10001), BOT);
  assert.equal(normalizeQQId(Number.MAX_SAFE_INTEGER), '9007199254740991');
  for (const value of ['', '0', '000', '-1', '+1', '1.2', '1e3', ' 12', '12 ', '１２', null, undefined, true, {}, 0, -1]) {
    expectCode(() => normalizeQQId(value), 'INVALID_ID');
  }
  for (const value of [Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, 1.5]) {
    expectCode(() => normalizeQQId(value), 'UNSAFE_ID_NUMBER');
  }
});

test('message IDs require stable values, support signed v11 integers and bounded opaque gateway IDs', () => {
  assert.equal(normalizeMessageId(-123), '-123');
  assert.equal(normalizeMessageId('-000123'), '-123');
  assert.equal(normalizeMessageId('-000'), '0');
  assert.equal(normalizeMessageId(0), '0');
  assert.equal(normalizeMessageId('900719925474099312345'), '900719925474099312345');
  assert.equal(normalizeMessageId('gateway:abc-123_0.x'), 'gateway:abc-123_0.x');
  for (const value of [null, undefined, '']) expectCode(() => normalizeMessageId(value), 'MISSING_MESSAGE_ID');
  for (const value of ['with spaces', 'x\ny', 'x'.repeat(129), {}, true]) expectCode(() => normalizeMessageId(value), 'INVALID_MESSAGE_ID');
  expectCode(() => normalizeMessageId(2 ** 53), 'UNSAFE_ID_NUMBER');
});

test('CQ decoding performs one escaping layer, with comma decoding only in parameters', () => {
  assert.equal(decodeCQText('&amp;#91;&#91;x&#93;&#44;'), '&#91;[x]&#44;');
  assert.equal(decodeCQText('&amp;#91;&#91;x&#93;&#44;', true), '&#91;[x],');
  const segments = parseCQMessage('&#91;CQ:at,qq=10001&#93; &amp;#91;CQ:at,qq=10001&amp;#93;');
  assert.deepEqual(segments, [{ type: 'text', text: '[CQ:at,qq=10001] &#91;CQ:at,qq=10001&#93;' }]);
  assert.equal(matchesTrigger({ botId: BOT, segments }, persona), false);
});

test('CQ text, at, reply and nontext metadata are distinctly normalized', () => {
  assert.deepEqual(parseCQMessage('hi&amp;[CQ:at,qq=00010001][CQ:reply,id=-0012][CQ:image,file=小月.png]'), [
    { type: 'text', text: 'hi&' },
    { type: 'at', target: BOT },
    { type: 'reply', messageId: '-12' },
    { type: 'metadata', kind: 'image', placeholder: '[image]' },
  ]);
  assert.deepEqual(parseCQMessage('[CQ:text,text=a&#44;b&amp;#91;]'), [{ type: 'text', text: 'a,b&#91;' }]);
});

test('array text is already decoded and CQ-looking array text stays plain text', () => {
  const value = '&amp; &#91;CQ:at,qq=10001&#93; [CQ:at,qq=10001]';
  const result = normalizeSegments([textSegment(value)]);
  assert.deepEqual(result, [{ type: 'text', text: value }]);
  assert.equal(matchesTrigger({ botId: BOT, segments: result }, persona), false);
});

test('CQ parsing rejects ambiguous duplicate/broken parameters and invalid at/reply data', () => {
  expectCode(() => parseCQMessage('[CQ:at,qq=10001,qq=20002]'), 'INVALID_CQ');
  expectCode(() => parseCQMessage('[CQ:at,qq]'), 'INVALID_CQ');
  expectCode(() => parseCQMessage('[CQ:at,qq=10001,]'), 'INVALID_CQ');
  expectCode(() => parseCQMessage('[CQ:at,qq=not-a-qq]'), 'INVALID_ID');
  expectCode(() => parseCQMessage('[CQ:reply]'), 'MISSING_MESSAGE_ID');
  expectCode(() => parseCQMessage('[CQ:node,content=[CQ:at,qq=10001]]'), 'INVALID_CQ');
  const quoted = parseCQMessage('[CQ:node,content=&#91;CQ:at&#44;qq=10001&#93;小月]');
  assert.equal(matchesTrigger({ botId: BOT, segments: quoted }, persona), false);
  // Unclosed syntax is literal text, not executable CQ.
  assert.deepEqual(parseCQMessage('[CQ:at,qq=10001'), [{ type: 'text', text: '[CQ:at,qq=10001' }]);
});

test('reply IDs are validated even when the quoted body is ignored', () => {
  expectCode(() => normalized(groupEvent({
    sender: { nickname: '小月' },
    message: [{ type: 'reply', data: { id: '小月', text: '小月', content: [textSegment('小月')] } }],
  })), 'INVALID_MESSAGE_ID');
});

test('metadata placeholders discard quote bodies, filenames, URLs and sender nicknames', () => {
  const event = groupEvent({
    sender: { nickname: '小月', card: 'Moonlight' },
    message: [
      { type: 'reply', data: { id: '-5', text: '小月' } },
      { type: 'forward', data: { id: '小月', content: [textSegment('小月')] } },
      { type: 'node', data: { name: '小月', content: [{ type: 'at', data: { qq: BOT } }] } },
      { type: 'quote', data: { content: '小月' } },
      { type: 'image', data: { file: '小月.png', url: 'https://invalid.example/小月' } },
      { type: 'json', data: { data: '{"name":"小月"}' } },
      { type: 'xml', data: { data: '<小月/>' } },
    ],
  });
  const message = normalized(event);
  assert.equal(matchesTrigger(message, persona), false);
  const persisted = JSON.stringify(message);
  assert.equal(persisted.includes('小月'), false);
  assert.equal(persisted.includes('invalid.example'), false);
  assert.equal(persisted.includes('Moonlight'), false);
  assert.equal(message.text, '[reply][forward][node][quote][image][json][xml]');
});

test('unknown segment types cannot persist secret-bearing type strings or data', () => {
  const segments = normalizeSegments([{ type: 'sk-abcdefghijklmnop', data: { text: 'hidden' } }]);
  assert.deepEqual(segments, [{ type: 'metadata', kind: 'unknown', placeholder: '[unknown]' }]);
});

test('events require bot identity, message type, stable message ID, author, time and segments', () => {
  const cases: [Record<string, unknown>, ProtocolErrorCode][] = [
    [{ self_id: '10002' }, 'BOT_ID_MISMATCH'],
    [{ self_id: undefined }, 'INVALID_ID'],
    [{ message_type: 'guild' }, 'INVALID_MESSAGE_TYPE'],
    [{ message_id: undefined }, 'MISSING_MESSAGE_ID'],
    [{ message_id: 2 ** 53 }, 'UNSAFE_ID_NUMBER'],
    [{ user_id: undefined }, 'INVALID_ID'],
    [{ group_id: undefined }, 'INVALID_ID'],
    [{ time: undefined }, 'INVALID_TIME'],
    [{ time: '1800000000' }, 'INVALID_TIME'],
    [{ time: 1.25 }, 'INVALID_TIME'],
    [{ time: -1 }, 'INVALID_TIME'],
    [{ time: NaN }, 'INVALID_TIME'],
    [{ time: 8_640_000_000_001 }, 'INVALID_TIME'],
    [{ message: undefined }, 'INVALID_SEGMENT'],
    [{ message: [] }, 'INVALID_SEGMENT'],
    [{ message: [{ type: 'text', data: { text: 1 } }] }, 'INVALID_SEGMENT'],
    [{ message: [{ type: 'at', data: { qq: 'all ' } }] }, 'INVALID_ID'],
    [{ message: [{ type: 'image', data: null }] }, 'INVALID_SEGMENT'],
  ];
  for (const [override, code] of cases) expectCode(() => normalized(groupEvent(override)), code);
});

test('message normalization preserves canonical conversation identity and event time', () => {
  const message = normalized(groupEvent({ self_id: 10001, group_id: '00030003', user_id: '90071992547409930000' }));
  assert.equal(message.botId, BOT);
  assert.equal(message.conversationType, 'group');
  assert.equal(message.conversationId, GROUP);
  assert.equal(message.messageId, '-123');
  assert.deepEqual(message.author, { kind: 'qq', qqId: '90071992547409930000' });
  assert.equal(message.eventTimeSeconds, 1_800_000_000);
  assert.equal(message.eventTimeMs, 1_800_000_000_000);
  assert.equal(message.text, 'hello');
  assert.equal(message.idempotencyKey, JSON.stringify([BOT, 'group', GROUP, '-123']));
});

test('private conversations are keyed to the author, not an incidental group ID', () => {
  const message = normalized(groupEvent({ message_type: 'private', group_id: '99999' }));
  assert.equal(message.conversationType, 'private');
  assert.equal(message.conversationId, USER);
  assert.equal('group_id' in message.sanitizedEvent, false);
  assert.equal(message.sanitizedEvent.user_id, USER);
});

test('self messages and nonmessages are ignored, without treating notices as conversation', () => {
  assert.equal(normalizeMessageEvent(groupEvent({ user_id: BOT }), { expectedSelfId: BOT }), null);
  assert.equal(normalizeMessageEvent(groupEvent({ sub_type: 'notice' }), { expectedSelfId: BOT }), null);
  for (const post_type of ['notice', 'request', 'meta_event', 'message_sent']) {
    assert.equal(normalizeMessageEvent({ post_type, self_id: BOT }, { expectedSelfId: BOT }), null);
  }
  expectCode(() => normalizeMessageEvent({ post_type: 'meta_event', self_id: '99999' }, { expectedSelfId: BOT }), 'BOT_ID_MISMATCH');
});

test('anonymous group identities are local and never guessed as a certain QQ user', () => {
  const first = normalized(groupEvent({ user_id: 80000000, anonymous: { id: 42, name: '小月', flag: 'secret-flag' } }));
  const second = normalized(groupEvent({ user_id: 80000000, group_id: '30004', anonymous: { id: 42, name: '小月' } }));
  assert.equal(first.author.kind, 'anonymous');
  assert.notDeepEqual(first.author, second.author);
  assert.equal('user_id' in first.sanitizedEvent, false);
  assert.equal(JSON.stringify(first).includes('secret-flag'), false);
  // Do not search the entire serialized event: its UNIX timestamp legitimately contains this digit sequence.
  assert.equal(JSON.stringify(first.author).includes('80000000'), false);
  assert.equal('qqId' in first.author, false);
  assert.equal(normalized(groupEvent({ user_id: BOT, anonymous: { id: 43 } })).author.kind, 'anonymous');
  assert.equal(normalized(groupEvent({ user_id: 'not-a-qq-identity', anonymous: { id: 44 } })).author.kind, 'anonymous');
  expectCode(() => normalized(groupEvent({ anonymous: {} })), 'MISSING_MESSAGE_ID');
  expectCode(() => normalized(groupEvent({ sub_type: 'anonymous', anonymous: null })), 'INVALID_EVENT');
  expectCode(() => normalized(groupEvent({ message_type: 'private', anonymous: { id: 42 } })), 'INVALID_EVENT');
});

test('JSON strings are bounded before parsing and malformed/nonobject events are rejected safely', () => {
  const raw = JSON.stringify(groupEvent());
  const bytes = Buffer.byteLength(raw, 'utf8');
  assert.equal(normalized(raw, { limits: { maxEventBytes: bytes } }).text, 'hello');
  expectCode(() => normalized(raw, { limits: { maxEventBytes: bytes - 1 } }), 'EVENT_TOO_LARGE');
  for (const value of ['not-json-auth-secret', 'null', '[]', '{}', undefined]) {
    expectCode(() => normalizeMessageEvent(value, { expectedSelfId: BOT }), 'INVALID_EVENT');
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expectCode(() => normalizeMessageEvent(cyclic, { expectedSelfId: BOT }), 'INVALID_EVENT');
  const unsafeNumericId = raw.replace('"self_id":"10001"', '"self_id":9007199254740993');
  expectCode(() => normalized(unsafeNumericId), 'UNSAFE_ID_NUMBER');
});

test('idempotency keys isolate bots, conversation kinds and IDs, never depend on body text', () => {
  const base = normalized(groupEvent());
  const repeat = normalized(groupEvent({ message_id: '-00123' }));
  const conflict = normalized(groupEvent({ message: [textSegment('different body')] }));
  assert.equal(base.idempotencyKey, repeat.idempotencyKey);
  assert.equal(base.idempotencyKey, conflict.idempotencyKey);
  assert.notEqual(base.text, conflict.text); // The persistent inbox must reject this conflict.
  assert.notEqual(base.idempotencyKey, messageIdempotencyKey('10002', 'group', GROUP, '-123'));
  assert.notEqual(base.idempotencyKey, messageIdempotencyKey(BOT, 'private', GROUP, '-123'));
  assert.notEqual(base.idempotencyKey, messageIdempotencyKey(BOT, 'group', '30004', '-123'));
  assert.notEqual(messageIdempotencyKey(BOT, 'group', GROUP, 'a:b'), messageIdempotencyKey(BOT, 'group', GROUP, 'a'));
});

test('inbound limits count UTF-8 bytes and wire segments before any coalescing or masking', () => {
  assert.equal(normalized(groupEvent({ message: [textSegment('界🙂')] }), { limits: { maxTextBytes: 7 } }).text, '界🙂');
  expectCode(() => normalized(groupEvent({ message: [textSegment('界🙂')] }), { limits: { maxTextBytes: 6 } }), 'TEXT_TOO_LARGE');
  expectCode(() => normalizeSegments([textSegment('a'), textSegment('b'), textSegment('c')], { limits: { maxSegments: 2 } }), 'TOO_MANY_SEGMENTS');
  expectCode(() => parseCQMessage('a[CQ:at,qq=10001]b', { limits: { maxSegments: 2 } }), 'TOO_MANY_SEGMENTS');
  expectCode(() => normalizeSegments([textSegment('token=very-long-credential')], { limits: { maxTextBytes: 5 } }), 'TEXT_TOO_LARGE');
  expectCode(() => normalizeSegments([textSegment('token=x')], { limits: { maxTextBytes: 7 } }), 'TEXT_TOO_LARGE');
  expectCode(() => normalized(groupEvent({ message: [{ type: 'image', data: {} }] }), { limits: { maxTextBytes: 3 } }), 'TEXT_TOO_LARGE');
  expectCode(() => normalizeSegments([{ type: 'image', data: { ignored: 'x'.repeat(200) } }], { limits: { maxEventBytes: 100 } }), 'EVENT_TOO_LARGE');
});

test('invalid limits and invalid Unicode fail with explicit codes', () => {
  for (const maxSegments of [0, -1, NaN, 1.5, Infinity]) {
    expectCode(() => normalizeSegments([textSegment('a')], { limits: { maxSegments } }), 'INVALID_LIMIT');
  }
  expectCode(() => normalizeSegments([textSegment('\ud800')]), 'INVALID_TEXT');
  expectCode(() => splitOutgoingText('\udfff'), 'INVALID_TEXT');
  expectCode(() => splitOutgoingText('a', { maxSegments: 0 }), 'INVALID_LIMIT');
  expectCode(() => splitOutgoingText('a', { maxUtf8BytesPerSegment: Infinity }), 'INVALID_LIMIT');
});

test('only the current verified bot at triggers; at all and other bots do not', () => {
  for (const [target, expected] of [[BOT, true], ['99999', false], ['all', false]] as const) {
    const message = normalized(groupEvent({ message: [{ type: 'at', data: { qq: target } }] }));
    assert.equal(matchesTrigger(message, persona), expected);
  }
  expectCode(() => matchesTrigger(normalized(groupEvent()), { ...persona, botId: '99999' }), 'BOT_ID_MISMATCH');
});

test('names and aliases match deterministic direct text only; metadata cannot bridge text runs', () => {
  assert.equal(matchesTrigger(normalized(groupEvent({ message: [textSegment('你好小月呀')] })), persona), true);
  assert.equal(matchesTrigger(normalized(groupEvent({ message: [textSegment('hi Moonlight!')] })), persona), true);
  assert.equal(matchesTrigger(normalized(groupEvent({ message: [textSegment('hi moonlight!')] })), persona), false);
  assert.equal(matchesTrigger(normalized(groupEvent({ message: [textSegment('小'), textSegment('月')] })), persona), true);
  assert.equal(matchesTrigger(normalized(groupEvent({ message: [textSegment('小'), { type: 'image', data: {} }, textSegment('月')] })), persona), false);
  // Hand-copied quotations are ordinary direct text; no semantic quotation detector is claimed.
  assert.equal(matchesTrigger(normalized(groupEvent({ message: [textSegment('引用：“小月你好”')] })), persona), true);
});

test('empty, one-point, whitespace-padded and multiline trigger names are configuration errors', () => {
  const message = normalized(groupEvent({ message: [{ type: 'at', data: { qq: BOT } }] }));
  for (const alias of ['', '月', '🙂', ' 小月', '小月 ', '小\n月', '小\t月']) {
    expectCode(() => matchesTrigger(message, { ...persona, aliases: [alias] }), 'INVALID_TRIGGER');
  }
  expectCode(() => matchesTrigger(message, { ...persona, name: '' }), 'INVALID_TRIGGER');
  assert.equal(matchesTrigger(message, { botId: BOT, name: '🙂🙂' }), true);
});

test('known secret masking covers configured literals, auth, keys, JWTs, credential URLs and assignments', () => {
  const secrets = ['exact-secret', 'abc', 'abcdef'];
  const raw = 'exact-secret abcdef Bearer bearer-value Basic YWxhZGRpbjpvcGVuc2VzYW1l sk-abcdefghijklmnop '
    + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature '
    + 'wss://user:pass@invalid.example/?access_token=query-secret '
    + 'password="spaces in secret" {"api_key":"json-secret"} token=plain-secret';
  const safe = sanitizeSecrets(raw, secrets);
  for (const secret of ['exact-secret', 'abcdef', 'bearer-value', 'YWxhZGRpbjpvcGVuc2VzYW1l', 'sk-abcdefghijklmnop', 'signature', 'user:pass', 'query-secret', 'spaces in secret', 'json-secret', 'plain-secret']) {
    assert.equal(safe.includes(secret), false, secret);
  }
  assert.equal(sanitizeSecrets(safe, secrets), safe);
  assert.equal(sanitizeSecrets('A completely ordinary sentence.'), 'A completely ordinary sentence.');
});

test('normalization discards auth-bearing raw fields and masks all retained direct text', () => {
  const secret = 'host-model-credential';
  const event = groupEvent({
    authorization: `Bearer ${secret}`,
    headers: { authorization: `Bearer ${secret}` },
    raw_message: secret,
    sender: { nickname: secret },
    message: [textSegment(`小月 ${secret} token=onebot-value`), { type: 'image', data: { url: `https://invalid.example/?token=${secret}` } }],
  });
  const message = normalized(event, { knownSecrets: [secret] });
  const persisted = JSON.stringify(message);
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('onebot-value'), false);
  assert.equal(persisted.includes('authorization'), false);
  assert.equal(persisted.includes('headers'), false);
  assert.equal(message.text.includes('小月'), true);
  assert.equal(matchesTrigger(message, persona), true);
});

test('credential-bearing stable IDs are rejected rather than persisted or silently changed', () => {
  expectCode(() => normalized(groupEvent({ message_id: 'configured-credential' }), { knownSecrets: ['configured-credential'] }), 'INVALID_MESSAGE_ID');
  expectCode(() => normalizeSegments([{ type: 'reply', data: { id: 'sk-abcdefghijklmnop' } }]), 'INVALID_MESSAGE_ID');
  expectCode(() => messageIdempotencyKey(BOT, 'group', GROUP, 'sk-abcdefghijklmnop'), 'INVALID_MESSAGE_ID');
});

test('adjacent text segment boundaries cannot evade exact-secret or assignment masking', () => {
  const result = normalizeSegments([
    textSegment('top-'), textSegment('secret'), textSegment(' token='), textSegment('sensitive-value'),
  ], { knownSecrets: ['top-secret'] });
  assert.equal(result.length, 1);
  const retained = JSON.stringify(result);
  assert.equal(retained.includes('top-secret'), false);
  assert.equal(retained.includes('sensitive-value'), false);
});

test('custom sanitizer receives masked text and its output is validated and masked again', () => {
  let received = '';
  const message = normalized(groupEvent({ message: [textSegment('credential-value email@example.test')] }), {
    knownSecrets: ['credential-value'],
    sanitizeText: (text) => { received = text; return text.replace('email@example.test', '[EMAIL]') + ' token=introduced-value'; },
  });
  assert.equal(received.includes('credential-value'), false);
  assert.equal(message.text.includes('email@example.test'), false);
  assert.equal(message.text.includes('introduced-value'), false);
  expectCode(() => normalized(groupEvent(), { sanitizeText: () => { throw new Error('raw-auth-must-not-leak'); } }), 'SANITIZER_FAILED');
  expectCode(() => normalized(groupEvent(), { sanitizeText: () => 'x'.repeat(100), limits: { maxTextBytes: 50 } }), 'TEXT_TOO_LARGE');
  expectCode(() => normalized(groupEvent(), { sanitizeText: () => '\ud800' }), 'INVALID_TEXT');
});

test('ProtocolError messages do not echo rejected input or callback errors', () => {
  for (const action of [
    () => normalizeMessageEvent('Bearer never-echo-this-value', { expectedSelfId: BOT }),
    () => normalizeQQId('Bearer never-echo-this-value'),
    () => normalized(groupEvent(), { sanitizeText: () => { throw new Error('Bearer never-echo-this-value'); } }),
  ]) {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.message.includes('never-echo-this-value'), false);
      return true;
    });
  }
});

test('outgoing model-generated CQ code is sent as one fixed text segment, never parsed', () => {
  const text = '[CQ:at,qq=all] [CQ:image,file=file:///secret]';
  assert.deepEqual(splitOutgoingText(text), [{ type: 'text', data: { text } }]);
});

test('outgoing splits by Unicode points without splitting surrogate pairs and preserves all text', () => {
  const text = 'A🙂B🙂';
  const chunks = splitOutgoingText(text, { maxCodePointsPerSegment: 2, maxUtf8BytesPerSegment: 5 });
  assert.deepEqual(chunks.map((chunk) => chunk.data.text), ['A🙂', 'B🙂']);
  assert.equal(chunks.map((chunk) => chunk.data.text).join(''), text);
  for (const chunk of splitOutgoingText('🙂🙂', { maxCodePointsPerSegment: 1 })) {
    assert.equal([...chunk.data.text].length, 1);
    assert.equal(chunk.data.text.length, 2);
  }
  assert.deepEqual(splitOutgoingText('界界a', { maxUtf8BytesPerSegment: 4 }).map((chunk) => chunk.data.text), ['界', '界a']);
});

test('outgoing byte budgets include escaped JSON payload, not just raw UTF-8 text', () => {
  const overhead = Buffer.byteLength(JSON.stringify([textSegment('')]), 'utf8');
  const text = '\n"\\';
  const chunks = splitOutgoingText(text, { maxPayloadBytesPerSegment: overhead + 2, maxSegments: 3 });
  assert.deepEqual(chunks.map((chunk) => chunk.data.text), ['\n', '"', '\\']);
  assert.equal(chunks.map((chunk) => chunk.data.text).join(''), text);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(JSON.stringify([chunk]), 'utf8') <= overhead + 2);
  expectCode(() => splitOutgoingText('a', { maxPayloadBytesPerSegment: overhead }), 'OUTGOING_OVERFLOW');
  expectCode(() => splitOutgoingText('🙂', { maxUtf8BytesPerSegment: 3 }), 'OUTGOING_OVERFLOW');
});

test('outgoing segment overflow rejects the whole answer, never returns a truncated prefix', () => {
  assert.deepEqual(splitOutgoingText('abcd', { maxCodePointsPerSegment: 2, maxSegments: 2 }).map((chunk) => chunk.data.text), ['ab', 'cd']);
  expectCode(() => splitOutgoingText('abcde', { maxCodePointsPerSegment: 2, maxSegments: 2 }), 'OUTGOING_OVERFLOW');
  expectCode(() => splitOutgoingText('x'.repeat(1500 * 8 + 1)), 'OUTGOING_OVERFLOW');
  for (const empty of ['', ' \r\n\t']) expectCode(() => splitOutgoingText(empty), 'INVALID_TEXT');
});

test('deterministic mixed-Unicode/JSON-escaping matrix preserves content under every budget', () => {
  const source = '小月🙂e\u0301\n"\\[CQ:at,qq=all] ';
  const overhead = Buffer.byteLength(JSON.stringify([textSegment('')]), 'utf8');
  for (let repeat = 1; repeat <= 32; repeat++) {
    const text = source.repeat(repeat);
    const chunks = splitOutgoingText(text, {
      maxCodePointsPerSegment: 7, maxUtf8BytesPerSegment: 17,
      maxPayloadBytesPerSegment: overhead + 20, maxSegments: 1000,
    });
    assert.equal(chunks.map((chunk) => chunk.data.text).join(''), text);
    for (const chunk of chunks) {
      assert.equal(chunk.type, 'text');
      assert.deepEqual(Object.keys(chunk.data), ['text']);
      assert.ok([...chunk.data.text].length <= 7);
      assert.ok(Buffer.byteLength(chunk.data.text, 'utf8') <= 17);
      assert.ok(Buffer.byteLength(JSON.stringify([chunk]), 'utf8') <= overhead + 20);
    }
  }
});

test('helpers do not mutate input events or exported frozen default budgets', () => {
  const data = Object.freeze({ text: '小月' });
  const segment = Object.freeze({ type: 'text', data });
  const message = Object.freeze([segment]);
  const event = Object.freeze(groupEvent({ message }));
  assert.equal(normalized(event).text, '小月');
  splitOutgoingText('hello', { maxSegments: 1 });
  assert.equal(DEFAULT_INBOUND_LIMITS.maxSegments, 256);
  assert.equal(DEFAULT_OUTGOING_LIMITS.maxSegments, 8);
  assert.equal(Object.isFrozen(DEFAULT_INBOUND_LIMITS), true);
  assert.equal(Object.isFrozen(DEFAULT_OUTGOING_LIMITS), true);
  assert.equal(event.message, message);
});
