import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { parseConfig } from '../config.js';
import { fingerprint } from '../llm/routes.js';
import type { SourceRecord } from '../storage/model.js';
import type { ControlRepository } from '../storage/repository.js';
import type { CurrentConfiguration } from './configuration.js';
import { RuntimeError } from './configuration.js';

// Root-entry lifetime only. These bounds are NOT a plugin setting or a durable/offline history claim.
// The 64-policy cap is lifetime-total even after ACK: no history eviction or automatic reset is provided.
const MAX_POLICIES = 64;
const MAX_BYTES = 1_048_576;
const MAX_STORES = 8;
interface SourcePolicy {
  readonly expectedSelfId: string;
  readonly personalityIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly privateUserIds: readonly string[];
}
interface Observation {
  readonly sequence: number;
  readonly revision: string;
  readonly policy: SourcePolicy;
}
export interface ConfigurationObservationStatus {
  readonly state: 'ready' | 'blocked';
  /** Largest unflushed suffix among known stores; all observations if none is known yet. */
  readonly pending: number;
  readonly observedPolicies: number;
  readonly trackedStores: number;
  readonly retainedBytes: number;
}
function canonicalIds(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}
function policyFrozen(config: CurrentConfiguration['config']): boolean {
  // A shallowly frozen fixture is not an immutable source policy. Check these once at cache admission.
  return Object.isFrozen(config) && Object.isFrozen(config.onebot) && Object.isFrozen(config.allow)
    && Object.isFrozen(config.allow.groupIds) && Object.isFrozen(config.allow.privateUserIds)
    && Object.isFrozen(config.personalities) && config.personalities.every(persona => Object.isFrozen(persona));
}
function allowed(source: SourceRecord, policy: SourcePolicy): boolean {
  return (!policy.expectedSelfId || source.botId === policy.expectedSelfId)
    && policy.personalityIds.includes(source.personalityId)
    && (source.conversationType === 'group' ? policy.groupIds : policy.privateUserIds).includes(source.conversationId);
}

/** Bounded metadata-only journal for ACTUALLY OBSERVED immutable configuration pulls.
 * Capture at the root entry, including while no Session/repository exists. A later C cannot erase B.
 * No authorization, grants, configRevision updates, source migration, tokens, URLs, models or bodies.
 * Retained policy metadata is never evicted; overflow/unknown audit failure permanently fails closed.
 * Whole-plugin/process loss before flush is UNKNOWN, not proof of durable Volatile history.
 */
export class ConfigurationObservations {
  private readonly epoch = randomUUID();
  private readonly observations: Observation[] = [];
  private readonly cursors = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  private lastPolicyHash: string | undefined;
  // Never strongly retain a whole configuration (credentials/models/prompts) for this metadata cache.
  private lastConfig: WeakRef<CurrentConfiguration['config']> | undefined;
  private lastRevision: string | undefined;
  private bytes = 0;
  private failed = false;

  private check(): void {
    if (this.failed) throw new RuntimeError('configuration-observations-blocked');
  }
  private storeKey(key: string): void {
    if (typeof key !== 'string' || !key || key.length > 4096 || key.includes('\0')) {
      this.failed = true; throw new RuntimeError('configuration-observations-invalid-store');
    }
  }
  /** Call synchronously on EVERY successful real reader pull, not just on active-session transitions. */
  observe(current: CurrentConfiguration): void {
    this.check();
    try {
      if (typeof current.revision !== 'string' || !current.revision || current.revision.length > 512) throw new Error();
      if (current.revision === this.lastRevision && Object.isFrozen(current.config)
        && this.lastConfig?.deref() === current.config) return;
      const config = parseConfig(current.config);
      const policy: SourcePolicy = Object.freeze({ expectedSelfId: config.onebot.expectedSelfId,
        personalityIds: canonicalIds(config.personalities.map(persona => persona.id)),
        groupIds: canonicalIds(config.allow.groupIds), privateUserIds: canonicalIds(config.allow.privateUserIds) });
      const hash = fingerprint(policy);
      // Update even for model/token-only new identities, before policy-hash dedup. Mutable input never caches.
      this.lastConfig = policyFrozen(current.config) ? new WeakRef(current.config) : undefined;
      this.lastRevision = this.lastConfig ? current.revision : undefined;
      // Only consecutive policy identity is deduplicated: B->C->B are three meaningful observations.
      if (hash === this.lastPolicyHash) return;
      const observation: Observation = Object.freeze({ sequence: this.observations.length + 1,
        revision: current.revision, policy });
      const bytes = Buffer.byteLength(JSON.stringify(observation), 'utf8');
      if (this.observations.length >= MAX_POLICIES || bytes > MAX_BYTES - this.bytes) {
        this.failed = true; throw new RuntimeError('configuration-observations-overflow');
      }
      this.observations.push(observation); this.bytes += bytes; this.lastPolicyHash = hash;
    } catch (error) {
      this.failed = true;
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('configuration-observations-invalid');
    }
  }

  /** Caller supplies the held owner's CANONICAL store key and an open repository BEFORE C workers.
   * Every historical projection captures current target epochs BEFORE awaiting its first ledger write.
   * Per-store cursors advance only after every target ACK; C's later fresh epochs are never re-revoked.
   * Call again before repository close; observations arriving during await are drained by this same loop.
   */
  flush(repository: ControlRepository, storeKey: string): Promise<void> {
    const pending = this.tail.then(async () => {
      this.check(); this.storeKey(storeKey);
      if (!this.cursors.has(storeKey)) {
        if (this.cursors.size >= MAX_STORES) {
          this.failed = true; throw new RuntimeError('configuration-observations-store-overflow');
        }
        this.cursors.set(storeKey, 0);
      }
      while ((this.cursors.get(storeKey) ?? 0) < this.observations.length) {
        this.check();
        const observation = this.observations[this.cursors.get(storeKey)!]!;
        const targets = Object.values(repository.read().sources)
          .filter(source => source.allowed && !allowed(source, observation.policy))
          .map(source => ({ sourceId: source.sourceId, throughEpoch: source.sourceEpoch }));
        for (const target of targets) {
          this.check();
          await repository.recordDeletion(`revoke:${fingerprint(['source-policy-observation', this.epoch, storeKey,
            observation.sequence, observation.revision, target.sourceId, target.throughEpoch])}`,
          { kind: 'source', ...target }, 'revoke');
        }
        this.check(); this.cursors.set(storeKey, observation.sequence);
      }
      this.check();
    }).catch(() => {
      this.failed = true; throw new RuntimeError('configuration-observations-audit-failed');
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  /** Synchronous FINAL guard immediately before owner release, with no intervening await.
   * If a pull observed B AFTER repository close, do NOT flush a closed repository or claim success:
   * retain the old owner/fail closed (or reopen domains under that same held owner and flush first).
   */
  assertFlushed(storeKey: string): void {
    this.check(); this.storeKey(storeKey);
    if (this.cursors.get(storeKey) !== this.observations.length) {
      throw new RuntimeError('configuration-observations-pending');
    }
  }

  getStatus(): ConfigurationObservationStatus {
    let pending = this.cursors.size ? 0 : this.observations.length;
    for (const cursor of this.cursors.values()) pending = Math.max(pending, this.observations.length - cursor);
    return { state: this.failed ? 'blocked' : 'ready', pending, observedPolicies: this.observations.length,
      trackedStores: this.cursors.size, retainedBytes: this.bytes };
  }
}
