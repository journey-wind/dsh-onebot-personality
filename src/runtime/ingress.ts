import { randomUUID } from 'node:crypto';
import { selectPersonality } from '../config.js';
import type { Personality, PluginConfig } from '../config.js';
import { createSnapshot, fingerprint } from '../llm/routes.js';
import type { FiveRoutes } from '../llm/routes.js';
import { matchesTrigger, normalizeMessageEvent } from '../onebot/protocol.js';
import type { NormalizedMessage } from '../onebot/protocol.js';
import { ControlRepository } from '../storage/repository.js';
import type { ControlState, Provenance } from '../storage/model.js';
import { RuntimeError } from './configuration.js';
import type { ConfigurationReader } from './configuration.js';

export interface VerifiedIdentity { readonly selfId: string; readonly connectionEpoch: string }
export type IngressResult =
  | { status: 'ignored'; code: string }
  | { status: 'duplicate'; messageKey: string }
  | { status: 'accepted'; messageKey: string; retainTaskId: string; replyId?: string };
export interface IngressDependencies {
  readConfiguration: ConfigurationReader;
  readIdentity: () => VerifiedIdentity | undefined;
  resolveRoutes: (config: PluginConfig, persona: Personality, signal: AbortSignal) => Promise<FiveRoutes>;
  /** Required real disk probe at deployment. Unobservable disk health fails closed. */
  availableDiskBytes: () => Promise<number>;
  signal: AbortSignal;
  isLive?: () => boolean;
}

/** Hash only bounded inbound message data, never transport headers, tokens or an auth environment. */
export function inboundBodyHash(messageData: unknown): string {
  return fingerprint({ encoding: 'onebot-inbound-message-v1', messageData });
}
export function bankKeyFor(botId: string, personalityId: string): string {
  return `bank-${fingerprint([botId, personalityId])}`;
}
export function sourceIdFor(botId: string, personalityId: string, type: 'group' | 'private', conversationId: string): string {
  return `source-${fingerprint([botId, personalityId, type, conversationId])}`;
}
export function inboxBytes(state: Readonly<ControlState>): number {
  return Object.values(state.messages).reduce((sum, message) => sum
    + Buffer.byteLength(message.text ?? '', 'utf8') + Buffer.byteLength(message.sanitizedEventJson ?? '', 'utf8'), 0);
}
function pendingCount(state: Readonly<ControlState>): number {
  return Object.values(state.tasks).filter(task => ['pending', 'running', 'retry'].includes(task.state)).length;
}
function assertCapacity(state: Readonly<ControlState>, config: PluginConfig, bytes: number): void {
  if (pendingCount(state) >= config.budgets.maxPendingTasks) throw new RuntimeError('retain-queue-full');
  if (inboxBytes(state) + bytes > config.budgets.inboxMaxBytes) throw new RuntimeError('inbox-byte-quota');
}

/** No online generation is scheduled until the atomic ingress commit acknowledges durability. */
export class Ingress {
  private knownDropped = 0;
  private pausedCode: string | undefined;
  constructor(private readonly repository: ControlRepository, private readonly dependencies: IngressDependencies) {}
  getStatus(): { knownDropped: number; state: 'ready' | 'paused'; code?: string } {
    return { knownDropped: this.knownDropped, state: this.pausedCode ? 'paused' : 'ready',
      ...(this.pausedCode ? { code: this.pausedCode } : {}) };
  }

  private reject(code: string): never {
    this.knownDropped++;
    this.pausedCode = code;
    throw new RuntimeError(code);
  }

  private async recordConflict(messageKey: string, firstHash: string, nextHash: string, at: number): Promise<void> {
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const previous = draft.ingressConflicts[messageKey];
      if ((previous?.count ?? 0) >= Number.MAX_SAFE_INTEGER) throw new RuntimeError('counter-overflow');
      draft.ingressConflicts[messageKey] = {
        count: (previous?.count ?? 0) + 1, firstSeenAt: previous?.firstSeenAt ?? at, lastSeenAt: at,
        bodyHashes: [...new Set([...(previous?.bodyHashes ?? [firstHash]), nextHash])].slice(0, 8),
      };
    });
  }

  /** message was normalized by trusted protocol code; bodyHash is host-computed before redaction. */
  async accept(message: NormalizedMessage, bodyHash: string, receivedAt = Date.now()): Promise<IngressResult> {
    const { readConfiguration, readIdentity, signal } = this.dependencies;
    signal.throwIfAborted();
    const observed = readConfiguration();
    signal.throwIfAborted();
    if (this.dependencies.isLive && !this.dependencies.isLive()) throw new RuntimeError('admission-currentness-invalid');
    const config = observed.config;
    const identity = readIdentity();
    if (!config.onebot.enabled) return { status: 'ignored', code: 'disabled' };
    if (!identity || identity.selfId !== config.onebot.expectedSelfId || identity.selfId !== message.botId) {
      return { status: 'ignored', code: 'unverified-identity' };
    }
    const allowed = message.conversationType === 'group' ? config.allow.groupIds : config.allow.privateUserIds;
    if (!allowed.includes(message.conversationId)) return { status: 'ignored', code: 'not-allowed' };
    if (!/^[a-f0-9]{64}$/.test(bodyHash) || !Number.isSafeInteger(receivedAt) || receivedAt < 0) this.reject('invalid-ingress-metadata');
    let initial: Readonly<ControlState>;
    try { initial = this.repository.read(); } catch { this.reject('storage-unavailable'); }
    if (initial.configRevision !== observed.revision) this.reject('configuration-not-reconciled');
    const prior = initial.messages[message.idempotencyKey];
    if (prior) {
      if (prior.bodyHash !== bodyHash) {
        this.knownDropped++;
        try { await this.recordConflict(prior.key, prior.bodyHash, bodyHash, receivedAt); }
        catch { this.pausedCode = 'conflict-audit-failed'; throw new RuntimeError(this.pausedCode); }
        throw new RuntimeError('idempotency-conflict');
      }
      return { status: 'duplicate', messageKey: prior.key };
    }
    if (initial.forgottenMessages[message.idempotencyKey]) return { status: 'ignored', code: 'message-tombstoned' };
    const persona = selectPersonality(config, message.conversationType, message.conversationId);
    const bankKey = bankKeyFor(message.botId, persona.id);
    const sourceId = sourceIdFor(message.botId, persona.id, message.conversationType, message.conversationId);
    const isCurrent = (): boolean => {
      const current = readConfiguration();
      const liveIdentity = readIdentity();
      return !signal.aborted && (this.dependencies.isLive?.() ?? true)
        && current.config === observed.config && current.revision === observed.revision && current.config.onebot.enabled
        && liveIdentity?.selfId === identity.selfId && liveIdentity.connectionEpoch === identity.connectionEpoch;
    };
    // Normalization must be called with the configured token. Defense in depth prevents a caller
    // forgetting that option from persisting it in either text or structured retained projection.
    const credential = config.onebot.token;
    const identifiers = [message.botId, message.conversationId, message.messageId,
      message.author.kind === 'qq' ? message.author.qqId : message.author.localId];
    if (credential && identifiers.some(value => value.includes(credential))) this.reject('credential-bearing-identity');
    let safe: NormalizedMessage | null;
    try {
      safe = normalizeMessageEvent(message.sanitizedEvent, {
        expectedSelfId: identity.selfId, knownSecrets: credential ? [credential] : [],
        limits: { maxEventBytes: config.budgets.maxEventBytes, maxTextBytes: config.budgets.maxTextBytes, maxSegments: config.budgets.maxSegments },
      });
    } catch { this.reject('invalid-normalized-event'); }
    if (!safe || safe.idempotencyKey !== message.idempotencyKey || fingerprint(safe.author) !== fingerprint(message.author)
      || safe.eventTimeMs !== message.eventTimeMs) this.reject('inconsistent-normalized-event');
    const text = safe.text;
    const eventJson = JSON.stringify(safe.sanitizedEvent);
    const bytes = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(eventJson, 'utf8');
    try {
      assertCapacity(initial, config, bytes);
      let free: number;
      try { free = await this.dependencies.availableDiskBytes(); }
      catch { throw new RuntimeError('disk-health-unobservable'); }
      if (!Number.isSafeInteger(free) || free < 0) throw new RuntimeError('disk-health-unobservable');
      if (free < config.budgets.diskWarningBytes + bytes) throw new RuntimeError('disk-low');
      if (!isCurrent()) throw new RuntimeError('admission-configuration-changed');
      const routes = await this.dependencies.resolveRoutes(config, persona, signal);
      if (!isCurrent()) throw new RuntimeError('admission-configuration-changed');
      const snapshot = createSnapshot(config, persona, routes, observed.revision);
      await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
        if (!isCurrent() || draft.configRevision !== observed.revision) throw new RuntimeError('admission-configuration-changed');
        if (!draft.banks[bankKey]) draft.banks[bankKey] = {
          bankKey, botId: message.botId, personalityId: persona.id,
          provisionMarker: `dsh-onebot-personality:bank:v1:${bankKey}`, state: 'unmapped', revision: 0, generation: 0,
        };
        const source = draft.sources[sourceId];
        if (!source) draft.sources[sourceId] = {
          sourceId, sourceEpoch: 1, botId: message.botId, personalityId: persona.id,
          conversationType: message.conversationType, conversationId: message.conversationId, allowed: true, forgotten: false,
        };
        else if (!source.allowed) {
          if (source.sourceEpoch >= Number.MAX_SAFE_INTEGER) throw new RuntimeError('counter-overflow');
          source.sourceEpoch++;
          source.allowed = true;
          source.forgotten = false;
        }
      });
      const source = this.repository.read().sources[sourceId]!;
      const provenance: Provenance = { complete: true, sourceRefs: [{ sourceId, sourceEpoch: source.sourceEpoch }],
        messageKeys: [message.idempotencyKey], dependencyVersions: [] };
      const retainTaskId = `retain-${fingerprint(message.idempotencyKey)}`;
      const triggered = message.conversationType === 'private' || matchesTrigger(safe, {
        botId: message.botId, name: persona.name, aliases: persona.aliases,
      });
      const replyId = triggered ? randomUUID() : undefined;
      const result = await this.repository.transact<IngressResult>({
        kind: 'content', fence: this.repository.fence, botId: message.botId, personalityId: persona.id,
        provenance, newMessageKeys: [message.idempotencyKey], validateLive: isCurrent,
      }, draft => {
        if (draft.configRevision !== observed.revision) throw new RuntimeError('admission-configuration-changed');
        const existing = draft.messages[message.idempotencyKey];
        if (existing) {
          if (existing.bodyHash !== bodyHash) throw new RuntimeError('idempotency-conflict');
          return { status: 'duplicate', messageKey: existing.key };
        }
        assertCapacity(draft, config, bytes);
        if (draft.nextMessageSequence >= Number.MAX_SAFE_INTEGER) throw new RuntimeError('counter-overflow');
        draft.snapshots[snapshot.id] = snapshot;
        draft.messages[message.idempotencyKey] = {
          key: message.idempotencyKey, botId: message.botId, personalityId: persona.id,
          conversationType: message.conversationType, conversationId: message.conversationId, messageId: message.messageId,
          sourceRef: provenance.sourceRefs[0]!, author: structuredClone(message.author),
          eventTimeMs: message.eventTimeMs, receivedAt, sequence: draft.nextMessageSequence++, snapshotId: snapshot.id,
          bodyHash, text, sanitizedEventJson: eventJson, state: 'active',
        };
        draft.tasks[retainTaskId] = {
          taskId: retainTaskId, kind: 'retain', bankKey, snapshotId: snapshot.id, provenance,
          messageKey: message.idempotencyKey, routeFingerprint: fingerprint(snapshot.routes.retain),
          state: 'pending', stage: 'ingress_committed', retryCount: 0, nextRunAt: receivedAt,
          leaseToken: 0, attemptCount: 0, attemptCalls: 0,
          checkpoint: {}, calls: 0, reservedTokens: 0, failureCodes: [],
        };
        if (replyId) draft.replies[replyId] = {
          replyId, messageKey: message.idempotencyKey, snapshotId: snapshot.id, bankKey,
          configRevision: observed.revision, authEpoch: draft.authEpoch, bindingRevision: draft.bindingRevision,
          provenance, deadlineAt: receivedAt + config.budgets.onlineDeadlineMs, state: 'pending',
        };
        return { status: 'accepted', messageKey: message.idempotencyKey, retainTaskId, ...(replyId ? { replyId } : {}) };
      });
      this.pausedCode = undefined;
      return result;
    } catch (error) {
      this.knownDropped++;
      this.pausedCode = error instanceof RuntimeError ? error.code : 'ingress-failed';
      if (this.pausedCode === 'idempotency-conflict') {
        try {
          const existing = this.repository.read().messages[message.idempotencyKey];
          if (existing) await this.recordConflict(existing.key, existing.bodyHash, bodyHash, receivedAt);
        } catch { this.pausedCode = 'conflict-audit-failed'; }
      }
      throw new RuntimeError(this.pausedCode);
    }
  }
}
