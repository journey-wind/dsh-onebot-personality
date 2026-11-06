import { RuntimeError } from './configuration.js';
import type { ConfigurationReader, CurrentConfiguration } from './configuration.js';
import type { OwnedRuntime } from './bootstrap.js';
import type { RuntimeSession } from './session.js';
import { ConfigurationObservations } from './observations.js';

export interface HostStatus {
  state: 'disabled' | 'blocked' | 'starting' | 'running' | 'stopped';
  code: string;
  runtime?: ReturnType<RuntimeSession['getStatus']>;
}
export interface HostControllerOptions {
  readConfiguration: ConfigurationReader;
  isScopeLive: () => boolean;
  /** Local resource acquisition must honor cancellation and close any late acquired handles. */
  open: (observed: CurrentConfiguration, signal: AbortSignal, observations: ConfigurationObservations) => Promise<OwnedRuntime>;
  observations?: ConfigurationObservations;
  activationVerified: boolean;
  schedule?: (callback: () => void, ms: number) => () => void;
}
interface Active { observed: CurrentConfiguration; handle: OwnedRuntime; controller: AbortController }

/** Metadata-only poll drives cleanup/rebuild. It NEVER grants authorization: each session guard pulls
 * the immutable reference/fiber again at the actual SDK/body/commit boundary. No source/epoch migration. */
export class HostController {
  private started = false;
  private stopped = false;
  private desired: CurrentConfiguration | undefined;
  private active: Active | undefined;
  private opening: AbortController | undefined;
  private pump: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private cancelTimer: (() => void) | undefined;
  private phase: HostStatus['state'] = 'disabled';
  private code = 'disabled-by-configuration';
  readonly observations: ConfigurationObservations;
  constructor(private readonly options: HostControllerOptions) {
    this.observations = options.observations ?? new ConfigurationObservations();
  }
  /** Every actual pull is observed even before a session exists or after it has stopped. */
  readConfiguration(): CurrentConfiguration {
    const current = this.options.readConfiguration();
    this.observeConfiguration(current);
    return current;
  }
  private scopeLive(): boolean { try { return !this.stopped && this.options.isScopeLive(); } catch { return false; } }
  private same(left: CurrentConfiguration | undefined, right: CurrentConfiguration | undefined): boolean {
    return left === right || (!!left && !!right && left.config === right.config && left.revision === right.revision);
  }
  private fence(): void {
    this.opening?.abort(); this.active?.controller.abort();
    if (this.active) void this.active.handle.session.stop().catch(() => {});
  }
  start(): void {
    if (this.started || this.stopped) throw new RuntimeError('host-controller-already-started');
    this.started = true;
    // Schedule rather than opening inline, so the caller's synchronous effect disposer is registered first.
    if (this.options.activationVerified) this.arm(0);
  }
  private arm(ms = 250): void {
    if (!this.scopeLive() || this.cancelTimer || !this.options.activationVerified) return;
    const callback = () => { this.cancelTimer = undefined; this.poll(); };
    try {
      if (this.options.schedule) this.cancelTimer = this.options.schedule(callback, ms);
      else { const timer = setTimeout(callback, ms); timer.unref(); this.cancelTimer = () => clearTimeout(timer); }
    } catch { this.phase = 'blocked'; this.code = 'host-scheduler-failed'; void this.stop().catch(() => {}); }
  }
  private poll(): void {
    if (!this.scopeLive()) { void this.stop().catch(() => {}); return; }
    let next: CurrentConfiguration | undefined;
    try { next = this.readConfiguration(); }
    catch { this.phase = 'blocked'; this.code = 'invalid-current-configuration'; }
    if (!this.same(this.desired, next)) {
      this.desired = next; this.fence(); this.request();
    }
    this.arm();
  }
  private request(): void {
    if (this.pump || !this.scopeLive()) return;
    const operation = Promise.resolve().then(() => this.reconcile()).catch(() => {
      this.phase = 'blocked'; this.code = 'host-runtime-reconcile-failed'; this.fence();
    }).finally(() => { if (this.pump === operation) this.pump = undefined; });
    this.pump = operation;
  }
  private async closeActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.handle.close(); // Keep the reference on error; never open a second owner on uncertain teardown.
    if (this.active === active) this.active = undefined;
  }
  private async reconcile(): Promise<void> {
    while (this.scopeLive()) {
      const target = this.desired;
      if (this.active && this.same(this.active.observed, target)) return;
      await this.closeActive();
      if (!this.scopeLive()) return;
      if (!this.same(target, this.desired)) continue;
      if (!target) { this.phase = 'blocked'; this.code = 'invalid-current-configuration'; return; }
      if (!target.config.onebot.enabled) { this.phase = 'disabled'; this.code = 'disabled-by-configuration'; return; }
      if (!this.options.activationVerified) { this.phase = 'blocked'; this.code = 'development-verification-required'; return; }
      const controller = new AbortController(); this.opening = controller;
      this.phase = 'starting'; this.code = 'runtime-starting';
      let handle: OwnedRuntime;
      try { handle = await this.options.open(target, controller.signal, this.observations); }
      catch {
        if (this.opening === controller) this.opening = undefined;
        if (!this.scopeLive()) return;
        if (!this.same(target, this.desired) || controller.signal.aborted) continue;
        this.phase = 'blocked'; this.code = 'owned-runtime-startup-failed'; return;
      }
      if (this.opening === controller) this.opening = undefined;
      let current: CurrentConfiguration | undefined;
      try { current = this.readConfiguration(); } catch { /* Invalid config cannot inherit the new handle. */ }
      if (!this.scopeLive() || controller.signal.aborted || !this.same(target, this.desired) || !this.same(target, current)) {
        controller.abort(); await handle.close();
        if (this.scopeLive()) { this.desired = current; continue; }
        return;
      }
      this.active = { observed: target, handle, controller }; this.phase = 'running'; this.code = 'runtime-running';
      return;
    }
  }
  /** Observation may fence/audit old resources, but never starts new ones from a status read. */
  observeConfiguration(current: CurrentConfiguration): void {
    try { this.observations.observe(current); }
    catch { this.fence(); throw new RuntimeError('configuration-observation-blocked'); }
    if (this.active && !this.same(current, this.active.observed)) this.active.handle.session.observeConfiguration(current);
  }
  getStatus(): HostStatus {
    if (this.stopped) return { state: 'stopped', code: this.code === 'host-scheduler-failed' ? this.code : 'host-controller-stopped' };
    let current: CurrentConfiguration;
    try { current = this.readConfiguration(); }
    catch { this.fence(); return { state: 'blocked', code: 'invalid-current-configuration' }; }
    if (!this.scopeLive()) { this.fence(); return { state: 'stopped', code: 'host-scope-not-live' }; }
    if (this.active && !this.same(current, this.active.observed)) { this.fence(); }
    if (!current.config.onebot.enabled) return { state: 'disabled', code: 'disabled-by-configuration' };
    if (!this.options.activationVerified) return { state: 'blocked', code: 'development-verification-required' };
    if (this.active && this.same(current, this.active.observed)) {
      try {
        const runtime = this.active.handle.session.getStatus();
        return { state: runtime.phase === 'running' ? 'running' : 'blocked', code: runtime.phase === 'running' ? this.code : 'session-not-running', runtime };
      } catch { return { state: 'blocked', code: 'runtime-status-unavailable' }; }
    }
    return { state: this.phase === 'running' || this.phase === 'disabled' ? 'starting' : this.phase,
      code: this.phase === 'disabled' ? 'awaiting-runtime-reconcile' : this.code };
  }
  private session(): RuntimeSession {
    const current = this.readConfiguration();
    if (!this.scopeLive() || !this.active || !this.same(this.active.observed, current) || this.active.controller.signal.aborted) {
      this.fence(); throw new RuntimeError('host-runtime-not-active');
    }
    return this.active.handle.session;
  }
  async retryRetain(taskId: string): Promise<void> { await this.session().retryRetain(taskId); }
  async forgetBySource(sourceId: string, operationId?: string) { return this.session().forgetBySource(sourceId, operationId); }
  async forgetByAuthor(target: { botId: string; personalityId: string; qqId: string }, operationId?: string) {
    return this.session().forgetByAuthor(target, operationId);
  }
  getForgetStatus(operationId: string) { return this.session().getForgetStatus(operationId); }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    const cancel = this.cancelTimer; this.cancelTimer = undefined;
    try { cancel?.(); } catch { /* Do not expose scheduler error payload. */ }
    this.fence();
    this.closing = (async () => { await this.pump; await this.closeActive(); this.phase = 'stopped'; })();
    return this.closing;
  }
}
