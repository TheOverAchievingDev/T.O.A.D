# Side-Effect Replay-on-Restart

Slice: 2026-04-30
Status: complete

## Goal

Close the loop on the durable side-effect delivery receipts slice by deciding what to do with `'pending'` receipts when the orchestration process restarts. Without this, the `side_effect_deliveries` table accumulates orphaned `'pending'` rows that no one will ever resolve, which is misleading for any read-side consumer trying to reason about delivery state.

## Per-Kind Policy

Both `tool_result` and `compaction_reinjection` adopt a **drop-on-restart** policy — pending receipts are marked `'failed'` when `LocalToadRuntime.start()` is called.

- `tool_result`: the originating runtime session is gone after a process restart, the `toolUseId` is no longer addressable on any new adapter, and Claude has long since timed out the request. There is nothing left to deliver to, so the only honest outcome is `'failed'`.
- `compaction_reinjection`: the in-memory `CompactionHandler.#pending` map is also gone after restart. Even if the same `runtimeId` could theoretically be re-attached (it cannot — runtime IDs are unique per launch), the handler has no record that a reinjection was owed. Drop and mark failed.

Re-arming a different policy (e.g. retrying tool results against a freshly attached adapter) would require a much larger redesign — adapter sessions carrying their own durable identity, request re-association, and a way to express "best-effort retry vs. drop" on a per-call basis. Not in scope here.

## Changes

### Business Logic

- `src/app/LocalToadRuntime.js`:
  - Added a public `replayPendingSideEffects()` method that iterates `sideEffectLog.getPending()` and calls `markFailed` on each. Returns `{ dropped: number }` for caller observability.
  - When `sideEffectLog` is `null` (no SQLite handle was available at construction), the method is a no-op and returns `{ dropped: 0 }`.
  - `start()` now calls `replayPendingSideEffects()` before binding the API server.

### Tests

- New tests in `test/localToadRuntime.test.js`:
  - `replayPendingSideEffects marks all pending receipts failed`.
  - `replayPendingSideEffects does not affect already-delivered receipts`.
  - `replayPendingSideEffects is a no-op when sideEffectLog is null` (verified by passing `runtimeRegistry` and `eventLog` instances that do not expose `db`, so `LocalToadRuntime` constructs `sideEffectLog = null`).
  - `replayPendingSideEffects returns the count of dropped receipts`.

The wiring from `start()` to `replayPendingSideEffects()` is intentionally kept as a one-line internal call. Testing `start()` directly would require binding the API server to a real port, which is unnecessary churn — the public method is exercised directly and the wiring is a single line of code that is easy to read.

## Test command

```powershell
npm.cmd test
```

All 26 backend test files pass.

## Out Of Scope (Future Work)

- Telemetry: emit a `runtime_event` or log line summarizing the dropped count on startup. Worthwhile but cleanly separable.
- Retention: the `side_effect_deliveries` table grows unbounded. A periodic VACUUM/DELETE for old `'delivered'` and `'failed'` rows is a separate hygiene slice.
- Adapter-session durability: would unlock real retry-on-restart for tool results, but requires a full redesign of adapter identity. Not planned.
