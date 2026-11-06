import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Deliberately not exported: callers receive fixed codes, never native errors,
// filenames, SQLite diagnostics, or an error.cause that could disclose them.
type LockErrorCode =
  | 'OWNER_INVALID_PATH'
  | 'OWNER_UNSAFE_PATH'
  | 'OWNER_BUSY'
  | 'OWNER_ACQUIRE_FAILED'
  | 'OWNER_NOT_HELD'
  | 'OWNER_CLOSED'
  | 'OWNER_CLOSE_FAILED';

class LockError extends Error {
  readonly code: LockErrorCode;

  constructor(code: LockErrorCode) {
    super(code);
    this.name = 'OwnerLockError';
    this.code = code;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === code;
}

function acquisitionError(error: unknown): LockError {
  if (error instanceof LockError) return error;
  if (typeof error === 'object' && error !== null) {
    // node:sqlite uses ERR_SQLITE_ERROR and a numeric SQLite errcode. Include
    // extended BUSY/LOCKED codes without depending on localized error messages.
    const sqliteCode = 'errcode' in error ? error.errcode : undefined;
    if ((typeof sqliteCode === 'number' && [5, 6].includes(sqliteCode & 0xff))
      || hasCode(error, 'SQLITE_BUSY') || hasCode(error, 'SQLITE_LOCKED')) {
      return new LockError('OWNER_BUSY');
    }
  }
  return new LockError('OWNER_ACQUIRE_FAILED');
}

function inspect(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function checkDirectory(stat: BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LockError('OWNER_UNSAFE_PATH');
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    // A trusted root/current-user ancestor may be sticky (e.g. /tmp), but a
    // writable non-sticky ancestor would let another user replace our path.
    if (uid === undefined || (stat.uid !== BigInt(uid) && stat.uid !== 0n)
      || ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)) {
      throw new LockError('OWNER_UNSAFE_PATH');
    }
  }
}

function checkFile(stat: BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw new LockError('OWNER_UNSAFE_PATH');
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid === undefined || stat.uid !== BigInt(uid) || (stat.mode & 0o7777n) !== 0o600n) {
      throw new LockError('OWNER_UNSAFE_PATH');
    }
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  // Zero/unknown identities cannot establish that SQLite opened the checked file.
  return left.ino !== 0n && right.ino !== 0n
    && left.dev === right.dev && left.ino === right.ino;
}

function directories(parent: string): string[] {
  const root = parse(parent).root;
  const paths = [root];
  let current = root;
  for (const part of parent.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  return paths;
}

// An empty schema plus these header values identify the dedicated owner file.
// This is a format marker, not a secret, a fencing token, or an ACL guarantee.
const OWNER_APPLICATION_ID = 0x44534f57; // DSOW
const OWNER_FORMAT_VERSION = 1;

function hasOwnedHeader(database: DatabaseSync): boolean {
  const applicationId = database.prepare('PRAGMA application_id').get()?.application_id;
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  const entries = database.prepare('SELECT count(*) AS count FROM sqlite_schema').get()?.count;
  // Inspect BEFORE journal_mode or header writes: never repurpose a populated
  // application database or one with foreign/nonzero metadata, even if empty.
  if (entries !== 0) throw new LockError('OWNER_UNSAFE_PATH');
  if (applicationId === OWNER_APPLICATION_ID && version === OWNER_FORMAT_VERSION) return true;
  if (applicationId === 0 && version === 0) return false;
  throw new LockError('OWNER_UNSAFE_PATH');
}

function checkSidecars(path: string): void {
  // Header initialization may create a journal, but it must be committed and
  // removed BEFORE the long exclusive hold. Never ignore/recover an uncertain
  // sidecar, follow a sidecar link, or force-unlock anything.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (inspect(`${path}${suffix}`) !== undefined) {
      throw new LockError('OWNER_UNSAFE_PATH');
    }
  }
}

function validatedPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')
    || path === ':memory:' || !isAbsolute(path)
    || /[\\/]$/.test(path) || ['.', '..'].includes(basename(path))) {
    throw new LockError('OWNER_INVALID_PATH');
  }
  if (process.platform === 'win32') {
    // Reject UNC/network and Win32 device namespaces, ADS, ambiguous trailing
    // dots/spaces and DOS device names. SQLite locking requires a local disk.
    if (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':')
      || path.slice(3).split(/[\\/]/).some((part) =>
        (part !== '.' && part !== '..' && /[. ]$/.test(part))
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new LockError('OWNER_INVALID_PATH');
    }
  } else if (path.startsWith('//')) {
    throw new LockError('OWNER_INVALID_PATH');
  }
  return resolve(path);
}

/**
 * A process-exclusive lock for ONE plugin-owned domain, on Node >=24.9.
 *
 * Every caller sharing that domain MUST configure the same canonical lock path.
 * A different file is a different lock; ownerId is a random identity, NOT a
 * monotonically increasing fencing token, a lease, or proof of storageDomain CAS.
 * Acquire before opening domain workers; stop/fence all work before close().
 *
 * The dedicated SQLite connection holds BEGIN EXCLUSIVE in DELETE rollback
 * journaling mode for its entire lifetime. OS process death releases SQLite's
 * locks; no timestamps, stale lease overrides, lock deletion, or shared DSH /
 * knowledge databases are involved. Use a dedicated file, never an existing
 * application/control/knowledge database. Files are never unlinked on close.
 * Do not independently open/close this file while held: unrelated descriptors
 * can invalidate process-scoped POSIX fcntl locks outside SQLite's bookkeeping.
 *
 * Requires a trusted LOCAL filesystem with working SQLite OS locks, stable file
 * identities and trusted ancestors. Symlinks/junctions, hardlinks, nonregular
 * files and uncertain sidecars are rejected. Path checks are best effort, NOT
 * protection against hostile concurrent path/ACL changes by the same user/root.
 * POSIX creates directories 0700/files 0600 and validates file ownership/modes;
 * existing paths are never chmod'ed/chown'ed. On Windows Node's mode argument
 * does NOT enforce/inspect DACLs: the administrator must pre-provision a private
 * parent with owner-only inherited ACLs. This module cannot certify Windows ACL
 * privacy, remote mounts or filesystem locking reliability.
 */
export class OwnerLock {
  readonly #ownerId: string;
  readonly #canonicalPath: string;
  readonly #identity: BigIntStats;
  #database: DatabaseSync | undefined;
  #held = true;
  #closed = false;

  private constructor(database: DatabaseSync, canonicalPath: string, identity: BigIntStats) {
    this.#database = database;
    this.#canonicalPath = canonicalPath;
    this.#identity = identity;
    this.#ownerId = randomUUID();
  }

  get ownerId(): string { return this.#ownerId; }
  get canonicalPath(): string { return this.#canonicalPath; }

  static async acquire(lockPath: string): Promise<OwnerLock> {
    let database: DatabaseSync | undefined;
    try {
      const path = validatedPath(lockPath);
      for (const parent of directories(dirname(path))) {
        let stat = inspect(parent);
        if (stat === undefined) {
          try {
            mkdirSync(parent, { mode: 0o700 });
          } catch (error) {
            if (!hasCode(error, 'EEXIST')) throw error;
          }
          stat = lstatSync(parent, { bigint: true });
        }
        checkDirectory(stat);
      }

      let before = inspect(path);
      if (before === undefined) {
        let descriptor: number | undefined;
        try {
          descriptor = openSync(path,
            constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
              | (constants.O_NOFOLLOW ?? 0), 0o600);
          before = fstatSync(descriptor, { bigint: true });
          checkFile(before);
        } catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
          before = lstatSync(path, { bigint: true });
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
      }
      if (before === undefined) throw new LockError('OWNER_ACQUIRE_FAILED');
      checkFile(before);
      const canonicalPath = realpathSync.native(path);
      const canonicalStat = lstatSync(canonicalPath, { bigint: true });
      checkFile(canonicalStat);
      if (!sameFile(before, canonicalStat)) throw new LockError('OWNER_UNSAFE_PATH');
      checkSidecars(canonicalPath);

      database = new DatabaseSync(canonicalPath, {
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
      });
      database.exec('PRAGMA busy_timeout = 0');
      const initialized = hasOwnedHeader(database);
      const mode = database.prepare('PRAGMA journal_mode = DELETE').get();
      if (mode?.journal_mode !== 'delete') throw new LockError('OWNER_ACQUIRE_FAILED');
      if (!initialized) {
        // BEGIN EXCLUSIVE on a zero-byte database itself creates a rollback
        // journal. Initialize our owned header in a SHORT transaction, commit,
        // then hold a fresh transaction without any later database writes.
        database.exec('BEGIN EXCLUSIVE');
        // Recheck under the write lock; another initializer may have won.
        if (!hasOwnedHeader(database)) {
          database.exec(`PRAGMA application_id = ${OWNER_APPLICATION_ID}; PRAGMA user_version = ${OWNER_FORMAT_VERSION}`);
        }
        database.exec('COMMIT');
      }
      checkSidecars(canonicalPath);
      database.exec('BEGIN EXCLUSIVE');
      if (!hasOwnedHeader(database)) throw new LockError('OWNER_UNSAFE_PATH');
      if (!database.isOpen || !database.isTransaction) {
        throw new LockError('OWNER_ACQUIRE_FAILED');
      }
      // Check again AFTER SQLite acquires the lock; a changed path fails closed.
      for (const parent of directories(dirname(canonicalPath))) {
        checkDirectory(lstatSync(parent, { bigint: true }));
      }
      const after = lstatSync(canonicalPath, { bigint: true });
      checkFile(after);
      if (!sameFile(before, after)) throw new LockError('OWNER_UNSAFE_PATH');
      checkSidecars(canonicalPath);
      return new OwnerLock(database, canonicalPath, after);
    } catch (error) {
      if (database !== undefined) {
        try { if (database.isTransaction) database.exec('ROLLBACK'); } catch { /* close still attempted */ }
        try { database.close(); } catch { /* no success/ownership is reported */ }
      }
      throw acquisitionError(error);
    }
  }

  isHeld(): boolean {
    const database = this.#database;
    if (!this.#held || this.#closed || database === undefined) return false;
    try {
      if (!database.isOpen || !database.isTransaction) throw new LockError('OWNER_NOT_HELD');
      for (const parent of directories(dirname(this.#canonicalPath))) {
        checkDirectory(lstatSync(parent, { bigint: true }));
      }
      const current = lstatSync(this.#canonicalPath, { bigint: true });
      checkFile(current);
      if (!sameFile(this.#identity, current)) throw new LockError('OWNER_NOT_HELD');
      checkSidecars(this.#canonicalPath);
      return true;
    } catch {
      // Once uncertain, this instance never silently becomes an owner again.
      this.#held = false;
      return false;
    }
  }

  assertHeld(): void {
    if (this.#closed) throw new LockError('OWNER_CLOSED');
    if (!this.isHeld()) throw new LockError('OWNER_NOT_HELD');
  }

  async close(): Promise<void> {
    this.#held = false;
    this.#closed = true;
    const database = this.#database;
    if (database === undefined) return;
    // No awaits: repeated/concurrent calls cannot interleave rollback and close.
    try { if (database.isOpen && database.isTransaction) database.exec('ROLLBACK'); } catch { /* closing rolls back too */ }
    try {
      if (database.isOpen) database.close();
      this.#database = undefined;
    } catch {
      // Keep the private handle so a repeated close() can retry cleanup, but
      // assertHeld() already rejects and callers must stop work immediately.
      throw new LockError('OWNER_CLOSE_FAILED');
    }
  }
}
