import test from 'node:test';
import assert from 'node:assert/strict';
import { DispatchDeferred, StageError } from '../src/llm/calls.js';
import { RuntimeError } from '../src/runtime/configuration.js';
import { ProviderQuota } from '../src/runtime/quota.js';
import type { QuotaLimits } from '../src/runtime/quota.js';

// AUTHORED ONLY: these tests have not been executed in this restricted editing session.
function fixture(input: Partial<QuotaLimits> = {}) {
  let now = 0;
  let limits: QuotaLimits = { onlineRequestsPerMinute: 4, retainRequestsPerMinute: 2,
    onlineTokensPerMinute: 1000, retainTokensPerMinute: 500, ...input };
  const quota = new ProviderQuota({ readLimits: () => limits, now: () => now });
  return { quota, setNow(value: number) { now = value; }, setLimits(value: Partial<QuotaLimits>) { limits = { ...limits, ...value }; } };
}
function deferred(work: () => void, retryAt: number, stage = 'retain'): void {
  assert.throws(work, error => error instanceof DispatchDeferred && error.code === 'dispatch-deferred'
    && error.stage === stage && error.retryAt === retryAt);
}

test('combined provider ceiling counts both lanes while half of requests stays available online', () => {
  const f = fixture();
  f.quota.reserve('retain', 'registered-a', 100, 'retain');
  f.quota.reserve('retain', 'registered-a', 100, 'retain');
  deferred(() => f.quota.reserve('retain', 'registered-a', 1, 'retain'), 60_000);
  f.quota.reserve('online', 'registered-a', 100, 'router');
  f.quota.reserve('online', 'registered-a', 100, 'reply');
  deferred(() => f.quota.reserve('online', 'registered-a', 1, 'reply'), 60_000, 'reply');
  assert.deepEqual(f.quota.getStatus().providers[0], { provider: 'registered-a', requests: 4, tokens: 400,
    retainRequests: 2, retainTokens: 200, nextOnlineAt: 60_000, nextRetainAt: 60_000 });
});

test('background own cap is the minimum of configuration and half the COMBINED ceilings', () => {
  const f = fixture({ onlineRequestsPerMinute: 10, retainRequestsPerMinute: 1, retainTokensPerMinute: 900 });
  f.quota.reserve('retain', 'registered-a', 500, 'retain');
  deferred(() => f.quota.reserve('retain', 'registered-a', 1, 'retain'), 60_000);
  f.quota.reserve('online', 'registered-a', 500, 'reply');
  assert.throws(() => f.quota.reserve('retain', 'registered-b', 501, 'retain'), /quota-request-exceeds-window/);
  const odd = fixture({ onlineRequestsPerMinute: 3, retainRequestsPerMinute: 20 });
  odd.quota.reserve('retain', 'registered-a', 1, 'retain');
  deferred(() => odd.quota.reserve('retain', 'registered-a', 1, 'retain'), 60_000);
});

test('rolling expiration is exact and request/token constraints choose the earliest sufficient expiry', () => {
  const f = fixture({ onlineRequestsPerMinute: 10, retainRequestsPerMinute: 5 });
  f.quota.reserve('online', 'registered-a', 600, 'router');
  f.setNow(1000); f.quota.reserve('retain', 'registered-a', 300, 'retain');
  f.setNow(2000); deferred(() => f.quota.reserve('online', 'registered-a', 200, 'reply'), 60_000, 'reply');
  f.setNow(59_999); deferred(() => f.quota.reserve('online', 'registered-a', 200, 'reply'), 60_000, 'reply');
  f.setNow(60_000); f.quota.reserve('online', 'registered-a', 200, 'reply');
  assert.equal(f.quota.getStatus().providers[0]!.tokens, 500);
  const requests = fixture({ onlineRequestsPerMinute: 2, retainRequestsPerMinute: 1 });
  requests.quota.reserve('online', 'registered-a', 1, 'reply');
  requests.setNow(1000); requests.quota.reserve('retain', 'registered-a', 1, 'retain');
  requests.setNow(2000); deferred(() => requests.quota.reserve('online', 'registered-a', 1, 'reply'), 60_000, 'reply');
});

test('tokens may require more than the first expiration; failed admissions do not consume quota', () => {
  const f = fixture({ onlineRequestsPerMinute: 10 });
  f.quota.reserve('online', 'registered-a', 300, 'router');
  f.setNow(1000); f.quota.reserve('online', 'registered-a', 500, 'recall');
  f.setNow(2000); deferred(() => f.quota.reserve('online', 'registered-a', 600, 'reply'), 61_000, 'reply');
  deferred(() => f.quota.reserve('online', 'registered-a', 600, 'reply'), 61_000, 'reply');
  assert.equal(f.quota.getStatus().providers[0]!.requests, 2);
  f.setNow(61_000); f.quota.reserve('online', 'registered-a', 600, 'reply');
  assert.equal(f.quota.getStatus().providers[0]!.requests, 1);
});

test('all models of one registered provider share usage; distinct registered provider IDs do not', () => {
  const f = fixture({ onlineRequestsPerMinute: 2 });
  // There is intentionally no model argument or model-keyed registry to reset/split this usage.
  f.quota.reserve('online', 'registered-a', 500, 'router');
  f.quota.reserve('online', 'registered-a', 500, 'reply');
  deferred(() => f.quota.reserve('online', 'registered-a', 1, 'recall'), 60_000, 'recall');
  f.quota.reserve('online', 'registered-b', 1000, 'reply');
  assert.equal(f.quota.getStatus().providers.length, 2);
});

test('live configuration changes do not reset previous requests or conservative token reservations', () => {
  const f = fixture({ onlineRequestsPerMinute: 10 });
  f.quota.reserve('online', 'registered-a', 800, 'reply');
  f.setLimits({ onlineTokensPerMinute: 500, retainTokensPerMinute: 500 });
  deferred(() => f.quota.reserve('online', 'registered-a', 100, 'reply'), 60_000, 'reply');
  f.setLimits({ onlineTokensPerMinute: 1000 });
  f.quota.reserve('online', 'registered-a', 200, 'reply');
  assert.equal(f.quota.getStatus().providers[0]!.tokens, 1000);
  assert.equal('refund' in f.quota, false);
});

test('clock reversal does not prematurely expire or refund usage', () => {
  const f = fixture({ onlineRequestsPerMinute: 1 });
  f.setNow(100); f.quota.reserve('online', 'registered-a', 1, 'reply');
  f.setNow(0); deferred(() => f.quota.reserve('online', 'registered-a', 1, 'reply'), 60_100, 'reply');
  f.setNow(60_099); deferred(() => f.quota.reserve('online', 'registered-a', 1, 'reply'), 60_100, 'reply');
  f.setNow(60_100); f.quota.reserve('online', 'registered-a', 1, 'reply');
});

test('invalid, impossible, aborted and stopped reservations fail with fixed errors without input echo', () => {
  const f = fixture();
  for (const tokens of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => f.quota.reserve('online', 'registered-a', tokens, 'reply'), RuntimeError);
  }
  for (const provider of ['', ' provider', 'provider\nSECRET', 'https://SECRET.invalid', 'x'.repeat(257)]) {
    assert.throws(() => f.quota.reserve('online', provider, 1, 'reply'), error => error instanceof RuntimeError
      && error.message === 'invalid-quota-reservation');
  }
  assert.throws(() => f.quota.reserve('online', 'registered-a', Number.MAX_SAFE_INTEGER, 'reply'), error =>
    error instanceof StageError && error.code === 'quota-request-exceeds-window');
  const controller = new AbortController(); controller.abort(new Error('SECRET'));
  assert.throws(() => f.quota.reserve('online', 'registered-a', 1, 'reply', controller.signal), /quota-cancelled/);
  assert.equal(f.quota.getStatus().providers.length, 0);
  f.quota.reserve('online', 'registered-a', 1, 'reply'); f.quota.stop(); f.quota.stop();
  assert.throws(() => f.quota.reserve('online', 'registered-a', 1, 'reply'), /quota-stopped/);
  assert.equal(f.quota.getStatus().providers[0]!.nextOnlineAt, null);
  assert.equal(JSON.stringify(f.quota.getStatus()).includes('SECRET'), false);
  const disabled = fixture({ onlineRequestsPerMinute: 1 });
  assert.throws(() => disabled.quota.reserve('retain', 'registered-a', 1, 'retain'), /quota-request-exceeds-window/);
});

test('provider registry fails closed at its bound, preserving live usage, then evicts expired entries', () => {
  const f = fixture();
  for (let index = 0; index < 1024; index++) f.quota.reserve('online', `registered-${index}`, 1, 'reply');
  assert.throws(() => f.quota.reserve('online', 'registered-overflow', 1, 'reply'), /quota-provider-capacity/);
  assert.equal(f.quota.getStatus().providers.length, 1024);
  f.quota.reserve('online', 'registered-0', 1, 'reply');
  assert.equal(f.quota.getStatus().providers.find(value => value.provider === 'registered-0')!.requests, 2);
  f.setNow(60_000); f.quota.reserve('online', 'registered-overflow', 1, 'reply');
  assert.ok(f.quota.getStatus().providers.length <= 1024);
});

test('status is detached, metadata-only, and next availability is explicitly for a one-token request', () => {
  const f = fixture(); f.quota.reserve('retain', 'registered-a', 500, 'retain');
  const first = f.quota.getStatus();
  assert.equal(first.providers[0]!.nextOnlineAt, 0);
  assert.equal(first.providers[0]!.nextRetainAt, 60_000);
  assert.deepEqual(Object.keys(first.providers[0]!).sort(), ['nextOnlineAt', 'nextRetainAt', 'provider', 'requests', 'retainRequests', 'retainTokens', 'tokens'].sort());
  f.setNow(60_000); f.quota.reserve('retain', 'registered-a', 1, 'retain');
  assert.equal(first.providers[0]!.retainTokens, 500);
});

test('malformed limit readers and invalid clocks never leak exception text', () => {
  const throwing = new ProviderQuota({ readLimits: () => { throw new Error('SECRET'); }, now: () => 0 });
  assert.throws(() => throwing.reserve('online', 'registered-a', 1, 'reply'), /invalid-quota-limits/);
  const f = fixture(); f.setLimits({ onlineRequestsPerMinute: 10_001 });
  assert.throws(() => f.quota.reserve('online', 'registered-a', 1, 'reply'), /invalid-quota-limits/);
  f.setLimits({ onlineRequestsPerMinute: 10 }); f.setNow(NaN);
  assert.throws(() => f.quota.reserve('online', 'registered-a', 1, 'reply'), /invalid-quota-clock/);
});
