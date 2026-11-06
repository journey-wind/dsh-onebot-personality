import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeSources, memoryUsable, unionClosure, scopeFingerprint, PolicyValidationError,
  MAX_MEMBERSHIP_PROOF_MS } from '../src/policy/scope.js';
import type { AuthorizedScope, DependencyVersion, MemoryMetadata, MembershipProof, ProvenanceInput,
  SourceRecord, SourceRef, TargetScope } from '../src/policy/scope.js';

const NOW = 100_000;
const BOTS = ['100', '200'] as const;
const PERSONAS = ['p1', 'p2'] as const;
const GROUPS = ['301', '302', '303'] as const;
const USERS = ['401', '402', '403'] as const;
const MEMBERS: Readonly<Record<string, readonly string[]>> = { '401': ['301', '302'], '402': ['302'], '403': [] };
const SOURCES: readonly SourceRecord[] = BOTS.flatMap(botId => PERSONAS.flatMap(personalityId => [
  ...GROUPS.map(conversationId => makeSource(botId, personalityId, 'group', conversationId)),
  ...USERS.map(conversationId => makeSource(botId, personalityId, 'private', conversationId)),
]));

function makeSource(botId: string, personalityId: string, conversationType: 'group' | 'private', conversationId: string): SourceRecord {
  return { sourceId: `${botId}/${personalityId}/${conversationType}/${conversationId}`, sourceEpoch: 1,
    botId, personalityId, conversationType, conversationId, allowed: true, forgotten: false };
}

function getSource(type: 'group' | 'private', id: string, bot = '100', persona = 'p1'): SourceRecord {
  const result = SOURCES.find(s => s.botId === bot && s.personalityId === persona && s.conversationType === type && s.conversationId === id);
  assert.ok(result);
  return result;
}

function ref(s: SourceRecord): SourceRef { return { sourceId: s.sourceId, sourceEpoch: s.sourceEpoch }; }
function message(s: SourceRecord): string { return `${s.sourceId}/message-1`; }
function marker(s: SourceRecord): string { return `SECRET[${s.sourceId}]`; }
function memory(s: SourceRecord, overrides: Partial<MemoryMetadata> = {}): MemoryMetadata {
  return { memoryId: `m:${s.sourceId}`, version: 1, botId: s.botId, personalityId: s.personalityId,
    active: true, tombstoned: false, sourceRefs: [ref(s)], messageKeys: [message(s)], dependencyVersions: [], complete: true, ...overrides };
}

function target(overrides: Partial<TargetScope> = {}): TargetScope {
  return { botId: '100', personalityId: 'p1', conversationType: 'group', conversationId: '301', requesterQQ: '401',
    visibility: 'source-restricted', configRevision: 'config-1', authEpoch: 1, bindingRevision: 1,
    connectionEpoch: 'connection-1', ...overrides };
}

function member(groupId = '301', overrides: Partial<MembershipProof> = {}): MembershipProof {
  return { botId: '100', groupId, userId: '401', connectionEpoch: 'connection-1', checkedAt: NOW,
    expiresAt: NOW + MAX_MEMBERSHIP_PROOF_MS, ...overrides };
}

function privateTarget(overrides: Partial<TargetScope> = {}): TargetScope {
  return target({ conversationType: 'private', conversationId: '401', ...overrides });
}

function input(s: SourceRecord, overrides: Partial<ProvenanceInput> = {}): ProvenanceInput {
  return { sourceRefs: [ref(s)], messageKeys: [message(s)], dependencyVersions: [], complete: true, ...overrides };
}

function unsafe<T>(value: unknown): T { return value as T; }

// Payloads stay outside strict policy metadata. Selection happens BEFORE supplying inputs to
// mock candidates, stages, rerank, cache or send; no real model/OneBot/knowledge calls occur.
test('2 bots x 2 personas x 3 groups x 3 users: unauthorized markers never enter selected inputs', () => {
  const fixtures = SOURCES.map(s => ({ source: s, metadata: memory(s), content: marker(s) }));
  for (const botId of BOTS) for (const personalityId of PERSONAS) {
    for (const visibility of ['source-restricted', 'fully-shared'] as const) {
      for (const conversationType of ['group', 'private'] as const) {
        for (const conversationId of conversationType === 'group' ? GROUPS : USERS) {
          const requesterQQ = conversationType === 'private' ? conversationId : USERS[0];
          const t = target({ botId, personalityId, visibility, conversationType, conversationId, requesterQQ });
          const groups = MEMBERS[requesterQQ] ?? [];
          const proofs = groups.map(groupId => member(groupId, { botId, userId: requesterQQ }));
          const scope = authorizeSources(t, SOURCES, proofs, NOW);
          const expected = SOURCES.filter(s => s.botId === botId && s.personalityId === personalityId &&
            (visibility === 'fully-shared' || (conversationType === 'group'
              ? s.conversationType === 'group' && s.conversationId === conversationId
              : s.conversationType === 'private' ? s.conversationId === requesterQQ : groups.includes(s.conversationId))));
          assert.deepEqual(new Set(scope.allowedSources.map(s => s.sourceId)), new Set(expected.map(s => s.sourceId)));
          const selected = fixtures.filter(f => memoryUsable(f.metadata, scope, SOURCES, NOW));
          assert.deepEqual(new Set(selected.map(f => f.source.sourceId)), new Set(expected.map(s => s.sourceId)));
          for (const boundary of ['candidates', 'router', 'recall-plan', 'rerank', 'recall-evidence', 'reflect', 'reply', 'cache', 'send']) {
            const selectedInputs = JSON.stringify({ boundary, inputs: selected.map(f => f.content) });
            for (const f of fixtures) assert.equal(selectedInputs.includes(f.content), expected.some(s => s.sourceId === f.source.sourceId));
          }
        }
      }
    }
  }
});

test('restricted group cannot read another group or any private source without respect to membership', () => {
  const scope = authorizeSources(target(), SOURCES, GROUPS.map(id => member(id)), NOW);
  assert.equal(memoryUsable(memory(getSource('group', '301')), scope, SOURCES, NOW), true);
  for (const s of [getSource('group', '302'), getSource('private', '401'), getSource('private', '402')]) {
    assert.equal(memoryUsable(memory(s), scope, SOURCES, NOW), false);
  }
});

test('anonymous group requester remains null and authorizes only its group without fabricated QQ', () => {
  const anonymous = target({ requesterQQ: null });
  const scope = authorizeSources(anonymous, SOURCES, GROUPS.map(id => member(id)), NOW);
  assert.equal(scope.requesterQQ, null);
  assert.deepEqual(scope.allowedSources, [ref(getSource('group', '301'))]);
  assert.deepEqual(scope.membershipProofs, []);
  for (const s of SOURCES) assert.equal(memoryUsable(memory(s), scope, SOURCES, NOW),
    s.sourceId === getSource('group', '301').sourceId);
  assert.notEqual(scopeFingerprint(scope), scopeFingerprint(authorizeSources(target(), SOURCES, [], NOW)));
  assert.equal(scopeFingerprint(scope), scopeFingerprint(authorizeSources(anonymous, SOURCES, [], NOW)));
  assert.throws(() => authorizeSources(unsafe<TargetScope>({ ...anonymous, requesterQQ: 'anonymous-placeholder' }), SOURCES, [], NOW),
    PolicyValidationError);
  const { requesterQQ: omitted, ...missing } = anonymous;
  assert.equal(omitted, null);
  assert.throws(() => authorizeSources(unsafe<TargetScope>(missing), SOURCES, [], NOW), PolicyValidationError);
});

test('anonymous group fully-shared scope remains explicit and confined to its bot and persona', () => {
  const scope = authorizeSources(target({ requesterQQ: null, visibility: 'fully-shared' }), SOURCES, [], NOW);
  assert.equal(scope.requesterQQ, null);
  assert.equal(scope.allowedSources.length, 6);
  assert.deepEqual(scope.membershipProofs, []);
  for (const s of SOURCES) assert.equal(memoryUsable(memory(s), scope, SOURCES, NOW),
    s.botId === '100' && s.personalityId === 'p1');
});

test('private null requester is denied for restricted and fully-shared targets', () => {
  for (const visibility of ['source-restricted', 'fully-shared'] as const) {
    assert.throws(() => authorizeSources(privateTarget({ requesterQQ: null, visibility }), SOURCES, [member()], NOW), PolicyValidationError);
    const valid = authorizeSources(privateTarget({ visibility }), SOURCES, [member()], NOW);
    assert.equal(memoryUsable(memory(getSource('private', '401')), { ...valid, requesterQQ: null }, SOURCES, NOW), false);
  }
});

test('private group access needs exact bot/user/group/connection proof and bounded lifetime', () => {
  const s = getSource('group', '301');
  const invalid: readonly unknown[] = [
    member('302'), member('301', { botId: '200' }), member('301', { userId: '402' }),
    member('301', { connectionEpoch: 'old-connection' }), member('301', { checkedAt: NOW + 1 }),
    member('301', { checkedAt: NOW - 30_000, expiresAt: NOW }),
    member('301', { expiresAt: NOW + 30_001 }), member('301', { expiresAt: NOW }),
    { ...member(), member: true }, { ...member(), checkedAt: NaN }, {}, null,
  ];
  for (const p of invalid) {
    const scope = authorizeSources(privateTarget(), SOURCES, unsafe<readonly MembershipProof[]>([p]), NOW);
    assert.equal(memoryUsable(memory(s), scope, SOURCES, NOW), false);
    assert.equal(memoryUsable(memory(getSource('private', '401')), scope, SOURCES, NOW), true);
  }
  // No successful query (timeout, error, query budget exhausted) is represented by no proof.
  const noProof = authorizeSources(privateTarget(), SOURCES, [], NOW);
  assert.equal(memoryUsable(memory(s), noProof, SOURCES, NOW), false);
  const valid = authorizeSources(privateTarget(), SOURCES, [member()], NOW);
  assert.equal(memoryUsable(memory(s), valid, SOURCES, NOW), true);
});

test('stale proof never grants group access after 30s; own private is not needlessly expired', () => {
  const scope = authorizeSources(privateTarget(), SOURCES, [member()], NOW);
  const group = memory(getSource('group', '301'));
  const ownPrivate = memory(getSource('private', '401'));
  assert.equal(memoryUsable(group, scope, SOURCES, NOW + 29_999), true);
  for (const now of [NOW + 30_000, NOW + 30_001, NOW + 90_000]) {
    assert.equal(memoryUsable(group, scope, SOURCES, now), false);
    assert.equal(memoryUsable(ownPrivate, scope, SOURCES, now), true);
  }
  const earlyExpiry = authorizeSources(privateTarget(), SOURCES, [member('301', { expiresAt: NOW + 5 })], NOW);
  assert.equal(memoryUsable(group, earlyExpiry, SOURCES, NOW + 5), false);
});

test('expiry checks are per actual source even if scope also carries an unrelated stale proof', () => {
  const scope = authorizeSources(privateTarget(), SOURCES,
    [member('301', { expiresAt: NOW + 5 }), member('302', { expiresAt: NOW + 20_000 })], NOW);
  assert.equal(memoryUsable(memory(getSource('group', '301')), scope, SOURCES, NOW + 6), false);
  assert.equal(memoryUsable(memory(getSource('group', '302')), scope, SOURCES, NOW + 6), true);
});

test('invalid, missing and mismatching private requester identities fail closed', () => {
  for (const change of [{ requesterQQ: '' }, { requesterQQ: 'unknown' }, { requesterQQ: '402' }, { requesterQQ: 401 }]) {
    assert.throws(() => authorizeSources(unsafe<TargetScope>({ ...privateTarget(), ...change }), SOURCES, [], NOW), PolicyValidationError);
  }
  const { requesterQQ: omittedRequester, ...missing } = privateTarget();
  assert.equal(omittedRequester, '401');
  assert.throws(() => authorizeSources(unsafe<TargetScope>(missing), SOURCES, [], NOW), PolicyValidationError);
});

test('revoked, forgotten and advanced-epoch sources invalidate even previously authorized scopes', () => {
  const s = getSource('group', '301');
  const m = memory(s);
  const scope = authorizeSources(target(), SOURCES, [], NOW);
  for (const changed of [{ ...s, allowed: false }, { ...s, forgotten: true }, { ...s, sourceEpoch: 2 }]) {
    const current = SOURCES.map(item => item.sourceId === s.sourceId ? changed : item);
    assert.equal(memoryUsable(m, scope, current, NOW), false);
    const newScope = authorizeSources(target(), current, [], NOW);
    assert.equal(memoryUsable(m, newScope, current, NOW), false);
  }
  const epoch2 = SOURCES.map(item => item.sourceId === s.sourceId ? { ...s, sourceEpoch: 2 } : item);
  const newScope = authorizeSources(target(), epoch2, [], NOW);
  assert.equal(memoryUsable(memory(s, { sourceRefs: [{ sourceId: s.sourceId, sourceEpoch: 2 }] }), newScope, epoch2, NOW), true);
  assert.equal(memoryUsable(m, scope, SOURCES.filter(item => item.sourceId !== s.sourceId), NOW), false);
});

test('fully shared includes only allowed nonforgotten current same-bot/persona sources', () => {
  const revoked = getSource('group', '302');
  const forgotten = getSource('private', '402');
  const current = SOURCES.map(s => s.sourceId === revoked.sourceId ? { ...s, allowed: false } :
    s.sourceId === forgotten.sourceId ? { ...s, forgotten: true } : s);
  const scope = authorizeSources(target({ visibility: 'fully-shared' }), current, [], NOW);
  assert.equal(scope.allowedSources.length, 4);
  assert.equal(scope.membershipProofs.length, 0);
  for (const s of current) assert.equal(memoryUsable(memory(s), scope, current, NOW + 60_000),
    s.botId === '100' && s.personalityId === 'p1' && s.allowed && !s.forgotten);
});

test('closure includes every input source, message and version, not selected model citations', () => {
  const a = getSource('group', '301');
  const b = getSource('private', '402');
  const v1: DependencyVersion = { memoryId: 'fact-a', version: 1 };
  const v2: DependencyVersion = { memoryId: 'fact-b', version: 2 };
  const inputs = [input(a, { inputVersion: v1 }), input(b, { inputVersion: v2, dependencyVersions: [v1] }), input(a)];
  const result = unionClosure(inputs);
  assert.deepEqual(new Set(result.sourceRefs.map(s => s.sourceId)), new Set([a.sourceId, b.sourceId]));
  assert.deepEqual(new Set(result.messageKeys), new Set([message(a), message(b)]));
  assert.deepEqual(result.dependencyVersions, [v1, v2]);
  const mixed = memory(a, result);
  const restricted = authorizeSources(target(), SOURCES, [], NOW);
  const shared = authorizeSources(target({ visibility: 'fully-shared' }), SOURCES, [], NOW);
  assert.equal(memoryUsable(mixed, shared, SOURCES, NOW, { currentDependencyVersions: [v1, v2] }), true);
  assert.equal(memoryUsable(mixed, restricted, SOURCES, NOW, { currentDependencyVersions: [v1, v2] }), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.sourceRefs), true);
  assert.equal(Object.isFrozen(result.sourceRefs[0]), true);
});

test('mixed metadata, observations, mental models, historical replies and experiences do not launder private inputs', () => {
  const group = getSource('group', '301');
  const privateSource = getSource('private', '401');
  const generated = unionClosure([input(group), input(privateSource)]);
  const restricted = authorizeSources(target(), SOURCES, [], NOW);
  const shared = authorizeSources(target({ visibility: 'fully-shared' }), SOURCES, [], NOW);
  for (const kind of ['entity-property', 'alias', 'relation', 'observation', 'mental-model', 'reflect', 'reply-history', 'experience']) {
    const item = memory(group, { ...generated, memoryId: kind });
    assert.equal(memoryUsable(item, shared, SOURCES, NOW), true);
    assert.equal(memoryUsable(item, restricted, SOURCES, NOW), false);
  }
});

test('empty, incomplete, malformed or unknown provenance is denied rather than made public', () => {
  const good = input(getSource('group', '301'));
  for (const bad of [
    [], [null], [{ ...good, complete: false }], [{ ...good, complete: undefined }],
    [{ ...good, sourceRefs: [] }], [{ ...good, messageKeys: [] }], [{ ...good, messageKeys: [''] }],
    [{ ...good, sourceRefs: [{ sourceId: 'x', sourceEpoch: 0 }] }],
    [{ ...good, sourceRefs: [{ sourceId: 'x', sourceEpoch: 1, acl: true }] }],
    [{ ...good, dependencyVersions: [{ memoryId: 'unknown', version: 1 }] }],
    [{ ...good, dependencyVersions: [{ memoryId: 'x', version: 0 }] }],
    [{ ...good, dependencyVersions: [{ memoryId: 'x', version: 1, allowed: true }] }],
    [{ ...good, allowed: true }], [{ ...good, modelCitations: [good.sourceRefs[0]] }],
  ]) assert.throws(() => unionClosure(unsafe<readonly ProvenanceInput[]>(bad)), PolicyValidationError);
});

test('contradictory source epochs and dependency versions reject the entire closure', () => {
  const s = getSource('group', '301');
  const good = input(s);
  assert.throws(() => unionClosure([good, input(s, { sourceRefs: [{ sourceId: s.sourceId, sourceEpoch: 2 }] })]), PolicyValidationError);
  assert.throws(() => unionClosure([good, input(s, { inputVersion: { memoryId: 'same', version: 1 } }),
    input(s, { inputVersion: { memoryId: 'same', version: 2 } })]), PolicyValidationError);
  assert.throws(() => unionClosure([input(s, { dependencyVersions: [{ memoryId: 'fact', version: 2 }] })],
    [{ memoryId: 'fact', version: 1 }]), PolicyValidationError);
  const result = unionClosure([input(s, { dependencyVersions: [{ memoryId: 'fact', version: 2 }] })],
    [{ memoryId: 'fact', version: 2 }]);
  assert.deepEqual(result.dependencyVersions, [{ memoryId: 'fact', version: 2 }]);
});

test('self-dependencies cannot manufacture a valid provenance version', () => {
  const s = getSource('group', '301');
  const own: DependencyVersion = { memoryId: 'self', version: 1 };
  assert.throws(() => unionClosure([input(s, { inputVersion: own, dependencyVersions: [own] })]), PolicyValidationError);
  const scope = authorizeSources(target(), SOURCES, [], NOW);
  assert.equal(memoryUsable(memory(s, { memoryId: 'self', dependencyVersions: [own] }), scope, SOURCES, NOW,
    { currentDependencyVersions: [own] }), false);
});

test('unknown, removed or superseded dependency versions are unusable', () => {
  const s = getSource('group', '301');
  const scope = authorizeSources(target(), SOURCES, [], NOW);
  const m = memory(s, { dependencyVersions: [{ memoryId: 'fact', version: 2 }] });
  assert.equal(memoryUsable(m, scope, SOURCES, NOW), false);
  assert.equal(memoryUsable(m, scope, SOURCES, NOW, { currentDependencyVersions: [] }), false);
  assert.equal(memoryUsable(m, scope, SOURCES, NOW, { currentDependencyVersions: [{ memoryId: 'fact', version: 3 }] }), false);
  assert.equal(memoryUsable(m, scope, SOURCES, NOW, { currentDependencyVersions: [{ memoryId: 'fact', version: 2 }] }), true);
});

test('message and author forgetting invalidates ALL-input derived closures without source forgetting', () => {
  const a = getSource('group', '301');
  const b = getSource('group', '302');
  const scope = authorizeSources(target({ visibility: 'fully-shared' }), SOURCES, [], NOW);
  const c = unionClosure([input(a), input(b)]);
  const derived = memory(a, c);
  assert.equal(memoryUsable(derived, scope, SOURCES, NOW), true);
  assert.equal(memoryUsable(derived, scope, SOURCES, NOW, { tombstonedMessageKeys: [message(b)] }), false);
  const keysForForgottenAuthor = new Set([message(b)]);
  assert.equal(memoryUsable(derived, scope, SOURCES, NOW, { isMessageForgotten: key => keysForForgottenAuthor.has(key) }), false);
  assert.equal(memoryUsable(memory(a), scope, SOURCES, NOW, { tombstonedMessageKeys: [message(b)] }), true);
  assert.equal(memoryUsable(derived, scope, SOURCES, NOW, { isMessageForgotten: () => { throw new Error('index unavailable'); } }), false);
  assert.equal(memoryUsable(derived, scope, SOURCES, NOW, { isMessageForgotten: unsafe<(key: string) => boolean>(() => undefined) }), false);
});

test('tombstoned/inactive memory, wrong bank, empty/unknown sources and partial closure are unusable', () => {
  const s = getSource('group', '301');
  const scope = authorizeSources(target(), SOURCES, [], NOW);
  for (const change of [
    { active: false }, { tombstoned: true }, { active: 'true' }, { botId: '200' }, { personalityId: 'p2' },
    { sourceRefs: [] }, { sourceRefs: [{ sourceId: 'unknown', sourceEpoch: 1 }] }, { sourceRefs: [{ sourceId: s.sourceId, sourceEpoch: 2 }] },
    { complete: false }, { complete: undefined }, { messageKeys: [] }, { version: 0 },
    { dependencyVersions: [{ memoryId: 'unknown', version: 1 }] }, { modelAllowed: true },
  ]) assert.equal(memoryUsable(unsafe<MemoryMetadata>({ ...memory(s), ...change }), scope, SOURCES, NOW), false);
  const empty = authorizeSources(target(), [], [], NOW);
  assert.equal(empty.allowedSources.length, 0);
  assert.equal(memoryUsable(memory(s), empty, SOURCES, NOW), false);
});

test('source identities and epochs must be unambiguous positive safe integers', () => {
  const s = getSource('group', '301');
  for (const epoch of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const bad = unsafe<SourceRecord>({ ...s, sourceEpoch: epoch });
    assert.throws(() => authorizeSources(target(), [bad], [], NOW), PolicyValidationError);
  }
  assert.throws(() => authorizeSources(target(), [s, s], [], NOW), PolicyValidationError);
  assert.throws(() => authorizeSources(target(), [s, { ...s, sourceId: 'alias' }], [], NOW), PolicyValidationError);
  assert.throws(() => authorizeSources(target(), [unsafe<SourceRecord>({ ...s, acl: true })], [], NOW), PolicyValidationError);
});

test('scope connection changes, tampering and future/invalid clock fail closed', () => {
  const scope = authorizeSources(privateTarget(), SOURCES, [member()], NOW);
  const m = memory(getSource('group', '301'));
  assert.equal(memoryUsable(m, { ...scope, connectionEpoch: 'new-connection' }, SOURCES, NOW), false);
  assert.equal(memoryUsable(m, scope, SOURCES, NOW - 1), false);
  assert.equal(memoryUsable(m, scope, SOURCES, NaN), false);
  assert.equal(memoryUsable(m, unsafe<AuthorizedScope>({ ...scope, modelAllowed: true }), SOURCES, NOW), false);
  const forged = { ...authorizeSources(target(), SOURCES, [], NOW), allowedSources: [ref(getSource('private', '401'))] };
  assert.equal(memoryUsable(memory(getSource('private', '401')), forged, SOURCES, NOW), false);
});

test('every local pipeline checkpoint rechecks revocation rather than trusting earlier selection', () => {
  const s = getSource('group', '301');
  const scope = authorizeSources(target(), SOURCES, [], NOW);
  const m = memory(s);
  for (const checkpoint of ['router', 'recall-plan', 'search', 'evidence', 'reflect', 'reply', 'send-queue', 'segment']) {
    assert.equal(memoryUsable(m, scope, SOURCES, NOW), true, checkpoint);
    const revoked = SOURCES.map(item => item.sourceId === s.sourceId ? { ...s, allowed: false } : item);
    assert.equal(memoryUsable(m, scope, revoked, NOW), false, checkpoint);
    assert.equal(memoryUsable(m, scope, SOURCES, NOW, { tombstonedMessageKeys: [message(s)] }), false, checkpoint);
  }
});

test('scope fingerprints canonicalize order and include all scope invalidation metadata', () => {
  const t = privateTarget();
  const proofs = [member('301'), member('302')];
  const scope = authorizeSources(t, SOURCES, proofs, NOW);
  const reversed = { ...scope, allowedSources: [...scope.allowedSources].reverse(), membershipProofs: [...scope.membershipProofs].reverse() };
  const fingerprint = scopeFingerprint(scope);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(scopeFingerprint(reversed), fingerprint);
  for (const change of [
    { configRevision: 'config-2' }, { authEpoch: 2 }, { bindingRevision: 2 }, { createdAt: NOW + 1 },
    { allowedSources: scope.allowedSources.slice(1) },
    { allowedSources: scope.allowedSources.map(s => ({ ...s, sourceEpoch: 2 })) },
    { membershipProofs: scope.membershipProofs.map(p => ({ ...p, expiresAt: p.expiresAt - 1 })) },
  ]) assert.notEqual(scopeFingerprint({ ...scope, ...change }), fingerprint);
  const group = authorizeSources(target(), SOURCES, [], NOW);
  for (const change of [
    { botId: '200' }, { personalityId: 'p2' }, { conversationId: '302' }, { requesterQQ: '402' },
    { visibility: 'fully-shared' as const }, { connectionEpoch: 'new-connection' },
  ]) assert.notEqual(scopeFingerprint({ ...group, ...change }), scopeFingerprint(group));
  assert.notEqual(scopeFingerprint(authorizeSources(target({ visibility: 'fully-shared' }), SOURCES, [], NOW)), scopeFingerprint(group));
  assert.throws(() => scopeFingerprint(unsafe<AuthorizedScope>({ ...scope, content: 'SECRET_PAYLOAD' })), PolicyValidationError);
});

test('returned scopes and closures are immutable detached snapshots', () => {
  const s = { ...getSource('group', '301') };
  const t = target();
  const scope = authorizeSources(t, [s], [], NOW);
  s.sourceEpoch = 2;
  assert.equal(scope.allowedSources[0]?.sourceEpoch, 1);
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(Object.isFrozen(scope.allowedSources), true);
  const mutableInput = { ...input(s), sourceRefs: [ref(s)], messageKeys: [message(s)] };
  const c = unionClosure([mutableInput]);
  mutableInput.messageKeys[0] = 'replacement';
  assert.equal(c.messageKeys[0], message(s));
});

test('hidden/accessor/unknown metadata cannot override source policy or leak through errors', () => {
  const s = getSource('group', '301');
  let getterInvoked = false;
  const accessor = { ...s };
  Object.defineProperty(accessor, 'allowed', { enumerable: true, get: () => { getterInvoked = true; return true; } });
  assert.throws(() => authorizeSources(target(), [accessor], [], NOW), PolicyValidationError);
  assert.equal(getterInvoked, false);
  const symbol = { ...s, [Symbol('acl')]: true };
  assert.throws(() => authorizeSources(target(), [symbol], [], NOW), PolicyValidationError);
  assert.throws(() => authorizeSources(target(), [unsafe<SourceRecord>({ ...s, credential: 'SECRET_DO_NOT_ECHO' })], [], NOW),
    error => error instanceof PolicyValidationError && !String(error).includes('SECRET_DO_NOT_ECHO'));
});
