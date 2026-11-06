import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';

// Compiled location: dist/tests -> repository/scripts. Never targets a real SnowLuma/profile.
const scriptUrl = new URL('../../scripts/probe-snowluma.mjs', import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const PRIVATE_TOKEN = 'PRIVATE_SENTINEL_TOKEN_7e3';
const PRIVATE_BODY = 'PRIVATE_SENTINEL_RAW_QQ_BODY_2a9';
const UNKNOWN_POST_TYPE = 'PRIVATE_SENTINEL_UNKNOWN_POST_TYPE';
const SELF_ID = '10001';
type ProbeModule = {
  validateConfig(config: unknown, options: Record<string, unknown>): Record<string, unknown>;
  loadTargetFromConfig(path: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  parseArgs(argv: string[]): Record<string, unknown>;
};
const loadModule = async (): Promise<ProbeModule> => await import(scriptUrl.href) as ProbeModule;
const hasCode = (code: string) => (error: unknown): boolean =>
  error instanceof Error && error.message === code && (error as Error & { code?: string }).code === code;
const config = (port = 3001) => ({ networks: { wsServers: [{
  name: 'ws-default', host: '127.0.0.1', port, path: '/', role: 'Universal',
  messageFormat: 'array', accessToken: PRIVATE_TOKEN,
}], wsClients: [{ name: 'untouched-reverse-fixture', port: 6199 }] } });

interface Summary {
  state: string; code: string; authentication: string; expectedSelfId?: string; verifiedSelfId?: string;
  endpoint?: string; eventCount: number;
  counts: { message: { group: number; private: number; other: number }; notice: number; request: number; meta_event: number; other: number };
}
async function cli(t: TestContext, args: string[], afterSpawn?: (child: ReturnType<typeof spawn>) => void) {
  const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; if (stdout.length > 65_536) child.kill(); });
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; if (stderr.length > 65_536) child.kill(); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const timer = setTimeout(() => child.kill(), 8_000);
  const closed = once(child, 'close');
  afterSpawn?.(child);
  let result: unknown[];
  try { result = await closed; } finally { clearTimeout(timer); }
  assert.equal(stderr, '', 'probe emits no raw diagnostics, credentials, paths or stack traces');
  assert.ok(stdout.length < 65_536);
  assert.equal(stdout.trim().split('\n').length, 1, 'one JSON summary, not an event stream');
  for (const secret of [PRIVATE_TOKEN, PRIVATE_BODY, UNKNOWN_POST_TYPE, 'PRIVATE_SENTINEL_NICKNAME', 'PRIVATE_SENTINEL_REFUSAL']) {
    assert.equal(stdout.includes(secret), false, 'private fixture values must not appear in metadata');
  }
  assert.equal(stdout.includes('user:password'), false);
  assert.equal(stdout.includes('access_token='), false);
  return { code: result[0], signal: result[1], summary: JSON.parse(stdout) as Summary, stdout };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'snowluma-probe-'));
  const configPath = join(directory, `onebot_${SELF_ID}.json`);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  const actions: string[] = [];
  const authorizations: (string | undefined)[] = [];
  server.on('connection', (socket, request) => {
    socket.on('error', () => {});
    authorizations.push(request.headers.authorization);
    socket.on('message', data => {
      const action = JSON.parse(data.toString()) as { action: string };
      actions.push(action.action);
    });
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    assert.equal(server.clients.size, 0);
    assert.equal(server.address(), null);
    // Verify the exact owned temporary target before recursive deletion.
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('snowluma-probe-'));
    assert.equal(dirname(configPath), directory);
    await rm(directory, { recursive: true, force: true });
    await assert.rejects(access(directory));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const privateConfig = JSON.stringify(config(address.port));
  await writeFile(configPath, privateConfig, { mode: 0o600 });
  return { server, actions, authorizations, configPath, privateConfig, port: address.port };
}

function replyAndEvents(f: Awaited<ReturnType<typeof fixture>>, mode: 'ok' | 'mismatch' | 'refusal' | 'disconnect' | 'idle') {
  f.server.on('connection', socket => socket.on('message', data => {
    const action = JSON.parse(data.toString()) as { action: string; echo: string; params: unknown };
    if (action.action !== 'get_login_info') return;
    assert.deepEqual(action.params, {});
    if (mode === 'idle') return;
    socket.send(JSON.stringify(mode === 'refusal' ? {
      status: 'failed', retcode: 1401, echo: action.echo, wording: 'PRIVATE_SENTINEL_REFUSAL', data: {},
    } : {
      status: 'ok', retcode: 0, echo: action.echo,
      data: { user_id: mode === 'mismatch' ? 99999 : Number(SELF_ID), nickname: 'PRIVATE_SENTINEL_NICKNAME' },
    }));
    if (mode === 'mismatch' || mode === 'refusal') return;
    const base = { self_id: Number(SELF_ID), user_id: 888888, group_id: 777777, message_id: 666666,
      raw_message: PRIVATE_BODY, message: [{ type: 'text', data: { text: PRIVATE_BODY } }],
      url: `ws://user:password@127.0.0.1/?access_token=${PRIVATE_TOKEN}` };
    for (const event of [
      { post_type: 'message', message_type: 'group' }, { post_type: 'message', message_type: 'private' },
      { post_type: 'message', message_type: UNKNOWN_POST_TYPE }, { post_type: 'notice' },
      { post_type: 'request' }, { post_type: 'meta_event', meta_event_type: 'heartbeat' },
      { post_type: UNKNOWN_POST_TYPE },
    ]) socket.send(JSON.stringify({ ...base, ...event }));
    if (mode === 'disconnect') {
      // An explicit pong barrier ensures the client consumed login/events before the server closes.
      socket.once('pong', () => socket.close());
      socket.ping('read-only-fixture-barrier');
    }
  }));
}

const args = (path: string, duration = '350') => ['--config', path, '--duration-ms', duration];

test('SnowLuma module import is inert and exact config validation rejects unsafe endpoints and identity guesses', async () => {
  const module = await loadModule();
  const options = { configPath: 'onebot_10001.json' };
  const target = module.validateConfig(config(), options);
  assert.equal(target.expectedSelfId, SELF_ID);
  assert.equal(target.wsUrl, 'ws://127.0.0.1:3001/');
  assert.equal(target.token, PRIVATE_TOKEN);
  assert.throws(() => module.validateConfig(config(), { configPath: 'account.json' }), hasCode('EXPECTED_SELF_ID_REQUIRED'));
  assert.equal(module.validateConfig(config(), { configPath: 'account.json', expectedSelfId: '20002' }).expectedSelfId, '20002');
  assert.throws(() => module.validateConfig(config(), { ...options, expectedSelfId: '0' }), hasCode('INVALID_SELF_ID'));
  for (const change of [
    { host: '0.0.0.0' }, { host: 'example.com' }, { host: '127.0.0.1@evil.invalid' },
    { host: '127.1' }, { port: '3001' }, { port: 0 }, { port: 65_536 }, { port: 1.5 },
    { path: '//user:password@host/' }, { path: '/?access_token=secret' }, { path: '/#secret' },
    { path: '/%2fsecret' }, { path: '/../secret' }, { path: '/ space' },
  ]) {
    const changed = config(); Object.assign(changed.networks.wsServers[0]!, change);
    assert.throws(() => module.validateConfig(changed, options), hasCode('INVALID_ENDPOINT'));
  }
  const duplicate = config(); duplicate.networks.wsServers.push({ ...duplicate.networks.wsServers[0]! });
  assert.throws(() => module.validateConfig(duplicate, options), hasCode('SERVER_AMBIGUOUS'));
  assert.throws(() => module.validateConfig(config(), { ...options, serverName: 'missing' }), hasCode('SERVER_NOT_FOUND'));
  const selected = config(); selected.networks.wsServers[0]!.name = 'exact-other';
  assert.equal(module.validateConfig(selected, { ...options, serverName: 'exact-other' }).expectedSelfId, SELF_ID);
  assert.throws(() => module.validateConfig(config(), { ...options, serverName: 'exact-other' }), hasCode('SERVER_NOT_FOUND'));
  const invalidToken = config(); invalidToken.networks.wsServers[0]!.accessToken = 'private\r\nheader';
  assert.throws(() => module.validateConfig(invalidToken, options), hasCode('INVALID_TOKEN'));
  assert.equal(module.parseArgs(['--config', 'exact.json']).durationMs, 15_000);
  for (const bad of ['0', '-1', '60001', '1.5', '1e3', ' 100', '15000secret']) {
    assert.throws(() => module.parseArgs(['--config', 'exact.json', '--duration-ms', bad]), hasCode('ARGUMENTS_INVALID'));
  }
  assert.throws(() => module.parseArgs(['--config', 'exact.json', '--token', PRIVATE_TOKEN]), hasCode('ARGUMENTS_INVALID'));
  assert.throws(() => module.parseArgs(['--config', 'one', '--config', 'two']), hasCode('ARGUMENTS_INVALID'));
});

test('SnowLuma CLI uses native Bearer login and emits only fixed aggregate metadata, never reply sends', { timeout: 15_000 }, async t => {
  const f = await fixture(t); replyAndEvents(f, 'ok');
  const result = await cli(t, args(f.configPath));
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.equal(result.summary.state, 'ready'); assert.equal(result.summary.code, 'OK');
  assert.equal(result.summary.authentication, 'verified');
  assert.equal(result.summary.expectedSelfId, SELF_ID); assert.equal(result.summary.verifiedSelfId, SELF_ID);
  assert.equal(result.summary.endpoint, `ws://127.0.0.1:${f.port}`);
  assert.equal(result.summary.eventCount, 7);
  assert.deepEqual(result.summary.counts, { message: { group: 1, private: 1, other: 1 }, notice: 1, request: 1, meta_event: 1, other: 1 });
  assert.deepEqual(f.authorizations, [`Bearer ${PRIVATE_TOKEN}`]);
  assert.deepEqual(f.actions, ['get_login_info'], 'zero membership, reply/send, arbitrary OneBot, model or agent actions');
  for (const id of ['888888', '777777', '666666']) assert.equal(result.stdout.includes(id), false);
  assert.equal(await readFile(f.configPath, 'utf8'), f.privateConfig, 'private config is unchanged');
});

for (const [mode, code] of [['mismatch', 'IDENTITY_MISMATCH'], ['refusal', 'AUTH_FAILED']] as const) {
  test(`SnowLuma ${mode} blocks with a fixed code, no body/credentials and no sends`, { timeout: 15_000 }, async t => {
    const f = await fixture(t); replyAndEvents(f, mode);
    const result = await cli(t, args(f.configPath));
    assert.equal(result.code, 1); assert.equal(result.summary.state, 'blocked');
    assert.equal(result.summary.code, code); assert.equal(result.summary.authentication, 'unverified');
    assert.equal(result.summary.verifiedSelfId, undefined); assert.equal(result.summary.eventCount, 0);
    assert.deepEqual(f.actions, ['get_login_info']);
    assert.deepEqual(f.authorizations, [`Bearer ${PRIVATE_TOKEN}`]);
  });
}

test('SnowLuma deadline bounds an unauthenticated connection instead of claiming success', { timeout: 15_000 }, async t => {
  const f = await fixture(t); replyAndEvents(f, 'idle');
  const result = await cli(t, args(f.configPath, '100'));
  assert.equal(result.code, 1); assert.equal(result.summary.code, 'CONNECTION_TIMEOUT');
  assert.notEqual(result.summary.state, 'ready'); assert.equal(result.summary.authentication, 'unverified');
  assert.equal(result.summary.eventCount, 0); assert.deepEqual(f.actions, ['get_login_info']);
});

test('SnowLuma disconnect after verified events is not mislabeled connected', { timeout: 15_000 }, async t => {
  const f = await fixture(t); replyAndEvents(f, 'disconnect');
  const result = await cli(t, args(f.configPath, '500'));
  assert.equal(result.code, 1); assert.notEqual(result.summary.state, 'ready');
  assert.equal(result.summary.authentication, 'unverified'); assert.equal(result.summary.eventCount, 7);
  assert.equal(result.summary.code, 'DISCONNECTED');
  assert.deepEqual(f.actions, ['get_login_info']);
});

test('SnowLuma bounded file/JSON errors are fixed and do not expose the config path', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, '{PRIVATE_SENTINEL_RAW_QQ_BODY_2a9');
  const malformed = await cli(t, args(f.configPath));
  assert.equal(malformed.summary.code, 'INVALID_CONFIG');
  assert.equal(malformed.stdout.includes(f.configPath), false);
  await writeFile(f.configPath, ' '.repeat(256 * 1024 + 1));
  const oversized = await cli(t, args(f.configPath));
  assert.equal(oversized.summary.code, 'CONFIG_TOO_LARGE'); assert.equal(oversized.code, 1);
  const missing = await cli(t, args(join(dirname(f.configPath), 'onebot_20002.json')));
  assert.equal(missing.summary.code, 'CONFIG_READ_FAILED');
  assert.deepEqual(f.actions, []); assert.deepEqual(f.authorizations, []);
});

test('SnowLuma graceful abort disposes the transport without marking disposal as the observed state', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const module = await loadModule();
  const target = await module.loadTargetFromConfig(f.configPath);
  const controller = new AbortController(); controller.abort();
  const probeModule = await import(scriptUrl.href) as { probe(target: unknown, options: unknown): Promise<Summary> };
  const result = await probeModule.probe(target, { durationMs: 50, signal: controller.signal });
  assert.equal(result.code, 'INTERRUPTED'); assert.equal(result.state, 'disabled');
  assert.equal(result.authentication, 'unverified'); assert.deepEqual(f.actions, []);
});
