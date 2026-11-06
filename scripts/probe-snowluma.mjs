#!/usr/bin/env node
/** Read-only OneBot v11 metadata probe. Importing this module never connects. */
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_CONFIG_BYTES = 256 * 1024;
const DEFAULT_DURATION_MS = 15_000;
const MAX_DURATION_MS = 60_000;
const FIXED_CODES = new Set([
  'ARGUMENTS_INVALID', 'CONFIG_READ_FAILED', 'CONFIG_TOO_LARGE', 'INVALID_CONFIG',
  'SERVER_NOT_FOUND', 'SERVER_AMBIGUOUS', 'EXPECTED_SELF_ID_REQUIRED', 'INVALID_SELF_ID',
  'INVALID_ENDPOINT', 'INVALID_TOKEN', 'CLIENT_UNAVAILABLE', 'INTERNAL_ERROR',
  'OK', 'CONNECTION_TIMEOUT', 'INTERRUPTED', 'DISCONNECTED',
  'INVALID_OPTIONS', 'NOT_READY', 'STALE_CONNECTION', 'STOPPED', 'IDENTITY_MISMATCH',
  'IDENTITY_CHANGED', 'AUTH_FAILED', 'ACTION_TOO_LARGE', 'TOO_MANY_PENDING',
  'INVALID_TEXT', 'INVALID_ID', 'ACTION_REJECTED', 'MALFORMED_RESPONSE', 'ACTION_MISMATCH',
  'MEMBER_MISMATCH', 'TIMEOUT', 'CONNECT_TIMEOUT', 'SOCKET_ERROR', 'SEND_ERROR',
  'INVALID_FRAME', 'PAYLOAD_TOO_LARGE', 'HEARTBEAT_TIMEOUT', 'CALLBACK_FAILED',
]);
const FIXED_STATES = new Set([
  'disabled', 'connecting', 'authenticating', 'ready', 'reconnecting', 'blocked', 'stopping', 'stopped',
]);

export class ProbeError extends Error {
  constructor(code) {
    const safe = FIXED_CODES.has(code) ? code : 'INTERNAL_ERROR';
    super(safe);
    this.name = 'ProbeError';
    this.code = safe;
  }
}
const fail = code => { throw new ProbeError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const fixedCode = value => FIXED_CODES.has(value) ? value : 'INTERNAL_ERROR';
const emptyCounts = () => ({
  message: { group: 0, private: 0, other: 0 }, notice: 0, request: 0, meta_event: 0, other: 0,
});
function duration(value = DEFAULT_DURATION_MS) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DURATION_MS) fail('ARGUMENTS_INVALID');
  return value;
}

/** Pure, strict projection. No directory discovery; never returns any unrelated config fields. */
export function validateConfig(config, { configPath, serverName = 'ws-default', expectedSelfId } = {}) {
  if (typeof configPath !== 'string' || !configPath || configPath.length > 32_768 || configPath.includes('\0')) {
    fail('ARGUMENTS_INVALID');
  }
  if (typeof serverName !== 'string' || !serverName || serverName.length > 128 || /[\x00-\x20\x7f]/.test(serverName)) {
    fail('ARGUMENTS_INVALID');
  }
  // Identity is never inferred from ports, event fields, another config file or the login response.
  const inferred = /^onebot_([1-9][0-9]{0,31})\.json$/.exec(basename(configPath))?.[1];
  const selfId = expectedSelfId === undefined ? inferred : expectedSelfId;
  if (selfId === undefined) fail('EXPECTED_SELF_ID_REQUIRED');
  if (!validId(selfId)) fail('INVALID_SELF_ID');
  if (!record(config) || !record(config.networks) || !Array.isArray(config.networks.wsServers)
    || config.networks.wsServers.length > 256) fail('INVALID_CONFIG');
  const matches = config.networks.wsServers.filter(item => record(item) && item.name === serverName);
  if (matches.length === 0) fail('SERVER_NOT_FOUND');
  if (matches.length !== 1) fail('SERVER_AMBIGUOUS');
  const server = matches[0];
  if (server.role !== 'Universal' || server.enabled === false || server.enable === false) fail('INVALID_CONFIG');
  const host = server.host;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
    || !Number.isSafeInteger(server.port) || server.port < 1 || server.port > 65_535) fail('INVALID_ENDPOINT');
  const path = server.path;
  // Reject queries, fragments, credentials, escapes, dot segments and URL-like authority paths.
  if (typeof path !== 'string' || path.length > 1024 || !/^\/(?:[A-Za-z0-9_~-]+\/?)*$/.test(path)) {
    fail('INVALID_ENDPOINT');
  }
  const token = server.accessToken;
  if (token !== undefined && (typeof token !== 'string' || token.length > 4096
    || (token !== '' && !/^[\x21-\x7e]+$/.test(token)))) fail('INVALID_TOKEN');
  const authority = host === '::1' ? '[::1]' : host;
  // Path and token are deliberately never included in any summary.
  return Object.freeze({
    wsUrl: `ws://${authority}:${server.port}${path}`,
    endpoint: `ws://${authority}:${server.port}`,
    expectedSelfId: selfId,
    token: token ?? '',
  });
}

/** Read only the exact supplied file, with a byte cap even if it grows after stat(). */
export async function loadTargetFromConfig(configPath, options = {}) {
  if (typeof configPath !== 'string' || !configPath || configPath.length > 32_768 || configPath.includes('\0')) {
    fail('ARGUMENTS_INVALID');
  }
  let file;
  let config;
  try {
    file = await open(configPath, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) fail('INVALID_CONFIG');
    if (stat.size > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE');
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE');
    try { config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { fail('INVALID_CONFIG'); }
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    fail('CONFIG_READ_FAILED');
  } finally {
    if (file) await file.close().catch(() => {});
  }
  return validateConfig(config, { ...options, configPath });
}

export function parseArgs(argv) {
  const allowed = new Set(['--config', '--server', '--expected-self-id', '--duration-ms']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || values.has(key) || typeof value !== 'string' || !value || value.startsWith('--')) {
      fail('ARGUMENTS_INVALID');
    }
    values.set(key, value);
  }
  if (!values.has('--config')) fail('ARGUMENTS_INVALID');
  const rawDuration = values.get('--duration-ms');
  if (rawDuration !== undefined && !/^[1-9][0-9]{0,4}$/.test(rawDuration)) fail('ARGUMENTS_INVALID');
  return {
    configPath: values.get('--config'), serverName: values.get('--server') ?? 'ws-default',
    ...(values.has('--expected-self-id') ? { expectedSelfId: values.get('--expected-self-id') } : {}),
    durationMs: duration(rawDuration === undefined ? undefined : Number(rawDuration)),
  };
}

/** No body access, persistence, models, member lookups or send actions; only fixed counters. */
export async function probe(target, { durationMs = DEFAULT_DURATION_MS, signal } = {}) {
  const waitMs = duration(durationMs);
  // Revalidate the public target boundary rather than permitting arbitrary URLs via the exported API.
  let url;
  try { url = new URL(target.wsUrl); } catch { fail('INVALID_ENDPOINT'); }
  const normalized = validateConfig({ networks: { wsServers: [{
    name: 'ws-default', role: 'Universal', host: url.hostname, port: Number(url.port || 80),
    path: url.pathname, accessToken: target.token,
  }] } }, { configPath: 'explicit.json', expectedSelfId: target.expectedSelfId });
  if (url.protocol !== 'ws:' || url.username || url.password || url.search || url.hash
    || target.wsUrl !== normalized.wsUrl) fail('INVALID_ENDPOINT');
  let OneBotClient;
  try { ({ OneBotClient } = await import('../dist/src/onebot/client.js')); }
  catch { fail('CLIENT_UNAVAILABLE'); }
  const counts = emptyCounts();
  let eventCount = 0;
  let verifiedSelfId;
  let client;
  let pollTimer;
  let deadlineTimer;
  let abortListener;
  try {
    client = new OneBotClient({
      enabled: true, wsUrl: normalized.wsUrl, expectedSelfId: normalized.expectedSelfId,
      token: normalized.token, authMode: 'bearer',
      maxPayloadBytes: 256 * 1024, maxActionBytes: 16_384, maxPending: 32,
      connectTimeoutMs: Math.min(5_000, waitMs), actionTimeoutMs: Math.min(5_000, waitMs),
      onEvent(event) {
        // OneBotClient invokes this only after login identity verification; retain no event fields.
        verifiedSelfId = normalized.expectedSelfId;
        eventCount++;
        switch (event.post_type) {
          case 'message':
            if (event.message_type === 'group') counts.message.group++;
            else if (event.message_type === 'private') counts.message.private++;
            else counts.message.other++;
            break;
          case 'notice': counts.notice++; break;
          case 'request': counts.request++; break;
          case 'meta_event': counts.meta_event++; break;
          default: counts.other++; break;
        }
      },
    });
    return await new Promise(resolveResult => {
      let finished = false;
      const finish = reason => {
        if (finished) return;
        finished = true;
        // Capture real transport state BEFORE dispose; never label a previous connection as ready.
        const status = client.getStatus();
        const identity = client.identity;
        if (identity) verifiedSelfId = identity.selfId;
        const ready = status.state === 'ready' && identity?.selfId === normalized.expectedSelfId;
        const code = reason ?? (status.state === 'blocked' ? fixedCode(status.lastError)
          : ready ? 'OK' : verifiedSelfId ? 'DISCONNECTED' : 'CONNECTION_TIMEOUT');
        resolveResult({
          state: FIXED_STATES.has(status.state) ? status.state : 'blocked', code,
          authentication: ready ? 'verified' : 'unverified',
          expectedSelfId: normalized.expectedSelfId,
          ...(verifiedSelfId ? { verifiedSelfId } : {}), endpoint: normalized.endpoint,
          ...(status.lastError ? { lastError: fixedCode(status.lastError) } : {}),
          eventCount, counts,
        });
      };
      const sample = () => {
        const status = client.getStatus();
        if (client.identity) verifiedSelfId = client.identity.selfId;
        if (status.state === 'blocked') finish();
        else if (verifiedSelfId && status.state !== 'ready') finish('DISCONNECTED');
      };
      abortListener = () => finish('INTERRUPTED');
      signal?.addEventListener('abort', abortListener, { once: true });
      // This referenced deadline keeps the standalone CLI alive even though client timers are unref'd.
      deadlineTimer = setTimeout(() => finish(), waitMs);
      pollTimer = setInterval(sample, Math.min(20, waitMs));
      if (signal?.aborted) finish('INTERRUPTED');
      else { client.start(); sample(); }
    });
  } finally {
    clearInterval(pollTimer);
    clearTimeout(deadlineTimer);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    client?.dispose();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  let interruptedBy;
  const interrupt = name => { interruptedBy = name; controller.abort(); };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  let summary;
  try {
    const options = parseArgs(argv);
    const target = await loadTargetFromConfig(options.configPath, options);
    summary = await probe(target, { durationMs: options.durationMs, signal: controller.signal });
  } catch (error) {
    summary = {
      state: 'blocked', code: error instanceof ProbeError ? fixedCode(error.code) : 'INTERNAL_ERROR',
      authentication: 'unverified', eventCount: 0, counts: emptyCounts(),
    };
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return interruptedBy === 'SIGINT' ? 130 : interruptedBy === 'SIGTERM' ? 143 : summary.code === 'OK' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
