import type { PluginConfig, Stage } from '../config.js';
import { DispatchDeferred, StageError } from '../llm/calls.js';
import { RuntimeError } from './configuration.js';

export type QuotaLimits = Pick<PluginConfig['budgets'], 'onlineRequestsPerMinute' | 'retainRequestsPerMinute'
  | 'onlineTokensPerMinute' | 'retainTokensPerMinute'>;
export type QuotaLane = 'online' | 'retain';
export interface ProviderQuotaOptions { readLimits: () => QuotaLimits; now?: () => number }
interface Entry { at: number; lane: QuotaLane; requests: number; tokens: number }
interface Usage { entries: Entry[] }
interface Counts { requests: number; tokens: number; retainRequests: number; retainTokens: number }
export interface ProviderQuotaStatus {
  readonly stopped: boolean;
  readonly windowMs: number;
  readonly providers: readonly {
    readonly provider: string;
    readonly requests: number;
    readonly tokens: number;
    readonly retainRequests: number;
    readonly retainTokens: number;
    /** Earliest admission of ONE token, not a promise to admit an arbitrary payload. null means disabled/stopped. */
    readonly nextOnlineAt: number | null;
    readonly nextRetainAt: number | null;
  }[];
}
const WINDOW = 60_000;
const MAX_PROVIDERS = 1024;
const EVICTION_BATCH = 32;

/**
 * Process-local, plugin-owned rolling admission accounting, keyed ONLY by registered provider ID.
 * The composition must pass IDs already resolved/validated by the DSH route registry, never URLs,
 * credentials, models, prompts or request bodies. No registry, authentication or network calls occur here.
 * Aliases/other plugins/processes may share a supplier: this is NOT a supplier-global guarantee.
 * A reservation is never refunded: cancellation/adapter failure does not prove no supplier work occurred.
 */
export class ProviderQuota {
  private stopped = false;
  private lastNow = 0;
  private readonly usage = new Map<string, Usage>();
  private sweep: IterableIterator<[string, Usage]> | undefined;
  constructor(private readonly options: ProviderQuotaOptions) {}

  private now(): number {
    let value: number;
    try { value = (this.options.now ?? Date.now)(); } catch { throw new RuntimeError('invalid-quota-clock'); }
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - WINDOW) {
      throw new RuntimeError('invalid-quota-clock');
    }
    // A wall-clock correction must not refund admissions made in the apparent future.
    return this.lastNow = Math.max(this.lastNow, value);
  }
  private limits(): QuotaLimits {
    let limits: QuotaLimits;
    try { limits = this.options.readLimits(); } catch { throw new RuntimeError('invalid-quota-limits'); }
    if (!limits || ![limits.onlineRequestsPerMinute, limits.retainRequestsPerMinute].every(value =>
      Number.isSafeInteger(value) && value >= 1 && value <= 10_000)
      || ![limits.onlineTokensPerMinute, limits.retainTokensPerMinute].every(value =>
        Number.isSafeInteger(value) && value >= 256 && value <= 10_000_000)) throw new RuntimeError('invalid-quota-limits');
    return limits;
  }
  private prune(usage: Usage, now: number): void {
    let expired = 0;
    while (expired < usage.entries.length && usage.entries[expired]!.at + WINDOW <= now) expired++;
    if (expired) usage.entries.splice(0, expired);
  }
  private evict(now: number): void {
    // Bounded provider traversal; targeted providers are also pruned on every access.
    this.sweep ??= this.usage.entries();
    for (let n = 0; n < EVICTION_BATCH; n++) {
      const item = this.sweep.next();
      if (item.done) { this.sweep = undefined; break; }
      const [provider, usage] = item.value;
      this.prune(usage, now);
      if (!usage.entries.length) this.usage.delete(provider);
    }
  }
  private counts(usage: Usage | undefined): Counts {
    const counts: Counts = { requests: 0, tokens: 0, retainRequests: 0, retainTokens: 0 };
    for (const entry of usage?.entries ?? []) {
      counts.requests += entry.requests; counts.tokens += entry.tokens;
      if (entry.lane === 'retain') { counts.retainRequests += entry.requests; counts.retainTokens += entry.tokens; }
    }
    return counts;
  }
  private earliest(usage: Usage | undefined, lane: QuotaLane, tokens: number, limits: QuotaLimits, now: number): number | null {
    const retainRequests = Math.min(limits.retainRequestsPerMinute, Math.floor(limits.onlineRequestsPerMinute / 2));
    const retainTokens = Math.min(limits.retainTokensPerMinute, Math.floor(limits.onlineTokensPerMinute / 2));
    if (tokens > limits.onlineTokensPerMinute || (lane === 'retain' && (retainRequests < 1 || tokens > retainTokens))) return null;
    const counts = this.counts(usage);
    const fits = () => counts.requests + 1 <= limits.onlineRequestsPerMinute && counts.tokens + tokens <= limits.onlineTokensPerMinute
      && (lane === 'online' || (counts.retainRequests + 1 <= retainRequests && counts.retainTokens + tokens <= retainTokens));
    if (fits()) return now;
    // Chronological expiration accounts for BOTH constraints at once (including same-millisecond batches).
    for (const entry of usage?.entries ?? []) {
      counts.requests -= entry.requests; counts.tokens -= entry.tokens;
      if (entry.lane === 'retain') { counts.retainRequests -= entry.requests; counts.retainTokens -= entry.tokens; }
      if (fits()) return entry.at + WINDOW;
    }
    return now; // Empty usage always fits a validated individual reservation.
  }

  reserve(lane: QuotaLane, provider: string, tokens: number, stage: Stage, signal?: AbortSignal): void {
    if (this.stopped) throw new RuntimeError('quota-stopped');
    if (signal?.aborted) throw new RuntimeError('quota-cancelled');
    if ((lane !== 'online' && lane !== 'retain') || typeof provider !== 'string' || provider.length < 1 || provider.length > 256
      || provider !== provider.trim() || /[\s\u0000-\u001f\u007f]/u.test(provider) || provider.includes('://')
      || !Number.isSafeInteger(tokens) || tokens < 1
      || !['router', 'recall', 'reflect', 'retain', 'reply'].includes(stage)) throw new RuntimeError('invalid-quota-reservation');
    const limits = this.limits(); const now = this.now();
    this.evict(now);
    let usage = this.usage.get(provider);
    if (usage) this.prune(usage, now);
    const retryAt = this.earliest(usage, lane, tokens, limits, now);
    if (retryAt === null) throw new StageError(stage, 'quota-request-exceeds-window');
    if (retryAt > now) throw new DispatchDeferred(stage, retryAt);
    if (!usage) {
      if (this.usage.size >= MAX_PROVIDERS) throw new RuntimeError('quota-provider-capacity');
      usage = { entries: [] }; this.usage.set(provider, usage);
    }
    // At most 10000 admissions/provider/window; adjacent same-time/lane entries are folded.
    const last = usage.entries.at(-1);
    if (last?.at === now && last.lane === lane) { last.requests++; last.tokens += tokens; }
    else usage.entries.push({ at: now, lane, requests: 1, tokens });
  }

  getStatus(): ProviderQuotaStatus {
    const now = this.now(); const limits = this.limits(); this.evict(now);
    return { stopped: this.stopped, windowMs: WINDOW, providers: [...this.usage].map(([provider, usage]) => {
      this.prune(usage, now);
      return { provider, ...this.counts(usage),
        nextOnlineAt: this.stopped ? null : this.earliest(usage, 'online', 1, limits, now),
        nextRetainAt: this.stopped ? null : this.earliest(usage, 'retain', 1, limits, now) };
    }) };
  }
  stop(): void { this.stopped = true; }
}
