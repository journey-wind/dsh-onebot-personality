import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm';
import { parseConfig, selectPersonality, STAGES } from '../src/config.js';
import { createSnapshot, inheritRoute } from '../src/llm/routes.js';
import type { FiveRoutes } from '../src/llm/routes.js';
import { CallBudget, StageCaller } from '../src/llm/calls.js';
import type { CallContext } from '../src/llm/calls.js';

function context(overrides: Partial<CallContext> = {}): CallContext {
  const config = parseConfig();
  const p = selectPersonality(config, 'private', '123');
  const routes = Object.fromEntries(STAGES.map(stage => [stage,
    inheritRoute(p.models[stage], { ...config.models[stage], selection: 'explicit', provider: `p-${stage}`, model: `m-${stage}` },
      { provider: 'default', model: 'default' }, stage),
  ])) as FiveRoutes;
  return {
    snapshot: createSnapshot(config, p, routes, 'r1'),
    budget: new CallBudget(Date.now() + 10000, 12, 1000000),
    signal: new AbortController().signal,
    authorize: async () => {},
    ...overrides,
  };
}

function mock(outputs: Array<{ text: string; finish?: 'stop' | 'max-tokens' }>) {
  const calls: GenerateOptions[] = [];
  let index = 0;
  const llm: Pick<LlmRuntime, 'prepareCall'> = {
    prepareCall: async config => ({
      config,
      context: { contextWindow: 1000000 },
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      adapterDefaults: {},
      stream: async function* (options): AsyncIterable<StreamChunk> {
        calls.push(options);
        const out = outputs[index++];
        if (!out) throw new Error('unexpected call');
        yield { type: 'text-delta', index: 0, text: out.text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: out.text } };
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop' } };
      },
    }),
  };
  return { calls, caller: new StageCaller(llm), llm };
}

const parseMode = (value: unknown): { mode: 'recall' | 'reflect' } => {
  if (typeof value !== 'object' || value === null || !('mode' in value) || !['recall', 'reflect'].includes(String(value.mode))) {
    throw new Error('invalid mode');
  }
  return value as { mode: 'recall' | 'reflect' };
};

test('all calls keep exact stage route and budgets; no tools or purpose are supplied', async () => {
  const { caller, calls } = mock(STAGES.map(() => ({ text: 'complete' })));
  const ctx = context();
  for (const stage of STAGES) await caller.text(stage, 'trusted system', { untrusted: 'input' }, ctx);
  assert.equal(calls.length, 5);
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i]!;
    const call = calls[i]!;
    assert.equal(call.provider, `p-${stage}`);
    assert.equal(call.model, `m-${stage}`);
    assert.equal(call.maxTokens, ctx.snapshot.routes[stage].maxOutputTokens);
    assert.equal(call.tools, undefined);
    assert.equal(call.purpose, undefined);
    assert.equal(call.signal?.aborted, false);
  }
});

test('JSON repair calls the same slot once and consumes cumulative calls', async () => {
  const { caller, calls } = mock([{ text: 'not JSON' }, { text: '{"mode":"reflect"}' }]);
  const ctx = context();
  const result = await caller.structured('router', 'route only', { text: 'input' }, parseMode, ctx);
  assert.equal(result.mode, 'reflect');
  assert.equal(ctx.budget.calls, 2);
  assert.deepEqual(calls.map(c => c.provider), ['p-router', 'p-router']);
});

test('invalid semantic output gets no more than one same-stage repair', async () => {
  const { caller, calls } = mock([{ text: '{"mode":"invoke-shell"}' }, { text: '{"mode":"invoke-shell"}' }]);
  await assert.rejects(caller.structured('router', 'route only', {}, parseMode, context()), /invalid-structured-output/);
  assert.equal(calls.length, 2);
});

test('reply max-tokens is incomplete, not a sendable partial response', async () => {
  const { caller } = mock([{ text: 'incomplete', finish: 'max-tokens' }]);
  await assert.rejects(caller.text('reply', 'persona', {}, context()), /incomplete-output/);
});

test('nonreply calls preserve a reply slot and repairs do not reset budget', async () => {
  const { caller, calls } = mock([{ text: 'invalid' }, { text: 'complete reply' }]);
  const ctx = context({ budget: new CallBudget(Date.now() + 10000, 2, 1000000) });
  await assert.rejects(caller.structured('recall', 'plan', {}, parseMode, ctx), /call-budget/);
  await caller.text('reply', 'persona', {}, ctx);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.provider), ['p-recall', 'p-reply']);
});

test('authorization failure before dispatch sends no model input', async () => {
  const { caller, calls } = mock([{ text: 'not used' }]);
  await assert.rejects(caller.text('reply', 'persona', {}, context({ authorize: async () => { throw new Error('revoked secret'); } })));
  assert.equal(calls.length, 0);
});

test('authorization failure after generation suppresses all output and redacts failure text', async () => {
  const { caller } = mock([{ text: 'SECRET_RESPONSE' }]);
  let checks = 0;
  await assert.rejects(caller.text('reply', 'persona', {}, context({ authorize: async () => {
    if (++checks === 3) throw new Error('SECRET_ERROR');
  } })), error => {
    assert.equal(String(error).includes('SECRET'), false);
    return true;
  });
});

test('pre-cancellation and expired parent deadlines cannot dispatch', async () => {
  const { caller, calls } = mock([]);
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(caller.text('reply', 'persona', {}, context({ signal: cancel.signal })));
  await assert.rejects(caller.text('reply', 'persona', {}, context({ budget: new CallBudget(0, 12, 1000000) })), /deadline/);
  assert.equal(calls.length, 0);
});

test('input context failures never truncate the current message or call stream', async () => {
  const { llm, calls } = mock([{ text: 'unused' }]);
  const original = llm.prepareCall;
  const caller = new StageCaller({ prepareCall: async (...args) => ({ ...await original(...args), context: { contextWindow: 32 } }) });
  await assert.rejects(caller.text('reply', 'persona', { message: 'x'.repeat(200) }, context()), /input-budget/);
  assert.equal(calls.length, 0);
});

test('provider error details do not escape the adapter', async () => {
  const caller = new StageCaller({ prepareCall: async () => { throw new Error('Bearer SECRET_CREDENTIAL'); } });
  await assert.rejects(caller.text('reply', 'persona', {}, context()), error => {
    assert.equal(String(error), 'StageError: reply:provider-or-authorization-error');
    return true;
  });
});
