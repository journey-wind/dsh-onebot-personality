import { createHash } from 'node:crypto';
import type { KnowledgeService, DocumentSummary, KnowledgeDocument } from 'dsh-knowledge/knowledge';
import { z } from 'zod';
import type { Provenance } from '../storage/model.js';

/** Public surface only. No knowledge runtime, store, retrieval or HTTP imports. */
export type PublicKnowledgeService = Pick<KnowledgeService,
  'whenReady' | 'listBases' | 'createBase' | 'getConfigFor' | 'listDocuments' |
  'addTextDocument' | 'getDocument' | 'readDocumentText' | 'deleteDocument'> &
  Partial<Pick<KnowledgeService, 'reindexDocument'>>;
export const KNOWLEDGE_NAMESPACE = 'dsh-onebot-personality/v1';
const HEADER_PREFIX = 'DSH_ONEBOT_MEMORY_V1 ';
const TITLE_PREFIX = 'dsh-onebot-memory/v1:';
const MAX_DOCUMENT_CHARS = 262_144;
const MAX_RETRIEVAL_DOCS = 100;
const MAX_RETRIEVAL_CHARS = 1_048_576;
const keySchema = z.string().min(1).max(1024);
const positiveSchema = z.number().int().safe().positive();
const provenanceSchema = z.object({
  complete: z.literal(true),
  sourceRefs: z.array(z.object({ sourceId: keySchema, sourceEpoch: positiveSchema }).strict()).min(1).max(1000),
  messageKeys: z.array(keySchema).min(1).max(10000),
  dependencyVersions: z.array(z.object({ memoryId: keySchema, version: positiveSchema }).strict()).max(10000),
}).strict();
const headerSchema = z.object({
  encoding: z.literal(1), memoryId: keySchema, version: positiveSchema, writeIntentId: keySchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/), provenance: provenanceSchema,
}).strict();
export type PluginDocumentHeader = z.infer<typeof headerSchema>;
export interface PluginDocumentInput {
  memoryId: string;
  version: number;
  writeIntentId: string;
  provenance: Provenance;
  text: string;
}
export interface EncodedPluginDocument {
  title: string;
  content: string;
  /** Exact recovery identity, excluding the content hash. Host-generated, never model-supplied. */
  marker: string;
  hash: string;
  header: PluginDocumentHeader;
  text: string;
}
export interface BankTarget { bankKey: string; provisionMarker: string; baseId?: string }
export interface ProvisionedBank extends BankTarget { baseId: string }
export type VectorState = 'not_requested' | 'pending' | 'ready' | 'failed' | 'unknown';
export interface ReconciledDocument {
  docId: string;
  orphanDocIds: string[];
  vectorState: VectorState;
}
export interface VerifiedPluginDocument {
  docId: string;
  baseId: string;
  header: PluginDocumentHeader;
  hash: string;
  text: string;
}
export interface PluginDocumentMetadata {
  docId: string;
  baseId: string;
  header: PluginDocumentHeader;
  hash: string;
  vectorState: VectorState;
}
export interface AuthorizedDocumentsRequest {
  bank: ProvisionedBank;
  /** Host-selected graph/time/etc candidates; never widen these IDs from model arguments. */
  docIds: readonly string[];
  /** Recheck owner/scope, active version, hash and provenance whenever documents are supplied. */
  authorize(docIds: readonly string[], documents?: readonly VerifiedPluginDocument[]): void | Promise<void>;
  /** Final synchronous authority; asynchronous authorize alone cannot close an await/effect race. */
  validateLive?: (docIds: readonly string[], documents?: readonly VerifiedPluginDocument[]) => boolean;
}
export interface LexicalHit extends VerifiedPluginDocument { score: number }
export interface LexicalRequest {
  bank: ProvisionedBank;
  /** Host-computed authorized active IDs. Never model arguments. */
  docIds: readonly string[];
  query: string;
  /** Must recheck ownership, epoch/tombstone, active version and (when supplied) header/hash/provenance. */
  authorize(docIds: readonly string[], documents?: readonly VerifiedPluginDocument[]): void | Promise<void>;
  /** Final synchronous authority; asynchronous authorize alone cannot close an await/effect race. */
  validateLive?: (docIds: readonly string[], documents?: readonly VerifiedPluginDocument[]) => boolean;
  topK?: number;
}
/** Read-only preparation grants no mutation until the caller explicitly submits once. */
export interface PreparedRepair {
  readonly docId: string;
  /** True immediately before the SDK invocation, including synchronous SDK failure. */
  readonly invoked: boolean;
  submit(): Promise<void>;
}
export interface WriteSettlement {
  readonly state: 'pending' | 'fulfilled' | 'rejected';
  /** Settles with the *underlying addTextDocument promise*, not an adapter timeout/race. */
  readonly settled: Promise<'fulfilled' | 'rejected'>;
}
export class KnowledgeAdapterError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'KnowledgeAdapterError'; }
}
function fail(code: string): never { throw new KnowledgeAdapterError(code); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function validKey(value: unknown): asserts value is string {
  if (!keySchema.safeParse(value).success) fail('invalid-knowledge-identity');
}
/** UTF-8 roundtrip gives deterministic replacement of lone surrogates; CR/CRLF become LF.
 * No trimming, NFC folding, or whitespace compression: raw evidence retains its spacing. */
function normalizeText(text: string): string {
  if (typeof text !== 'string') fail('invalid-document-text');
  return Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8').toString('utf8');
}
function canonicalProvenance(value: unknown): Provenance {
  const parsed = provenanceSchema.safeParse(value);
  if (!parsed.success) fail('invalid-document-provenance');
  const p = parsed.data;
  const sourceRefs = [...new Map(p.sourceRefs.map(ref => [JSON.stringify([ref.sourceId, ref.sourceEpoch]), ref])).values()]
    .sort((a, b) => compare(a.sourceId, b.sourceId) || a.sourceEpoch - b.sourceEpoch);
  // An identity with two epochs in the same closure cannot be made current.
  if (new Set(sourceRefs.map(ref => ref.sourceId)).size !== sourceRefs.length) fail('conflicting-source-epochs');
  const dependencyVersions = [...new Map(p.dependencyVersions.map(dep => [JSON.stringify([dep.memoryId, dep.version]), dep])).values()]
    .sort((a, b) => compare(a.memoryId, b.memoryId) || a.version - b.version);
  if (new Set(dependencyVersions.map(dep => dep.memoryId)).size !== dependencyVersions.length) {
    fail('conflicting-dependency-versions');
  }
  return {
    complete: true,
    sourceRefs: sourceRefs.map(ref => ({ sourceId: ref.sourceId, sourceEpoch: ref.sourceEpoch })),
    messageKeys: [...new Set(p.messageKeys)].sort(compare),
    dependencyVersions: dependencyVersions.map(dep => ({ memoryId: dep.memoryId, version: dep.version })),
  };
}
/** Hash v1 = SHA-256(UTF8(JSON.stringify({encoding:1,text,provenance}))) in that
 * property order. Provenance sets are deduplicated/sorted by code-unit order.
 * The recovery header, IDs, title and hash itself are NOT hash inputs. */
export function canonicalDocumentHash(text: string, provenance: Provenance): string {
  return createHash('sha256').update(JSON.stringify({ encoding: 1, text: normalizeText(text),
    provenance: canonicalProvenance(provenance) }), 'utf8').digest('hex');
}
function recoveryMarker(memoryId: string, version: number, writeIntentId: string): string {
  return TITLE_PREFIX + Buffer.from(JSON.stringify([memoryId, version, writeIntentId]), 'utf8').toString('base64url');
}
export function encodePluginDocument(input: PluginDocumentInput): EncodedPluginDocument {
  validKey(input.memoryId); validKey(input.writeIntentId);
  if (!positiveSchema.safeParse(input.version).success) fail('invalid-document-version');
  const text = normalizeText(input.text);
  if (!text.trim() || text.length > 131_072) fail('document-text-budget');
  const provenance = canonicalProvenance(input.provenance);
  const hash = canonicalDocumentHash(text, provenance);
  const header: PluginDocumentHeader = { encoding: 1, memoryId: input.memoryId, version: input.version,
    writeIntentId: input.writeIntentId, hash, provenance };
  const marker = recoveryMarker(header.memoryId, header.version, header.writeIntentId);
  if (marker.length > 1024) fail('document-marker-budget');
  const content = HEADER_PREFIX + JSON.stringify(header) + '\n' + text;
  if (content.length > MAX_DOCUMENT_CHARS) fail('document-text-budget');
  return { title: marker + ':' + hash, content, marker, hash, header, text };
}
/** Verifies canonical serialization, title identity, text completeness and content hash.
 * A marker-looking string in model text is ordinary body data, never a recovery header. */
export function decodePluginDocument(title: string, content: string): EncodedPluginDocument {
  if (typeof content !== 'string' || content.length > MAX_DOCUMENT_CHARS || !content.startsWith(HEADER_PREFIX)) {
    fail('invalid-plugin-document');
  }
  const newline = content.indexOf('\n');
  if (newline < 0) fail('invalid-plugin-document');
  let raw: unknown;
  try { raw = JSON.parse(content.slice(HEADER_PREFIX.length, newline)); }
  catch { fail('invalid-plugin-document'); }
  const parsed = headerSchema.safeParse(raw);
  if (!parsed.success) fail('invalid-plugin-document');
  const h = parsed.data;
  const encoded = encodePluginDocument({ memoryId: h.memoryId, version: h.version, writeIntentId: h.writeIntentId,
    provenance: h.provenance, text: content.slice(newline + 1) });
  if (h.hash !== encoded.hash || title !== encoded.title || content !== encoded.content) fail('document-integrity-mismatch');
  return encoded;
}
/** Exact base name + exact JSON description are the owned namespace/marker.
 * Display names are not identities; never rename or merge an existing mismatch. */
export function bankIdentity(bank: BankTarget): { name: string; description: string } {
  validKey(bank.bankKey); validKey(bank.provisionMarker);
  if (bank.baseId !== undefined) validKey(bank.baseId);
  return {
    name: KNOWLEDGE_NAMESPACE + '/' + Buffer.from(bank.bankKey, 'utf8').toString('base64url'),
    description: JSON.stringify({ namespace: KNOWLEDGE_NAMESPACE, bankKey: bank.bankKey, provisionMarker: bank.provisionMarker }),
  };
}
/** Small literal-only query expansion, independent of knowledge's tokenizer.
 * Keep whole terms/Latin words, then overlapping CJK code-point bigrams. This
 * improves partial Chinese recall without claiming segmentation or semantics. */
export function lexicalQueryFeatures(query: string): string[] {
  if (typeof query !== 'string' || query.length > 4096) fail('lexical-budget');
  const normalized = query.normalize('NFKC').toLowerCase();
  const cjkRuns = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  const features = new Set<string>();
  const add = (term: string) => { if (features.size < 64) features.add(term); };
  for (const term of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) add(term);
  // Separate mixed strings such as "喜欢Tea" without losing the original term.
  for (const word of normalized.replace(cjkRuns, ' ').match(/[\p{L}\p{N}]+/gu) ?? []) add(word);
  for (const run of normalized.match(cjkRuns) ?? []) {
    const points = Array.from(run);
    if (points.length === 1) add(run);
    for (let i = 0; i + 1 < points.length && features.size < 64; i++) add(points[i]! + points[i + 1]!);
    if (features.size === 64) break;
  }
  return [...features];
}
function vectorState(doc: DocumentSummary, provider: string): VectorState {
  if (doc.embeddingError !== undefined || doc.status === 'failed') return 'failed';
  if (doc.embedded) return 'ready';
  // Published knowledge can label lexical-only completed text "pending" because no vector exists.
  // After verified full text, do not invent an embedding request when its effective provider is none.
  if (provider === 'none') return 'not_requested';
  if (doc.status === 'pending' || doc.status === 'processing') return 'pending';
  return 'unknown';
}

/** Parent owns durable intents, bank serialization/CAS, fencing and timeout registry.
 * This adapter never times out an add, retries it in a catch, activates a version,
 * or equates JS promise settlement with termination of an external server operation. */
export class KnowledgeAdapter {
  private readonly writes = new Map<string, WriteSettlement>();
  private readonly activeWrites = new Set<string>();
  constructor(private readonly service: PublicKnowledgeService,
    private readonly options: { isLive?: () => boolean } = {}) {
    for (const method of ['whenReady', 'listBases', 'createBase', 'getConfigFor', 'listDocuments',
      'addTextDocument', 'getDocument', 'readDocumentText', 'deleteDocument'] as const) {
      if (typeof service?.[method] !== 'function') fail('knowledge-public-api-unavailable');
    }
  }
  private async call<T>(code: string, work: () => T | Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (error instanceof KnowledgeAdapterError) throw error; fail(code); }
  }
  private async checked(check: () => void | Promise<void>): Promise<void> {
    // Caller guard failures may contain source text; do not propagate even an Error subclass.
    try { this.checkLive(); await check(); this.checkLive(); }
    catch { fail('knowledge-authorization-rejected'); }
  }
  private checkLive(check?: () => void | boolean | Promise<void>): void {
    let result: void | boolean | Promise<void>;
    try {
      if (this.options.isLive && this.options.isLive() !== true) fail('knowledge-authorization-rejected');
      result = check?.();
      // A reentrant guard may itself trigger owner-scope disposal.
      if (this.options.isLive && this.options.isLive() !== true) fail('knowledge-authorization-rejected');
    } catch { fail('knowledge-authorization-rejected'); }
    if (result && typeof result === 'object' && 'then' in result) {
      void Promise.resolve(result).catch(() => {});
      fail('knowledge-async-guard-unsupported');
    }
    if (result === false) fail('knowledge-authorization-rejected');
  }
  /** No await may separate this guard from the public service invocation. */
  private effect<T>(work: () => T, check?: () => void | boolean | Promise<void>): T {
    this.checkLive(check);
    return work();
  }
  private documentCheck(request: AuthorizedDocumentsRequest | LexicalRequest, ids: readonly string[],
    docs?: readonly VerifiedPluginDocument[]): () => void | boolean | Promise<void> {
    const selected = Object.freeze([...ids]);
    return request.validateLive ? () => request.validateLive!(selected, docs)
      : () => request.authorize(selected, docs);
  }
  private async ready(check?: () => void | boolean | Promise<void>): Promise<void> {
    await this.call('knowledge-unavailable', () => this.effect(() => this.service.whenReady(), check));
    this.checkLive(check);
  }
  private findBank(bank: BankTarget, check?: () => void | boolean | Promise<void>): string | undefined {
    const identity = bankIdentity(bank);
    const all = this.effect(() => this.service.listBases(), check); // Public 0.5.2 returns the FULL array, not TopK/pages.
    const candidates = all.filter(base => {
      if (base.name === identity.name || base.description === identity.description || base.id === bank.baseId) return true;
      // A marker elsewhere in the owned namespace is also a conflict, not a new-bank invitation.
      try {
        const meta: unknown = JSON.parse(base.description);
        if (meta && typeof meta === 'object' && 'namespace' in meta && meta.namespace === KNOWLEDGE_NAMESPACE) {
          return ('provisionMarker' in meta && meta.provisionMarker === bank.provisionMarker) ||
            ('bankKey' in meta && meta.bankKey === bank.bankKey);
        }
      } catch { /* Foreign descriptions need not be JSON. */ }
      return false;
    });
    if (candidates.length > 1) fail('bank-marker-ambiguous');
    const base = candidates[0];
    if (!base) return undefined;
    if (base.name !== identity.name || base.description !== identity.description ||
      (bank.baseId !== undefined && bank.baseId !== base.id)) fail('bank-namespace-mismatch');
    return base.id;
  }
  private assertSafeBank(bank: ProvisionedBank, check?: () => void | boolean | Promise<void>): void {
    if (this.findBank(bank, check) !== bank.baseId) fail('bank-not-found');
    const config = this.effect(() => this.service.getConfigFor(bank.baseId), check);
    if (config.autoRetrieve !== false || config.injectUsagePrompt !== false || config.autoRetrieveWeight !== 0) {
      fail('bank-proactive-not-disabled');
    }
  }
  /** Read-only recovery of an uncertain provisioning operation. Absence never creates a base. */
  async reconcileBank(bank: BankTarget, check: () => void = () => {}): Promise<ProvisionedBank | undefined> {
    return this.call('bank-reconcile-failed', async () => {
      await this.ready(check);
      const baseId = this.findBank(bank, check);
      if (baseId === undefined) return undefined;
      const result = { bankKey: bank.bankKey, provisionMarker: bank.provisionMarker, baseId };
      this.assertSafeBank(result, check);
      return result;
    });
  }
  async provisionBank(bank: BankTarget, check: () => void = () => {}): Promise<ProvisionedBank & { reused: boolean }> {
    return this.call('bank-provision-failed', async () => {
      await this.ready(check);
      const identity = bankIdentity(bank);
      let baseId = this.findBank(bank, check);
      const reused = baseId !== undefined;
      if (!baseId) {
        if (bank.baseId !== undefined) fail('bank-not-found');
        try {
          const created = await this.effect(() => this.service.createBase({ ...identity,
            config: { autoRetrieve: false, injectUsagePrompt: false, autoRetrieveWeight: 0 } }), check);
          baseId = created.id;
        } catch {
          // A create may have persisted before rejecting. Enumerate; never blindly create again.
          baseId = this.findBank(bank, check);
          if (!baseId) fail('bank-provision-reconcile-required');
        }
      }
      const result = { bankKey: bank.bankKey, provisionMarker: bank.provisionMarker, baseId, reused };
      this.assertSafeBank(result, check);
      return result;
    });
  }
  private readVerified(baseId: string, docId: string, check: () => void | boolean | Promise<void>): VerifiedPluginDocument {
    const doc = this.effect(() => this.service.getDocument(docId, { includeChunks: false, rawTextLimit: MAX_DOCUMENT_CHARS }), check);
    this.checkLive(check); // A reentrant service hook cannot authorize subsequent local body consumption.
    if (doc.id !== docId || doc.baseId !== baseId || doc.sourceType !== 'text') fail('document-scope-mismatch');
    if (doc.rawTextTruncated || doc.rawText === undefined || doc.rawText.length !== doc.charCount ||
      doc.charCount > MAX_DOCUMENT_CHARS) fail('document-text-incomplete');
    const decoded = decodePluginDocument(doc.title, doc.rawText);
    return { docId, baseId, header: decoded.header, hash: decoded.hash, text: decoded.text };
  }
  private validateEncoded(expected: EncodedPluginDocument): void {
    const actual = decodePluginDocument(expected.title, expected.content);
    if (actual.marker !== expected.marker || actual.hash !== expected.hash || actual.text !== expected.text ||
      JSON.stringify(actual.header) !== JSON.stringify(expected.header)) fail('document-intent-mismatch');
  }
  async reconcileDocument(bank: ProvisionedBank, expected: EncodedPluginDocument,
    check: () => void | Promise<void>): Promise<ReconciledDocument | undefined> {
    return this.call('document-reconcile-failed', async () => {
      this.checkLive(check);
      this.validateEncoded(expected);
      await this.checked(check);
      await this.ready(check);
      await this.checked(check);
      this.assertSafeBank(bank, check);
      const all = this.effect(() => this.service.listDocuments(bank.baseId), check); // Complete enumeration, never semantic search.
      const matches: DocumentSummary[] = [];
      for (const summary of all) {
        if (summary.baseId !== bank.baseId) fail('document-scope-mismatch');
        if (summary.title !== expected.marker && !summary.title.startsWith(expected.marker + ':')) continue;
        await this.checked(check);
        const actual = this.readVerified(bank.baseId, summary.id, check);
        if (actual.header.memoryId !== expected.header.memoryId || actual.header.version !== expected.header.version ||
          actual.header.writeIntentId !== expected.header.writeIntentId || actual.hash !== expected.hash ||
          summary.title !== expected.title) fail('document-marker-conflict');
        matches.push(summary);
        await this.checked(check);
      }
      await this.checked(check);
      matches.sort((a, b) => compare(a.id, b.id));
      const canonical = matches[0];
      if (!canonical) return undefined;
      return { docId: canonical.id, orphanDocIds: matches.slice(1).map(doc => doc.id),
        vectorState: vectorState(canonical, this.effect(() => this.service.getConfigFor(bank.baseId), check).embeddingProvider) };
    });
  }
  /** Validate the exact existing document without starting indexing. The parent owns repair
   * intent/fencing and tracks raw settlement independently of subsequent authority loss. */
  async prepareRepair(bank: ProvisionedBank, expected: EncodedPluginDocument, docId: string,
    check: () => void): Promise<PreparedRepair> {
    return this.call('knowledge-embedding-repair-prepare-failed', async () => {
      this.checkLive(check);
      validKey(docId);
      this.validateEncoded(expected);
      // Detach caller-owned inputs before the first asynchronous boundary.
      const selectedBank = { ...bank };
      const selectedExpected = decodePluginDocument(expected.title, expected.content);
      const reindex = this.service.reindexDocument;
      if (typeof reindex !== 'function') fail('knowledge-embedding-repair-unavailable');
      const reconciled = await this.reconcileDocument(selectedBank, selectedExpected, check);
      if (!reconciled || reconciled.docId !== docId) fail('knowledge-embedding-repair-document-mismatch');
      this.assertSafeBank(selectedBank, check);
      const actual = this.readVerified(selectedBank.baseId, docId, check);
      if (actual.hash !== selectedExpected.hash || actual.text !== selectedExpected.text ||
        JSON.stringify(actual.header) !== JSON.stringify(selectedExpected.header)) {
        fail('knowledge-embedding-repair-document-mismatch');
      }
      this.checkLive(check);
      let used = false;
      let invoked = false;
      return Object.freeze({
        docId,
        get invoked() { return invoked; },
        submit: (): Promise<void> => {
          if (used) fail('knowledge-embedding-repair-already-submitted');
          used = true; // A denied submission also consumes the port; never replay it.
          // Metadata only after preparation: no body reads or asynchronous authorization here.
          try {
            this.assertSafeBank(selectedBank, check);
            return this.effect(() => {
              invoked = true;
              let raw: ReturnType<NonNullable<PublicKnowledgeService['reindexDocument']>>;
              try { raw = reindex.call(this.service, docId, { mode: 'rechunk' }); }
              catch { fail('knowledge-embedding-repair-failed'); }
              // No timeout/root-abort race, post-authorization or provider-result consumption.
              return raw.then(() => {}, () => { fail('knowledge-embedding-repair-failed'); });
            }, check);
          } catch (error) {
            if (error instanceof KnowledgeAdapterError && ['knowledge-authorization-rejected',
              'knowledge-async-guard-unsupported', 'bank-marker-ambiguous', 'bank-namespace-mismatch',
              'bank-not-found', 'bank-proactive-not-disabled'].includes(error.code)) throw error;
            fail('knowledge-embedding-repair-failed');
          }
        },
      });
    });
  }
  /** Trusted owner-only maintenance, NOT a source-read ACL or retrieval path. Reads full
   * plugin text locally only to verify integrity; returns no body/content/title. Parent must
   * fence concurrent writes and establish external-write convergence before claiming purged. */
  async enumeratePluginDocuments(bank: ProvisionedBank,
    check: () => void | Promise<void>): Promise<PluginDocumentMetadata[]> {
    return this.call('document-enumeration-failed', async () => {
      await this.checked(check);
      await this.ready(check);
      await this.checked(check);
      this.assertSafeBank(bank, check);
      const all = this.effect(() => this.service.listDocuments(bank.baseId), check); // FULL scoped snapshot, no TopK/search.
      const documents: PluginDocumentMetadata[] = [];
      const seen = new Set<string>();
      for (const summary of all) {
        if (summary.baseId !== bank.baseId) fail('document-scope-mismatch');
        // Other users' clearly foreign documents are untouched and their bodies never read.
        if (!summary.title.startsWith('dsh-onebot-memory')) continue;
        if (!summary.title.startsWith(TITLE_PREFIX) || summary.sourceType !== 'text') fail('invalid-plugin-document');
        if (seen.has(summary.id)) fail('document-enumeration-ambiguous');
        seen.add(summary.id);
        await this.checked(check);
        const verified = this.readVerified(bank.baseId, summary.id, check);
        const marker = recoveryMarker(verified.header.memoryId, verified.header.version, verified.header.writeIntentId);
        if (summary.title !== marker + ':' + verified.hash) fail('document-marker-conflict');
        documents.push({ docId: verified.docId, baseId: verified.baseId, header: verified.header, hash: verified.hash,
          vectorState: vectorState(summary, this.effect(() => this.service.getConfigFor(bank.baseId), check).embeddingProvider) });
        await this.checked(check);
      }
      await this.checked(check);
      this.assertSafeBank(bank, check);
      return documents.sort((a, b) => compare(a.docId, b.docId));
    });
  }
  /** Tracker has no plaintext, provider exception or promise rejection payload. Keep until parent
   * has converged the intent; a timeout must NOT clear it or authorize another append. */
  getWriteSettlement(writeIntentId: string): WriteSettlement | undefined { return this.writes.get(writeIntentId); }
  /** Parent calls ONLY after durable intent/cleanup convergence. Drops settled registry
   * metadata, never documents/intents or proof of external termination. Unknown is a no-op. */
  releaseWriteSettlement(writeIntentId: string): void {
    validKey(writeIntentId);
    if (this.activeWrites.has(writeIntentId) || this.writes.get(writeIntentId)?.state === 'pending') {
      fail('document-write-in-flight');
    }
    this.writes.delete(writeIntentId);
  }
  async writeDocument(bank: ProvisionedBank, expected: EncodedPluginDocument,
    check: () => void | Promise<void>): Promise<ReconciledDocument & { reused: boolean }> {
    return this.call('document-write-failed', async () => {
      this.checkLive(check);
      this.validateEncoded(expected);
      const intentId = expected.header.writeIntentId;
      if (this.activeWrites.has(intentId)) fail('document-write-in-flight');
      this.activeWrites.add(intentId); // Reserve before the first await, even for immediately settled services.
      try {
        const prior = this.writes.get(intentId);
        if (prior?.state === 'pending') fail('document-write-in-flight');
        const found = await this.reconcileDocument(bank, expected, check);
        if (found) return { ...found, reused: true };
        await this.checked(check);
        this.assertSafeBank(bank, check); // Effective proactive configuration and live authority before body write.
        let promise: Promise<KnowledgeDocument>;
        try { promise = this.effect(() => this.service.addTextDocument({ baseId: bank.baseId, title: expected.title, content: expected.content }), check); }
        catch {
          const recovered = await this.reconcileDocument(bank, expected, check);
          if (recovered) return { ...recovered, reused: true };
          fail('document-write-reconcile-required');
        }
        let state: WriteSettlement['state'] = 'pending';
        const settled = promise.then(() => { state = 'fulfilled'; return 'fulfilled' as const; },
          () => { state = 'rejected'; return 'rejected' as const; });
        this.writes.set(intentId, { get state() { return state; }, settled });
        let rejected = false;
        try { await promise; } catch { rejected = true; }
        // Includes embedding failure after rawText was durably saved. Never append in this catch.
        const recovered = await this.reconcileDocument(bank, expected, check);
        if (!recovered) fail('document-write-reconcile-required');
        return { ...recovered, reused: rejected };
      } finally { this.activeWrites.delete(intentId); }
    });
  }
  /** Public full-body read for already-authorized graph/time candidates. No query ranking,
   * graph traversal or candidate enumeration. All service reads stay inside the supplied IDs. */
  async readAuthorizedDocuments(request: AuthorizedDocumentsRequest): Promise<readonly VerifiedPluginDocument[]> {
    if (request.docIds.length === 0) return []; // Includes ZERO readiness/config/base reads.
    return this.call('authorized-document-read-failed', async () => {
      const ids = [...new Set(request.docIds)].sort(compare);
      ids.forEach(validKey);
      if (ids.length > MAX_RETRIEVAL_DOCS) fail('document-read-budget');
      const bank = { ...request.bank };
      const callback = request.authorize;
      const authorize = (selected: readonly string[], docs?: readonly VerifiedPluginDocument[]) =>
        this.checked(() => callback(Object.freeze([...selected]), docs));
      await authorize(ids);
      const check = this.documentCheck(request, ids);
      await this.ready(check);
      await authorize(ids);
      this.assertSafeBank(bank, check);
      const documents: VerifiedPluginDocument[] = [];
      let chars = 0;
      for (const docId of ids) {
        await authorize([docId]);
        const document = this.readVerified(bank.baseId, docId, this.documentCheck(request, [docId]));
        chars += document.text.length;
        if (chars > MAX_RETRIEVAL_CHARS) fail('document-read-budget');
        await authorize([docId], structuredClone([document]));
        this.checkLive(this.documentCheck(request, [docId], structuredClone([document])));
        documents.push(document);
      }
      // Guards get only detached copies; final validation covers every body read, not TopK.
      await authorize(ids, structuredClone(documents));
      this.assertSafeBank(bank, this.documentCheck(request, ids, structuredClone(documents)));
      return documents;
    });
  }
  async retrieveLexical(request: LexicalRequest): Promise<{ mode: 'local-lexical'; hits: LexicalHit[] }> {
    // No readiness/config/list/read/search call for an empty host-authorized set.
    if (request.docIds.length === 0) return { mode: 'local-lexical', hits: [] };
    return this.call('lexical-retrieval-failed', async () => {
      const ids = [...new Set(request.docIds)].sort(compare);
      ids.forEach(validKey);
      if (ids.length > MAX_RETRIEVAL_DOCS || typeof request.query !== 'string' || request.query.length > 4096) fail('lexical-budget');
      const topK = request.topK ?? 20;
      if (!Number.isSafeInteger(topK) || topK < 1 || topK > MAX_RETRIEVAL_DOCS) fail('lexical-budget');
      const authorize = (selected: readonly string[], docs?: readonly VerifiedPluginDocument[]) =>
        this.checked(() => request.authorize(Object.freeze([...selected]), docs));
      await authorize(ids);
      const check = this.documentCheck(request, ids);
      await this.ready(check);
      await authorize(ids);
      this.assertSafeBank(request.bank, check);
      const terms = lexicalQueryFeatures(request.query);
      const documents: VerifiedPluginDocument[] = [];
      let chars = 0;
      for (const docId of ids) {
        await authorize([docId]); // No unauthorized body/metadata reads, including after an await.
        const doc = this.readVerified(request.bank.baseId, docId, this.documentCheck(request, [docId]));
        chars += doc.text.length;
        if (chars > MAX_RETRIEVAL_CHARS) fail('lexical-budget');
        // Callback receives a detached copy: mutating it cannot replace verified evidence.
        await authorize([docId], structuredClone([doc]));
        this.checkLive(this.documentCheck(request, [docId], structuredClone([doc])));
        documents.push(doc);
      }
      const hits = documents.map(doc => {
        const text = doc.text.normalize('NFKC').toLowerCase();
        let score = 0;
        for (const term of terms) {
          let start = 0;
          for (let occurrences = 0; occurrences < 32; occurrences++) {
            const found = text.indexOf(term, start);
            if (found < 0) break;
            score++;
            start = found + term.length;
          }
        }
        return { ...doc, score };
      }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || compare(a.docId, b.docId)).slice(0, topK);
      // Revalidate *all read dependencies*, not merely final TopK, after asynchronous guards.
      await authorize(ids, structuredClone(documents));
      await authorize(hits.map(hit => hit.docId), structuredClone(hits));
      this.checkLive(this.documentCheck(request, ids, structuredClone(documents)));
      return { mode: 'local-lexical', hits };
    });
  }
  /** Idempotent cleanup must still be fenced by the parent. No recursive directories. */
  async deleteDocument(bank: ProvisionedBank, docId: string, check: () => void | Promise<void>): Promise<void> {
    await this.call('document-delete-failed', async () => {
      await this.checked(check);
      await this.ready(check);
      await this.checked(check);
      this.assertSafeBank(bank, check);
      const all = this.effect(() => this.service.listDocuments(bank.baseId), check);
      const summary = all.find(doc => doc.id === docId);
      if (!summary) return;
      if (summary.baseId !== bank.baseId || !summary.title.startsWith(TITLE_PREFIX) || summary.sourceType !== 'text') {
        fail('document-delete-scope-mismatch');
      }
      // Verify ownership marker before deletion, but no activation/ACL claim is inferred from it.
      this.readVerified(bank.baseId, docId, check);
      await this.checked(check);
      await this.effect(() => this.service.deleteDocument(docId), check);
      await this.checked(check);
      this.checkLive(check);
    });
  }
}
