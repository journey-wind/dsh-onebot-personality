import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, selectPersonality, STAGES } from '../src/config.js';
import { createSnapshot, inheritRoute, resolveFiveRoutes } from '../src/llm/routes.js';
import type { ModelSelection } from '../src/llm/routes.js';

const defaultModel: ModelSelection = { provider: 'default-provider', model: 'default-model', reasoningEffort: 'default-effort' };
function personaConfig(input: unknown = {}) {
  const config = parseConfig(input);
  return { config, persona: selectPersonality(config, 'group', '123') };
}

test('default configuration is disabled with empty allowlists and distinct stage budgets', () => {
  const { config, persona } = personaConfig();
  assert.equal(config.onebot.enabled, false);
  assert.deepEqual(config.allow.groupIds, []);
  assert.deepEqual(config.allow.privateUserIds, []);
  assert.equal(persona.id, 'assistant-main');
  assert.equal(inheritRoute(persona.models.router, config.models.router, defaultModel, 'router').maxOutputTokens, 256);
  assert.equal(inheritRoute(persona.models.retain, config.models.retain, defaultModel, 'retain').timeoutMs, 60000);
});

test('route pairs cannot be partial, implicit or whitespace-padded', () => {
  for (const router of [
    { selection: 'explicit', provider: 'p' },
    { selection: 'explicit', model: 'm' },
    { selection: 'inherit', provider: 'p', model: 'm' },
    { selection: 'explicit', provider: ' p ', model: 'm' },
  ]) assert.throws(() => parseConfig({ models: { router } }));
});

test('global explicit route drops default effort; persona inherits budget independently', () => {
  const { config, persona } = personaConfig({ models: { reply: { selection: 'explicit', provider: 'global', model: 'reply', maxOutputTokens: 500 } } });
  const route = inheritRoute({ ...persona.models.reply, timeoutMs: 3000 }, config.models.reply, defaultModel, 'reply');
  assert.deepEqual(route, { provider: 'global', model: 'reply', maxOutputTokens: 500, timeoutMs: 3000 });
  const overridden = inheritRoute({ ...persona.models.reply, selection: 'explicit', provider: 'personal', model: 'other' },
    { ...config.models.reply, reasoningEffort: 'global-effort' }, defaultModel, 'reply');
  assert.equal(overridden.provider, 'personal');
  assert.equal(overridden.reasoningEffort, undefined);
});

test('unknown bindings, duplicate identities, unsafe IDs and shared mode fail closed', () => {
  const p = { id: 'p', name: '测试', systemPrompt: 'test' };
  assert.throws(() => parseConfig({ bindings: { defaultPersonalityId: 'unknown' } }));
  assert.throws(() => parseConfig({ bindings: { groups: [{ id: '123', personalityId: 'unknown' }] } }));
  assert.throws(() => parseConfig({ personalities: [p, p] }));
  assert.throws(() => parseConfig({ allow: { groupIds: [9007199254740992] } }));
  assert.throws(() => parseConfig({ personalities: [{ ...p, visibility: 'fully-shared' }], bindings: { defaultPersonalityId: 'p' } }));
  assert.doesNotThrow(() => parseConfig({
    personalities: [{ ...p, visibility: 'fully-shared' }], bindings: { defaultPersonalityId: 'p' },
    security: { confirmSharedPrivateToGroups: true },
  }));
});

test('WS rejects credentials, token URLs and unconfirmed remote cleartext', () => {
  for (const wsUrl of ['ws://bot:secret@localhost', 'ws://localhost/?token=secret', 'https://localhost', 'ws://remote.example']) {
    assert.throws(() => parseConfig({ onebot: { wsUrl } }));
  }
  assert.throws(() => parseConfig({ onebot: { enabled: true } }));
  assert.doesNotThrow(() => parseConfig({ onebot: { wsUrl: 'wss://remote.example', expectedSelfId: '123', enabled: true } }));
});

test('five routes resolve to exact host configs, snapshots have no WS token and remain detached', async () => {
  const globalModels = Object.fromEntries(STAGES.map(stage => [stage, { selection: 'explicit', provider: `provider-${stage}`, model: `model-${stage}` }]));
  const { config, persona } = personaConfig({ models: globalModels, onebot: { token: 'TOKEN_MUST_NOT_PERSIST' } });
  const seen: string[] = [];
  const routes = await resolveFiveRoutes({ resolveCallConfig: async call => {
    seen.push(`${call.provider}:${call.model}`);
    return call;
  } }, config, persona, defaultModel);
  assert.equal(seen.length, 5);
  for (const stage of STAGES) assert.equal(routes[stage].provider, `provider-${stage}`);
  const snapshot = createSnapshot(config, persona, routes, 'revision-1');
  assert.equal(JSON.stringify(snapshot).includes('TOKEN_MUST_NOT_PERSIST'), false);
  assert.equal(Object.isFrozen(snapshot.routes.reply), true);
  config.budgets.onlineConcurrency = 9;
  assert.equal(snapshot.budgets.onlineConcurrency, 4);
});

test('immutable host config is detached, undeclared fields and cycles are rejected without echoing secrets', () => {
  const frozen = Object.freeze({ onebot: Object.freeze({ token: 'DO_NOT_ECHO' }) });
  assert.equal(parseConfig(frozen).onebot.token, 'DO_NOT_ECHO');
  for (const input of [
    { onebot: { extraCredential: 'DO_NOT_ECHO' } },
    { models: { router: { apiKey: 'DO_NOT_ECHO' } } },
    { budgets: { onlineConcurrency: NaN } },
    { personalities: [{ id: 'p', name: '小\n忆', systemPrompt: 'test' }], bindings: { defaultPersonalityId: 'p' } },
  ]) assert.throws(() => parseConfig(input), error => !String(error).includes('DO_NOT_ECHO'));
  const cycle: Record<string, unknown> = {};
  cycle.onebot = cycle;
  assert.throws(() => parseConfig(cycle));
});

test('host route failures never substitute another provider', async () => {
  const { config, persona } = personaConfig();
  let calls = 0;
  await assert.rejects(resolveFiveRoutes({ resolveCallConfig: async () => {
    calls++;
    throw new Error('model removed');
  } }, config, persona, defaultModel));
  assert.equal(calls, 1);
});
