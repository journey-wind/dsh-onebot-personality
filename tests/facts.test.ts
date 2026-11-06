import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceQQIds, renderFact, validateFacts } from '../src/memory/facts.js';
import type { FactEvidence } from '../src/memory/facts.js';
import type { ExtractedFact } from '../src/storage/model.js';
import { runtimeFixture } from './helpers/runtime.js';
import { fingerprint } from '../src/llm/routes.js';

const evidence: FactEvidence = { text: '我喜欢茶，昨天和小林喝茶，生日是1960-01-02。',
  entityScope: 'bank-100-persona/source-300/epoch-1/message-1', qqIds: ['200', '300'], timeZone: 'Asia/Shanghai',
  eventTimeMs: Date.parse('2026-11-04T01:00:00Z') };
function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return { content: '用户报告喜欢茶', quote: '我喜欢茶', confidence: 'reported', inferred: false,
    eventTime: { expression: '', precision: 'unknown', ambiguous: true }, entities: [], relations: [], ...overrides };
}
const parse = (value: unknown, context = evidence) => validateFacts({ facts: [value] }, context);

test('strict extraction shape rejects host provenance/class and limits the number of facts', () => {
  assert.throws(() => validateFacts({ facts: [], sourceId: 'fake' }, evidence));
  assert.throws(() => parse({ ...fact(), kind: 'experience' }));
  assert.throws(() => parse({ ...fact(), sourceRef: { sourceId: 'fake', sourceEpoch: 1 } }));
  assert.throws(() => validateFacts({ facts: Array.from({ length: 33 }, () => fact()) }, evidence));
  assert.throws(() => parse({ ...fact(), eventTime: { expression: '', precision: 'unknown', ambiguous: true, invented: true } }));
});

test('quotes are exact original substrings and control/bounds/inferred consistency are checked', () => {
  for (const invalid of [fact({ quote: '我讨厌茶' }), fact({ content: '\u0000secret' }), fact({ content: ' ' }),
    fact({ content: 'a'.repeat(8193) }), fact({ confidence: 'inferred', inferred: false }),
    fact({ confidence: 'reported', inferred: true }), fact({ content: '\ud800' })]) assert.throws(() => parse(invalid));
  assert.equal(parse(fact({ confidence: 'inferred', inferred: true }))[0]!.inferred, true);
});

test('single independent evidence cannot claim corroboration even with repeated facts or quotes', () => {
  const corroborated = fact({ confidence: 'corroborated' });
  assert.throws(() => parse(corroborated));
  assert.throws(() => validateFacts({ facts: [corroborated, corroborated] }, evidence));
  assert.equal(parse(fact({ confidence: 'reported' }))[0]!.confidence, 'reported');
});

test('QQ identity uses only host-author/explicit at; numeric text/nickname/JSON metadata confer no identity', async () => {
  const f = await runtimeFixture();
  await f.admit({ message: [{ type: 'at', data: { qq: '400' } }, { type: 'text', data: { text: 'QQ 999，小林' } }] });
  const message = Object.values(f.repository.read().messages)[0]!;
  assert.deepEqual(evidenceQQIds(message), ['200', '400']);
  assert.deepEqual(evidenceQQIds({ ...message, sanitizedEventJson: '{broken' }), ['200']);
  assert.deepEqual(evidenceQQIds({ ...message, sanitizedEventJson: JSON.stringify({ sender: { user_id: '999' }, message: [] }) }), ['200']);
  assert.throws(() => parse(fact({ entities: [{ key: 'x', kind: 'qq', label: '小林', qqId: '999' }] })));
  assert.throws(() => parse(fact({ entities: [{ key: 'x', kind: 'uncertain', label: '茶', qqId: '200' }] })));
});

test('host generates stable qq/uncertain keys and remaps known relation endpoints without nickname merging', () => {
  const input = fact({ quote: '昨天和小林喝茶', entities: [
    { key: 'author', kind: 'qq', label: '作者', qqId: '200' }, { key: 'nickname', kind: 'uncertain', label: '小林' },
  ], relations: [{ from: 'author', to: 'nickname', relation: '喝茶', inferred: false }] });
  const normalized = parse(input)[0]!;
  assert.ok(normalized.entities.some(entity => entity.key === 'qq:200'));
  assert.equal(normalized.entities.find(entity => entity.kind === 'qq')!.label, '200');
  const uncertain = normalized.entities.find(entity => entity.kind === 'uncertain')!;
  assert.match(uncertain.key, /^entity-[a-f0-9]{64}$/);
  assert.equal(normalized.relations[0]!.to, uncertain.key);
  assert.equal(normalized.relations[0]!.from, 'qq:200');
  assert.deepEqual(validateFacts({ facts: [normalized] }, evidence), [normalized]);
  assert.notEqual(parse(input, { ...evidence, entityScope: 'another-bank' })[0]!.entities.find(entity => entity.kind === 'uncertain')!.key, uncertain.key);
  assert.throws(() => parse(fact({ entities: [{ key: 'x', kind: 'uncertain', label: '不存在' }] })));
  assert.throws(() => parse(fact({ relations: [{ from: 'missing', to: 'also-missing', relation: '关系', inferred: false }] })));
  assert.throws(() => parse({ ...input, relations: [{ ...input.relations[0], inferred: true }] }));
});

test('uncertain keys are per-source-item/epoch and retry-stable while exact QQ IDs remain canonical', () => {
  const input = fact({ quote: '昨天和小林喝茶', entities: [
    { key: 'author', kind: 'qq', label: '作者', qqId: '200' }, { key: 'nickname', kind: 'uncertain', label: '小林' },
  ] });
  const key = (scope: string) => parse(input, { ...evidence, entityScope: scope })[0]!.entities;
  const one = key('bank/source-300/epoch-1/message-1');
  assert.deepEqual(key('bank/source-300/epoch-1/message-1'), one);
  for (const other of ['bank/source-301/epoch-1/message-1', 'bank/source-300/epoch-1/message-2', 'bank/source-300/epoch-2/message-1']) {
    const next = key(other);
    assert.notEqual(next.find(entity => entity.kind === 'uncertain')!.key, one.find(entity => entity.kind === 'uncertain')!.key);
    assert.equal(next.find(entity => entity.kind === 'qq')!.key, 'qq:200');
  }
});

test('canonical entity/relation order and checkpoint fingerprints use deterministic code-unit order', () => {
  const input = fact({ entities: [
    { key: 'q300', kind: 'qq', label: '300', qqId: '300' }, { key: 'tea', kind: 'uncertain', label: '茶' },
    { key: 'q200', kind: 'qq', label: '200', qqId: '200' },
  ], relations: [
    { from: 'q300', to: 'tea', relation: '提及', inferred: false },
    { from: 'q200', to: 'tea', relation: '喜欢', inferred: false },
  ] });
  const first = parse(input)[0]!;
  const second = parse({ ...input, entities: [...input.entities].reverse(), relations: [...input.relations].reverse() })[0]!;
  const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const keys = first.entities.map(entity => entity.key); const hashes = first.relations.map(relation => fingerprint(relation));
  assert.deepEqual(keys, [...keys].sort(order)); assert.deepEqual(hashes, [...hashes].sort(order));
  assert.deepEqual(first, second); assert.equal(fingerprint(first), fingerprint(second));
});

test('dedup runs after host normalization and readable fact text contains evidence instead of JSON', () => {
  const normalized = validateFacts({ facts: [fact(), fact()] }, evidence);
  assert.equal(normalized.length, 1);
  const text = renderFact(normalized[0]!);
  assert.match(text, /用户报告喜欢茶/); assert.match(text, /原文引文：我喜欢茶/);
  assert.equal(text.startsWith('{'), false);
});

test('dates must occur in quote; host validates ISO calendar days including pre-1970 dates', () => {
  const input = fact({ quote: '生日是1960-01-02', eventTime: { expression: '1960-01-02', precision: 'unknown', ambiguous: true } });
  const time = parse(input)[0]!.eventTime;
  assert.equal(time.start, Date.parse('1960-01-01T16:00:00Z'));
  assert.equal(time.end, Date.parse('1960-01-02T16:00:00Z') - 1);
  assert.equal(time.precision, 'day'); assert.equal(time.ambiguous, false);
  assert.throws(() => parse(fact({ eventTime: { expression: '2026-01-01', precision: 'day', ambiguous: false } })));
  assert.throws(() => parse({ ...input, eventTime: { ...input.eventTime, start: 0 } }));
  const impossible = fact({ quote: '2026-02-30', eventTime: { expression: '2026-02-30', precision: 'day', ambiguous: false } });
  assert.deepEqual(parse(impossible, { ...evidence, text: impossible.quote })[0]!.eventTime,
    { expression: '2026-02-30', precision: 'unknown', ambiguous: true });
});

test('relative days use source eventTime and explicit snapshot timezone, including DST-length days', () => {
  const yesterday = fact({ quote: '昨天和小林喝茶', eventTime: { expression: '昨天', precision: 'unknown', ambiguous: true } });
  assert.equal(parse(yesterday)[0]!.eventTime.start, Date.parse('2026-11-02T16:00:00Z'));
  const today = fact({ quote: '今天', eventTime: { expression: '今天', precision: 'unknown', ambiguous: true } });
  const time = parse(today, { ...evidence, text: '今天', timeZone: 'America/New_York', eventTimeMs: Date.parse('2026-11-01T12:00:00Z') })[0]!.eventTime;
  assert.equal(time.start, Date.parse('2026-11-01T04:00:00Z'));
  assert.equal(time.end! - time.start! + 1, 25 * 3_600_000);
  const { eventTimeMs: _removed, ...botEvidence } = evidence;
  assert.equal(parse(yesterday, botEvidence)[0]!.eventTime.start, undefined);
});

test('unsupported or unanchored times remain ambiguous; fabricated model epochs fail closed', () => {
  const input = fact({ quote: '下个月', eventTime: { expression: '下个月', precision: 'month', ambiguous: false } });
  assert.equal(parse(input, { ...evidence, text: '下个月' })[0]!.eventTime.ambiguous, true);
  assert.throws(() => parse({ ...input, eventTime: { ...input.eventTime, start: Date.parse('2026-12-01T00:00:00Z') } }, { ...evidence, text: '下个月' }));
  assert.throws(() => parse(fact({ eventTime: { expression: '', precision: 'instant', ambiguous: false, start: 123 } })));
});
