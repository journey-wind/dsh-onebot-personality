import { parseConfig } from '../config.js';
import type { PluginConfig } from '../config.js';
import { fingerprint } from '../llm/routes.js';
import { ControlRepository } from '../storage/repository.js';
import type { SourceRecord } from '../storage/model.js';

export interface CurrentConfiguration { readonly config: PluginConfig; readonly revision: string }
export type ConfigurationReader = () => CurrentConfiguration;

export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';
  constructor(readonly code: string) { super(code); }
}

/** A binding change does not reassign old messages or move their bank. */
export function sourceStillAllowed(source: SourceRecord, config: PluginConfig): boolean {
  return (!config.onebot.expectedSelfId || source.botId === config.onebot.expectedSelfId)
    && config.personalities.some(persona => persona.id === source.personalityId)
    && (source.conversationType === 'group' ? config.allow.groupIds : config.allow.privateUserIds).includes(source.conversationId);
}

/** Config refs can change in the host before reconciliation. Every admission/send compares revisions. */
export class ConfigurationCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private auditFailed = false;
  constructor(private readonly repository: ControlRepository, private readonly readCurrent: ConfigurationReader) {}

  apply(current: CurrentConfiguration, revalidateInitial = false): Promise<void> {
    // Even an update superseded before its queued reconcile must keep the safety tightening it observed.
    const audit = this.observeWithdrawals(current);
    const next = this.tail.then(async () => { await audit; await this.reconcile(current, revalidateInitial); });
    this.tail = next.catch(() => {});
    return next;
  }

  /** Capture an OBSERVED safety tightening synchronously, before fencing can start teardown.
   * Only revokes the epochs present at observation; superseding config never cancels this audit or grants access. */
  observeWithdrawals(input: CurrentConfiguration): Promise<void> {
    let targets: Array<{ sourceId: string; throughEpoch: number }>;
    try {
      if (!input.revision) throw new Error();
      const config = parseConfig(input.config);
      targets = Object.values(this.repository.read().sources).filter(source => source.allowed && !sourceStillAllowed(source, config))
        .map(source => ({ sourceId: source.sourceId, throughEpoch: source.sourceEpoch }));
    } catch {
      this.auditFailed = true;
      return Promise.reject(new RuntimeError('configuration-withdrawal-audit-failed'));
    }
    const revision = input.revision;
    const next = this.tail.then(async () => {
      for (const target of targets) await this.repository.recordDeletion(
        `revoke:${fingerprint([revision, target.sourceId, target.throughEpoch])}`, { kind: 'source', ...target }, 'revoke');
    });
    this.tail = next.catch(() => { this.auditFailed = true; });
    return next;
  }

  /** Teardown must not release owner/domain handles while an observed withdrawal remains queued. */
  async drainObserved(): Promise<void> {
    let observed: Promise<void>;
    do { observed = this.tail; await observed; } while (observed !== this.tail);
    if (this.auditFailed) throw new RuntimeError('configuration-withdrawal-audit-failed');
  }

  private async reconcile(input: CurrentConfiguration, revalidateInitial: boolean): Promise<void> {
    const observed = this.readCurrent();
    if (!input.revision || observed.revision !== input.revision || observed.config !== input.config) throw new RuntimeError('superseded-config-update');
    const config = parseConfig(input.config);
    const state = this.repository.read();
    // A bootstrap-local revision label may be reused after process restart. Revalidate before any worker starts.
    if (!revalidateInitial && state.configRevision === input.revision) return;
    for (const source of Object.values(state.sources)) {
      if (source.allowed && !sourceStillAllowed(source, config)) {
        await this.repository.recordDeletion(`revoke:${fingerprint([input.revision, source.sourceId, source.sourceEpoch])}`,
          { kind: 'source', sourceId: source.sourceId, throughEpoch: source.sourceEpoch }, 'revoke');
      }
    }
    await this.repository.transact({ kind: 'metadata', fence: this.repository.fence }, draft => {
      const latest = this.readCurrent();
      if (latest.revision !== input.revision || latest.config !== input.config) throw new RuntimeError('superseded-config-update');
      if (draft.authEpoch >= Number.MAX_SAFE_INTEGER || draft.bindingRevision >= Number.MAX_SAFE_INTEGER) throw new RuntimeError('counter-overflow');
      draft.configRevision = input.revision;
      draft.authEpoch++;
      draft.bindingRevision++;
      for (const reply of Object.values(draft.replies)) {
        if (['completed', 'partial', 'unknown', 'failed', 'cancelled'].includes(reply.state)) continue;
        const segments = Object.values(draft.segments).filter(segment => segment.replyId === reply.replyId);
        for (const segment of segments) {
          if (segment.state === 'prepared') { segment.state = 'cancelled'; delete segment.text; }
          else if (segment.state === 'sending') segment.state = 'unknown';
        }
        reply.state = segments.some(segment => segment.state === 'unknown') ? 'unknown'
          : segments.some(segment => segment.state === 'succeeded') ? 'partial' : 'cancelled';
        reply.cancellationCode = 'configuration-changed';
      }
    });
  }
}
