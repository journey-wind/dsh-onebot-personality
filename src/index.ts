import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { PluginConfig } from './config.js';
import { ACTIVATION_VERIFIED, openOwnedRuntime } from './runtime/bootstrap.js';
import { RuntimeError } from './runtime/configuration.js';
import { HostController } from './runtime/host.js';
import type { HostStatus } from './runtime/host.js';
import { configurationReader } from './runtime/reference.js';
import { ProviderQuota } from './runtime/quota.js';
import { ConfigurationObservations } from './runtime/observations.js';

export { Config } from './config.js';
export const name = 'onebot-personality';
export interface PluginStatus extends HostStatus { implementation: 'development' | 'verified' }
export interface OneBotPersonalityService {
  getStatus(): PluginStatus;
  retryRetain(taskId: string): Promise<void>;
  forgetBySource(sourceId: string, operationId?: string): ReturnType<HostController['forgetBySource']>;
  forgetByAuthor(target: { botId: string; personalityId: string; qqId: string }, operationId?: string): ReturnType<HostController['forgetByAuthor']>;
  getForgetStatus(operationId: string): ReturnType<HostController['getForgetStatus']>;
}
declare module '@deepseek-ai/cordis' { interface Context { onebotPersonality: OneBotPersonalityService } }

// Public Cordis4.0.5 FiberState ABI: LOADING=1, ACTIVE=2. Ambient const enums cannot
// be imported as runtime values with verbatimModuleSyntax; pin/check the supported SDK.
function live(ctx: Context): boolean { return ctx.fiber.state === 1 || ctx.fiber.state === 2; }

/** Native metadata surface is always available. Runtime stays refused until actual release verification.
 * Injected callback scope owns the ONE ordered disposer; no shared Host service is closed. */
export function apply(ctx: Context, reference: Volatile<PluginConfig>): void {
  const observations = new ConfigurationObservations();
  const rawRead = configurationReader(reference);
  const read = () => { const current = rawRead(); observations.observe(current); return current; };
  if (read().config.onebot.enabled && !ACTIVATION_VERIFIED) throw new RuntimeError('development-verification-required');
  let controller: HostController | undefined;
  const requireController = () => {
    if (!controller || !live(ctx)) throw new RuntimeError('host-runtime-not-active');
    return controller;
  };
  const service: OneBotPersonalityService = {
    getStatus: () => {
      try {
        const current = read(); controller?.observeConfiguration(current);
        const implementation = ACTIVATION_VERIFIED ? 'verified' as const : 'development' as const;
        if (!current.config.onebot.enabled) return { state: 'disabled', implementation, code: 'disabled-by-configuration' };
        if (!ACTIVATION_VERIFIED) return { state: 'blocked', implementation, code: 'development-verification-required' };
        return { ...(controller?.getStatus() ?? { state: 'blocked' as const, code: 'waiting-required-services' }), implementation };
      } catch { return { state: 'blocked', implementation: ACTIVATION_VERIFIED ? 'verified' : 'development', code: 'invalid-current-configuration' }; }
    },
    retryRetain: async taskId => requireController().retryRetain(taskId),
    forgetBySource: async (sourceId, operationId) => requireController().forgetBySource(sourceId, operationId),
    forgetByAuthor: async (target, operationId) => requireController().forgetByAuthor(target, operationId),
    getForgetStatus: operationId => requireController().getForgetStatus(operationId),
  };
  ctx.provide('onebotPersonality', service);
  if (!ACTIVATION_VERIFIED) return; // No dependencies, timer, socket, model, DB or HTTP endpoint in development hold.
  ctx.inject(['storage', 'llm', 'agentDefaultModel', 'knowledge'], depCtx => {
    depCtx.effect(() => {
      const scopeLive = () => live(ctx) && live(depCtx);
      const quota = new ProviderQuota({ readLimits: () => read().config.budgets });
      const instance = new HostController({ readConfiguration: read, isScopeLive: scopeLive,
        activationVerified: ACTIVATION_VERIFIED, observations,
        open: (observed, signal, journal) => openOwnedRuntime(depCtx, read, signal, scopeLive, quota, observed, journal) });
      controller = instance;
      instance.start(); // Schedules only; resource acquisition cannot precede registering this synchronous disposer.
      return () => {
        const closing = instance.stop(); // Abort/fence prefix executes now, before the returned async close chain.
        return closing.finally(() => { quota.stop(); if (controller === instance) controller = undefined; });
      };
    });
  });
}
