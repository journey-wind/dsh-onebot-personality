import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/index.js';

test('actual Cordis loads native volatile settings and body-free disabled service without business dependencies', async t => {
  const ctx = new Context(); const fiber = ctx.plugin(plugin, {}); t.after(() => fiber.dispose());
  await fiber.await();
  const service = ctx.get('onebotPersonality'); assert.ok(service);
  assert.deepEqual(service.getStatus(), { state: 'disabled', implementation: 'verified', code: 'disabled-by-configuration' });
  await assert.rejects(service.retryRetain('not-a-task'), /host-runtime-not-active/);
  await fiber.dispose(); assert.equal(ctx.get('onebotPersonality'), undefined);
});

test('enabled entry without business dependencies waits without opening transport or model resources', async t => {
  const ctx = new Context(); const fiber = ctx.plugin(plugin, { onebot: { enabled: true, expectedSelfId: '100' } });
  t.after(() => fiber.dispose()); await fiber.await();
  const service = ctx.get('onebotPersonality'); assert.ok(service);
  assert.deepEqual(service.getStatus(), { state: 'blocked', implementation: 'verified', code: 'waiting-required-services' });
  await assert.rejects(service.retryRetain('not-a-task'), /host-runtime-not-active/);
});

test('native status never exports token/private directory or exposes configuration bodies', async t => {
  const ctx = new Context(); const fiber = ctx.plugin(plugin, { onebot: { expectedSelfId: '100', token: 'TOKEN_PRIVATE' },
    persistence: { directory: 'C:\\PRIVATE_DIRECTORY', privateDirectoryReady: false } });
  t.after(() => fiber.dispose()); await fiber.await();
  const status = ctx.get('onebotPersonality')!.getStatus();
  assert.equal(JSON.stringify(status).includes('TOKEN_PRIVATE'), false);
  assert.equal(JSON.stringify(status).includes('PRIVATE_DIRECTORY'), false);
  assert.equal('config' in status, false);
});
