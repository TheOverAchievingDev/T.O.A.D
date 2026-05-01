# Restart Housekeeping Telemetry

Slice: 2026-04-30
Status: complete

## Goal

`LocalToadRuntime.start()` performs two housekeeping passes against `side_effect_deliveries`:

1. `replayPendingSideEffects()` — drops orphaned `'pending'` rows from a previous process by marking them `'failed'`.
2. `pruneSideEffectLog()` — deletes terminal rows older than the retention window.

Both methods return counts (`{ dropped }` and `{ deleted }`), but those counts are silently consumed. An operator looking at the dashboard has no way to see "your last restart cleared 47 orphaned receipts" or "the retention sweep deleted 1,200 old rows". This slice surfaces both via the existing `RuntimeEventBus`.

## Design

### Event channel and shape

Both signals are emitted on the existing `'runtime_event'` channel of `RuntimeEventBus`, which `ApiServer` already relays to all SSE clients. No new channel.

- `type: 'side_effects_dropped_on_restart'`, `count: number`, `createdAt: ISO string`
- `type: 'side_effects_pruned'`, `count: number`, `createdAt: ISO string`

These are system-level events — they do not carry `runtimeId` / `teamId` / `agentId`. The dashboard can render them in a system/operations panel rather than tying them to a specific runtime card.

### Suppression on no-op

If a housekeeping call returns `0`, no event is emitted. A clean restart on a clean log is silent — the channel signal-to-noise stays high and a future "did anything happen on the last restart?" alert can be a simple "any event with these types in the last N seconds".

## Changes

### `src/app/LocalToadRuntime.js`

`start()` now:

```
const replay = replayPendingSideEffects()
if (replay.dropped > 0) eventBus.emit('runtime_event', { type: 'side_effects_dropped_on_restart', count: replay.dropped, createdAt: ... })
const prune = pruneSideEffectLog()
if (prune.deleted > 0) eventBus.emit('runtime_event', { type: 'side_effects_pruned', count: prune.deleted, createdAt: ... })
await apiServer.start()
```

### Tests (`test/localToadRuntime.test.js`)

- `start()` emits a `side_effects_dropped_on_restart` event when pending rows existed.
- `start()` emits a `side_effects_pruned` event when stale terminal rows were deleted.
- `start()` emits neither event on a clean log.

## Test command

```powershell
npm.cmd test
```

All 26 backend test files pass.

## Out Of Scope

- Persisting these events to `runtime_events` (the SQLite event log). The events are diagnostic and their value is in the live SSE stream — they would only clutter a table whose purpose is reproducing per-runtime histories.
- Dashboard UI for the new event types. Once the events are flowing, a small UI follow-up can render them in a system panel.
- Periodic prune telemetry (would require a periodic timer, which the prior slice intentionally deferred).
