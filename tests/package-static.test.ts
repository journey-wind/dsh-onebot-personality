import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseConfig } from '../src/config.js';
import { inheritRoute } from '../src/llm/routes.js';

const project = new URL('../../', import.meta.url);
test('distributed examples are disabled, credential-free and preserve five exact routes plus persona override', async () => {
  assert.equal(await readFile(new URL('lockfiles/dependencies.yaml', project), 'utf8'), await readFile(new URL('pnpm-lock.yaml', project), 'utf8'));
  const disabled = parseConfig(JSON.parse(await readFile(new URL('examples/disabled.json', project), 'utf8')));
  assert.equal(disabled.onebot.enabled, false); assert.equal(disabled.onebot.token, '');
  assert.deepEqual(disabled.allow, { groupIds: [], privateUserIds: [] }); assert.equal(disabled.persistence.privateDirectoryReady, false);
  const routes = parseConfig(JSON.parse(await readFile(new URL('examples/five-routes.json', project), 'utf8')));
  assert.equal(routes.onebot.enabled, false); assert.equal(routes.onebot.token, '');
  assert.ok(routes.personalities.every(persona => persona.visibility === 'source-restricted'));
  for (const stage of ['router', 'recall', 'reflect', 'retain', 'reply'] as const) {
    const route = inheritRoute(routes.personalities[0]!.models[stage], routes.models[stage], { provider: 'unused', model: 'unused' }, stage);
    assert.equal(route.model, `example-${stage}`); assert.equal(route.provider, 'example-provider');
  }
  assert.equal(inheritRoute(routes.personalities[1]!.models.reply, routes.models.reply, { provider: 'unused', model: 'unused' }, 'reply').model, 'example-alternative-reply');
});

function archive(entries: Array<{ name: string; text: string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text); const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8'); header.write('0000600\0', 100, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156); header[156] = (entry.type ?? '0').charCodeAt(0); header.write('ustar\0', 257, 6);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const verifierUrl = new URL('scripts/verify-package.mjs', project).href;
test('offline tar verifier validates exports/resources and rejects traversal, links, secrets and broken checksums', async () => {
  const verifier = await import(verifierUrl);
  assert.equal(typeof verifier.inspectTarball, 'function');
  const names = ['package.json', 'dist/src/index.js', 'dist/src/index.d.ts', 'cordis.patch.yml', 'LICENSE', 'lockfiles/dependencies.yaml',
    'scripts/probe-snowluma.mjs', 'scripts/verify-package.mjs', 'locale/en.json', 'locale/zh.json', 'icon.svg'];
  const entries = await Promise.all(names.map(async name => ({ name: `package/${name}`, text: await readFile(new URL(name, project), 'utf8') })));
  const result = verifier.inspectTarball(archive(entries));
  assert.equal(result.package, 'dsh-onebot-personality'); assert.equal(result.fileCount, names.length);
  assert.equal(result.checks.renderedIcon, 'unverified'); assert.equal(result.checks.isolatedInstall, 'not-run');
  for (const entry of [
    { name: 'package/../escape.txt', text: '' }, { name: 'package/link', text: '', type: '2' },
    { name: 'package/.private/config.json', text: '{}' }, { name: 'package/a.sqlite', text: '' },
    { name: 'package/credentials.txt', text: 'sk-' + 'a'.repeat(32) },
    { name: 'package/key.txt', text: '-----BEGIN ' + 'RSA ' + 'PRIVATE KEY-----' },
    { name: 'package/package.json', text: '{}' },
  ]) assert.throws(() => verifier.inspectTarball(archive([...entries, entry])));
  const corrupt = archive(entries); corrupt[15] = corrupt[15]! ^ 255;
  assert.throws(() => verifier.inspectTarball(corrupt));
});
