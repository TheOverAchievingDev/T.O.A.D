# Runtime Compaction Handling

Slice: 2026-04-30
Status: complete

## Goal

Handle context compaction events from Claude CLI by injecting a context
reinjection prompt on the next idle turn, restoring team identity, behavioral
rules, and task board state that was lost during compaction.

## Legacy Finding

When Claude CLI's context window fills up, it compacts the conversation and emits
a `system` event with `subtype: compact_boundary`. After compaction, the agent
loses its original system prompt, team identity, task board state, and behavioral
rules.

The legacy app handles this with a deferred post-compact reminder:

1. On `compact_boundary` → set `pendingPostCompactReminder = true`
2. On next `result.success` (turn complete + idle) → inject context via stdin
3. The reinjection includes: team identity, roster, behavioral rules, task board
4. The prompt explicitly says "Reply with OK" to avoid starting new work
5. On `result.error` → clear pending state (strict drop policy)

### `compact_boundary` metadata

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compact_metadata": {
    "trigger": "auto",
    "pre_tokens": 180000
  }
}
```

### `api_retry` event shape

```json
{
  "type": "system",
  "subtype": "api_retry",
  "attempt": 2,
  "max_retries": 5,
  "error_status": 429,
  "error": "rate_limit",
  "error_message": "Rate limit exceeded",
  "retry_delay_ms": 5000
}
```

## Changes

### New files

- `src/runtime/CompactionHandler.js` — manages per-runtime compact_boundary →
  reinjection lifecycle. Tracks pending state per runtimeId. On turn_completed,
  builds and injects a reinjection prompt with team identity, behavioral rules,
  and task board snapshot via `adapter.sendTurn()`. Strict one-shot drop policy
  on failure (matching legacy).

### Modified files

- `src/runtime/ClaudeStreamJsonAdapter.js` — `compact_boundary` now preserves
  `trigger` and `preTokens` from `compact_metadata`. New `api_retry` event type
  with extracted fields: `attempt`, `maxRetries`, `errorStatus`, `error`,
  `errorMessage`, `retryDelayMs`.

- `src/runtime/RuntimeEventIngestor.js` — added optional `compactionHandler`
  dependency. Dispatches `compact_boundary`, `turn_completed`, and `turn_failed`
  events to the handler's lifecycle methods.

- `src/app/LocalToadRuntime.js` — creates `CompactionHandler` and passes it to
  the event ingestor.

### New test files

- `test/compactionHandler.test.js` — 9 tests covering pending state, injection,
  task board inclusion, failure clearing, multi-compact dedup, runtime isolation,
  and missing adapter/taskBoard cases.

### Modified test files

- `test/claudeStreamJsonAdapter.test.js` — 2 new tests for compact_boundary
  metadata and api_retry normalization (total: 13 tests).

## Test command

```powershell
npm.cmd test
```

All 21 test files pass (existing 20 + 1 new).
