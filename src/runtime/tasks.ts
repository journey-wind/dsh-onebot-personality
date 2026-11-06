import { ControlRepository } from '../storage/repository.js';
import type { ContentGuard } from '../storage/repository.js';
import type { TaskRecord } from '../storage/model.js';
import { RuntimeError } from './configuration.js';

export interface TaskLease { readonly taskId: string; readonly ownerId: string; readonly ownerFence: number; readonly leaseToken: number }
const STAGES: TaskRecord['stage'][] = ['ingress_committed', 'raw_intent', 'raw_text_saved', 'raw_active', 'extracted_validated',
  'fact_versions_written', 'facts_active', 'derived_jobs_enqueued', 'done'];
function derived(task: TaskRecord): boolean { return task.kind === 'observation' || task.kind === 'mental-model'; }
function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new RuntimeError('counter-overflow');
  return value + 1;
}

/** Persistent task leases/checkpoints; no timer or model call is started by this class. */
export class RetainTaskQueue {
  private stopped = false;
  constructor(
    private readonly repository: ControlRepository,
    private readonly options: { now?: () => number; random?: () => number; onlineCongested?: () => boolean; isLive?: () => boolean } = {},
  ) {}
  private now(): number { return (this.options.now ?? Date.now)(); }

  private rootLive(): boolean {
    try { return !this.stopped && (this.options.isLive?.() ?? true); } catch { return false; }
  }
  isLive(lease: TaskLease): boolean {
    if (!this.rootLive() || lease.ownerFence !== this.repository.fence) return false;
    try {
      const state = this.repository.read();
      const task = state.tasks[lease.taskId];
      return state.ownerId === lease.ownerId && task?.state === 'running' && task.ownerId === lease.ownerId
        && task.fence === lease.ownerFence && task.leaseToken === lease.leaseToken && (task.leaseUntil ?? 0) > this.now();
    } catch { return false; }
  }

  /** This guard MUST accompany every checkpoint, write intent, activation and new task from a worker. */
  guard(lease: TaskLease): ContentGuard {
    const state = this.repository.read();
    const task = state.tasks[lease.taskId];
    const bank = task && state.banks[task.bankKey];
    if (!task || !bank || !this.isLive(lease)) throw new RuntimeError('task-lease-invalid');
    return { kind: 'content', fence: lease.ownerFence, botId: bank.botId, personalityId: bank.personalityId,
      provenance: structuredClone(task.provenance), validateLive: () => this.isLive(lease) };
  }

  async claimNext(leaseMs = 120_000): Promise<TaskLease | undefined> {
    if (!this.rootLive() || this.options.onlineCongested?.()) return undefined;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new RuntimeError('invalid-task-lease-duration');
    const now = this.now();
    const state = this.repository.read();
    const candidates = Object.values(state.tasks).filter(task =>
      ((task.state === 'pending' || task.state === 'retry') && task.nextRunAt <= now)
      || (task.state === 'running' && (task.leaseUntil ?? 0) <= now))
      .sort((a, b) => a.nextRunAt - b.nextRunAt || a.taskId.localeCompare(b.taskId));
    for (const candidate of candidates) {
      const snapshot = state.snapshots[candidate.snapshotId];
      const bank = state.banks[candidate.bankKey];
      if (!snapshot || !bank) throw new RuntimeError('task-reference-invalid');
      if (state.pausedBanks[bank.bankKey] || ['blocked', 'retiring', 'suspended'].includes(bank.state)) continue;
      const running = Object.values(this.repository.read().tasks).filter(task => task.state === 'running' && (task.leaseUntil ?? 0) > now);
      if (running.length >= snapshot.budgets.retainConcurrency) return undefined;
      if (derived(candidate) && running.some(task => derived(task) && task.bankKey === candidate.bankKey)) continue;
      const result = await this.repository.transact<TaskLease | undefined>({
        kind: 'content', fence: this.repository.fence, botId: bank.botId, personalityId: bank.personalityId,
        provenance: structuredClone(candidate.provenance), validateLive: () => this.rootLive() && !this.options.onlineCongested?.(),
      }, draft => {
        const task = draft.tasks[candidate.taskId];
        if (!task || !(['pending', 'retry', 'running'].includes(task.state)) || task.nextRunAt > now
          || (task.state === 'running' && (task.leaseUntil ?? 0) > now)) return undefined;
        const active = Object.values(draft.tasks).filter(other => other.state === 'running' && (other.leaseUntil ?? 0) > now);
        if (active.length >= snapshot.budgets.retainConcurrency
          || (derived(task) && active.some(other => derived(other) && other.bankKey === task.bankKey))) return undefined;
        task.state = 'running';
        task.ownerId = draft.ownerId;
        task.fence = this.repository.fence;
        task.leaseToken = increment(task.leaseToken);
        task.attemptCount = increment(task.attemptCount);
        task.attemptCalls = 0;
        task.leaseUntil = now + leaseMs;
        return { taskId: task.taskId, ownerId: draft.ownerId, ownerFence: this.repository.fence, leaseToken: task.leaseToken };
      });
      if (result) return result;
    }
    return undefined;
  }

  async renew(lease: TaskLease, leaseMs = 120_000): Promise<void> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new RuntimeError('invalid-task-lease-duration');
    await this.repository.transact(this.guard(lease), draft => { draft.tasks[lease.taskId]!.leaseUntil = this.now() + leaseMs; });
  }

  async checkpoint(lease: TaskLease, stage: TaskRecord['stage'], checkpoint: TaskRecord['checkpoint']): Promise<void> {
    await this.repository.transact(this.guard(lease), draft => {
      const task = draft.tasks[lease.taskId]!;
      if (stage === 'done' || STAGES.indexOf(stage) < STAGES.indexOf(task.stage)) throw new RuntimeError('invalid-checkpoint-transition');
      task.stage = stage;
      task.checkpoint = structuredClone(checkpoint);
    });
  }

  /** Persisted BEFORE each retain call, including format repairs, under the original snapshot. */
  async reserveCall(lease: TaskLease, estimatedTokens: number): Promise<void> {
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1) throw new RuntimeError('invalid-token-reservation');
    await this.repository.transact(this.guard(lease), draft => {
      const task = draft.tasks[lease.taskId]!;
      const snapshot = draft.snapshots[task.snapshotId]!;
      if (task.attemptCalls >= snapshot.budgets.retainMaxLlmCalls) throw new RuntimeError('retain-attempt-call-budget');
      if (task.reservedTokens + estimatedTokens > snapshot.budgets.maxRetainTaskTokens) throw new RuntimeError('retain-task-token-budget');
      task.attemptCalls = increment(task.attemptCalls);
      task.calls = increment(task.calls);
      task.reservedTokens += estimatedTokens;
    });
  }

  async finish(lease: TaskLease): Promise<void> {
    await this.repository.transact(this.guard(lease), draft => {
      const task = draft.tasks[lease.taskId]!;
      if (task.stage !== 'derived_jobs_enqueued') throw new RuntimeError('task-derived-enqueue-not-confirmed');
      task.stage = 'done'; task.state = 'done';
      delete task.ownerId; delete task.fence; delete task.leaseUntil;
    });
  }

  async fail(lease: TaskLease, code: string): Promise<void> {
    const safeCode = /^[a-zA-Z0-9:_-]{1,96}$/.test(code) ? code : 'worker-failed';
    const now = this.now();
    const random = (this.options.random ?? Math.random)();
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new RuntimeError('invalid-retry-random');
    await this.repository.transact({ kind: 'metadata', fence: lease.ownerFence }, draft => {
      const task = draft.tasks[lease.taskId];
      if (!task || task.state !== 'running' || task.ownerId !== lease.ownerId || task.fence !== lease.ownerFence
        || task.leaseToken !== lease.leaseToken) return; // Old callback cannot reset a new/cancelled task.
      const snapshot = draft.snapshots[task.snapshotId]!;
      task.failureCodes = [...task.failureCodes, safeCode].slice(-100);
      if (task.retryCount >= snapshot.budgets.retainMaxRetries) task.state = 'dead-letter';
      else {
        task.retryCount++;
        const delay = Math.min(snapshot.memory.retryMaxMs, snapshot.memory.retryInitialMs * 2 ** Math.min(task.retryCount - 1, 20));
        task.nextRunAt = now + Math.floor(delay * (0.75 + random * 0.5));
        task.state = 'retry';
      }
      delete task.ownerId; delete task.fence; delete task.leaseUntil;
    });
  }

  /** Capacity admission failed before dispatch. Preserve retry/cost history instead of burning failure attempts. */
  async defer(lease: TaskLease, nextRunAt: number, code = 'dispatch-deferred'): Promise<void> {
    if (!Number.isSafeInteger(nextRunAt) || nextRunAt <= this.now()) throw new RuntimeError('invalid-defer-time');
    const safeCode = /^[a-zA-Z0-9:_-]{1,96}$/.test(code) ? code : 'dispatch-deferred';
    await this.repository.transact({ kind: 'metadata', fence: lease.ownerFence }, draft => {
      const task = draft.tasks[lease.taskId];
      if (!task || task.state !== 'running' || task.ownerId !== lease.ownerId || task.fence !== lease.ownerFence
        || task.leaseToken !== lease.leaseToken) return;
      task.state = 'retry'; task.nextRunAt = nextRunAt;
      task.failureCodes = [...task.failureCodes, safeCode].slice(-100);
      delete task.ownerId; delete task.fence; delete task.leaseUntil;
    });
  }

  /** Explicit host administration only. Never revives cancelled/quarantined/tombstoned work. */
  async retryDeadLetter(taskId: string): Promise<void> {
    const state = this.repository.read();
    const task = state.tasks[taskId];
    const bank = task && state.banks[task.bankKey];
    if (!task || !bank || task.state !== 'dead-letter' || !state.snapshots[task.snapshotId]) throw new RuntimeError('task-not-retryable');
    await this.repository.transact({ kind: 'content', fence: this.repository.fence, botId: bank.botId, personalityId: bank.personalityId,
      provenance: structuredClone(task.provenance), validateLive: () => this.rootLive() }, draft => {
      const current = draft.tasks[taskId]!;
      if (current.state !== 'dead-letter') throw new RuntimeError('task-not-retryable');
      current.state = 'retry'; current.nextRunAt = this.now();
      // History, route, checkpoint and all cumulative counters intentionally survive.
    });
  }

  stop(): void { this.stopped = true; }
}
