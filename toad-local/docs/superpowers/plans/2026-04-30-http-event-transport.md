# HTTP/SSE API Transport for Event Bus

Slice: 2026-04-30
Status: complete

## Goal

Expose the `RuntimeEventBus` over the network so UI dashboards can receive live activity feeds, and expose a local HTTP bridge for read-only and mutating facade calls. The implementation uses Node.js built-in `http`, Server-Sent Events for live runtime events, and a JSON `POST /api/call` endpoint for local tool/facade access.

## Changes

### Files

- `src/transport/apiServer.js` - `ApiServer` class
- `test/apiServer.test.js` - 5 tests

### Behavior

- `ApiServer`
  - Takes `eventBus`, optional `toolFacade`, and `port` in the constructor.
  - Exposes `GET /events` as an SSE stream.
  - Subscribes to the `runtime_event` channel on start and broadcasts to all connected SSE clients.
  - Gracefully handles client disconnects to prevent memory leaks.
  - Exposes `POST /api/call`, accepting `{ actor, method, args, idempotencyKey? }` and routing to `toolFacade.execute()`.
  - Returns `404 Not Found` for unknown routes.
  - Implements CORS for the local web UI.
  - `start()` and `stop()` manage lifecycle and unsubscribe from the event bus.

## Test command

```powershell
cd C:\Project-TOAD\toad-local
node test/apiServer.test.js
npm.cmd test
```

The current full backend suite passes.
