import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fingerprint, freezeDeep } from '../llm/routes.js';
import type { LivePolicy } from '../policy/live.js';
import { unionClosure } from '../policy/scope.js';
import type { AuthorizedScope, ProvenanceInput } from '../policy/scope.js';
import type { ConfigurationReader } from '../runtime/configuration.js';
import { memoryVersionKey } from '../storage/model.js';
import type { MemoryVersion, Provenance } from '../storage/model.js';
import type { ControlRepository } from '../storage/repository.js';
import { canonicalDocumentHash, lexicalQueryFeatures } from './knowledge.js';
import type { KnowledgeAdapter, VerifiedPluginDocument } from './knowledge.js';

export interface RecallPlan {
  readonly queries: readonly string[];
  readonly entities?: readonly string[];
  readonly timeRange?: { readonly start?: number; readonly end?: number };
}
export type RecallLane = 'lexical' | 'entity' | 'time';
export interface RecallEvidence {
  readonly evidenceId: string;
  readonly memoryId: string;
  readonly version: number;
  readonly docId: string;
  readonly kind: MemoryVersion['kind'];
  /** Plain text, never a fact JSON codec. Snippets are exact UTF-16 slices of verified text. */
  readonly text: string;
  readonly provenance: Provenance;
  readonly score: number;
  readonly lanes: readonly RecallLane[];
  readonly contentHash: string;
  readonly eventStart?: number;
  readonly eventEnd?: number;
  readonly snippet?: { readonly start: number; readonly end: number; readonly totalChars: number };
}
export interface RecallResult {
  readonly evidence: readonly RecallEvidence[];
  /** Only evidence actually returned for model input, including each input's own active version. */
  readonly provenance?: Provenance;
  /** Host control-plane data, NOT part of the model evidence payload. */
  readonly scope: AuthorizedScope;
  readonly mode: 'local-lexical';
  /** Conservative UTF-8 byte count of serialized {evidence,provenance}, including JSON metadata. */
  readonly estimatedTokens: number;
  readonly tokenBudget: number;
  readonly candidateCount: number;
}
export interface RecallOptions { readonly readConfiguration?: ConfigurationReader; readonly now?: () => number }
export interface ValidatedCitations {
  readonly evidenceIds: readonly string[];
  readonly quotes: readonly { readonly evidenceId: string; readonly quote: string }[];
}
export class RecallError extends Error {
  override readonly name = 'RecallError';
  constructor(readonly code: string) { super(code); }
}

const timestamp = z.number().int().safe().min(-8_640_000_000_000_000).max(8_640_000_000_000_000);
const planSchema = z.object({
  queries: z.array(z.string().max(512)).max(8),
  entities: z.array(z.string().min(1).max(256)).max(16).optional(),
  timeRange: z.object({ start: timestamp.optional(), end: timestamp.optional() }).strict()
    .refine(value => value.start !== undefined || value.end !== undefined)
    .refine(value => value.start === undefined || value.end === undefined || value.start <= value.end).optional(),
}).strict();
const citationsSchema = z.object({
  evidenceIds: z.array(z.string().min(1).max(80)).max(100),
  quotes: z.array(z.object({ evidenceId: z.string().min(1).max(80), quote: z.string().min(1).max(4096) }).strict()).max(100).optional(),
}).strict();
const MAX_POOL = 100;
const MAX_TOKENS = 4096;
const MAX_CORPUS = 20_000;
const MAX_SCAN_CHARS = 67_108_864;
const MAX_SNIPPET_CHARS = 1024;
const RRF_K = 60;
const fail = (code: string): never => { throw new RecallError(code); };
const key = (memory: Pick<MemoryVersion, 'memoryId' | 'version'>): string => memoryVersionKey(memory.memoryId, memory.version);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
interface Ranked { readonly memory: MemoryVersion; readonly score: number }
interface Fused extends Ranked { readonly lanes: readonly RecallLane[] }
const rank = (items: Ranked[]): Ranked[] => items.filter(item => item.score > 0)
  .sort((a, b) => b.score - a.score || compare(key(a.memory), key(b.memory))).slice(0, MAX_POOL);

/** Strict projection for parent recall/reflect digests. No prose field is treated as a citation.
 * A quote must name a cited ID and be an exact nonempty substring of that ID's actual evidence. */
export function validateCitations(payload: unknown, evidence: readonly RecallEvidence[]): ValidatedCitations {
  const parsed = citationsSchema.safeParse(payload);
  if (!parsed.success) return fail('invalid-citations');
  const byId = new Map(evidence.map(item => [item.evidenceId, item]));
  if (byId.size !== evidence.length) return fail('invalid-citations');
  const ids = [...new Set(parsed.data.evidenceIds)];
  if (ids.some(id => !byId.has(id))) return fail('invalid-citations');
  const quotes = parsed.data.quotes ?? [];
  if (quotes.some(item => !ids.includes(item.evidenceId) || !byId.get(item.evidenceId)?.text.includes(item.quote))) {
    return fail('invalid-citations');
  }
  return freezeDeep({ evidenceIds: ids, quotes: quotes.map(item => ({ ...item })) });
}

function lexicalScore(text: string, features: readonly string[]): number {
  const normalized = text.normalize('NFKC').toLowerCase();
  let score = 0;
  for (const feature of features) {
    let start = 0;
    for (let occurrence = 0; occurrence < 32; occurrence++) {
      const at = normalized.indexOf(feature, start);
      if (at < 0) break;
      score++;
      start = at + feature.length;
    }
  }
  return score;
}

/** A bounded cooccurrence approximation, NOT a global graph or native Hindsight traversal.
 * Two passes = direct entity records plus one cooccurrence hop, all over authorized metadata.
 * Entity keys are exact: no QQ/nickname similarity merging or cross-scope entity profile. */
function entityLane(memories: readonly MemoryVersion[], entities: readonly string[]): Ranked[] {
  let frontier = new Set(entities);
  const visitedEntities = new Set(frontier);
  const scores = new Map<string, Ranked>();
  for (let pass = 0; pass < 2 && frontier.size; pass++) {
    const next = new Set<string>();
    for (const memory of memories) {
      const own = [...new Set(memory.entities)].slice(0, 128);
      const matches = own.filter(entity => frontier.has(entity)).length;
      if (!matches) continue;
      const score = (pass === 0 ? 1000 : 0) + matches;
      const prior = scores.get(key(memory));
      if (!prior || score > prior.score) scores.set(key(memory), { memory, score });
      for (const entity of own) {
        if (next.size >= 128) break;
        if (!visitedEntities.has(entity)) next.add(entity);
      }
    }
    for (const entity of next) visitedEntities.add(entity);
    frontier = next;
  }
  return rank([...scores.values()]);
}
function verifiedInterval(memory: MemoryVersion): { start: number; end: number } | undefined {
  const start = memory.eventStart ?? memory.eventEnd;
  const end = memory.eventEnd ?? memory.eventStart;
  if (!timestamp.safeParse(start).success || !timestamp.safeParse(end).success || start === undefined || end === undefined || start > end) return undefined;
  return { start, end };
}
function timeLane(memories: readonly MemoryVersion[], range: RecallPlan['timeRange']): Ranked[] {
  if (!range) return [];
  const anchor = range.start ?? range.end!;
  const result: Ranked[] = [];
  for (const memory of memories) {
    const interval = verifiedInterval(memory);
    // Unknown event times never fall back to receivedAt, createdAt or document update time.
    if (!interval || (range.start !== undefined && interval.end < range.start)
      || (range.end !== undefined && interval.start > range.end)) continue;
    const distance = Math.max(0, interval.start - anchor, anchor - interval.end);
    result.push({ memory, score: 1 / (1 + distance) });
  }
  return rank(result);
}
function fuse(lanes: readonly (readonly [RecallLane, readonly Ranked[]])[], limit: number): Fused[] {
  const fused = new Map<string, { memory: MemoryVersion; score: number; lanes: RecallLane[] }>();
  for (const [lane, items] of lanes) {
    const seen = new Set<string>();
    let position = 0;
    for (const item of items) {
      const id = key(item.memory);
      if (seen.has(id)) continue;
      seen.add(id);
      position++;
      const entry = fused.get(id) ?? { memory: item.memory, score: 0, lanes: [] };
      // All query rewrites share ONE lexical lane; never manufacture semantic/hybrid votes.
      if (!entry.lanes.includes(lane)) { entry.score += 1 / (RRF_K + position); entry.lanes.push(lane); }
      fused.set(id, entry);
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || compare(key(a.memory), key(b.memory))).slice(0, limit);
}
function closureFor(memory: MemoryVersion, catalog: readonly MemoryVersion[]): Provenance {
  const byKey = new Map(catalog.map(item => [key(item), item]));
  const inputs: ProvenanceInput[] = [{ ...memory.provenance, inputVersion: { memoryId: memory.memoryId, version: memory.version } }];
  const queue = [...memory.provenance.dependencyVersions];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const dependency = queue[index]!;
    const id = memoryVersionKey(dependency.memoryId, dependency.version);
    if (seen.has(id)) continue;
    seen.add(id);
    const current = byKey.get(id);
    if (!current || id === key(memory)) return fail('recall-dependency-invalid');
    inputs.push(current.provenance);
    queue.push(...current.provenance.dependencyVersions.filter(item => !seen.has(memoryVersionKey(item.memoryId, item.version))));
    if (queue.length > MAX_CORPUS * 128) return fail('recall-corpus-budget');
  }
  return structuredClone(unionClosure(inputs, catalog.map(item => ({ memoryId: item.memoryId, version: item.version })))) as Provenance;
}
function modelPayload(evidence: readonly RecallEvidence[], catalog: readonly MemoryVersion[]): { evidence: readonly RecallEvidence[]; provenance?: Provenance } {
  if (!evidence.length) return { evidence };
  const provenance = structuredClone(unionClosure(evidence.map(item => item.provenance),
    catalog.map(item => ({ memoryId: item.memoryId, version: item.version })))) as Provenance;
  return { evidence, provenance };
}
function tokenCost(payload: unknown): number { return Buffer.byteLength(JSON.stringify(payload), 'utf8'); }
function context(scope: AuthorizedScope): unknown {
  return [scope.botId, scope.personalityId, scope.conversationType, scope.conversationId, scope.requesterQQ,
    scope.visibility, scope.configRevision, scope.authEpoch, scope.bindingRevision, scope.connectionEpoch];
}
function quoteWindow(text: string, features: readonly string[], maximum: number): { text: string; start: number; end: number } {
  if (text.length <= maximum) return { text, start: 0, end: text.length };
  const found = features.map(term => text.indexOf(term)).filter(at => at >= 0);
  const anchor = found.length ? Math.min(...found) : 0;
  let start = Math.max(0, anchor - Math.floor(maximum / 4));
  let end = Math.min(text.length, start + maximum);
  // Never split a surrogate pair; offsets are still exact original UTF-16 positions.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
  return { text: text.slice(start, end), start, end };
}

/** Fixed host retrieval only. No LLM, reranker, vector service, general tool or knowledge internals.
 * Large corpora are scanned completely (or fail a hard budget), never arbitrarily first-100.
 * Local scan bodies influence trusted ranking only; only returned evidence enters provenance. */
export class RecallEngine {
  constructor(private readonly repository: ControlRepository,
    private readonly knowledge: Pick<KnowledgeAdapter, 'readAuthorizedDocuments'>,
    private readonly policy: Pick<LivePolicy, 'captureScope' | 'candidates' | 'authorizeDocuments' | 'validateDocumentsLive'>,
    private readonly options: RecallOptions = {}) {}

  async retrieve(messageKey: string, plan: RecallPlan, suppliedScope?: AuthorizedScope): Promise<RecallResult> {
    const parsed = planSchema.safeParse(plan);
    if (!parsed.success) return fail('invalid-recall-plan');
    const value = parsed.data;
    // Zod optional fields may retain explicit undefined; the host contract uses absent keys.
    const normalized: RecallPlan = { queries: value.queries,
      ...(value.entities === undefined ? {} : { entities: value.entities }),
      ...(value.timeRange === undefined ? {} : { timeRange: {
        ...(value.timeRange.start === undefined ? {} : { start: value.timeRange.start }),
        ...(value.timeRange.end === undefined ? {} : { end: value.timeRange.end }),
      } }),
    };
    try { return await this.retrieveAuthorized(messageKey, normalized, suppliedScope); }
    catch (error) { if (error instanceof RecallError) throw error; return fail('recall-authorization-or-read-failed'); }
  }

  private async retrieveAuthorized(messageKey: string, plan: RecallPlan, suppliedScope?: AuthorizedScope): Promise<RecallResult> {
    const configuration = this.options.readConfiguration?.();
    const fresh = await this.policy.captureScope(messageKey);
    const scope = suppliedScope ?? fresh;
    // A caller may reuse a narrower host scope, but cannot borrow another requester's/target's scope.
    if (fingerprint(context(scope)) !== fingerprint(context(fresh)) || scope.allowedSources.some(ref => !fresh.allowedSources
      .some(other => other.sourceId === ref.sourceId && other.sourceEpoch === ref.sourceEpoch))) return fail('recall-scope-mismatch');
    const memories = this.policy.candidates(scope);
    if (memories.length > MAX_CORPUS) return fail('recall-corpus-budget');
    const ids = memories.map(memory => memory.docId ?? fail('recall-document-missing'));
    const state = this.repository.read();
    const message = state.messages[messageKey];
    const snapshot = message && state.snapshots[message.snapshotId];
    if (!message || !snapshot || message.botId !== scope.botId || message.personalityId !== scope.personalityId
      || snapshot.configRevision !== scope.configRevision) return fail('recall-scope-mismatch');
    const limit = Math.min(MAX_POOL, snapshot.budgets.maxCandidates);
    const tokenBudget = Math.min(MAX_TOKENS, snapshot.budgets.evidenceMaxTokens);
    const startedAt = (this.options.now ?? Date.now)();
    const check = (): void => {
      const now = (this.options.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < startedAt) return fail('recall-clock-invalid');
      if (configuration) {
        const current = this.options.readConfiguration!();
        if (current.config !== configuration.config || current.revision !== configuration.revision
          || current.revision !== scope.configRevision) return fail('recall-configuration-invalid');
      }
      this.policy.candidates(fresh); // Also binds every post-await check to THIS message/deadline.
      if (scope !== fresh) this.policy.candidates(scope);
      if (!this.policy.validateDocumentsLive(scope, ids)) return fail('recall-authorization-or-read-failed'); // Full ranking corpus, including pending deletion blocks.
    };
    check(); // FULL metadata authorization before touching any local text, entities or event times.
    const empty = (): RecallResult => {
      check();
      return freezeDeep({ evidence: [], scope, mode: 'local-lexical', estimatedTokens: tokenCost({ evidence: [] }), tokenBudget, candidateCount: 0 });
    };
    if (!ids.length) return empty(); // No readiness/list/search/read call and never undefined docIds.
    const features = [...new Set(plan.queries.flatMap(query => lexicalQueryFeatures(query)))].slice(0, 64);
    const entities = entityLane(memories, plan.entities ?? []);
    const times = timeLane(memories, plan.timeRange);
    let lexical: Ranked[] = [];
    let pool: Fused[];
    let selected: readonly MemoryVersion[];
    if (memories.length > MAX_POOL) {
      if (features.length) {
        let chars = 0;
        const scores: Ranked[] = [];
        for (const memory of memories) {
          // No await in this scan: the preceding full-set guard covers every access; the
          // full-set guard is repeated immediately afterwards (rather than O(n²) rescans).
          const current = this.repository.read().memories[key(memory)];
          // No spread/clone/body access before the public policy has authorized this exact mapping.
          const text = current?.text;
          if (typeof text !== 'string') return fail('recall-local-index-unavailable');
          chars += text.length;
          if (chars > MAX_SCAN_CHARS || text.length > 131_072) return fail('recall-corpus-budget');
          if (canonicalDocumentHash(text, memory.provenance) !== memory.contentHash) return fail('recall-local-index-integrity');
          scores.push({ memory, score: lexicalScore(text, features) });
        }
        lexical = rank(scores);
      }
      check(); // Recheck full scope/mappings after the entire trusted local scan.
      pool = fuse([['lexical', lexical], ['entity', entities], ['time', times]], limit);
      selected = pool.map(item => item.memory);
    } else if (features.length) {
      // At most 100 selected authorized documents can be read through the public adapter.
      selected = memories;
      pool = [];
    } else {
      pool = fuse([['entity', entities], ['time', times]], limit);
      selected = pool.map(item => item.memory);
    }
    if (!selected.length) return empty();
    const bank = this.repository.read().banks[selected[0]!.bankKey];
    if (!bank || bank.state !== 'ready' || !bank.baseId) return fail('recall-bank-unavailable');
    const selectedIds = selected.map(memory => memory.docId!);
    const documents = await this.knowledge.readAuthorizedDocuments({
      bank: { bankKey: bank.bankKey, provisionMarker: bank.provisionMarker, baseId: bank.baseId }, docIds: selectedIds,
      authorize: (docIds, docs) => {
        check();
        this.policy.authorizeDocuments(scope, docIds, docs);
      },
      validateLive: (docIds, docs) => {
        check();
        return this.policy.validateDocumentsLive(scope, docIds, docs);
      },
    });
    check();
    this.policy.authorizeDocuments(scope, selectedIds, documents);
    // Defense against an incomplete/incorrect adapter: validate every selected body independently.
    const byDoc = new Map<string, VerifiedPluginDocument>();
    for (const document of documents) {
      if (byDoc.has(document.docId) || !selectedIds.includes(document.docId)
        || canonicalDocumentHash(document.text, document.header.provenance) !== document.hash) return fail('recall-document-integrity');
      byDoc.set(document.docId, document);
    }
    if (byDoc.size !== selectedIds.length) return fail('recall-document-missing');
    if (memories.length <= MAX_POOL && features.length) {
      lexical = rank(memories.map(memory => ({ memory, score: lexicalScore(byDoc.get(memory.docId!)!.text, features) })));
      pool = fuse([['lexical', lexical], ['entity', entities], ['time', times]], limit);
    }
    const evidence: RecallEvidence[] = [];
    for (const item of pool) {
      const memory = item.memory;
      const document = byDoc.get(memory.docId!);
      if (!document) return fail('recall-document-missing');
      const provenance = closureFor(memory, memories);
      // Whole evidence items or explicitly marked exact quote windows; never truncate current input.
      let maximum = Math.min(MAX_SNIPPET_CHARS, document.text.length);
      while (maximum > 0) {
        const window = quoteWindow(document.text, features, maximum);
        const snippet = window.start !== 0 || window.end !== document.text.length
          ? { start: window.start, end: window.end, totalChars: document.text.length } : undefined;
        const evidenceId = 'ev-' + createHash('sha256').update(JSON.stringify([memory.memoryId, memory.version,
          document.docId, document.hash, window.start, window.end]), 'utf8').digest('hex');
        const candidate: RecallEvidence = { evidenceId, memoryId: memory.memoryId, version: memory.version,
          docId: document.docId, kind: memory.kind, text: window.text, provenance, score: item.score,
          lanes: [...item.lanes], contentHash: memory.contentHash,
          ...(verifiedInterval(memory) ? {
            ...(memory.eventStart === undefined ? {} : { eventStart: memory.eventStart }),
            ...(memory.eventEnd === undefined ? {} : { eventEnd: memory.eventEnd }),
          } : {}), ...(snippet ? { snippet } : {}) };
        if (tokenCost(modelPayload([...evidence, candidate], memories)) <= tokenBudget) { evidence.push(candidate); break; }
        if (maximum <= 64) break;
        maximum = Math.max(64, Math.floor(maximum / 2));
      }
    }
    const payload = modelPayload(evidence, memories);
    check(); // After all awaits and all formatting, no stale evidence crosses the return boundary.
    this.policy.authorizeDocuments(scope, selectedIds, documents);
    return freezeDeep({ ...payload, scope, mode: 'local-lexical', estimatedTokens: tokenCost(payload), tokenBudget, candidateCount: pool.length });
  }
}
