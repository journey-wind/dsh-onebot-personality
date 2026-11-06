// Executed ONLY as a separate child process by knowledge-real.test.ts, never imported by the Host.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { Storage } from '@deepseek-ai/dsh-storage';
import { DomainFacility, descriptorOf } from '@deepseek-ai/dsh-storage-domain';
import { KnowledgeAdapter, encodePluginDocument } from '../../src/memory/knowledge.js';
import { exerciseNativePipeline } from './native-pipeline.js';

const input = process.argv[2]; assert.ok(input && isAbsolute(input));
const root = realpathSync.native(input); assert.equal(root, input);
assert.equal(dirname(root), realpathSync.native(tmpdir())); assert.equal(basename(root).startsWith('personality-knowledge-p6-'), true);
assert.ok(process.argv[3]); assert.equal(readFileSync(join(root, 'p6-child-permission'), 'utf8'), process.argv[3]);
// Knowledge probes its legacy DSH_HOME store even when chunkStorePath is explicit. Isolate BEFORE import.
process.env.DSH_HOME = root;
process.env.DSH_PROFILE = 'onebot-p6-isolated-child';
process.env.DSH_PROFILE_DIR = join(root, 'profile');
for (const name of ['metadata', 'chunks', 'models', 'profile']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_P6_CHILD'); };
const { KnowledgeService, Config, knowledgeDomainSpec } = await import('dsh-knowledge/knowledge');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
const descriptor = descriptorOf(knowledgeDomainSpec);
assert.equal(descriptor.name, 'knowledge'); assert.equal(descriptor.version, 0);
assert.ok(descriptor.layout === undefined || descriptor.layout === 'single');
const validated = await Config['~standard'].validate({ embeddingProvider: 'none', searchMode: 'lexical', embeddingBaseUrl: '', embeddingModel: '', embeddingApiKey: '',
  rerankModel: '', rerankBaseUrl: '', rerankApiKey: '', localModelCacheDir: join(root, 'models'),
  chunkStorePath: join(root, 'chunks', 'chunks.sqlite'), documentProcessorProvider: 'builtin', semanticChunk: false,
  imageCaptionProvider: 'off', urlRefreshHours: 0, resumeInterruptedOnStartup: false,
  autoRetrieve: false, injectUsagePrompt: false, autoRetrieveWeight: 0 });
assert.ok(!validated.issues);
// This published schema erases its Standard Schema output to unknown; narrow ONLY after successful public validation.
const config = validated.value as ConstructorParameters<typeof KnowledgeService>[1];

async function open() {
  const ctx = new Context(); const storage = new Storage(ctx);
  // Match the actual Host's public JSON knowledge backend. Plugin control/ledger still use strict owned SQLite.
  const backend = new JsonStorageBackend(join(root, 'metadata'));
  const unregister = storage.backend.register('p6_knowledge', backend);
  const facility = new DomainFacility(ctx, { backend: 'p6_knowledge', routes: {} });
  ctx.provide('storageDomain', facility);
  const routes = new Set<unknown>();
  // Deliberately inert public route-registration port. No HTTP listener or management request is started.
  ctx.provide('webServer', { host: '127.0.0.1', register(route: unknown) { routes.add(route); return () => { routes.delete(route); }; } });
  const fiber = ctx.plugin(KnowledgeService, config);
  try {
    await fiber.await(); const service = ctx.get('knowledge'); assert.ok(service);
    assert.equal(ctx.get('storageDomain'), facility); await service.whenReady(); service.listBases();
    assert.equal(routes.size, 1);
    return { ctx, service, async close() {
      await service.waitForIdle(); await fiber.dispose(); await facility.closeAll(); unregister();
      await backend.close(); await ctx.fiber.dispose(); assert.equal(routes.size, 0);
    } };
  } catch (error) {
    await fiber.dispose(); await facility.closeAll(); unregister(); await backend.close(); throw error;
  }
}

const text = 'Dedicated P6 sentinel raw text. 这是隔离测试原文。';
const bankTarget = { bankKey: 'isolated-p6-bank', provisionMarker: 'isolated-p6-marker' };
const encoded = encodePluginDocument({ memoryId: 'isolated-p6-memory', version: 1, writeIntentId: 'isolated-p6-intent',
  provenance: { complete: true, sourceRefs: [{ sourceId: 'isolated-p6-source', sourceEpoch: 1 }],
    messageKeys: ['isolated-p6-message'], dependencyVersions: [] }, text: 'Canonical plugin raw evidence. 隔离原文。' });
let pluginBaseId: string; let pluginDocumentId: string;
let first = await open(); let baseId: string; let documentId: string;
try {
  assert.equal(first.service.listBases().length, 0);
  const base = await first.service.createBase({ name: 'isolated-P6' }); baseId = base.id;
  const document = await first.service.addTextDocument({ baseId, title: 'raw-note', content: text }); documentId = document.id;
  assert.equal(first.service.getDocument(documentId, { includeChunks: false }).rawText, text);
  assert.equal(first.service.readDocumentText(documentId, 0, text.length).content, text);
  assert.ok(first.service.listChunks(documentId).length > 0);
  const adapter = new KnowledgeAdapter(first.service); const bank = await adapter.provisionBank(bankTarget);
  pluginBaseId = bank.baseId; const saved = await adapter.writeDocument(bank, encoded, () => {}); pluginDocumentId = saved.docId;
  assert.equal(saved.vectorState, 'not_requested');
  const verified = await adapter.readAuthorizedDocuments({ bank, docIds: [saved.docId], authorize: () => {}, validateLive: () => true });
  assert.equal(verified[0]!.text, encoded.text);
  // Real public rechunk mutator, provider=none: no external embedding/model request.
  const repair = await adapter.prepareRepair(bank, encoded, saved.docId, () => {});
  assert.equal(repair.invoked, false); await repair.submit(); assert.equal(repair.invoked, true);
  const afterRepair = await adapter.reconcileDocument(bank, encoded, () => {});
  assert.equal(afterRepair?.docId, saved.docId); assert.equal(afterRepair?.vectorState, 'not_requested');
} finally { await first.close(); }
assert.ok(existsSync(join(root, 'metadata', 'knowledge.json')), 'no silent memory-store fallback');
const second = await open();
try {
  assert.ok(second.service.listBases().some(base => base.id === baseId!));
  const adapter = new KnowledgeAdapter(second.service);
  const bank = await adapter.reconcileBank({ ...bankTarget, baseId: pluginBaseId! }); assert.ok(bank);
  const reconciled = await adapter.reconcileDocument(bank, encoded, () => {}); assert.ok(reconciled);
  assert.equal(reconciled.docId, pluginDocumentId!);
  const verified = await adapter.readAuthorizedDocuments({ bank, docIds: [pluginDocumentId!], authorize: () => {}, validateLive: () => true });
  assert.equal(verified[0]!.text, encoded.text);
  await adapter.deleteDocument(bank, pluginDocumentId!, () => {});
  await second.service.deleteBase(pluginBaseId!);
  assert.equal(second.service.getDocument(documentId!, { includeChunks: false }).rawText, text);
  assert.equal(second.service.readDocumentText(documentId!, 0, text.length).content, text);
  assert.ok(second.service.listChunks(documentId!).length > 0);
  await second.service.deleteDocument(documentId!); assert.equal(second.service.listDocuments(baseId!).length, 0);
  await second.service.deleteBase(baseId!);
} finally { await second.close(); }
const third = await open();
try {
  assert.deepEqual(third.service.listBases(), []);
  await exerciseNativePipeline(third.ctx, root, third.service);
} finally { await third.close(); }
console.log('P6_KNOWLEDGE_OK');
