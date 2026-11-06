import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage';
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OwnerIdentity } from './repository.js';

export type OwnedStorageErrorCode = 'invalid-path' | 'unsafe-path' | 'invalid-descriptor' | 'already-open'
  | 'unknown-table' | 'invalid-key' | 'invalid-value' | 'global-not-declared'
  | 'owner-not-held' | 'close-failed' | 'closed' | 'malformed-medium'
  | 'version-mismatch' | 'unknown-state';

/** Backend-specific failure, including uncertain outcomes absent from published rc.3's error union. */
export class OwnedStorageError extends Error {
  override readonly name = 'OwnedStorageError';
  constructor(readonly code: OwnedStorageErrorCode) { super(code); }
}
function failure(code: OwnedStorageErrorCode): Error {
  if (code === 'closed' || code === 'malformed-medium' || code === 'version-mismatch') {
    return new StorageError(code, code);
  }
  return new OwnedStorageError(code);
}
function known(error: unknown): error is Error {
  return error instanceof OwnedStorageError || (error instanceof StorageError
    && ['closed', 'malformed-medium', 'version-mismatch'].includes(error.code)
    && error.message === error.code && !('cause' in error));
}
function exists(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.ino !== 0n && b.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}
function directory(stat: BigIntStats, privateRoot = false): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe-path');
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid === undefined || (stat.uid !== BigInt(uid) && stat.uid !== 0n)
      || ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)
      || (privateRoot && (stat.uid !== BigInt(uid) || (stat.mode & 0o077n) !== 0n))) {
      throw failure('unsafe-path');
    }
  }
}
function regular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw failure('unsafe-path');
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid === undefined || stat.uid !== BigInt(uid) || (stat.mode & 0o7777n) !== 0o600n) {
      throw failure('unsafe-path');
    }
  }
}
function ancestors(path: string): void {
  let current = parse(path).root;
  directory(lstatSync(current, { bigint: true }));
  for (const segment of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    directory(lstatSync(current, { bigint: true }), current === path);
  }
}
function rootPath(input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || !isAbsolute(input)
    || input.startsWith('//') || input.startsWith('\\\\')) throw failure('invalid-path');
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(input) || input.slice(2).includes(':')
    || input.slice(3).split(/[\\/]/).some(part =>
      (part !== '.' && part !== '..' && /[. ]$/.test(part))
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw failure('invalid-path');
  const path = resolve(input);
  ancestors(path);
  const canonical = realpathSync.native(path);
  if (canonical !== path) throw failure('unsafe-path');
  return canonical;
}
function sidecars(path: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const stat = exists(`${path}${suffix}`);
    if (!stat) continue;
    regular(stat);
    // DELETE journaling can recover its own regular hot journal. WAL is foreign.
    if (suffix !== '-journal') throw failure('malformed-medium');
  }
}
interface Descriptor {
  name: string; version: number; tables: string[]; hasGlobal: boolean; layout: 'single';
}
function descriptor(input: KvUnitDescriptor): Descriptor {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !UNIT_NAME_RE.test(input.name)
    || input.name === 'owner' // Never independently open/close the process-lock inode.
    || !Number.isSafeInteger(input.version) || input.version < 0 || !Array.isArray(input.tables)
    || Array.from(input.tables).some(t => typeof t !== 'string' || !UNIT_NAME_RE.test(t))
    || new Set(input.tables).size !== input.tables.length || typeof input.hasGlobal !== 'boolean'
    || (input.layout !== undefined && input.layout !== 'single')
    || (input.compatibleVersions !== undefined && (!Array.isArray(input.compatibleVersions)
      || Array.from(input.compatibleVersions).some(v => !Number.isSafeInteger(v) || v < 0)))) throw failure('invalid-descriptor');
  return { name: input.name, version: input.version, tables: [...input.tables].sort(), hasGlobal: input.hasGlobal, layout: 'single' };
}
function encode(value: unknown): string {
  // JSON only: do not silently discard undefined/functions, coerce NaN, or run toJSON.
  const visiting = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || visiting.has(item)) throw failure('invalid-value');
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) throw failure('invalid-value');
    visiting.add(item);
    if (Object.getOwnPropertySymbols(item).length) throw failure('invalid-value');
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (!property || !('value' in property)) throw failure('invalid-value');
        check(property.value);
      }
      if (Object.keys(item).length !== item.length
        || Object.getOwnPropertyNames(item).length !== item.length + 1) throw failure('invalid-value');
    } else {
      for (const property of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!property.enumerable || !('value' in property)) throw failure('invalid-value');
        check(property.value);
      }
    }
    visiting.delete(item);
  }
  try {
    check(value);
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw failure('invalid-value');
    return json;
  } catch { throw failure('invalid-value'); }
}
function decode(value: unknown): unknown {
  if (typeof value !== 'string') throw failure('malformed-medium');
  try {
    const decoded: unknown = JSON.parse(value);
    encode(decoded); // Includes overflowing JSON numbers such as 1e999.
    return decoded;
  } catch { throw failure('malformed-medium'); }
}

const SCHEMA = {
  owned_meta: 'CREATE TABLE owned_meta (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL) STRICT',
  owned_global: 'CREATE TABLE owned_global (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL) STRICT',
  owned_records: 'CREATE TABLE owned_records (table_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(table_name, key)) STRICT',
};
const FORMAT = 'onebot-owned-sqlite-v1';
// Also reject accidental second backend instances in the same JS module/process.
// Independent processes are excluded by the caller's shared owner.sqlite lock.
const OPEN_UNITS = new Set<string>();

/** Owned extension: published rc.3's KvUnit has no batch-delete member. */
export interface OwnedKvUnit extends KvUnit {
  deleteRecords(table: string, keys: readonly string[]): Promise<void>;
}
/** Covariant public facet; assignable to both published and newer KvFacet contracts. */
export interface OwnedKvFacet extends KvFacet {
  open(descriptor: KvUnitDescriptor): Promise<OwnedKvUnit>;
}

/** Public KV backend only; constructor checks an existing private root but opens/creates nothing. */
export class OwnedSqliteBackend implements StorageBackend {
  readonly kv: OwnedKvFacet;
  readonly #root: string;
  readonly #identity: BigIntStats;
  readonly #owner: OwnerIdentity;
  readonly #units = new Map<string, OwnedUnit>();
  readonly #failedOpens = new Map<string, DatabaseSync>();
  #closed = false;

  constructor(directory: string, owner: OwnerIdentity) {
    try {
      this.#root = rootPath(directory);
      this.#identity = lstatSync(this.#root, { bigint: true });
      this.#owner = owner;
      this.#assertOwner();
    } catch (error) { throw known(error) ? error : failure('unsafe-path'); }
    this.kv = Object.freeze({ open: async (input: KvUnitDescriptor): Promise<OwnedKvUnit> => this.#open(input) });
  }
  #assertOwner(): void {
    try { if (this.#owner.isHeld()) return; } catch { /* sanitized below */ }
    throw failure('owner-not-held');
  }
  #assertActive(): void {
    if (this.#closed) {
      try { this.#owner.isHeld(); } catch { /* closed wins */ }
      throw failure('closed');
    }
    this.#assertOwner();
    try {
      ancestors(this.#root);
      if (!same(this.#identity, lstatSync(this.#root, { bigint: true }))) throw failure('unsafe-path');
    } catch { throw failure('unsafe-path'); }
  }
  #open(input: KvUnitDescriptor): OwnedKvUnit {
    let database: DatabaseSync | undefined;
    let openedPath: string | undefined;
    let materializing = false;
    try {
      this.#assertActive();
      const spec = descriptor(input);
      if (this.#units.has(spec.name)) throw failure('already-open');
      const path = join(this.#root, `${spec.name}.sqlite`);
      if (OPEN_UNITS.has(path)) throw failure('already-open');
      let stat = exists(path);
      const fresh = stat === undefined;
      sidecars(path);
      if (fresh) {
        let fd: number | undefined;
        try {
          fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
          stat = fstatSync(fd, { bigint: true });
        } finally { if (fd !== undefined) closeSync(fd); }
      }
      if (!stat) throw failure('malformed-medium');
      regular(stat);
      const identity = stat;
      if (!fresh && stat.size < 512n) throw failure('malformed-medium');
      if (realpathSync.native(path) !== path) throw failure('unsafe-path');
      openedPath = path;
      database = new DatabaseSync(path, {
        enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false,
      });
      const assertPath = (): void => {
        this.#assertActive();
        const current = lstatSync(path, { bigint: true });
        regular(current);
        if (!same(identity, current)) throw failure('unsafe-path');
        sidecars(path);
      };
      assertPath();
      database.exec('PRAGMA busy_timeout = 0');
      if (!fresh) {
        const checks = database.prepare('PRAGMA quick_check').all();
        if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') throw failure('malformed-medium');
        const schema = database.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
        if (schema.length !== 3 || schema.some(row => !(String(row.name) in SCHEMA)
          || row.sql !== SCHEMA[row.name as keyof typeof SCHEMA])) throw failure('malformed-medium');
        const rows = database.prepare('SELECT id, value FROM owned_meta').all();
        if (rows.length !== 1 || rows[0]?.id !== 1) throw failure('malformed-medium');
        const saved = decode(rows[0].value) as Record<string, unknown> | null;
        if (!saved || typeof saved !== 'object' || saved.format !== FORMAT || saved.name !== spec.name
          || typeof saved.version !== 'number' || !Number.isSafeInteger(saved.version) || saved.version < 0
          || JSON.stringify(saved.tables) !== JSON.stringify(spec.tables)
          || saved.hasGlobal !== spec.hasGlobal || saved.layout !== 'single'
          || Object.keys(saved).sort().join(',') !== 'format,hasGlobal,layout,name,tables,version') throw failure('malformed-medium');
        if (saved.version !== spec.version) throw failure('version-mismatch');
      }
      const mode = database.prepare('PRAGMA journal_mode = DELETE').get();
      if (mode?.journal_mode !== 'delete') throw failure('malformed-medium');
      database.exec('PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF');
      if (database.prepare('PRAGMA synchronous').get()?.synchronous !== 2
        || database.prepare('PRAGMA secure_delete').get()?.secure_delete !== 1) throw failure('malformed-medium');
      if (fresh) {
        materializing = true;
        database.exec('BEGIN IMMEDIATE');
        for (const sql of Object.values(SCHEMA)) database.exec(sql);
        database.prepare('INSERT INTO owned_meta(id, value) VALUES(1, ?)').run(JSON.stringify({ format: FORMAT, ...spec }));
        assertPath();
        database.exec('COMMIT');
        // SQLite syncs its own files/journal; also persist a new directory entry on POSIX.
        if (process.platform !== 'win32') {
          const fd = openSync(this.#root, constants.O_RDONLY);
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      }
      const unit = new OwnedUnit(database, spec, assertPath, () => {
        if (this.#units.get(spec.name) === unit) {
          this.#units.delete(spec.name);
          OPEN_UNITS.delete(path);
        }
      }, () => { try { return this.#owner.isHeld(); } catch { return false; } });
      unit.read(); // Reject corrupt JSON, unknown tables and undeclared global before publishing.
      this.#units.set(spec.name, unit);
      OPEN_UNITS.add(path);
      database = undefined;
      return unit;
    } catch (error) {
      if (database) {
        try { if (database.isTransaction) database.exec('ROLLBACK'); } catch { /* no acknowledgement */ }
        try { database.close(); } catch { /* retain the owned handle for close() retry */ }
        if (database.isOpen && openedPath !== undefined) {
          this.#failedOpens.set(openedPath, database);
          OPEN_UNITS.add(openedPath);
          throw failure('close-failed');
        }
      }
      if (materializing) throw failure('unknown-state');
      throw known(error) ? error : failure('malformed-medium');
    }
  }
  async close(): Promise<void> {
    // Check ownership but always permit cleanup after loss. Never close the caller's lock.
    try { this.#owner.isHeld(); } catch { /* cleanup must still run */ }
    this.#closed = true;
    let failed = false;
    for (const unit of [...this.#units.values()]) {
      try { await unit.close(); } catch { failed = true; }
    }
    for (const [path, database] of this.#failedOpens) {
      try { if (database.isTransaction) database.exec('ROLLBACK'); } catch { failed = true; }
      try { if (database.isOpen) database.close(); } catch { failed = true; }
      if (!database.isOpen) {
        this.#failedOpens.delete(path);
        OPEN_UNITS.delete(path);
      }
    }
    if (failed) throw failure('close-failed');
  }
}

class OwnedUnit implements OwnedKvUnit {
  #closed = false;
  #unknown = false;
  readonly #database: DatabaseSync;
  constructor(
    database: DatabaseSync,
    private readonly spec: Descriptor,
    private readonly assertPath: () => void,
    private readonly released: () => void,
    private readonly ownerHeld: () => boolean,
  ) { this.#database = database; }
  #active(): void {
    if (this.#closed || this.#unknown) {
      this.ownerHeld();
      throw failure(this.#closed ? 'closed' : 'unknown-state');
    }
    try { this.assertPath(); }
    catch (error) { this.#unknown = true; throw known(error) ? error : failure('unknown-state'); }
  }
  #table(table: string): void {
    if (typeof table !== 'string' || !this.spec.tables.includes(table)) throw failure('unknown-table');
  }
  #key(key: string): void { if (typeof key !== 'string') throw failure('invalid-key'); }
  read(): { tables: Record<string, Record<string, unknown>>; global: unknown } {
    this.#active();
    try {
      const tables: Record<string, Record<string, unknown>> = Object.create(null);
      for (const table of this.spec.tables) tables[table] = Object.create(null);
      for (const row of this.#database.prepare('SELECT table_name, key, value FROM owned_records').all()) {
        if (typeof row.table_name !== 'string' || !this.spec.tables.includes(row.table_name)
          || typeof row.key !== 'string') throw failure('malformed-medium');
        tables[row.table_name]![row.key] = decode(row.value);
      }
      const globals = this.#database.prepare('SELECT id, value FROM owned_global').all();
      if (globals.length > 1 || (globals.length !== 0 && (!this.spec.hasGlobal || globals[0]?.id !== 1))) {
        throw failure('malformed-medium');
      }
      const global = globals.length === 0 ? null : decode(globals[0]!.value);
      this.assertPath();
      return { tables, global };
    } catch (error) {
      this.#unknown = true;
      throw known(error) ? error : failure('malformed-medium');
    }
  }
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> { return this.read(); }
  #write(operation: () => void): void {
    this.#active();
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      operation();
      this.assertPath();
      this.#database.exec('COMMIT');
      this.assertPath();
    } catch {
      this.#unknown = true;
      try { if (this.#database.isTransaction) this.#database.exec('ROLLBACK'); } catch { /* uncertain outcome */ }
      // Includes errors after COMMIT: no stale cache, retry, or success acknowledgement.
      throw failure('unknown-state');
    }
  }
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.#active(); this.#table(table); this.#key(key);
    const json = encode(value);
    this.#write(() => this.#database.prepare('INSERT INTO owned_records(table_name, key, value) VALUES(?, ?, ?) ON CONFLICT(table_name, key) DO UPDATE SET value = excluded.value').run(table, key, json));
  }
  async deleteRecord(table: string, key: string): Promise<void> { return this.deleteRecords(table, [key]); }
  async deleteRecords(table: string, keys: readonly string[]): Promise<void> {
    this.#active(); this.#table(table);
    if (!Array.isArray(keys)) throw failure('invalid-key');
    const copy = [...keys];
    for (const key of copy) this.#key(key);
    this.#write(() => {
      const statement = this.#database.prepare('DELETE FROM owned_records WHERE table_name = ? AND key = ?');
      for (const key of copy) statement.run(table, key);
    });
  }
  async setGlobal(value: unknown): Promise<void> {
    this.#active();
    if (!this.spec.hasGlobal) throw failure('global-not-declared');
    const json = encode(value);
    this.#write(() => this.#database.prepare('INSERT INTO owned_global(id, value) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(json));
  }
  async close(): Promise<void> {
    this.ownerHeld(); // Cleanup is intentionally allowed even if this is false.
    this.#closed = true;
    let failed = false;
    try {
      if (this.#database.isOpen && this.#database.isTransaction) this.#database.exec('ROLLBACK');
    } catch { failed = true; }
    try { if (this.#database.isOpen) this.#database.close(); }
    catch { failed = true; }
    if (!this.#database.isOpen) this.released();
    if (failed) throw failure('close-failed');
  }
}
