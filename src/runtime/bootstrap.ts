import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { statfs } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-storage';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from 'dsh-knowledge/knowledge';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { resolveFiveRoutes } from '../llm/routes.js';
import { CONTROL_DOMAIN, LEDGER_DOMAIN, openDomains } from '../storage/domains.js';
import { OwnerLock } from '../storage/owner.js';
import { OwnedSqliteBackend } from '../storage/sqlite.js';
import type { ConfigurationReader, CurrentConfiguration } from './configuration.js';
import { RuntimeError } from './configuration.js';
import { RuntimeSession } from './session.js';
import type { ProviderQuota } from './quota.js';
import { ConfigurationObservations } from './observations.js';

/** Pinned SDK/native/fault/isolation verification is complete for this release path.
 * This does NOT authorize real QQ/model calls: configuration stays disabled by default,
 * with explicit identity/allowlists/private-directory and registered-model checks at startup. */
export const ACTIVATION_VERIFIED = true;
// A rejected startup has no returned handle to retain its owner. Keep uncertain owners strongly held;
// GC must never silently unlock a quarantined store. No force-unlock/clear switch is exposed.
const quarantinedOwners = new Map<string, OwnerLock>();
function retainOwner(owner: OwnerLock | undefined): void { if (owner) quarantinedOwners.set(owner.canonicalPath, owner); }
export interface OwnedRuntime {
  readonly session: RuntimeSession;
  /** Synchronous fence followed by ordered close. Never closes any injected Host service. */
  close(): Promise<void>;
}

/** Resource factory for the future Host lifecycle binding. Caller must register a synchronous disposer
 * BEFORE invoking this async function; abort it on unload and call close on any late returned handle.
 * No shared storage-domain routing is changed and no shared Host/knowledge database is opened. */
export async function openOwnedRuntime(ctx: Context, readConfiguration: ConfigurationReader,
  signal: AbortSignal, isScopeLive: () => boolean, providerQuota?: ProviderQuota, expected?: CurrentConfiguration,
  observations = new ConfigurationObservations()): Promise<OwnedRuntime> {
  const pull = () => { const current = readConfiguration(); observations.observe(current); return current; };
  const initial = pull();
  if (expected && (initial.config !== expected.config || initial.revision !== expected.revision)) throw new RuntimeError('superseded-startup');
  const config = initial.config;
  if (!config.onebot.enabled) throw new RuntimeError('runtime-disabled');
  if (!config.persistence.directory || !isAbsolute(config.persistence.directory)) throw new RuntimeError('private-state-directory-required');
  if (!config.persistence.privateDirectoryReady) throw new RuntimeError('private-directory-precondition-unverified');
  const root = new AbortController();
  let owner: OwnerLock | undefined; let backend: OwnedSqliteBackend | undefined;
  let facility: DomainFacility | undefined; let unregister: (() => void) | undefined;
  let domains: Awaited<ReturnType<typeof openDomains>> | undefined; let session: RuntimeSession | undefined;
  let closing: Promise<void> | undefined;
  const live = (): boolean => {
    try {
      const current = pull();
      return !signal.aborted && !root.signal.aborted && isScopeLive()
        && current.config === initial.config && current.revision === initial.revision;
    } catch { return false; }
  };
  const check = () => { if (!live()) throw new RuntimeError('runtime-startup-cancelled'); };
  const abort = () => { root.abort(); if (session) void session.stop().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const close = (): Promise<void> => {
    abort();
    if (closing) return closing;
    closing = (async () => {
      let failed = false; let auditFailed = false;
      try { await session?.stop(); } catch (error) {
        failed = true; auditFailed = error instanceof RuntimeError && error.code === 'configuration-withdrawal-audit-failed';
      }
      // Metadata cleanup is allowed after fencing. No policy observation may vanish at a handoff.
      try { pull(); } catch { auditFailed = true; }
      if (domains && owner) {
        try { await observations.flush(domains.repository, owner.canonicalPath); }
        catch { auditFailed = true; }
      }
      try { await domains?.close(); } catch { failed = true; }
      try { await facility?.closeAll(); } catch { failed = true; }
      try { unregister?.(); unregister = undefined; } catch { failed = true; }
      // A backend-close error does NOT certify that all writers/handles are drained. Keep owner held.
      try { await backend?.close(); }
      catch { retainOwner(owner); throw new RuntimeError('owned-storage-close-incomplete-owner-held'); }
      // No await between this generation check and invoking owner.close(). An observation after
      // repository.close() cannot be audited there; keep the owner rather than certifying release.
      if (domains && owner) {
        try { observations.assertFlushed(owner.canonicalPath); } catch { auditFailed = true; }
      }
      if (auditFailed) { retainOwner(owner); throw new RuntimeError('withdrawal-audit-incomplete-owner-held'); }
      try { await owner?.close(); } catch { failed = true; }
      signal.removeEventListener('abort', abort);
      if (failed) throw new RuntimeError('owned-runtime-shutdown-incomplete');
    })();
    return closing;
  };
  try {
    check();
    owner = await OwnerLock.acquire(join(config.persistence.directory, 'owner.sqlite')); check();
    const directory = dirname(owner.canonicalPath);
    backend = new OwnedSqliteBackend(directory, owner); check();
    const backendId = `onebot_personality_${randomUUID().replaceAll('-', '_')}`;
    unregister = ctx.storage.backend.register(backendId, backend);
    facility = new DomainFacility(ctx, { backend: backendId, routes: { [CONTROL_DOMAIN]: backendId, [LEDGER_DOMAIN]: backendId } });
    domains = await openDomains(facility, owner, live); check();
    await observations.flush(domains.repository, owner.canonicalPath); check();
    session = new RuntimeSession(domains.repository, ctx.llm, ctx.knowledge, {
      readConfiguration: () => {
        const current = pull();
        // Do not construct a C session on storage selected by a superseded A startup.
        if (!session && (current.config !== initial.config || current.revision !== initial.revision)) throw new RuntimeError('superseded-startup');
        return current;
      }, signal: root.signal, isScopeLive, ...(providerQuota ? { providerQuota } : {}),
      resolveRoutes: (current, persona, callSignal) => resolveFiveRoutes(ctx.llm, current, persona, ctx.agentDefaultModel.currentSelection(), callSignal),
      availableDiskBytes: async () => {
        check(); const stats = await statfs(directory, { bigint: true }); check();
        const bytes = stats.bavail * stats.bsize;
        if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new RuntimeError('disk-health-unobservable');
        return Number(bytes);
      },
    });
    await session.start(); check();
    return { session, close };
  } catch {
    try { await close(); } catch { throw new RuntimeError('owned-runtime-startup-cleanup-incomplete'); }
    throw new RuntimeError('owned-runtime-startup-failed');
  }
}
