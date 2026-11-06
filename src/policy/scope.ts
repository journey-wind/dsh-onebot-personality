import { createHash } from 'node:crypto';

/** Trusted control-plane metadata only. Never populate these fields from model ACLs. */
export interface SourceRef {
  readonly sourceId: string;
  readonly sourceEpoch: number;
}

export interface SourceRecord extends SourceRef {
  readonly botId: string;
  readonly personalityId: string;
  readonly conversationType: 'group' | 'private';
  readonly conversationId: string;
  readonly allowed: boolean;
  readonly forgotten: boolean;
}

/** A successful fixed member query, bound to a verified bot connection. Times are epoch ms. */
export interface MembershipProof {
  readonly botId: string;
  readonly groupId: string;
  readonly userId: string;
  readonly connectionEpoch: string;
  readonly checkedAt: number;
  readonly expiresAt: number;
}

export interface TargetScope {
  readonly botId: string;
  readonly personalityId: string;
  readonly conversationType: 'group' | 'private';
  readonly conversationId: string;
  /** Null only for an anonymous group sender; never fabricate QQ from a gateway placeholder. */
  readonly requesterQQ: string | null;
  readonly visibility: 'source-restricted' | 'fully-shared';
  readonly configRevision: string;
  readonly authEpoch: number;
  readonly bindingRevision: number;
  readonly connectionEpoch: string;
}

export interface AuthorizedScope extends TargetScope {
  readonly allowedSources: readonly SourceRef[];
  readonly membershipProofs: readonly MembershipProof[];
  readonly createdAt: number;
}

export interface DependencyVersion {
  readonly memoryId: string;
  readonly version: number;
}

/** Complete host-computed transitive closure, not the model's selected citations. */
export interface ProvenanceClosure {
  readonly sourceRefs: readonly SourceRef[];
  readonly messageKeys: readonly string[];
  readonly dependencyVersions: readonly DependencyVersion[];
  readonly complete: true;
}

export interface ProvenanceInput extends ProvenanceClosure {
  /** Include an input memory's own version as well as its transitive dependencies. */
  readonly inputVersion?: DependencyVersion;
}

export interface MemoryMetadata extends ProvenanceClosure {
  readonly memoryId: string;
  readonly version: number;
  readonly botId: string;
  readonly personalityId: string;
  readonly active: boolean;
  readonly tombstoned: boolean;
}

export interface MemoryUsabilityOptions {
  /** Exact current active versions from the trusted index; absent means none are known. */
  readonly currentDependencyVersions?: readonly DependencyVersion[];
  /** Current message tombstones, including keys found by author-based forgetting. */
  readonly tombstonedMessageKeys?: readonly string[];
  /** Alternative/additional current forgetting lookup. Errors or non-booleans deny use. */
  readonly isMessageForgotten?: (messageKey: string) => boolean;
}

export const MAX_MEMBERSHIP_PROOF_MS = 30_000;

export class PolicyValidationError extends Error {
  constructor() {
    // Do not echo malformed metadata, which may accidentally contain private content.
    super('Invalid or incomplete policy metadata');
    this.name = 'PolicyValidationError';
  }
}

const targetKeys = ['botId', 'personalityId', 'conversationType', 'conversationId', 'requesterQQ',
  'visibility', 'configRevision', 'authEpoch', 'bindingRevision', 'connectionEpoch'] as const;
const sourceKeys = ['sourceId', 'sourceEpoch', 'botId', 'personalityId', 'conversationType',
  'conversationId', 'allowed', 'forgotten'] as const;
const proofKeys = ['botId', 'groupId', 'userId', 'connectionEpoch', 'checkedAt', 'expiresAt'] as const;
const closureKeys = ['sourceRefs', 'messageKeys', 'dependencyVersions', 'complete'] as const;

function reject(): never { throw new PolicyValidationError(); }

/** Reject unknown fields, symbols, accessors, class instances and inherited metadata. */
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return reject();
  const keys = Object.keys(descriptors);
  if (required.some(key => !Object.hasOwn(descriptors, key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key))) return reject();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return reject();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return reject();
  return value;
}

function qq(value: unknown): string {
  const result = text(value);
  if (!/^[1-9][0-9]*$/u.test(result)) return reject();
  return result;
}

function integer(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) return reject();
  return value;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return reject();
  // Only ordinary dense arrays: no hidden extra metadata or accessor elements.
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) return reject();
  for (let index = 0; index < value.length; index++) {
    const item = descriptors[String(index)];
    if (!item || !Object.hasOwn(item, 'value') || !item.enumerable) return reject();
  }
  return value as readonly unknown[];
}

function sourceRef(value: unknown): SourceRef {
  const v = record(value, ['sourceId', 'sourceEpoch']);
  return Object.freeze({ sourceId: text(v.sourceId), sourceEpoch: integer(v.sourceEpoch, true) });
}

function dependency(value: unknown): DependencyVersion {
  const v = record(value, ['memoryId', 'version']);
  return Object.freeze({ memoryId: text(v.memoryId), version: integer(v.version, true) });
}

function conversation(value: unknown): 'group' | 'private' {
  if (value !== 'group' && value !== 'private') return reject();
  return value;
}

function source(value: unknown): SourceRecord {
  const v = record(value, sourceKeys);
  if (typeof v.allowed !== 'boolean' || typeof v.forgotten !== 'boolean') return reject();
  return Object.freeze({ sourceId: text(v.sourceId), sourceEpoch: integer(v.sourceEpoch, true),
    botId: qq(v.botId), personalityId: text(v.personalityId), conversationType: conversation(v.conversationType),
    conversationId: qq(v.conversationId), allowed: v.allowed, forgotten: v.forgotten });
}

function target(value: unknown, authorized = false): TargetScope {
  const v = record(value, authorized ? [...targetKeys, 'allowedSources', 'membershipProofs', 'createdAt'] : targetKeys);
  if (v.visibility !== 'source-restricted' && v.visibility !== 'fully-shared') return reject();
  const result: TargetScope = { botId: qq(v.botId), personalityId: text(v.personalityId),
    conversationType: conversation(v.conversationType), conversationId: qq(v.conversationId),
    requesterQQ: v.requesterQQ === null ? null : qq(v.requesterQQ),
    visibility: v.visibility, configRevision: text(v.configRevision), authEpoch: integer(v.authEpoch),
    bindingRevision: integer(v.bindingRevision), connectionEpoch: text(v.connectionEpoch) };
  if (result.conversationType === 'private' && result.requesterQQ !== result.conversationId) return reject();
  return Object.freeze(result);
}

function proof(value: unknown): MembershipProof {
  const v = record(value, proofKeys);
  const checkedAt = integer(v.checkedAt);
  const expiresAt = integer(v.expiresAt);
  if (expiresAt <= checkedAt || expiresAt - checkedAt > MAX_MEMBERSHIP_PROOF_MS) return reject();
  return Object.freeze({ botId: qq(v.botId), groupId: qq(v.groupId), userId: qq(v.userId),
    connectionEpoch: text(v.connectionEpoch), checkedAt, expiresAt });
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function references(values: unknown): readonly SourceRef[] {
  const refs = new Map<string, SourceRef>();
  for (const value of list(values)) {
    const ref = sourceRef(value);
    const prior = refs.get(ref.sourceId);
    if (prior && prior.sourceEpoch !== ref.sourceEpoch) return reject();
    refs.set(ref.sourceId, ref);
  }
  return Object.freeze([...refs.values()].sort((a, b) => compare(a.sourceId, b.sourceId)));
}

function versions(values: unknown): readonly DependencyVersion[] {
  const refs = new Map<string, DependencyVersion>();
  for (const value of list(values)) {
    const ref = dependency(value);
    const prior = refs.get(ref.memoryId);
    if (prior && prior.version !== ref.version) return reject();
    refs.set(ref.memoryId, ref);
  }
  return Object.freeze([...refs.values()].sort((a, b) => compare(a.memoryId, b.memoryId)));
}

function messages(values: unknown): readonly string[] {
  return Object.freeze([...new Set(list(values).map(text))].sort(compare));
}

function sourceIndex(values: unknown): ReadonlyMap<string, SourceRecord> {
  const result = new Map<string, SourceRecord>();
  const locations = new Set<string>();
  for (const value of list(values)) {
    const item = source(value);
    const location = JSON.stringify([item.botId, item.personalityId, item.conversationType, item.conversationId]);
    // A current snapshot must contain one authoritative record per ID and location.
    if (result.has(item.sourceId) || locations.has(location)) return reject();
    result.set(item.sourceId, item);
    locations.add(location);
  }
  return result;
}

function proofMatches(p: MembershipProof, t: TargetScope, groupId: string, now: number): boolean {
  return t.requesterQQ !== null && p.botId === t.botId && p.userId === t.requesterQQ && p.groupId === groupId &&
    p.connectionEpoch === t.connectionEpoch && p.checkedAt <= now && now < p.expiresAt &&
    now - p.checkedAt < MAX_MEMBERSHIP_PROOF_MS;
}

function sourceAllowed(s: SourceRecord, t: TargetScope, proofs: readonly MembershipProof[], now: number): boolean {
  if (!s.allowed || s.forgotten || s.botId !== t.botId || s.personalityId !== t.personalityId) return false;
  if (t.visibility === 'fully-shared') return true;
  if (t.conversationType === 'group') return s.conversationType === 'group' && s.conversationId === t.conversationId;
  return s.conversationType === 'private' ? s.conversationId === t.requesterQQ :
    proofs.some(p => proofMatches(p, t, s.conversationId, now));
}

/**
 * Pure authorization over a current trusted snapshot. Invalid target/source metadata throws;
 * malformed/failed member proofs grant nothing. Empty authorization is a valid deny-all scope.
 * Target allowlists, shared-mode confirmation and current revisions belong to the caller.
 */
export function authorizeSources(targetScope: TargetScope, sources: readonly SourceRecord[],
  membershipProofs: readonly MembershipProof[], now: number): AuthorizedScope {
  integer(now);
  const t = target(targetScope);
  const current = sourceIndex(sources);
  const candidates: MembershipProof[] = [];
  for (const value of list(membershipProofs)) {
    try {
      const p = proof(value);
      if (proofMatches(p, t, p.groupId, now)) candidates.push(p);
    } catch { /* Unknown/malformed proof is not evidence of membership. */ }
  }
  const allowed = [...current.values()].filter(s => sourceAllowed(s, t, candidates, now));
  const selected = new Map<string, MembershipProof>();
  if (t.visibility === 'source-restricted' && t.conversationType === 'private') {
    for (const s of allowed) {
      if (s.conversationType !== 'group') continue;
      const p = candidates.filter(item => item.groupId === s.conversationId)
        .sort((a, b) => b.checkedAt - a.checkedAt || b.expiresAt - a.expiresAt)[0];
      if (p) selected.set(s.conversationId, p);
    }
  }
  return Object.freeze({ ...t, allowedSources: references(allowed.map(s => ({ sourceId: s.sourceId, sourceEpoch: s.sourceEpoch }))),
    membershipProofs: Object.freeze([...selected.values()].sort((a, b) => compare(a.groupId, b.groupId))), createdAt: now });
}

function authorized(value: unknown): AuthorizedScope {
  const t = target(value, true);
  const v = value as Record<string, unknown>;
  const createdAt = integer(v.createdAt);
  const proofs = list(v.membershipProofs).map(proof);
  const groups = new Set<string>();
  for (const p of proofs) {
    if (t.visibility !== 'source-restricted' || t.conversationType !== 'private' ||
      !proofMatches(p, t, p.groupId, createdAt) || groups.has(p.groupId)) return reject();
    groups.add(p.groupId);
  }
  return Object.freeze({ ...t, allowedSources: references(v.allowedSources),
    membershipProofs: Object.freeze(proofs.sort((a, b) => compare(a.groupId, b.groupId))), createdAt });
}

function closure(value: Record<string, unknown>): ProvenanceClosure {
  if (value.complete !== true) return reject();
  const sourceRefs = references(value.sourceRefs);
  const messageKeys = messages(value.messageKeys);
  const dependencyVersions = versions(value.dependencyVersions);
  if (!sourceRefs.length || !messageKeys.length) return reject();
  return Object.freeze({ sourceRefs, messageKeys, dependencyVersions, complete: true });
}

/**
 * Union ALL inputs supplied to any stage, including raw messages, metadata and prior outputs.
 * Unknown dependency IDs/versions fail closed. knownDependencyVersions is an explicit trusted
 * active-version catalog; inputVersion declares an input's own version. No model citation list
 * can shrink this union. Callers must pass complete host-generated transitive input closures.
 */
export function unionClosure(inputs: readonly ProvenanceInput[],
  knownDependencyVersions: readonly DependencyVersion[] = []): ProvenanceClosure {
  const items = list(inputs);
  if (!items.length) return reject();
  const allSources: SourceRef[] = [];
  const allMessages: string[] = [];
  const allDependencies: DependencyVersion[] = [];
  const declared = [...versions(knownDependencyVersions)];
  for (const item of items) {
    const v = record(item, closureKeys, ['inputVersion']);
    const c = closure(v);
    allSources.push(...c.sourceRefs);
    allMessages.push(...c.messageKeys);
    allDependencies.push(...c.dependencyVersions);
    if (Object.hasOwn(v, 'inputVersion')) {
      const own = dependency(v.inputVersion);
      if (c.dependencyVersions.some(ref => ref.memoryId === own.memoryId)) return reject();
      allDependencies.push(own);
      declared.push(own);
    }
  }
  const catalog = new Map(versions(declared).map(v => [v.memoryId, v.version]));
  const dependencyVersions = versions(allDependencies);
  if (dependencyVersions.some(v => catalog.get(v.memoryId) !== v.version)) return reject();
  return closure({ sourceRefs: allSources, messageKeys: allMessages, dependencyVersions, complete: true });
}

/**
 * Recheck immediately before selecting any payload for models/rerank/cache/send. The caller
 * must provide current sources, tombstones and dependency versions from the authorization
 * barrier and compare scope revisions/connection against current target configuration.
 * A snapshot is not a capability: source/proof checks are repeated per actual dependency.
 */
export function memoryUsable(memory: MemoryMetadata, scope: AuthorizedScope, currentSources: readonly SourceRecord[],
  now: number, options: MemoryUsabilityOptions = {}): boolean {
  try {
    integer(now);
    const v = record(memory, [...closureKeys, 'memoryId', 'version', 'botId', 'personalityId', 'active', 'tombstoned']);
    const memoryId = text(v.memoryId);
    integer(v.version, true);
    const c = closure(v);
    if (c.dependencyVersions.some(ref => ref.memoryId === memoryId)) return false;
    const s = authorized(scope);
    if (s.createdAt > now || v.active !== true || v.tombstoned !== false ||
      qq(v.botId) !== s.botId || text(v.personalityId) !== s.personalityId) return false;
    const current = sourceIndex(currentSources);
    const allowed = new Map(s.allowedSources.map(ref => [ref.sourceId, ref.sourceEpoch]));
    for (const ref of c.sourceRefs) {
      const item = current.get(ref.sourceId);
      if (!item || allowed.get(ref.sourceId) !== ref.sourceEpoch || item.sourceEpoch !== ref.sourceEpoch ||
        !sourceAllowed(item, s, s.membershipProofs, now)) return false;
    }
    const o = record(options, [], ['currentDependencyVersions', 'tombstonedMessageKeys', 'isMessageForgotten']);
    const currentVersions = new Map(versions(Object.hasOwn(o, 'currentDependencyVersions') ? o.currentDependencyVersions : [])
      .map(ref => [ref.memoryId, ref.version]));
    if (c.dependencyVersions.some(ref => currentVersions.get(ref.memoryId) !== ref.version)) return false;
    const forgotten = new Set(messages(Object.hasOwn(o, 'tombstonedMessageKeys') ? o.tombstonedMessageKeys : []));
    if (Object.hasOwn(o, 'isMessageForgotten') && typeof o.isMessageForgotten !== 'function') return false;
    const lookup = o.isMessageForgotten as ((messageKey: string) => boolean) | undefined;
    for (const key of c.messageKeys) {
      if (forgotten.has(key)) return false;
      if (lookup && lookup(key) !== false) return false;
    }
    return true;
  } catch { return false; }
}

/** Canonical SHA-256 metadata fingerprint only; this module implements no content cache. */
export function scopeFingerprint(scope: AuthorizedScope): string {
  const s = authorized(scope);
  // Explicit schema-order projection; record validators reject hidden/unknown content fields.
  const canonical = [1, s.botId, s.personalityId, s.conversationType, s.conversationId, s.requesterQQ,
    s.visibility, s.configRevision, s.authEpoch, s.bindingRevision, s.connectionEpoch, s.createdAt,
    s.allowedSources.map(ref => [ref.sourceId, ref.sourceEpoch]),
    s.membershipProofs.map(p => [p.botId, p.groupId, p.userId, p.connectionEpoch, p.checkedAt, p.expiresAt])];
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
