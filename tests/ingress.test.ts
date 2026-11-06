import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture } from './helpers/runtime.js';

const text = (value: string) => [{ type: 'text', data: { text: value } }];

test('untriggered allowed group durably queues retain but creates no online job', async () => {
  const f = await runtimeFixture();
  const result = await f.admit();
  assert.equal(result.status, 'accepted');
  const state = f.repository.read();
  assert.equal(Object.keys(state.messages).length, 1);
  assert.equal(Object.keys(state.snapshots).length, 1);
  assert.equal(Object.keys(state.tasks).length, 1);
  assert.equal(Object.keys(state.replies).length, 0);
  assert.equal(Object.values(state.tasks)[0]!.stage, 'ingress_committed');
  // resolveRoutes only resolves host metadata; it is not an online chat-model call.
  assert.equal(f.routeCalls, 1);
});

test('private allowlist, current-persona text mention and exact verified bot at create reply jobs', async () => {
  const f = await runtimeFixture();
  await f.admit({ message: text('小忆 你好') });
  await f.admit({ message_id: '2', message: [{ type: 'at', data: { qq: '100' } }] });
  await f.admit({ message_id: '3', message_type: 'private', message: text('hello') });
  assert.equal(Object.keys(f.repository.read().replies).length, 3);
  await f.admit({ message_id: '4', message: [{ type: 'at', data: { qq: 'all' } }] });
  await f.admit({ message_id: '5', message: [{ type: 'image', data: { file: '小忆.png' } }] });
  assert.equal(Object.keys(f.repository.read().replies).length, 3);
});

test('outside allowlists and unverified identities are ignored before snapshots, routes or body writes', async () => {
  const f = await runtimeFixture();
  assert.deepEqual(await f.admit({ group_id: '301', message: text('PRIVATE_SECRET') }), { status: 'ignored', code: 'not-allowed' });
  assert.deepEqual(await f.admit({ message_type: 'private', user_id: '201' }), { status: 'ignored', code: 'not-allowed' });
  f.setIdentity(undefined);
  assert.deepEqual(await f.admit(), { status: 'ignored', code: 'unverified-identity' });
  assert.equal(f.routeCalls, 0);
  assert.equal(Object.keys(f.repository.read().messages).length, 0);
  assert.equal(JSON.stringify(f.control.value).includes('PRIVATE_SECRET'), false);
});

test('duplicate messages do not pay routes twice or create a second reply; conflicts preserve original and audit hashes only', async () => {
  const f = await runtimeFixture();
  const first = await f.admit({ message: text('小忆 你好') });
  assert.equal(first.status, 'accepted');
  const duplicate = await f.admit({ message: text('小忆 你好') });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(f.routeCalls, 1);
  await assert.rejects(f.admit({ message: text('CONFLICT_SECRET') }), /idempotency-conflict/);
  const state = f.repository.read();
  assert.equal(Object.keys(state.tasks).length, 1);
  assert.equal(Object.keys(state.replies).length, 1);
  assert.equal(Object.values(state.messages)[0]!.text, '小忆 你好');
  assert.equal(Object.values(state.ingressConflicts)[0]!.count, 1);
  assert.equal(JSON.stringify(state).includes('CONFLICT_SECRET'), false);
});

test('configured token is absent from retained text/JSON/snapshot and projection stays valid JSON', async () => {
  const f = await runtimeFixture({ onebot: { enabled: true, expectedSelfId: '100', token: 'gateway-credential' } });
  await f.admit({ message: text('小忆 gateway-credential token=third-party-secret') });
  const state = f.repository.read();
  assert.equal(JSON.stringify(state).includes('gateway-credential'), false);
  assert.equal(JSON.stringify(state).includes('third-party-secret'), false);
  assert.doesNotThrow(() => JSON.parse(Object.values(state.messages)[0]!.sanitizedEventJson!));
});

test('queue, inbox and disk limits fail before body admission and report known loss', async () => {
  const full = await runtimeFixture({ budgets: { maxPendingTasks: 1 } });
  await full.admit();
  await assert.rejects(full.admit({ message_id: '2' }), /retain-queue-full/);
  assert.equal(Object.keys(full.repository.read().messages).length, 1);
  assert.equal(full.ingress.getStatus().knownDropped, 1);
  assert.equal(full.ingress.getStatus().state, 'paused');
  const quota = await runtimeFixture({ budgets: { inboxMaxBytes: 1024 } });
  await assert.rejects(quota.admit({ message: text('x'.repeat(800)) }), /inbox-byte-quota/);
  assert.equal(Object.keys(quota.repository.read().messages).length, 0);
  const disk = await runtimeFixture();
  disk.setDiskProbe(async () => { throw new Error('secret disk details'); });
  await assert.rejects(disk.admit(), /disk-health-unobservable/);
  disk.setDiskProbe(async () => 0);
  await assert.rejects(disk.admit(), /disk-low/);
  assert.equal(Object.keys(disk.repository.read().tasks).length, 0);
});

test('final ingress commit failure leaves no message/snapshot/task/reply and blocks repository', async () => {
  const f = await runtimeFixture();
  f.control.failAtCommit = f.control.commits + 2; // source/bank metadata then the one body transaction.
  await assert.rejects(f.admit({ message: text('小忆 SECRET_INPUT') }), /ingress-failed/);
  assert.deepEqual(f.control.value.messages, {});
  assert.deepEqual(f.control.value.snapshots, {});
  assert.deepEqual(f.control.value.tasks, {});
  assert.deepEqual(f.control.value.replies, {});
  assert.equal(JSON.stringify(f.control.value).includes('SECRET_INPUT'), false);
  assert.equal(f.repository.getHealth().state, 'blocked');
});

test('configuration change during route resolution cancels admission without a body write', async () => {
  const f = await runtimeFixture();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setRouteHook(async () => { entered(); await gate; });
  const pending = f.admit({ message: text('SECRET_PENDING') });
  await started;
  const next = structuredClone(f.current.config);
  next.allow.groupIds = [];
  await f.changeConfiguration(next);
  release();
  await assert.rejects(pending, /admission-configuration-changed/);
  assert.equal(Object.keys(f.repository.read().messages).length, 0);
  assert.equal(JSON.stringify(f.control.value).includes('SECRET_PENDING'), false);
});

test('source reallow opens a new epoch and never revives quarantined old messages/tasks', async () => {
  const f = await runtimeFixture();
  await f.admit();
  const oldMessage = Object.values(f.repository.read().messages)[0]!;
  const next = structuredClone(f.current.config);
  next.allow.groupIds = [];
  await f.changeConfiguration(next);
  assert.equal(f.repository.read().messages[oldMessage.key]!.state, 'quarantined');
  assert.equal(Object.values(f.repository.read().tasks)[0]!.state, 'cancelled');
  const back = structuredClone(f.current.config);
  back.allow.groupIds = ['300'];
  await f.changeConfiguration(back);
  await f.admit({ message_id: '2' });
  const fresh = Object.values(f.repository.read().messages).find(message => message.messageId === '2')!;
  assert.equal(fresh.sourceRef.sourceId, oldMessage.sourceRef.sourceId);
  assert.ok(fresh.sourceRef.sourceEpoch > oldMessage.sourceRef.sourceEpoch);
  assert.equal(f.repository.read().messages[oldMessage.key]!.state, 'quarantined');
});

test('binding switch changes new persona but not old message ownership; old pending reply is cancelled', async () => {
  const f = await runtimeFixture();
  await f.admit({ message: text('小忆 你好') });
  const next = structuredClone(f.current.config);
  const original = next.personalities[0]!;
  next.personalities.push({ ...structuredClone(original), id: 'other', name: '小月', aliases: [] });
  next.bindings.groups = [{ id: '300', personalityId: 'other' }];
  await f.changeConfiguration(next);
  await f.admit({ message_id: '2', message: text('小月 你好') });
  const messages = Object.values(f.repository.read().messages).sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(messages.map(message => message.personalityId), ['assistant-main', 'other']);
  assert.equal(Object.values(f.repository.read().replies).filter(reply => reply.state === 'cancelled').length, 1);
  assert.equal(Object.keys(f.repository.read().banks).length, 2);
});
