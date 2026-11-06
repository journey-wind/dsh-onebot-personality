import { DispatchDeferred, StageError } from '../llm/calls.js';
import { BankError } from '../memory/banks.js';
import type { RetainWorker } from '../memory/retain.js';
import { StorageError } from '../storage/repository.js';
import type { ControlRepository } from '../storage/repository.js';
import type { ReplyRecord } from '../storage/model.js';
import { RuntimeError } from './configuration.js';
import type { ConfigurationReader } from './configuration.js';
import type { OnlinePipeline } from './online.js';
import type { RetainTaskQueue, TaskLease } from './tasks.js';

export interface DerivedWorker {
  enqueueDue(limit?: number): Promise<number>;
  run(lease: TaskLease): Promise<void>;
}
export interface WorkerLoopOptions {
  /** MUST be the SAME owned root signal passed to online, retain, derived and Outbox's live guard. */
  signal: AbortSignal;
  readConfiguration: ConfigurationReader;
  now?: () => number;
  /** One-shot, asynchronous scheduler; returns cancellation of ONLY this loop's timer. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /**
   * Synchronously abort that root controller and fence any additional owned worker coordinators.
   * This is mandatory: run-only injected worker instances cannot receive a private replacement signal.
   * The loop stops its task queue itself; the composition separately awaits bank.stop() settlement.
   * Never close shared Host LLM/knowledge services, repository handles or owner here.
   */
  stopOwnedWork: () => void;
  tickMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  claimBatch?: number;
}
interface ActiveTask {
  lease: TaskLease;
  nextHeartbeatAt: number;
  leaseLost: boolean;
  operation: Promise<void>;
}
interface Auxiliary { operation: Promise<void> | undefined; nextAt: number; failures: number }
export interface WorkerLoopStatus {
  readonly state: 'idle' | 'running' | 'stopped';
  readonly timerScheduled: boolean;
  readonly ticking: boolean;
  readonly onlineActive: number;
  readonly conversationsActive: number;
  readonly backgroundActive: number;
  readonly leasesLost: number;
  readonly derivedEnqueueActive: boolean;
  readonly maintenanceActive: boolean;
  readonly trackedPromises: number;
  readonly errorCodes: readonly string[];
}
function bounded(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function failureCode(error: unknown): string {
  if (error instanceof StageError) return /^[a-z0-9:_-]{1,96}$/i.test(error.code) ? `${error.stage}:${error.code}` : 'worker-failed';
  if (error instanceof RuntimeError || error instanceof StorageError || error instanceof BankError) {
    return /^[a-z0-9:_-]{1,96}$/i.test(error.code) ? error.code : 'worker-failed';
  }
  return 'worker-failed'; // Unknown error messages, abort reasons and provider bodies never enter status/storage.
}

/**
 * Explicitly started lifecycle orchestration, not a Host effect or a connection/database factory.
 * Online.run includes the entire outbox completion: its conversation slot is held until it settles.
 * Separate background/maintenance lanes never occupy online concurrency. Queue.claimNext retains
 * responsibility for ORIGINAL snapshot concurrency and same-bank derived serialization.
 * stop() fences local body writes synchronously, but does NOT assert that submitted external work
 * was cancelled. It deliberately does not await an adapter promise that may never settle.
 */
export class WorkerLoop {
  private state: WorkerLoopStatus['state'] = 'idle';
  private cancelTimer: (() => void) | undefined;
  private ticking: Promise<void> | undefined;
  private readonly onlineActive = new Map<string, Promise<void>>();
  private readonly conversations = new Set<string>();
  private readonly background = new Map<string, ActiveTask>();
  private readonly promises = new Set<Promise<void>>();
  private readonly errors: string[] = [];
  private readonly due: Auxiliary = { operation: undefined, nextAt: 0, failures: 0 };
  private readonly maintenanceState: Auxiliary = { operation: undefined, nextAt: 0, failures: 0 };
  private readonly tickMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly claimBatch: number;
  private readonly onAbort = () => { void this.stop().catch(() => {}); };

  constructor(private readonly repository: ControlRepository, private readonly taskQueue: RetainTaskQueue,
    private readonly online: Pick<OnlinePipeline, 'run'>, private readonly retain: Pick<RetainWorker, 'run'>,
    private readonly derived: DerivedWorker, private readonly maintenance: { tick(limit: number): Promise<void> } | undefined,
    private readonly options: WorkerLoopOptions) {
    this.tickMs = options.tickMs ?? 250; this.leaseMs = options.leaseMs ?? 120_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000; this.claimBatch = options.claimBatch ?? 32;
    if (!bounded(this.tickMs, 1, 60_000) || !bounded(this.leaseMs, 1, 3_600_000)
      || !bounded(this.heartbeatMs, 1, Math.floor(this.leaseMs / 2)) || !bounded(this.claimBatch, 1, 64)
      || typeof options.stopOwnedWork !== 'function') throw new RuntimeError('invalid-worker-loop-options');
    // No timers, listeners, claims, repository reads or business work in this constructor.
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!bounded(now, 0, Number.MAX_SAFE_INTEGER - this.leaseMs)) throw new RuntimeError('invalid-worker-clock');
    return now;
  }
  private live(): boolean { return this.state === 'running' && !this.options.signal.aborted; }
  private note(code: string): void { this.errors.push(code); if (this.errors.length > 16) this.errors.shift(); }
  private track(operation: Promise<void>): Promise<void> {
    // Attach both handlers immediately, including promises still running after stop().
    this.promises.add(operation);
    void operation.then(() => { this.promises.delete(operation); }, () => { this.promises.delete(operation); });
    return operation;
  }
  private arm(): void {
    if (!this.live() || this.cancelTimer || this.ticking) return;
    const callback = () => {
      this.cancelTimer = undefined;
      if (!this.live()) return;
      const operation = this.tick().catch(() => { this.note('scheduler-tick-failed'); void this.stop().catch(() => {}); });
      this.ticking = operation; this.track(operation);
      void operation.then(() => {
        if (this.ticking === operation) this.ticking = undefined;
        if (this.live()) this.arm();
      }).catch(() => { this.note('scheduler-timer-failed'); });
    };
    try {
      if (this.options.schedule) this.cancelTimer = this.options.schedule(callback, this.tickMs);
      else { const timer = setTimeout(callback, this.tickMs); timer.unref(); this.cancelTimer = () => clearTimeout(timer); }
    } catch { this.note('scheduler-timer-failed'); void this.stop().catch(() => {}); }
  }

  start(): void {
    if (this.state === 'stopped') throw new RuntimeError('worker-loop-stopped');
    if (this.state === 'running') return;
    this.state = 'running';
    this.options.signal.addEventListener('abort', this.onAbort, { once: true });
    if (this.options.signal.aborted) { this.onAbort(); return; }
    this.requestTick();
  }
  requestTick(): void {
    if (!this.live()) return;
    // Multiple ingress/completion requests share the same positive-delay timer.
    this.arm();
  }

  private conversation(reply: ReplyRecord): string {
    const message = this.repository.read().messages[reply.messageKey];
    if (!message) throw new RuntimeError('online-message-missing');
    return JSON.stringify([message.botId, message.personalityId, message.conversationType, message.conversationId]);
  }
  private pumpOnline(concurrency: number): void {
    const state = this.repository.read();
    const pending = Object.values(state.replies).filter(reply => reply.state === 'pending')
      .sort((a, b) => {
        const left = state.messages[a.messageKey]; const right = state.messages[b.messageKey];
        if (!left || !right) throw new RuntimeError('online-message-missing');
        return left.receivedAt - right.receivedAt || left.sequence - right.sequence || a.replyId.localeCompare(b.replyId);
      });
    for (const reply of pending) {
      if (!this.live() || this.onlineActive.size >= concurrency) return;
      const conversation = this.conversation(reply);
      if (this.conversations.has(conversation) || this.onlineActive.has(reply.replyId)) continue;
      this.conversations.add(conversation);
      // Do not filter expiry: Online.run owns durable cancellation and must see expired queued jobs.
      // Do not resume generating/prepared/sending jobs: repository startup handles no-replay recovery.
      const operation = Promise.resolve().then(async () => {
        if (this.live()) await this.online.run(reply.replyId);
      }).catch(() => { this.note('online-worker-failed'); }).finally(() => {
        this.onlineActive.delete(reply.replyId); this.conversations.delete(conversation); this.requestTick();
      });
      this.onlineActive.set(reply.replyId, operation); this.track(operation);
    }
  }
  private onlineCongested(): boolean {
    // Active generation AND its outbox are online pressure, even after pending becomes generating.
    return this.onlineActive.size > 0 || Object.values(this.repository.read().replies).some(reply => reply.state === 'pending');
  }
  private valid(lease: TaskLease): boolean {
    if (!this.live() || !this.taskQueue.isLive(lease)) return false;
    try { this.repository.assertContentAllowed(this.taskQueue.guard(lease)); return true; }
    catch { return false; }
  }
  private async heartbeat(now: number): Promise<void> {
    for (const active of this.background.values()) {
      if (!this.live()) return;
      if (active.leaseLost) continue;
      if (!this.valid(active.lease)) { active.leaseLost = true; this.note('task-lease-lost'); continue; }
      if (active.nextHeartbeatAt > now) continue;
      try {
        await this.taskQueue.renew(active.lease, this.leaseMs);
        active.nextHeartbeatAt = this.now() + this.heartbeatMs;
      } catch { active.leaseLost = true; this.note('task-heartbeat-failed'); }
      // Lost/revoked leases already fail queue.guard at every future content commit. A submitted
      // external operation remains tracked/unknown; we never report its remote cancellation.
    }
  }
  private launchTask(lease: TaskLease): void {
    const task = this.repository.read().tasks[lease.taskId];
    if (!task) throw new RuntimeError('claimed-task-missing');
    const active: ActiveTask = { lease, nextHeartbeatAt: this.now() + this.heartbeatMs,
      leaseLost: false, operation: Promise.resolve() };
    const worker = task.kind === 'observation' || task.kind === 'mental-model' ? this.derived : this.retain;
    const operation = Promise.resolve().then(async () => {
      if (this.valid(lease)) await worker.run(lease);
    }).catch(async error => {
      if (!this.live()) return; // queue.stop/root signal are the local fence, not a durable false network result.
      try {
        if (error instanceof DispatchDeferred) {
          // A delayed event-loop turn may already have passed retryAt. Still yield at least one
          // positive tick instead of converting admission waiting into a charged failure attempt.
          const now = this.now();
          const retryAt = error.retryAt > now ? error.retryAt : now + this.tickMs;
          await this.taskQueue.defer(lease, retryAt, 'dispatch-deferred');
        } else await this.taskQueue.fail(lease, failureCode(error));
      } catch { this.note('task-result-commit-failed'); }
    }).finally(() => {
      if (this.background.get(lease.taskId) === active) this.background.delete(lease.taskId);
      this.requestTick();
    });
    active.operation = operation; this.background.set(lease.taskId, active); this.track(operation);
  }
  private async pumpBackground(): Promise<void> {
    for (let n = 0; n < this.claimBatch && this.live(); n++) {
      if (this.onlineCongested()) return; // Also configure queue.onlineCongested in composition for transaction-time checks.
      const lease = await this.taskQueue.claimNext(this.leaseMs);
      if (!lease || !this.live()) return;
      if (this.onlineCongested()) {
        // Ingress may have committed while claimNext was waiting on its durable commit barrier.
        await this.taskQueue.defer(lease, this.now() + this.tickMs, 'online-congested');
        return;
      }
      // An expired same-owner lease may be reclaimed while its old adapter ignores cancellation.
      // Do not launch a duplicate external operation. The new token fences the old callback; yield
      // the fresh lease WITHOUT retry cost and retain the old operation until real settlement.
      const state = this.repository.read();
      const task = state.tasks[lease.taskId];
      const snapshot = task && state.snapshots[task.snapshotId];
      if (!task || !snapshot) throw new RuntimeError('claimed-task-missing');
      const isDerived = task.kind === 'observation' || task.kind === 'mental-model';
      const sameBankUnsettled = isDerived && [...this.background.values()].some(active => {
        const other = state.tasks[active.lease.taskId];
        return other?.bankKey === task.bankKey && (other.kind === 'observation' || other.kind === 'mental-model');
      });
      // The durable queue excludes expired leases from its running count, but their external work
      // can still be unknown. Such operations continue to occupy our original-snapshot/local slots.
      if (this.background.has(lease.taskId) || this.background.size >= snapshot.budgets.retainConcurrency || sameBankUnsettled) {
        await this.taskQueue.defer(lease, this.now() + this.leaseMs, 'worker-operation-unsettled');
        return;
      }
      this.launchTask(lease);
    }
  }
  private launchAuxiliary(slot: Auxiliary, work: () => Promise<unknown>, retryInitialMs: number, retryMaxMs: number): void {
    if (!this.live() || slot.operation || slot.nextAt > this.now()) return;
    const operation = Promise.resolve().then(async () => { if (this.live()) await work(); })
      .then(() => { slot.failures = 0; slot.nextAt = this.now() + this.tickMs; }, () => {
        slot.failures = Math.min(slot.failures + 1, 21);
        slot.nextAt = this.now() + Math.min(retryMaxMs, retryInitialMs * 2 ** (slot.failures - 1));
        this.note('auxiliary-worker-failed');
      }).catch(() => { this.note('auxiliary-clock-failed'); }).finally(() => {
        if (slot.operation === operation) slot.operation = undefined;
        this.requestTick();
      });
    slot.operation = operation; this.track(operation);
  }
  private async tick(): Promise<void> {
    if (!this.live()) return;
    const { config } = this.options.readConfiguration();
    if (!bounded(config.budgets.onlineConcurrency, 1, 64) || !bounded(config.memory.cleanupBatch, 1, 500)
      || !bounded(config.memory.retryInitialMs, 1, 3_600_000) || !bounded(config.memory.retryMaxMs, config.memory.retryInitialMs, 3_600_000)) {
      throw new RuntimeError('invalid-worker-configuration');
    }
    this.pumpOnline(config.budgets.onlineConcurrency);
    // Auxiliary lanes are single-flight, bounded and independently retried, with NO retain LLM quota charge.
    this.launchAuxiliary(this.due, () => this.derived.enqueueDue(config.memory.cleanupBatch), config.memory.retryInitialMs, config.memory.retryMaxMs);
    if (this.maintenance) this.launchAuxiliary(this.maintenanceState, () => this.maintenance!.tick(config.memory.cleanupBatch),
      config.memory.retryInitialMs, config.memory.retryMaxMs);
    await this.heartbeat(this.now());
    if (this.live()) await this.pumpBackground();
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    const cancel = this.cancelTimer; this.cancelTimer = undefined;
    try { cancel?.(); } catch { this.note('scheduler-timer-cancel-failed'); }
    this.options.signal.removeEventListener('abort', this.onAbort);
    // Synchronous fences precede resolution. Never await unabortable network work or close Host handles.
    this.taskQueue.stop();
    try { this.options.stopOwnedWork(); } catch { this.note('worker-stop-hook-failed'); }
  }
  getStatus(): WorkerLoopStatus {
    return { state: this.state, timerScheduled: this.cancelTimer !== undefined, ticking: this.ticking !== undefined,
      onlineActive: this.onlineActive.size, conversationsActive: this.conversations.size, backgroundActive: this.background.size,
      leasesLost: [...this.background.values()].filter(active => active.leaseLost).length,
      derivedEnqueueActive: this.due.operation !== undefined, maintenanceActive: this.maintenanceState.operation !== undefined,
      trackedPromises: this.promises.size, errorCodes: [...this.errors] };
  }
}
