# API Token Protection on the Loopback Bridge

Slice: 2026-04-30
Status: complete

## Goal

The dashboard HTTP/SSE bridge currently has no authentication. Anything that can reach `127.0.0.1:3001` — another local process, a browser tab pointed at the right URL, a curl from a forgotten shell — can drive the runtime: send messages, create tasks, approve permission requests, fetch secrets from the read model. That is an unacceptable correctness gap as soon as the box has more than one user or a browser that runs untrusted JS.

This slice adds an opt-in shared-secret bearer token gate. When `TOAD_API_TOKEN` is set, both `/api/call` and `/events` require the token. When it is unset, the server runs in the existing no-auth mode so developer ergonomics are unchanged.

## Threat Model

In scope:

- Same-host opportunistic processes that can connect to the loopback port.
- Browsers running scripts that can issue cross-origin requests to `127.0.0.1`.

Out of scope:

- Privileged attackers who can read the user's `.env` / process env. They already own the machine.
- Network-attached attackers. The server still binds to `127.0.0.1` only.
- Strong cryptographic origin authentication (mTLS, signed nonces). A shared secret is sufficient for the threat model.

## Design

### Constructor option

```js
new ApiServer({ eventBus, toolFacade, port, maxBodyBytes, token })
```

- `token` is `null` / `undefined` / empty string → auth disabled (current behavior).
- `token` is a non-empty string → auth required on `/api/call` and `/events`.

### Auth on `/api/call`

- Header `Authorization: Bearer <token>` is required.
- Comparison uses `crypto.timingSafeEqual` to avoid leaking length-or-prefix information through timing.
- Failure: HTTP `401`, JSON body `{ error: "..." }`, no body parsing, no facade execution.

### Auth on `/events`

`EventSource` does not support custom headers in the browser, so the SSE endpoint must accept an alternative carrier.

- Either `Authorization: Bearer <token>` (for non-browser clients, useful for tests and curl).
- Or `?token=<token>` query string (for browsers using the native `EventSource` API).
- Failure: HTTP `401`, plain text body, connection closed.

Routing the token through a query string is acceptable here because (a) the server is loopback-only, (b) URL logging is to the user's own dev console, and (c) the same-host threat model already includes processes that can read each other's process tables and netstat output.

### CORS

`Access-Control-Allow-Headers` gains `Authorization` so a browser preflight that wants to send the bearer header is permitted.

`Access-Control-Allow-Origin` stays `*` for now — origin-based hardening is a separate slice and does not interact with bearer-token auth on a loopback API.

### Env var wiring

`LocalToadRuntime` reads `process.env.TOAD_API_TOKEN` at construction and forwards it to the `ApiServer` constructor. No `start()` change is needed.

### UI wiring

- `ui/src/config/toadApi.js`:
  - Reads `import.meta.env.VITE_TOAD_API_TOKEN`.
  - Exports a `toadApiHeaders()` helper that returns `{ 'Content-Type': 'application/json' }` or `{ 'Content-Type': 'application/json', Authorization: 'Bearer ...' }`.
  - Exports `toadEventsUrl()` that returns the events URL with `?token=...` appended when a token is configured.
- `useToadApi.js`: replaces the inline headers with `toadApiHeaders()`.
- `useToadEvents.js`: replaces `TOAD_EVENTS_URL` constant with `toadEventsUrl()` so the token is included.

## Changes

### Backend

- `src/transport/apiServer.js` — new `token` option, `#authenticate(req)` helper, 401 paths on `/api/call` and `/events`, `Authorization` added to CORS allowed headers.
- `src/app/LocalToadRuntime.js` — passes `process.env.TOAD_API_TOKEN` to `ApiServer`.
- `test/apiServer.test.js` — new tests:
  - `/api/call` returns 401 without `Authorization` when token is set.
  - `/api/call` returns 401 with a wrong Bearer token.
  - `/api/call` returns 200 with the correct Bearer token.
  - `/events` returns 401 without a token when token is set.
  - `/events` returns 200 when the correct token is in the `?token=` query string.

### UI

- `ui/src/config/toadApi.js` — `TOAD_API_TOKEN`, `toadApiHeaders()`, `toadEventsUrl()`.
- `ui/src/hooks/useToadApi.js` — uses `toadApiHeaders()`.
- `ui/src/hooks/useToadEvents.js` — uses `toadEventsUrl()`.
- `README.md` — documents `TOAD_API_TOKEN` and `VITE_TOAD_API_TOKEN`.

## Test command

```powershell
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

All 26 backend test files pass; UI lint and build pass.

## Out Of Scope (Future Work)

- Origin-restricted CORS (`Access-Control-Allow-Origin` to a specific dashboard origin).
- Token rotation, multi-token, or per-method scopes.
- TLS / signed nonces — relevant only if the server stops binding to loopback.
