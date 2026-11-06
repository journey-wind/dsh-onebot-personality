import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { OwnerLock } from '../src/storage/owner.js';

interface OwnerChild {
  process: ChildProcess;
  reply: Promise<{ code: string; ownerId?: string }>;
  exited: Promise<void>;
}

// Only dedicated temporary owner files and native child processes are used.
// Windows DACL privacy remains a deployment precondition, not a test claim.
function fixture(t: TestContext): {
  root: string;
  acquire: (path: string) => Promise<OwnerLock>;
  startOwner: (path: string) => OwnerChild;
} {
  const temporaryParent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(temporaryParent, 'personality-owner-')));
  const locks: OwnerLock[] = [];
  const children: OwnerChild[] = [];
  t.after(async () => {
    try {
      for (const child of children) {
        if (child.process.exitCode === null && child.process.signalCode === null) {
          child.process.kill('SIGKILL');
        }
        await child.exited;
      }
      for (const lock of locks) await lock.close();
    } finally {
      // Verify the exact resolved, private fixture target before recursive delete.
      assert.equal(isAbsolute(root), true);
      assert.equal(resolve(root), root);
      assert.equal(dirname(root), temporaryParent);
      assert.equal(basename(root).startsWith('personality-owner-'), true);
      assert.equal(lstatSync(root).isDirectory(), true);
      assert.equal(lstatSync(root).isSymbolicLink(), false);
      assert.equal(realpathSync.native(root), root);
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    async acquire(path) {
      const lock = await OwnerLock.acquire(path);
      locks.push(lock);
      return lock;
    },
    startOwner(path) {
      assert.equal(dirname(path), root);
      const source = `
        import { OwnerLock } from ${JSON.stringify(new URL('../src/storage/owner.js', import.meta.url).href)};
        try {
          const lock = await OwnerLock.acquire(process.argv[1]);
          const keepAlive = setInterval(() => {}, 1000);
          process.on('message', async (message) => {
            if (message !== 'close') return;
            await lock.close();
            clearInterval(keepAlive);
            process.disconnect();
          });
          process.send({ code: lock.isHeld() ? 'OWNER_HELD' : 'OWNER_NOT_HELD', ownerId: lock.ownerId });
        } catch (error) {
          process.send({ code: error.code ?? 'CHILD_FAILED' });
          process.disconnect();
        }
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, path], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const exited = new Promise<void>((done) => child.once('close', () => done()));
      const reply = new Promise<{ code: string; ownerId?: string }>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('owner child response timeout')), 10_000);
        const clean = (): void => { clearTimeout(timer); };
        child.once('message', (message) => {
          clean();
          done(message as { code: string; ownerId?: string });
        });
        child.once('error', (error) => { clean(); fail(error); });
        child.once('exit', () => { clean(); fail(new Error('owner child exited before response')); });
      });
      const tracked = { process: child, reply, exited };
      children.push(tracked);
      return tracked;
    },
  };
}

function codeIs(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error
    && 'code' in error && error.code === code
    && error.name === 'OwnerLockError' && error.message === code
    && !('cause' in error);
}

function skipUnavailableSymlink(t: TestContext, error: unknown): boolean {
  if (process.platform === 'win32' && typeof error === 'object' && error !== null
    && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
    t.skip('Windows symlink creation privileges are unavailable');
    return true;
  }
  return false;
}

test('a valid foreign application database is rejected without changing its bytes or metadata', async (t) => {
  const f = fixture(t); const path = join(f.root, 'foreign.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE private_data (value TEXT); INSERT INTO private_data VALUES ('DO_NOT_TOUCH'); PRAGMA application_id=1234; PRAGMA user_version=7");
  db.close(); const before = readFileSync(path);
  await assert.rejects(f.acquire(path), codeIs('OWNER_UNSAFE_PATH'));
  assert.deepEqual(readFileSync(path), before);
});

test('empty foreign or unsupported owner headers cannot be silently initialized or migrated', async (t) => {
  const f = fixture(t);
  for (const [name, application, version] of [['foreign', 5678, 1], ['future', 0x44534f57, 2]] as const) {
    const path = join(f.root, `${name}.sqlite`); const db = new DatabaseSync(path);
    db.exec(`PRAGMA application_id=${application}; PRAGMA user_version=${version}`); db.close();
    const before = readFileSync(path);
    await assert.rejects(f.acquire(path), codeIs('OWNER_UNSAFE_PATH'));
    assert.deepEqual(readFileSync(path), before);
  }
});

test('same-path connections exclude a second owner and release on close', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'lock.sqlite');
  const first = await f.acquire(path);
  assert.equal(first.isHeld(), true);
  assert.doesNotThrow(() => first.assertHeld());
  assert.match(first.ownerId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

  await assert.rejects(f.acquire(path), codeIs('OWNER_BUSY'));
  assert.equal(first.isHeld(), true);
  await first.close();

  const next = await f.acquire(path);
  assert.equal(next.isHeld(), true);
  assert.notEqual(next.ownerId, first.ownerId);
});

test('native child processes exclude a second owner and release after graceful close', {
  timeout: 15_000,
}, async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'owner.sqlite');
  const first = f.startOwner(path);
  const initial = await first.reply;
  assert.equal(initial.code, 'OWNER_HELD');
  const contender = f.startOwner(path);
  assert.deepEqual(await contender.reply, { code: 'OWNER_BUSY' });
  await contender.exited;
  first.process.send('close');
  await first.exited;
  const next = await f.acquire(path);
  assert.equal(next.isHeld(), true);
  assert.notEqual(next.ownerId, initial.ownerId);
});

test('forced native process death releases exclusive ownership without journal recovery', {
  timeout: 15_000,
}, async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'owner.sqlite');
  const first = f.startOwner(path);
  const initial = await first.reply;
  assert.equal(initial.code, 'OWNER_HELD');
  const contender = f.startOwner(path);
  assert.deepEqual(await contender.reply, { code: 'OWNER_BUSY' });
  await contender.exited;
  assert.equal(first.process.kill('SIGKILL'), true);
  await first.exited;
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(existsSync(`${path}${suffix}`), false);
  }
  const next = f.startOwner(path);
  const reacquired = await next.reply;
  assert.equal(reacquired.code, 'OWNER_HELD');
  assert.notEqual(reacquired.ownerId, initial.ownerId);
  next.process.send('close');
  await next.exited;
});

test('canonical absolute path is stable across lexical aliases', async (t) => {
  const f = fixture(t);
  const path = `${f.root}${sep}created${sep}.${sep}owner.sqlite`;
  const first = await f.acquire(path);
  const canonical = realpathSync.native(join(f.root, 'created', 'owner.sqlite'));
  assert.equal(first.canonicalPath, canonical);
  await assert.rejects(f.acquire(canonical), codeIs('OWNER_BUSY'));
  await first.close();
  const next = await f.acquire(canonical);
  assert.equal(next.canonicalPath, canonical);
});

test('only new parent directories and a dedicated regular lock file are created', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'new-parent', 'nested', 'owner.sqlite');
  const lock = await f.acquire(path);
  assert.equal(lock.isHeld(), true);
  assert.equal(lstatSync(path).isFile(), true);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    assert.equal(existsSync(`${path}${suffix}`), false);
  }
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.root, 'new-parent')).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.root, 'new-parent', 'nested')).mode & 0o777, 0o700);
  }
  // Windows ACL privacy is a deployment precondition, not established by mode.
});

test('memory, relative, empty, NUL and directory paths are rejected', async (t) => {
  const f = fixture(t);
  for (const path of ['', ':memory:', 'relative.sqlite', './owner.sqlite',
    'file:owner.sqlite?mode=memory', `${f.root}${sep}bad\0name.sqlite`, `${f.root}${sep}`]) {
    await assert.rejects(f.acquire(path), codeIs('OWNER_INVALID_PATH'));
  }
  await assert.rejects(f.acquire(f.root), codeIs('OWNER_UNSAFE_PATH'));
});

test('Windows device, network and alternate-stream paths are rejected', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const f = fixture(t);
  for (const path of ['\\\\server\\share\\owner.sqlite', '\\\\?\\C:\\owner.sqlite',
    '\\\\.\\C:\\owner.sqlite', 'C:owner.sqlite', join(f.root, 'owner.sqlite:stream'),
    join(f.root, 'NUL.sqlite'), join(f.root, 'owner.sqlite.')]) {
    await assert.rejects(f.acquire(path), codeIs('OWNER_INVALID_PATH'));
  }
});

test('close is idempotent, closed ownership stays false and assertHeld is fixed-code', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'lock.sqlite');
  const lock = await f.acquire(path);
  const id = lock.ownerId;
  const canonical = lock.canonicalPath;
  await Promise.all([lock.close(), lock.close(), lock.close()]);
  await lock.close();
  assert.equal(lock.isHeld(), false);
  assert.throws(() => lock.assertHeld(), codeIs('OWNER_CLOSED'));
  assert.equal(lock.ownerId, id);
  assert.equal(lock.canonicalPath, canonical);
  assert.equal(existsSync(path), true);
  assert.equal((await f.acquire(path)).isHeld(), true);
});

test('existing lock file is reused without unlinking or changing its ownership/mode', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'existing.sqlite');
  await (await f.acquire(path)).close();
  const before = statSync(path);
  const bytes = readFileSync(path);
  const lock = await f.acquire(path);
  await lock.close();
  const after = statSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode, before.mode);
  assert.deepEqual(readFileSync(path), bytes);
});

test('unsafe existing POSIX file mode is rejected rather than repaired', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'public.sqlite');
  writeFileSync(path, '', { mode: 0o600 });
  chmodSync(path, 0o644);
  const before = statSync(path);
  await assert.rejects(f.acquire(path), codeIs('OWNER_UNSAFE_PATH'));
  assert.equal(statSync(path).mode, before.mode);
  assert.equal(statSync(path).ino, before.ino);
});

test('unsafe non-sticky POSIX parent is rejected without creating a lock', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = fixture(t);
  const parent = join(f.root, 'shared');
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o777);
  const path = join(parent, 'owner.sqlite');
  await assert.rejects(f.acquire(path), codeIs('OWNER_UNSAFE_PATH'));
  assert.equal(existsSync(path), false);
  assert.equal(statSync(parent).mode & 0o777, 0o777);
});

test('ownership fails closed after a path safety check becomes uncertain', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'owner.sqlite');
  const lock = await f.acquire(path);
  chmodSync(path, 0o644);
  assert.equal(lock.isHeld(), false);
  assert.throws(() => lock.assertHeld(), codeIs('OWNER_NOT_HELD'));
  chmodSync(path, 0o600);
  assert.equal(lock.isHeld(), false); // Do not silently re-enter ownership.
  await lock.close();
  assert.equal((await f.acquire(path)).isHeld(), true);
});

test('directory and hard-linked lock targets are rejected', async (t) => {
  const f = fixture(t);
  const directory = join(f.root, 'directory.sqlite');
  mkdirSync(directory);
  await assert.rejects(f.acquire(directory), codeIs('OWNER_UNSAFE_PATH'));

  const target = join(f.root, 'target.sqlite');
  const alias = join(f.root, 'hardlink.sqlite');
  writeFileSync(target, '', { mode: 0o600 });
  linkSync(target, alias);
  await assert.rejects(f.acquire(alias), codeIs('OWNER_UNSAFE_PATH'));
  assert.equal(statSync(target).nlink, 2);
});

test('symlink lock target is rejected and the target is preserved', async (t) => {
  const f = fixture(t);
  const target = join(f.root, 'target.sqlite');
  const alias = join(f.root, 'alias.sqlite');
  writeFileSync(target, '', { mode: 0o600 });
  try {
    symlinkSync(target, alias, 'file');
  } catch (error) {
    if (skipUnavailableSymlink(t, error)) return;
    throw error;
  }
  await assert.rejects(f.acquire(alias), codeIs('OWNER_UNSAFE_PATH'));
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.equal(readFileSync(target).length, 0);
});

test('symlink or Windows junction parent is rejected', async (t) => {
  const f = fixture(t);
  const target = join(f.root, 'real-parent');
  const alias = join(f.root, 'alias-parent');
  mkdirSync(target);
  try {
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (skipUnavailableSymlink(t, error)) return;
    throw error;
  }
  await assert.rejects(f.acquire(join(alias, 'owner.sqlite')), codeIs('OWNER_UNSAFE_PATH'));
  assert.equal(existsSync(join(target, 'owner.sqlite')), false);
});

test('uncertain pre-existing sidecars fail closed and are never removed', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'owner.sqlite');
  const sidecar = `${path}-journal`;
  writeFileSync(sidecar, 'private-marker', { mode: 0o600 });
  await assert.rejects(f.acquire(path), codeIs('OWNER_UNSAFE_PATH'));
  assert.equal(readFileSync(sidecar, 'utf8'), 'private-marker');
  assert.equal(existsSync(path), true);
});

test('SQLite failures have fixed sanitized codes and do not replace existing data', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'secret-marker-invalid.sqlite');
  const original = Buffer.from('not a SQLite database; do not overwrite');
  writeFileSync(path, original, { mode: 0o600 });
  await assert.rejects(f.acquire(path), (error) => {
    assert.equal(codeIs('OWNER_ACQUIRE_FAILED')(error), true);
    assert.equal(String(error).includes(path), false);
    assert.equal(String(error).includes('secret-marker'), false);
    return true;
  });
  assert.deepEqual(readFileSync(path), original);
});
