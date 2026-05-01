# Runtime Event Streaming (Event Bus)

Slice: 2026-04-30
Status: complete

## Goal

Add a lightweight pub/sub event bus for streaming runtime events. This is the
foundation for any transport layer (WebSocket, SSE, IPC) that needs to relay
live activity to UI clients.

## Changes

### New files

- `src/runtime/RuntimeEventBus.js` — EventEmitter wrapper with subscribe/unsubscribe/dispose
- `test/runtimeEventBus.test.js` — 8 tests

### Modified files

- `src/runtime/RuntimeEventIngestor.js` — added `eventBus` dependency, publishes
  events to both `runtime_event` (generic) and type-specific channels on ingest.
- `src/app/LocalToadRuntime.js` — imports and creates `RuntimeEventBus`, passes
  to ingestor, disposes on close.

### Behavior

- `RuntimeEventBus` wraps Node.js EventEmitter with:
  - `on(channel, handler)` / `off(channel, handler)` — standard subscribe/unsubscribe
  - `subscribe(channel, handler)` — returns unsubscribe function
  - `listenerCount(channel)` — listener count
  - `dispose()` — removes all listeners for clean shutdown

- Every ingested event is published to two channels:
  - `runtime_event` — catch-all channel
  - `{event.type}` — type-specific channel (e.g. `tool_use`, `api_retry`)

## Test command

```powershell
npm.cmd test
```

All 23 test files pass.
