import { createHash, randomUUID } from 'node:crypto';
import type { LlmRuntime, LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { STAGES, STAGE_DEFAULTS, validateSlot } from '../config.js';
import type { Stage, ModelSlot, PluginConfig, Personality } from '../config.js';

export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ResolvedRoute extends ModelSelection { maxOutputTokens: number; timeoutMs: number }
export type FiveRoutes = Record<Stage, ResolvedRoute>;
export interface ConfigSnapshot {
  id: string;
  personality: Personality;
  routes: FiveRoutes;
  budgets: PluginConfig['budgets'];
  memory: PluginConfig['memory'];
  configRevision: string;
  promptVersion: string;
  createdAt: number;
}

/** Stable JSON hash, versioned by its caller. Never hash/store a configuration containing secrets. */
export function fingerprint(value: unknown): string {
  const encode = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(encode);
    return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, encode(v)]));
  };
  return createHash('sha256').update(JSON.stringify(encode(value)), 'utf8').digest('hex');
}

export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** A provider/model pair is inherited atomically. Budgets inherit field-by-field. */
export function inheritRoute(personal: ModelSlot, global: ModelSlot, defaultSelection: ModelSelection, stage: Stage): ResolvedRoute {
  validateSlot(personal);
  validateSlot(global);
  const route = personal.selection === 'explicit' ? personal
    : global.selection === 'explicit' ? global : defaultSelection;
  if (!route.provider.trim() || !route.model.trim()) throw new Error('default-model-unavailable');
  // Changing a route discards lower-model effort, while an inherit layer can explicitly override it.
  const lowerEffort = global.selection === 'explicit' ? global.reasoningEffort
    : global.reasoningEffort || defaultSelection.reasoningEffort;
  const effort = personal.selection === 'explicit' ? personal.reasoningEffort
    : personal.reasoningEffort || lowerEffort;
  return {
    provider: route.provider, model: route.model,
    ...(effort ? { reasoningEffort: effort } : {}),
    maxOutputTokens: personal.maxOutputTokens || global.maxOutputTokens || STAGE_DEFAULTS[stage].maxOutputTokens,
    timeoutMs: personal.timeoutMs || global.timeoutMs || STAGE_DEFAULTS[stage].timeoutMs,
  };
}

export function toCallConfig(route: ResolvedRoute): LlmCallConfig {
  return {
    provider: route.provider, model: route.model, maxTokens: route.maxOutputTokens,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort as ReasoningEffortId } : {}),
  };
}

/** Resolves all five concrete routes at ingress; no credential or WS configuration is copied. */
export async function resolveFiveRoutes(
  llm: Pick<LlmRuntime, 'resolveCallConfig'>, config: PluginConfig, personality: Personality,
  selection: ModelSelection, signal?: AbortSignal,
): Promise<FiveRoutes> {
  const routes = {} as FiveRoutes;
  for (const stage of STAGES) {
    signal?.throwIfAborted();
    const route = inheritRoute(personality.models[stage], config.models[stage], selection, stage);
    const resolved = await llm.resolveCallConfig(toCallConfig(route), signal);
    if (resolved.provider !== route.provider || resolved.model !== route.model || resolved.maxTokens !== route.maxOutputTokens) {
      throw new Error('resolved-route-or-budget-changed');
    }
    routes[stage] = {
      provider: route.provider, model: route.model,
      maxOutputTokens: route.maxOutputTokens, timeoutMs: route.timeoutMs,
      ...(resolved.reasoningEffort ? { reasoningEffort: String(resolved.reasoningEffort) } : {}),
    };
  }
  return freezeDeep(routes);
}

export function createSnapshot(config: PluginConfig, personality: Personality, routes: FiveRoutes, configRevision: string): ConfigSnapshot {
  return freezeDeep(structuredClone({
    id: randomUUID(), personality, routes, budgets: config.budgets, memory: config.memory,
    configRevision, promptVersion: 'onebot-personality-prompts-v1', createdAt: Date.now(),
  }));
}
