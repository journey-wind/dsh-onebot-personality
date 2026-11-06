import { z } from 'zod';
import { fingerprint } from '../llm/routes.js';
import { factSchema } from '../storage/model.js';
import type { ExtractedFact, MessageRecord } from '../storage/model.js';

/** Exactly one independent message/confirmed segment, not a multi-source corroboration set. */
export interface FactEvidence {
  readonly text: string;
  /** Host-owned message/segment + source-epoch scope; never a bank-wide nickname identity. */
  readonly entityScope: string;
  readonly qqIds: readonly string[];
  readonly timeZone: string;
  /** Omitted for bot experience: the original user message time is not the send time. */
  readonly eventTimeMs?: number;
}
export class FactValidationError extends Error {
  override readonly name = 'FactValidationError';
  constructor() { super('invalid-retain-facts'); }
}
const extractionSchema = z.object({ facts: z.array(factSchema).max(32) }).strict();
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
function clean(value: string, nonempty = false): void {
  if (controls.test(value) || (nonempty && !value.trim())) throw new FactValidationError();
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new FactValidationError();
  }
}
/** Code-unit order is independent of process locale and ICU collation data. */
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the host author and literal protocol at segments confer QQ identity. Text/nicknames do not. */
export function evidenceQQIds(message: MessageRecord): string[] {
  const ids = new Set<string>(message.author.kind === 'qq' ? [message.author.qqId] : []);
  if (!message.sanitizedEventJson) return [...ids];
  try {
    const event: unknown = JSON.parse(message.sanitizedEventJson);
    if (!record(event) || !Array.isArray(event.message) || event.message.length > 256) return [...ids];
    for (const segment of event.message) {
      if (!record(segment) || segment.type !== 'at' || !record(segment.data)) continue;
      const id = segment.data.qq;
      if (typeof id === 'string' && /^[1-9][0-9]{0,31}$/.test(id)) ids.add(id);
    }
  } catch { /* Malformed projection confers no additional identities. */ }
  return [...ids].sort(compare);
}

function utcDay(year: number, month: number, day: number): number {
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}
/** Exact calendar dates and three relative-day expressions only; never trust model arithmetic. */
function verifiedTime(time: ExtractedFact['eventTime'], evidence: FactEvidence): ExtractedFact['eventTime'] {
  const unknown: ExtractedFact['eventTime'] = { expression: time.expression, precision: 'unknown', ambiguous: true };
  let verified = unknown;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: evidence.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const parts = (at: number): number[] => {
      const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
      return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(values[key]));
    };
    let day: number | undefined;
    const iso = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.exec(time.expression);
    if (iso) {
      const year = Number(iso[1]); const month = Number(iso[2]); const date = Number(iso[3]);
      const candidate = utcDay(year, month, date); const check = new Date(candidate);
      if (check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === date) day = candidate;
    } else if (evidence.eventTimeMs !== undefined && ['今天', '昨天', '明天'].includes(time.expression)) {
      const [year, month, date] = parts(evidence.eventTimeMs);
      day = utcDay(year!, month!, date!) + (time.expression === '昨天' ? -1 : time.expression === '明天' ? 1 : 0) * 86_400_000;
    }
    if (day !== undefined) {
      const midnight = (target: number): number | undefined => {
        let candidate = target;
        for (let i = 0; i < 4; i++) {
          const [year, month, date, hour, minute, second] = parts(candidate);
          const observed = utcDay(year!, month!, date!) + hour! * 3_600_000 + minute! * 60_000 + second! * 1000;
          if (observed === target) {
            // Distinct offsets around a repeated midnight must not silently select one instant.
            const matches = new Set([candidate]);
            for (const delta of [-172_800_000, 172_800_000]) {
              const sample = candidate + delta;
              const [sy, sm, sd, sh, smin, ss] = parts(sample);
              const sampleWall = utcDay(sy!, sm!, sd!) + sh! * 3_600_000 + smin! * 60_000 + ss! * 1000;
              const alternate = target - (sampleWall - sample);
              const [ay, am, ad, ah, amin, asec] = parts(alternate);
              if (utcDay(ay!, am!, ad!) + ah! * 3_600_000 + amin! * 60_000 + asec! * 1000 === target) matches.add(alternate);
            }
            return matches.size === 1 ? candidate : undefined;
          }
          candidate += target - observed;
        }
        return undefined; // DST gaps/unsupported calendars remain ambiguous.
      };
      const start = midnight(day); const next = midnight(day + 86_400_000);
      if (start !== undefined && next !== undefined && next > start) verified = {
        expression: time.expression, start, end: next - 1, precision: 'day', ambiguous: false,
      };
    }
  } catch { /* Invalid/unsupported zone, extreme date, or unavailable Intl: no asserted time. */ }
  if ((time.start !== undefined && time.start !== verified.start) || (time.end !== undefined && time.end !== verified.end)) {
    throw new FactValidationError();
  }
  return verified;
}

/** Pure, bounded schema + evidence validation, also used on durable checkpoint reload. */
export function validateFacts(input: unknown, evidence: FactEvidence): ExtractedFact[] {
  const parsed = extractionSchema.safeParse(input);
  if (!parsed.success) throw new FactValidationError();
  const allowedQQ = new Set(evidence.qqIds);
  const result: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const fact of parsed.data.facts) {
    clean(fact.content, true); clean(fact.quote, true);
    // One message/confirmed segment is one independent evidence item, however many quotes
    // or retries it supplies. Multi-evidence corroboration requires host-counted observations.
    if (fact.confidence === 'corroborated' || !evidence.text.includes(fact.quote)
      || fact.inferred !== (fact.confidence === 'inferred')) throw new FactValidationError();
    clean(fact.eventTime.expression);
    if (fact.eventTime.expression && !fact.quote.includes(fact.eventTime.expression)) throw new FactValidationError();
    const eventTime = verifiedTime(fact.eventTime, evidence);
    const remap = new Map<string, string>();
    const entities = new Map<string, ExtractedFact['entities'][number]>();
    for (const entity of fact.entities) {
      clean(entity.key, true); clean(entity.label, true);
      if (remap.has(entity.key)) throw new FactValidationError();
      let normalized: ExtractedFact['entities'][number];
      if (entity.kind === 'qq') {
        if (!entity.qqId || !allowedQQ.has(entity.qqId)) throw new FactValidationError();
        // QQ labels are host identity, never a model-created nickname/alias association.
        normalized = { key: `qq:${entity.qqId}`, kind: 'qq', label: entity.qqId, qqId: entity.qqId };
      } else {
        if (entity.qqId !== undefined || !fact.quote.includes(entity.label)) throw new FactValidationError();
        normalized = { key: `entity-${fingerprint(['retain-entity-v1', evidence.entityScope, entity.label])}`,
          kind: 'uncertain', label: entity.label };
      }
      remap.set(entity.key, normalized.key);
      const previous = entities.get(normalized.key);
      if (previous && fingerprint(previous) !== fingerprint(normalized)) throw new FactValidationError();
      entities.set(normalized.key, normalized);
    }
    const relations = new Map<string, ExtractedFact['relations'][number]>();
    for (const relation of fact.relations) {
      clean(relation.relation, true);
      const from = remap.get(relation.from); const to = remap.get(relation.to);
      if (!from || !to || (relation.inferred && !fact.inferred)) throw new FactValidationError();
      const normalized = { from, to, relation: relation.relation, inferred: relation.inferred };
      relations.set(fingerprint(normalized), normalized);
    }
    const normalized: ExtractedFact = { ...fact, eventTime,
      entities: [...entities.values()].sort((a, b) => compare(a.key, b.key)),
      relations: [...relations.values()].sort((a, b) => compare(fingerprint(a), fingerprint(b))),
    };
    const identity = fingerprint(normalized);
    if (!seen.has(identity)) { seen.add(identity); result.push(normalized); }
  }
  return result;
}

/** Readable lexical evidence, not a JSON envelope. Source ACL/provenance stays host-owned. */
export function renderFact(fact: ExtractedFact): string {
  return [fact.content, `原文引文：${fact.quote}`, `可信度：${fact.confidence}；推断：${fact.inferred ? '是' : '否'}`,
    `事件时间表达：${fact.eventTime.expression || '未提供'}；${fact.eventTime.start === undefined
      ? '时间未知/有歧义（未断言时间戳）' : `宿主核验区间：${fact.eventTime.start} 至 ${fact.eventTime.end}（${fact.eventTime.precision}）`}`,
    ...fact.entities.map(entity => `实体：${entity.key} ${entity.label}`),
    ...fact.relations.map(relation => `关系（${relation.inferred ? '推断' : '明确报告'}）：${relation.from} ${relation.relation} ${relation.to}`),
  ].join('\n');
}
