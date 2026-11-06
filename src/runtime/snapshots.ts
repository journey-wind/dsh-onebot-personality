import { STAGES } from '../config.js';
import { freezeDeep } from '../llm/routes.js';
import type { ConfigSnapshot, FiveRoutes } from '../llm/routes.js';
import { snapshotSchema } from '../storage/model.js';
import { RuntimeError } from './configuration.js';

/** Validate durable JSON and normalize optional fields without weakening exactOptionalPropertyTypes. */
export function materializeSnapshot(value: unknown): ConfigSnapshot {
  try {
    const parsed = snapshotSchema.parse(value);
    const routes = {} as FiveRoutes;
    for (const stage of STAGES) {
      const route = parsed.routes[stage];
      routes[stage] = { provider: route.provider, model: route.model,
        maxOutputTokens: route.maxOutputTokens, timeoutMs: route.timeoutMs,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) };
    }
    return freezeDeep({ id: parsed.id, personality: parsed.personality, routes,
      budgets: parsed.budgets, memory: parsed.memory, configRevision: parsed.configRevision,
      promptVersion: parsed.promptVersion, createdAt: parsed.createdAt });
  } catch { throw new RuntimeError('invalid-persisted-snapshot'); }
}
