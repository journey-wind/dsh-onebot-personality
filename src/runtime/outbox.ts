import { selectPersonality } from '../config.js';
import { fingerprint } from '../llm/routes.js';
import type { LateSendOutcome, OneBotClient, SendOutcome } from '../onebot/client.js';
import { normalizeMessageId, sanitizeSecrets, splitOutgoingText } from '../onebot/protocol.js';
import { provenanceSchema } from '../storage/model.js';
import type { ControlState, Provenance, ReplyRecord, SegmentRecord } from '../storage/model.js';
import { ControlRepository, StorageError } from '../storage/repository.js';
import type { ContentGuard } from '../storage/repository.js';
import { RuntimeError } from './configuration.js';
import type { ConfigurationReader } from './configuration.js';

export interface OutboxOptions {
  readConfiguration: ConfigurationReader;
  /** Trusted live policy: true MUST query actual dependency groups without member-cache reuse. */
  authorizeReply: (reply: ReplyRecord, forceMembers: boolean) => Promise<ContentGuard>;
  now?: () => number;
}

function contains(outer: Provenance, inner: Provenance): boolean {
  return inner.sourceRefs.every(ref => outer.sourceRefs.some(other => other.sourceId === ref.sourceId && other.sourceEpoch === ref.sourceEpoch))
    && inner.messageKeys.every(key => outer.messageKeys.includes(key))
    && inner.dependencyVersions.every(dep => outer.dependencyVersions.some(other => other.memoryId === dep.memoryId && other.version === dep.version));
}
function sameClosure(a: Provenance, b: Provenance): boolean { return contains(a, b) && contains(b, a); }
function textHash(text: string): string { return fingerprint({ encoding: 'outbox-text-v1', text }); }
function segmentsFor(state: Readonly<ControlState>, replyId: string): SegmentRecord[] {
  return Object.values(state.segments).filter(segment => segment.replyId === replyId).sort((a, b) => a.index - b.index);
}
function cancelRemaining(state: ControlState, replyId: string, code: string): void {
  for (const segment of segmentsFor(state, replyId)) {
    if (segment.state !== 'prepared') continue;
    segment.state = 'cancelled'; segment.errorCode = code;
    delete segment.text;
  }
}
function summarize(state: ControlState, replyId: string): void {
  const reply = state.replies[replyId]!;
  const segments = segmentsFor(state, replyId);
  if (!segments.length) return;
  const some = (status: SegmentRecord['state']): boolean => segments.some(segment => segment.state === status);
  reply.state = segments.every(segment => segment.state === 'succeeded') ? 'completed'
    : some('sending') ? 'sending'
    : some('unknown') ? (some('succeeded') ? 'partial' : 'unknown')
    : some('prepared') ? (some('succeeded') ? 'sending' : 'prepared')
    : some('succeeded') ? 'partial' : some('failed') ? 'failed' : 'cancelled';
}
// Only authorization rejection is eligible for body-free fallback. Storage failures MUST escape.
const AUTHORIZATION_ERRORS = new Set([
  'live-authorization-invalid', 'bank-paused', 'pending-deletion-block', 'conflicting-source-epochs',
  'source-invalid', 'message-forgotten', 'message-source-invalid', 'dependency-version-invalid', 'incomplete-dependency-closure',
]);

/** Durable, fixed-text, one-shot sends. No timers, reconnect replay, model routing or arbitrary API surface. */
export class Outbox {
  private readonly active = new Set<string>();
  constructor(
    private readonly repository: ControlRepository,
    private readonly transport: Pick<OneBotClient, 'identity' | 'prepareTextSend'>,
    private readonly options: OutboxOptions,
  ) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private reply(replyId: string): ReplyRecord {
    const reply = this.repository.read().replies[replyId];
    if (!reply) throw new RuntimeError('reply-not-found');
    return reply;
  }

  /** Enforce configuration/identity in addition to (never instead of) the injected policy. */
  private async authorize(reply: ReplyRecord, forceMembers: boolean, submitting = false): Promise<ContentGuard> {
    const observed = this.options.readConfiguration();
    const guard = await this.options.authorizeReply(structuredClone(reply), forceMembers);
    const state = this.repository.read();
    const message = state.messages[reply.messageKey];
    const bank = state.banks[reply.bankKey];
    if (!message || !bank || guard.kind !== 'content' || guard.fence !== this.repository.fence
      || guard.botId !== bank.botId || guard.personalityId !== bank.personalityId
      || !sameClosure(guard.provenance, reply.provenance)) throw new RuntimeError('reply-guard-mismatch');
    const validatePolicy = guard.validateLive;
    return { ...guard, provenance: structuredClone(reply.provenance), validateLive: () => {
      const current = this.options.readConfiguration();
      const live = this.repository.read();
      const identity = this.transport.identity;
      const targetAllowed = (message.conversationType === 'group' ? current.config.allow.groupIds : current.config.allow.privateUserIds)
        .includes(message.conversationId);
      return current.revision === observed.revision && current.revision === reply.configRevision
        && live.configRevision === reply.configRevision && live.authEpoch === reply.authEpoch
        && live.bindingRevision === reply.bindingRevision && current.config.onebot.enabled && targetAllowed
        && identity?.selfId === bank.botId && identity.selfId === current.config.onebot.expectedSelfId
        && selectPersonality(current.config, message.conversationType, message.conversationId).id === bank.personalityId
        && (!submitting || this.now() < reply.deadlineAt) && (!validatePolicy || validatePolicy() === true);
    } };
  }

  /** completeText is the complete StageCaller stop result, never a streaming prefix. */
  async prepare(replyId: string, completeText: string, provenance: Provenance): Promise<ReplyRecord> {
    const original = this.reply(replyId);
    const state = this.repository.read();
    const message = state.messages[original.messageKey]!;
    let closure: Provenance;
    try { closure = provenanceSchema.parse(provenance); }
    catch { throw new RuntimeError('invalid-reply-provenance'); }
    if (!contains(closure, original.provenance) || !closure.messageKeys.includes(message.key)
      || !closure.sourceRefs.some(ref => ref.sourceId === message.sourceRef.sourceId && ref.sourceEpoch === message.sourceRef.sourceEpoch)) {
      throw new RuntimeError('incomplete-reply-provenance');
    }
    if (!['pending', 'generating'].includes(original.state) || segmentsFor(state, replyId).length) throw new RuntimeError('reply-already-prepared');
    const proposed: ReplyRecord = { ...original, provenance: closure };
    // Important: policy sees the supplied FULL generation closure before any output is saved.
    const guard = await this.authorize(proposed, false, true);
    const observed = this.options.readConfiguration();
    const config = observed.config;
    let text: string;
    let chunks: ReturnType<typeof splitOutgoingText>;
    try {
      if (typeof completeText !== 'string') throw new Error();
      text = sanitizeSecrets(completeText, config.onebot.token ? [config.onebot.token] : []);
      chunks = splitOutgoingText(text, {
        maxCodePointsPerSegment: config.budgets.sendCodePoints, maxSegments: config.budgets.sendMaxSegments,
        maxUtf8BytesPerSegment: config.budgets.sendSegmentBytes, maxPayloadBytesPerSegment: config.budgets.sendSegmentBytes,
      });
      // Validate EVERY complete action envelope before saving/sending any segment. These handles
      // are discarded: each real submission gets fresh transport-owned echo/epoch metadata.
      for (const chunk of chunks) this.transport.prepareTextSend(message.conversationType, message.conversationId, chunk.data.text);
    } catch { throw new RuntimeError('outgoing-validation-failed'); }
    await this.repository.transact(guard, draft => {
      const reply = draft.replies[replyId]!;
      if (!['pending', 'generating'].includes(reply.state) || segmentsFor(draft, replyId).length
        || fingerprint(reply) !== fingerprint(original)) throw new RuntimeError('reply-preparation-raced');
      reply.provenance = structuredClone(closure);
      reply.outputHash = textHash(text);
      reply.state = 'prepared';
      chunks.forEach((chunk, index) => {
        const segmentId = `segment-${fingerprint([replyId, index])}`;
        draft.segments[segmentId] = { segmentId, replyId, index, provenance: structuredClone(closure),
          bodyHash: textHash(chunk.data.text), text: chunk.data.text, state: 'prepared' };
      });
    });
    return this.reply(replyId);
  }

  /** At most one send walk per reply. Terminal/unknown replies can NEVER resume. */
  async send(replyId: string): Promise<ReplyRecord> {
    if (this.active.has(replyId)) throw new RuntimeError('reply-send-in-progress');
    const initial = this.reply(replyId);
    if (initial.state !== 'prepared') return initial;
    this.active.add(replyId);
    try {
      for (const segment of segmentsFor(this.repository.read(), replyId)) {
        const current = this.repository.read().segments[segment.segmentId]!;
        const reply = this.reply(replyId);
        if (current.state !== 'prepared' || !['prepared', 'sending'].includes(reply.state)) break;
        let guard: ContentGuard;
        let prepared: ReturnType<OneBotClient['prepareTextSend']>;
        try {
          guard = await this.authorize(reply, true, true);
          this.repository.assertContentAllowed(guard);
          if (current.text === undefined || textHash(current.text) !== current.bodyHash) throw new RuntimeError('outbox-body-invalid');
          const message = this.repository.read().messages[reply.messageKey]!;
          prepared = this.transport.prepareTextSend(message.conversationType, message.conversationId, current.text);
        } catch (error) {
          if (error instanceof StorageError && !AUTHORIZATION_ERRORS.has(error.code)) throw error;
          // A revoked/forgotten body is never copied back into a metadata transaction.
          await this.cancel(replyId, 'send-authorization-or-preparation-failed');
          break;
        }
        let completion: Promise<SendOutcome>;
        try {
          const submitted = await this.repository.commitAndSubmit(guard, draft => {
            const liveReply = draft.replies[replyId]!;
            const live = draft.segments[segment.segmentId]!;
            const before = segmentsFor(draft, replyId).filter(other => other.index < live.index);
            if (!['prepared', 'sending'].includes(liveReply.state) || live.state !== 'prepared'
              || before.some(other => other.state !== 'succeeded') || live.text === undefined
              || textHash(live.text) !== live.bodyHash || !sameClosure(live.provenance, liveReply.provenance)
              || !sameClosure(liveReply.provenance, guard.provenance)
              || this.transport.identity?.connectionEpoch !== prepared.connectionEpoch) throw new RuntimeError('send-intent-invalid');
            live.state = 'sending'; live.echo = prepared.echo; live.connectionEpoch = prepared.connectionEpoch;
            liveReply.state = 'sending';
          }, () => prepared.submit()); // MUST enter socket submission synchronously under barrier.
          completion = submitted.completion;
        } catch (error) {
          if (error instanceof StorageError && error.code === 'submission-threw-after-durable-intent') {
            await this.confirm({ echo: prepared.echo, connectionEpoch: prepared.connectionEpoch,
              outcome: { state: 'unknown' } }, false);
          } else if (error instanceof StorageError && AUTHORIZATION_ERRORS.has(error.code)) {
            await this.cancel(replyId, 'send-authorization-invalid');
          } else if (error instanceof RuntimeError && error.code === 'send-intent-invalid') {
            await this.cancel(replyId, 'send-intent-invalid');
          } else throw error;
          break;
        }
        let outcome: SendOutcome;
        try { outcome = await completion; }
        catch { outcome = { state: 'unknown' }; }
        await this.confirm({ echo: prepared.echo, connectionEpoch: prepared.connectionEpoch, outcome }, false);
        // Use the original completion, not the latest DB state: a late confirmation can race the
        // queued unknown write. Even a late success MUST NOT restart the remaining send walk.
        if (outcome.state !== 'succeeded') break;
      }
      return this.reply(replyId);
    } finally { this.active.delete(replyId); }
  }

  private async cancel(replyId: string, code: string): Promise<void> {
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      cancelRemaining(draft, replyId, code);
      for (const segment of segmentsFor(draft, replyId)) {
        if (segment.state === 'sending') { segment.state = 'unknown'; segment.errorCode = code; }
      }
      const reply = draft.replies[replyId]!;
      reply.cancellationCode ??= code;
      summarize(draft, replyId);
    });
  }

  /** Wire to OneBotClient.onLateSendOutcome. Metadata only; never replays or resumes sends. */
  async handleLateOutcome(metadata: LateSendOutcome): Promise<void> { await this.confirm(metadata, true); }

  private normalizedOutcome(outcome: SendOutcome): SendOutcome {
    if (outcome.state === 'succeeded') {
      try {
        const messageId = normalizeMessageId(outcome.messageId);
        const token = this.options.readConfiguration().config.onebot.token;
        if (sanitizeSecrets(messageId, token ? [token] : []) !== messageId) throw new Error();
        return { state: 'succeeded', messageId };
      } catch { return { state: 'unknown' }; }
    }
    return { state: outcome.state === 'failed' ? 'failed' : 'unknown' };
  }

  private async confirm(metadata: LateSendOutcome, late: boolean): Promise<void> {
    const matches = Object.values(this.repository.read().segments).filter(segment =>
      segment.echo === metadata.echo && segment.connectionEpoch === metadata.connectionEpoch);
    if (matches.length !== 1) return; // BOTH exact identifiers required, never infer from a reply ID.
    const candidate = matches[0]!;
    if (!['sending', 'unknown', 'succeeded', 'failed'].includes(candidate.state)) return;
    const outcome = this.normalizedOutcome(metadata.outcome);
    const reply = this.reply(candidate.replyId);
    const apply = (draft: ControlState, allowExperience: boolean): void => {
      const segment = draft.segments[candidate.segmentId]!;
      if (segment.echo !== metadata.echo || segment.connectionEpoch !== metadata.connectionEpoch) return;
      if (!['sending', 'unknown', 'succeeded', 'failed'].includes(segment.state)) return;
      const liveReply = draft.replies[segment.replyId]!;
      const contentAuthorized = allowExperience && sameClosure(liveReply.provenance, reply.provenance)
        && sameClosure(segment.provenance, reply.provenance);
      const experience = segment.experienceTaskId === undefined ? undefined : draft.tasks[segment.experienceTaskId];
      // A duplicate audit must not destroy an already queued experience's only input merely
      // because the live configuration/binding changed. Preserve only a pre-existing body and
      // matching durable task; source/message revocation and forgetting still take precedence.
      const preserveConfirmedBody = segment.state === 'succeeded' && segment.text !== undefined
        && experience?.kind === 'experience' && experience.segmentId === segment.segmentId
        && experience.bankKey === liveReply.bankKey && experience.snapshotId === liveReply.snapshotId
        && experience.state !== 'cancelled' && sameClosure(experience.provenance, segment.provenance)
        && segment.provenance.sourceRefs.every(ref => {
          const source = draft.sources[ref.sourceId];
          return source?.allowed === true && !source.forgotten && source.sourceEpoch === ref.sourceEpoch
            && (draft.forgottenSources[ref.sourceId] ?? 0) < ref.sourceEpoch;
        })
        && segment.provenance.messageKeys.every(key => draft.messages[key]?.state === 'active' && !draft.forgottenMessages[key]);
      const confirmed = segment.state === 'succeeded' || segment.state === 'failed';
      if (confirmed) {
        // Initial uncertainty cannot overwrite a reliable confirmation, even when it arrived
        // while the durable state was still sending. Contradictions preserve the FIRST result.
        if (outcome.state !== 'unknown' && (outcome.state !== segment.state
          || (segment.state === 'succeeded' && outcome.messageId !== segment.qqMessageId))) {
          segment.errorCode = 'contradictory-send-confirmation';
        }
      } else {
        segment.state = outcome.state;
        if (outcome.state === 'succeeded') { segment.qqMessageId = outcome.messageId; delete segment.errorCode; }
        else segment.errorCode = outcome.state === 'failed' ? 'send-rejected' : 'send-outcome-unknown';
      }
      if (!contentAuthorized) {
        if (!preserveConfirmedBody) delete segment.text;
        // Keep contradiction evidence if present. No secret/provider-derived exception strings.
        segment.errorCode ??= 'experience-authorization-invalid';
      }
      if (contentAuthorized && outcome.state === 'succeeded' && segment.state === 'succeeded'
        && segment.qqMessageId === outcome.messageId && segment.text !== undefined
        && textHash(segment.text) === segment.bodyHash) {
        const snapshot = draft.snapshots[liveReply.snapshotId]!;
        const taskId = `experience-${fingerprint(segment.segmentId)}`;
        if (!draft.tasks[taskId]) {
          draft.tasks[taskId] = {
            taskId, kind: 'experience', bankKey: liveReply.bankKey, snapshotId: liveReply.snapshotId,
            segmentId: segment.segmentId, provenance: structuredClone(liveReply.provenance),
            routeFingerprint: fingerprint(snapshot.routes.retain), state: 'pending', stage: 'ingress_committed',
            retryCount: 0, nextRunAt: this.now(), leaseToken: 0, attemptCount: 0, attemptCalls: 0,
            checkpoint: {}, calls: 0, reservedTokens: 0, failureCodes: [],
          };
        }
        // Never replace an existing task: immutable route/snapshot and cumulative history survive.
        segment.experienceTaskId = taskId;
      }
      if (late || !contentAuthorized || outcome.state !== 'succeeded') cancelRemaining(draft, segment.replyId, 'send-stopped-no-replay');
      summarize(draft, segment.replyId);
    };
    let guard: ContentGuard | undefined;
    try { guard = await this.authorize(reply, false); this.repository.assertContentAllowed(guard); }
    catch (error) {
      if (error instanceof StorageError && !AUTHORIZATION_ERRORS.has(error.code)) throw error;
      // read() fails on storage/owner problems; never falsely report a successful fallback.
      this.repository.read();
      guard = undefined;
    }
    if (guard) {
      try { await this.repository.transact(guard, draft => apply(draft, true)); return; }
      catch (error) {
        if (!(error instanceof StorageError) || !AUTHORIZATION_ERRORS.has(error.code)) throw error;
      }
    }
    // Fallback never adds body/tasks. It may retain an existing confirmed task's still-valid
    // input, but newly confirmed invalidated content remains body-free audit metadata.
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => apply(draft, false));
  }
}
