#!/usr/bin/env node
/** Verify a self-built npm tarball without executing package code or extracting it. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const textField = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
function pax(bytes) {
  const fields = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset); assert.ok(space > offset, 'invalid PAX length');
    const length = Number(bytes.subarray(offset, space).toString());
    assert.ok(Number.isSafeInteger(length) && length > space - offset + 1 && offset + length <= bytes.length, 'invalid PAX record');
    const line = bytes.subarray(space + 1, offset + length).toString('utf8');
    const equals = line.indexOf('='); assert.ok(equals > 0 && line.endsWith('\n'), 'invalid PAX field');
    fields[line.slice(0, equals)] = line.slice(equals + 1, -1); offset += length;
  }
  return fields;
}
export function inspectTarball(compressed) {
  assert.ok(compressed.length <= 16 * 1024 * 1024, 'archive too large');
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map(); let local = {}; let global = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) break;
    const octal = field => { const value = textField(field).trim(); assert.match(value, /^[0-7]*$/); return parseInt(value || '0', 8); };
    const expected = octal(header.subarray(148, 156));
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(sum, expected, 'tar checksum mismatch');
    const size = octal(header.subarray(124, 136));
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + size <= tar.length, 'invalid tar size');
    const bytes = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (type === 'x') { local = pax(bytes); continue; }
    if (type === 'g') { global = { ...global, ...pax(bytes) }; continue; }
    assert.ok(type === '0' || type === '5', 'links and special files are forbidden');
    const prefix = textField(header.subarray(345, 500));
    const name = local.path ?? global.path ?? `${prefix ? prefix + '/' : ''}${textField(header.subarray(0, 100))}`;
    local = {};
    assert.ok(name.startsWith('package/') && !name.includes('\\') && !name.includes(':') && !name.includes('\0'), 'unsafe tar path');
    const parts = name.split('/'); assert.ok(!parts.some(part => part === '..' || part === '.'), 'unsafe tar segment');
    if (type === '5') continue;
    const relative = name.slice(8); assert.ok(relative && !files.has(relative), 'duplicate tar path');
    assert.ok(!/(^|\/)(?:node_modules|\.git|\.private|\.validation|artifacts|coverage)(\/|$)/.test(relative), 'private/build cache in package');
    assert.ok(!/(^|\/)(?:\.env(?:\..*)?|owner\.sqlite|onebot_[0-9]+\.json)$/.test(relative), 'private configuration in package');
    assert.ok(!/\.(?:sqlite|sqlite3|db|tgz|pem|key)(?:-(?:wal|shm|journal))?$/.test(relative), 'database/key/archive in package');
    const source = bytes.toString('utf8');
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(source), 'private key material detected');
    assert.ok(!/\bsk-(?:proj-)?[a-zA-Z0-9_-]{24,}/.test(source), 'possible API credential detected');
    files.set(relative, bytes);
  }
  assert.ok(files.size > 0, 'empty package');
  const text = name => { const bytes = files.get(name); assert.ok(bytes, `missing ${name}`); return bytes.toString('utf8'); };
  const manifest = JSON.parse(text('package.json'));
  assert.equal(manifest.name, 'dsh-onebot-personality'); assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(manifest.exports?.['.']?.default, './dist/src/index.js');
  assert.equal(manifest.exports?.['.']?.types, './dist/src/index.d.ts');
  assert.equal(manifest.exports?.['./icon'], './icon.svg');
  assert.equal(manifest.exports?.['./locale/*.json'], './locale/*.json');
  text('dist/src/index.js'); text('dist/src/index.d.ts'); text('cordis.patch.yml'); text('LICENSE'); assert.match(text('lockfiles/dependencies.yaml'), /^lockfileVersion: '9\.0'/);
  text('scripts/probe-snowluma.mjs'); text('scripts/verify-package.mjs');
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(text(`locale/${language}.json`));
    assert.ok(typeof locale.meta?.title === 'string' && locale.meta.title.length > 3);
    assert.ok(typeof locale.meta?.description === 'string' && locale.meta.description.length > 12);
    assert.ok(!/My (?:decoration|plugin)/i.test(locale.meta.title), 'template display metadata');
  }
  const icon = files.get('icon.svg'); assert.ok(icon && icon.length <= 256 * 1024);
  const svg = text('icon.svg'); assert.match(svg, /<svg\b/); assert.match(svg, /xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/);
  assert.ok(!/<script|<foreignObject|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:)/i.test(svg), 'active/external icon content');
  assert.ok(!manifest.scripts?.preinstall && !manifest.scripts?.install && !manifest.scripts?.postinstall && !manifest.scripts?.prepare && !manifest.scripts?.prepack);
  for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, `unlocked peer ${name}`);
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, `unlocked dependency ${name}`);
  return { package: manifest.name, version: manifest.version, sha256: sha(compressed), bytes: compressed.length,
    fileCount: files.size, checks: { structure: true, exports: true, displayResources: true, installScriptsAbsent: true,
      exactDependencies: true, credentialPatternScan: true, renderedIcon: 'unverified', isolatedInstall: 'not-run' },
    files: [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) })).sort((a, b) => a.path.localeCompare(b.path)) };
}
export async function main(args = process.argv.slice(2)) {
  assert.ok(args.length >= 1 && args.length <= 2, 'usage: node scripts/verify-package.mjs <archive.tgz> [new-report.json]');
  const archive = resolve(args[0]); assert.ok(isAbsolute(archive));
  const report = inspectTarball(await readFile(archive));
  if (args[1]) await writeFile(resolve(args[1]), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, files: undefined })}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch { process.stderr.write('package verification failed\n'); process.exitCode = 1; }
}
