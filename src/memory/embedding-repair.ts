import { randomUUID } from 'node:crypto';
import { memoryVersionKey } from '../storage/model.js';
import type { MaintenanceTask, MemoryVersion, Provenance } from '../storage/model.js';
import { ControlRepository } from '../storage/repository.js';
import type { ContentGuard } from '../storage/repository.js';
import { encodePluginDocument, KnowledgeAdapterError } from './knowledge.js';
import type { KnowledgeAdapter, ProvisionedBank } from './knowledge.js';

export class EmbeddingRepairError extends Error {
  override readonly name = 'EmbeddingRepairError';
  constructor(readonly code: string) { super(code); }
}
export interface EmbeddingRepairOptions {
  isLive?: () => boolean; signal?: AbortSignal; now?: () => number;
  /** Local wait only; never cancels or retries unresolved SDK work. Maximum 30 seconds. */
  timeoutMs?: number; schedule?: (callback: () => void, ms: number) => () => void;
}
type Adapter = Pick<KnowledgeAdapter, 'prepareRepair' | 'reconcileDocument'>;
type Outcome = 'fulfilled' | 'rejected' | 'not_invoked';

/** Independent maintenance cost/history. Never appends text, invokes an LLM, or activates a version. */
export class EmbeddingRepairRunner {
  private stopped = false;
  private readonly running = new Map<string, Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly onAbort = () => this.fence();
  constructor(private readonly repository: ControlRepository, private readonly adapter: Adapter,
    private readonly options: EmbeddingRepairOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000)) {
      throw new EmbeddingRepairError('invalid-embedding-repair-timeout');
    }
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal?.aborted) this.fence();
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private live(): boolean {
    try { return !this.stopped && !this.options.signal?.aborted && (this.options.isLive?.() ?? true); } catch { return false; }
  }
  private checkOwner(): void {
    if (!this.live()) throw new EmbeddingRepairError('embedding-repair-stopped');
    this.repository.read();
  }
  private async deadline<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => {});
    this.checkOwner();
    let cancel = () => {}; let rejectWait!: (error: EmbeddingRepairError) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectWait = reject;
      const callback = () => reject(new EmbeddingRepairError('embedding-repair-outcome-unknown'));
      if (this.options.schedule) cancel = this.options.schedule(callback, this.options.timeoutMs ?? 30_000);
      else { const timer = setTimeout(callback, this.options.timeoutMs ?? 30_000); timer.unref(); cancel = () => clearTimeout(timer); }
    });
    const stop = () => { try { cancel(); } finally { rejectWait(new EmbeddingRepairError('embedding-repair-stopped')); } };
    this.waiters.add(stop);
    if (!this.live()) stop();
    try { return await Promise.race([promise, timeout]); }
    finally { this.waiters.delete(stop); cancel(); }
  }
  private retryAt(retries: number): number { return this.now() + Math.min(300_000, 1000 * 2 ** Math.min(Math.max(0, retries - 1), 20)); }
  private async fail(taskId: string, code: string, attemptId?: string | null, retry = false): Promise<void> {
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const task = draft.maintenance[taskId];
      if (!task || (attemptId !== undefined && task.mutation?.attemptId !== (attemptId ?? undefined))) return;
      if (task.mutation?.externalWrite === 'in_flight') task.mutation.externalWrite = 'unknown';
      const unknown = task.mutation?.externalWrite === 'unknown';
      task.state = retry && !unknown && task.retries < 10 ? 'retry' : 'dead-letter';
      task.nextRunAt = this.retryAt(task.retries);
      task.errorCodes = [...task.errorCodes, unknown ? 'embedding-repair-outcome-unknown' : code].slice(-100);
    });
  }
  private target(task: MaintenanceTask): { memory: MemoryVersion; guard: ContentGuard; bank: ProvisionedBank; check: () => void } {
    this.checkOwner();
    const state = this.repository.read();
    const intent = task.intentId ? state.intents[task.intentId] : undefined;
    const memory = intent ? state.memories[memoryVersionKey(intent.memoryId, intent.version)] : undefined;
    const bank = state.banks[task.bankKey];
    // metadataResult precedes the retain lane's separate activation commit. A maintenance
    // tick in that gap must defer without consuming an attempt or reading an inactive body.
    const activeKey = memory ? state.activeMemory[memory.memoryId] : undefined;
    const previous = activeKey ? state.memories[activeKey] : undefined;
    const awaitingActivation = intent?.expectedNoActive === true ? previous === undefined
      : intent?.expectedNoActive === false && previous?.version === intent.expectedActiveVersion;
    if (memory && !memory.active && !memory.tombstoned && memory.state === 'text_saved' && intent?.state === 'text_saved'
      && awaitingActivation && bank?.state === 'ready') {
      throw new EmbeddingRepairError('embedding-repair-awaiting-activation');
    }
    if (!memory || !bank?.baseId || bank.state !== 'ready' || memory.bankKey !== task.bankKey
      || !memory.docId || task.docIds.length !== 1 || task.docIds[0] !== memory.docId
      || !memory.active || memory.tombstoned || memory.state !== 'active'
      || state.activeMemory[memory.memoryId] !== memoryVersionKey(memory.memoryId, memory.version)) {
      throw new EmbeddingRepairError('embedding-repair-target-inactive');
    }
    const provenance: Provenance = structuredClone(memory.provenance);
    if (!provenance.dependencyVersions.some(dep => dep.memoryId === memory.memoryId && dep.version === memory.version)) {
      provenance.dependencyVersions.push({ memoryId: memory.memoryId, version: memory.version });
    }
    const guard: ContentGuard = { kind: 'content', fence: this.repository.fence, botId: bank.botId, personalityId: bank.personalityId,
      provenance, validateLive: () => this.live() };
    const check = () => {
      this.checkOwner(); this.repository.assertContentAllowed(guard);
      const current = this.repository.read(); const value = current.memories[memoryVersionKey(memory.memoryId, memory.version)];
      if (!value || !value.active || value.tombstoned || value.state !== 'active' || value.docId !== memory.docId
        || value.contentHash !== memory.contentHash || current.activeMemory[memory.memoryId] !== memoryVersionKey(memory.memoryId, memory.version)
        || current.banks[task.bankKey]?.baseId !== bank.baseId || current.banks[task.bankKey]?.state !== 'ready') {
        throw new EmbeddingRepairError('embedding-repair-target-inactive');
      }
    };
    check(); // Before the caller consumes memory.text, not merely before the eventual SDK mutation.
    return { memory, guard, bank: { bankKey: bank.bankKey, provisionMarker: bank.provisionMarker, baseId: bank.baseId }, check };
  }
  run(taskId: string): Promise<void> {
    const existing = this.running.get(taskId); if (existing) return existing;
    const operation = this.runImpl(taskId);
    this.running.set(taskId, operation);
    const release = () => { if (this.running.get(taskId) === operation) this.running.delete(taskId); };
    void operation.then(release, release);
    return operation;
  }
  private async settled(taskId: string, attemptId: string, outcome: Outcome): Promise<Outcome> {
    // Intentionally no source/config check: raw settlement is metadata even after forget/fence.
    // Repository ownership and per-attempt identity still fence every late callback.
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const task = draft.maintenance[taskId]; const mutation = task?.mutation;
      if (!task || !mutation || mutation.attemptId !== attemptId || mutation.ownerFence !== this.repository.fence) return;
      if (outcome === 'not_invoked') mutation.externalWrite = 'not_started';
      else { mutation.externalWrite = 'settled'; mutation.outcome = outcome; mutation.settledAt = this.now(); }
      // A timed-out/deleted/fenced attempt remains dead-letter; settlement never reactivates it.
      if (task.state !== 'running') return;
      if (outcome !== 'fulfilled') {
        task.state = outcome === 'rejected' && task.retries < 10 ? 'retry' : 'dead-letter';
        task.nextRunAt = this.retryAt(task.retries);
        task.errorCodes = [...task.errorCodes, outcome === 'rejected' ? 'embedding-repair-rejected' : 'embedding-repair-not-submitted'].slice(-100);
      }
    });
    return outcome;
  }
  private async runImpl(taskId: string): Promise<void> {
    this.checkOwner();
    const task = this.repository.read().maintenance[taskId];
    if (!task || task.kind !== 'embedding') throw new EmbeddingRepairError('embedding-repair-task-invalid');
    if (task.mutation && ['unknown', 'in_flight'].includes(task.mutation.externalWrite)) {
      await this.fail(taskId, 'embedding-repair-outcome-unknown', task.mutation.attemptId); return;
    }
    if (!['pending', 'retry'].includes(task.state) || task.nextRunAt > this.now()) return;
    if (task.retries >= 10) { await this.fail(taskId, 'embedding-repair-budget-exhausted', task.mutation?.attemptId ?? null); return; }
    let attemptId: string | undefined;
    try {
      const { memory, guard, bank, check } = this.target(task);
      if (memory.vectorState !== 'failed') {
        await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
          const current = draft.maintenance[taskId]!;
          if (!['pending', 'retry'].includes(current.state) || current.mutation?.attemptId !== task.mutation?.attemptId) return;
          current.state = 'done'; current.errorCodes = [];
        });
        return;
      }
      check();
      if (memory.text === undefined) throw new EmbeddingRepairError('embedding-repair-content-unavailable');
      const encoded = encodePluginDocument({ memoryId: memory.memoryId, version: memory.version, writeIntentId: memory.writeIntentId,
        provenance: memory.provenance, text: memory.text });
      check();
      if (encoded.hash !== memory.contentHash) throw new EmbeddingRepairError('embedding-repair-content-mismatch');
      if (typeof this.adapter.prepareRepair !== 'function') throw new EmbeddingRepairError('embedding-repair-unsupported');
      const prepared = await this.deadline(this.adapter.prepareRepair(bank, encoded, memory.docId!, check));
      check();
      attemptId = randomUUID(); const id = attemptId;
      let resolveRaw!: () => void; let rejectRaw!: (reason: unknown) => void;
      const raw = new Promise<void>((yes, no) => { resolveRaw = yes; rejectRaw = no; });
      void raw.catch(() => {});
      let observerRegistered = false;
      const submission = this.repository.commitAndSubmit(guard, draft => {
        check();
        const current = draft.maintenance[taskId]!;
        if (!['pending', 'retry'].includes(current.state) || current.mutation?.attemptId !== task.mutation?.attemptId
          || (current.mutation && ['unknown', 'in_flight'].includes(current.mutation.externalWrite))) throw new EmbeddingRepairError('embedding-repair-attempt-raced');
        current.retries++;
        current.state = 'running'; current.errorCodes = [];
        current.mutation = { attemptId: id, generation: (current.mutation?.generation ?? 0) + 1,
          memoryId: memory.memoryId, version: memory.version, docId: memory.docId!, contentHash: memory.contentHash,
          provenance: structuredClone(guard.provenance), ownerFence: this.repository.fence,
          externalWrite: 'in_flight', startedAt: this.now() };
      }, () => {
        // Durable cost and in-flight intent precede SDK invocation; observers precede submit/await.
        const observed = this.repository.trackMaintenanceSubmission(taskId, id, { invoked: () => prepared.invoked, completion: raw });
        observerRegistered = true;
        const completion = observed.then(outcome => this.settled(taskId, id, outcome));
        // Arm the local deadline/stop waiter before SDK entry; raw settlement observation is
        // independent and survives this bounded wait, including synchronous service hooks.
        const bounded = this.deadline(completion);
        void completion.catch(() => {}); void bounded.catch(() => {});
        try { prepared.submit().then(resolveRaw, rejectRaw); } catch (error) { rejectRaw(error); }
        return bounded;
      });
      let submitted: Awaited<typeof submission>;
      try { submitted = await submission; }
      catch (error) {
        // A post-commit authorization check can deny start() itself. Positive local evidence
        // of zero invocation is not remote absence/reconciliation and may safely unblock purge.
        if (!observerRegistered && !prepared.invoked && this.repository.getHealth().state === 'ready'
          && this.repository.read().maintenance[taskId]?.mutation?.attemptId === id) {
          const outcome = await this.repository.trackMaintenanceSubmission(taskId, id,
            { invoked: () => false, completion: Promise.resolve() });
          await this.settled(taskId, id, outcome);
        }
        throw error;
      }
      const outcome = await submitted.completion;
      if (outcome !== 'fulfilled') return;
      check();
      const verified = await this.deadline(this.adapter.reconcileDocument(bank, encoded, check));
      check();
      if (!verified || verified.docId !== memory.docId || verified.vectorState !== 'ready') {
        await this.fail(taskId, 'embedding-repair-vector-not-ready', id, true); return;
      }
      await this.repository.transact(guard, draft => {
        check();
        const current = draft.maintenance[taskId]!;
        if (current.mutation?.attemptId !== id || current.state !== 'running' || current.mutation.outcome !== 'fulfilled') return;
        draft.memories[memoryVersionKey(memory.memoryId, memory.version)]!.vectorState = 'ready';
        current.state = 'done'; current.errorCodes = [];
      });
    } catch (error) {
      const code = error instanceof EmbeddingRepairError ? error.code
        : error instanceof KnowledgeAdapterError && error.code === 'knowledge-embedding-repair-unavailable' ? 'embedding-repair-unsupported' : 'embedding-repair-authorization-or-validation-failed';
      // A storage/owner failure must not trigger another mutation or a zero-cost SDK dispatch.
      if (this.repository.getHealth().state !== 'ready') throw new EmbeddingRepairError('embedding-repair-storage-or-owner-unavailable');
      const currentAttempt = this.repository.read().maintenance[taskId]?.mutation?.attemptId;
      await this.fail(taskId, code, attemptId !== undefined && currentAttempt === attemptId ? attemptId : task.mutation?.attemptId ?? null,
        code === 'embedding-repair-awaiting-activation');
    }
  }
  /** Cancels only local waits; actual submitted SDK work and its metadata observer keep running. */
  fence(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const stop of [...this.waiters]) { try { stop(); } catch { /* Fence every owned waiter. */ } }
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }
  async stop(): Promise<void> {
    this.fence();
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      for (const taskId of this.running.keys()) {
        const task = draft.maintenance[taskId];
        if (task?.mutation?.externalWrite === 'in_flight' && task.mutation.ownerFence === this.repository.fence) {
          task.mutation.externalWrite = 'unknown'; task.state = 'dead-letter'; task.errorCodes = ['embedding-repair-outcome-unknown'];
        }
      }
    });
  }
}
