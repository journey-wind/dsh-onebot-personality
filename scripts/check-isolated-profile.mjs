#!/usr/bin/env node
/** Optional P6 check through the PUBLIC DSH CLI. Never targets the current profile. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { inspectTarball } from './verify-package.mjs';

export async function checkIsolatedProfile(archiveArg, cliArg) {
  const archive = await realpath(resolve(archiveArg)); const cli = await realpath(resolve(cliArg));
  assert.ok(isAbsolute(archive) && isAbsolute(cli));
  const report = inspectTarball(await readFile(archive));
  const root = await mkdtemp(join(dirname(archive), 'profile-check-'));
  const profile = 'personality-package-validation';
  const expectedDir = join(root, 'profiles', profile);
  const emptyNpmrc = join(root, 'empty-npmrc'); await writeFile(emptyNpmrc, '', { flag: 'wx', mode: 0o600 });
  const env = { ...process.env, DSH_HOME: root, DSH_PROFILE: profile, DSH_PROFILE_DIR: expectedDir,
    NPM_CONFIG_USERCONFIG: emptyNpmrc, npm_config_userconfig: emptyNpmrc,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true', npm_config_ignore_scripts: 'true',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', npm_config_registry: 'https://registry.npmjs.org/' };
  const run = (args, label, timeoutMs = 180_000) => new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = ''; let overflow = false;
    const append = (which, chunk) => {
      if (output.length + error.length + chunk.length > 2 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); return; }
      if (which === 'out') output += chunk; else error += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', text => append('out', text));
    child.stderr.setEncoding('utf8').on('data', text => append('err', text));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => { clearTimeout(timer); no(new Error(`${label}: process start failed`)); });
    child.on('close', async code => {
      clearTimeout(timer);
      try {
        await writeFile(join(root, `${label}.log`), `${output}\n${error}`, { flag: 'wx', mode: 0o600 });
        assert.equal(overflow, false, `${label}: output overflow`);
        assert.equal(code, 0, `${label}: nonzero exit; inspect isolated log`); yes(output);
      } catch (failure) { no(failure); }
    });
  });
  const requireCli = createRequire(cli);
  const appBoot = pathToFileURL(requireCli.resolve('@deepseek-ai/dsh-app-boot')).href;
  const preflightCode = `const{resolveProfileDir}=await import(${JSON.stringify(appBoot)});process.stdout.write(JSON.stringify({dir:resolveProfileDir(${JSON.stringify(profile)})}));`;
  const preflight = JSON.parse(await run(['--input-type=module', '-e', preflightCode], 'preflight'));
  assert.equal(resolve(preflight.dir), resolve(expectedDir), 'DSH ignored isolated profile root; refusing installation');
  await run([cli, 'plugin', '--profile', profile, 'add', '--ignore-scripts', archive], 'install');
  const manifestPath = join(expectedDir, 'package.json');
  const profileManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(profileManifest.dependencies?.[report.package], 'public CLI did not install package');
  const installedRoot = join(expectedDir, 'node_modules', report.package);
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installedManifest.version, report.version);
  const composed = await run([cli, '--profile', profile, '--dump-config'], 'compose');
  assert.ok(composed.includes(report.package), 'installed bundle absent from composed tree');
  const smoke = `import assert from 'node:assert/strict';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
const requireInstalled=createRequire(${JSON.stringify(join(installedRoot, 'package.json'))});
const{Context}=await import(pathToFileURL(requireInstalled.resolve('@deepseek-ai/cordis')).href);
const plugin=await import(${JSON.stringify(pathToFileURL(join(installedRoot, 'dist/src/index.js')).href)});
const ctx=new Context();const fiber=ctx.plugin(plugin,{});
try{await fiber.await();const status=ctx.get('onebotPersonality')?.getStatus();assert.equal(status?.state,'disabled');assert.equal(status?.code,'disabled-by-configuration');}
finally{await fiber.dispose();assert.equal(ctx.get('onebotPersonality'),undefined);await ctx.fiber.dispose();}
process.stdout.write('disabled load and unload verified\\n');`;
  await run(['--input-type=module', '-e', smoke], 'mount-disabled', 30_000);
  await run([cli, 'plugin', '--profile', profile, 'remove', report.package], 'uninstall');
  const removed = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(removed.dependencies?.[report.package], undefined);
  let remains = true; try { await lstat(installedRoot); } catch (failure) { if (failure?.code === 'ENOENT') remains = false; else throw failure; }
  assert.equal(remains, false, 'removed alias remains installed');
  const result = { package: report.package, version: report.version, sha256: report.sha256, root,
    profile: expectedDir, install: true, composition: true, defaultDisabledLoad: true, unload: true, uninstall: true,
    installScripts: 'ignored', currentProfileChanged: false, renderedDisplay: 'unverified' };
  await writeFile(join(root, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 4, 'usage: check-isolated-profile.mjs <archive.tgz> <public-dsh-bin.js>');
    process.stdout.write(`${JSON.stringify(await checkIsolatedProfile(process.argv[2], process.argv[3]))}\n`);
  } catch (error) { process.stderr.write(`${error instanceof assert.AssertionError ? error.message : 'isolated profile check failed'}\n`); process.exitCode = 1; }
}
