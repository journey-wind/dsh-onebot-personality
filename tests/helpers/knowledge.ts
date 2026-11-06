import assert from 'node:assert/strict';
import type { KnowledgeDocument, DocumentSummary } from 'dsh-knowledge/knowledge';
import type { PublicKnowledgeService } from '../../src/memory/knowledge.js';

/** Test-only public-service mock. No filesystem, model, HTTP or real DSH service access. */
export class InMemoryKnowledge implements PublicKnowledgeService {
  calls: string[] = [];
  bases: ReturnType<PublicKnowledgeService['listBases']> = [];
  readonly docs = new Map<string, KnowledgeDocument>();
  readonly statuses = new Map<string, Pick<DocumentSummary, 'embedded' | 'status' | 'embeddingError'>>();
  beforeAdd: (() => Promise<void>) | undefined;
  afterAdd: (() => Promise<void>) | undefined;
  afterCreate: (() => Promise<void>) | undefined;
  failEmbedding = false;
  failDelete = false;
  configProvider = 'none';
  readonly reindexCalls: { id: string; options: Parameters<NonNullable<PublicKnowledgeService['reindexDocument']>>[1] }[] = [];
  onReindex: NonNullable<PublicKnowledgeService['reindexDocument']> | undefined;
  private sequence = 0;
  async whenReady(): Promise<void> { this.calls.push('ready'); }
  listBases(): ReturnType<PublicKnowledgeService['listBases']> { this.calls.push('listBases'); return structuredClone(this.bases); }
  async createBase(request: Parameters<PublicKnowledgeService['createBase']>[0]): ReturnType<PublicKnowledgeService['createBase']> {
    this.calls.push('create');
    const base = { id: `base-${this.bases.length + 1}`, name: request.name, description: request.description ?? '', config: request.config ?? {},
      documentCount: 0, storedDocCount: 0, chunkCount: 0, charCount: 0, tokenCount: 0, createdAt: 1, updatedAt: 1 };
    this.bases.push(base);
    if (this.afterCreate) await this.afterCreate();
    return base;
  }
  getConfigFor(baseId?: string): ReturnType<PublicKnowledgeService['getConfigFor']> {
    this.calls.push('config');
    return { ...this.bases.find(base => base.id === baseId)?.config, embeddingProvider: this.configProvider } as ReturnType<PublicKnowledgeService['getConfigFor']>;
  }
  listDocuments(baseId: string): DocumentSummary[] {
    this.calls.push('listDocuments');
    return [...this.docs.values()].filter(doc => doc.baseId === baseId).map(doc => ({
      id: doc.id, baseId: doc.baseId, title: doc.title, sourceType: doc.sourceType, charCount: doc.charCount,
      chunkCount: doc.chunkCount, createdAt: doc.createdAt, embedded: false, ...this.statuses.get(doc.id),
    }));
  }
  async addTextDocument(request: Parameters<PublicKnowledgeService['addTextDocument']>[0]): ReturnType<PublicKnowledgeService['addTextDocument']> {
    this.calls.push('add');
    assert.equal(this.getConfigFor(request.baseId).autoRetrieve, false);
    if (this.beforeAdd) await this.beforeAdd();
    const id = `doc-${++this.sequence}`;
    const doc: KnowledgeDocument = { id, baseId: request.baseId, title: request.title, sourceType: 'text',
      rawText: request.content, charCount: request.content.length, chunkCount: 0, createdAt: 1 };
    this.docs.set(id, doc);
    if (this.afterAdd) await this.afterAdd();
    if (this.failEmbedding) {
      this.statuses.set(id, { embedded: false, status: 'failed', embeddingError: 'untrusted provider detail' });
      throw new Error('embedding failed after durable body');
    }
    return doc;
  }
  getDocument(id: string, options?: Parameters<PublicKnowledgeService['getDocument']>[1]): ReturnType<PublicKnowledgeService['getDocument']> {
    this.calls.push(`read:${id}`);
    const doc = this.docs.get(id);
    assert.ok(doc);
    const rawText = doc.rawText ?? '';
    const limit = options?.rawTextLimit ?? rawText.length;
    return { id, baseId: doc.baseId, title: doc.title, sourceType: doc.sourceType, charCount: doc.charCount,
      chunkCount: doc.chunkCount, createdAt: doc.createdAt, rawText: rawText.slice(0, limit), ...(limit < rawText.length ? { rawTextTruncated: true } : {}) };
  }
  readDocumentText(): ReturnType<PublicKnowledgeService['readDocumentText']> { throw new Error('unexpected alternate reader'); }
  reindexDocument(id: string, options?: Parameters<NonNullable<PublicKnowledgeService['reindexDocument']>>[1]): ReturnType<NonNullable<PublicKnowledgeService['reindexDocument']>> {
    this.calls.push(`reindex:${id}`);
    this.reindexCalls.push({ id, options });
    if (this.onReindex) return this.onReindex(id, options);
    const doc = this.docs.get(id);
    assert.ok(doc);
    this.statuses.set(id, { embedded: true, status: 'completed' });
    return Promise.resolve(doc);
  }
  async deleteDocument(id: string): Promise<void> {
    this.calls.push(`delete:${id}`);
    if (this.failDelete) throw new Error('private cleanup error');
    this.docs.delete(id);
  }
}

export class ManualDeadlines {
  private sequence = 0;
  private readonly pending = new Map<number, () => void>();
  schedule = (callback: () => void, _ms: number): (() => void) => {
    const id = ++this.sequence; this.pending.set(id, callback);
    return () => { this.pending.delete(id); };
  };
  expireAll(): void {
    const callbacks = [...this.pending.values()]; this.pending.clear();
    for (const callback of callbacks) callback();
  }
}
