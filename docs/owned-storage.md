# Plugin-owned public SQLite storage

## Actual API and status

[OwnedSqliteBackend](../src/storage/sqlite.ts) implements only the public
`StorageBackend` / `KvFacet` / `KvUnit` contracts from
`@deepseek-ai/dsh-storage` (the workspace-installed published `0.2.1-rc.3`
declarations). No private backend interfaces, SQL services, global facility
mount, Host database, or knowledge database are used.

The published rc.3 SDK differs from the live checkout at the same version:
its `KvUnit` has no `deleteRecords`, and its `StorageErrorCode` has no
`unknown-state`. This module therefore exports `OwnedKvUnit extends KvUnit`
with the additional atomic `deleteRecords(table, keys)` method and
`OwnedKvFacet extends KvFacet` whose `open()` returns `Promise<OwnedKvUnit>`.
`OwnedSqliteBackend.kv` has this covariant owned type, still assignable to the
public facet without assertions or SDK augmentation. Published Host domain
callers use only the supported public methods; the production domain specs
have no record tables. Batch deletion is an owned extension, not a claimed
published Host SDK method. The exported `OwnedStorageError` and
`OwnedStorageErrorCode` explicitly carry backend-specific failures, including
`unknown-state`; this code is never passed to the published `StorageError`
constructor.

```ts
const backend = new OwnedSqliteBackend(directory, owner);
const unit = await backend.kv.open({
  name: 'onebot_personality_control',
  version: 1,
  tables: [],
  hasGlobal: true,
  layout: 'single',
});
await unit.setGlobal(jsonValue);
const { tables, global } = await unit.loadAll();
await unit.close();
await backend.close();
```

Constructor signature: `new OwnedSqliteBackend(directory: string, owner:
OwnerIdentity)`. It validates but does not create directories, open SQLite, or
write data. The root must already exist, be absolute, canonical, trusted, local
and private. The owner must already be held. The caller acquires the deterministic
`owner.sqlite` inside its explicit private directory and obtains `directory`
from `dirname(owner.canonicalPath)`, not from a shared storage facility.

Register this instance using public `ctx.storage.backend.register(ownedUniqueName,
backend)`. A plugin-local `DomainFacility` must route **both**
`onebot_personality_control` and `onebot_personality_deletion_ledger` explicitly
to that unique backend (and use it as the default). The bootstrap owns that
facility and the registration disposer. Do not mount over the global facility;
do not assume its configuration exposes or proves any physical storage path.

**Verification boundary:** the initial implementation was authored without
commands or execution. Subsequent authorized workspace installation/typechecking
identified the published-SDK differences described above; this compatibility
revision corrects them without claiming a successful build or test run.
Activation must remain refused (`VERIFIED = false`) until an authorized actual
build and the required verification pass. Consult the supervising session's
verification report for execution results; this document is not a claim of
platform durability testing.

## On-disk format and validation

Each unit gets exactly `<descriptor.name>.sqlite` beneath the private root.
The owner lock remains a separate `owner.sqlite`; it must never be opened as a
KV unit or deleted to unlock. The reserved unit name `owner` is rejected before
opening any file. In production use only the two explicit domain
names above. Unit and table names follow the public `UNIT_NAME_RE`,
`/^[a-z][a-z0-9_]*$/`, not the former hyphenated spelling.

Only `single` layout is implemented (`layout` omitted means `single`).
`per-record` is rejected. Versions are nonnegative safe integers;
`compatibleVersions`, when supplied, must contain valid versions, but does not
relax single-layout exact-version checks. There is no migration and no adoption
of old JSON/SQLite files. The backend's fixed three-table schema stores a format
signature, unit name, version, declared table list, layout and global capability.
The descriptor is copied on open; later caller mutation cannot add tables.

A new file immediately serves empty declared tables and `global: null`.
On reopen, SQLite integrity, exact schema, descriptor identity, exact version,
JSON record/global values, declared tables and global capability are checked
before the handle is published. Domain-specific Zod validation remains the
public domain facility's responsibility: a KV backend has no domain schemas.
An existing empty/truncated/foreign/garbage file is not silently reinitialized.
Undeclared tables/globals, malformed metadata/records, extra schema objects,
and mismatched shapes fail closed. Exact-version mismatch uses public
`StorageError('version-mismatch', 'version-mismatch')`; corrupt/foreign media
uses public `malformed-medium`. There is no in-memory fallback.

Names never enter SQL: the schema and statements are fixed, and table names,
keys and encoded values are bound parameters. Single-layout record keys are
opaque strings, including names that would be unsafe as filesystem segments.
Snapshot maps have null prototypes. Values must be finite JSON data; cycles,
undefined, functions, BigInt, accessors, sparse arrays and custom prototypes
are rejected instead of silently coercing/dropping data.

## Atomicity, durability and uncertain outcomes

Requires builtin `node:sqlite`, Node **>=24.9**, and a local filesystem with
working SQLite locking and synchronization. Every connection verifies DELETE
rollback journaling, `synchronous = FULL` and `secure_delete = ON`.
All writes use native `BEGIN IMMEDIATE` / `COMMIT`; batch deletion uses a single
transaction, not separately committed deletes. All batch keys are validated
before BEGIN. Missing records and repeated keys are harmless. New file entries
also receive parent-directory fsync on POSIX; Windows durability relies on
SQLite's native VFS. No unsafe SQLite pragmas or fallback modes are available.

Calls use synchronous SQLite operations with no intervening `await`: actual
writes finish before Promise acknowledgement. The backend does not establish
cross-domain transactions, CAS, leases or arbitrary concurrent caller ordering.
The host domain facility's per-unit write chain and repository commit barrier
remain required. Each method is atomic, not an entire sequence of methods.

A native write/commit/sync failure, or loss of owner/path certainty during a
transaction, yields owned `OwnedStorageError('unknown-state')`. Rollback is attempted but its
success never converts an uncertain outcome to success. Every later operation
on that unit rejects `unknown-state` until close; after close it rejects
`closed`. A commit may already have happened when its acknowledgement fails.
Only close/reopen and validated durable state can resolve that uncertainty;
there is no stale cached acknowledgement, silent retry, or cached snapshot.
An owner/path failure before a write starts is reported by its fixed code and
quarantines the handle as well. Invalid caller arguments are checked before
writes and do not themselves poison an otherwise healthy handle.

## Ownership and lifecycle

Every operation checks `owner.isHeld()` and live root/file identities; ownership
loss fences access. Unit names remain exclusive while open in the backend map;
a module-local registry also rejects accidental duplicate backend instances
opening the same physical path. Other processes must use the same canonical
owner lock. Loading another module copy is not a replacement for that lock or
a bootstrap singleton: callers must never manufacture different owner paths
for the same directory. Closing a unit removes its map/registry entry, so a
fresh facility can reopen it without a permanent false `already-open` error.

`close()` stops new operations, closes only owned domain connections and is
idempotent. Synchronous operations cannot leave an unfinished background write
for close to abandon. Cleanup is permitted after ownership loss, without
reporting successful data operations. Close errors are fixed `close-failed`
and can be retried. The caller must stop workers and close repository/domain
handles, unregister/close the local facility/backend, **then** release the owner
lock. The backend never closes an injected Host service or the caller's lock.
Files, including the owner file, are never unlinked by production code.

## Private-path boundary

Paths must be existing canonical absolute roots. Symlinks/junctions in the root
or its ancestors, nonregular files, hardlinked files, unexpected WAL/SHM
sidecars, Windows UNC/device/ADS and ambiguous device-name paths are rejected.
A regular private DELETE hot journal can be recovered by SQLite after a crash;
a linked/foreign sidecar is never followed intentionally. File identities are
checked around opens and operations. New files are exclusive-created with
0600; existing files are never chmod'ed, chown'ed or ACL-repaired. POSIX files
must be owner-owned 0600 and the root must be owner-private; ancestors must be
trusted (sticky system temporary directories are allowed).

Checks are **best effort**, not a defense against hostile concurrent path,
mount, hardlink or ACL changes by the same user/root. They do not prove a POSIX
mount is local or that a filesystem honors SQLite durability. On Windows,
Node's mode bits neither enforce nor verify DACL privacy. An administrator
must pre-provision a local private directory with appropriate inherited
owner-only ACLs and trustworthy ancestors. No ACL certification is claimed.

All errors carry fixed messages/codes without paths, record content, native
SQLite diagnostics, or `cause`. Public contract codes are `StorageError`;
backend-specific codes use `OwnedStorageError`. The backend exposes no physical
path accessor, raw SQLite connection, arbitrary-SQL operation, fault-injection
option, or backup-record operation.

## Authored tests and remaining limits

[SQLite backend tests](../tests/sqlite-backend.test.ts) use real temporary
SQLite files and real `OwnerLock` wherever possible. They cover initial shape,
cold persistence, opaque keys, isolation, exact versions, malformed descriptors,
duplicate opens, reopened units, close behavior, ownership loss, atomic batches,
busy writes, mid-batch rollback, post-COMMIT uncertainty, corrupt files/schema,
JSON validation, symlinks/hardlinks and private-path constraints. Faults use
test-only native connections/triggers and a read-only `OwnerIdentity` mock;
there is no added production injection API. Recursive test cleanup verifies
the absolute temporary target, parent, prefix, canonical identity and inode
before deletion. None of these tests were executed during implementation.

The ledger is a **separate SQLite file**, not independent rollback-proof
storage. Restoring or rolling back the whole private folder (including control,
ledger and owner files) is unsupported and can restore deleted information.
There is no external monotonic anti-rollback anchor or cross-file transaction.
`secure_delete` is not secure erasure of backups, filesystem snapshots, SSD
remapping, OS caches or external knowledge storage. Power-loss durability,
Windows DACLs, multi-process behavior and target-platform SQLite recovery must
be verified before any production activation.
