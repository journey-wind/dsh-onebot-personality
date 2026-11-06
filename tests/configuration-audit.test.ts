import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { ConfigurationCoordinator } from '../src/runtime/configuration.js';
import { runtimeFixture } from './helpers/runtime.js';

test('two observed withdrawals survive superseding config and revoke all captured epochs before granting C', async () => {
  const f = await runtimeFixture(); await f.admit({ message_id: 'group-before' });
  await f.admit({ message_type: 'private', user_id: '200', message_id: 'private-before' });
  const oldMessages = Object.values(f.repository.read().messages);
  let current = f.current; const coordinator = new ConfigurationCoordinator(f.repository, () => current);
  const original = current.config;
  const b = { config: parseConfig({ ...original, allow: { groupIds: [], privateUserIds: [] } }), revision: 'B' };
  const c = { config: parseConfig(original), revision: 'C' };
  current = b; const superseded = coordinator.apply(b); const rejected = assert.rejects(superseded, /superseded-config-update/);
  current = c; const latest = coordinator.apply(c, true);
  await rejected; await latest; await coordinator.drainObserved();
  assert.equal(f.repository.read().configRevision, 'C');
  for (const message of oldMessages) {
    assert.equal(f.repository.read().sources[message.sourceRef.sourceId]!.allowed, false);
    assert.notEqual(f.repository.read().messages[message.key]!.state, 'active');
    assert.ok(f.ledger.get().entries.some(entry => entry.action === 'revoke' && entry.target.kind === 'source'
      && entry.target.sourceId === message.sourceRef.sourceId && entry.target.throughEpoch === message.sourceRef.sourceEpoch));
  }
  await f.changeConfiguration(original); await f.admit({ message_id: 'new-after-C' });
  const fresh = Object.values(f.repository.read().messages).find(message => message.messageId === 'new-after-C')!;
  assert.ok(fresh.sourceRef.sourceEpoch > oldMessages.find(message => message.conversationType === 'group')!.sourceRef.sourceEpoch);
});

test('same revision label cannot authorize stale config identity or make observation-only audit grant permissions', async () => {
  const f = await runtimeFixture(); await f.admit();
  let current = f.current; const coordinator = new ConfigurationCoordinator(f.repository, () => current);
  const stale = current; current = { config: parseConfig(stale.config), revision: stale.revision };
  await assert.rejects(coordinator.apply(stale), /superseded-config-update/);
  const beforeRevision = f.repository.read().configRevision;
  await coordinator.observeWithdrawals({ config: parseConfig({ ...current.config, allow: { groupIds: [], privateUserIds: [] } }), revision: 'observed-only' });
  await coordinator.drainObserved();
  assert.equal(f.repository.read().configRevision, beforeRevision);
  assert.ok(Object.values(f.repository.read().sources).every(source => !source.allowed));
});
