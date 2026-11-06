import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { HostController } from '../src/runtime/host.js';
import type { CurrentConfiguration } from '../src/runtime/configuration.js';
import type { OwnedRuntime } from '../src/runtime/bootstrap.js';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function fixture(enabled = true, verified = true) {
  let revision = 1; let now = 0; let scope = true;
  let current: CurrentConfiguration = { config: parseConfig({ onebot: { enabled, expectedSelfId: '100' } }), revision: '1' };
  const timers = new Map<number, { at: number; callback: () => void }>(); let id = 0;
  const log: string[] = []; const signals: AbortSignal[] = [];
  let opener: ((observed: CurrentConfiguration, signal: AbortSignal) => Promise<OwnedRuntime>) | undefined;
  const handle = (label: string, closeFailure = false): OwnedRuntime => {
    let stopped = false; let closed = false;
    // Only the public lifecycle/metadata port is exercised here. No fake native storage proof is asserted.
    return { session: {
      observeConfiguration: (observed: CurrentConfiguration) => { log.push(`observe:${observed.revision}`); },
      stop: async () => { if (!stopped) { stopped = true; log.push(`stop:${label}`); } },
      getStatus: () => ({ phase: stopped ? 'stopped' : 'running' }),
      retryRetain: async (taskId: string) => { log.push(`retry:${taskId}`); },
      forgetBySource: async () => ({ state: 'blocked', logicallyBlocked: true }),
      forgetByAuthor: async () => ({ state: 'blocked', logicallyBlocked: true }),
      getForgetStatus: () => ({ state: 'blocked', logicallyBlocked: true }),
    }, close: async () => {
      if (closeFailure) throw new Error('PRIVATE_CLOSE_DETAILS');
      if (!closed) { closed = true; log.push(`close:${label}`); }
    } } as unknown as OwnedRuntime;
  };
  const controller = new HostController({ readConfiguration: () => current, isScopeLive: () => scope,
    activationVerified: verified, open: async (observed, signal) => {
      log.push(`open:${observed.revision}`); signals.push(signal);
      return opener ? opener(observed, signal) : handle(observed.revision);
    }, schedule: (callback, ms) => { const key = ++id; timers.set(key, { at: now + ms, callback }); return () => { timers.delete(key); }; } });
  return { controller, log, signals, timers, handle,
    setOpen(next: typeof opener) { opener = next; },
    update(nextEnabled = true) { current = { config: parseConfig({ ...structuredClone(current.config), onebot: { ...current.config.onebot, enabled: nextEnabled } }), revision: `${++revision}` }; },
    unload() { scope = false; },
    async tick(ms = 250) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); } await flush(); },
  };
}

test('unverified hold creates no timer/resource; status is read-only even after enabling', async () => {
  const f = fixture(false, false); f.controller.start();
  assert.equal(f.controller.getStatus().state, 'disabled'); f.update(true);
  assert.equal(f.controller.getStatus().state, 'blocked'); assert.deepEqual([...f.log], []); assert.equal(f.timers.size, 0);
  await f.controller.stop();
});
test('disabled verified controller observes metadata only, never opens runtime resources', async () => {
  const f = fixture(false); f.controller.start(); await f.tick(0);
  assert.equal(f.controller.getStatus().state, 'disabled'); assert.deepEqual([...f.log], []);
  await f.controller.stop(); assert.equal(f.timers.size, 0);
});
test('configuration replacement fences immediately when observed and closes old handle before opening a new owner', async () => {
  const f = fixture(); f.controller.start(); assert.deepEqual([...f.log], []); await f.tick(0);
  assert.equal(f.controller.getStatus().state, 'running');
  f.update(); assert.equal(f.controller.getStatus().state, 'starting');
  assert.equal(f.signals[0]!.aborted, true); assert.ok(f.log.includes('stop:1'));
  await f.tick(); assert.ok(f.log.indexOf('close:1') < f.log.indexOf('open:2'));
  assert.equal(f.controller.getStatus().state, 'running'); await f.controller.stop(); assert.equal(f.timers.size, 0);
});
test('late startup handle closes before replacement starts and cannot inherit a newer configuration', async () => {
  const f = fixture(); const old = deferred<OwnedRuntime>();
  f.setOpen(observed => observed.revision === '1' ? old.promise : Promise.resolve(f.handle(observed.revision)));
  f.controller.start(); await f.tick(0); f.update(); await f.tick();
  assert.equal(f.signals[0]!.aborted, true); old.resolve(f.handle('late-1')); await flush();
  assert.ok(f.log.indexOf('close:late-1') < f.log.indexOf('open:2'));
  assert.equal(f.controller.getStatus().state, 'running'); await f.controller.stop();
});
test('scope invalidation fences before disposer completion; stop drains late local acquisition and clears its timer', async () => {
  const f = fixture(); const pending = deferred<OwnedRuntime>(); f.setOpen(() => pending.promise);
  f.controller.start(); await f.tick(0); f.unload();
  assert.equal(f.controller.getStatus().state, 'stopped'); assert.equal(f.signals[0]!.aborted, true);
  const stopping = f.controller.stop(); pending.resolve(f.handle('late')); await stopping;
  assert.ok(f.log.includes('close:late')); assert.equal(f.timers.size, 0);
});
test('uncertain old-runtime teardown blocks replacement instead of opening another owner', async () => {
  const f = fixture(); f.setOpen(async observed => f.handle(observed.revision, true));
  f.controller.start(); await f.tick(0); f.update(); await f.tick();
  assert.deepEqual(f.log.filter(value => value.startsWith('open:')), ['open:1']);
  assert.equal(f.controller.getStatus().state, 'blocked');
  assert.equal(JSON.stringify(f.controller.getStatus()).includes('PRIVATE_CLOSE_DETAILS'), false);
  await assert.rejects(f.controller.stop());
});
test('startup failure is fixed metadata, has no busy retry, and admin actions cannot bypass inactive state', async () => {
  const f = fixture(); f.setOpen(async () => { throw new Error('TOKEN_AND_PRIVATE_BODY'); });
  f.controller.start(); await f.tick(0); await f.tick();
  assert.equal(f.controller.getStatus().state, 'blocked'); assert.equal(f.log.length, 1);
  assert.equal(JSON.stringify(f.controller.getStatus()).includes('TOKEN_AND_PRIVATE_BODY'), false);
  await assert.rejects(f.controller.retryRetain('x'), /host-runtime-not-active/); await f.controller.stop();
});
