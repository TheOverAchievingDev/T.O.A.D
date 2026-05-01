# VACUUM On Retention

Slice: 2026-04-30
Status: complete

## Goal

`pruneSideEffectLog()` and any other DELETE that runs against the persistent SQLite file releases pages to the file's freelist but does **not** shrink the file. With the broker, taskBoard, approvalBroker, runtimeRegistry, eventLog, and side_effect_deliveries all writing to one shared `<projectCwd>/.toad/toad.db`, a busy install will accumulate freelist pages over time and the file size will only ever monotonically grow.

This slice adds a `VACUUM` step that runs after `pruneSideEffectLog()` whenever the prune actually deleted rows — turning the freelist back into reclaimed disk on every restart.

## Design

### Full VACUUM vs incremental_vacuum

`PRAGMA auto_vacuum = INCREMENTAL` only takes effect if set **before** any tables are created. The TOAD schema is already in flight, so switching to incremental mode would require an initial full `VACUUM` to migrate. Given that:

- The DB stays small in practice (single-user, low-volume).
- VACUUM on a small DB takes single-digit milliseconds.
- The operation already runs at restart, when the operator expects a brief pause.

…a plain `VACUUM` is the right tool. No schema change.

### When to VACUUM

`LocalToadRuntime.start()` already does:

```
replayPendingSideEffects()
pruneSideEffectLog()
apiServer.start()
```

This slice extends that to:

```
replayPendingSideEffects()
prune = pruneSideEffectLog()
if (prune.deleted > 0) {
  vacuumDatabase()  // releases freelist back to disk
  emit('runtime_event', { type: 'database_vacuumed', deleted: prune.deleted })
}
apiServer.start()
```

VACUUM runs **only** after a prune that actually deleted rows. A clean restart on a clean DB stays silent — same convention as the prior housekeeping telemetry slice.

### `vacuumDatabase()` API

A new public method on `LocalToadRuntime`. Returns `{ vacuumed: boolean, reason }`:

- `{ vacuumed: false, reason: 'in_memory' }` when `dbPath === ':memory:'` — VACUUM on `:memory:` works but has no point and would mask config bugs.
- `{ vacuumed: false, reason: 'no_db_handle' }` when no SQLite connection is available (purely-injected test setups).
- `{ vacuumed: true, reason: 'success', freelistBefore, freelistAfter }` otherwise.

The method finds a live connection by walking `this.runtimeRegistry?.db || this.eventLog?.db || this.approvalBroker?.db || …` (same fallback order used to wire `SideEffectLog`).

### VACUUM and concurrent transactions

VACUUM cannot run inside an open transaction. At `start()` time no transactions are in flight — every prior write has committed before `start()` is called. Safe.

## Changes

- `src/app/LocalToadRuntime.js`:
  - New `vacuumDatabase()` method.
  - `start()` calls `vacuumDatabase()` after a prune-with-deletions and emits a `database_vacuumed` runtime event.
- `test/localToadRuntime.test.js`:
  - `vacuumDatabase reduces freelist_count to 0 on a real DB after deletes` (uses a temp file dbPath, manually flips a row from delivered to deleted, verifies `freelist_count` PRAGMA before and after).
  - `vacuumDatabase is a no-op when dbPath is ':memory:'` (returns `{ vacuumed: false, reason: 'in_memory' }`).
  - `start() emits database_vacuumed when prune did non-zero work` (extends the existing housekeeping-telemetry pattern).
- `ui/src/components/Dashboard.jsx`:
  - The System Housekeeping panel gains a third cell for `database_vacuumed` so the operator can see VACUUM ran.

## Verification

```powershell
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

All 26 backend test files pass; UI lint and build pass.

## Out Of Scope

- Periodic VACUUM during long-running uptime (would require a timer; not needed when `start()` is the natural restart cadence).
- Switching the schema to `auto_vacuum = INCREMENTAL`. Only worth it if VACUUM-at-restart proves too slow on real installs.
- VACUUMing without a prune. Routine VACUUMs on every restart even when nothing was pruned would be wasteful churn for no gain.
