import S from '@deepseek-ai/schemastery';

export const STAGES = ['router', 'recall', 'reflect', 'retain', 'reply'] as const;
export type Stage = typeof STAGES[number];
export const STAGE_DEFAULTS: Record<Stage, { maxOutputTokens: number; timeoutMs: number }> = {
  router: { maxOutputTokens: 256, timeoutMs: 10_000 },
  recall: { maxOutputTokens: 1536, timeoutMs: 20_000 },
  reflect: { maxOutputTokens: 1536, timeoutMs: 25_000 },
  retain: { maxOutputTokens: 2048, timeoutMs: 60_000 },
  reply: { maxOutputTokens: 1536, timeoutMs: 40_000 },
};

const id = () => S.string().pattern(/^[1-9][0-9]{0,31}$/);
const natural = (value: number, min: number, max: number) => S.natural().min(min).max(max).default(value);
const choice = <T extends string>(values: readonly T[]) => S.union(values.map(value => S.const(value)));
const modelSlot = () => S.object({
  selection: choice(['inherit', 'explicit'] as const).default('inherit')
    .description('inherit：继承上层完整路由；explicit：同时填写 provider 与 model。'),
  provider: S.string().default('').description('DSH 已注册的 provider 路由；不填写 API 密钥。'),
  model: S.string().default(''),
  reasoningEffort: S.string().default('').description('空值采用所选模型默认；不跨显式路由继承。'),
  maxOutputTokens: natural(0, 0, 131072).description('0 表示继承；实际调用必须获得正值上限。'),
  timeoutMs: natural(0, 0, 300_000).description('0 表示继承；在线仍受总绝对截止时间限制。'),
});
const models = () => S.object({
  router: modelSlot(), recall: modelSlot(), reflect: modelSlot(), retain: modelSlot(), reply: modelSlot(),
});
const binding = () => S.object({
  id: id().required(), personalityId: S.string().required(),
});
const personality = S.object({
  id: S.string().pattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).required()
    .description('稳定 ID；修改后视为新身份，不迁移历史 bank。'),
  name: S.string().min(2).max(64).required(),
  aliases: S.array(S.string().min(2).max(64)).max(32).default([]),
  systemPrompt: S.string().min(1).max(16_384).required(),
  style: S.string().max(2048).default('自然、简洁、友善'),
  background: S.string().max(8192).default(''),
  disposition: S.object({
    skepticism: natural(3, 1, 5), literalism: natural(3, 1, 5), empathy: natural(4, 1, 5),
  }),
  visibility: choice(['source-restricted', 'fully-shared'] as const).default('source-restricted'),
  models: models(),
});

/** Form schema remains Schemastery so DSH can redact secrets and generate its own UI. */
export const PlainConfig = S.object({
  onebot: S.object({
    enabled: S.boolean().default(false).description('启用前完成兼容核验和 QQ 单独授权；默认不连接。'),
    wsUrl: S.string().default('ws://127.0.0.1:3001'),
    token: S.string().role('secret').default('').description('仅用于 Authorization: Bearer，不放入 URL、日志或快照。'),
    expectedSelfId: S.string().default('').description('启用时必须指定预期机器人 QQ ID。'),
    authMode: choice(['bearer'] as const).default('bearer'),
    connectTimeoutMs: natural(10_000, 1000, 120_000),
    actionTimeoutMs: natural(10_000, 1000, 120_000),
    heartbeatTimeoutMs: natural(60_000, 5000, 300_000),
    reconnectInitialMs: natural(1000, 100, 60_000),
    reconnectMaxMs: natural(60_000, 1000, 600_000),
    stableConnectionMs: natural(60_000, 1000, 600_000),
  }),
  persistence: S.object({
    directory: S.string().max(4096).default('')
      .description('独立私有状态目录的绝对路径；真正启用时必填，不使用会话工作目录或共享宿主数据库。'),
    privateDirectoryReady: S.boolean().default(false)
      .description('已在外部验证本地盘、可信父目录和私有权限（Windows owner-only DACL）。此确认不代替构建/故障验收，不支持整体旧备份安全开放恢复。'),
  }),
  allow: S.object({
    groupIds: S.array(id()).max(1000).default([]),
    privateUserIds: S.array(id()).max(10000).default([]),
  }),
  personalities: S.array(personality).max(100).default([{
    id: 'assistant-main', name: '小忆', aliases: ['忆酱'],
    systemPrompt: '你是小忆。遵守证据边界，不虚构长期记忆。',
  }]),
  bindings: S.object({
    defaultPersonalityId: S.string().default('assistant-main'),
    groups: S.array(binding()).default([]),
    privateUsers: S.array(binding()).default([]),
  }),
  models: models(),
  budgets: S.object({
    onlineConcurrency: natural(4, 1, 64), retainConcurrency: natural(2, 1, 32),
    retainMaxRetries: natural(5, 0, 20),
    reflectMaxRecallRounds: natural(3, 1, 3), onlineMaxLlmCalls: natural(12, 2, 64),
    retainMaxLlmCalls: natural(8, 1, 32), onlineDeadlineMs: natural(120_000, 5000, 600_000),
    recentMessages: natural(20, 0, 100), recentMaxBytes: natural(16_384, 0, 131_072),
    maxEventBytes: natural(262_144, 1024, 1_048_576),
    maxTextBytes: natural(16_384, 1, 65_536), maxSegments: natural(256, 1, 1024),
    maxCandidates: natural(100, 1, 100), evidenceMaxTokens: natural(4096, 128, 16_384),
    maxPendingTasks: natural(10_000, 1, 100_000),
    inboxMaxBytes: natural(268_435_456, 1024, 2_147_483_647),
    diskWarningBytes: natural(536_870_912, 0, 2_147_483_647),
    sendCodePoints: natural(1500, 1, 4000), sendMaxSegments: natural(8, 1, 16),
    sendSegmentBytes: natural(16_384, 128, 65_536),
    membershipMaxQueries: natural(32, 0, 1000),
    onlineRequestsPerMinute: natural(60, 1, 10000), retainRequestsPerMinute: natural(30, 1, 10000),
    onlineTokensPerMinute: natural(120_000, 256, 10_000_000),
    retainTokensPerMinute: natural(60_000, 256, 10_000_000),
    maxRetainTaskTokens: natural(100_000, 2048, 1_000_000),
  }),
  memory: S.object({
    refreshFactThreshold: natural(10, 1, 1000), refreshDebounceMs: natural(60_000, 1000, 3_600_000),
    refreshMaxWaitMs: natural(300_000, 1000, 3_600_000), freshnessMs: natural(86_400_000, 1000, 2_147_483_647),
    reflectCacheEnabled: S.boolean().default(false),
    cleanupBatch: natural(50, 1, 500), retryInitialMs: natural(1000, 100, 60_000),
    retryMaxMs: natural(300_000, 1000, 3_600_000),
    timeZone: S.string().default('Asia/Shanghai'),
  }),
  security: S.object({
    membershipCacheMs: natural(30_000, 0, 30_000),
    confirmSharedPrivateToGroups: S.boolean().default(false)
      .description('明确确认：私聊内容可能用于群回复。只有 fully-shared 模式需要此确认。'),
    allowInsecureRemoteWs: S.boolean().default(false)
      .description('非本机明文 WS 会暴露 token 和内容；默认拒绝。'),
    redactKnownSecrets: S.boolean().default(true),
    logMode: choice(['metadata-only'] as const).default('metadata-only'),
  }),
});

export type PluginConfig = ReturnType<typeof PlainConfig>;
export type Personality = PluginConfig['personalities'][number];
export type ModelSlot = PluginConfig['models']['router'];

/** Root volatile reference enables the native generated settings form, including secret masking. */
export const Config = PlainConfig.volatile();

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
  constructor(readonly code: string) { super(code); }
}

export function validateSlot(slot: ModelSlot): void {
  const provider = slot.provider.trim();
  const model = slot.model.trim();
  if (slot.provider !== provider || slot.model !== model) throw new ConfigurationError('route-whitespace');
  if (slot.selection === 'explicit' && (!provider || !model)) throw new ConfigurationError('route-pair-required');
  if (slot.selection === 'inherit' && (provider || model)) throw new ConfigurationError('inherited-route-must-be-empty');
  if (slot.reasoningEffort !== slot.reasoningEffort.trim()) throw new ConfigurationError('effort-whitespace');
}

/** Cross-field checks also run on every current volatile snapshot before any work. */
export function validateConfig(config: PluginConfig): PluginConfig {
  const ids = new Set<string>();
  for (const p of config.personalities) {
    if (ids.has(p.id)) throw new ConfigurationError('duplicate-personality');
    ids.add(p.id);
    if (!p.name.trim() || !p.systemPrompt.trim()) throw new ConfigurationError('empty-personality');
    if ([p.name, ...p.aliases].some(alias => [...alias.trim()].length < 2 || alias !== alias.trim() || /[\r\n\t]/.test(alias))) {
      throw new ConfigurationError('trigger-name-too-short-or-whitespace');
    }
    if (new Set(p.aliases).size !== p.aliases.length) throw new ConfigurationError('duplicate-alias');
    if (p.visibility === 'fully-shared' && !config.security.confirmSharedPrivateToGroups) {
      throw new ConfigurationError('shared-private-to-groups-confirmation-required');
    }
    for (const stage of STAGES) validateSlot(p.models[stage]);
  }
  if (!ids.has(config.bindings.defaultPersonalityId)) throw new ConfigurationError('unknown-default-personality');
  for (const list of [config.bindings.groups, config.bindings.privateUsers]) {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.id)) throw new ConfigurationError('duplicate-binding');
      seen.add(item.id);
      if (!ids.has(item.personalityId)) throw new ConfigurationError('unknown-bound-personality');
    }
  }
  for (const list of [config.allow.groupIds, config.allow.privateUserIds]) {
    if (new Set(list).size !== list.length) throw new ConfigurationError('duplicate-allow-id');
  }
  for (const stage of STAGES) validateSlot(config.models[stage]);
  if (config.onebot.enabled && !/^[1-9][0-9]{0,31}$/.test(config.onebot.expectedSelfId)) {
    throw new ConfigurationError('expected-self-id-required');
  }
  let url: URL;
  try { url = new URL(config.onebot.wsUrl); } catch { throw new ConfigurationError('invalid-ws-url'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError('ws-url-must-not-contain-credentials-query-or-fragment');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'ws:' && !loopback && !config.security.allowInsecureRemoteWs) {
    throw new ConfigurationError('insecure-remote-ws-requires-confirmation');
  }
  if (config.onebot.reconnectInitialMs > config.onebot.reconnectMaxMs) throw new ConfigurationError('invalid-reconnect-range');
  if (config.memory.retryInitialMs > config.memory.retryMaxMs) throw new ConfigurationError('invalid-retry-range');
  if (config.memory.refreshDebounceMs > config.memory.refreshMaxWaitMs) throw new ConfigurationError('invalid-refresh-range');
  if (config.memory.reflectCacheEnabled) throw new ConfigurationError('reflect-cache-not-implemented');
  try { new Intl.DateTimeFormat('en', { timeZone: config.memory.timeZone }); }
  catch { throw new ConfigurationError('invalid-memory-time-zone'); }
  return config;
}

/** Reject undeclared fields rather than allowing credentials/opaque objects into later snapshots. */
function assertConfigShape(value: unknown, schema: S, ancestors = new Set<object>()): void {
  if (value === undefined || value === null) return; // Schemastery resolves nullable defaults/requirements.
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ConfigurationError('non-finite-config-number');
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new ConfigurationError('non-json-configuration');
  }
  if (typeof value !== 'object') return;
  if (ancestors.has(value)) throw new ConfigurationError('circular-configuration');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (schema.type !== 'array' || !schema.inner) throw new ConfigurationError('invalid-config-shape');
      for (const child of value) assertConfigShape(child, schema.inner, ancestors);
      return;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || schema.type !== 'object' || !schema.dict) {
      throw new ConfigurationError('invalid-config-shape');
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.dict, key)) throw new ConfigurationError('unknown-config-field');
      assertConfigShape(Reflect.get(value, key), schema.dict[key]!, ancestors);
    }
  } finally { ancestors.delete(value); }
}

/** Detach immutable host references before schema adaptation; errors never echo input values. */
export function parseConfig(input: unknown = {}): PluginConfig {
  try {
    assertConfigShape(input, PlainConfig);
    return validateConfig(PlainConfig(structuredClone(input) as Parameters<typeof PlainConfig>[0]));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('invalid-config-shape');
  }
}

export function selectPersonality(config: PluginConfig, type: 'group' | 'private', conversationId: string): Personality {
  const bindings = type === 'group' ? config.bindings.groups : config.bindings.privateUsers;
  const selected = bindings.find(b => b.id === conversationId)?.personalityId ?? config.bindings.defaultPersonalityId;
  const result = config.personalities.find(p => p.id === selected);
  if (!result) throw new ConfigurationError('unknown-bound-personality');
  return result;
}
