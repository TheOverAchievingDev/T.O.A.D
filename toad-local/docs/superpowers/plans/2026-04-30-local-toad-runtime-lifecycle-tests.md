# LocalToadRuntime Lifecycle Tests

Slice: 2026-04-30
Status: complete

## Goal

`LocalToadRuntime.start()` and `LocalToadRuntime.close()` are the orchestration entry points that wire together the API server, the runtime supervisor, the event bus, and the durable stores. None of that wiring is currently exercised by tests — the existing `localToadRuntime.test.js` cases avoid `start()` because it binds the API server to a fixed port (default 3001), which is hostile to a test runner.

This slice adds three lifecycle assertions:

1. `start()` actually binds the API server and serves at least one request.
2. `close()` disconnects any pending SSE clients and unbinds the server cleanly.
3. `close()` called without a prior `start()` does not throw or hang.

## Refactor

`LocalToadRuntime` gains a `port` constructor option that is forwarded to the internal `ApiServer`. The default still resolves to `process.env.TOAD_API_PORT` or `3001`, so existing callers are unaffected. Tests pass `port: 0` to bind to a random ephemeral port.

This is the minimum necessary refactor — the rest of the dependency graph is already injectable, so the API server was the lone outlier.

## Changes

- `src/app/LocalToadRuntime.js` — `port` option threaded into the `ApiServer` constructor.
- `src/transport/apiServer.js` — `stop()` now calls `server.closeAllConnections()` after `server.close(callback)`. Without this, an SSE client's keep-alive socket prevents `server.close()` from ever resolving, so `LocalToadRuntime.close()` would hang. This bug was latent until the lifecycle tests exercised the path.
- `test/localToadRuntime.test.js` — three new tests using the port-0 binding pattern, an HTTP/SSE smoke pair, and a `close()`-without-`start()` guard.

## Bug Surfaced By This Slice

Before this slice, `apiServer.stop()` could hang indefinitely if any SSE client was still connected, because `server.close()` waits for keep-alive sockets to drain and an SSE response holds its socket open. The new test for `close() disconnects pending SSE clients` was the first thing to actually exercise that race, and it hung. The fix is one line: `this.#server.closeAllConnections()` after registering the close callback.

## Test command

```powershell
npm.cmd test
```

All 26 backend test files pass.

## Out Of Scope

- Idempotent / re-entrant `start()` / `close()` — single-call contract is sufficient.
- Graceful drain of in-flight `/api/call` POSTs during shutdown — `apiServer.stop()` already calls `server.close()`, which lets in-flight requests finish before unbinding. No specific test coverage for that race here.
- Lifecycle of the side-effect log (already covered by the replay-on-restart slice).
