import type { BankCoordinator } from '../memory/banks.js';
import type { EmbeddingRepairRunner } from '../memory/embedding-repair.js';
import type { ControlRepository } from '../storage/repository.js';
import { RuntimeError } from './configuration.js';

/** Separate maintenance lane. Limit bounds delete attempts, NOT full-bank integrity-enumeration cost. */
export class MaintenanceRunner {
  constructor(private readonly repository: ControlRepository,
    private readonly banks: Pick<BankCoordinator, 'purgeForget' | 'runCleanup' | 'reconcileBank'>,
    private readonly options: { signal: AbortSignal; isLive?: () => boolean; now?: () => number;
      embeddingRepair?: Pick<EmbeddingRepairRunner, 'run'> }) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private check(): void {
    this.options.signal.throwIfAborted();
    if (this.options.isLive && !this.options.isLive()) throw new RuntimeError('maintenance-currentness-invalid');
    this.repository.read();
  }
  async tick(limit: number): Promise<void> {
    this.check();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RuntimeError('invalid-maintenance-batch');
    const state = this.repository.read();
    const forget = Object.values(state.forgetTasks).filter(task => ['blocked', 'purging', 'retry'].includes(task.state)
      && task.nextRunAt <= this.now()).sort((a, b) => a.nextRunAt - b.nextRunAt || a.ledgerSequence - b.ledgerSequence)[0];
    if (forget) {
      await this.banks.purgeForget(forget.operationId, limit);
      return; // Privacy cleanup takes priority; no second delete budget in this tick.
    }
    const due = Object.values(state.maintenance).filter(task => ['pending', 'retry'].includes(task.state) && task.nextRunAt <= this.now())
      .sort((a, b) => a.nextRunAt - b.nextRunAt || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    const cleanup = due.find(task => task.kind === 'cleanup' || task.kind === 'orphan');
    if (cleanup) { await this.banks.runCleanup(cleanup.bankKey, limit); return; }
    const task = due[0];
    if (!task) return;
    if (task.kind === 'embedding') {
      if (this.options.embeddingRepair) { await this.options.embeddingRepair.run(task.taskId); return; }
      // Explicit unsupported lane when no verified public adapter has been composed.
      await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
        const current = draft.maintenance[task.taskId]!;
        current.state = 'dead-letter'; current.errorCodes = ['embedding-repair-unavailable'];
      });
      return;
    }
    let unknown = true;
    try { unknown = (await this.banks.reconcileBank(task.bankKey)).affectedUnknownWrites > 0; }
    catch { /* Safe fixed error below; no provider details or forgotten bodies are copied. */ }
    this.check();
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const current = draft.maintenance[task.taskId]!;
      if (!unknown) { current.state = 'done'; return; }
      current.retries++;
      current.state = current.retries >= 10 ? 'dead-letter' : 'retry';
      current.nextRunAt = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(current.retries - 1, 20));
      current.errorCodes = [...current.errorCodes, 'external-write-reconciliation-required'].slice(-100);
    });
  }
}
