// Called ONLY inside real-knowledge.ts's DSH_HOME-isolated child, never by the Host.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { OwnerLock } from '../../src/storage/owner.js';
import { LEDGER_DOMAIN, controlDomainSpec } from '../../src/storage/domains.js';
import { OwnedSqliteBackend } from '../../src/storage/sqlite.js';
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain';
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
import NodeWebSocket, { WebSocketServer as NodeWebSocketServer } from 'ws';
import { parseConfig, STAGES } from '../../src/config.js';
import { decodePluginDocument, type PublicKnowledgeService } from '../../src/memory/knowledge.js';
import { ACTIVATION_VERIFIED, openOwnedRuntime, type OwnedRuntime } from '../../src/runtime/bootstrap.js';
import type { CurrentConfiguration } from '../../src/runtime/configuration.js';
import { ConfigurationObservations } from '../../src/runtime/observations.js';
import * as nativePlugin from '../../src/index.js';

const DEADLINE_MS = 10_000;
async function deadline<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`native pipeline deadline: ${label}`)), DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + DEADLINE_MS;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`native pipeline deadline: ${label}`);
    await pause(20);
  }
}
interface Action { action: string; echo: string; params: Record<string, unknown> }

/** Real owned domains, client, policy, online/outbox and retention against borrowed real knowledge.
 * privateDirectoryReady is an isolated-fixture precondition, NOT an owner-only Windows ACL certificate.
 * Verified factory and native plugin-entry lifecycles use isolated public services; default stays disabled.
 */
export async function exerciseNativePipeline(ctx: Context, root: string, knowledge: PublicKnowledgeService): Promise<void> {
  assert.ok(isAbsolute(root)); assert.equal(realpathSync.native(root), root);
  assert.equal(process.env.DSH_HOME, root, 'caller must isolate DSH_HOME before loading real knowledge');
  assert.equal(process.env.DSH_PROFILE_DIR, join(root, 'profile'));
  // Cordis may return context-bound service proxies; reference equality is not its public contract.
  // Public document readback below proves the factory used the same isolated persistent service.
  assert.ok(ctx.get('knowledge'));
  assert.equal(ACTIVATION_VERIFIED, true);
  assert.equal(parseConfig().onebot.enabled, false, 'release verification never opts in by default');
  await deadline(knowledge.whenReady(), 'borrowed knowledge ready');
  const beforeDocumentIds = new Set(knowledge.listBases().flatMap(base => knowledge.listDocuments(base.id).map(doc => doc.id)));
  const calls: string[] = [];
  const literalReply = 'Native pipeline reply: literal [CQ:at,qq=all] & [CQ:image,file=fixture] 中文';
  const fakeLlm: Pick<LlmRuntime, 'resolveCallConfig' | 'prepareCall'> = {
    async resolveCallConfig(config, signal) {
      signal?.throwIfAborted(); assert.equal(config.provider, 'mock');
      assert.ok(STAGES.some(stage => stage === config.model));
      return config;
    },
    async prepareCall(config, signal) {
      signal?.throwIfAborted(); assert.equal(config.provider, 'mock');
      return { config, context: { contextWindow: 1_000_000 }, adapterDefaults: {},
        retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
          options.signal?.throwIfAborted();
          assert.equal('tools' in options, false, 'no model tools are exposed');
          assert.ok(['router', 'reply', 'retain'].includes(config.model), 'no recall/reflect or hidden model call');
          calls.push(config.model);
          const text = config.model === 'router' ? '{"mode":"chat"}'
            : config.model === 'retain' ? '{"facts":[]}' : literalReply;
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };
  const unprovideLlm = ctx.provide('llm', fakeLlm);
  const unprovideDefaultModel = ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'reply' }),
  });
  const server = new NodeWebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  const listening = once(server, 'listening');
  const sockets: NodeWebSocket[] = [];
  const actions: Action[] = [];
  const sent: Action[] = [];
  let gatewayFailure: unknown;
  const failGateway = (error: unknown): void => { gatewayFailure ??= error; };
  const checkGateway = (): void => { if (gatewayFailure) throw gatewayFailure; };
  server.on('error', failGateway);
  server.on('connection', (socket, request) => {
    sockets.push(socket); socket.on('error', failGateway);
    try {
      assert.equal(request.headers.authorization, 'Bearer native-pipeline-fixture-token');
      assert.equal(request.url, '/onebot-v11');
    } catch (error) { failGateway(error); socket.terminate(); return; }
    socket.on('message', (data, binary) => {
      try {
        assert.equal(binary, false); assert.ok(Buffer.isBuffer(data));
        const requestAction = JSON.parse(data.toString('utf8')) as Action;
        assert.equal(typeof requestAction.echo, 'string'); assert.ok(requestAction.echo.length > 0);
        actions.push(requestAction);
        let result: Record<string, unknown>;
        switch (requestAction.action) {
          case 'get_login_info':
            assert.deepEqual(requestAction.params, {}); result = { user_id: 10001 }; break;
          case 'get_group_member_info':
            assert.deepEqual(requestAction.params, { group_id: '30003', user_id: '20002', no_cache: true });
            result = { group_id: 30003, user_id: 20002 }; break;
          case 'send_group_msg':
            assert.deepEqual(requestAction.params, { group_id: '30003', message: [{ type: 'text', data: { text: literalReply } }] });
            sent.push(requestAction); result = { message_id: 70001 }; break;
          default: throw new Error('unexpected native pipeline gateway action');
        }
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: requestAction.echo, data: result }), error => {
          if (error) failGateway(error);
        });
      } catch (error) { failGateway(error); socket.terminate(); }
    });
  });
  const external = new AbortController();
  let scopeLive = true;
  let owned: OwnedRuntime | undefined;
  let opening: Promise<OwnedRuntime> | undefined;
  let injected: ReturnType<Context['inject']> | undefined;
  let dependencies: Context | undefined;
  try {
    const ready = new Promise<Context>(resolve => {
      injected = ctx.inject(['storage', 'llm', 'agentDefaultModel', 'knowledge'], child => { resolve(child); });
    });
    dependencies = await deadline(ready, 'native dependency callback');
    await deadline(listening, 'loopback gateway listen');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1'); assert.ok(address.port > 0);
    const config = parseConfig({
      onebot: { enabled: true, wsUrl: `ws://127.0.0.1:${address.port}/onebot-v11`, expectedSelfId: '10001',
        token: 'native-pipeline-fixture-token', connectTimeoutMs: 5_000, actionTimeoutMs: 5_000 },
      persistence: { directory: join(root, 'personality-control'), privateDirectoryReady: true },
      allow: { groupIds: ['30003'] },
      models: Object.fromEntries(STAGES.map(stage => [stage, { selection: 'explicit', provider: 'mock', model: stage }])),
    });
    let current: CurrentConfiguration = Object.freeze({ config, revision: 'native-pipeline-isolated-v1' });
    const reader = () => current;
    const open = async (): Promise<OwnedRuntime> => {
      // Liveness and the outer finally disposer exist before this asynchronous resource factory starts.
      assert.ok(dependencies);
      const dependency = dependencies;
      opening = openOwnedRuntime(dependency, reader, external.signal,
        () => scopeLive && (dependency.fiber.state === 1 || dependency.fiber.state === 2), undefined, current);
      owned = await deadline(opening, 'owned native runtime startup');
      opening = undefined;
      return owned;
    };
    const first = await open();
    await until(() => { checkGateway(); return first.session.getStatus().transport.state === 'ready'; }, 'native identity ready');
    assert.equal(sockets.length, 1);
    assert.equal(actions[0]?.action, 'get_login_info');
    assert.deepEqual(calls, []); assert.equal(sent.length, 0);
    const name = config.personalities[0]!.name;
    const inboundText = `${name} hello`;
    const socket = sockets[0]!;
    await deadline(new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify({ post_type: 'message', self_id: 10001, message_type: 'group', group_id: 30003,
        user_id: 20002, message_id: 60001, time: Math.floor(Date.now() / 1000),
        message: [{ type: 'text', data: { text: inboundText } }] }), error => { if (error) reject(error); else resolve(); });
    }), 'inbound gateway message');
    await until(() => {
      checkGateway(); const status = first.session.getStatus();
      return sent.length === 1 && (status.tasks.done ?? 0) >= 2
        && status.banks.reduce((sum, bank) => sum + bank.activeMemories, 0) >= 2;
    }, 'confirmed send plus raw and experience retention');
    const status = first.session.getStatus();
    assert.equal(status.rejectedEvents, 0); assert.equal(status.storage.state, 'ready');
    assert.deepEqual(status.errorCodes, []); assert.deepEqual(status.workers.errorCodes, []);
    assert.equal(sent.length, 1);
    // Current-group-only input needs no cross-group membership proof; the native member API has its own transport test.
    assert.equal(actions.filter(value => value.action === 'get_group_member_info').length, 0);
    assert.equal(calls.filter(stage => stage === 'router').length, 1);
    assert.equal(calls.filter(stage => stage === 'reply').length, 1);
    assert.equal(calls.filter(stage => stage === 'retain').length, 2);
    assert.ok(calls.every(stage => ['router', 'reply', 'retain'].includes(stage)));
    const documents = knowledge.listBases().flatMap(base => knowledge.listDocuments(base.id))
      .filter(doc => !beforeDocumentIds.has(doc.id));
    assert.ok(documents.length >= 2, 'real public KnowledgeService contains raw and confirmed-experience documents');
    const texts = documents.map(doc => {
      const detail = knowledge.getDocument(doc.id, { includeChunks: false });
      assert.equal(typeof detail.rawText, 'string');
      return decodePluginDocument(doc.title, detail.rawText!).text;
    });
    assert.ok(texts.some(text => text.includes(inboundText)), 'real raw evidence persisted');
    assert.ok(texts.some(text => text.includes(literalReply)), 'real confirmed experience persisted');
    const firstClosed = deadline(once(socket, 'close'), 'first runtime websocket close');
    await deadline(first.close(), 'first owned runtime close'); owned = undefined;
    await firstClosed;
    assert.equal(first.session.getStatus().workers.state, 'stopped');
    assert.equal(first.session.getStatus().transport.state, 'stopped');
    assert.ok(knowledge.listBases().length > 0, 'owned runtime never closes borrowed knowledge');

    const completedCalls = [...calls]; const completedDone = status.tasks.done ?? 0;
    const second = await open();
    await until(() => {
      checkGateway(); const cold = second.session.getStatus();
      return cold.transport.state === 'ready' && (cold.tasks.done ?? 0) >= completedDone
        && cold.banks.reduce((sum, bank) => sum + bank.activeMemories, 0) >= 2;
    }, 'cold native runtime recovers committed tasks and memories');
    assert.equal(sockets.length, 2);
    assert.deepEqual(calls, completedCalls, 'cold recovery does not regenerate old model work');
    assert.equal(sent.length, 1, 'cold recovery does not replay the confirmed send');
    const secondClosed = deadline(once(sockets[1]!, 'close'), 'cold runtime websocket close');
    await deadline(second.close(), 'cold owned runtime close'); owned = undefined;
    await secondClosed;
    checkGateway();
    assert.deepEqual(calls, completedCalls); assert.equal(sent.length, 1);
    assert.ok(knowledge.listBases().length > 0, 'borrowed public knowledge remains usable after both closes');

    // Actual native entry, not a direct resource factory: Cordis adapts the public root Volatile
    // schema and injects the real isolated services. Explicit enablement still targets ONLY loopback.
    assert.equal(ctx.get('onebotPersonality'), undefined);
    const entryDirectory = join(root, 'native-entry-control');
    const entrySocketOffset = sockets.length; const entryActionOffset = actions.length;
    const entryBackends = dependencies.storage.backend.names().sort();
    const entryFiber = ctx.plugin(nativePlugin, { ...config,
      persistence: { ...config.persistence, directory: entryDirectory } });
    let entryDisposed = false;
    try {
      await deadline(entryFiber.await(), 'native plugin entry fiber active');
      await until(() => {
        checkGateway(); const entry = ctx.get('onebotPersonality')?.getStatus();
        return entry?.implementation === 'verified' && entry.state === 'running'
          && entry.runtime?.transport.state === 'ready';
      }, 'native plugin entry host and transport ready');
      const service = ctx.get('onebotPersonality'); assert.ok(service);
      const entry = service.getStatus();
      assert.equal(entry.implementation, 'verified'); assert.equal(entry.state, 'running');
      assert.equal(entry.code, 'runtime-running'); assert.ok(entry.runtime);
      assert.equal(entry.runtime.phase, 'running'); assert.equal(entry.runtime.storage.state, 'ready');
      assert.equal(entry.runtime.transport.state, 'ready'); assert.equal(entry.runtime.rejectedEvents, 0);
      assert.deepEqual(entry.runtime.tasks, {}); assert.deepEqual(entry.runtime.banks, []);
      assert.deepEqual(entry.runtime.errorCodes, []); assert.deepEqual(entry.runtime.workers.errorCodes, []);
      for (const name of ['storage', 'llm', 'agentDefaultModel', 'knowledge'] as const) assert.ok(ctx.get(name));
      assert.equal(sockets.length, entrySocketOffset + 1, 'native entry opens its own loopback connection');
      assert.deepEqual(actions.slice(entryActionOffset).map(action => action.action), ['get_login_info']);
      assert.deepEqual(calls, completedCalls); assert.equal(sent.length, 1);
      const entrySocket = sockets[entrySocketOffset]!;
      const entryClosed = once(entrySocket, 'close');
      void entryClosed.catch(() => {}); // Outer gateway teardown drains the socket on any failed assertion.
      await deadline(entryFiber.dispose(), 'native plugin entry dispose'); entryDisposed = true;
      assert.equal(ctx.get('onebotPersonality'), undefined, 'native entry withdraws its public service');
      await deadline(entryClosed, 'native plugin entry websocket close accepted');
      assert.equal(entrySocket.readyState, NodeWebSocket.CLOSED);
      assert.deepEqual(dependencies.storage.backend.names().sort(), entryBackends, 'entry unregisters only its owned backend');
      const releasedOwner = await OwnerLock.acquire(join(entryDirectory, 'owner.sqlite'));
      await releasedOwner.close(); // Real factory teardown released ownership; never force-unlock anything.
      await deadline(knowledge.whenReady(), 'borrowed knowledge after native entry dispose');
      assert.ok(knowledge.listBases().length > 0, 'native entry never closes borrowed real knowledge');
      assert.deepEqual(calls, completedCalls); assert.equal(sent.length, 1); checkGateway();
    } finally {
      if (!entryDisposed) await deadline(entryFiber.dispose(), 'finally native plugin entry dispose');
    }

    // Separate real factory close-tail case: its quarantined owner cannot block the ledger-busy case.
    // candidateRootNoClock/fault retention proves ACTUALLY OBSERVED metadata, not whole offline history.
    const lateConfig = parseConfig({ ...config, persistence: { ...config.persistence,
      directory: join(root, 'personality-close-tail-control') } });
    let lateCurrent: CurrentConfiguration = Object.freeze({ config: lateConfig, revision: 'native-close-tail-A' });
    const journal = new ConfigurationObservations();
    const registry = dependencies.storage.backend;
    const originalRegister = registry.register;
    let wrappedBackend: OwnedSqliteBackend | undefined;
    let originalBackendClose: OwnedSqliteBackend['close'] | undefined;
    let closeTailArmed = false; let closeTailObserved = false; let registrations = 0;
    const lateOwnerFile = join(lateConfig.persistence.directory, 'owner.sqlite');
    try {
      // Public SDK registry seam only. Never unwrap a ContextualProxy or access Host/knowledge internals.
      registry.register = (backendId, backend) => {
        if (/^onebot_personality_[a-f0-9_]+$/.test(backendId)) {
          assert.equal(++registrations, 1, 'intercept only this next factory-owned backend');
          assert.ok(backend instanceof OwnedSqliteBackend);
          wrappedBackend = backend; originalBackendClose = backend.close;
          const originalClose = backend.close;
          backend.close = async () => {
            await originalClose.call(backend);
            if (!closeTailArmed) return;
            // bootstrap reaches backend.close ONLY after domains/repository.close. This is the real
            // owned backend, now closed, while the real SQLite owner must still exclude another owner.
            await assert.rejects(backend.kv.open(descriptorOf(controlDomainSpec)), { code: 'closed' });
            await assert.rejects(OwnerLock.acquire(lateOwnerFile), /OWNER_BUSY/);
            assert.equal(journal.getStatus().pending, 0, 'pre-close observation flush already drained');
            lateCurrent = Object.freeze({ config: parseConfig({ ...lateConfig,
              allow: { groupIds: [], privateUserIds: [] } }), revision: 'native-close-tail-B' });
            journal.observe(lateCurrent); // B is actually observed AFTER repository/backend close.
            lateCurrent = Object.freeze({ config: lateConfig, revision: 'native-close-tail-C' });
            journal.observe(lateCurrent); // Reallowing G cannot erase the unflushed withdrawal B.
            assert.equal(journal.getStatus().observedPolicies, 3);
            assert.equal(journal.getStatus().pending, 2);
            closeTailObserved = true;
          };
        }
        return originalRegister.call(registry, backendId, backend);
      };
      const dependency = dependencies;
      const lateSocketOffset = sockets.length;
      opening = openOwnedRuntime(dependency, () => lateCurrent, external.signal,
        () => scopeLive && (dependency.fiber.state === 1 || dependency.fiber.state === 2), undefined, lateCurrent, journal);
      owned = await deadline(opening, 'close-tail native runtime startup'); opening = undefined;
      const late = owned;
      await until(() => { checkGateway(); return late.session.getStatus().transport.state === 'ready'; }, 'close-tail native ready');
      assert.equal(registrations, 1); assert.equal(sockets.length, lateSocketOffset + 1);
      assert.deepEqual(calls, completedCalls); assert.equal(sent.length, 1);
      assert.equal(journal.getStatus().observedPolicies, 1); assert.equal(journal.getStatus().pending, 0);
      const lateClosed = once(sockets[lateSocketOffset]!, 'close');
      void lateClosed.catch(() => {}); // The outer finally also drains this socket on an assertion failure.
      closeTailArmed = true;
      await assert.rejects(deadline(late.close(), 'close-tail owned runtime close'), {
        message: 'withdrawal-audit-incomplete-owner-held',
      });
      owned = undefined; // Expected rejected close is quarantined, never replayed by the outer finally.
      await deadline(lateClosed, 'close-tail runtime websocket close');
      assert.equal(closeTailObserved, true, 'late B/C injection really ran after real backend close');
      assert.equal(journal.getStatus().pending, 2, 'closed repository never acknowledges late B/C');
      await assert.rejects(OwnerLock.acquire(lateOwnerFile), /OWNER_BUSY/);
      assert.deepEqual(calls, completedCalls); assert.equal(sent.length, 1); checkGateway();
    } finally {
      registry.register = originalRegister;
      if (wrappedBackend && originalBackendClose) wrappedBackend.close = originalBackendClose;
    }

    // Native fault injection targets ONLY this test-owned plugin ledger, never knowledge's private DB.
    const third = await open();
    await until(() => third.session.getStatus().transport.state === 'ready', 'fault-case native ready');
    const blocker = new DatabaseSync(join(config.persistence.directory, `${LEDGER_DOMAIN}.sqlite`));
    try {
      blocker.exec('BEGIN EXCLUSIVE');
      current = Object.freeze({ config: parseConfig({ ...config, allow: { groupIds: [], privateUserIds: [] } }), revision: 'observed-native-withdrawal-B' });
      third.session.getStatus(); // Observe B while its durable audit cannot acquire the ledger write lock.
      await assert.rejects(third.close(), /withdrawal-audit-incomplete-owner-held/);
      owned = undefined; // Its rejected close remains intentionally quarantined; don't replay it in finally.
      await assert.rejects(OwnerLock.acquire(join(config.persistence.directory, 'owner.sqlite')), /OWNER_BUSY/);
      assert.deepEqual(calls, completedCalls); assert.equal(sent.length, 1);
    } finally {
      if (blocker.isTransaction) blocker.exec('ROLLBACK'); blocker.close();
    }
    assert.equal(ACTIVATION_VERIFIED, true);
  } finally {
    scopeLive = false; external.abort();
    try {
      if (owned) await deadline(owned.close(), 'finally owned runtime close');
      if (opening) await deadline(opening.then(handle => handle.close(), () => {}), 'late startup ownership drain');
    } finally {
      try {
        const closedClients = [...server.clients].map(socket => {
          if (socket.readyState === NodeWebSocket.CLOSED) return Promise.resolve();
          const closed = once(socket, 'close'); socket.terminate(); return closed.then(() => {});
        });
        const closedServer = new Promise<void>((resolve, reject) => {
          server.close(error => { if (error) reject(error); else resolve(); });
        });
        await deadline(Promise.all([...closedClients, closedServer]), 'all gateway clients and server close');
        assert.equal(server.clients.size, 0); assert.equal(server.address(), null);
      } finally { await injected?.dispose(); await unprovideDefaultModel(); await unprovideLlm(); }
    }
  }
}
