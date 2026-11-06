import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as checkpoint } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { parseConfig } from '../src/config.js';
import { freezeDeep } from '../src/llm/routes.js';
import { openOwnedRuntime } from '../src/runtime/bootstrap.js';
import type { OwnedRuntime } from '../src/runtime/bootstrap.js';
import { ConfigurationCoordinator } from '../src/runtime/configuration.js';
import type { CurrentConfiguration } from '../src/runtime/configuration.js';
import { ConfigurationObservations } from '../src/runtime/observations.js';
import { HostController } from '../src/runtime/host.js';
import { configurationReader } from '../src/runtime/reference.js';
import { RuntimeSession } from '../src/runtime/session.js';
import { ControlRepository } from '../src/storage/repository.js';
import type { RuntimeTransport } from '../src/runtime/session.js';
import { runtimeFixture } from './helpers/runtime.js';
import { InMemoryKnowledge } from './helpers/knowledge.js';

function configuration(config: unknown, revision: string): CurrentConfiguration {
  return { config: freezeDeep(parseConfig(config)), revision };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Explicit scheduler edges plus one event-loop checkpoint; no retry/poll/busy loop or real server. */
class ManualSchedule {
  private sequence = 0;
  readonly pending = new Map<number, () => void>();
  schedule = (callback: () => void, _ms: number): (() => void) => {
    const id = ++this.sequence; this.pending.set(id, callback);
    return () => { this.pending.delete(id); };
  };
  async fire(): Promise<void> {
    const callbacks = [...this.pending.values()]; this.pending.clear();
    for (const callback of callbacks) callback();
    await checkpoint();
  }
}

async function fixture() {
  const f = await runtimeFixture();
  await f.admit({ message_id: 'A-history' });
  const old = Object.values(f.repository.read().messages)[0]!;
  // Only the supported public get() contract: frozen identity, no invented subscribe/version API.
  let snapshot = freezeDeep(parseConfig(f.current.config));
  const read = configurationReader({ get: () => snapshot });
  const observations = new ConfigurationObservations(); // Actual Controller pulls must populate this journal.
  const original = snapshot;
  const hostSchedule = new ManualSchedule();
  const workerSchedule = new ManualSchedule(); // Deliberately never fired: no worker/model/knowledge effects.
  const starts: Array<{ revision: string; oldAllowed: boolean; ledgerSequence: number }> = [];
  const sessions: RuntimeSession[] = [];
  const replacementStarted = deferred<void>();
  const openSession = async (observed: CurrentConfiguration, signal: AbortSignal,
    journal: ConfigurationObservations): Promise<OwnedRuntime> => {
    assert.equal(read(), observed, 'test opener cannot silently inherit a different immutable configuration');
    await journal.flush(f.repository, 'C:\\handoff-fixture\\owner.sqlite');
    let started = false; let disposed = false;
    const transport: RuntimeTransport = {
      get identity() { return undefined; },
      start() {
        started = true;
        starts.push({ revision: observed.revision, oldAllowed: f.repository.read().sources[old.sourceRef.sourceId]!.allowed,
          ledgerSequence: f.ledger.get().sequence });
      },
      dispose() { disposed = true; },
      getStatus: () => ({ state: disposed ? 'stopped' : started ? 'connecting' : 'disabled', reconnectAttempt: 0,
        pending: 0, lateOutcomes: 0, droppedFrames: 0 }),
      async getGroupMemberInfo() { throw new Error('handoff test must never request QQ membership'); },
      prepareTextSend() { throw new Error('handoff test must never send QQ messages'); },
    };
    const session = new RuntimeSession(f.repository, {
      async prepareCall() { throw new Error('handoff test must never call a model'); },
    }, new InMemoryKnowledge(), {
      readConfiguration: read, signal, isScopeLive: () => true,
      async resolveRoutes() { throw new Error('handoff test must never resolve a model route'); },
      availableDiskBytes: async () => 1_000_000_000_000,
      createTransport: () => transport, schedule: workerSchedule.schedule,
    });
    sessions.push(session);
    await session.start();
    replacementStarted.resolve();
    return { session, close: () => session.stop() };
  };
  return { f, old, read, observations, hostSchedule, starts, sessions, replacementStarted, openSession,
    withdraw() { snapshot = freezeDeep(parseConfig({ ...original, allow: { groupIds: [], privateUserIds: [] } })); return read(); },
    reallow() { snapshot = freezeDeep(parseConfig(original)); return read(); },
  };
}

test('counterexample control: rejecting a detached real factory is not a durable withdrawal audit', { timeout: 5_000 }, async () => {
  const f = await runtimeFixture(); await f.admit();
  const old = Object.values(f.repository.read().messages)[0]!;
  const a = configuration(f.current.config, 'detached-A');
  let current = configuration({ ...a.config, allow: { groupIds: [], privateUserIds: [] } }, 'detached-B');
  let observedB = false;
  const read = () => { observedB ||= current.revision === 'detached-B'; return current; };
  // Actual B pull, actual factory rejection, and real persisted A epoch. No root journal is handed off.
  await assert.rejects(openOwnedRuntime(new Context(), read, new AbortController().signal, () => true, undefined, a), /superseded-startup/);
  assert.equal(observedB, true);
  current = configuration(a.config, 'detached-C');
  await new ConfigurationCoordinator(f.repository, read).apply(current, true);
  assert.equal(f.ledger.get().sequence, 0, 'factory rejection alone never certified B as audited');
  assert.equal(f.repository.read().sources[old.sourceRef.sourceId]!.allowed, true);
  assert.equal(f.repository.read().messages[old.key]!.state, 'active');
});

// Acceptance regressions for ACTUALLY OBSERVED handoffs, not offline-history or real owner-lock certification.
test('observed B during actual factory pre-session rejection survives C before the next session starts', { timeout: 5_000 }, async t => {
  const f = await fixture();
  const factoryEntered = deferred<void>(); const permitFactoryRead = deferred<void>();
  const factoryFinished = deferred<void>(); let opens = 0;
  const controller = new HostController({ readConfiguration: f.read, isScopeLive: () => true,
    activationVerified: true, observations: f.observations, schedule: f.hostSchedule.schedule,
    open: async (observed, signal, journal) => {
      if (++opens !== 1) return f.openSession(observed, signal, journal);
      factoryEntered.resolve(); await permitFactoryRead.promise;
      // This is the real owned factory's expected/current comparison, before any resource/Session exists.
      // It must not access Context services in this deliberately superseded startup.
      try { return await openOwnedRuntime(new Context(), f.read, signal, () => true, undefined, observed, journal); }
      finally { factoryFinished.resolve(); }
    },
  });
  t.after(async () => { permitFactoryRead.resolve(); await controller.stop(); });
  controller.start(); await f.hostSchedule.fire(); await factoryEntered.promise;
  const b = f.withdraw();
  controller.getStatus(); // B is actually observed while HostController.active is absent.
  permitFactoryRead.resolve(); await factoryFinished.promise; await checkpoint();
  assert.equal(f.sessions.length, 0, 'the rejected native factory must not construct/start a session');
  assert.equal(f.read(), b);
  f.reallow(); await f.hostSchedule.fire(); await f.replacementStarted.promise; await checkpoint();
  assert.equal(controller.getStatus().state, 'running');
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0]!.oldAllowed, false, 'observed startup B must revoke A before C transport/workers start');
  assert.ok(f.f.ledger.get().entries.some(entry => entry.action === 'revoke' && entry.target.kind === 'source'
    && entry.target.sourceId === f.old.sourceRef.sourceId && entry.target.throughEpoch === f.old.sourceRef.sourceEpoch));
  assert.notEqual(f.f.repository.read().messages[f.old.key]!.state, 'active');
});

test('observed B after old repository teardown prevents owner release and any new C workers', { timeout: 5_000 }, async t => {
  const f = await fixture();
  const oldDomainsClosed = deferred<void>(); const permitRelease = deferred<void>();
  let ownerReleased = false; let opens = 0;
  const controller = new HostController({ readConfiguration: f.read, isScopeLive: () => true,
    activationVerified: true, observations: f.observations, schedule: f.hostSchedule.schedule,
    open: async (observed, signal, journal) => {
      const handle = await f.openSession(observed, signal, journal); opens++;
      let closing: Promise<void> | undefined;
      return { session: handle.session, close: () => closing ??= (async () => {
        await handle.session.stop();
        await journal.flush(f.f.repository, 'C:\\handoff-fixture\\owner.sqlite');
        // Match real Native domains.close(): actual repository stops BEFORE backend/owner release.
        await f.f.repository.close(); oldDomainsClosed.resolve(); await permitRelease.promise;
        journal.assertFlushed('C:\\handoff-fixture\\owner.sqlite'); // No await before the owner-release edge.
        ownerReleased = true;
      })() };
    },
  });
  t.after(async () => { permitRelease.resolve(); await controller.stop().catch(() => {}); });
  controller.start(); await f.hostSchedule.fire();
  assert.equal(controller.getStatus().state, 'running');
  f.reallow(); await f.hostSchedule.fire(); await oldDomainsClosed.promise;
  f.withdraw(); controller.getStatus(); await checkpoint();
  f.reallow(); controller.getStatus();
  permitRelease.resolve(); await checkpoint();
  assert.equal(controller.getStatus().state, 'blocked');
  assert.equal(ownerReleased, false, 'late unflushed B cannot be silently cleared at owner release');
  assert.equal(opens, 1); assert.equal(f.starts.length, 1);
  assert.ok(f.observations.getStatus().pending > 0);
  await assert.rejects(controller.stop(), /configuration-observations-pending/);

  // Recovery under the SAME still-held test owner may reopen domains, audit B, then start C safely.
  f.f.repository = await ControlRepository.open(f.f.control, f.f.ledger,
    { ownerId: 'same-still-held-owner', isHeld: () => true });
  await f.observations.flush(f.f.repository, 'C:\\handoff-fixture\\owner.sqlite');
  f.observations.assertFlushed('C:\\handoff-fixture\\owner.sqlite');
  const replacement = await f.openSession(f.read(), new AbortController().signal, f.observations);
  await replacement.close();
  assert.equal(f.starts.at(-1)!.oldAllowed, false);
  assert.notEqual(f.f.repository.read().messages[f.old.key]!.state, 'active');
});

test('journal deduplicates policy-equivalent model/credential changes without exporting configuration', { timeout: 5_000 }, () => {
  const journal = new ConfigurationObservations();
  const original = parseConfig({ onebot: { expectedSelfId: '100', token: 'SECRET_TOKEN' },
    allow: { groupIds: ['301', '300'], privateUserIds: ['200'] } });
  journal.observe(configuration(original, 'A'));
  const before = journal.getStatus();
  for (let i = 0; i < 100; i++) journal.observe(configuration({ ...original,
    onebot: { ...original.onebot, token: `SECRET_TOKEN_${i}`, wsUrl: 'ws://127.0.0.1:1/SECRET_URL' },
    allow: { groupIds: ['300', '301'], privateUserIds: ['200'] },
    models: { ...original.models, reply: { selection: 'explicit', provider: 'SECRET_PROVIDER', model: `SECRET_MODEL_${i}` } },
  }, `model-only-${i}`));
  assert.deepEqual(journal.getStatus(), before);
  assert.equal(before.observedPolicies, 1);
  assert.doesNotMatch(JSON.stringify(journal.getStatus()), /SECRET|expectedSelfId|groupIds|privateUserIds|revision/);
});

test('frozen repeated identities are no-ops but returning to original A after B remains a new policy transition', { timeout: 5_000 }, () => {
  const journal = new ConfigurationObservations();
  const a = configuration({ onebot: { expectedSelfId: '100', token: 'PRIVATE_A' }, allow: { groupIds: ['300'] } }, 'A');
  journal.observe(a); const before = journal.getStatus();
  for (let i = 0; i < 16; i++) journal.observe(a);
  assert.deepEqual(journal.getStatus(), before);
  const modelOnly = configuration({ ...a.config, onebot: { ...a.config.onebot, token: 'PRIVATE_NEW' } }, 'new-identity');
  journal.observe(modelOnly);
  for (let i = 0; i < 16; i++) journal.observe(modelOnly);
  assert.deepEqual(journal.getStatus(), before);
  journal.observe(configuration({ ...a.config, allow: { groupIds: [], privateUserIds: [] } }, 'B'));
  journal.observe(a); // Same original frozen object/revision, but NOT the immediately previous observation.
  assert.equal(journal.getStatus().observedPolicies, 3);
  assert.doesNotMatch(JSON.stringify(journal.getStatus()), /PRIVATE|token/);
});

test('same-object mutable or shallow-frozen nested policies are always reobserved before C', { timeout: 5_000 }, async () => {
  for (const shallowFrozen of [false, true]) {
    const f = await runtimeFixture(); await f.admit();
    const journal = new ConfigurationObservations();
    const config = parseConfig(f.current.config);
    if (shallowFrozen) Object.freeze(config); // The nested allowlist still changes; top-level freeze is insufficient.
    const current = { config, revision: 'same-object-and-revision' };
    journal.observe(current);
    config.allow.groupIds.splice(0); journal.observe(current);
    config.allow.groupIds.push('300'); journal.observe(current);
    assert.equal(journal.getStatus().observedPolicies, 3);
    await journal.flush(f.repository, 'C:\\mutable-fixture\\owner.sqlite');
    assert.ok(Object.values(f.repository.read().sources).every(source => !source.allowed));
  }
});

test('revision validation is never bypassed by the frozen identity cache', { timeout: 5_000 }, () => {
  const journal = new ConfigurationObservations(); const current = configuration({}, 'valid');
  journal.observe(current); journal.observe(current);
  assert.throws(() => journal.observe({ config: current.config, revision: '' }), /configuration-observations-invalid/);
  assert.equal(journal.getStatus().state, 'blocked');
  assert.throws(() => journal.observe(current), /configuration-observations-blocked/);
});

test('journal audits B before C, grants nothing, and per-store cursor never revokes a fresh C epoch twice', { timeout: 5_000 }, async () => {
  const f = await runtimeFixture(); await f.admit();
  const old = Object.values(f.repository.read().messages)[0]!;
  const original = f.current.config;
  const journal = new ConfigurationObservations();
  journal.observe(configuration(original, 'A'));
  journal.observe(configuration({ ...original, allow: { groupIds: [], privateUserIds: ['200'] } }, 'B'));
  journal.observe(configuration(original, 'C'));
  const beforeRevision = f.repository.read().configRevision;
  await journal.flush(f.repository, 'C:\\first-store\\owner.sqlite');
  journal.assertFlushed('C:\\first-store\\owner.sqlite');
  assert.equal(f.repository.read().configRevision, beforeRevision, 'observation-only flush never grants/applies C');
  assert.equal(f.repository.read().sources[old.sourceRef.sourceId]!.allowed, false);
  assert.notEqual(f.repository.read().messages[old.key]!.state, 'active');
  const ledgerSequence = f.ledger.get().sequence;
  await f.changeConfiguration(original); await f.admit({ message_id: 'new-C-epoch' });
  const fresh = Object.values(f.repository.read().messages).find(message => message.messageId === 'new-C-epoch')!;
  assert.ok(fresh.sourceRef.sourceEpoch > old.sourceRef.sourceEpoch);
  await journal.flush(f.repository, 'C:\\first-store\\owner.sqlite');
  assert.equal(f.ledger.get().sequence, ledgerSequence);
  assert.equal(f.repository.read().messages[fresh.key]!.state, 'active');
  const second = await runtimeFixture(); await second.admit({ message_id: 'other-store-A' });
  await journal.flush(second.repository, 'C:\\second-store\\owner.sqlite');
  assert.ok(Object.values(second.repository.read().sources).every(source => !source.allowed));
  assert.equal(journal.getStatus().trackedStores, 2);
});

test('journal drains policies observed while its real repository ledger write is awaiting ACK', { timeout: 5_000 }, async t => {
  const f = await runtimeFixture(); await f.admit();
  await f.admit({ message_type: 'private', user_id: '200', message_id: 'private-A' });
  const journal = new ConfigurationObservations();
  const original = f.current.config;
  journal.observe(configuration({ ...original, allow: { groupIds: [], privateUserIds: ['200'] } }, 'B-group'));
  const entered = deferred<void>(); const permit = deferred<void>();
  t.after(() => { permit.resolve(); });
  const set = f.ledger.set.bind(f.ledger); let calls = 0;
  f.ledger.set = async value => { if (++calls === 1) { entered.resolve(); await permit.promise; } await set(value); };
  const flushing = journal.flush(f.repository, 'C:\\awaiting-store\\owner.sqlite');
  await entered.promise;
  journal.observe(configuration({ ...original, allow: { groupIds: [], privateUserIds: [] } }, 'B-private'));
  journal.observe(configuration(original, 'C'));
  assert.throws(() => journal.assertFlushed('C:\\awaiting-store\\owner.sqlite'), /configuration-observations-pending/);
  permit.resolve(); await flushing;
  journal.assertFlushed('C:\\awaiting-store\\owner.sqlite');
  assert.equal(f.ledger.get().sequence, 2);
  assert.ok(Object.values(f.repository.read().messages).every(message => message.state !== 'active'));
  assert.equal(journal.getStatus().pending, 0);
});

test('journal policy-count overflow is permanent fail-closed without evicting unaudited B', { timeout: 5_000 }, async () => {
  const f = await runtimeFixture(); const journal = new ConfigurationObservations();
  for (let i = 0; i < 64; i++) journal.observe(configuration({ ...f.current.config,
    allow: { groupIds: [String(1000 + i)], privateUserIds: [] } }, `observed-${i}`));
  assert.equal(journal.getStatus().observedPolicies, 64);
  assert.throws(() => journal.observe(configuration(f.current.config, 'overflow-C')), /configuration-observations-overflow/);
  assert.equal(journal.getStatus().state, 'blocked');
  assert.equal(journal.getStatus().observedPolicies, 64);
  assert.throws(() => journal.observe(configuration(f.current.config, 'retry')), /configuration-observations-blocked/);
  await assert.rejects(journal.flush(f.repository, 'C:\\overflow-store\\owner.sqlite'), /configuration-observations-audit-failed/);
});

test('journal metadata-byte bound and distinct-store bound fail closed', { timeout: 5_000 }, async () => {
  const f = await runtimeFixture(); const bytes = new ConfigurationObservations();
  const privateUserIds = Array.from({ length: 10_000 }, (_, i) => `1${String(i).padStart(31, '0')}`);
  for (let i = 0; i < 2; i++) bytes.observe(configuration({ ...f.current.config,
    allow: { groupIds: [String(300 + i)], privateUserIds } }, `large-${i}`));
  assert.throws(() => bytes.observe(configuration({ ...f.current.config,
    allow: { groupIds: ['302'], privateUserIds } }, 'byte-overflow')), /configuration-observations-overflow/);
  assert.ok(bytes.getStatus().retainedBytes <= 1_048_576);
  assert.equal(bytes.getStatus().state, 'blocked');
  const stores = new ConfigurationObservations(); stores.observe(f.current);
  for (let i = 0; i < 8; i++) await stores.flush(f.repository, `C:\\store-${i}\\owner.sqlite`);
  await assert.rejects(stores.flush(f.repository, 'C:\\store-9\\owner.sqlite'), /configuration-observations-audit-failed/);
  assert.equal(stores.getStatus().state, 'blocked');
  assert.equal(stores.getStatus().trackedStores, 8);
});

test('journal failed ledger ACK never advances the cursor or clears unknown audit failure', { timeout: 5_000 }, async () => {
  const f = await runtimeFixture(); await f.admit(); const journal = new ConfigurationObservations();
  journal.observe(configuration({ ...f.current.config, allow: { groupIds: [], privateUserIds: [] } }, 'B'));
  f.ledger.failAtCommit = f.ledger.commits + 1;
  await assert.rejects(journal.flush(f.repository, 'C:\\fault-store\\owner.sqlite'), /configuration-observations-audit-failed/);
  assert.equal(journal.getStatus().state, 'blocked'); assert.equal(journal.getStatus().pending, 1);
  assert.throws(() => journal.assertFlushed('C:\\fault-store\\owner.sqlite'), /configuration-observations-blocked/);
});
