import assert from 'node:assert/strict';
import test from 'node:test';
import type { OneBotClient, PreparedSend, ReadyIdentity, SendOutcome } from '../src/onebot/client.js';
import type { Provenance, ReplyRecord } from '../src/storage/model.js';
import type { ContentGuard } from '../src/storage/repository.js';
import { fingerprint } from '../src/llm/routes.js';
import { Outbox } from '../src/runtime/outbox.js';
import { runtimeFixture } from './helpers/runtime.js';

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
interface Attempt { type: 'group' | 'private'; targetId: string; text: string; echo: string; connectionEpoch: string }
class FakeTransport implements Pick<OneBotClient, 'identity' | 'prepareTextSend'> {
  identity: ReadyIdentity | undefined = { selfId: '100', connectionEpoch: 'epoch-1' };
  readonly prepared: Attempt[] = [];
  readonly submitted: Attempt[] = [];
  onSubmit: (attempt: Attempt) => Promise<SendOutcome> = async () => ({ state: 'succeeded', messageId: String(this.submitted.length) });
  constructor(private readonly fixture: Fixture) {}
  prepareTextSend(type: 'group' | 'private', targetId: string, text: string): PreparedSend {
    if (!this.identity) throw new Error('fake-not-ready');
    const attempt = { type, targetId, text, echo: `echo-${this.prepared.length + 1}`, connectionEpoch: this.identity.connectionEpoch };
    this.prepared.push(attempt);
    return { echo: attempt.echo, connectionEpoch: attempt.connectionEpoch, submit: () => {
      // The network entry must observe a DURABLY stored intent and exact transport correlation.
      const persisted = Object.values(this.fixture.control.get().segments).find(segment => segment.echo === attempt.echo);
      assert.ok(persisted);
      assert.equal(persisted.state, 'sending');
      assert.equal(persisted.connectionEpoch, attempt.connectionEpoch);
      const preceding = Object.values(this.fixture.control.get().segments).filter(segment =>
        segment.replyId === persisted.replyId && segment.index < persisted.index);
      assert.ok(preceding.every(segment => segment.state === 'succeeded'));
      this.submitted.push(attempt);
      return this.onSubmit(attempt);
    } };
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(input: Record<string, unknown> = {}) {
  const fixture = await runtimeFixture(input);
  const admitted = await fixture.admit({ message: [{ type: 'text', data: { text: '小忆 please answer' } }] });
  if (admitted.status !== 'accepted' || !admitted.replyId) throw new Error('expected reply admission');
  const replyId = admitted.replyId;
  const transport = new FakeTransport(fixture);
  const authorizationCalls: { reply: ReplyRecord; force: boolean }[] = [];
  let live = true;
  let hook: (reply: ReplyRecord, force: boolean) => Promise<void> = async () => {};
  const outbox = new Outbox(fixture.repository, transport, {
    readConfiguration: () => fixture.current, now: () => fixture.now,
    authorizeReply: async (reply, force): Promise<ContentGuard> => {
      authorizationCalls.push({ reply: structuredClone(reply), force });
      await hook(reply, force);
      if (!live) throw new Error('untrusted secret details must never be persisted');
      const bank = fixture.repository.read().banks[reply.bankKey]!;
      return { kind: 'content', fence: fixture.repository.fence, botId: bank.botId, personalityId: bank.personalityId,
        provenance: structuredClone(reply.provenance), validateLive: () => live };
    },
  });
  const provenance = structuredClone(fixture.repository.read().replies[replyId]!.provenance);
  return { fixture, outbox, transport, replyId, provenance, authorizationCalls,
    setLive(value: boolean) { live = value; },
    setAuthorizationHook(next: typeof hook) { hook = next; },
    segments() { return Object.values(fixture.repository.read().segments).filter(segment => segment.replyId === replyId).sort((a, b) => a.index - b.index); },
    experience() { return Object.values(fixture.repository.read().tasks).filter(task => task.kind === 'experience'); },
  };
}

// Authored deterministic unit tests only. No real socket, model, HTTP or storageDomain calls.
test('long Unicode output is complete, ordered and freshly authorized per segment', async () => {
  const s = await setup({ budgets: { sendCodePoints: 4 } });
  const text = '甲😀乙丙丁戊己庚辛壬癸';
  await s.outbox.prepare(s.replyId, text, s.provenance);
  assert.equal(s.transport.submitted.length, 0);
  const result = await s.outbox.send(s.replyId);
  assert.equal(result.state, 'completed');
  assert.equal(s.transport.submitted.map(send => send.text).join(''), text);
  assert.ok(s.transport.submitted.every(send => [...send.text].length <= 4));
  assert.equal(s.authorizationCalls.filter(call => call.force).length, s.segments().length);
  assert.ok(s.transport.submitted.every(send => send.type === 'group' && send.targetId === '300'));
  assert.equal(s.experience().length, s.segments().length);
  assert.ok(s.segments().every(segment => segment.state === 'succeeded' && segment.qqMessageId && segment.experienceTaskId));
  assert.ok(s.transport.submitted.every(send => !s.transport.prepared.slice(0, s.segments().length).includes(send)));
});

test('CQ-looking output is literal text, never parsed as an action', async () => {
  const s = await setup();
  const text = '[CQ:at,qq=all][CQ:image,file=https://example.invalid/payload] &amp;';
  await s.outbox.prepare(s.replyId, text, s.provenance);
  await s.outbox.send(s.replyId);
  assert.equal(s.transport.submitted.length, 1);
  assert.equal(s.transport.submitted[0]!.text, text);
});

test('total overflow and later action-envelope overflow submit zero segments', async () => {
  const s = await setup({ budgets: { sendCodePoints: 3, sendMaxSegments: 2 } });
  await assert.rejects(s.outbox.prepare(s.replyId, '1234567', s.provenance), /outgoing-validation-failed/);
  assert.equal(s.segments().length, 0);
  await s.outbox.send(s.replyId);
  assert.equal(s.transport.submitted.length, 0);
  const other = await setup({ budgets: { sendCodePoints: 3 } });
  const prepare = other.transport.prepareTextSend.bind(other.transport);
  other.transport.prepareTextSend = (type, target, text) => {
    if (other.transport.prepared.length === 1) throw new Error('fake entire envelope over cap');
    return prepare(type, target, text);
  };
  await assert.rejects(other.outbox.prepare(other.replyId, '123456', other.provenance), /outgoing-validation-failed/);
  assert.equal(other.segments().length, 0);
  assert.equal(other.transport.submitted.length, 0);
});

test('prepare authorizes and persists full supplied provenance, not old minimal input', async () => {
  const s = await setup({ allow: { groupIds: ['300', '400'], privateUserIds: ['200'] } });
  const extra = await s.fixture.admit({ group_id: '400', message_id: '2' });
  if (extra.status !== 'accepted') throw new Error('expected second source');
  const message = s.fixture.repository.read().messages[extra.messageKey]!;
  const full: Provenance = { complete: true, sourceRefs: [...s.provenance.sourceRefs, message.sourceRef],
    messageKeys: [...s.provenance.messageKeys, message.key], dependencyVersions: [] };
  s.setAuthorizationHook(async reply => {
    // A trusted policy may canonicalize set ordering without changing its capability.
    reply.provenance.sourceRefs.reverse(); reply.provenance.messageKeys.reverse();
  });
  await s.outbox.prepare(s.replyId, 'derived from both conversations', full);
  assert.deepEqual(s.authorizationCalls[0]!.reply.provenance, full);
  assert.deepEqual(s.fixture.repository.read().replies[s.replyId]!.provenance, full);
  assert.deepEqual(s.segments()[0]!.provenance, full);
  await s.outbox.send(s.replyId);
  assert.deepEqual(s.experience()[0]!.provenance, full);
  const missingOriginal: Provenance = { complete: true, sourceRefs: [message.sourceRef], messageKeys: [message.key], dependencyVersions: [] };
  const next = await setup();
  await assert.rejects(next.outbox.prepare(next.replyId, 'not allowed', missingOriginal), /incomplete-reply-provenance/);
  assert.equal(next.segments().length, 0);
});

for (const action of ['revoke', 'forget'] as const) {
  test(`${action} between segments stops the rest without erasing confirmed delivery`, async () => {
    const s = await setup({ budgets: { sendCodePoints: 4 } });
    await s.outbox.prepare(s.replyId, 'AAAABBBBCCCC', s.provenance);
    let queries = 0;
    s.setAuthorizationHook(async (_reply, force) => {
      if (!force || ++queries !== 2) return;
      const ref = s.provenance.sourceRefs[0]!;
      await s.fixture.repository.recordDeletion(`between-${action}`, { kind: 'source', sourceId: ref.sourceId, throughEpoch: ref.sourceEpoch }, action, s.fixture.now);
    });
    const result = await s.outbox.send(s.replyId);
    assert.equal(s.transport.submitted.length, 1);
    assert.equal(s.segments()[0]!.state, 'succeeded');
    assert.ok(s.segments().slice(1).every(segment => segment.state === 'cancelled'));
    assert.equal(result.state, 'partial');
    assert.equal(s.experience().length, 1); // The already-confirmed experience was subsequently cancelled by the ledger.
    assert.equal(s.experience()[0]!.state, 'cancelled');
    if (action === 'forget') assert.ok(s.segments().every(segment => segment.text === undefined));
    await s.outbox.send(s.replyId);
    assert.equal(s.transport.submitted.length, 1);
  });
}

test('revocation during fresh membership authorization prevents the first submit', async () => {
  const s = await setup();
  await s.outbox.prepare(s.replyId, 'never submit', s.provenance);
  s.setAuthorizationHook(async (_reply, force) => {
    if (force) s.setLive(false);
  });
  const result = await s.outbox.send(s.replyId);
  assert.equal(result.state, 'cancelled');
  assert.equal(s.transport.submitted.length, 0);
  assert.equal(s.experience().length, 0);
});

test('final live check after durable intent rejects invalidation before synchronous submit', async () => {
  const s = await setup();
  await s.outbox.prepare(s.replyId, 'never enter the socket', s.provenance);
  const set = s.fixture.control.set.bind(s.fixture.control);
  s.fixture.control.set = async value => {
    await set(value);
    if (Object.values(value.segments).some(segment => segment.state === 'sending')) s.setLive(false);
  };
  await s.outbox.send(s.replyId);
  assert.equal(s.transport.submitted.length, 0);
  assert.equal(s.segments()[0]!.state, 'unknown'); // Durable intent is conservatively potentially submitted.
  assert.equal(s.experience().length, 0);
});

test('authorization barrier releases before network completion; in-flight forget wins content writes', { timeout: 2000 }, async () => {
  const s = await setup({ budgets: { sendCodePoints: 4 } });
  await s.outbox.prepare(s.replyId, 'AAAABBBB', s.provenance);
  const entered = deferred<void>();
  const network = deferred<SendOutcome>();
  s.transport.onSubmit = () => { entered.resolve(); return network.promise; };
  const sending = s.outbox.send(s.replyId);
  await entered.promise;
  await s.fixture.repository.recordDeletion('in-flight-forget', { kind: 'messages', messageKeys: s.provenance.messageKeys }, 'forget', s.fixture.now);
  assert.equal(s.segments()[0]!.state, 'unknown');
  network.resolve({ state: 'succeeded', messageId: 'confirmed-after-forget' });
  await sending;
  assert.equal(s.segments()[0]!.state, 'succeeded');
  assert.equal(s.segments()[0]!.qqMessageId, 'confirmed-after-forget');
  assert.ok(s.segments().every(segment => segment.text === undefined));
  assert.equal(s.experience().length, 0);
  assert.equal(s.transport.submitted.length, 1);
});

test('timeout is unknown, stops following segments, never retries or resumes after late success', async () => {
  const s = await setup({ budgets: { sendCodePoints: 4 } });
  await s.outbox.prepare(s.replyId, 'AAAABBBB', s.provenance);
  s.transport.onSubmit = async () => ({ state: 'unknown', code: 'TIMEOUT' });
  await s.outbox.send(s.replyId);
  assert.equal(s.segments()[0]!.state, 'unknown');
  assert.equal(s.segments()[1]!.state, 'cancelled');
  assert.equal(s.experience().length, 0);
  const sent = s.transport.submitted[0]!;
  s.transport.identity = { selfId: '100', connectionEpoch: 'epoch-reconnected' };
  await s.outbox.send(s.replyId);
  assert.equal(s.transport.submitted.length, 1);
  s.fixture.advance(130_000); // Delivery confirmation is valid after the online deadline.
  await s.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: sent.connectionEpoch, outcome: { state: 'succeeded', messageId: 'late-1' } });
  assert.equal(s.segments()[0]!.state, 'succeeded');
  assert.equal(s.experience().length, 1);
  await s.outbox.send(s.replyId);
  assert.equal(s.transport.submitted.length, 1);
});

test('late success while durable state is sending cannot be overwritten by queued initial unknown', async () => {
  const s = await setup({ budgets: { sendCodePoints: 4 } });
  await s.outbox.prepare(s.replyId, 'AAAABBBB', s.provenance);
  s.transport.onSubmit = attempt => s.outbox.handleLateOutcome({ echo: attempt.echo, connectionEpoch: attempt.connectionEpoch,
    outcome: { state: 'succeeded', messageId: 'first-confirmation' } }).then(() => ({ state: 'unknown', code: 'TIMEOUT' }));
  await s.outbox.send(s.replyId);
  assert.equal(s.segments()[0]!.state, 'succeeded');
  assert.equal(s.segments()[0]!.qqMessageId, 'first-confirmation');
  assert.equal(s.segments()[1]!.state, 'cancelled');
  assert.equal(s.transport.submitted.length, 1);
  assert.equal(s.experience().length, 1);
});

test('only confirmed success creates unique experience with original retain snapshot and untouched histories', async () => {
  const s = await setup();
  await s.outbox.prepare(s.replyId, 'confirmed', s.provenance);
  await s.outbox.send(s.replyId);
  const task = s.experience()[0]!;
  const reply = s.fixture.repository.read().replies[s.replyId]!;
  const snapshot = s.fixture.repository.read().snapshots[reply.snapshotId]!;
  assert.equal(task.snapshotId, reply.snapshotId);
  assert.equal(task.routeFingerprint, fingerprint(snapshot.routes.retain));
  assert.deepEqual([task.leaseToken, task.attemptCount, task.attemptCalls, task.calls, task.reservedTokens, task.retryCount], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(task.provenance, reply.provenance);
  await s.fixture.repository.transact({ kind: 'metadata', fence: s.fixture.repository.fence }, draft => {
    Object.assign(draft.tasks[task.taskId]!, { leaseToken: 3, attemptCount: 4, attemptCalls: 1,
      calls: 7, reservedTokens: 9000, retryCount: 2, failureCodes: ['previous-failure'] });
  });
  const history = structuredClone(s.experience()[0]);
  const sent = s.transport.submitted[0]!;
  await s.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: sent.connectionEpoch, outcome: { state: 'succeeded', messageId: '1' } });
  assert.equal(s.experience().length, 1);
  assert.deepEqual(s.experience()[0], history);
  await s.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: sent.connectionEpoch, outcome: { state: 'failed', code: 'secret unsafe details' } });
  assert.equal(s.segments()[0]!.state, 'succeeded');
  assert.equal(s.segments()[0]!.errorCode, 'contradictory-send-confirmation');
  assert.deepEqual(s.experience()[0], history);
});

for (const invalidation of ['configuration-only', 'forget', 'revoke'] as const) {
  test(`duplicate unknown after ${invalidation} preserves only still-valid confirmed experience input`, async () => {
    const s = await setup();
    const text = 'durably confirmed experience input';
    await s.outbox.prepare(s.replyId, text, s.provenance);
    await s.outbox.send(s.replyId);
    const queued = structuredClone(s.experience()[0]!);
    assert.equal(queued.state, 'pending');
    // Same settings with a new revision: existing completed sends/tasks are not cancelled.
    await s.fixture.changeConfiguration(structuredClone(s.fixture.current.config));
    if (invalidation !== 'configuration-only') {
      const ref = s.provenance.sourceRefs[0]!;
      await s.fixture.repository.recordDeletion(`confirmed-${invalidation}`, {
        kind: 'source', sourceId: ref.sourceId, throughEpoch: ref.sourceEpoch,
      }, invalidation, s.fixture.now);
    }
    const beforeAudit = structuredClone(s.experience()[0]!);
    const sent = s.transport.submitted[0]!;
    await s.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: sent.connectionEpoch, outcome: { state: 'unknown' } });
    assert.equal(s.segments()[0]!.state, 'succeeded');
    assert.equal(s.segments()[0]!.qqMessageId, '1');
    assert.equal(s.experience().length, 1);
    assert.deepEqual(s.experience()[0], beforeAudit); // Audit cannot rewrite task state, route, snapshot or history.
    if (invalidation === 'configuration-only') {
      assert.equal(s.segments()[0]!.text, text);
      assert.equal(s.segments()[0]!.experienceTaskId, queued.taskId);
      assert.deepEqual(s.experience()[0], queued);
    } else {
      assert.equal(s.segments()[0]!.text, undefined);
      assert.equal(s.experience()[0]!.state, 'cancelled');
    }
    await s.outbox.send(s.replyId);
    assert.equal(s.transport.submitted.length, 1);
  });
}

test('late failure before queued unknown stays failed, and contradictory success cannot turn it into experience', async () => {
  const s = await setup();
  await s.outbox.prepare(s.replyId, 'rejected', s.provenance);
  s.transport.onSubmit = attempt => s.outbox.handleLateOutcome({ echo: attempt.echo, connectionEpoch: attempt.connectionEpoch,
    outcome: { state: 'failed' } }).then(() => ({ state: 'unknown' }));
  await s.outbox.send(s.replyId);
  const sent = s.transport.submitted[0]!;
  await s.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: sent.connectionEpoch, outcome: { state: 'succeeded', messageId: 'contradictory' } });
  assert.equal(s.segments()[0]!.state, 'failed');
  assert.equal(s.segments()[0]!.errorCode, 'contradictory-send-confirmation');
  assert.equal(s.experience().length, 0);
});

test('late outcome requires exact echo AND epoch; forgetting never restores body or experience', async () => {
  const s = await setup();
  await s.outbox.prepare(s.replyId, 'sensitive answer', s.provenance);
  s.transport.onSubmit = async () => ({ state: 'unknown' });
  await s.outbox.send(s.replyId);
  const sent = s.transport.submitted[0]!;
  await s.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: 'wrong-epoch', outcome: { state: 'succeeded', messageId: 'x' } });
  await s.outbox.handleLateOutcome({ echo: 'wrong-echo', connectionEpoch: sent.connectionEpoch, outcome: { state: 'succeeded', messageId: 'x' } });
  assert.equal(s.segments()[0]!.state, 'unknown');
  await s.fixture.repository.recordDeletion('late-forget', { kind: 'messages', messageKeys: s.provenance.messageKeys }, 'forget', s.fixture.now);
  await s.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: sent.connectionEpoch, outcome: { state: 'succeeded', messageId: 'audit-only' } });
  assert.equal(s.segments()[0]!.state, 'succeeded');
  assert.equal(s.segments()[0]!.text, undefined);
  assert.equal(s.experience().length, 0);
  assert.ok(!JSON.stringify(s.fixture.control.get()).includes('sensitive answer'));
});

test('configuration binding changes cancel old prepared output and late confirmations remain audit-only', async () => {
  const s = await setup();
  await s.outbox.prepare(s.replyId, 'old-personality body', s.provenance);
  const next = structuredClone(s.fixture.current.config);
  next.personalities.push({ ...structuredClone(next.personalities[0]!), id: 'other-personality', name: '另一个' });
  next.bindings.groups = [{ id: '300', personalityId: 'other-personality' }];
  await s.fixture.changeConfiguration(next);
  assert.equal((await s.outbox.send(s.replyId)).state, 'cancelled');
  assert.equal(s.transport.submitted.length, 0);
  const inFlight = await setup();
  await inFlight.outbox.prepare(inFlight.replyId, 'late config body', inFlight.provenance);
  inFlight.transport.onSubmit = async () => ({ state: 'unknown' });
  await inFlight.outbox.send(inFlight.replyId);
  await inFlight.fixture.changeConfiguration(next);
  const sent = inFlight.transport.submitted[0]!;
  await inFlight.outbox.handleLateOutcome({ echo: sent.echo, connectionEpoch: sent.connectionEpoch, outcome: { state: 'succeeded', messageId: 'config-audit' } });
  assert.equal(inFlight.segments()[0]!.state, 'succeeded');
  assert.equal(inFlight.segments()[0]!.text, undefined);
  assert.equal(inFlight.experience().length, 0);
});

test('configured credentials, known patterns and untrusted outcome errors never leak into output/audit', async () => {
  const secret = 'configured-onebot-secret-value';
  const s = await setup({ onebot: { enabled: true, expectedSelfId: '100', token: secret }, security: { redactKnownSecrets: false } });
  const mockApiKey = 'sk-' + '123456789012345678901234'; // Deliberately synthetic, no stored credential literal.
  const text = `literal ${secret}; Bearer abcdefghijklmnop; ${mockApiKey}; password=plaintext`;
  await s.outbox.prepare(s.replyId, text, s.provenance);
  s.transport.onSubmit = async () => ({ state: 'failed', code: `gateway unsafe ${secret}` });
  await s.outbox.send(s.replyId);
  const serialized = JSON.stringify({ state: s.fixture.control.get(), sends: s.transport.submitted });
  for (const forbidden of [secret, 'abcdefghijklmnop', mockApiKey, 'plaintext', 'gateway unsafe']) {
    assert.ok(!serialized.includes(forbidden));
  }
  assert.match(s.transport.submitted[0]!.text, /REDACTED/);
  assert.equal(s.segments()[0]!.state, 'failed');
  assert.equal(s.experience().length, 0);
});

test('confirmation storage failure is surfaced, not swallowed as successful metadata fallback', async () => {
  const s = await setup();
  await s.outbox.prepare(s.replyId, 'possibly delivered', s.provenance);
  s.transport.onSubmit = async () => {
    s.fixture.control.failAtCommit = s.fixture.control.commits + 1;
    return { state: 'succeeded', messageId: 'delivered-before-storage-failure' };
  };
  await assert.rejects(s.outbox.send(s.replyId), /control-commit-failed/);
  assert.equal(s.fixture.repository.getHealth().state, 'blocked');
  assert.equal(s.transport.submitted.length, 1);
  assert.equal(Object.values(s.fixture.control.get().tasks).filter(task => task.kind === 'experience').length, 0);
  assert.equal(Object.values(s.fixture.control.get().segments)[0]!.state, 'sending');
});
