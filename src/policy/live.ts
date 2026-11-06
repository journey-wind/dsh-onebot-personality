import { Buffer } from 'node:buffer';
import { selectPersonality } from '../config.js';
import type { PluginConfig } from '../config.js';
import { fingerprint, freezeDeep } from '../llm/routes.js';
import type { VerifiedPluginDocument } from '../memory/knowledge.js';
import type { OneBotClient, ReadyIdentity } from '../onebot/client.js';
import { RuntimeError, sourceStillAllowed } from '../runtime/configuration.js';
import type { ConfigurationReader } from '../runtime/configuration.js';
import { bankKeyFor } from '../runtime/ingress.js';
import { memoryVersionKey } from '../storage/model.js';
import type { ControlState, MemoryVersion, MessageRecord, Provenance, ReplyRecord } from '../storage/model.js';
import { ControlRepository } from '../storage/repository.js';
import type { ContentGuard } from '../storage/repository.js';
import { authorizeSources, MAX_MEMBERSHIP_PROOF_MS, memoryUsable, unionClosure } from './scope.js';
import type { AuthorizedScope, DependencyVersion, MembershipProof, MemoryMetadata, SourceRecord, SourceRef } from './scope.js';

export interface LivePolicyOptions {
  readConfiguration: ConfigurationReader;
  /** This fixed public method always requests no_cache; no arbitrary OneBot action surface. */
  onebot: Pick<OneBotClient, 'identity' | 'getGroupMemberInfo'>;
  now?: () => number;
}
export interface RecentWindowEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly messageKey: string;
  readonly segmentId?: string;
  readonly provenance: Provenance;
}
interface Capture {
  readonly messageKey: string;
  readonly replyId: string | undefined;
  readonly config: PluginConfig;
  readonly configHash: string;
  readonly revision: string;
  readonly authEpoch: number;
  readonly bindingRevision: number;
  readonly identity: ReadyIdentity;
  readonly deadlineAt: number;
  /** Confirmation/experience only; never used by captureScope or forced submission authorization. */
  readonly allowLateExperience: boolean;
  readonly createdAt: number;
  readonly messageHash: string;
  readonly bankKey: string;
  readonly generations: ReadonlyMap<string, number>;
}
interface CacheEntry { readonly proof: MembershipProof; readonly generation: number }
interface CandidateIndex {
  readonly state: Readonly<ControlState>;
  readonly validUntil: number;
  readonly memories: readonly MemoryVersion[];
  readonly byDoc: ReadonlyMap<string, MemoryVersion>;
  readonly duplicateDocs: boolean;
  /** Metadata only. Checked against volatile deletion blocks on EVERY cache use. */
  readonly provenance?: Provenance;
}
const fail = (): never => { throw new RuntimeError('live-authorization-invalid'); };
const same = (a: unknown, b: unknown): boolean => fingerprint(a) === fingerprint(b);
function configurationHash(config: PluginConfig): string {
  const { token: _secret, ...onebot } = config.onebot;
  return fingerprint({ ...config, onebot }); // Never hash or retain transport credentials.
}

/** Explicit projections: the pure engine deliberately rejects storage/body fields and nesting. */
function projectClosure(value: Provenance): Provenance {
  if (value.complete !== true || !Array.isArray(value.sourceRefs) || !Array.isArray(value.messageKeys)
    || !Array.isArray(value.dependencyVersions)) return fail();
  return { complete: true,
    sourceRefs: value.sourceRefs.map(ref => ({ sourceId: ref.sourceId, sourceEpoch: ref.sourceEpoch })),
    messageKeys: [...value.messageKeys],
    dependencyVersions: value.dependencyVersions.map(dep => ({ memoryId: dep.memoryId, version: dep.version })),
  };
}
function original(message: MessageRecord): Provenance {
  return { complete: true, sourceRefs: [{ sourceId: message.sourceRef.sourceId, sourceEpoch: message.sourceRef.sourceEpoch }],
    messageKeys: [message.key], dependencyVersions: [] };
}
function messageIdentity(message: MessageRecord): string {
  return fingerprint([message.key, message.botId, message.personalityId, message.conversationType,
    message.conversationId, message.snapshotId, message.sourceRef, message.author, message.bodyHash]);
}
function metadata(memory: MemoryVersion): MemoryMetadata {
  return { ...projectClosure(memory.provenance), memoryId: memory.memoryId, version: memory.version,
    botId: memory.botId, personalityId: memory.personalityId, active: memory.active, tombstoned: memory.tombstoned };
}
/** Do not spread/destructure an entire record: doing so would access the body before authorization. */
function metadataCopy(memory: MemoryVersion): MemoryVersion {
  return freezeDeep({ memoryId: memory.memoryId, version: memory.version, botId: memory.botId,
    personalityId: memory.personalityId, bankKey: memory.bankKey, kind: memory.kind,
    provenance: projectClosure(memory.provenance), contentHash: memory.contentHash, writeIntentId: memory.writeIntentId,
    state: memory.state, vectorState: memory.vectorState, active: memory.active, tombstoned: memory.tombstoned,
    stale: memory.stale, createdAt: memory.createdAt, entities: [...memory.entities],
    ...(memory.docId === undefined ? {} : { docId: memory.docId }),
    ...(memory.eventStart === undefined ? {} : { eventStart: memory.eventStart }),
    ...(memory.eventEnd === undefined ? {} : { eventEnd: memory.eventEnd }),
    ...(memory.supersedes === undefined ? {} : { supersedes: { ...memory.supersedes } }),
    ...(memory.templateId === undefined ? {} : { templateId: memory.templateId }),
    ...(memory.coveredRevision === undefined ? {} : { coveredRevision: memory.coveredRevision }),
  });
}
function contains(container: Provenance, input: Provenance): boolean {
  return input.complete === true
    && input.sourceRefs.every(ref => container.sourceRefs.some(other => other.sourceId === ref.sourceId && other.sourceEpoch === ref.sourceEpoch))
    && input.messageKeys.every(key => container.messageKeys.includes(key))
    && input.dependencyVersions.every(dep => container.dependencyVersions.some(other => other.memoryId === dep.memoryId && other.version === dep.version));
}

/** Host-only live policy. A captured scope is an expiring observation, never a bearer capability.
 * All checks after asynchronous member queries and all validateLive checks are synchronous.
 * The repository's shared commitAndSubmit barrier remains the final submission authority. */
export class LivePolicy {
  private readonly now: () => number;
  private readonly scopes = new WeakMap<AuthorizedScope, Capture>();
  private readonly candidateIndices = new WeakMap<AuthorizedScope, CandidateIndex>();
  private readonly members = new Map<string, CacheEntry>();
  private readonly generations = new Map<string, number>();
  private cacheConfiguration: PluginConfig | undefined;
  private cacheRevision = '';
  private cacheIdentity = '';

  constructor(private readonly repository: ControlRepository, private readonly options: LivePolicyOptions) {
    this.now = options.now ?? Date.now;
  }

  /** A notice is an invalidation signal only, never proof of membership. Also fences in-flight queries.
   * User-specific notices conservatively invalidate ALL captured guards for that group. */
  invalidateMembers(groupId: string, userId?: string): void {
    if (!/^[1-9][0-9]*$/u.test(groupId) || (userId !== undefined && !/^[1-9][0-9]*$/u.test(userId))) return;
    this.generations.set(groupId, (this.generations.get(groupId) ?? 0) + 1);
    for (const [key, entry] of this.members) {
      if (entry.proof.groupId === groupId && (userId === undefined || entry.proof.userId === userId)) this.members.delete(key);
    }
  }

  private sources(state: Readonly<ControlState>, config: PluginConfig): SourceRecord[] {
    return Object.values(state.sources).map(source => ({ sourceId: source.sourceId, sourceEpoch: source.sourceEpoch,
      botId: source.botId, personalityId: source.personalityId, conversationType: source.conversationType,
      conversationId: source.conversationId,
      allowed: source.allowed && sourceStillAllowed(source, config),
      forgotten: source.forgotten || (state.forgottenSources[source.sourceId] ?? 0) >= source.sourceEpoch }));
  }

  private active(memory: MemoryVersion, state: Readonly<ControlState>, bankKey: string): boolean {
    const bank = state.banks[bankKey];
    return !!bank && bank.state === 'ready' && !!bank.baseId && memory.bankKey === bankKey
      && memory.botId === bank.botId && memory.personalityId === bank.personalityId
      && memory.active && memory.state === 'active' && !memory.tombstoned && !memory.stale
      && state.activeMemory[memory.memoryId] === memoryVersionKey(memory.memoryId, memory.version);
  }
  private catalog(state: Readonly<ControlState>, bankKey: string): DependencyVersion[] {
    const versions: DependencyVersion[] = [];
    for (const [id, key] of Object.entries(state.activeMemory)) {
      const memory = state.memories[key];
      if (memory && memory.memoryId === id && this.active(memory, state, bankKey)) versions.push({ memoryId: id, version: memory.version });
    }
    return versions;
  }

  /** Close over persisted inputs and each dependency's full metadata, not final model citations. */
  private closure(state: Readonly<ControlState>, bankKey: string, inputs: readonly Provenance[]): Provenance {
    const sourceRefs: SourceRef[] = [];
    const messageKeys: string[] = [];
    const dependencyVersions: DependencyVersion[] = [];
    const append = (input: Provenance): void => {
      const projected = projectClosure(input);
      sourceRefs.push(...projected.sourceRefs); messageKeys.push(...projected.messageKeys);
      dependencyVersions.push(...projected.dependencyVersions);
    };
    inputs.forEach(append);
    const expanded = new Set<string>();
    for (let index = 0; index < dependencyVersions.length; index++) {
      const dep = dependencyVersions[index]!;
      const key = memoryVersionKey(dep.memoryId, dep.version);
      if (expanded.has(key)) continue;
      const memory = state.memories[key];
      if (!memory || !this.active(memory, state, bankKey)
        || memory.provenance.dependencyVersions.some(other => other.memoryId === memory.memoryId)) return fail();
      expanded.add(key);
      append(memory.provenance);
    }
    // Message provenance is host-derived even when the caller supplied only its key.
    for (const key of new Set(messageKeys)) {
      const message = state.messages[key];
      if (!message) return fail();
      sourceRefs.push({ sourceId: message.sourceRef.sourceId, sourceEpoch: message.sourceRef.sourceEpoch });
    }
    const merged = unionClosure([{ complete: true, sourceRefs, messageKeys, dependencyVersions }], this.catalog(state, bankKey));
    return projectClosure(merged as Provenance);
  }

  private capture(messageKey: string, supplied?: ReplyRecord, permitLateExperience = false): Capture {
    const observed = this.options.readConfiguration();
    const state = this.repository.read();
    const message = state.messages[messageKey];
    const identity = this.options.onebot.identity;
    const now = this.now();
    if (!message || !identity || !Number.isSafeInteger(now) || now < 0 || !observed.revision
      || state.configRevision !== observed.revision || !observed.config.onebot.enabled
      || identity.selfId !== observed.config.onebot.expectedSelfId || identity.selfId !== message.botId
      || !identity.connectionEpoch || message.state !== 'active') return fail();
    const config = observed.config;
    if (!(message.conversationType === 'group' ? config.allow.groupIds : config.allow.privateUserIds).includes(message.conversationId)) return fail();
    const persona = selectPersonality(config, message.conversationType, message.conversationId);
    const snapshot = state.snapshots[message.snapshotId];
    const bankKey = bankKeyFor(message.botId, persona.id);
    const bank = state.banks[bankKey];
    if (!snapshot || snapshot.configRevision !== observed.revision || snapshot.personality.id !== message.personalityId
      || persona.id !== message.personalityId || !same(snapshot.personality, persona)
      || !same(snapshot.budgets, config.budgets) || !same(snapshot.memory, config.memory)
      || !bank || bank.botId !== message.botId || bank.personalityId !== persona.id
      || state.pausedBanks[bankKey] || ['blocked', 'suspended', 'retiring'].includes(bank.state)
      || (persona.visibility === 'fully-shared' && !config.security.confirmSharedPrivateToGroups)
      || (message.author.kind === 'anonymous' && message.conversationType !== 'group')
      || (message.conversationType === 'private' && (message.author.kind !== 'qq' || message.author.qqId !== message.conversationId))) return fail();
    const reply = supplied ? state.replies[supplied.replyId]
      : Object.values(state.replies).find(item => item.messageKey === messageKey && item.snapshotId === message.snapshotId);
    if (supplied && (!reply || supplied.messageKey !== messageKey || supplied.snapshotId !== reply.snapshotId
      || supplied.bankKey !== reply.bankKey || supplied.configRevision !== reply.configRevision
      || supplied.authEpoch !== reply.authEpoch || supplied.bindingRevision !== reply.bindingRevision
      || supplied.deadlineAt !== reply.deadlineAt || ['cancelled', 'failed'].includes(supplied.state))) return fail();
    if (reply && (reply.messageKey !== messageKey || reply.snapshotId !== message.snapshotId || reply.bankKey !== bankKey
      || reply.configRevision !== observed.revision || reply.authEpoch !== state.authEpoch || reply.bindingRevision !== state.bindingRevision
      || ['cancelled', 'failed'].includes(reply.state) || reply.cancellationCode !== undefined)) return fail();
    const deadlineAt = reply?.deadlineAt ?? message.receivedAt + snapshot.budgets.onlineDeadlineMs;
    const allowLateExperience = permitLateExperience && !!reply && ['sending', 'unknown', 'partial', 'completed'].includes(reply.state);
    if ((!allowLateExperience && now >= deadlineAt) || now < message.receivedAt) return fail();
    // Revision/reference/connection changes never carry a positive cache into the new context.
    const identityKey = JSON.stringify([identity.selfId, identity.connectionEpoch]);
    if (this.cacheConfiguration !== config || this.cacheRevision !== observed.revision || this.cacheIdentity !== identityKey) {
      this.members.clear(); this.cacheConfiguration = config; this.cacheRevision = observed.revision; this.cacheIdentity = identityKey;
    }
    return { messageKey, replyId: reply?.replyId, config, configHash: configurationHash(config), revision: observed.revision,
      authEpoch: state.authEpoch, bindingRevision: state.bindingRevision, identity: { ...identity }, deadlineAt, allowLateExperience,
      createdAt: now, messageHash: messageIdentity(message), bankKey, generations: new Map() };
  }

  private check(capture: Capture): Readonly<ControlState> {
    const current = this.options.readConfiguration();
    const identity = this.options.onebot.identity;
    const now = this.now();
    const state = this.repository.read(); // Includes synchronous owner/storage fencing.
    const message = state.messages[capture.messageKey];
    if (current.config !== capture.config || current.revision !== capture.revision || configurationHash(current.config) !== capture.configHash
      || state.configRevision !== capture.revision || state.authEpoch !== capture.authEpoch || state.bindingRevision !== capture.bindingRevision
      || !identity || identity.selfId !== capture.identity.selfId || identity.connectionEpoch !== capture.identity.connectionEpoch
      || !Number.isSafeInteger(now) || now < capture.createdAt || (!capture.allowLateExperience && now >= capture.deadlineAt)
      || !message || message.state !== 'active' || messageIdentity(message) !== capture.messageHash) return fail();
    if (capture.replyId) {
      const reply = state.replies[capture.replyId];
      if (!reply || reply.messageKey !== capture.messageKey || reply.bankKey !== capture.bankKey || reply.snapshotId !== message.snapshotId
        || reply.configRevision !== capture.revision || reply.authEpoch !== capture.authEpoch || reply.bindingRevision !== capture.bindingRevision
        || reply.deadlineAt !== capture.deadlineAt || reply.cancellationCode !== undefined || ['cancelled', 'failed'].includes(reply.state)
        || (capture.allowLateExperience && !['sending', 'unknown', 'partial', 'completed'].includes(reply.state))) return fail();
    }
    for (const [groupId, generation] of capture.generations) if ((this.generations.get(groupId) ?? 0) !== generation) return fail();
    return state;
  }

  private async scope(capture: Capture, neededSourceRefs?: readonly SourceRef[], forceMembers = false): Promise<AuthorizedScope> {
    const state = this.check(capture);
    const message = state.messages[capture.messageKey]!;
    const persona = selectPersonality(capture.config, message.conversationType, message.conversationId);
    const requesterQQ = message.author.kind === 'qq' ? message.author.qqId : null;
    const sources = this.sources(state, capture.config);
    const target = { botId: message.botId, personalityId: message.personalityId,
      conversationType: message.conversationType, conversationId: message.conversationId, requesterQQ,
      visibility: persona.visibility, configRevision: capture.revision, authEpoch: capture.authEpoch,
      bindingRevision: capture.bindingRevision, connectionEpoch: capture.identity.connectionEpoch };
    const proofs: MembershipProof[] = [];
    const observedGenerations = new Map<string, number>();
    if (target.visibility === 'source-restricted' && target.conversationType === 'private' && requesterQQ !== null) {
      const groups = [...new Set(sources.filter(source => source.allowed && !source.forgotten && source.botId === target.botId
        && source.personalityId === target.personalityId && source.conversationType === 'group'
        && (neededSourceRefs === undefined || neededSourceRefs.some(ref => ref.sourceId === source.sourceId && ref.sourceEpoch === source.sourceEpoch)))
        .map(source => source.conversationId))].sort();
      let queries = 0;
      for (const groupId of groups) {
        this.check(capture);
        const key = JSON.stringify([target.botId, target.connectionEpoch, groupId, requesterQQ]);
        const cached = this.members.get(key);
        const at = this.now();
        if (!forceMembers && capture.config.security.membershipCacheMs > 0
          && cached && cached.generation === (this.generations.get(groupId) ?? 0)
          && cached.proof.checkedAt <= at && at < cached.proof.expiresAt) {
          proofs.push(cached.proof); observedGenerations.set(groupId, cached.generation); continue;
        }
        // A forced refresh must not reuse the previous proof even if the query fails/budget is exhausted.
        if (forceMembers) this.invalidateMembers(groupId, requesterQQ);
        else this.members.delete(key);
        if (queries >= capture.config.budgets.membershipMaxQueries) continue;
        queries++;
        const generation = this.generations.get(groupId) ?? 0;
        const startedAt = this.now();
        try {
          const member = await this.options.onebot.getGroupMemberInfo(groupId, requesterQQ);
          this.check(capture);
          const checkedAt = member.checkedAt;
          const finishedAt = this.now();
          // Zero disables cross-call cache reuse, not the lifetime of this fresh observation.
          const cacheMs = capture.config.security.membershipCacheMs;
          const ttl = cacheMs === 0 ? MAX_MEMBERSHIP_PROOF_MS : Math.min(MAX_MEMBERSHIP_PROOF_MS, cacheMs);
          if (member.selfId !== target.botId || member.connectionEpoch !== target.connectionEpoch || member.groupId !== groupId
            || member.userId !== requesterQQ || !Number.isSafeInteger(checkedAt) || checkedAt < startedAt || checkedAt > finishedAt
            || finishedAt >= checkedAt + ttl || (this.generations.get(groupId) ?? 0) !== generation) continue;
          const proof: MembershipProof = Object.freeze({ botId: target.botId, connectionEpoch: target.connectionEpoch,
            groupId, userId: requesterQQ, checkedAt, expiresAt: checkedAt + ttl });
          proofs.push(proof); observedGenerations.set(groupId, generation);
          if (capture.config.security.membershipCacheMs > 0) this.members.set(key, { proof, generation });
        } catch {
          // Fail closed for this group; final context validation below still rejects global changes.
          this.members.delete(key);
          if ((this.generations.get(groupId) ?? 0) === generation) this.invalidateMembers(groupId, requesterQQ);
        }
      }
    }
    const completed: Capture = { ...capture, generations: observedGenerations };
    const latest = this.check(completed);
    const result = authorizeSources(target, this.sources(latest, capture.config), proofs, this.now());
    this.scopes.set(result, completed);
    this.assertClosure(original(latest.messages[capture.messageKey]!), result, latest, completed);
    return result;
  }

  async captureScope(messageKey: string, neededSourceRefs?: readonly SourceRef[]): Promise<AuthorizedScope> {
    return this.scope(this.capture(messageKey), neededSourceRefs);
  }

  private getCapture(scope: AuthorizedScope): Capture {
    const capture = this.scopes.get(scope);
    if (!capture) return fail();
    this.check(capture);
    return capture;
  }
  private usable(provenance: Provenance, scope: AuthorizedScope, state: Readonly<ControlState>, capture: Capture,
    memory?: MemoryVersion): boolean {
    const sources = this.sources(state, capture.config);
    // memoryUsable validates/parses its supplied catalog. Passing the entire bank for
    // every record made candidate formation quadratic even when there were NO dependencies.
    // A closure needs only its own exact dependencies; active() still checks each one live.
    const options = { currentDependencyVersions: provenance.dependencyVersions.filter(dep => {
      const current = state.memories[memoryVersionKey(dep.memoryId, dep.version)];
      return !!current && this.active(current, state, capture.bankKey);
    }),
      isMessageForgotten: (key: string): boolean => {
        const message = state.messages[key];
        return !!state.forgottenMessages[key] || !message || message.state !== 'active' || message.botId !== scope.botId
          || message.personalityId !== scope.personalityId || !provenance.sourceRefs.some(ref => ref.sourceId === message.sourceRef.sourceId
            && ref.sourceEpoch === message.sourceRef.sourceEpoch);
      } };
    const value: MemoryMetadata = memory ? metadata(memory) : { ...projectClosure(provenance), memoryId: 'live-policy-input-closure',
      version: 1, botId: scope.botId, personalityId: scope.personalityId, active: true, tombstoned: false };
    if (!memoryUsable(value, scope, sources, this.now(), options)) return false;
    for (const dep of provenance.dependencyVersions) {
      const dependency = state.memories[memoryVersionKey(dep.memoryId, dep.version)];
      if (!dependency || !this.active(dependency, state, capture.bankKey) || !contains(provenance, dependency.provenance)
        || !memoryUsable(metadata(dependency), scope, sources, this.now(), options)) return false;
    }
    return true;
  }
  private assertClosure(provenance: Provenance, scope: AuthorizedScope, state: Readonly<ControlState>, capture: Capture): void {
    if (!this.usable(provenance, scope, state, capture)) return fail();
    // Includes volatile deletion blocks, which are intentionally not exposed in repository.read().
    this.repository.assertContentAllowed({ kind: 'content', fence: this.repository.fence, botId: scope.botId,
      personalityId: scope.personalityId, provenance });
  }

  /** Call before every stage with its accumulated ALL-input provenance; force before EACH send segment.
   * false on an already submitted reply also permits late delivery-confirmation/experience commits;
   * those guards MUST NOT be used for new model calls or submission. true always enforces deadline. */
  async authorizeReply(reply: ReplyRecord, forceMembers = false): Promise<ContentGuard> {
    const capture = this.capture(reply.messageKey, reply, !forceMembers);
    const state = this.check(capture);
    const persisted = state.replies[reply.replyId]!;
    const replyId = persisted.replyId;
    const provenance = freezeDeep(this.closure(state, capture.bankKey,
      [original(state.messages[reply.messageKey]!), persisted.provenance, reply.provenance]));
    const scope = await this.scope(capture, provenance.sourceRefs, forceMembers);
    const completed = this.getCapture(scope);
    const validateLive = (): boolean => {
      try {
        const current = this.check(completed);
        const liveReply = current.replies[replyId];
        if (!liveReply || !contains(provenance, liveReply.provenance)) return false;
        this.assertClosure(provenance, scope, current, completed);
        return true;
      } catch { return false; }
    };
    if (!validateLive()) return fail();
    return Object.freeze({ kind: 'content', fence: this.repository.fence, botId: scope.botId,
      personalityId: scope.personalityId, provenance, validateLive });
  }

  /** A cache of immutable, already-authorized METADATA, never bodies or lexical features.
   * Repository state identity fences every mapping/source/version; scope identity binds the
   * snapshot, requester and proof generations. Config/owner/deadline and original-input guards
   * run even on a hit. Time and volatile pending deletions are NOT covered by state identity. */
  private candidateIndex(scope: AuthorizedScope): CandidateIndex {
    const capture = this.getCapture(scope);
    const state = this.check(capture);
    this.assertClosure(original(state.messages[capture.messageKey]!), scope, state, capture);
    const now = this.now();
    const cached = this.candidateIndices.get(scope);
    if (cached?.state === state && now < cached.validUntil) {
      try {
        if (cached.provenance) this.assertAllowed(cached.provenance, scope);
        return cached;
      } catch { /* A pending deletion can precede the next immutable repository state. */ }
    }
    const bank = state.banks[capture.bankKey];
    const result: MemoryVersion[] = [];
    if (bank?.state === 'ready' && bank.baseId) for (const key of Object.values(state.activeMemory)) {
      const memory = state.memories[key];
      if (!memory || !memory.docId || !this.active(memory, state, capture.bankKey)
        || !this.usable(memory.provenance, scope, state, capture, memory)) continue;
      try { this.assertAllowed(memory.provenance, scope); }
      catch { continue; }
      // Entities/time are copied only AFTER this exact record's complete authorization.
      result.push(metadataCopy(memory));
    }
    const memories = Object.freeze(result.sort((a, b) => a.memoryId.localeCompare(b.memoryId) || a.version - b.version));
    const byDoc = new Map<string, MemoryVersion>();
    let duplicateDocs = false;
    for (const memory of memories) {
      if (byDoc.has(memory.docId!)) duplicateDocs = true;
      byDoc.set(memory.docId!, memory);
    }
    const provenance = memories.length ? freezeDeep(projectClosure(unionClosure(memories.map(memory => memory.provenance),
      this.catalog(state, capture.bankKey)) as Provenance)) : undefined;
    const index: CandidateIndex = { state, memories, byDoc, duplicateDocs,
      validUntil: Math.min(Infinity, ...scope.membershipProofs.filter(proof => proof.expiresAt > now).map(proof => proof.expiresAt)),
      ...(provenance === undefined ? {} : { provenance }) };
    if (provenance) this.assertAllowed(provenance, scope);
    this.check(capture);
    this.candidateIndices.set(scope, index);
    return index;
  }

  private assertAllowed(provenance: Provenance, scope: AuthorizedScope): void {
    this.repository.assertContentAllowed({ kind: 'content', fence: this.repository.fence, botId: scope.botId,
      personalityId: scope.personalityId, provenance });
  }

  /** Metadata-only candidate formation. Neither local text nor knowledge bodies are read here. */
  candidates(scope: AuthorizedScope): readonly MemoryVersion[] {
    if (scope.allowedSources.length === 0) return [];
    return this.candidateIndex(scope).memories;
  }

  /** KnowledgeAdapter callback, before AND after reads. Unknown, duplicate or old doc mappings deny.
   * Empty input performs no storage/service I/O. An empty scope never grants a nonempty set. */
  authorizeDocuments(scope: AuthorizedScope, docIds: readonly string[], documents?: readonly VerifiedPluginDocument[]): void {
    if (docIds.length === 0) {
      if (documents && documents.length !== 0) return fail();
      return;
    }
    if (scope.allowedSources.length === 0) return fail();
    const capture = this.getCapture(scope);
    const state = this.check(capture);
    const bank = state.banks[capture.bankKey];
    if (!bank || bank.state !== 'ready' || !bank.baseId || new Set(docIds).size !== docIds.length) return fail();
    const byDoc = new Map<string, MemoryVersion>();
    for (const memory of this.candidates(scope)) {
      if (!memory.docId) continue;
      if (byDoc.has(memory.docId)) return fail();
      byDoc.set(memory.docId, memory);
    }
    const ids = new Set(docIds);
    for (const docId of docIds) if (!byDoc.has(docId)) return fail();
    if (documents !== undefined) {
      if (documents.length !== docIds.length || new Set(documents.map(doc => doc.docId)).size !== docIds.length) return fail();
      for (const doc of documents) {
        const memory = byDoc.get(doc.docId);
        if (!ids.has(doc.docId) || !memory || doc.baseId !== bank.baseId || doc.header.encoding !== 1
          || doc.header.memoryId !== memory.memoryId || doc.header.version !== memory.version
          || doc.header.writeIntentId !== memory.writeIntentId || doc.header.hash !== memory.contentHash
          || doc.hash !== memory.contentHash
          || !same(unionClosure([projectClosure(doc.header.provenance)], this.catalog(state, capture.bankKey)),
            unionClosure([projectClosure(memory.provenance)], this.catalog(state, capture.bankKey)))) return fail();
      }
    }
    this.check(capture);
  }

  /** Final synchronous document authority. Uses only captured, still-live membership proofs and
   * metadata; never refreshes membership or touches a private body. Pending deletion blocks count. */
  validateDocumentsLive(scope: AuthorizedScope, docIds: readonly string[], documents?: readonly VerifiedPluginDocument[]): boolean {
    try {
      if (docIds.length === 0) return documents === undefined || documents.length === 0;
      const capture = this.getCapture(scope);
      const state = this.check(capture);
      this.assertClosure(original(state.messages[capture.messageKey]!), scope, state, capture);
      this.authorizeDocuments(scope, docIds, documents);
      return true;
    } catch { return false; }
  }

  /** Whole authorized records only, no truncation, no retain waits. Current input stays separate. */
  recentWindow(messageKey: string, scope: AuthorizedScope): readonly RecentWindowEntry[] {
    if (scope.allowedSources.length === 0) return [];
    const capture = this.getCapture(scope);
    if (capture.messageKey !== messageKey) return fail();
    const state = this.check(capture);
    const current = state.messages[messageKey]!;
    const maxCount = Math.min(20, capture.config.budgets.recentMessages);
    const maxBytes = capture.config.budgets.recentMaxBytes;
    if (!maxCount || !maxBytes) return [];
    const eligible = (message: MessageRecord): boolean => message.key !== messageKey && message.sequence < current.sequence
      && message.state === 'active' && message.botId === scope.botId && message.personalityId === scope.personalityId
      && message.conversationType === scope.conversationType && message.conversationId === scope.conversationId
      && state.snapshots[message.snapshotId]?.personality.id === scope.personalityId;
    const history: { sequence: number; offset: number; message: MessageRecord; segmentId?: string; provenance: Provenance }[] = [];
    for (const message of Object.values(state.messages)) {
      if (eligible(message)) history.push({ sequence: message.sequence, offset: -1, message, provenance: original(message) });
    }
    for (const segment of Object.values(state.segments)) {
      if (segment.state !== 'succeeded') continue;
      const reply = state.replies[segment.replyId];
      const message = reply && state.messages[reply.messageKey];
      if (!reply || !message || !eligible(message) || reply.bankKey !== capture.bankKey || reply.snapshotId !== message.snapshotId) continue;
      try {
        const provenance = this.closure(state, capture.bankKey, [original(message), reply.provenance, segment.provenance]);
        history.push({ sequence: message.sequence, offset: segment.index, message, segmentId: segment.segmentId, provenance });
      } catch { /* Revoked, forgotten or unknown dependency histories never become public. */ }
    }
    history.sort((a, b) => b.sequence - a.sequence || b.offset - a.offset);
    const result: RecentWindowEntry[] = [];
    let bytes = 0;
    for (const item of history) {
      if (result.length >= maxCount) break;
      try { this.assertClosure(item.provenance, scope, state, capture); }
      catch { continue; }
      // Body access happens only after source ACL, tombstones and inherited dependencies pass.
      const text = item.segmentId === undefined ? item.message.text : state.segments[item.segmentId]?.text;
      if (text === undefined) continue;
      const size = Buffer.byteLength(text, 'utf8');
      if (bytes + size > maxBytes) continue;
      bytes += size;
      result.push(freezeDeep<RecentWindowEntry>({ role: item.segmentId === undefined ? 'user' : 'assistant', text, messageKey: item.message.key,
        ...(item.segmentId === undefined ? {} : { segmentId: item.segmentId }), provenance: projectClosure(item.provenance) }));
    }
    this.check(capture);
    return Object.freeze(result.reverse());
  }
}
