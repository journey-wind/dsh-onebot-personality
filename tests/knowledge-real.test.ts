import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('published knowledge raw-text API persists/deletes across cold contexts with every path isolated in a child', { timeout: 90_000 }, async t => {
  const parent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(parent, 'personality-knowledge-p6-')));
  const identity = lstatSync(root, { bigint: true }); const nonce = randomUUID();
  writeFileSync(join(root, 'p6-child-permission'), nonce, { mode: 0o600, flag: 'wx' });
  t.after(() => {
    assert.equal(isAbsolute(root), true); assert.equal(resolve(root), root); assert.equal(dirname(root), parent);
    assert.equal(basename(root).startsWith('personality-knowledge-p6-'), true);
    assert.equal(realpathSync.native(root), root); const current = lstatSync(root, { bigint: true });
    assert.equal(current.isSymbolicLink(), false); assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev);
    // execFile settles only after close (or timeout kill), so no child-owned DB handle survives this delete.
    rmSync(root, { recursive: true, force: true });
  });
  const output = await new Promise<string>((done, fail) => {
    execFile(process.execPath, [fileURLToPath(new URL('./helpers/real-knowledge.js', import.meta.url)), root, nonce],
      { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576 }, (error, stdout, stderr) => {
        if (error) fail(new Error(`isolated knowledge child failed: ${stdout}\n${stderr}`, { cause: error }));
        else done(stdout);
      });
  });
  assert.equal(output.includes('P6_KNOWLEDGE_OK'), true);
});
