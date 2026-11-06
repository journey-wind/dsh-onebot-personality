import { fingerprint } from '../llm/routes.js';
import { ControlRepository } from '../storage/repository.js';
import type { ContentGuard } from '../storage/repository.js';
import { memoryVersionKey } from '../storage/model.js';
import type { ControlState, ForgetTarget, MemoryVersion, Provenance, WriteIntent } from '../storage/model.js';
import { encodePluginDocument, KnowledgeAdapterError } from './knowledge.js';
import type { KnowledgeAdapter, PluginDocumentMetadata, ProvisionedBank, ReconciledDocument } from './knowledge.js';

export class BankError extends Error {
  override readonly name = 'BankError';
  constructor(readonly code: string) { super(code); }
}
type Adapter = Pick<KnowledgeAdapter, 'provisionBank' | 'reconcileBank' | 'enumeratePluginDocuments' |
  'writeDocument' | 'reconcileDocument' | 'deleteDocument' | 'getWriteSettlement' | 'releaseWriteSettlement'>;
export interface VersionInput {
  bankKey: string; memoryId: string; operationKey: string; kind: MemoryVersion['kind'];
  text: string; provenance: Provenance;
  expectedBankRevision?: number; templateId?: string; coveredRevision?: number;
  eventStart?: number; eventEnd?: number; entities?: string[]; scopeKey?: string; generatedAt?: number;
}
export interface VersionPlan { bankKey: string; memoryId: string; version: number; intentId: string; contentHash: string }
export function memoryIdFor(bankKey: string, kind: MemoryVersion['kind'], logicalKey: string): string {
  return `memory-${kind}-${fingerprint([bankKey, logicalKey])}`;
}
interface Operation { settled: boolean; promise: Promise<ReconciledDocument & { reused: boolean }> }
function next(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new BankError('counter-overflow');
  return value + 1;
}
function affected(p: Provenance, target: ForgetTarget): boolean {
  return target.kind === 'source' ? p.sourceRefs.some(ref => ref.sourceId === target.sourceId && ref.sourceEpoch <= target.throughEpoch)
    : p.messageKeys.some(key => target.messageKeys.includes(key));
}
function includesClosure(container: Provenance, input: Provenance): boolean {
  return input.sourceRefs.every(ref => container.sourceRefs.some(other => other.sourceId === ref.sourceId && other.sourceEpoch === ref.sourceEpoch))
    && input.messageKeys.every(key => container.messageKeys.includes(key))
    && input.dependencyVersions.every(dep => container.dependencyVersions.some(other => other.memoryId === dep.memoryId && other.version === dep.version));
}

/** Cross-store coordinator. External computation never runs inside the repository commit barrier. */
export class BankCoordinator {
  private stopped = false;
  private readonly ensuring = new Map<string, Promise<ProvisionedBank>>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly forgetting = new Map<string, Promise<'purged' | 'purging'>>();
  private readonly provisioning = new Map<string, Promise<ProvisionedBank>>();
  private readonly operations = new Map<string, Operation>();
  private readonly deadlineWaiters = new Set<() => void>();
  constructor(private readonly repository: ControlRepository, private readonly knowledge: Adapter,
    private readonly options: { isLive?: () => boolean; now?: () => number; timeoutMs?: number; schedule?: (callback: () => void, ms: number) => () => void } = {}) {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3_600_000)) {
      throw new BankError('invalid-knowledge-timeout');
    }
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private live(): boolean {
    try { return !this.stopped && (this.options.isLive?.() ?? true); } catch { return false; }
  }
  private maintenanceCheck = (): void => {
    if (!this.live()) throw new BankError('coordinator-stopped');
    this.repository.read(); // Enforces exclusive live owner and healthy durable state, not old source ACL.
  };
  private fullGuard(guard: ContentGuard, provenance: Provenance): ContentGuard {
    if (!includesClosure(provenance, guard.provenance)) throw new BankError('incomplete-input-closure');
    return { ...guard, provenance: structuredClone(provenance),
      validateLive: () => this.live() && (guard.validateLive ? guard.validateLive() === true : true) };
  }
  private check(guard: ContentGuard): void { this.maintenanceCheck(); this.repository.assertContentAllowed(guard); }
  private async deadline<T>(promise: Promise<T>): Promise<T> {
    const ms = this.options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 3_600_000) {
      void promise.catch(() => {}); throw new BankError('invalid-knowledge-timeout');
    }
    if (this.stopped) { void promise.catch(() => {}); throw new BankError('coordinator-stopped'); }
    let cancel = () => {}; let rejectWait!: (error: BankError) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectWait = reject;
      const callback = () => reject(new BankError('external-write-unknown'));
      if (this.options.schedule) cancel = this.options.schedule(callback, ms);
      else { const timer = setTimeout(callback, ms); timer.unref(); cancel = () => clearTimeout(timer); }
    });
    const stopWaiting = () => {
      try { cancel(); } catch { /* The waiter still settles without exposing scheduler details. */ }
      rejectWait(new BankError('coordinator-stopped'));
    };
    this.deadlineWaiters.add(stopWaiting);
    if (this.stopped) stopWaiting();
    try { return await Promise.race([promise, timeout]); }
    finally { this.deadlineWaiters.delete(stopWaiting); cancel(); }
  }
  private async pause(bankKey: string, code: string): Promise<void> {
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const bank = draft.banks[bankKey];
      if (!bank) return;
      draft.pausedBanks[bankKey] = code; bank.state = 'blocked';
    });
  }
  private queueMaintenance(draft: ControlState, kind: 'cleanup' | 'orphan' | 'embedding' | 'reconcile', bankKey: string, intentId: string, docIds: string[]): void {
    const taskId = `${kind}-${fingerprint([bankKey, intentId, [...docIds].sort()])}`;
    if (draft.maintenance[taskId]) return;
    draft.maintenance[taskId] = { taskId, kind, bankKey, intentId, docIds: [...new Set(docIds)],
      state: 'pending', retries: 0, nextRunAt: this.now(), errorCodes: [] };
  }

  async ensureBank(bankKey: string, guard: ContentGuard): Promise<ProvisionedBank> {
    this.check(guard);
    let operation = this.ensuring.get(bankKey);
    if (!operation) {
      operation = this.ensureBankImpl(bankKey, guard);
      this.ensuring.set(bankKey, operation);
      const release = () => { if (this.ensuring.get(bankKey) === operation) this.ensuring.delete(bankKey); };
      void operation.then(release, release);
    }
    const result = await operation;
    this.check(guard);
    return result;
  }

  private async ensureBankImpl(bankKey: string, guard: ContentGuard): Promise<ProvisionedBank> {
    this.check(guard);
    const running = this.provisioning.get(bankKey);
    if (running) return this.deadline(running);
    const bank = this.repository.read().banks[bankKey];
    if (!bank || bank.botId !== guard.botId || bank.personalityId !== guard.personalityId) throw new BankError('bank-scope-mismatch');
    const target = { bankKey, provisionMarker: bank.provisionMarker, ...(bank.baseId ? { baseId: bank.baseId } : {}) };
    const canCreate = bank.state === 'unmapped' && bank.baseId === undefined;
    if (['blocked', 'suspended', 'retiring'].includes(bank.state)) throw new BankError('bank-not-writable');
    if (canCreate) await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const current = draft.banks[bankKey]!;
      if (current.state !== 'unmapped') throw new BankError('bank-provision-race');
      current.state = 'provisioning';
    });
    this.check(guard);
    // An uncertain old provisioning attempt may only enumerate/reuse, NEVER blindly create again.
    const operation = (async () => {
      const result = canCreate ? await this.knowledge.provisionBank(target, () => this.check(guard))
        : await this.knowledge.reconcileBank(target, () => this.check(guard));
      if (!result) throw new BankError('bank-provision-outcome-unknown');
      this.maintenanceCheck();
      await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
        const current = draft.banks[bankKey]!;
        if (current.provisionMarker !== target.provisionMarker || (current.baseId && current.baseId !== result.baseId)) throw new BankError('bank-binding-conflict');
        current.baseId = result.baseId; current.state = 'ready';
      });
      return { bankKey, provisionMarker: result.provisionMarker, baseId: result.baseId };
    })();
    this.provisioning.set(bankKey, operation);
    void operation.then(() => { this.provisioning.delete(bankKey); }, () => { this.provisioning.delete(bankKey); });
    try { const result = await this.deadline(operation); this.check(guard); return result; }
    catch (error) {
      await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
        const current = draft.banks[bankKey];
        if (current && current.state !== 'ready' && current.state !== 'blocked') current.state = 'reconciliation_required';
      });
      if (error instanceof KnowledgeAdapterError && /ambiguous|namespace|proactive/.test(error.code)) await this.pause(bankKey, error.code);
      throw new BankError(error instanceof BankError ? error.code : 'bank-provision-failed');
    }
  }

  async planVersion(input: VersionInput, originalGuard: ContentGuard): Promise<VersionPlan> {
    if (!input.operationKey || !input.memoryId) throw new BankError('invalid-version-identity');
    if ((input.kind === 'observation' || input.kind === 'mental-model') && input.expectedBankRevision === undefined) throw new BankError('derived-revision-required');
    const guard = this.fullGuard(originalGuard, input.provenance);
    this.check(guard);
    return this.repository.transact(guard, draft => {
      const bank = draft.banks[input.bankKey];
      if (!bank || bank.botId !== guard.botId || bank.personalityId !== guard.personalityId || bank.state !== 'ready') throw new BankError('bank-not-ready');
      const intentId = `write-${fingerprint([input.bankKey, input.operationKey])}`;
      const existing = draft.intents[intentId];
      const allVersions = Object.values(draft.memories).filter(memory => memory.memoryId === input.memoryId);
      if (allVersions.some(memory => memory.bankKey !== input.bankKey || memory.botId !== bank.botId || memory.personalityId !== bank.personalityId)) {
        throw new BankError('memory-identity-conflict');
      }
      const version = existing?.version ?? next(allVersions.reduce((max, memory) => Math.max(max, memory.version), 0));
      const encoded = encodePluginDocument({ memoryId: input.memoryId, version, writeIntentId: intentId, text: input.text, provenance: guard.provenance });
      if (existing) {
        const saved = draft.memories[memoryVersionKey(existing.memoryId, existing.version)];
        if (!saved || saved.kind !== input.kind || saved.templateId !== input.templateId || saved.coveredRevision !== input.coveredRevision
          || saved.scopeKey !== input.scopeKey || (input.generatedAt !== undefined && saved.generatedAt !== input.generatedAt)
          || existing.expectedBankRevision !== input.expectedBankRevision) throw new BankError('write-intent-conflict');
        if (existing.memoryId !== input.memoryId || existing.contentHash !== encoded.hash || existing.marker !== encoded.marker
          || fingerprint(existing.provenance) !== fingerprint(encoded.header.provenance)) throw new BankError('write-intent-conflict');
        if (existing.state === 'invalidated' || existing.state === 'cleaned' || existing.text === undefined) throw new BankError('write-intent-not-reusable');
        return { bankKey: input.bankKey, memoryId: input.memoryId, version, intentId, contentHash: encoded.hash };
      }
      const activeKey = draft.activeMemory[input.memoryId];
      const active = activeKey ? draft.memories[activeKey] : undefined;
      if (allVersions.some(memory => memory.botId !== bank.botId || memory.personalityId !== bank.personalityId)) throw new BankError('memory-identity-conflict');
      draft.intents[intentId] = {
        intentId, bankKey: input.bankKey, memoryId: input.memoryId, version, marker: encoded.marker, contentHash: encoded.hash,
        provenance: encoded.header.provenance, ownerFence: this.repository.fence,
        ...(input.expectedBankRevision === undefined ? {} : { expectedBankRevision: input.expectedBankRevision }),
        ...(active ? { expectedActiveVersion: active.version, expectedNoActive: false } : { expectedNoActive: true }),
        state: 'planned', externalWrite: 'not_started', text: encoded.text, docIds: [], createdAt: this.now(),
      };
      draft.memories[memoryVersionKey(input.memoryId, version)] = {
        memoryId: input.memoryId, version, botId: bank.botId, personalityId: bank.personalityId, bankKey: input.bankKey,
        kind: input.kind, provenance: encoded.header.provenance, contentHash: encoded.hash, writeIntentId: intentId,
        state: 'planned', vectorState: 'unknown', text: encoded.text, active: false, tombstoned: false, stale: false, createdAt: this.now(),
        ...(active ? { supersedes: { memoryId: active.memoryId, version: active.version } } : {}),
        ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
        ...(input.coveredRevision === undefined ? {} : { coveredRevision: input.coveredRevision }),
        ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey }),
        ...(input.generatedAt === undefined ? {} : { generatedAt: input.generatedAt }),
        ...(input.eventStart === undefined ? {} : { eventStart: input.eventStart }),
        ...(input.eventEnd === undefined ? {} : { eventEnd: input.eventEnd }), entities: input.entities ?? [],
      };
      return { bankKey: input.bankKey, memoryId: input.memoryId, version, intentId, contentHash: encoded.hash };
    });
  }

  private intent(plan: VersionPlan): WriteIntent {
    const intent = this.repository.read().intents[plan.intentId];
    if (!intent || intent.bankKey !== plan.bankKey || intent.memoryId !== plan.memoryId || intent.version !== plan.version
      || intent.contentHash !== plan.contentHash) throw new BankError('write-plan-mismatch');
    return intent;
  }
  private async metadataResult(plan: VersionPlan, result: ReconciledDocument, settled: boolean): Promise<void> {
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const intent = draft.intents[plan.intentId];
      const memory = draft.memories[memoryVersionKey(plan.memoryId, plan.version)];
      if (!intent || !memory) throw new BankError('write-plan-missing');
      intent.docIds = [...new Set([...intent.docIds, result.docId, ...result.orphanDocIds])];
      if (settled) intent.externalWrite = 'settled';
      if (!['invalidated', 'cleaned', 'active'].includes(intent.state)) intent.state = 'text_saved';
      memory.docId = result.docId; memory.vectorState = result.vectorState;
      if (!memory.active && !['invalidated', 'cleanup_pending', 'cleaned'].includes(memory.state)) memory.state = 'text_saved';
      if (result.vectorState === 'failed' && !memory.tombstoned && intent.state !== 'invalidated' && intent.state !== 'cleaned') {
        this.queueMaintenance(draft, 'embedding', plan.bankKey, plan.intentId, [result.docId]);
      }
      if (result.orphanDocIds.length) this.queueMaintenance(draft, 'orphan', plan.bankKey, plan.intentId, result.orphanDocIds);
      if (intent.state === 'invalidated' || memory.tombstoned) this.queueMaintenance(draft, 'cleanup', plan.bankKey, plan.intentId, intent.docIds);
    });
  }
  private async markUnknown(plan: VersionPlan, code: string): Promise<void> {
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const intent = draft.intents[plan.intentId];
      if (!intent || intent.externalWrite === 'settled') return;
      intent.externalWrite = 'unknown'; intent.lastErrorCode = code;
      if (intent.state !== 'invalidated' && intent.state !== 'cleaned') intent.state = 'reconcile_required';
      const memory = draft.memories[memoryVersionKey(plan.memoryId, plan.version)];
      if (memory && !memory.active && !memory.tombstoned && !['invalidated', 'cleaned'].includes(memory.state)) memory.state = 'reconcile_required';
      this.queueMaintenance(draft, 'reconcile', plan.bankKey, plan.intentId, []);
    });
  }

  async writeVersion(plan: VersionPlan, originalGuard: ContentGuard): Promise<void> {
    this.check(this.fullGuard(originalGuard, this.intent(plan).provenance));
    let operation = this.writing.get(plan.intentId);
    if (!operation) {
      operation = this.writeVersionImpl(plan, originalGuard);
      this.writing.set(plan.intentId, operation);
      const release = () => { if (this.writing.get(plan.intentId) === operation) this.writing.delete(plan.intentId); };
      void operation.then(release, release);
    }
    await operation;
    this.check(this.fullGuard(originalGuard, this.intent(plan).provenance));
  }

  private async writeVersionImpl(plan: VersionPlan, originalGuard: ContentGuard): Promise<void> {
    const intent = this.intent(plan);
    const guard = this.fullGuard(originalGuard, intent.provenance);
    this.check(guard);
    if (intent.state === 'active') {
      if (this.repository.read().activeMemory[plan.memoryId] === memoryVersionKey(plan.memoryId, plan.version)) return;
      throw new BankError('memory-version-superseded');
    }
    if (intent.text === undefined || ['invalidated', 'cleaned'].includes(intent.state)) throw new BankError('write-intent-not-writable');
    if (intent.expectedNoActive === undefined) throw new BankError('intent-cas-expectation-missing');
    const bank = await this.ensureBank(plan.bankKey, guard);
    const encoded = encodePluginDocument({ memoryId: plan.memoryId, version: plan.version, writeIntentId: plan.intentId,
      provenance: intent.provenance, text: intent.text });
    if (encoded.hash !== plan.contentHash) throw new BankError('persisted-content-hash-mismatch');
    let running = this.operations.get(plan.intentId);
    if (!running && (intent.externalWrite === 'unknown' || intent.externalWrite === 'in_flight' || intent.state === 'reconcile_required')) {
      const recovered = await this.knowledge.reconcileDocument(bank, encoded, () => this.check(guard));
      if (!recovered) throw new BankError('external-write-unknown'); // Absence is NOT termination proof.
      await this.metadataResult(plan, recovered, false);
      return;
    }
    if (!running && intent.state === 'text_saved') return;
    if (!running) {
      await this.repository.transact(guard, draft => {
        const current = draft.intents[plan.intentId]!;
        current.ownerFence = this.repository.fence; current.externalWrite = 'in_flight'; current.state = 'writing';
        draft.memories[memoryVersionKey(plan.memoryId, plan.version)]!.state = 'writing';
      });
      try { this.check(guard); }
      catch (error) {
        // No adapter operation was invoked, so this registered intent is known not submitted.
        await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
          const current = draft.intents[plan.intentId]; if (current) current.externalWrite = 'not_started';
        });
        throw error;
      }
      let resolve!: (result: ReconciledDocument & { reused: boolean }) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ReconciledDocument & { reused: boolean }>((yes, no) => { resolve = yes; reject = no; });
      const operation: Operation = { settled: false, promise };
      this.operations.set(plan.intentId, operation); // Register BEFORE the first adapter await/call.
      let raw: Promise<ReconciledDocument & { reused: boolean }>;
      try { raw = this.knowledge.writeDocument(bank, encoded, () => this.check(guard)); }
      catch { raw = Promise.reject(new BankError('knowledge-write-failed')); }
      void raw.then(async result => {
        await this.metadataResult(plan, result, true); // Metadata only, even if source was forgotten meanwhile.
        resolve(result);
      }, async error => {
        const code = error instanceof KnowledgeAdapterError ? error.code : 'knowledge-write-failed';
        await this.markUnknown(plan, code);
        if (/marker-conflict|integrity-mismatch|namespace|proactive/.test(code)) await this.pause(plan.bankKey, code);
        reject(new BankError(code));
      }).catch(error => { reject(error); }).finally(() => {
        operation.settled = true; this.operations.delete(plan.intentId);
      });
      running = operation;
    }
    try { await this.deadline(running.promise); }
    catch (error) {
      await this.markUnknown(plan, error instanceof BankError ? error.code : 'knowledge-write-failed');
      throw new BankError(error instanceof BankError ? error.code : 'knowledge-write-failed');
    }
  }

  async activate(plan: VersionPlan, originalGuard: ContentGuard): Promise<void> {
    const initial = this.intent(plan);
    const guard = this.fullGuard(originalGuard, initial.provenance);
    const conflict = await this.repository.transact(guard, draft => {
      const intent = draft.intents[plan.intentId]!;
      const memory = draft.memories[memoryVersionKey(plan.memoryId, plan.version)]!;
      const bank = draft.banks[plan.bankKey]!;
      const pointer = draft.activeMemory[plan.memoryId];
      if (memory.active && pointer === memoryVersionKey(plan.memoryId, plan.version)) return false;
      if (intent.state !== 'text_saved' || !memory.docId || memory.tombstoned) throw new BankError('text-not-verified');
      if (intent.expectedNoActive === undefined) throw new BankError('intent-cas-expectation-missing');
      intent.ownerFence = this.repository.fence;
      const active = pointer ? draft.memories[pointer] : undefined;
      const mismatch = (intent.expectedBankRevision !== undefined && bank.revision !== intent.expectedBankRevision)
        || (intent.expectedNoActive === true ? active !== undefined : active?.version !== intent.expectedActiveVersion);
      if (mismatch) {
        memory.state = 'invalidated'; memory.active = false; delete memory.text;
        intent.state = 'invalidated'; delete intent.text;
        this.queueMaintenance(draft, 'cleanup', plan.bankKey, plan.intentId, intent.docIds);
        return true;
      }
      if (active) {
        active.active = false; active.state = 'superseded';
        const previousIntent = draft.intents[active.writeIntentId];
        if (previousIntent?.docIds.length) this.queueMaintenance(draft, 'cleanup', plan.bankKey, previousIntent.intentId, previousIntent.docIds);
      }
      memory.state = 'active'; memory.active = true; memory.stale = false;
      intent.state = 'active'; draft.activeMemory[plan.memoryId] = memoryVersionKey(plan.memoryId, plan.version);
      bank.revision = next(bank.revision);
      return false;
    });
    if (conflict) throw new BankError('activation-cas-conflict');
    if (this.intent(plan).externalWrite === 'settled') this.knowledge.releaseWriteSettlement(plan.intentId);
  }

  async reconcileBank(bankKey: string): Promise<{ documents: number; affectedUnknownWrites: number }> {
    try { return await this.reconcileBankImpl(bankKey); }
    catch (error) {
      const code = error instanceof BankError || error instanceof KnowledgeAdapterError ? error.code : 'bank-reconcile-failed';
      if (/conflict|integrity|namespace|proactive|active-document-missing/.test(code)) await this.pause(bankKey, code);
      throw new BankError(code);
    }
  }

  private async reconcileBankImpl(bankKey: string): Promise<{ documents: number; affectedUnknownWrites: number }> {
    this.maintenanceCheck();
    const record = this.repository.read().banks[bankKey];
    if (!record) throw new BankError('bank-not-found');
    const bank = await this.knowledge.reconcileBank({ bankKey, provisionMarker: record.provisionMarker,
      ...(record.baseId ? { baseId: record.baseId } : {}) }, this.maintenanceCheck);
    if (!bank) {
      if (Object.values(this.repository.read().memories).some(memory => memory.bankKey === bankKey && memory.active)) throw new BankError('active-document-missing');
      return { documents: 0, affectedUnknownWrites: Object.values(this.repository.read().intents)
        .filter(intent => intent.bankKey === bankKey && ['unknown', 'in_flight'].includes(intent.externalWrite)).length };
    }
    const documents = await this.knowledge.enumeratePluginDocuments(bank, this.maintenanceCheck);
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      draft.banks[bankKey]!.baseId = bank.baseId;
      for (const memory of Object.values(draft.memories)) {
        if (memory.bankKey === bankKey && memory.active && !documents.some(doc => doc.docId === memory.docId)) throw new BankError('active-document-missing');
      }
      const groups = new Map<string, PluginDocumentMetadata[]>();
      for (const doc of documents) {
        const intent = draft.intents[doc.header.writeIntentId];
        if (!intent || intent.bankKey !== bankKey) { this.queueMaintenance(draft, 'orphan', bankKey, doc.header.writeIntentId, [doc.docId]); continue; }
        if (intent.memoryId !== doc.header.memoryId || intent.version !== doc.header.version || intent.contentHash !== doc.hash
          || fingerprint(intent.provenance) !== fingerprint(doc.header.provenance)) throw new BankError('document-marker-conflict');
        intent.docIds = [...new Set([...intent.docIds, doc.docId])];
        const group = groups.get(intent.intentId) ?? []; group.push(doc); groups.set(intent.intentId, group);
        if (intent.state === 'invalidated' || intent.state === 'cleaned') this.queueMaintenance(draft, 'cleanup', bankKey, intent.intentId, [doc.docId]);
      }
      for (const [intentId, group] of groups) {
        const intent = draft.intents[intentId]!;
        const memory = draft.memories[memoryVersionKey(intent.memoryId, intent.version)]!;
        const canonical = memory.active ? memory.docId : [...group].sort((a, b) => a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0)[0]?.docId;
        if (memory.active && !group.some(doc => doc.docId === canonical)) throw new BankError('active-document-missing');
        if (memory.active && group.find(doc => doc.docId === canonical)?.vectorState === 'failed') {
          memory.vectorState = 'failed';
          this.queueMaintenance(draft, 'embedding', bankKey, intentId, [canonical!]);
        }
        const orphanIds = group.filter(doc => doc.docId !== canonical).map(doc => doc.docId);
        if (orphanIds.length) this.queueMaintenance(draft, 'orphan', bankKey, intentId, orphanIds);
      }
    });
    return { documents: documents.length, affectedUnknownWrites: Object.values(this.repository.read().intents)
      .filter(intent => intent.bankKey === bankKey && ['unknown', 'in_flight'].includes(intent.externalWrite)).length };
  }

  async runCleanup(bankKey: string, limit = 50): Promise<number> {
    this.maintenanceCheck();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new BankError('invalid-cleanup-batch');
    let attempted = 0;
    const state = this.repository.read(); const record = state.banks[bankKey];
    if (!record) throw new BankError('bank-not-found');
    const bank = await this.knowledge.reconcileBank({ bankKey, provisionMarker: record.provisionMarker, ...(record.baseId ? { baseId: record.baseId } : {}) }, this.maintenanceCheck);
    const tasks = Object.values(state.maintenance).filter(task => task.bankKey === bankKey
      && (task.kind === 'cleanup' || task.kind === 'orphan') && ['pending', 'retry'].includes(task.state) && task.nextRunAt <= this.now()).slice(0, limit);
    for (const task of tasks) {
      if (attempted >= limit) break;
      const deleted: string[] = [];
      try {
        for (const docId of task.docIds) {
          if (attempted >= limit) break;
          attempted++;
          if (Object.values(this.repository.read().memories).some(memory => memory.active && memory.docId === docId)) throw new BankError('active-document-not-deletable');
          if (bank) await this.deadline(this.knowledge.deleteDocument(bank, docId, this.maintenanceCheck));
          deleted.push(docId);
        }
        await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
          const current = draft.maintenance[task.taskId]!;
          current.docIds = current.docIds.filter(docId => !deleted.includes(docId));
          current.state = current.docIds.length ? 'pending' : 'done';
          const intent = task.intentId ? draft.intents[task.intentId] : undefined;
          if (intent) {
            intent.docIds = intent.docIds.filter(docId => !deleted.includes(docId));
            const memory = draft.memories[memoryVersionKey(intent.memoryId, intent.version)];
            if (memory && !memory.active && intent.docIds.length === 0 && intent.externalWrite === 'settled') {
              memory.state = 'cleaned'; delete memory.text; intent.state = 'cleaned'; delete intent.text;
            }
          }
        });
        const completedIntent = task.intentId ? this.repository.read().intents[task.intentId] : undefined;
        if (completedIntent?.state === 'cleaned' && completedIntent.externalWrite === 'settled') this.knowledge.releaseWriteSettlement(completedIntent.intentId);
      } catch (error) {
        await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
          const current = draft.maintenance[task.taskId]!;
          current.retries = next(current.retries); current.state = current.retries >= 10 ? 'dead-letter' : 'retry';
          current.nextRunAt = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(current.retries - 1, 20));
          current.errorCodes = [...current.errorCodes, error instanceof BankError ? error.code : 'cleanup-failed'].slice(-100);
        });
      }
    }
    return attempted;
  }

  /** Full owned-bank sweep; absence never clears an unresolved external-write flag. */
  async purgeForget(operationId: string, limit = 50): Promise<'purged' | 'purging'> {
    this.maintenanceCheck();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new BankError('invalid-cleanup-batch');
    const running = this.forgetting.get(operationId);
    if (running) return running;
    const operation = this.purgeForgetImpl(operationId, limit).catch(async error => {
      const code = error instanceof BankError ? error.code : 'forget-cleanup-failed';
      await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
        const task = draft.forgetTasks[operationId];
        if (!task || task.state === 'purged') return;
        task.retries = next(task.retries); task.state = task.retries >= 10 ? 'dead-letter' : 'retry';
        task.nextRunAt = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(task.retries - 1, 20));
        task.errorCodes = [...task.errorCodes, code].slice(-100);
      });
      throw new BankError(code);
    });
    this.forgetting.set(operationId, operation);
    const release = () => { if (this.forgetting.get(operationId) === operation) this.forgetting.delete(operationId); };
    void operation.then(release, release);
    return operation;
  }

  private async purgeForgetImpl(operationId: string, limit: number): Promise<'purged' | 'purging'> {
    this.maintenanceCheck();
    let attempted = 0;
    const remainingIds = new Set<string>();
    const original = this.repository.read().forgetTasks[operationId];
    if (!original) throw new BankError('forget-operation-not-found');
    if (original.state === 'purged') return 'purged';
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => { draft.forgetTasks[operationId]!.state = 'purging'; });
    for (const record of Object.values(this.repository.read().banks)) {
      const bank = await this.knowledge.reconcileBank({ bankKey: record.bankKey, provisionMarker: record.provisionMarker,
        ...(record.baseId ? { baseId: record.baseId } : {}) }, this.maintenanceCheck);
      if (!bank) continue;
      const documents = await this.knowledge.enumeratePluginDocuments(bank, this.maintenanceCheck);
      const pendingIds = documents.filter(doc => affected(doc.header.provenance, original.target)).map(doc => doc.docId);
      await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
        const task = draft.forgetTasks[operationId]!;
        task.docIdsPending = [...new Set([...task.docIdsPending, ...pendingIds])];
      });
      for (const doc of documents) if (affected(doc.header.provenance, original.target) && attempted < limit) {
        attempted++;
        await this.deadline(this.knowledge.deleteDocument(bank, doc.docId, this.maintenanceCheck));
      }
      const remaining = await this.knowledge.enumeratePluginDocuments(bank, this.maintenanceCheck);
      for (const doc of remaining) if (affected(doc.header.provenance, original.target)) remainingIds.add(doc.docId);
    }
    const outcome = await this.repository.transact<'purged' | 'purging'>({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const task = draft.forgetTasks[operationId]!;
      const unknown = Object.values(draft.intents).some(intent => affected(intent.provenance, task.target)
        && (intent.externalWrite === 'unknown' || intent.externalWrite === 'in_flight'))
        || Object.values(draft.maintenance).some(work => work.mutation && affected(work.mutation.provenance, task.target)
          && (work.mutation.externalWrite === 'unknown' || work.mutation.externalWrite === 'in_flight'));
      const complete = !unknown && remainingIds.size === 0;
      task.externalWriteUnknown = unknown; task.docIdsPending = [...remainingIds];
      for (const intent of Object.values(draft.intents)) if (affected(intent.provenance, task.target)) {
        intent.docIds = intent.docIds.filter(id => remainingIds.has(id));
        if (complete) intent.state = 'cleaned';
      }
      for (const memory of Object.values(draft.memories)) if (affected(memory.provenance, task.target) && !memory.active) {
        memory.state = complete ? 'cleaned' : 'cleanup_pending';
      }
      if (unknown) {
        task.retries = next(task.retries);
        task.nextRunAt = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(task.retries - 1, 20));
        task.state = task.retries >= 10 ? 'dead-letter' : 'purging';
      } else {
        task.state = complete ? 'purged' : 'purging';
        if (!complete) task.nextRunAt = this.now() + 1000;
      }
      task.errorCodes = unknown ? ['external-write-unknown'] : complete ? [] : ['physical-cleanup-pending'];
      task.purgeProof = { ledgerSequence: draft.ledgerSequence, allBanksEnumerated: true, enumeratedAt: this.now() };
      return complete ? 'purged' : 'purging';
    });
    if (outcome === 'purged') {
      for (const intent of Object.values(this.repository.read().intents)) {
        if (affected(intent.provenance, original.target) && intent.externalWrite === 'settled') this.knowledge.releaseWriteSettlement(intent.intentId);
      }
    }
    return outcome;
  }

  /** Synchronous local fence, including maintenance entry points and owned timers. */
  fence(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const stopWaiting of [...this.deadlineWaiters]) {
      try { stopWaiting(); } catch { /* Continue fencing all waiters; never copy scheduler exception details. */ }
    }
  }
  /** Do not wait forever for an unabortable knowledge operation. */
  async stop(): Promise<void> {
    this.fence();
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      for (const bankKey of this.provisioning.keys()) {
        const bank = draft.banks[bankKey];
        if (bank && !['ready', 'blocked', 'retiring'].includes(bank.state)) bank.state = 'reconciliation_required';
      }
      for (const [intentId, operation] of this.operations) if (!operation.settled) {
        const intent = draft.intents[intentId];
        if (intent && intent.externalWrite !== 'settled') {
          intent.externalWrite = 'unknown'; intent.lastErrorCode = 'coordinator-stopped';
          if (intent.state !== 'invalidated') intent.state = 'reconcile_required';
        }
      }
    });
  }
}
