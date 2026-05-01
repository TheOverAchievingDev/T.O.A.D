# Side-Effect Log Retention

Slice: 2026-04-30
Status: complete

## Goal

The `side_effect_deliveries` table grows unbounded. Every `tool_result` and `compaction_reinjection` writes a row, the row is marked `'delivered'` or `'failed'`, and then it is never touched again. On a long-running install with hundreds of turns per day, that table will grow until SQLite is the bottleneck. This slice adds a bounded retention policy: terminal rows older than a configurable threshold are deleted on `LocalToadRuntime.start()`.

## Policy

- `'pending'` rows are **never** deleted by retention. They are still potentially-replayable receipts. (`replayPendingSideEffects()` from the prior slice converges them to `'failed'` on next start, so they will be eligible for prune one start later.)
- `'delivered'` and `'failed'` rows are eligible for deletion when their effective age exceeds the retention window. Effective age is `now() - COALESCE(delivered_at, created_at)`:
  - `delivered_at` is the obvious choice for `'delivered'` rows.
  - For `'failed'` rows, `delivered_at` is `NULL`, so we fall back to `created_at`. Worst case: a row that lingered as `'pending'` for hours before failing is treated as slightly older than reality, by exactly the duration of that lingering. For a default retention window measured in days, that drift is irrelevant.
- Default retention is **7 days**. Override via `TOAD_SIDE_EFFECT_RETENTION_DAYS` (env) or `sideEffectRetentionDays` (`LocalToadRuntime` constructor option).

## Trigger

`LocalToadRuntime.start()` already does housekeeping (`replayPendingSideEffects()` to drop orphaned pending rows). The prune call is added immediately after, in the same start sequence:

```
start()
  → replayPendingSideEffects()   // drop stale pending → failed
  → pruneSideEffectLog()         // delete old terminal rows
  → apiServer.start()
```

This is sufficient for the typical case — every orchestrator restart includes a sweep. A periodic background timer is intentionally **not** added in this slice; if hourly pruning ever becomes necessary it is a clean follow-up.

## Changes

### `SideEffectLog`

- New method `pruneOlderThan(cutoffDate)`:
  ```
  DELETE FROM side_effect_deliveries
  WHERE status IN ('delivered', 'failed')
    AND COALESCE(delivered_at, created_at) < ?
  ```
  Returns the number of rows deleted (`Statement.run(...).changes`).

### `LocalToadRuntime`

- New constructor option `sideEffectRetentionDays`. Defaults to `parseRetentionEnv(process.env.TOAD_SIDE_EFFECT_RETENTION_DAYS) ?? 7`.
- New method `pruneSideEffectLog({ olderThan } = {})`:
  - When `sideEffectLog` is `null`, returns `{ deleted: 0 }`.
  - When `olderThan` is a `Date`, uses it directly. Otherwise computes `new Date(Date.now() - retentionDays * 86_400_000)`.
  - Returns `{ deleted: number }`.
- `start()` now calls `pruneSideEffectLog()` after `replayPendingSideEffects()` and before `apiServer.start()`.

### Tests

`test/sideEffectLog.test.js`:

- `pruneOlderThan deletes delivered rows older than the cutoff`.
- `pruneOlderThan deletes failed rows older than the cutoff (using created_at when delivered_at is null)`.
- `pruneOlderThan keeps pending rows regardless of age`.
- `pruneOlderThan keeps terminal rows newer than the cutoff`.
- `pruneOlderThan returns the deleted count`.

`test/localToadRuntime.test.js`:

- `pruneSideEffectLog uses the configured retention window`.
- `pruneSideEffectLog with an explicit olderThan overrides the default`.
- `pruneSideEffectLog is a no-op when sideEffectLog is null`.
- `start() prunes terminal rows that exceed the retention window`.

### Docs

- `README.md` — documents `TOAD_SIDE_EFFECT_RETENTION_DAYS` alongside the existing API env vars.

## Test command

```powershell
npm.cmd test
```

All 26 backend test files pass.

## Out Of Scope

- Periodic background pruning. Add later if a single per-start sweep proves insufficient.
- VACUUM / page reclamation — `DELETE` releases SQLite pages back to the freelist; manual `VACUUM` to reclaim disk is a separate concern, applicable to all tables, and is not currently a pressing problem.
- Per-kind retention windows. The same window applies to both `tool_result` and `compaction_reinjection`.
