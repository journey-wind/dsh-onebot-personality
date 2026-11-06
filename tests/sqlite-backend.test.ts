import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage';
import { OwnerLock } from '../src/storage/owner.js';
import type { OwnerIdentity } from '../src/storage/repository.js';
import { OwnedSqliteBackend, OwnedStorageError } from '../src/storage/sqlite.js';

// Authored only: no tests, processes, ACL changes, installs or Host storage are run by this task.
const SPEC: KvUnitDescriptor = { name: 'control', version: 1, tables: ['records'], hasGlobal: true };
function codeIs(code: string): (error: unknown) => boolean {
  return error => error instanceof Error && 'code' in error && error.code === code
    && error.message === code && !('cause' in error)
    && (code !== 'unknown-state' || error instanceof OwnedStorageError);
}
async function fixture(t: TestContext) {
  const parent = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(parent, 'personality-owned-sqlite-')));
  const identity = lstatSync(root, { bigint: true });
  const resources: { close(): Promise<void> }[] = [];
  t.after(async () => {
    let firstError: unknown;
    for (const resource of [...resources].reverse()) {
      try { await resource.close(); } catch (error) { firstError ??= error; }
    }
    // Verify the exact absolute deletion target and identity before recursive cleanup.
    assert.equal(resolve(root), root);
    assert.equal(dirname(root), parent);
    assert.match(basename(root), /^personality-owned-sqlite-/);
    const current = lstatSync(root, { bigint: true });
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.isDirectory(), true);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.equal(realpathSync.native(root), root);
    rmSync(root, { recursive: true, force: true });
    if (firstError) throw firstError;
  });
  const acquire = async () => {
    const owner = await OwnerLock.acquire(join(root, 'owner.sqlite'));
    resources.push(owner);
    return owner;
  };
  const owner = await acquire();
  return {
    root, owner, acquire,
    backend(identity: OwnerIdentity = owner) {
      const backend = new OwnedSqliteBackend(root, identity);
      resources.push(backend);
      return backend;
    },
    file(name = SPEC.name) { return join(root, `${name}.sqlite`); },
  };
}
function mutate(path: string, operation: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try { operation(db); } finally { db.close(); }
}
function skipSymlink(t: TestContext, error: unknown): boolean {
  if (process.platform === 'win32' && typeof error === 'object' && error !== null
    && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
    t.skip('Windows symlink creation privileges unavailable');
    return true;
  }
  return false;
}

test('constructor is inert; initial schema, opaque keys, overwrite and cold persistence', async t => {
  const f = await fixture(t);
  const before = readdirSync(f.root);
  const backend = f.backend();
  assert.deepEqual(readdirSync(f.root), before);
  const unit = await backend.kv.open(SPEC);
  const empty = await unit.loadAll();
  assert.equal(empty.global, null);
  assert.deepEqual(Object.keys(empty.tables), ['records']);
  assert.deepEqual(Object.keys(empty.tables.records!), []);
  const key = "../__proto__'; DROP TABLE owned_records; --\0";
  await unit.putRecord('records', key, { text: 'first' });
  await unit.putRecord('records', key, { text: 'second', list: [null, true, 42] });
  await unit.putRecord('records', '__proto__', { safe: true });
  await unit.setGlobal({ revision: 2 });
  const snapshot = await unit.loadAll();
  (snapshot.global as { revision: number }).revision = 999;
  assert.deepEqual((await unit.loadAll()).global, { revision: 2 });
  await backend.close();
  await f.owner.close();
  assert.equal(existsSync(join(f.root, 'owner.sqlite')), true);
  const nextOwner = await f.acquire();
  const nextBackend = f.backend(nextOwner);
  const next = await nextBackend.kv.open(SPEC);
  const restored = await next.loadAll();
  assert.deepEqual(restored.global, { revision: 2 });
  assert.deepEqual(restored.tables.records![key], { text: 'second', list: [null, true, 42] });
  assert.deepEqual(restored.tables.records!.__proto__, { safe: true });
  assert.deepEqual(readdirSync(f.root).sort(), ['control.sqlite', 'owner.sqlite']);
});

test('duplicate open is blocked; closing releases the name, not the caller owner', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const first = await backend.kv.open(SPEC);
  await assert.rejects(backend.kv.open(SPEC), codeIs('already-open'));
  await first.close();
  await first.close();
  const next = await backend.kv.open(SPEC);
  await next.setGlobal({ reopened: true });
  await backend.close();
  assert.equal(f.owner.isHeld(), true);
  await assert.rejects(next.loadAll(), codeIs('closed'));
  await assert.rejects(backend.kv.open(SPEC), codeIs('closed'));
  await Promise.all([backend.close(), backend.close()]);
});

test('duplicate backend instances cannot open the same unit; stale close cannot release a new handle', async t => {
  const f = await fixture(t);
  const firstBackend = f.backend();
  const secondBackend = f.backend();
  const first = await firstBackend.kv.open(SPEC);
  await assert.rejects(secondBackend.kv.open(SPEC), codeIs('already-open'));
  await first.close();
  const next = await secondBackend.kv.open(SPEC);
  await first.close();
  await assert.rejects(firstBackend.kv.open(SPEC), codeIs('already-open'));
  await next.setGlobal({ exclusive: true });
  await assert.rejects(f.acquire(), error => error instanceof Error && 'code' in error && error.code === 'OWNER_BUSY');
});

test('separate domain files isolate globals, records and unit lifecycle', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const control = await backend.kv.open(SPEC);
  const ledger = await backend.kv.open({ ...SPEC, name: 'deletion_ledger' });
  await control.setGlobal({ body: 'private' });
  await ledger.setGlobal({ sequence: 1 });
  await control.putRecord('records', 'same', { side: 'control' });
  await ledger.putRecord('records', 'same', { side: 'ledger' });
  await control.close();
  assert.deepEqual((await ledger.loadAll()).global, { sequence: 1 });
  assert.deepEqual((await ledger.loadAll()).tables.records!.same, { side: 'ledger' });
  assert.equal(existsSync(f.file('deletion_ledger')), true);
  assert.equal(existsSync(f.file('control')), true);
});

test('exact versions only; compatibleVersions cannot migrate single-layout data', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  await (await backend.kv.open(SPEC)).close();
  await assert.rejects(backend.kv.open({ ...SPEC, version: 2, compatibleVersions: [1] }), codeIs('version-mismatch'));
  await assert.rejects(backend.kv.open({ ...SPEC, tables: ['other'] }), codeIs('malformed-medium'));
  await assert.rejects(backend.kv.open({ ...SPEC, hasGlobal: false }), codeIs('malformed-medium'));
  await (await backend.kv.open(SPEC)).close();
});

test('invalid descriptors are rejected without creating any unit files', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const before = readdirSync(f.root);
  const invalid: unknown[] = [null, {}, { ...SPEC, name: '../host' }, { ...SPEC, name: 'with-hyphen' },
    { ...SPEC, name: 'Uppercase' }, { ...SPEC, name: 'owner' }, { ...SPEC, version: -1 }, { ...SPEC, version: 1.5 },
    { ...SPEC, version: Number.MAX_SAFE_INTEGER + 1 }, { ...SPEC, tables: ['dup', 'dup'] },
    { ...SPEC, tables: ['../bad'] }, { ...SPEC, tables: 'records' }, { ...SPEC, hasGlobal: 1 },
    { ...SPEC, layout: 'per-record' }, { ...SPEC, compatibleVersions: [-1] }];
  for (const value of invalid) await assert.rejects(backend.kv.open(value as KvUnitDescriptor), codeIs('invalid-descriptor'));
  assert.deepEqual(readdirSync(f.root), before);
  const tables = ['records'];
  const unit = await backend.kv.open({ ...SPEC, tables });
  tables.push('undeclared');
  await assert.rejects(unit.putRecord('undeclared', 'key', {}), codeIs('unknown-table'));
});

test('table/global/key/JSON validation rejects before writes without poisoning unit', async t => {
  const f = await fixture(t);
  const unit = await f.backend().kv.open({ ...SPEC, hasGlobal: false });
  await assert.rejects(unit.setGlobal({}), codeIs('global-not-declared'));
  await assert.rejects(unit.putRecord('unknown', 'key', {}), codeIs('unknown-table'));
  await assert.rejects(unit.deleteRecord('unknown', 'key'), codeIs('unknown-table'));
  await assert.rejects(unit.putRecord('records', 1 as unknown as string, {}), codeIs('invalid-key'));
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error(f.root); } });
  const customArray = Object.defineProperty([], 'toJSON', { value: () => ({ unexpected: true }) });
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, { value: undefined }, cycle, new Date(), [undefined], accessor, customArray]) {
    await assert.rejects(unit.putRecord('records', 'bad', value), codeIs('invalid-value'));
  }
  await unit.putRecord('records', 'ok', { value: 1 });
  await assert.rejects(unit.deleteRecords('records', ['ok', 1] as unknown as string[]), codeIs('invalid-key'));
  assert.deepEqual((await unit.loadAll()).tables.records!.ok, { value: 1 });
});

test('batch deletion is atomic, deduplicated, idempotent and durable on reopen', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const unit = await backend.kv.open(SPEC);
  for (const key of ['a', 'b', 'c']) await unit.putRecord('records', key, { key });
  await unit.deleteRecords('records', ['a', 'b', 'a', 'missing']);
  await unit.deleteRecord('records', 'missing');
  await unit.deleteRecords('records', []);
  await unit.close();
  const restored = await (await backend.kv.open(SPEC)).loadAll();
  assert.deepEqual(Object.keys(restored.tables.records!), ['c']);
});

test('SQLite mid-batch abort rolls back every deletion and quarantines until close/reopen', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const unit = await backend.kv.open(SPEC);
  await unit.putRecord('records', 'a', 1);
  await unit.putRecord('records', 'b', 2);
  // Test-only native fault: no production injection API and no arbitrary SQL entry point.
  mutate(f.file(), db => db.exec("CREATE TRIGGER fail_second BEFORE DELETE ON owned_records WHEN OLD.key = 'b' BEGIN SELECT RAISE(ABORT, 'injected'); END"));
  await assert.rejects(unit.deleteRecords('records', ['a', 'b']), codeIs('unknown-state'));
  await assert.rejects(unit.loadAll(), codeIs('unknown-state'));
  await assert.rejects(unit.setGlobal({}), codeIs('unknown-state'));
  await assert.rejects(unit.deleteRecord('records', 'a'), codeIs('unknown-state'));
  await unit.close();
  await assert.rejects(unit.loadAll(), codeIs('closed'));
  mutate(f.file(), db => db.exec('DROP TRIGGER fail_second'));
  const restored = await (await backend.kv.open(SPEC)).loadAll();
  assert.equal(restored.tables.records!.a, 1);
  assert.equal(restored.tables.records!.b, 2);
});

test('busy write never acknowledges success or serves a stale snapshot', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const unit = await backend.kv.open(SPEC);
  await unit.setGlobal({ old: true });
  const blocker = new DatabaseSync(f.file());
  try {
    blocker.exec('BEGIN IMMEDIATE');
    await assert.rejects(unit.setGlobal({ new: true }), codeIs('unknown-state'));
    await assert.rejects(unit.loadAll(), codeIs('unknown-state'));
  } finally { if (blocker.isTransaction) blocker.exec('ROLLBACK'); blocker.close(); }
  await unit.close();
  assert.deepEqual((await (await backend.kv.open(SPEC)).loadAll()).global, { old: true });
});

test('real owner loss fences access; close is still allowed and never deletes the lock', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const unit = await backend.kv.open(SPEC);
  await unit.setGlobal({ prior: true });
  await f.owner.close();
  await assert.rejects(unit.setGlobal({ leaked: true }), codeIs('owner-not-held'));
  await assert.rejects(unit.loadAll(), codeIs('unknown-state'));
  await assert.rejects(backend.kv.open({ ...SPEC, name: 'other' }), codeIs('owner-not-held'));
  await backend.close();
  assert.equal(existsSync(join(f.root, 'owner.sqlite')), true);
});

test('read-only owner fault after COMMIT reports unknown outcome, persisted value only on reopen', async t => {
  const f = await fixture(t);
  let checks = 0;
  let loseAt = Infinity;
  const faultOwner: OwnerIdentity = Object.freeze({
    ownerId: f.owner.ownerId,
    isHeld: () => f.owner.isHeld() && ++checks < loseAt,
  });
  const backend = f.backend(faultOwner);
  const unit = await backend.kv.open(SPEC);
  // setGlobal currently checks twice before BEGIN, once before COMMIT, once after.
  loseAt = checks + 4;
  await assert.rejects(unit.setGlobal({ committed: true }), codeIs('unknown-state'));
  await assert.rejects(unit.loadAll(), codeIs('unknown-state'));
  loseAt = Infinity;
  await unit.close();
  const restored = await (await backend.kv.open(SPEC)).loadAll();
  assert.deepEqual(restored.global, { committed: true });
});

test('close drains synchronous writes before acknowledgement and only closes owned databases', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const unit = await backend.kv.open(SPEC);
  const write = unit.setGlobal({ finished: true });
  const close = backend.close();
  await Promise.all([write, close]);
  assert.equal(f.owner.isHeld(), true);
  const restored = await (await f.backend().kv.open(SPEC)).loadAll();
  assert.deepEqual(restored.global, { finished: true });
});

test('existing zero, garbage and truncated files fail closed without reinitialization', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  await (await backend.kv.open(SPEC)).close();
  const truncated = readFileSync(f.file()).subarray(0, 100);
  for (const [name, bytes] of [['zero', Buffer.alloc(0)], ['garbage', Buffer.alloc(4096, 0x41)], ['truncated', truncated]] as const) {
    const path = f.file(name);
    writeFileSync(path, bytes, { mode: 0o600 });
    await assert.rejects(backend.kv.open({ ...SPEC, name }), codeIs('malformed-medium'));
    assert.deepEqual(readFileSync(path), bytes);
  }
});

test('unknown schema, invalid JSON, unknown tables and undeclared globals reject on open', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  const corruptions: ((db: DatabaseSync) => void)[] = [
    db => db.exec('CREATE TABLE foreign_table(value TEXT)'),
    db => db.prepare('INSERT INTO owned_global(id, value) VALUES(1, ?)').run('{broken'),
    db => db.prepare('INSERT INTO owned_global(id, value) VALUES(1, ?)').run('1e999'),
    db => db.prepare('INSERT INTO owned_records(table_name, key, value) VALUES(?, ?, ?)').run('unknown', 'x', '{}'),
    db => db.prepare('INSERT INTO owned_records(table_name, key, value) VALUES(?, ?, ?)').run('records', 'x', 'not json'),
    db => db.prepare('UPDATE owned_meta SET value = ?').run('{broken'),
  ];
  for (let i = 0; i < corruptions.length; i++) {
    const name = `corrupt_${i}`;
    await (await backend.kv.open({ ...SPEC, name })).close();
    mutate(f.file(name), corruptions[i]!);
    await assert.rejects(backend.kv.open({ ...SPEC, name }), codeIs('malformed-medium'));
  }
  const spec = { ...SPEC, name: 'no_global', hasGlobal: false };
  await (await backend.kv.open(spec)).close();
  mutate(f.file(spec.name), db => db.prepare('INSERT INTO owned_global(id, value) VALUES(1, ?)').run('{}'));
  await assert.rejects(backend.kv.open(spec), codeIs('malformed-medium'));
});

test('incompatible unit identity cannot borrow another owned database', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  await (await backend.kv.open(SPEC)).close();
  mutate(f.file(), db => {
    const row = db.prepare('SELECT value FROM owned_meta WHERE id = 1').get();
    const meta = JSON.parse(String(row?.value));
    meta.name = 'some_other_unit';
    db.prepare('UPDATE owned_meta SET value = ? WHERE id = 1').run(JSON.stringify(meta));
  });
  await assert.rejects(backend.kv.open(SPEC), codeIs('malformed-medium'));
});

test('path errors are fixed and contain no paths or native causes', async t => {
  const f = await fixture(t);
  for (const path of ['', 'relative', ':memory:', 'file:host.sqlite', join(f.root, 'bad\0root')]) {
    assert.throws(() => new OwnedSqliteBackend(path, f.owner), codeIs('invalid-path'));
  }
  assert.throws(() => new OwnedSqliteBackend(join(f.root, 'missing'), f.owner), codeIs('unsafe-path'));
  assert.equal(existsSync(join(f.root, 'missing')), false);
  if (process.platform === 'win32') {
    for (const path of ['\\\\server\\share', '\\\\?\\C:\\private', `${f.root}:stream`, join(f.root, 'NUL')]) {
      assert.throws(() => new OwnedSqliteBackend(path, f.owner), codeIs('invalid-path'));
    }
  }
});

test('hardlink and nonregular unit files are rejected', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  await (await backend.kv.open(SPEC)).close();
  linkSync(f.file(), f.file('hardlink'));
  await assert.rejects(backend.kv.open({ ...SPEC, name: 'hardlink' }), codeIs('unsafe-path'));
  mkdirSync(f.file('directory'));
  await assert.rejects(backend.kv.open({ ...SPEC, name: 'directory' }), codeIs('unsafe-path'));
});

test('unexpected WAL/SHM sidecars are rejected without recovery or deletion', async t => {
  const f = await fixture(t);
  const backend = f.backend();
  for (const [name, suffix] of [['with_wal', '-wal'], ['with_shm', '-shm']] as const) {
    await (await backend.kv.open({ ...SPEC, name })).close();
    const path = `${f.file(name)}${suffix}`;
    const bytes = Buffer.from('foreign-sidecar');
    writeFileSync(path, bytes, { mode: 0o600 });
    await assert.rejects(backend.kv.open({ ...SPEC, name }), codeIs('malformed-medium'));
    assert.deepEqual(readFileSync(path), bytes);
  }
});

test('symlink root, ancestors and unit files are rejected without following them', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.root, 'actual'), { mode: 0o700 });
  mkdirSync(join(f.root, 'actual', 'nested'), { mode: 0o700 });
  try { symlinkSync(join(f.root, 'actual'), join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (skipSymlink(t, error)) return; throw error; }
  assert.throws(() => new OwnedSqliteBackend(join(f.root, 'alias'), f.owner), codeIs('unsafe-path'));
  assert.throws(() => new OwnedSqliteBackend(join(f.root, 'alias', 'nested'), f.owner), codeIs('unsafe-path'));
  const backend = f.backend();
  await (await backend.kv.open(SPEC)).close();
  try { symlinkSync(f.file(), f.file('linked'), 'file'); }
  catch (error) { if (skipSymlink(t, error)) return; throw error; }
  await assert.rejects(backend.kv.open({ ...SPEC, name: 'linked' }), codeIs('unsafe-path'));
});

test('POSIX existing privacy is validated, never repaired', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const backend = f.backend();
  await (await backend.kv.open(SPEC)).close();
  chmodSync(f.file(), 0o644);
  await assert.rejects(backend.kv.open(SPEC), codeIs('unsafe-path'));
  assert.equal(lstatSync(f.file()).mode & 0o777, 0o644);
  mkdirSync(join(f.root, 'public'), { mode: 0o755 });
  assert.throws(() => new OwnedSqliteBackend(join(f.root, 'public'), f.owner), codeIs('unsafe-path'));
  assert.equal(lstatSync(join(f.root, 'public')).mode & 0o777, 0o755);
});
