import { parseConfig, selectPersonality, STAGES } from '../../src/config.js';
import { inheritRoute } from '../../src/llm/routes.js';
import type { FiveRoutes } from '../../src/llm/routes.js';
import { normalizeMessageEvent } from '../../src/onebot/protocol.js';
import { emptyControlState, emptyLedger } from '../../src/storage/model.js';
import { ControlRepository } from '../../src/storage/repository.js';
import type { DurableCell } from '../../src/storage/repository.js';
import { ConfigurationCoordinator } from '../../src/runtime/configuration.js';
import { Ingress, inboundBodyHash } from '../../src/runtime/ingress.js';
import type { VerifiedIdentity } from '../../src/runtime/ingress.js';

/** Test double only. Never used by any production module. */
export class FaultCell<T> implements DurableCell<T> {
  value: T;
  commits = 0;
  failAtCommit = -1;
  constructor(value: T) { this.value = structuredClone(value); }
  get(): T { return structuredClone(this.value); }
  async set(value: T): Promise<void> {
    if (this.commits + 1 === this.failAtCommit) throw new Error('simulated secret provider detail');
    this.commits++;
    this.value = structuredClone(value);
  }
}

export async function runtimeFixture(input: Record<string, unknown> = {}) {
  const control = new FaultCell(emptyControlState());
  const ledger = new FaultCell(emptyLedger());
  const owner = { ownerId: 'test-owner', isHeld: () => true };
  const repository = await ControlRepository.open(control, ledger, owner);
  let current = { config: parseConfig({
    onebot: { enabled: true, expectedSelfId: '100' }, allow: { groupIds: ['300'], privateUserIds: ['200'] }, ...input,
  }), revision: 'config-1' };
  let revision = 1;
  let identity: VerifiedIdentity | undefined = { selfId: '100', connectionEpoch: 'epoch-1' };
  // Align the initial epoch with StageCaller/CallBudget's real clock; advance remains explicit.
  let now = Date.now();
  let disk = async () => 1_000_000_000_000;
  let routeHook = async () => {};
  let routeCalls = 0;
  const abort = new AbortController();
  const coordinator = new ConfigurationCoordinator(repository, () => current);
  await coordinator.apply(current);
  const ingress = new Ingress(repository, {
    readConfiguration: () => current, readIdentity: () => identity, availableDiskBytes: () => disk(), signal: abort.signal,
    resolveRoutes: async (config, persona, signal) => {
      routeCalls++;
      await routeHook();
      signal.throwIfAborted();
      return Object.fromEntries(STAGES.map(stage => [stage,
        inheritRoute(persona.models[stage], config.models[stage], { provider: 'mock', model: stage }, stage),
      ])) as FiveRoutes;
    },
  });
  function message(overrides: Record<string, unknown> = {}) {
    const raw = { post_type: 'message', self_id: '100', message_type: 'group', group_id: '300', user_id: '200',
      message_id: '1', time: Math.floor(now / 1000), message: [{ type: 'text', data: { text: 'ordinary message' } }], ...overrides };
    const normalized = normalizeMessageEvent(raw, { expectedSelfId: '100', knownSecrets: current.config.onebot.token ? [current.config.onebot.token] : [] });
    if (!normalized) throw new Error('test message unexpectedly ignored');
    return { raw, normalized, hash: inboundBodyHash(raw.message) };
  }
  return {
    repository, control, ledger, ingress, coordinator, abort,
    get current() { return current; }, get now() { return now; }, get routeCalls() { return routeCalls; },
    advance(ms: number) { now += ms; },
    setIdentity(next: VerifiedIdentity | undefined) { identity = next; },
    setDiskProbe(next: () => Promise<number>) { disk = next; },
    setRouteHook(next: () => Promise<void>) { routeHook = next; },
    async changeConfiguration(next: unknown) {
      current = { config: parseConfig(next), revision: `config-${++revision}` };
      await coordinator.apply(current);
    },
    message,
    async admit(overrides: Record<string, unknown> = {}) {
      const value = message(overrides);
      return ingress.accept(value.normalized, value.hash, now);
    },
    personality(type: 'group' | 'private' = 'group', id = '300') { return selectPersonality(current.config, type, id); },
  };
}
