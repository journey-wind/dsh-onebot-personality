import { randomUUID } from 'node:crypto';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { StageCaller } from '../llm/calls.js';
import { BankCoordinator } from '../memory/banks.js';
import { DerivedManager } from '../memory/derived.js';
import { EmbeddingRepairRunner } from '../memory/embedding-repair.js';
import { KnowledgeAdapter } from '../memory/knowledge.js';
import type { PublicKnowledgeService } from '../memory/knowledge.js';
import { RecallEngine } from '../memory/recall.js';
import { RetainWorker } from '../memory/retain.js';
import { OneBotClient } from '../onebot/client.js';
import type { OneBotClientOptions, ReadyIdentity } from '../onebot/client.js';
import { normalizeMessageEvent, normalizeQQId } from '../onebot/protocol.js';
import { LivePolicy } from '../policy/live.js';
import type { ForgetTarget } from '../storage/model.js';
import { ControlRepository } from '../storage/repository.js';
import { ConfigurationCoordinator, RuntimeError } from './configuration.js';
import type { ConfigurationReader, CurrentConfiguration } from './configuration.js';
import { Ingress, inboundBodyHash } from './ingress.js';
import type { IngressDependencies } from './ingress.js';
import { MaintenanceRunner } from './maintenance.js';
import { OnlinePipeline } from './online.js';
import { Outbox } from './outbox.js';
import { ProviderQuota } from './quota.js';
import { materializeSnapshot } from './snapshots.js';
import { RetainTaskQueue } from './tasks.js';
import type { TaskLease } from './tasks.js';
import { WorkerLoop } from './worker-loop.js';

export type RuntimeTransport = Pick<OneBotClient, 'start' | 'dispose' | 'identity' | 'getStatus' | 'getGroupMemberInfo' | 'prepareTextSend'>;
export interface RuntimeSessionOptions {
  readConfiguration: ConfigurationReader;
  /** Host-owned across configuration-driven sessions. Borrowed counters are never reset/stopped here. */
  providerQuota?: ProviderQuota;
  /** Optional cleanup notification only; authorization ALWAYS pulls the current immutable reference. */
  watchConfiguration?: (changed: () => void) => () => void;
  /** Public Host fiber liveness, read at every sensitive operation, including before disposer invocation. */
  isScopeLive?: () => boolean;
  resolveRoutes: IngressDependencies['resolveRoutes'];
  availableDiskBytes: IngressDependencies['availableDiskBytes'];
  /** Factories construct inert clients; they MUST NOT start/emit before start() is called. */
  createTransport?: (options: OneBotClientOptions) => RuntimeTransport;
  signal?: AbortSignal;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => () => void;
}
type Phase = 'idle' | 'starting' | 'disabled' | 'running' | 'stopping' | 'stopped';

/** Pure composition until explicit start(). Host bootstrap still owns capability proof, domains and owner lock.
 * This session never closes the supplied repository or borrowed Host LLM/knowledge services. */
export class RuntimeSession {
  private readonly root = new AbortController();
  private phase: Phase = 'idle';
  private readonly initial: CurrentConfiguration;
  private readonly configuration: ConfigurationCoordinator;
  private readonly transport: RuntimeTransport;
  private readonly policy: LivePolicy;
  private readonly quota: ProviderQuota;
  private readonly ownsQuota: boolean;
  private readonly queue: RetainTaskQueue;
  private readonly banks: BankCoordinator;
  private readonly embeddingRepair: EmbeddingRepairRunner;
  private readonly derived: DerivedManager;
  private readonly outbox: Outbox;
  private readonly ingress: Ingress;
  private readonly loop: WorkerLoop;
  private stopPromise: Promise<void> | undefined;
  private unwatch: (() => void) | undefined;
  private readonly errors: string[] = [];
  private rejectedEvents = 0;
  private readonly onExternalAbort = () => { void this.stop().catch(() => this.note('shutdown-failed')); };

  constructor(private readonly repository: ControlRepository, llm: Pick<LlmRuntime, 'prepareCall'>,
    knowledge: PublicKnowledgeService, private readonly options: RuntimeSessionOptions) {
    if ((options.watchConfiguration !== undefined && typeof options.watchConfiguration !== 'function')
      || typeof options.availableDiskBytes !== 'function' || typeof options.resolveRoutes !== 'function') throw new RuntimeError('runtime-dependencies-unavailable');
    this.initial = options.readConfiguration();
    this.configuration = new ConfigurationCoordinator(repository, options.readConfiguration);
    const config = this.initial.config;
    const transportOptions: OneBotClientOptions = { ...config.onebot,
      allowInsecureRemoteWs: config.security.allowInsecureRemoteWs, maxPayloadBytes: config.budgets.maxEventBytes,
      maxActionBytes: config.budgets.sendSegmentBytes,
      onEvent: (event, identity) => this.accept(event, identity),
      onLateSendOutcome: outcome => this.outbox.handleLateOutcome(outcome),
    };
    this.transport = (options.createTransport ?? (value => new OneBotClient(value)))(transportOptions);
    const signal = this.root.signal;
    const readConfiguration = (): CurrentConfiguration => {
      const current = options.readConfiguration();
      if (!this.matches(current)) { this.observeConfiguration(current); throw new RuntimeError('runtime-currentness-invalid'); }
      return current;
    };
    const isLive = () => this.live();
    const adapter = new KnowledgeAdapter(knowledge, { isLive });
    const caller = new StageCaller(llm);
    this.ownsQuota = options.providerQuota === undefined;
    this.quota = options.providerQuota ?? new ProviderQuota({ readLimits: () => options.readConfiguration().config.budgets,
      ...(options.now ? { now: options.now } : {}) });
    this.queue = new RetainTaskQueue(repository, { isLive, ...(options.now ? { now: options.now } : {}),
      onlineCongested: () => signal.aborted || Object.values(repository.read().replies).some(reply => reply.state === 'pending' || reply.state === 'generating') });
    this.banks = new BankCoordinator(repository, adapter, { isLive, ...(options.now ? { now: options.now } : {}),
      ...(options.schedule ? { schedule: options.schedule } : {}) });
    this.embeddingRepair = new EmbeddingRepairRunner(repository, adapter, { signal, isLive,
      ...(options.now ? { now: options.now } : {}), ...(options.schedule ? { schedule: options.schedule } : {}) });
    this.policy = new LivePolicy(repository, { readConfiguration, onebot: this.transport, ...(options.now ? { now: options.now } : {}) });
    this.outbox = new Outbox(repository, this.transport, { readConfiguration, ...(options.now ? { now: options.now } : {}),
      authorizeReply: async (reply, force) => {
        this.ensureActive();
        const guard = await this.policy.authorizeReply(reply, force);
        this.ensureActive();
        return { ...guard, validateLive: () => this.live() && guard.validateLive?.() === true };
      } });
    const admitCall = async (lease: TaskLease, tokens: number): Promise<void> => {
      this.ensureActive(); this.queue.guard(lease);
      const task = repository.read().tasks[lease.taskId]!;
      const snapshot = materializeSnapshot(repository.read().snapshots[task.snapshotId]);
      this.quota.reserve('retain', snapshot.routes.retain.provider, tokens, 'retain', signal);
    };
    this.derived = new DerivedManager(repository, this.queue, this.banks, caller,
      { signal, isLive, admitCall, ...(options.now ? { now: options.now } : {}) });
    const retain = new RetainWorker(repository, this.queue, this.banks, caller,
      { signal, isLive, admitCall, derived: this.derived, ...(options.now ? { now: options.now } : {}) });
    const recall = new RecallEngine(repository, adapter, this.policy, { readConfiguration, ...(options.now ? { now: options.now } : {}) });
    const online = new OnlinePipeline(repository, this.policy, recall, caller, this.outbox, { signal,
      ...(options.now ? { now: options.now } : {}), beforeCall: async (snapshot, stage, tokens) => {
        this.ensureActive(); this.quota.reserve('online', snapshot.routes[stage].provider, tokens, stage, signal);
      } });
    this.ingress = new Ingress(repository, { readConfiguration, readIdentity: () => this.transport.identity,
      resolveRoutes: options.resolveRoutes, availableDiskBytes: options.availableDiskBytes, signal, isLive });
    const maintenance = new MaintenanceRunner(repository, this.banks, { signal, isLive, embeddingRepair: this.embeddingRepair,
      ...(options.now ? { now: options.now } : {}) });
    this.loop = new WorkerLoop(repository, this.queue, online, retain, this.derived, maintenance, { signal, readConfiguration,
      stopOwnedWork: () => { this.fence(); void this.stop().catch(() => this.note('shutdown-failed')); }, ...(options.now ? { now: options.now } : {}),
      ...(options.schedule ? { schedule: options.schedule } : {}) });
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private note(code: string): void { this.errors.push(code); if (this.errors.length > 16) this.errors.shift(); }
  private fence(): void {
    // Synchronous and idempotent: no await between config/unload invalidation and send/worker fencing.
    const first = !this.root.signal.aborted;
    if (first) this.root.abort();
    this.queue?.stop(); if (this.ownsQuota) this.quota?.stop(); this.banks?.fence(); this.embeddingRepair?.fence();
    if (first) try { this.transport?.dispose(); } catch { this.note('transport-stop-failed'); }
  }
  private matches(current: CurrentConfiguration): boolean {
    return (this.options.isScopeLive?.() ?? true) && current.config === this.initial.config && current.revision === this.initial.revision;
  }
  private invalidate(): void {
    this.fence(); void this.stop().catch(() => this.note('shutdown-failed'));
  }
  /** Metadata-only observation, not an authorization hook. Capture revokes BEFORE abort handlers start teardown. */
  observeConfiguration(current: CurrentConfiguration): void {
    // A stopped session cannot append audits to a closing/closed repository. The root handoff
    // journal retains these observations and blocks a replacement until its own flush succeeds.
    if (this.phase === 'stopped') return;
    const audit = this.configuration.observeWithdrawals(current);
    void audit.catch(() => this.note('configuration-withdrawal-audit-failed'));
    this.invalidate();
  }
  private live(): boolean {
    if (this.root.signal.aborted) return false;
    try {
      const current = this.options.readConfiguration();
      if (this.matches(current)) return true;
      this.observeConfiguration(current); return false;
    } catch { /* Invalid references fail closed, never guess a replacement permission set. */ }
    this.invalidate(); return false;
  }
  private ensureActive(): void {
    if (!this.live() || this.phase !== 'running') throw new RuntimeError('runtime-not-active');
  }
  private administrative(): void {
    if (!this.live() || !['running', 'disabled'].includes(this.phase)) throw new RuntimeError('runtime-not-active');
    this.repository.read();
  }

  async start(): Promise<void> {
    if (this.phase !== 'idle') throw new RuntimeError('runtime-already-started');
    this.phase = 'starting';
    this.options.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
    try {
      if (this.options.signal?.aborted) throw new RuntimeError('runtime-stopped');
      if (this.options.watchConfiguration) {
      const unwatch = this.options.watchConfiguration(() => {
        try { this.observeConfiguration(this.options.readConfiguration()); }
        catch { this.invalidate(); }
      });
      if (typeof unwatch !== 'function') throw new RuntimeError('runtime-watch-unavailable');
      if (this.root.signal.aborted) { unwatch(); throw new RuntimeError('runtime-stopped'); }
      this.unwatch = unwatch;
      }
      if (!this.live()) throw new RuntimeError('runtime-currentness-invalid');
      await this.configuration.apply(this.initial, true);
      if (!this.live()) throw new RuntimeError('runtime-currentness-invalid');
      if (!this.initial.config.onebot.enabled) { this.phase = 'disabled'; return; }
      this.phase = 'running'; this.ensureActive(); this.transport.start(); this.loop.start(); this.root.signal.throwIfAborted();
    } catch {
      this.note('startup-failed'); await this.stop(); throw new RuntimeError('runtime-startup-failed');
    }
  }
  private async accept(event: Readonly<Record<string, unknown>>, identity: ReadyIdentity): Promise<void> {
    try {
      this.ensureActive();
      const actual = this.transport.identity; const config = this.initial.config;
      if (!actual || actual.selfId !== identity.selfId || actual.connectionEpoch !== identity.connectionEpoch
        || actual.selfId !== config.onebot.expectedSelfId || normalizeQQId(event.self_id) !== actual.selfId) return;
      if (event.post_type === 'notice') {
        if (['group_decrease', 'group_increase', 'group_admin'].includes(String(event.notice_type))) {
          const groupId = normalizeQQId(event.group_id);
          let userId: string | undefined;
          try { userId = normalizeQQId(event.user_id); } catch { /* Unknown member invalidates this group's proofs. */ }
          this.policy.invalidateMembers(groupId, userId);
        }
        return;
      }
      const message = normalizeMessageEvent(event, { expectedSelfId: actual.selfId,
        knownSecrets: config.onebot.token ? [config.onebot.token] : [], limits: {
          maxEventBytes: config.budgets.maxEventBytes, maxTextBytes: config.budgets.maxTextBytes, maxSegments: config.budgets.maxSegments } });
      if (!message) return;
      const result = await this.ingress.accept(message, inboundBodyHash(event.message), this.now());
      if (result.status === 'accepted') this.loop.requestTick();
    } catch {
      if (this.phase === 'running' && !this.root.signal.aborted) this.rejectedEvents = Math.min(Number.MAX_SAFE_INTEGER, this.rejectedEvents + 1);
      this.note('inbound-rejected-or-runtime-stopped');
    }
  }

  async forgetBySource(sourceId: string, operationId: string = randomUUID()): Promise<ReturnType<RuntimeSession['getForgetStatus']>> {
    this.administrative();
    const source = this.repository.read().sources[sourceId];
    if (!source) throw new RuntimeError('forget-source-not-found');
    return this.forget(operationId, { kind: 'source', sourceId, throughEpoch: source.sourceEpoch });
  }
  async forgetByAuthor(target: { botId: string; personalityId: string; qqId: string }, operationId: string = randomUUID()): Promise<ReturnType<RuntimeSession['getForgetStatus']>> {
    this.administrative();
    const botId = normalizeQQId(target.botId); const qqId = normalizeQQId(target.qqId);
    const keys = Object.values(this.repository.read().messages).filter(message => message.botId === botId
      && message.personalityId === target.personalityId && message.author.kind === 'qq' && message.author.qqId === qqId).map(message => message.key);
    if (!keys.length) throw new RuntimeError('forget-target-empty');
    return this.forget(operationId, { kind: 'messages', messageKeys: keys });
  }
  private async forget(operationId: string, target: ForgetTarget) {
    await this.repository.recordDeletion(operationId, target, 'forget', this.now());
    try { await this.derived.afterDeletion(target); }
    catch { this.note('derived-deletion-refresh-required'); }
    this.loop.requestTick();
    return this.getForgetStatus(operationId);
  }
  getForgetStatus(operationId: string) {
    const task = this.repository.read().forgetTasks[operationId];
    if (!task) throw new RuntimeError('forget-operation-not-found');
    return { operationId: task.operationId, state: task.state, logicallyBlocked: true as const,
      externalWriteUnknown: task.externalWriteUnknown, pendingDocuments: task.docIdsPending.length,
      retries: task.retries, nextRunAt: task.nextRunAt, errorCodes: [...task.errorCodes] };
  }
  async retryRetain(taskId: string): Promise<void> {
    this.ensureActive(); await this.queue.retryDeadLetter(taskId); this.loop.requestTick();
  }
  getStatus() {
    this.live(); // Pull invalidation also on administrative status reads; never rely on notification delivery.
    const health = this.repository.getHealth();
    const counts: Record<string, number> = {};
    const banks: { bankKey: string; botId: string; personalityId: string; state: string; revision: number;
      activeMemories: number; failedVectors: number; unknownWrites: number }[] = [];
    if (health.state === 'ready') {
      const state = this.repository.read();
      for (const task of Object.values(state.tasks)) counts[task.state] = (counts[task.state] ?? 0) + 1;
      const byBank = new Map<string, { activeMemories: number; failedVectors: number; unknownWrites: number }>();
      for (const bank of Object.values(state.banks)) byBank.set(bank.bankKey, { activeMemories: 0, failedVectors: 0, unknownWrites: 0 });
      for (const memory of Object.values(state.memories)) {
        const entry = byBank.get(memory.bankKey);
        if (entry) { if (memory.active) entry.activeMemories++; if (memory.vectorState === 'failed') entry.failedVectors++; }
      }
      for (const intent of Object.values(state.intents)) if (intent.externalWrite === 'unknown' || intent.externalWrite === 'in_flight') {
        const entry = byBank.get(intent.bankKey); if (entry) entry.unknownWrites++;
      }
      for (const task of Object.values(state.maintenance)) if (task.mutation && ['unknown', 'in_flight'].includes(task.mutation.externalWrite)) {
        const entry = byBank.get(task.bankKey); if (entry) entry.unknownWrites++;
      }
      for (const bank of Object.values(state.banks)) banks.push({ bankKey: bank.bankKey, botId: bank.botId,
        personalityId: bank.personalityId, state: bank.state, revision: bank.revision, ...byBank.get(bank.bankKey)! });
    }
    return { phase: this.phase, storage: health, transport: this.transport.getStatus(), ingress: this.ingress.getStatus(),
      workers: this.loop.getStatus(), quotas: this.quota.getStatus(), tasks: counts, banks, rejectedEvents: this.rejectedEvents,
      deliveryContinuity: 'forward-ws-no-replay-guarantee' as const, errorCodes: [...this.errors] };
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    this.stopPromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.phase = 'stopping'; this.fence();
    this.options.signal?.removeEventListener('abort', this.onExternalAbort);
    const unwatch = this.unwatch; this.unwatch = undefined;
    try { unwatch?.(); } catch { this.note('configuration-unwatch-failed'); }
    void (async () => {
      try { await this.loop.stop(); await this.embeddingRepair.stop(); await this.banks.stop(); }
      finally { try { await this.configuration.drainObserved(); } finally { this.phase = 'stopped'; } }
    })().then(resolve, reject);
    return this.stopPromise;
  }
}
