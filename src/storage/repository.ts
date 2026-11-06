import { fingerprint, freezeDeep } from '../llm/routes.js';
import {
  controlSchema, ledgerSchema, memoryVersionKey, provenanceSchema, ZERO_HASH,
} from './model.js';
import type {
  ControlState, DeletionLedger, ForgetTarget, LedgerEntry, Provenance,
} from './model.js';

/** A production cell is a durable storageDomain global handle, not an in-memory fallback. */
export interface DurableCell<T> { get(): T; set(value: T): Promise<void> }
export interface OwnerIdentity { readonly ownerId: string; isHeld(): boolean }
export class StorageError extends Error {
  override readonly name = 'StorageError';
  constructor(readonly code: string) { super(code); }
}

/** One shared authorization/commit barrier. Never await an LLM/knowledge/network response inside it. */
export class CommitBarrier {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.then(() => {}, () => {});
    return pending;
  }
}

export interface MetadataGuard { kind: 'metadata'; fence: number }
export interface ContentGuard {
  kind: 'content'; fence: number; botId: string; personalityId: string; provenance: Provenance;
  /** Ingress only: missing keys allowed before, but never after, its atomic insert. */
  newMessageKeys?: readonly string[];
  /** Compare current immutable Config reference, target binding and request cancellation. */
  validateLive?: () => boolean;
}
export type WriteGuard = MetadataGuard | ContentGuard;

function safeIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new StorageError('counter-overflow');
  return value + 1;
}
function affected(provenance: Provenance, target: ForgetTarget): boolean {
  return target.kind === 'source'
    ? provenance.sourceRefs.some(ref => ref.sourceId === target.sourceId && ref.sourceEpoch <= target.throughEpoch)
    : provenance.messageKeys.some(message => target.messageKeys.includes(message));
}
function messageAffected(sourceId: string, epoch: number, messageKey: string, target: ForgetTarget): boolean {
  return target.kind === 'source' ? target.sourceId === sourceId && epoch <= target.throughEpoch : target.messageKeys.includes(messageKey);
}

/** Ledger hash excludes entryHash itself. Encoding is stable-json-sha256/v1 via fingerprint. */
export function ledgerEntryHash(entry: Omit<LedgerEntry, 'entryHash'>): string {
  return fingerprint({ encoding: 'deletion-ledger-v1', ...entry });
}
export function validateLedger(input: DeletionLedger): DeletionLedger {
  const ledger = ledgerSchema.parse(input);
  let previousHash = ZERO_HASH;
  let sequence = 0;
  const operations = new Set<string>();
  for (const entry of ledger.entries) {
    sequence = safeIncrement(sequence);
    const { entryHash, ...unsigned } = entry;
    if (entry.sequence !== sequence || entry.previousHash !== previousHash || operations.has(entry.operationId)
      || ledgerEntryHash(unsigned) !== entryHash) throw new StorageError('ledger-chain-invalid');
    previousHash = entryHash;
    operations.add(entry.operationId);
  }
  if (ledger.sequence !== sequence || ledger.headHash !== previousHash) throw new StorageError('ledger-watermark-invalid');
  return ledger;
}

/** Replaying is idempotent. This function only projects a ledger operation; it never calls external services. */
export function projectLedgerEntry(state: ControlState, entry: LedgerEntry): void {
  if (entry.sequence <= state.ledgerSequence) return;
  if (entry.sequence !== state.ledgerSequence + 1 || entry.previousHash !== state.ledgerHeadHash) {
    throw new StorageError('ledger-projection-gap');
  }
  state.authEpoch = safeIncrement(state.authEpoch);
  const forget = entry.action === 'forget';
  const target = entry.target;
  if (target.kind === 'source') {
    if (forget) state.forgottenSources[target.sourceId] = Math.max(state.forgottenSources[target.sourceId] ?? 0, target.throughEpoch);
    const source = state.sources[target.sourceId];
    if (source && source.sourceEpoch <= target.throughEpoch) {
      source.allowed = false;
      source.forgotten = forget;
      source.sourceEpoch = safeIncrement(target.throughEpoch);
    }
  } else if (forget) {
    for (const message of target.messageKeys) state.forgottenMessages[message] = entry.sequence;
  }
  const pendingDocs = new Set<string>();
  let externalWriteUnknown = false;
  for (const message of Object.values(state.messages)) {
    if (!messageAffected(message.sourceRef.sourceId, message.sourceRef.sourceEpoch, message.key, target)) continue;
    message.state = forget ? 'forgotten' : 'quarantined';
    if (forget) {
      state.forgottenMessages[message.key] = entry.sequence;
      delete message.text;
      delete message.sanitizedEventJson;
    }
  }
  for (const task of Object.values(state.tasks)) {
    if (!affected(task.provenance, target)) continue;
    if (task.state !== 'done') task.state = 'cancelled';
    if (forget) task.checkpoint = {};
  }
  for (const memory of Object.values(state.memories)) {
    if (!affected(memory.provenance, target)) continue;
    memory.active = false;
    memory.tombstoned = forget || memory.tombstoned;
    memory.state = 'invalidated';
    memory.stale = true;
    if (state.activeMemory[memory.memoryId] === memoryVersionKey(memory.memoryId, memory.version)) delete state.activeMemory[memory.memoryId];
    if (forget) {
      delete memory.text;
      memory.entities = [];
      delete memory.eventStart;
      delete memory.eventEnd;
      if (memory.docId) pendingDocs.add(memory.docId);
    }
  }
  for (const intent of Object.values(state.intents)) {
    if (!affected(intent.provenance, target)) continue;
    intent.state = 'invalidated';
    if (forget) {
      delete intent.text;
      for (const docId of intent.docIds) pendingDocs.add(docId);
      if (intent.externalWrite === 'in_flight' || intent.externalWrite === 'unknown') externalWriteUnknown = true;
    }
  }
  for (const task of Object.values(state.maintenance)) {
    if (task.kind !== 'embedding') continue;
    const mutation = task.mutation;
    const intent = task.intentId ? state.intents[task.intentId] : undefined;
    if (!(mutation ? affected(mutation.provenance, target) : intent && affected(intent.provenance, target))) continue;
    // Retain the attempt forever: neither deletion nor enumeration proves remote termination.
    task.state = 'dead-letter';
    task.errorCodes = [forget ? 'embedding-repair-forgotten' : 'embedding-repair-revoked'];
    if (forget && mutation) {
      pendingDocs.add(mutation.docId);
      if (mutation.externalWrite === 'in_flight' || mutation.externalWrite === 'unknown') externalWriteUnknown = true;
    }
  }
  for (const reply of Object.values(state.replies)) {
    if (!affected(reply.provenance, target)) continue;
    if (reply.state !== 'completed' && reply.state !== 'partial' && reply.state !== 'unknown') reply.state = 'cancelled';
    reply.cancellationCode = forget ? 'forgotten-dependency' : 'revoked-dependency';
  }
  for (const segment of Object.values(state.segments)) {
    if (!affected(segment.provenance, target)) continue;
    if (segment.state === 'sending') segment.state = 'unknown';
    else if (segment.state === 'prepared') segment.state = 'cancelled';
    if (forget) delete segment.text;
    segment.errorCode = forget ? 'forgotten-dependency' : 'revoked-dependency';
    const reply = state.replies[segment.replyId];
    if (reply && segment.state === 'unknown') reply.state = 'unknown';
  }
  for (const [refreshKey, refresh] of Object.entries(state.refresh)) {
    if (target.kind === 'source' && (refresh.provenance ? affected(refresh.provenance, target) : refresh.sourceId === target.sourceId)) {
      delete state.refresh[refreshKey];
    }
  }
  if (forget) state.forgetTasks[entry.operationId] = {
    operationId: entry.operationId, target, ledgerSequence: entry.sequence,
    state: 'blocked', externalWriteUnknown, retries: 0, nextRunAt: entry.at,
    docIdsPending: [...pendingDocs], errorCodes: externalWriteUnknown ? ['external-write-unknown'] : [],
  };
  state.ledgerSequence = entry.sequence;
  state.ledgerHeadHash = entry.entryHash;
}

function recoverTransient(state: ControlState, ownerId: string, now: number): void {
  for (const task of Object.values(state.tasks)) {
    if (task.state === 'running' && (task.ownerId !== ownerId || (task.leaseUntil ?? 0) <= now)) {
      task.state = 'retry';
      task.nextRunAt = now;
      delete task.ownerId;
      delete task.fence;
      delete task.leaseUntil;
    }
  }
  for (const intent of Object.values(state.intents)) {
    if (intent.state === 'writing' || intent.externalWrite === 'in_flight') {
      if (intent.state !== 'invalidated' && intent.state !== 'cleaned') intent.state = 'reconcile_required';
      intent.externalWrite = 'unknown';
    }
  }
  for (const task of Object.values(state.maintenance)) {
    if (task.mutation?.externalWrite === 'in_flight') task.mutation.externalWrite = 'unknown';
    if (task.mutation?.externalWrite === 'unknown') {
      task.state = 'dead-letter'; task.errorCodes = ['embedding-repair-outcome-unknown'];
    } else if (task.state === 'running') {
      task.state = 'retry'; task.nextRunAt = now;
    }
  }
  for (const segment of Object.values(state.segments)) {
    if (segment.state === 'sending') {
      segment.state = 'unknown';
      segment.errorCode = 'restart-after-possible-submit';
    } else if (segment.state === 'prepared') segment.state = 'cancelled';
  }
  for (const reply of Object.values(state.replies)) {
    if (['pending', 'generating', 'prepared', 'sending'].includes(reply.state)) {
      const segments = Object.values(state.segments).filter(segment => segment.replyId === reply.replyId);
      reply.state = segments.some(segment => segment.state === 'unknown') ? 'unknown'
        : segments.some(segment => segment.state === 'succeeded') ? 'partial' : 'cancelled';
      reply.cancellationCode = 'restart-no-online-replay';
    }
  }
}

function closureContains(container: Provenance, input: Provenance): boolean {
  return input.sourceRefs.every(ref => container.sourceRefs.some(other => other.sourceId === ref.sourceId && other.sourceEpoch === ref.sourceEpoch))
    && input.messageKeys.every(message => container.messageKeys.includes(message))
    && input.dependencyVersions.every(dep => container.dependencyVersions.some(other => other.memoryId === dep.memoryId && other.version === dep.version));
}

/** Detect accidental unguarded body/checkpoint/task writes even in trusted plugin modules. */
type MutationProof = 'not_invoked' | 'fulfilled' | 'rejected';
function mutationProofKey(taskId: string, attemptId: string, fence: number): string { return JSON.stringify([taskId, attemptId, fence]); }
function assertGuardedChanges(before: ControlState, draft: ControlState, guard: WriteGuard,
  mutationProofs: ReadonlyMap<string, MutationProof>): void {
  if (draft.ownerId !== before.ownerId || draft.ownerFence !== before.ownerFence || draft.ownerActive !== before.ownerActive) {
    throw new StorageError('owner-fields-are-repository-owned');
  }
  for (const [sourceId, source] of Object.entries(draft.sources)) {
    const old = before.sources[sourceId];
    if (old?.allowed && (!source.allowed || source.sourceEpoch !== old.sourceEpoch || source.forgotten !== old.forgotten)) {
      throw new StorageError('source-invalidation-requires-ledger');
    }
    if (old && (source.sourceEpoch < old.sourceEpoch || source.botId !== old.botId || source.personalityId !== old.personalityId
      || source.conversationType !== old.conversationType || source.conversationId !== old.conversationId)) {
      throw new StorageError('source-identity-or-epoch-invalid');
    }
  }
  for (const sourceId of Object.keys(before.sources)) {
    if (!draft.sources[sourceId]) throw new StorageError('source-history-cannot-be-deleted');
  }
  for (const [messageKey, generation] of Object.entries(before.forgottenMessages)) {
    if ((draft.forgottenMessages[messageKey] ?? 0) < generation) throw new StorageError('message-tombstone-cannot-roll-back');
  }
  for (const [sourceId, generation] of Object.entries(before.forgottenSources)) {
    if ((draft.forgottenSources[sourceId] ?? 0) < generation) throw new StorageError('source-tombstone-cannot-roll-back');
  }
  const check = (provenance: Provenance): void => {
    if (guard.kind !== 'content') throw new StorageError('content-guard-required');
    if (!closureContains(provenance, guard.provenance)) throw new StorageError('output-must-inherit-all-inputs');
  };
  for (const [snapshotId, snapshot] of Object.entries(draft.snapshots)) {
    const old = before.snapshots[snapshotId];
    if (!old && guard.kind !== 'content') throw new StorageError('snapshot-content-guard-required');
    if (old && fingerprint(old) !== fingerprint(snapshot)) throw new StorageError('snapshot-is-immutable');
  }
  for (const [messageKey, message] of Object.entries(draft.messages)) {
    const old = before.messages[messageKey];
    if (!old || (message.text !== undefined && message.text !== old.text)
      || (message.sanitizedEventJson !== undefined && message.sanitizedEventJson !== old.sanitizedEventJson)) {
      check({ complete: true, sourceRefs: [message.sourceRef], messageKeys: [message.key], dependencyVersions: [] });
    }
  }
  for (const [taskId, task] of Object.entries(draft.tasks)) {
    const old = before.tasks[taskId];
    if (old && (task.kind !== old.kind || task.bankKey !== old.bankKey || task.snapshotId !== old.snapshotId
      || task.routeFingerprint !== old.routeFingerprint || task.messageKey !== old.messageKey || task.segmentId !== old.segmentId
      || task.templateId !== old.templateId || task.scopeKey !== old.scopeKey)) {
      throw new StorageError('task-identity-and-route-are-immutable');
    }
    if (old && (task.leaseToken < old.leaseToken || task.attemptCount < old.attemptCount || task.retryCount < old.retryCount
      || task.calls < old.calls || task.reservedTokens < old.reservedTokens
      || (task.leaseToken === old.leaseToken && task.attemptCalls < old.attemptCalls))) throw new StorageError('task-counters-cannot-roll-back');
    if (old && !closureContains(task.provenance, old.provenance)) throw new StorageError('task-input-closure-cannot-shrink');
    if (!old || fingerprint(task.provenance) !== fingerprint(old.provenance)
      || (Object.keys(task.checkpoint).length > 0 && fingerprint(task.checkpoint) !== fingerprint(old.checkpoint))) check(task.provenance);
  }
  for (const [memoryKey, memory] of Object.entries(draft.memories)) {
    const old = before.memories[memoryKey];
    if (!old || (memory.text !== undefined && memory.text !== old.text) || (!old.active && memory.active)
      || memory.entities.some(entity => !old.entities.includes(entity))
      || (memory.eventStart !== undefined && memory.eventStart !== old.eventStart)
      || (memory.eventEnd !== undefined && memory.eventEnd !== old.eventEnd)) check(memory.provenance);
  }
  for (const [intentId, intent] of Object.entries(draft.intents)) {
    const old = before.intents[intentId];
    if (!old || (intent.text !== undefined && intent.text !== old.text)
      || (intent.state === 'writing' && old.state !== 'writing')) check(intent.provenance);
  }
  for (const [taskId, old] of Object.entries(before.maintenance)) {
    if (old.mutation && !draft.maintenance[taskId]?.mutation) throw new StorageError('repair-attempt-history-cannot-be-deleted');
  }
  for (const [taskId, task] of Object.entries(draft.maintenance)) {
    const oldTask = before.maintenance[taskId];
    if (oldTask && (task.kind !== oldTask.kind || task.bankKey !== oldTask.bankKey || task.intentId !== oldTask.intentId
      || task.retries < oldTask.retries)) throw new StorageError('maintenance-identity-or-counters-invalid');
    const mutation = task.mutation; const old = oldTask?.mutation;
    if (!mutation) continue;
    if (old && !closureContains(mutation.provenance, old.provenance)) throw new StorageError('repair-input-closure-cannot-shrink');
    if (!old || mutation.attemptId !== old.attemptId) {
      if (old && (old.externalWrite === 'unknown' || old.externalWrite === 'in_flight')) throw new StorageError('repair-unsettled-attempt-cannot-be-replaced');
      check(mutation.provenance);
      if (guard.kind !== 'content' || !closureContains(guard.provenance, mutation.provenance)) throw new StorageError('repair-full-content-guard-required');
      if (mutation.generation !== (old?.generation ?? 0) + 1 || mutation.ownerFence !== guard.fence
        || mutation.externalWrite !== 'in_flight' || mutation.outcome !== undefined || mutation.settledAt !== undefined) {
        throw new StorageError('repair-new-attempt-invalid');
      }
    } else {
      const identity = (value: typeof mutation) => ({ ...value, externalWrite: undefined, outcome: undefined, settledAt: undefined });
      if (fingerprint(identity(mutation)) !== fingerprint(identity(old))) throw new StorageError('repair-attempt-identity-is-immutable');
      if (old.externalWrite === 'settled' && fingerprint(old) !== fingerprint(mutation)) throw new StorageError('repair-settlement-is-immutable');
      const proof = mutationProofs.get(mutationProofKey(taskId, mutation.attemptId, guard.fence));
      if (mutation.externalWrite === 'settled' && old.externalWrite !== 'settled'
        && (mutation.ownerFence !== guard.fence || mutation.outcome === undefined || proof !== mutation.outcome)) {
        throw new StorageError('repair-raw-settlement-proof-required');
      }
      if (mutation.externalWrite === 'not_started' && old.externalWrite !== 'not_started'
        && (mutation.ownerFence !== guard.fence || proof !== 'not_invoked')) throw new StorageError('repair-no-submission-proof-required');
      if (old.externalWrite === 'unknown' && !['unknown', 'settled'].includes(mutation.externalWrite)) throw new StorageError('repair-unknown-cannot-be-cleared');
      if (old.externalWrite === 'not_started' && mutation.externalWrite !== 'not_started') throw new StorageError('repair-new-attempt-required');
    }
  }
  for (const [replyId, reply] of Object.entries(draft.replies)) {
    const old = before.replies[replyId];
    if (!old || fingerprint(old.provenance) !== fingerprint(reply.provenance) || (reply.outputHash !== undefined && reply.outputHash !== old.outputHash)) check(reply.provenance);
  }
  for (const [segmentId, segment] of Object.entries(draft.segments)) {
    const old = before.segments[segmentId];
    if (!old || (segment.text !== undefined && segment.text !== old.text)
      || (segment.state === 'sending' && old.state !== 'sending')) check(segment.provenance);
  }
}

/** Referential checks make malformed/recovered control data fail closed rather than silently orphaning it. */
export function validateControlInvariants(state: ControlState): void {
  for (const [sourceId, source] of Object.entries(state.sources)) if (source.sourceId !== sourceId) throw new StorageError('source-key-mismatch');
  for (const [snapshotId, snapshot] of Object.entries(state.snapshots)) if (snapshot.id !== snapshotId) throw new StorageError('snapshot-key-mismatch');
  for (const [messageKey, message] of Object.entries(state.messages)) {
    if (message.key !== messageKey || !state.snapshots[message.snapshotId] || !state.sources[message.sourceRef.sourceId]) throw new StorageError('message-reference-invalid');
  }
  for (const [bankKey, bank] of Object.entries(state.banks)) if (bank.bankKey !== bankKey) throw new StorageError('bank-key-mismatch');
  for (const [taskId, task] of Object.entries(state.tasks)) {
    if (task.taskId !== taskId || !state.snapshots[task.snapshotId] || !state.banks[task.bankKey]
      || (task.messageKey !== undefined && !state.messages[task.messageKey])
      || (task.segmentId !== undefined && !state.segments[task.segmentId])) throw new StorageError('task-reference-invalid');
  }
  for (const [versionKey, memory] of Object.entries(state.memories)) {
    if (memoryVersionKey(memory.memoryId, memory.version) !== versionKey || !state.banks[memory.bankKey]) throw new StorageError('memory-reference-invalid');
    if (memory.active && (memory.tombstoned || memory.state !== 'active' || state.activeMemory[memory.memoryId] !== versionKey)) throw new StorageError('active-memory-invalid');
  }
  for (const [memoryId, versionKey] of Object.entries(state.activeMemory)) {
    const memory = state.memories[versionKey];
    if (!memory || !memory.active || memory.tombstoned || memory.memoryId !== memoryId) throw new StorageError('active-pointer-invalid');
  }
  for (const [intentId, intent] of Object.entries(state.intents)) {
    if (intent.intentId !== intentId || !state.banks[intent.bankKey]
      || !state.memories[memoryVersionKey(intent.memoryId, intent.version)]) throw new StorageError('intent-reference-invalid');
  }
  for (const [replyId, reply] of Object.entries(state.replies)) {
    if (reply.replyId !== replyId || !state.messages[reply.messageKey] || !state.snapshots[reply.snapshotId]
      || !state.banks[reply.bankKey]) throw new StorageError('reply-reference-invalid');
  }
  for (const [segmentId, segment] of Object.entries(state.segments)) {
    if (segment.segmentId !== segmentId || !state.replies[segment.replyId]) throw new StorageError('segment-reference-invalid');
  }
  for (const [taskId, task] of Object.entries(state.maintenance)) {
    if (task.taskId !== taskId || !state.banks[task.bankKey]) throw new StorageError('maintenance-reference-invalid');
    const mutation = task.mutation;
    if (!mutation) continue;
    const memory = state.memories[memoryVersionKey(mutation.memoryId, mutation.version)];
    if (task.kind !== 'embedding' || !memory || memory.bankKey !== task.bankKey || memory.contentHash !== mutation.contentHash
      || !closureContains(mutation.provenance, memory.provenance)
      || !mutation.provenance.dependencyVersions.some(dep => dep.memoryId === mutation.memoryId && dep.version === mutation.version)
      || (mutation.externalWrite === 'settled' ? mutation.outcome === undefined || mutation.settledAt === undefined
        : mutation.outcome !== undefined || mutation.settledAt !== undefined)) throw new StorageError('repair-mutation-invalid');
  }
  for (const task of Object.values(state.forgetTasks)) {
    if (task.state !== 'purged') continue;
    if (task.externalWriteUnknown || task.docIdsPending.length || !task.purgeProof?.allBanksEnumerated
      || task.purgeProof.ledgerSequence < task.ledgerSequence) throw new StorageError('purge-not-proven');
    if (Object.values(state.intents).some(intent => affected(intent.provenance, task.target)
      && (intent.text !== undefined || intent.externalWrite === 'in_flight' || intent.externalWrite === 'unknown'))
      || Object.values(state.maintenance).some(work => work.mutation && affected(work.mutation.provenance, task.target)
        && (work.mutation.externalWrite === 'in_flight' || work.mutation.externalWrite === 'unknown'))) throw new StorageError('external-write-not-settled');
    if (Object.values(state.messages).some(message => messageAffected(message.sourceRef.sourceId, message.sourceRef.sourceEpoch, message.key, task.target)
      && (message.text !== undefined || message.sanitizedEventJson !== undefined))
      || Object.values(state.memories).some(memory => affected(memory.provenance, task.target)
        && (memory.text !== undefined || memory.active || memory.entities.length > 0 || memory.eventStart !== undefined || memory.eventEnd !== undefined))
      || Object.values(state.segments).some(segment => affected(segment.provenance, task.target) && segment.text !== undefined)
      || Object.values(state.tasks).some(work => affected(work.provenance, task.target)
        && ((work.checkpoint.facts?.length ?? 0) > 0 || work.checkpoint.derived !== undefined))) {
      throw new StorageError('local-forgotten-body-remains');
    }
  }
}

function checkedControl(input: unknown): ControlState {
  try {
    const state = controlSchema.parse(input);
    validateControlInvariants(state);
    return state;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('invalid-control-state');
  }
}

/** Aggregate state makes Message+Snapshot+Task+Reply and every activation one atomic record write. */
export class ControlRepository {
  private current: ControlState;
  private ledger: DeletionLedger;
  private stopped = false;
  private storageFailed = false;
  private volatileBlocks: ForgetTarget[] = [];
  private readonly mutationProofs = new Map<string, MutationProof>();
  readonly barrier = new CommitBarrier();
  readonly fence: number;

  private constructor(
    private readonly controlCell: DurableCell<ControlState>,
    private readonly ledgerCell: DurableCell<DeletionLedger>,
    private readonly owner: OwnerIdentity,
    state: ControlState, ledger: DeletionLedger,
  ) {
    this.current = freezeDeep(state);
    this.ledger = freezeDeep(ledger);
    this.fence = state.ownerFence;
  }

  static async open(
    control: DurableCell<ControlState>, ledgerCell: DurableCell<DeletionLedger>, owner: OwnerIdentity,
    options: { now?: number; restoreMode?: boolean } = {},
  ): Promise<ControlRepository> {
    if (!owner.isHeld() || !owner.ownerId) throw new StorageError('owner-lock-required');
    // No administrator click can stand in for an independently preserved latest deletion watermark.
    if (options.restoreMode) throw new StorageError('safe-backup-restore-not-supported-without-independent-latest-ledger');
    const state = checkedControl(structuredClone(control.get()));
    const ledger = validateLedger(structuredClone(ledgerCell.get()));
    validateControlInvariants(state);
    if (state.ledgerSequence > ledger.sequence) throw new StorageError('ledger-rollback-detected');
    const projectedHash = state.ledgerSequence === 0 ? ZERO_HASH : ledger.entries[state.ledgerSequence - 1]?.entryHash;
    if (projectedHash !== state.ledgerHeadHash) throw new StorageError('ledger-projection-mismatch');
    for (const entry of ledger.entries) projectLedgerEntry(state, entry);
    state.ownerFence = safeIncrement(state.ownerFence);
    state.ownerId = owner.ownerId;
    state.ownerActive = true;
    state.revision = safeIncrement(state.revision);
    recoverTransient(state, owner.ownerId, options.now ?? Date.now());
    if (!owner.isHeld()) throw new StorageError('owner-lost');
    const checked = checkedControl(state);
    await control.set(checked);
    if (!owner.isHeld()) throw new StorageError('owner-lost');
    return new ControlRepository(control, ledgerCell, owner, checked, ledger);
  }

  private assertOwner(fence = this.fence): void {
    if (this.stopped || !this.owner.isHeld() || !this.current.ownerActive || this.current.ownerId !== this.owner.ownerId
      || this.current.ownerFence !== fence) throw new StorageError('owner-fenced');
    if (this.storageFailed) throw new StorageError('storage-unavailable');
  }

  read(): Readonly<ControlState> { this.assertOwner(); return this.current; }

  getHealth(): { state: 'ready' | 'blocked' | 'stopped'; fence: number; revision: number } {
    return { state: this.stopped ? 'stopped' : this.storageFailed || !this.owner.isHeld() ? 'blocked' : 'ready',
      fence: this.fence, revision: this.current.revision };
  }

  assertContentAllowed(guard: ContentGuard): void {
    this.assertOwner(guard.fence);
    this.assertContent(this.current, guard, false);
  }

  private assertContent(state: ControlState, guard: ContentGuard, allowNew: boolean): void {
    if (guard.validateLive) {
      try { if (guard.validateLive() !== true) throw new Error(); }
      catch { throw new StorageError('live-authorization-invalid'); }
    }
    for (const bank of Object.values(state.banks)) {
      if (bank.botId === guard.botId && bank.personalityId === guard.personalityId
        && (state.pausedBanks[bank.bankKey] || bank.state === 'blocked' || bank.state === 'retiring' || bank.state === 'suspended')) {
        throw new StorageError('bank-paused');
      }
    }
    const provenance = provenanceSchema.parse(guard.provenance);
    if (this.volatileBlocks.some(target => affected(provenance, target))) throw new StorageError('pending-deletion-block');
    const refs = new Map<string, number>();
    for (const ref of provenance.sourceRefs) {
      if (refs.has(ref.sourceId) && refs.get(ref.sourceId) !== ref.sourceEpoch) throw new StorageError('conflicting-source-epochs');
      refs.set(ref.sourceId, ref.sourceEpoch);
      const source = state.sources[ref.sourceId];
      if (!source || !source.allowed || source.forgotten || source.sourceEpoch !== ref.sourceEpoch
        || source.botId !== guard.botId || source.personalityId !== guard.personalityId
        || (state.forgottenSources[ref.sourceId] ?? 0) >= ref.sourceEpoch) throw new StorageError('source-invalid');
    }
    for (const messageKey of provenance.messageKeys) {
      if (state.forgottenMessages[messageKey]) throw new StorageError('message-forgotten');
      const message = state.messages[messageKey];
      if (!message && allowNew && guard.newMessageKeys?.includes(messageKey)) continue;
      if (!message || message.state !== 'active' || message.botId !== guard.botId || message.personalityId !== guard.personalityId
        || refs.get(message.sourceRef.sourceId) !== message.sourceRef.sourceEpoch) throw new StorageError('message-source-invalid');
    }
    for (const dependency of provenance.dependencyVersions) {
      const versionKey = memoryVersionKey(dependency.memoryId, dependency.version);
      const memory = state.memories[versionKey];
      if (!memory || !memory.active || memory.tombstoned || memory.state !== 'active'
        || state.activeMemory[memory.memoryId] !== versionKey || memory.botId !== guard.botId || memory.personalityId !== guard.personalityId) {
        throw new StorageError('dependency-version-invalid');
      }
      if (memory.provenance.sourceRefs.some(ref => refs.get(ref.sourceId) !== ref.sourceEpoch)
        || memory.provenance.messageKeys.some(message => !provenance.messageKeys.includes(message))) {
        throw new StorageError('incomplete-dependency-closure');
      }
    }
  }

  private async commitUnlocked<T>(guard: WriteGuard, mutate: (draft: ControlState) => T): Promise<T> {
    this.assertOwner(guard.fence);
    const draft = structuredClone(this.current);
    if (guard.kind === 'content') this.assertContent(draft, guard, true);
    const result = mutate(draft);
    if (result !== null && typeof result === 'object' && 'then' in result) throw new StorageError('async-transaction-not-allowed');
    this.assertOwner(guard.fence);
    assertGuardedChanges(this.current, draft, guard, this.mutationProofs);
    if (guard.kind === 'content') this.assertContent(draft, guard, false);
    draft.revision = safeIncrement(draft.revision);
    const checked = checkedControl(draft);
    try { await this.controlCell.set(checked); }
    catch { this.storageFailed = true; throw new StorageError('control-commit-failed'); }
    this.current = freezeDeep(checked);
    if (!this.owner.isHeld()) {
      this.storageFailed = true;
      throw new StorageError('owner-lost-after-commit');
    }
    return freezeDeep(structuredClone(result));
  }

  /** Capture ONLY the actual prepared SDK submission promise, before awaiting/racing it.
   * A stopped/closed old owner never transfers its settlement proof to a replacement owner.
   * The returned promise carries fixed outcomes, never SDK exception bodies. */
  trackMaintenanceSubmission(taskId: string, attemptId: string,
    submission: { invoked: () => boolean; completion: Promise<void> }): Promise<'fulfilled' | 'rejected' | 'not_invoked'> {
    this.assertOwner();
    const mutation = this.current.maintenance[taskId]?.mutation;
    if (!mutation || mutation.attemptId !== attemptId || mutation.ownerFence !== this.fence
      || mutation.externalWrite !== 'in_flight') throw new StorageError('repair-attempt-not-current');
    const key = mutationProofKey(taskId, attemptId, this.fence);
    const capture = (outcome: MutationProof): MutationProof => {
      try { this.assertOwner(); this.mutationProofs.set(key, outcome); } catch { /* Closed owner cannot confirm an unknown attempt. */ }
      return outcome;
    };
    return submission.completion.then(
      () => capture(submission.invoked() ? 'fulfilled' : 'not_invoked'),
      () => capture(submission.invoked() ? 'rejected' : 'not_invoked'));
  }

  /** Callback is synchronous. External computation happens before a short guarded transaction. */
  async transact<T>(guard: WriteGuard, mutate: (draft: ControlState) => T): Promise<T> {
    return this.barrier.run(() => this.commitUnlocked(guard, mutate));
  }

  /**
   * Final authorization + durable sending intent + synchronous network submission share one
   * barrier. start() MUST submit before returning its Promise (no awaits/queues before submit).
   * Network completion is deliberately wrapped, not awaited under the authorization barrier.
   */
  async commitAndSubmit<T, U>(guard: ContentGuard, mutate: (draft: ControlState) => T, start: () => Promise<U>): Promise<{ result: T; completion: Promise<U> }> {
    return this.barrier.run(async () => {
      const result = await this.commitUnlocked(guard, mutate);
      this.assertContentAllowed(guard);
      let completion: Promise<U>;
      try { completion = start(); }
      catch { throw new StorageError('submission-threw-after-durable-intent'); }
      // Attach rejection handling immediately; the caller still receives the rejecting promise.
      void completion.catch(() => {});
      return { result, completion };
    });
  }

  /** Same barrier as sending. Ledger is durable first; projection failure leaves the bank/runtime blocked. */
  async recordDeletion(operationId: string, target: ForgetTarget, action: 'forget' | 'revoke' = 'forget', now = Date.now()): Promise<string> {
    return this.barrier.run(async () => {
      this.assertOwner();
      const existing = this.ledger.entries.find(entry => entry.operationId === operationId);
      if (existing) {
        if (fingerprint(existing.target) !== fingerprint(target) || existing.action !== action) throw new StorageError('deletion-operation-conflict');
        return existing.operationId;
      }
      try {
        this.volatileBlocks.push(structuredClone(target));
        const unsigned = {
          operationId, target: structuredClone(target), action, at: now,
          sequence: safeIncrement(this.ledger.sequence), previousHash: this.ledger.headHash,
        };
        const entry: LedgerEntry = { ...unsigned, entryHash: ledgerEntryHash(unsigned) };
        const nextLedger = validateLedger({
          schemaVersion: 1, sequence: entry.sequence, headHash: entry.entryHash, entries: [...this.ledger.entries, entry],
        });
        try { await this.ledgerCell.set(nextLedger); }
        catch { throw new StorageError('deletion-ledger-commit-failed'); }
        this.ledger = freezeDeep(nextLedger);
        const draft = structuredClone(this.current);
        projectLedgerEntry(draft, entry);
        draft.revision = safeIncrement(draft.revision);
        const checked = checkedControl(draft);
        try { await this.controlCell.set(checked); }
        catch { throw new StorageError('deletion-projection-commit-failed'); }
        this.current = freezeDeep(checked);
        this.volatileBlocks = this.volatileBlocks.filter(block => fingerprint(block) !== fingerprint(target));
        return operationId;
      } catch (error) {
        this.storageFailed = true;
        if (error instanceof StorageError) throw error;
        throw new StorageError('deletion-operation-failed');
      }
    });
  }

  /** Drain commits and invalidate owner state before the caller closes domains and releases the lock. */
  async close(): Promise<void> {
    await this.barrier.run(async () => {
      if (this.stopped) return;
      this.stopped = true;
      if (this.storageFailed || !this.owner.isHeld()) return;
      const draft = structuredClone(this.current);
      draft.ownerActive = false;
      draft.ownerFence = safeIncrement(draft.ownerFence);
      draft.revision = safeIncrement(draft.revision);
      try {
        await this.controlCell.set(checkedControl(draft));
        this.current = freezeDeep(draft);
      } catch { this.storageFailed = true; throw new StorageError('control-close-failed'); }
    });
  }
}
