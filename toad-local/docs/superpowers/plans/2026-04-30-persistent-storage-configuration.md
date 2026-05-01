# Persistent Storage Configuration

Slice: 2026-04-30
Status: complete

## Goal

Every SQLite-backed component in TOAD currently defaults to `:memory:` — including `SqliteRuntimeRegistry`, `SqliteRuntimeEventLog`, and `SqliteApprovalBroker`. `LocalToadRuntime`'s default constructor inherits those defaults, and `scripts/dev-api-server.mjs` doesn't override them. The practical consequence: an operator running `npm run api:dev`, killing it, and restarting it gets a **fresh empty database every time**. The whole durability story we have been building over the last several slices (delivery receipts, approval persistence, runtime audit, side-effect replay-on-restart, retention) silently does nothing across a real restart.

This slice gives the orchestrator a real file path to back its SQLite stores by default in production, while keeping `:memory:` as the constructor default so tests stay clean.

## Design

### Storage layout

A single shared SQLite file at `<projectCwd>/.toad/toad.db` by default. All three SQLite components (registry, event log, approval broker) open their own connection to that same file. Schema is `CREATE IF NOT EXISTS`, so each component re-applying it is idempotent.

Why one file vs. three:

- Each component's tables are independent in practice (no cross-component joins), so per-component files would also work.
- One file is more discoverable (operator can spot the data, back it up, wipe it) and matches conventions like Vite's `.vite/` and Next.js's `.next/` project-local state directories.
- SQLite handles multiple connections to the same file fine; for TOAD's low-volume single-user use, default journal mode is sufficient and we don't need WAL.

### Constructor option

`LocalToadRuntime` gains a `dbPath` option:

- Default: `':memory:'` (preserves test ergonomics and the in-memory default everywhere else).
- When `dbPath` is set to a file path, all three default-constructed SQLite components are opened against it.
- When the user passes their own `runtimeRegistry`, `eventLog`, or `approvalBroker` via DI, those are used as-is — `dbPath` only governs the defaults.

### Auto-create parent directory

`openToadDatabase(filePath)` in `src/storage/sqlite.js` will `mkdirSync(parent, { recursive: true })` when `filePath` is a real file path (not `':memory:'`). This avoids the operator hitting a "directory not found" error on first run and matches the behavior of nearly every comparable project-local data store.

### Production wiring

`scripts/dev-api-server.mjs` sets `dbPath` explicitly:

```js
const dbPath = process.env.TOAD_DB_PATH || path.join(process.cwd(), '.toad', 'toad.db');
const runtime = new LocalToadRuntime({ projectCwd: process.cwd(), dbPath });
```

Operators can override with `TOAD_DB_PATH` if they want the data elsewhere (shared volume, separate disk, etc.). Setting `TOAD_DB_PATH=:memory:` reverts to ephemeral mode.

## Changes

- `src/storage/sqlite.js` — `openToadDatabase` auto-creates the parent directory for non-`:memory:` paths.
- `src/app/LocalToadRuntime.js` — new `dbPath` constructor option (default `:memory:`); when set to anything else, `runtimeRegistry`, `eventLog`, `approvalBroker` defaults are constructed against `dbPath`.
- `scripts/dev-api-server.mjs` — sets `dbPath` to `<projectCwd>/.toad/toad.db` (overridable by `TOAD_DB_PATH`).
- `test/localToadRuntime.test.js` — new test using a temp directory: starts a runtime, ingests events, closes it, starts a fresh runtime against the same `dbPath`, asserts the prior data is visible.
- `README.md` — documents `TOAD_DB_PATH` and the default location.
- `.gitignore` (toad-local) — adds `.toad/` so the project DB doesn't get committed.

## Test command

```powershell
npm.cmd test
```

All 27 backend test files pass (26 prior + the new persistence test).

## Out Of Scope

- Migrations between schema versions. Today everything is `CREATE IF NOT EXISTS`. A migration framework can come when we actually break a column shape.
- WAL mode and write tuning. Not needed for current single-user low-volume use.
- Backup / export commands. Operators can `cp .toad/toad.db backup.db` themselves while the orchestrator is stopped.
- Sharing storage between `broker` and `taskBoard` — those still default to in-memory variants for their own design reasons. Switching to SQLite versions is a different slice.
