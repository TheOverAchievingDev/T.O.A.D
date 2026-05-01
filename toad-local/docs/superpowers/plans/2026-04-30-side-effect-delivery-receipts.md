# Durable Side-Effect Delivery Receipts

Slice: 2026-04-30
Status: complete (foundation); replay-on-restart deferred to a follow-up slice

## Goal

Provide durable, exactly-once delivery semantics for runtime side effects that are otherwise fire-and-forget calls into a live runtime adapter. Two side effects in particular are at risk of duplicate or lost delivery if the orchestration process restarts mid-flight:

1. `adapter.sendToolResult()` — used by `RuntimeEventIngestor` to return a `tool_use` result to Claude after the local tool facade has executed the underlying command.
2. `adapter.sendTurn()` — used by `CompactionHandler` to inject a post-compaction context reminder on the next idle turn.

The approval response delivery path already gained durable receipts in the prior `hardening-approval-delivery` slice (`approval_deliveries` table). This slice extends the same pattern to the two remaining side-effect surfaces.

## Changes

### Schema

- Added the `side_effect_deliveries` table to `src/storage/schema.sql`:
  - `delivery_id` PRIMARY KEY
  - `idempotency_key` UNIQUE NOT NULL — semantic key (`tool-result:<eventHash>` or `compaction-reinjection:<runtimeId>:<sessionId|createdAt>`)
  - `kind` TEXT NOT NULL — `'tool_result'` or `'compaction_reinjection'`
  - `runtime_id` TEXT NOT NULL
  - `status` TEXT NOT NULL — `'pending'`, `'delivered'`, or `'failed'`
  - `created_at` TEXT NOT NULL
  - `delivered_at` TEXT (nullable)

### Data Access

- Added `src/delivery/sideEffectLog.js` with the `SideEffectLog` class:
  - `markPending({ deliveryId, idempotencyKey, kind, runtimeId })` — `INSERT … ON CONFLICT DO NOTHING` so the same idempotency key can be marked pending repeatedly without raising.
  - `markDelivered(idempotencyKey)` — flips status to `'delivered'` and stamps `delivered_at`.
  - `markFailed(idempotencyKey)` — flips status to `'failed'`.
  - `get(idempotencyKey)` — returns the record or `null`.
  - `getPending(kind?)` — returns all `'pending'` rows in insertion order, optionally filtered by kind. Reserved for the deferred replay-on-restart slice; no caller invokes it yet.

### Business Logic

- `RuntimeEventIngestor.#sendToolResult` (`src/runtime/RuntimeEventIngestor.js`):
  - Constructor now accepts an optional `sideEffectLog`.
  - Before calling `adapter.sendToolResult()`, looks up the idempotency key `tool-result:<eventHash>`. If a record exists with status `'delivered'`, the call is skipped and `null` is returned.
  - Otherwise marks pending, calls the adapter, and marks delivered on success or failed on exception (and re-throws).

- `CompactionHandler` (`src/runtime/CompactionHandler.js`):
  - Constructor now accepts an optional `sideEffectLog`.
  - On `compact_boundary`: builds an idempotency key `compaction-reinjection:<runtimeId>:<sessionId|createdAt>`, stores it in `#pending`, and writes a pending receipt.
  - On `turn_completed`: after a successful `adapter.sendTurn()`, marks delivered. On exception, marks failed (strict drop — does not re-arm).
  - When `sideEffectLog` is `null`, the handler degrades to the prior in-memory-only behavior.

### Wiring

- `src/app/LocalToadRuntime.js`:
  - Imports `SideEffectLog`.
  - Instantiates `this.sideEffectLog` from the first available SQLite handle (`runtimeRegistry.db ?? eventLog.db`); `null` if neither is SQLite-backed.
  - Passes `sideEffectLog` into both `CompactionHandler` and `RuntimeEventIngestor`.

### Tests

- New `test/sideEffectLog.test.js` (7 tests, isolated unit coverage of the class).
- New tests in `test/compactionHandler.test.js`:
  - `compact_boundary → turn_completed` writes a pending receipt and then marks delivered.
  - `compact_boundary → turn_failed` records pending but never marks delivered (strict drop).
  - `sendTurn` rejection marks the receipt failed.
- New tests in `test/runtimeEventIngestor.test.js`:
  - Successful `tool_use` dispatch records a `tool_result` receipt as `delivered`.
  - When the receipt already shows `delivered`, `adapter.sendToolResult` is not called again.
  - When `adapter.sendToolResult` rejects, the receipt is marked `failed` and the error is re-thrown.

### Test Chain

- Added `node test/sideEffectLog.test.js` to the `package.json` `test` script.

### Cleanup

- Removed an unused `import { openToadDatabase }` from `src/delivery/sideEffectLog.js`.

## Out Of Scope (Deferred Follow-up)

The receipts are written but **not yet replayed on process restart**. `getPending()` exists and is unit-tested but has no caller. A follow-up slice (`2026-04-30-side-effect-replay-on-restart` or similar) should:

1. On `LocalToadRuntime.start()`, read all pending receipts.
2. For each, decide a replay or compensation policy per kind:
   - `tool_result`: probably drop, because the originating runtime session is gone and the toolUseId is no longer addressable.
   - `compaction_reinjection`: probably drop, because compaction state is process-local; or re-arm in `#pending` if the same runtimeId is re-attached.
3. Write a strict policy doc and tests before implementing replay.

This is intentionally split off because the policy decisions deserve their own brainstorm and the receipts alone close the immediate observability gap.

## Test command

```powershell
npm.cmd test
```

All 26 backend test files pass (25 prior + new `sideEffectLog.test.js`).
