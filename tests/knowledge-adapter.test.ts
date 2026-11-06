import test from 'node:test';
import assert from 'node:assert/strict';
import type { KnowledgeDocument, DocumentSummary } from 'dsh-knowledge/knowledge';
import { KnowledgeAdapter, bankIdentity, canonicalDocumentHash, decodePluginDocument, encodePluginDocument, lexicalQueryFeatures } from '../src/memory/knowledge.js';
import type { BankTarget, EncodedPluginDocument, ProvisionedBank, PublicKnowledgeService } from '../src/memory/knowledge.js';
import type { Provenance } from '../src/storage/model.js';

const provenance: Provenance = { complete: true, sourceRefs: [{ sourceId: 'group-A', sourceEpoch: 1 }],
  messageKeys: ['message-1'], dependencyVersions: [] };
const target: BankTarget = { bankKey: '["100","persona-A"]', provisionMarker: 'host-bank-intent-1' };
const check = () => {};
function encoded(overrides: Partial<Parameters<typeof encodePluginDocument>[0]> = {}): EncodedPluginDocument {
  return encodePluginDocument({ memoryId: 'raw-1', version: 1, writeIntentId: 'write-1', provenance,
    text: '喜欢喝茶 tea preference', ...overrides });
}
/** Entirely in-memory fault mock. No real knowledge service, model, network or database. */
class KnowledgeMock implements PublicKnowledgeService {
  calls: string[] = [];
  bases: ReturnType<PublicKnowledgeService['listBases']> = [];
  docs = new Map<string, KnowledgeDocument>();
  statuses = new Map<string, Pick<DocumentSummary, 'embedded' | 'status' | 'embeddingError'>>();
  failAdd: 'none' | 'before' | 'after' = 'none';
  failCreateAfter = false;
  overrideProactive = false;
  truncate = false;
  throwRead = false;
  nextDocId: string | undefined;
  onAdd: (() => Promise<void>) | undefined;
  afterRead: (() => void) | undefined;
  configProvider = 'none';
  reindexCalls: { id: string; options: Parameters<NonNullable<PublicKnowledgeService['reindexDocument']>>[1] }[] = [];
  onReindex: NonNullable<PublicKnowledgeService['reindexDocument']> | undefined;
  reindexDocument(id: string, options?: Parameters<NonNullable<PublicKnowledgeService['reindexDocument']>>[1]): ReturnType<NonNullable<PublicKnowledgeService['reindexDocument']>> {
    this.calls.push(`reindex:${id}`);
    this.reindexCalls.push({ id, options });
    if (this.onReindex) return this.onReindex(id, options);
    const doc = this.docs.get(id);
    assert.ok(doc);
    return Promise.resolve(doc);
  }
  async whenReady(): Promise<void> { this.calls.push('ready'); }
  listBases(): ReturnType<PublicKnowledgeService['listBases']> { this.calls.push('listBases'); return structuredClone(this.bases); }
  async createBase(request: Parameters<PublicKnowledgeService['createBase']>[0]): ReturnType<PublicKnowledgeService['createBase']> {
    this.calls.push('createBase');
    assert.deepEqual(request.config, { autoRetrieve: false, injectUsagePrompt: false, autoRetrieveWeight: 0 });
    const base = { id: `base-${this.bases.length + 1}`, name: request.name, description: request.description ?? '',
      config: request.config, documentCount: 0, storedDocCount: 0, chunkCount: 0, charCount: 0, tokenCount: 0,
      createdAt: 1, updatedAt: 1 };
    // The public create request's optional config is omitted, not materialized as undefined.
    const stored = { ...base, config: request.config ?? {} };
    this.bases.push(stored);
    if (this.failCreateAfter) throw new Error('PROVIDER_SECRET create persisted');
    return stored;
  }
  getConfigFor(baseId?: string): ReturnType<PublicKnowledgeService['getConfigFor']> {
    this.calls.push('config');
    const config = this.bases.find(base => base.id === baseId)?.config ?? {};
    // Only fields inspected by adapter: deliberate mock of the public effective configuration.
    return { ...config, embeddingProvider: this.configProvider,
      ...(this.overrideProactive ? { autoRetrieve: true } : {}) } as ReturnType<PublicKnowledgeService['getConfigFor']>;
  }
  listDocuments(baseId: string): DocumentSummary[] {
    this.calls.push('listDocuments');
    return [...this.docs.values()].filter(doc => doc.baseId === baseId).map(doc => ({
      id: doc.id, baseId: doc.baseId, title: doc.title, sourceType: doc.sourceType,
      charCount: doc.charCount, chunkCount: doc.chunkCount, createdAt: doc.createdAt,
      embedded: false, ...this.statuses.get(doc.id),
    }));
  }
  put(bank: ProvisionedBank, value: EncodedPluginDocument, id: string): KnowledgeDocument {
    const doc: KnowledgeDocument = { id, baseId: bank.baseId, title: value.title, sourceType: 'text',
      rawText: value.content, charCount: value.content.length, chunkCount: 1, createdAt: 1 };
    this.docs.set(id, doc);
    return doc;
  }
  async addTextDocument(request: Parameters<PublicKnowledgeService['addTextDocument']>[0]): ReturnType<PublicKnowledgeService['addTextDocument']> {
    this.calls.push('add');
    const config = this.getConfigFor(request.baseId);
    assert.equal(config.autoRetrieve, false, 'proactive disabled before any body is saved');
    assert.equal(config.injectUsagePrompt, false);
    assert.equal(config.autoRetrieveWeight, 0);
    if (this.failAdd === 'before') throw new Error('PROVIDER_SECRET no body');
    const id = this.nextDocId ?? `doc-${this.docs.size + 1}`;
    const doc: KnowledgeDocument = { id, baseId: request.baseId, title: request.title, sourceType: 'text',
      rawText: request.content, charCount: request.content.length, chunkCount: 0, createdAt: 1 };
    this.docs.set(id, doc);
    if (this.onAdd) await this.onAdd();
    if (this.failAdd === 'after') {
      this.statuses.set(id, { embedded: false, status: 'failed', embeddingError: 'PROVIDER_SECRET embedding failed' });
      throw new Error('PROVIDER_SECRET embedding failed after save');
    }
    return doc;
  }
  getDocument(id: string, options?: Parameters<PublicKnowledgeService['getDocument']>[1]): ReturnType<PublicKnowledgeService['getDocument']> {
    this.calls.push(`read:${id}`);
    assert.equal(options?.includeChunks, false, 'no hidden chunks/neighbor context');
    if (this.throwRead) throw new Error('PRIVATE_SECRET read error');
    const doc = this.docs.get(id);
    assert.ok(doc, 'mock document exists');
    const rawText = doc.rawText ?? '';
    const limit = this.truncate ? 10 : options?.rawTextLimit ?? rawText.length;
    const result = { id: doc.id, baseId: doc.baseId, title: doc.title, sourceType: doc.sourceType,
      rawText: rawText.slice(0, limit), charCount: doc.charCount, chunkCount: doc.chunkCount, createdAt: doc.createdAt,
      ...(limit < rawText.length ? { rawTextTruncated: true } : {}) };
    this.afterRead?.();
    return result;
  }
  readDocumentText(_id: string): ReturnType<PublicKnowledgeService['readDocumentText']> {
    this.calls.push('readDocumentText');
    throw new Error('Unexpected alternative text reader');
  }
  async deleteDocument(id: string): Promise<void> { this.calls.push(`delete:${id}`); this.docs.delete(id); }
  // Extra tripwires are intentionally outside PublicKnowledgeService: adapter cannot use them.
  async search(): Promise<never> { this.calls.push('SEARCH_SECRET'); throw new Error('No search allowed'); }
  async model(): Promise<never> { this.calls.push('MODEL_SECRET'); throw new Error('No model allowed'); }
  async rerank(): Promise<never> { this.calls.push('RERANK_SECRET'); throw new Error('No rerank allowed'); }
}
async function fixture() {
  const service = new KnowledgeMock();
  const adapter = new KnowledgeAdapter(service);
  const bank = await adapter.provisionBank(target);
  service.calls.length = 0;
  return { service, adapter, bank };
}

test('v1 UTF8 canonical hash excludes host recovery IDs and stabilizes provenance sets/newlines', () => {
  const p: Provenance = { complete: true,
    sourceRefs: [{ sourceId: 'z', sourceEpoch: 2 }, { sourceId: 'a', sourceEpoch: 1 }, { sourceId: 'a', sourceEpoch: 1 }],
    messageKeys: ['m2', 'm1', 'm2'], dependencyVersions: [{ memoryId: 'z', version: 2 }, { memoryId: 'a', version: 1 }] };
  const reversed: Provenance = { ...p, sourceRefs: [...p.sourceRefs].reverse(), messageKeys: ['m1', 'm2'],
    dependencyVersions: [...p.dependencyVersions].reverse() };
  assert.equal(canonicalDocumentHash('汉字\r\n😀  ', p), canonicalDocumentHash('汉字\n😀  ', reversed));
  const first = encoded({ provenance: p, text: ' tea\r\n\r\n\r\nend ' });
  const other = encoded({ memoryId: 'other', version: 9, writeIntentId: 'other-intent', provenance: reversed, text: first.text });
  assert.equal(first.hash, other.hash);
  assert.notEqual(first.marker, other.marker);
  assert.equal(first.text, ' tea\n\n\nend ');
  assert.deepEqual(decodePluginDocument(first.title, first.content), first);
});

test('canonical provenance rejects contradictory dependency versions but deduplicates identical dependencies', () => {
  const conflicting: Provenance = { ...provenance, dependencyVersions: [
    { memoryId: 'fact-1', version: 1 }, { memoryId: 'fact-1', version: 2 },
  ] };
  assert.throws(() => encoded({ provenance: conflicting }), /conflicting-dependency-versions/);
  assert.throws(() => canonicalDocumentHash('tea', conflicting), /conflicting-dependency-versions/);
  const duplicate: Provenance = { ...provenance, dependencyVersions: [
    { memoryId: 'fact-1', version: 1 }, { memoryId: 'fact-1', version: 1 },
  ] };
  const single: Provenance = { ...provenance, dependencyVersions: [{ memoryId: 'fact-1', version: 1 }] };
  assert.equal(canonicalDocumentHash('tea', duplicate), canonicalDocumentHash('tea', single));
  assert.deepEqual(encoded({ provenance: duplicate }).header.provenance.dependencyVersions, single.dependencyVersions);
});

test('model marker-looking text is data, and altered body/header/hash cannot pass verification', () => {
  const text = 'DSH_ONEBOT_MEMORY_V1 {"memoryId":"model-controlled","hash":"fake"}\nquoted marker';
  const doc = encoded({ text });
  assert.equal(decodePluginDocument(doc.title, doc.content).header.memoryId, 'raw-1');
  assert.equal(decodePluginDocument(doc.title, doc.content).text, text);
  assert.throws(() => decodePluginDocument(doc.title, doc.content + 'tampered'), /document-integrity-mismatch/);
  assert.throws(() => decodePluginDocument(doc.title.replace(/.$/, 'x'), doc.content), /document-integrity-mismatch/);
  assert.throws(() => encodePluginDocument({ ...doc.header, provenance: { ...provenance, sourceRefs: [] }, text: 'x' }), /invalid-document-provenance/);
  assert.throws(() => encoded({ provenance: { ...provenance, sourceRefs: [
    { sourceId: 's', sourceEpoch: 1 }, { sourceId: 's', sourceEpoch: 2 },
  ] } }), /conflicting-source-epochs/);
});

test('provision creates empty proactive-off base then verifies effective config before text', async () => {
  const f = await fixture();
  assert.equal(f.service.docs.size, 0);
  await f.adapter.writeDocument(f.bank, encoded(), check);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
  assert.ok(f.service.calls.indexOf('config') < f.service.calls.indexOf('add'));
  f.service.overrideProactive = true;
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded({ writeIntentId: 'write-2' }), check), /bank-proactive-not-disabled/);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
});

test('ineffective proactive overrides refuse even an empty new bank; never modify other bases', async () => {
  const service = new KnowledgeMock();
  service.overrideProactive = true;
  const adapter = new KnowledgeAdapter(service);
  await assert.rejects(adapter.provisionBank(target), /bank-proactive-not-disabled/);
  assert.equal(service.docs.size, 0);
  assert.equal(service.calls.includes('add'), false);
});

test('full listBases exact marker recovers create persisted before crash/rejection', async () => {
  const service = new KnowledgeMock();
  // A long unrelated directory is not a semantic/TopK query.
  for (let n = 0; n < 150; n++) service.bases.push({ id: `foreign-${n}`, name: `foreign ${n}`, description: '',
    documentCount: 0, storedDocCount: 0, chunkCount: 0, charCount: 0, tokenCount: 0, createdAt: 1, updatedAt: 1 });
  service.failCreateAfter = true;
  const adapter = new KnowledgeAdapter(service);
  const bank = await adapter.provisionBank(target);
  assert.equal(bank.baseId, 'base-151');
  const restored = await new KnowledgeAdapter(service).provisionBank(target);
  assert.equal(restored.baseId, bank.baseId);
  assert.equal(restored.reused, true);
  assert.equal(service.calls.filter(call => call === 'createBase').length, 1);
});

test('ambiguous exact banks, mismatched namespace, marker reuse and bound ID conflicts refuse', async () => {
  const f = await fixture();
  const original = f.service.bases[0]!;
  f.service.bases.push({ ...original, id: 'duplicate' });
  await assert.rejects(f.adapter.provisionBank(target), /bank-marker-ambiguous/);
  f.service.bases.pop();
  f.service.bases[0] = { ...original, name: 'foreign-name' };
  await assert.rejects(f.adapter.provisionBank(target), /bank-namespace-mismatch/);
  f.service.bases[0] = { ...original, ...bankIdentity({ bankKey: 'different-bank', provisionMarker: target.provisionMarker }) };
  await assert.rejects(f.adapter.provisionBank(target), /bank-namespace-mismatch/);
  f.service.bases[0] = original;
  await assert.rejects(f.adapter.provisionBank({ ...target, baseId: 'wrong-base' }), /bank-namespace-mismatch/);
  assert.equal(f.service.calls.includes('createBase'), false);
});

test('full document enumeration recovers crash before local docId commit, never appends again', async () => {
  const f = await fixture();
  const wanted = encoded();
  for (let n = 0; n < 150; n++) f.service.put(f.bank, encoded({ memoryId: `unrelated-${n}`, writeIntentId: `intent-${n}` }), `unrelated-${n}`);
  f.service.put(f.bank, wanted, 'last-existing-document');
  const restored = new KnowledgeAdapter(f.service);
  const result = await restored.writeDocument(f.bank, wanted, check);
  assert.equal(result.docId, 'last-existing-document');
  assert.equal(result.reused, true);
  assert.equal(f.service.calls.includes('add'), false);
  assert.deepEqual(f.service.calls.filter(call => call.startsWith('read:')), ['read:last-existing-document']);
  assert.equal(f.service.calls.includes('SEARCH_SECRET'), false);
});

test('embedding rejection after text save is reconciled, publicly readable and remains lexical evidence', async () => {
  const f = await fixture();
  f.service.failAdd = 'after';
  const doc = encoded();
  const result = await f.adapter.writeDocument(f.bank, doc, check);
  assert.equal(result.vectorState, 'failed');
  assert.equal(result.reused, true);
  const again = await f.adapter.writeDocument(f.bank, doc, check);
  assert.equal(again.docId, result.docId);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
  const found = await f.adapter.retrieveLexical({ bank: f.bank, docIds: [result.docId], query: '茶', authorize: check });
  assert.equal(found.mode, 'local-lexical');
  assert.equal(found.hits[0]?.text, doc.text);
  assert.equal(await f.adapter.getWriteSettlement('write-1')?.settled, 'rejected');
  assert.equal(f.adapter.getWriteSettlement('write-1')?.state, 'rejected');
});

test('pre-save rejection enumerates after catch, returns payload-free uncertain error and no catch append', async () => {
  const f = await fixture();
  f.service.failAdd = 'before';
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded(), check), error => {
    assert.equal(String(error).includes('PROVIDER_SECRET'), false);
    return /document-write-reconcile-required/.test(String(error));
  });
  assert.equal(f.service.calls.filter(call => call === 'listDocuments').length, 2);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
});

test('identical duplicate markers choose code-unit-sorted canonical docId and expose orphan IDs', async () => {
  const f = await fixture();
  const doc = encoded();
  for (const id of ['z-last', 'a-first', 'm-middle']) f.service.put(f.bank, doc, id);
  const result = await f.adapter.writeDocument(f.bank, doc, check);
  assert.equal(result.docId, 'a-first');
  assert.deepEqual(result.orphanDocIds, ['m-middle', 'z-last']);
  assert.equal(f.service.calls.includes('add'), false);
});

test('same marker different valid hashes quarantines instead of selecting or appending', async () => {
  const f = await fixture();
  const wanted = encoded();
  f.service.put(f.bank, wanted, 'good');
  const conflict = encoded({ text: 'PRIVATE_SECRET conflict' });
  assert.equal(conflict.marker, wanted.marker);
  f.service.put(f.bank, conflict, 'bad');
  await assert.rejects(f.adapter.writeDocument(f.bank, wanted, check), error => {
    assert.equal(String(error).includes('PRIVATE_SECRET'), false);
    return /document-marker-conflict/.test(String(error));
  });
  assert.equal(f.service.calls.includes('add'), false);
});

test('empty authorized set is zero service calls including readiness/base enumeration/search', async () => {
  const f = await fixture();
  let authorizations = 0;
  const result = await f.adapter.retrieveLexical({ bank: f.bank, docIds: [], query: 'secret',
    authorize() { authorizations++; } });
  assert.deepEqual(result, { mode: 'local-lexical', hits: [] });
  assert.deepEqual([...f.service.calls], []);
  assert.equal(authorizations, 0);
});

test('only explicitly authorized bodies read; unauthorized secret never enters model/rerank/search', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded({ text: 'tea allowed' }), 'allowed');
  f.service.put(f.bank, encoded({ memoryId: 'private', writeIntentId: 'private-intent', text: 'PRIVATE_SECRET tea' }), 'secret');
  const received: string[] = [];
  const result = await f.adapter.retrieveLexical({ bank: f.bank, docIds: ['allowed'], query: 'tea',
    authorize(ids, docs) {
      assert.ok(ids.every(id => id === 'allowed'));
      if (docs) received.push(JSON.stringify(docs));
    } });
  assert.equal(result.hits.length, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false);
  assert.equal(received.join().includes('PRIVATE_SECRET'), false);
  assert.deepEqual(f.service.calls.filter(call => call.startsWith('read:')), ['read:allowed']);
  for (const forbidden of ['SEARCH_SECRET', 'MODEL_SECRET', 'RERANK_SECRET', 'listDocuments']) {
    assert.equal(f.service.calls.includes(forbidden), false);
  }
  f.service.calls.length = 0;
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['secret'], query: 'tea',
    authorize() { throw new Error('PRIVATE_SECRET denied'); } }), /knowledge-authorization-rejected/);
  assert.deepEqual([...f.service.calls], []);
});

test('bounded local query features retain whole/Latin terms and code-point CJK bigrams', () => {
  const features = lexicalQueryFeatures('你还记得我喜欢什么吗 喜欢Tea');
  assert.ok(features.includes('你还记得我喜欢什么吗'));
  assert.ok(features.includes('喜欢tea'));
  assert.ok(features.includes('tea'));
  assert.ok(features.includes('喜欢'));
  assert.equal(new Set(features).size, features.length);
  const supplementary = lexicalQueryFeatures('𠀀𠀁𠀂');
  assert.deepEqual(supplementary, ['𠀀𠀁𠀂', '𠀀𠀁', '𠀁𠀂']);
  assert.equal(lexicalQueryFeatures(Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')).length, 64);
  assert.throws(() => lexicalQueryFeatures('x'.repeat(4097)), /lexical-budget/);
});

test('Chinese partial recall stays local and reads only explicitly authorized source bodies', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded({ text: '我喜欢茶' }), 'allowed');
  f.service.put(f.bank, encoded({ memoryId: 'secret', writeIntentId: 'secret-intent',
    text: 'PRIVATE_SECRET 你还记得我喜欢什么吗' }), 'secret');
  const result = await f.adapter.retrieveLexical({ bank: f.bank, docIds: ['allowed'], query: '你还记得我喜欢什么吗',
    authorize(ids) { assert.ok(ids.every(id => id === 'allowed')); } });
  assert.equal(result.mode, 'local-lexical');
  assert.equal(result.hits[0]?.docId, 'allowed');
  assert.equal(result.hits[0]?.text, '我喜欢茶');
  assert.ok((result.hits[0]?.score ?? 0) > 0);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false);
  assert.deepEqual(f.service.calls.filter(call => call.startsWith('read:')), ['read:allowed']);
  for (const forbidden of ['SEARCH_SECRET', 'MODEL_SECRET', 'RERANK_SECRET']) assert.equal(f.service.calls.includes(forbidden), false);
});

test('caller rechecks decoded metadata/hash; revocation after a public read suppresses all output', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded(), 'doc');
  let revoked = false;
  f.service.afterRead = () => { revoked = true; };
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['doc'], query: '茶',
    async authorize() { if (revoked) throw new Error('revoked'); }, validateLive: () => !revoked }), /knowledge-authorization-rejected/);
  f.service.afterRead = undefined;
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['doc'], query: '茶',
    authorize(_ids, docs) {
      if (docs) { assert.equal(docs[0]?.header.memoryId, 'raw-1'); throw new Error('stale active version'); }
    } }), /knowledge-authorization-rejected/);
});

test('authorization callback cannot replace verified output by mutating metadata copies', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded(), 'doc');
  const result = await f.adapter.retrieveLexical({ bank: f.bank, docIds: ['doc'], query: '茶',
    authorize(_ids, docs) { if (docs?.[0]) { docs[0].text = 'replacement'; docs[0].header.memoryId = 'forged'; } } });
  assert.equal(result.hits[0]?.header.memoryId, 'raw-1');
  assert.equal(result.hits[0]?.text, encoded().text);
});

test('truncated or incomplete public documents refuse rather than hashing/searching a partial body', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded(), 'doc');
  f.service.truncate = true;
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['doc'], query: '茶', authorize: check }), /document-text-incomplete/);
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded(), check), /document-text-incomplete/);
  f.service.truncate = false;
  const doc = f.service.docs.get('doc')!;
  f.service.docs.set('doc', { ...doc, charCount: doc.charCount + 1 });
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['doc'], query: '茶', authorize: check }), /document-text-incomplete/);
  assert.equal(f.service.calls.includes('add'), false);
});

test('wrong-base documents and raw provider errors are fail-closed and payload-free', async () => {
  const f = await fixture();
  f.service.put({ ...f.bank, baseId: 'another-base' }, encoded(), 'wrong');
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['wrong'], query: '茶', authorize: check }), /document-scope-mismatch/);
  f.service.throwRead = true;
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['wrong'], query: '茶', authorize: check }), error => {
    assert.equal(String(error).includes('PRIVATE_SECRET'), false);
    return /lexical-retrieval-failed/.test(String(error));
  });
});

test('pending underlying write settlement stays observable and prevents a parallel append', async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.service.onAdd = () => { entered(); return gate; };
  const operation = f.adapter.writeDocument(f.bank, encoded(), check);
  await started;
  const tracker = f.adapter.getWriteSettlement('write-1');
  assert.ok(tracker);
  assert.equal(tracker.state, 'pending');
  assert.throws(() => f.adapter.releaseWriteSettlement('write-1'), /document-write-in-flight/);
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded(), check), /document-write-in-flight/);
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
  release();
  const result = await operation;
  assert.equal(result.docId, 'doc-1');
  assert.equal(await tracker.settled, 'fulfilled');
  assert.equal(tracker.state, 'fulfilled');
});

test('settlement release refuses an active operation even after the raw write has settled', async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reconciling = new Promise<void>(resolve => { entered = resolve; });
  const ready = f.service.whenReady.bind(f.service);
  f.service.whenReady = async () => {
    await ready();
    if (f.adapter.getWriteSettlement('write-1')?.state === 'fulfilled') { entered(); await gate; }
  };
  const operation = f.adapter.writeDocument(f.bank, encoded(), check);
  await reconciling;
  assert.equal(f.adapter.getWriteSettlement('write-1')?.state, 'fulfilled');
  assert.throws(() => f.adapter.releaseWriteSettlement('write-1'), /document-write-in-flight/);
  release();
  await operation;
  const before = f.service.calls.length;
  f.adapter.releaseWriteSettlement('write-1'); // Simulates parent declaring durable reconciliation complete.
  assert.equal(f.adapter.getWriteSettlement('write-1'), undefined);
  assert.equal(f.service.docs.size, 1, 'release is metadata-only, not a document delete');
  f.adapter.releaseWriteSettlement('write-1'); // Idempotent for unknown/released IDs.
  assert.equal(f.service.calls.length, before);
});

test('rejected raw write registry metadata can be released after parent convergence', async () => {
  const f = await fixture();
  f.service.failAdd = 'before';
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded(), check), /document-write-reconcile-required/);
  assert.equal(f.adapter.getWriteSettlement('write-1')?.state, 'rejected');
  const before = f.service.calls.length;
  // Parent, not releaseWriteSettlement, must establish durable/external convergence.
  f.adapter.releaseWriteSettlement('write-1');
  assert.equal(f.adapter.getWriteSettlement('write-1'), undefined);
  assert.equal(f.service.calls.length, before);
});

test('late write after revocation cannot activate/return text; settled tracker still converges', async () => {
  const f = await fixture();
  let valid = true;
  f.service.onAdd = async () => { valid = false; };
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded(), () => { if (!valid) throw new Error('revoked'); }), /knowledge-authorization-rejected/);
  assert.equal(f.service.docs.size, 1, 'parent must reconcile/delete late external body; adapter does not pretend purged');
  assert.equal(await f.adapter.getWriteSettlement('write-1')?.settled, 'fulfilled');
});

test('concurrent fresh write calls reserve the intent before their first asynchronous guard', async () => {
  const f = await fixture();
  const first = f.adapter.writeDocument(f.bank, encoded(), check);
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded(), check), /document-write-in-flight/);
  await first;
  assert.equal(f.service.calls.filter(call => call === 'add').length, 1);
});

test('explicit candidate and text budgets refuse rather than performing unscoped fallback', async () => {
  const f = await fixture();
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank,
    docIds: Array.from({ length: 101 }, (_, i) => `id-${i}`), query: 'x', authorize: check }), /lexical-budget/);
  assert.deepEqual([...f.service.calls], []);
  await assert.rejects(f.adapter.retrieveLexical({ bank: f.bank, docIds: ['doc'], query: 'x', topK: 101, authorize: check }), /lexical-budget/);
  assert.deepEqual([...f.service.calls], []);
  assert.throws(() => encoded({ text: 'x'.repeat(131_073) }), /document-text-budget/);
});

test('reconciliation rejects a copied title whose header is a different host identity', async () => {
  const f = await fixture();
  const wanted = encoded();
  const different = encoded({ memoryId: 'other-memory' });
  f.service.put(f.bank, { ...different, title: wanted.title }, 'forged');
  await assert.rejects(f.adapter.writeDocument(f.bank, wanted, check), /document-integrity-mismatch/);
  assert.equal(f.service.calls.includes('add'), false);
});

test('cleanup is scoped, verified and idempotent for already-absent document', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded(), 'doc');
  await f.adapter.deleteDocument(f.bank, 'doc', check);
  await f.adapter.deleteDocument(f.bank, 'doc', check);
  assert.equal(f.service.calls.filter(call => call === 'delete:doc').length, 1);
  const foreign = { ...encoded(), title: 'ordinary admin document' };
  f.service.put(f.bank, foreign, 'foreign');
  await assert.rejects(f.adapter.deleteDocument(f.bank, 'foreign', check), /document-delete-scope-mismatch/);
  assert.ok(f.service.docs.has('foreign'));
});

test('read-only bank reconciliation of absent provisioning never creates or writes anything', async () => {
  const service = new KnowledgeMock();
  const adapter = new KnowledgeAdapter(service);
  assert.equal(await adapter.reconcileBank(target), undefined);
  assert.equal(await adapter.reconcileBank({ ...target, baseId: 'missing-base' }), undefined);
  assert.deepEqual(service.bases, []);
  assert.deepEqual([...service.docs], []);
  assert.ok(service.calls.includes('listBases'));
  assert.equal(service.calls.some(call => call === 'createBase' || call === 'add' || call.startsWith('delete:')), false);
});

test('read-only bank reconciliation uses full exact ownership and effective proactive checks', async () => {
  const f = await fixture();
  const owned = f.service.bases[0]!;
  for (let n = 0; n < 150; n++) f.service.bases.unshift({ ...owned, id: `foreign-${n}`, name: `foreign ${n}`, description: '' });
  assert.deepEqual(await f.adapter.reconcileBank(target), {
    bankKey: target.bankKey, provisionMarker: target.provisionMarker, baseId: f.bank.baseId,
  });
  f.service.overrideProactive = true;
  await assert.rejects(f.adapter.reconcileBank(target), /bank-proactive-not-disabled/);
  f.service.overrideProactive = false;
  f.service.bases.push({ ...owned, id: 'ambiguous-owned' });
  await assert.rejects(f.adapter.reconcileBank(target), /bank-marker-ambiguous/);
  f.service.bases.pop();
  f.service.bases[f.service.bases.length - 1] = { ...owned, name: 'mismatched-owned-name' };
  await assert.rejects(f.adapter.reconcileBank(target), /bank-namespace-mismatch/);
  assert.equal(f.service.calls.includes('createBase'), false);
  assert.equal(f.service.calls.includes('add'), false);
});

test('owner maintenance enumerates all owned metadata including forgotten IDs, never returns body or touches foreign docs', async () => {
  const f = await fixture();
  for (let n = 0; n < 151; n++) f.service.put(f.bank, encoded({ memoryId: `owned-${n}`, writeIntentId: `intent-${n}`,
    text: `FORGOTTEN_BODY_SECRET ${n}`, provenance: { complete: true,
      sourceRefs: [{ sourceId: 'forgotten-source', sourceEpoch: 1 }], messageKeys: [`message-${n}`], dependencyVersions: [] } }), `owned-${n}`);
  f.service.statuses.set('owned-150', { embedded: false, status: 'failed', embeddingError: 'PROVIDER_SECRET' });
  f.service.put(f.bank, { ...encoded({ text: 'FOREIGN_BODY_SECRET' }), title: 'ordinary admin note' }, 'foreign');
  let ownerChecks = 0;
  const documents = await f.adapter.enumeratePluginDocuments(f.bank, () => { ownerChecks++; });
  assert.equal(documents.length, 151, 'maintenance is complete enumeration, not retrieval TopK100');
  assert.ok(ownerChecks > documents.length);
  assert.equal(documents.find(doc => doc.docId === 'owned-150')?.vectorState, 'failed');
  assert.equal(documents[0]?.baseId, f.bank.baseId);
  assert.equal(documents[0]?.header.provenance.sourceRefs[0]?.sourceId, 'forgotten-source');
  assert.ok(documents.every(doc => Object.keys(doc).sort().join(',') === 'baseId,docId,hash,header,vectorState'));
  const serialized = JSON.stringify(documents);
  for (const secret of ['FORGOTTEN_BODY_SECRET', 'FOREIGN_BODY_SECRET', 'PROVIDER_SECRET']) assert.equal(serialized.includes(secret), false);
  assert.equal(f.service.calls.filter(call => call.startsWith('read:')).length, 151);
  assert.equal(f.service.calls.includes('read:foreign'), false);
  assert.ok(f.service.docs.has('foreign'));
  for (const forbidden of ['add', 'createBase', 'SEARCH_SECRET', 'MODEL_SECRET', 'RERANK_SECRET']) assert.equal(f.service.calls.includes(forbidden), false);
  assert.equal(f.service.calls.some(call => call.startsWith('delete:')), false);
});

test('maintenance refuses completeness for malformed owned marker, corrupt hash, non-text or truncated document', async () => {
  for (const fault of ['marker', 'body', 'type', 'truncated'] as const) {
    const f = await fixture();
    const value = encoded();
    const doc = f.service.put(f.bank, value, 'owned');
    if (fault === 'marker') f.service.docs.set('owned', { ...doc, title: 'dsh-onebot-memory/v9:malformed' });
    if (fault === 'body') f.service.docs.set('owned', { ...doc, rawText: value.content + 'CORRUPTED_SECRET', charCount: doc.charCount + 16 });
    if (fault === 'type') f.service.docs.set('owned', { ...doc, sourceType: 'file' });
    if (fault === 'truncated') f.service.truncate = true;
    await assert.rejects(f.adapter.enumeratePluginDocuments(f.bank, check), error => {
      assert.equal(String(error).includes('CORRUPTED_SECRET'), false);
      return /invalid-plugin-document|document-integrity-mismatch|document-text-incomplete/.test(String(error));
    });
    assert.ok(f.service.docs.has('owned'));
    assert.equal(f.service.calls.some(call => call.startsWith('delete:')), false);
  }
});

test('maintenance rejects a wrong-base enumeration row before reading its body', async () => {
  const f = await fixture();
  const foreign = f.service.put({ ...f.bank, baseId: 'wrong-base' }, encoded(), 'wrong');
  f.service.listDocuments = () => [{ id: foreign.id, baseId: foreign.baseId, title: foreign.title,
    sourceType: foreign.sourceType, charCount: foreign.charCount, chunkCount: foreign.chunkCount,
    embedded: false, createdAt: 1 }];
  await assert.rejects(f.adapter.enumeratePluginDocuments(f.bank, check), /document-scope-mismatch/);
  assert.equal(f.service.calls.some(call => call.startsWith('read:')), false);
});

test('maintenance owner guard denies before reads and suppresses metadata after owner revocation', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded({ text: 'FORGOTTEN_BODY_SECRET' }), 'owned');
  await assert.rejects(f.adapter.enumeratePluginDocuments(f.bank, () => { throw new Error('OWNER_SECRET'); }), /knowledge-authorization-rejected/);
  assert.deepEqual([...f.service.calls], []);
  let revoked = false;
  f.service.afterRead = () => { revoked = true; };
  await assert.rejects(f.adapter.enumeratePluginDocuments(f.bank, () => { if (revoked) throw new Error('OWNER_SECRET'); }), /knowledge-authorization-rejected/);
  assert.equal(f.service.calls.includes('read:owned'), true);
  assert.equal(f.service.calls.some(call => call.startsWith('delete:')), false);
});

test('graph/time selected documents are publicly read without a query or lexical-match requirement', async () => {
  const f = await fixture();
  const first = encoded({ memoryId: 'event-1', writeIntentId: 'event-intent', text: '去年五月搬到了上海' });
  const second = encoded({ memoryId: 'relation-1', writeIntentId: 'relation-intent', text: '小王是小李的同事' });
  f.service.put(f.bank, first, 'event');
  f.service.put(f.bank, second, 'relation');
  f.service.put(f.bank, encoded({ memoryId: 'secret', writeIntentId: 'secret-intent', text: 'UNAUTHORIZED_BODY_SECRET' }), 'secret');
  let verifiedAll = false;
  const documents = await f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['relation', 'event', 'event'],
    authorize(ids, docs) {
      assert.ok(ids.every(id => id === 'event' || id === 'relation'));
      if (docs?.length === 2) verifiedAll = true;
      if (docs?.[0]?.docId === 'event') assert.equal(docs[0].hash, first.hash);
    } });
  assert.deepEqual(documents.map(doc => [doc.docId, doc.text]), [['event', first.text], ['relation', second.text]]);
  assert.equal(verifiedAll, true);
  assert.deepEqual(f.service.calls.filter(call => call.startsWith('read:')), ['read:event', 'read:relation']);
  assert.equal(JSON.stringify(documents).includes('UNAUTHORIZED_BODY_SECRET'), false);
  for (const forbidden of ['listDocuments', 'SEARCH_SECRET', 'MODEL_SECRET', 'RERANK_SECRET', 'add']) assert.equal(f.service.calls.includes(forbidden), false);
});

test('empty authorized batch read performs zero service and callback calls', async () => {
  const f = await fixture();
  let checks = 0;
  const documents = await f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: [], authorize() { checks++; } });
  assert.deepEqual(documents, []);
  assert.equal(checks, 0);
  assert.deepEqual([...f.service.calls], []);
});

test('authorized batch guards deny before reads and suppress output immediately after revocation', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded(), 'first');
  f.service.put(f.bank, encoded({ memoryId: 'second', writeIntentId: 'second-intent' }), 'second');
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['first'],
    authorize() { throw new Error('AUTHORIZATION_SECRET'); } }), /knowledge-authorization-rejected/);
  assert.deepEqual([...f.service.calls], []);
  let revoked = false;
  f.service.afterRead = () => { revoked = true; };
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['first', 'second'],
    async authorize() { if (revoked) throw new Error('AUTHORIZATION_SECRET'); }, validateLive: () => !revoked }), /knowledge-authorization-rejected/);
  assert.deepEqual(f.service.calls.filter(call => call.startsWith('read:')), ['read:first']);
});

test('authorized batch uses detached guard metadata and snapshots IDs so caller mutation cannot widen reads', async () => {
  const f = await fixture();
  const value = encoded({ text: 'original authorized text' });
  f.service.put(f.bank, value, 'allowed');
  f.service.put(f.bank, encoded({ memoryId: 'secret', writeIntentId: 'secret-intent', text: 'UNAUTHORIZED_BODY_SECRET' }), 'secret');
  const ids = ['allowed'];
  const documents = await f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ids,
    authorize(selected, docs) {
      assert.deepEqual(selected, ['allowed']);
      ids.push('secret');
      if (docs?.[0]) { docs[0].text = 'FORGED_TEXT'; docs[0].header.memoryId = 'forged-memory'; }
    } });
  assert.equal(documents[0]?.text, value.text);
  assert.equal(documents[0]?.header.memoryId, value.header.memoryId);
  assert.deepEqual(f.service.calls.filter(call => call.startsWith('read:')), ['read:allowed']);
  const again = await f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['allowed'], authorize: check });
  assert.equal(again[0]?.text, value.text);
});

test('authorized batch final guard rechecks the whole dependency set after all public reads', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded(), 'a');
  f.service.put(f.bank, encoded({ memoryId: 'b', writeIntentId: 'b-intent' }), 'b');
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['a', 'b'],
    async authorize(ids, docs) {
      if (docs?.length === 2) { assert.deepEqual(ids, ['a', 'b']); throw new Error('changed version'); }
    }, validateLive: () => true }), /knowledge-authorization-rejected/);
  assert.deepEqual(f.service.calls.filter(call => call.startsWith('read:')), ['read:a', 'read:b']);
});

test('authorized batch enforces candidate bounds, proactive safety, full text and canonical integrity', async () => {
  const f = await fixture();
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank,
    docIds: Array.from({ length: 101 }, (_, i) => `doc-${i}`), authorize: check }), /document-read-budget/);
  assert.deepEqual([...f.service.calls], []);
  const value = encoded();
  const doc = f.service.put(f.bank, value, 'allowed');
  f.service.overrideProactive = true;
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['allowed'], authorize: check }), /bank-proactive-not-disabled/);
  assert.equal(f.service.calls.includes('read:allowed'), false);
  f.service.overrideProactive = false;
  f.service.truncate = true;
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['allowed'], authorize: check }), /document-text-incomplete/);
  f.service.truncate = false;
  f.service.docs.set('allowed', { ...doc, rawText: value.content + '!', charCount: doc.charCount + 1 });
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['allowed'], authorize: check }), /document-integrity-mismatch/);
  f.service.docs.set('allowed', { ...doc, baseId: 'wrong-base' });
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['allowed'], authorize: check }), /document-scope-mismatch/);
});

for (const lane of ['documents', 'lexical'] as const) {
  test(`${lane} rejects queued microtask revocation after async authorization before the first body effect`, async () => {
    const f = await fixture();
    f.service.put(f.bank, encoded(), 'allowed');
    let live = true; let authorizations = 0;
    const request = { bank: f.bank, docIds: ['allowed'], query: 'tea',
      async authorize() {
        if (++authorizations === 3) queueMicrotask(() => { live = false; });
      }, validateLive: () => live };
    const pending = lane === 'documents' ? f.adapter.readAuthorizedDocuments(request) : f.adapter.retrieveLexical(request);
    await assert.rejects(pending, /knowledge-authorization-rejected/);
    assert.equal(authorizations, 3);
    assert.equal(f.service.calls.some(call => call.startsWith('read:')), false);
    assert.equal(f.service.calls.some(call => call === 'add' || call.startsWith('delete:')), false);
  });
}

test('async authorization without an explicit synchronous validator fails closed before any service effect', async () => {
  const f = await fixture();
  f.service.put(f.bank, encoded(), 'allowed');
  await assert.rejects(f.adapter.readAuthorizedDocuments({ bank: f.bank, docIds: ['allowed'],
    async authorize() {} }), /knowledge-async-guard-unsupported/);
  assert.deepEqual([...f.service.calls], []);
  await assert.rejects(f.adapter.writeDocument(f.bank, encoded(), async () => {}), /knowledge-async-guard-unsupported/);
  assert.deepEqual([...f.service.calls], []);
});

test('global pull currentness and provisioning check both fence after readiness without watcher notifications', async () => {
  for (const authority of ['global', 'bank'] as const) {
    const service = new KnowledgeMock();
    let live = true;
    service.whenReady = async () => { service.calls.push('ready'); queueMicrotask(() => { live = false; }); };
    const adapter = new KnowledgeAdapter(service, authority === 'global' ? { isLive: () => live } : {});
    const bankCheck = () => { if (!live) throw new Error('revoked'); };
    await assert.rejects(adapter.provisionBank(target, authority === 'bank' ? bankCheck : check), /knowledge-authorization-rejected/);
    assert.deepEqual(service.calls, ['ready']);
    assert.equal(service.bases.length, 0);
  }
});

test('maintenance final synchronous guard blocks a body read after queued microtask revocation', async () => {
  const f = await fixture(); f.service.put(f.bank, encoded(), 'owned');
  let live = true; let queued = false;
  const guard = () => {
    if (!live) throw new Error('revoked');
    if (!queued && f.service.calls.at(-1) === 'listDocuments') {
      queued = true; queueMicrotask(() => { live = false; });
    }
  };
  await assert.rejects(f.adapter.enumeratePluginDocuments(f.bank, guard), /knowledge-authorization-rejected/);
  assert.equal(queued, true);
  assert.equal(f.service.calls.some(call => call.startsWith('read:')), false);
});

test('queued revocation at write/delete admission prevents the subsequent public mutation', async () => {
  for (const action of ['write', 'delete'] as const) {
    const f = await fixture();
    if (action === 'delete') f.service.put(f.bank, encoded(), 'owned');
    let live = true; let queued = false;
    const guard = () => {
      if (!live) throw new Error('revoked');
      const barrier = action === 'write' ? 'listDocuments' : 'read:owned';
      if (!queued && f.service.calls.at(-1) === barrier) {
        queued = true; queueMicrotask(() => { live = false; });
      }
    };
    const pending = action === 'write' ? f.adapter.writeDocument(f.bank, encoded(), guard)
      : f.adapter.deleteDocument(f.bank, 'owned', guard);
    await assert.rejects(pending, /knowledge-authorization-rejected/);
    assert.equal(queued, true);
    assert.equal(f.service.calls.includes('add'), false);
    assert.equal(f.service.calls.some(call => call.startsWith('delete:')), false);
  }
});

async function repairFixture() {
  const f = await fixture();
  const expected = encoded();
  f.service.configProvider = 'openai'; // Synthetic effective config only; no embedding implementation/network.
  f.service.put(f.bank, expected, 'repair-doc');
  f.service.calls.length = 0;
  return { ...f, expected };
}

test('repair preparation is read-only; frozen single-use port submits exactly one ID with rechunk only', async () => {
  const f = await repairFixture();
  f.service.put(f.bank, encoded({ memoryId: 'foreign', writeIntentId: 'foreign-intent' }), 'other-doc');
  const prepared = await f.adapter.prepareRepair(f.bank, f.expected, 'repair-doc', check);
  assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(Object.keys(prepared).sort(), ['docId', 'invoked', 'submit']);
  assert.equal(prepared.docId, 'repair-doc');
  assert.equal(prepared.invoked, false);
  assert.deepEqual(f.service.reindexCalls, []);
  assert.ok(f.service.calls.includes('ready'));
  assert.ok(f.service.calls.includes('read:repair-doc'));
  assert.equal(f.service.calls.includes('read:other-doc'), false);
  assert.equal(f.service.calls.some(call => call === 'add' || call === 'createBase' || call.startsWith('delete:')), false);
  f.service.calls.length = 0;
  f.service.onReindex = (id, options) => {
    assert.equal(prepared.invoked, true, 'invocation marker is set before entering SDK');
    assert.equal(id, 'repair-doc');
    assert.deepEqual(options, { mode: 'rechunk' });
    return Promise.resolve(f.service.docs.get(id)!);
  };
  assert.equal(await prepared.submit(), undefined);
  assert.equal(prepared.invoked, true);
  assert.deepEqual(f.service.reindexCalls, [{ id: 'repair-doc', options: { mode: 'rechunk' } }]);
  assert.throws(() => prepared.submit(), /knowledge-embedding-repair-already-submitted/);
  assert.equal(f.service.reindexCalls.length, 1);
  assert.equal(f.service.calls.some(call => call.startsWith('read:')), false, 'no body reads after returning prepared port');
  for (const forbidden of ['add', 'createBase', 'SEARCH_SECRET', 'MODEL_SECRET', 'RERANK_SECRET']) {
    assert.equal(f.service.calls.includes(forbidden), false);
  }
});

test('repair submit synchronously checks queued source/global/config changes and consumes denied port', async () => {
  for (const authority of ['source', 'global', 'config', 'namespace'] as const) {
    const f = await repairFixture();
    let sourceLive = true; let rootLive = true;
    const adapter = new KnowledgeAdapter(f.service, { isLive: () => rootLive });
    const guard = () => { if (!sourceLive) throw new Error('SOURCE_AUTH_SECRET'); };
    const prepared = await adapter.prepareRepair(f.bank, f.expected, 'repair-doc', guard);
    queueMicrotask(() => {
      if (authority === 'source') sourceLive = false;
      if (authority === 'global') rootLive = false;
      if (authority === 'config') f.service.overrideProactive = true;
      if (authority === 'namespace') f.service.bases[0] = { ...f.service.bases[0]!, name: 'foreign' };
    });
    await Promise.resolve();
    assert.throws(() => prepared.submit(), /knowledge-authorization-rejected|bank-proactive-not-disabled|bank-namespace-mismatch/);
    assert.equal(prepared.invoked, false);
    assert.deepEqual(f.service.reindexCalls, []);
    assert.throws(() => prepared.submit(), /knowledge-embedding-repair-already-submitted/);
  }
});

test('repair final operation guard is synchronous, rejects Promise guards and rechecks reentrant global disposal', async () => {
  for (const fault of ['promise', 'reentrant-root', 'final-check'] as const) {
    const f = await repairFixture();
    let rootLive = true; let final = false; let enabled = false;
    const adapter = new KnowledgeAdapter(f.service, { isLive: () => rootLive });
    const config = f.service.getConfigFor.bind(f.service);
    f.service.getConfigFor = id => { const result = config(id); if (enabled) final = true; return result; };
    const guard = () => {
      if (!final) return;
      if (fault === 'promise') return Promise.resolve();
      if (fault === 'reentrant-root') rootLive = false;
      if (fault === 'final-check') throw new Error('AUTH_SECRET');
    };
    const prepared = await adapter.prepareRepair(f.bank, f.expected, 'repair-doc', guard);
    enabled = true;
    assert.throws(() => prepared.submit(), /knowledge-authorization-rejected|knowledge-async-guard-unsupported/);
    assert.equal(prepared.invoked, false);
    assert.deepEqual(f.service.reindexCalls, []);
  }
});

test('repair raw pending settlement does not race root abort or perform post-return authorization/reads', async () => {
  for (const outcome of ['fulfill', 'reject'] as const) {
    const f = await repairFixture();
    let rootLive = true; let operationLive = true; let guards = 0;
    let resolve!: (doc: KnowledgeDocument) => void; let reject!: (error: Error) => void;
    const raw = new Promise<KnowledgeDocument>((yes, no) => { resolve = yes; reject = no; });
    f.service.onReindex = () => raw;
    const adapter = new KnowledgeAdapter(f.service, { isLive: () => rootLive });
    const prepared = await adapter.prepareRepair(f.bank, f.expected, 'repair-doc', () => {
      guards++; if (!operationLive) throw new Error('AUTH_SECRET');
    });
    const submitted = prepared.submit();
    let state = 'pending';
    void submitted.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
    const callsAtDispatch = [...f.service.calls]; const guardsAtDispatch = guards;
    rootLive = false; operationLive = false;
    await Promise.resolve(); await Promise.resolve();
    assert.equal(state, 'pending');
    assert.equal(prepared.invoked, true);
    if (outcome === 'fulfill') {
      resolve(f.service.docs.get('repair-doc')!);
      await submitted;
      assert.equal(state, 'fulfilled');
    } else {
      reject(new Error('PROVIDER_SECRET'));
      await assert.rejects(submitted, error => {
        assert.equal(String(error), 'KnowledgeAdapterError: knowledge-embedding-repair-failed');
        return true;
      });
      assert.equal(state, 'rejected');
    }
    assert.equal(guards, guardsAtDispatch);
    assert.deepEqual(f.service.calls, callsAtDispatch);
  }
});

test('repair synchronous SDK exceptions are scrubbed, mark invoked and cannot replay', async () => {
  const f = await repairFixture();
  f.service.onReindex = () => { throw new Error('PROVIDER_SECRET synchronous'); };
  const prepared = await f.adapter.prepareRepair(f.bank, f.expected, 'repair-doc', check);
  assert.throws(() => prepared.submit(), error => {
    assert.equal(String(error), 'KnowledgeAdapterError: knowledge-embedding-repair-failed');
    return true;
  });
  assert.equal(prepared.invoked, true);
  assert.throws(() => prepared.submit(), /knowledge-embedding-repair-already-submitted/);
  assert.equal(f.service.reindexCalls.length, 1);
});

test('repair preparation refuses absent optional capability without any mutation', async () => {
  const f = await repairFixture();
  Object.defineProperty(f.service, 'reindexDocument', { value: undefined });
  const adapter = new KnowledgeAdapter(f.service); // Legacy mocks remain supported for other operations.
  await assert.rejects(adapter.prepareRepair(f.bank, f.expected, 'repair-doc', check), /knowledge-embedding-repair-unavailable/);
  assert.deepEqual(f.service.calls, []);
  assert.deepEqual(f.service.reindexCalls, []);
});

test('repair preparation fails closed for empty/missing/foreign IDs, headers, hashes, full provenance and unsafe bank', async () => {
  for (const fault of ['empty', 'missing', 'foreign-id', 'foreign-base', 'foreign-title', 'header', 'hash', 'provenance',
    'proactive', 'namespace', 'truncated', 'read-error'] as const) {
    const f = await repairFixture();
    let docId = 'repair-doc';
    const doc = f.service.docs.get(docId)!;
    if (fault === 'empty') docId = '';
    if (fault === 'missing') { f.service.docs.clear(); }
    if (fault === 'foreign-id') {
      f.service.put(f.bank, encoded({ memoryId: 'foreign', writeIntentId: 'foreign-write' }), 'foreign');
      docId = 'foreign';
    }
    if (fault === 'foreign-base') f.service.docs.set(docId, { ...doc, baseId: 'foreign-base' });
    if (fault === 'foreign-title') f.service.docs.set(docId, { ...doc, title: 'ordinary admin document' });
    if (fault === 'header') {
      const other = encoded({ memoryId: 'FOREIGN_HEADER_SECRET' });
      f.service.docs.set(docId, { ...doc, rawText: other.content, charCount: other.content.length });
    }
    if (fault === 'hash') f.service.docs.set(docId, { ...doc, rawText: doc.rawText + 'CORRUPT_SECRET', charCount: doc.charCount + 14 });
    if (fault === 'provenance') {
      const other = encoded({ provenance: { ...provenance, messageKeys: ['FOREIGN_MESSAGE_SECRET'],
        dependencyVersions: [{ memoryId: 'foreign-dependency', version: 1 }] } });
      f.service.put(f.bank, other, docId);
    }
    if (fault === 'proactive') f.service.overrideProactive = true;
    if (fault === 'namespace') f.service.bases[0] = { ...f.service.bases[0]!, description: 'FOREIGN_NAMESPACE_SECRET' };
    if (fault === 'truncated') f.service.truncate = true;
    if (fault === 'read-error') f.service.throwRead = true;
    await assert.rejects(f.adapter.prepareRepair(f.bank, f.expected, docId, check), error => {
      assert.equal(String(error).includes('SECRET'), false);
      return true;
    }, fault);
    assert.deepEqual(f.service.reindexCalls, [], fault);
    assert.equal(f.service.calls.some(call => call === 'add' || call === 'createBase' || call.startsWith('delete:')), false, fault);
    if (fault === 'empty') assert.deepEqual(f.service.calls, []);
  }
});
