# Origin-Restricted CORS

Slice: 2026-04-30
Status: complete

## Goal

Replace the API server's wildcard `Access-Control-Allow-Origin: *` with a configurable allow-list. With the bearer-token slice in place, browsers from any origin can already be denied at the auth check. CORS is the second layer: it stops a malicious tab on `http://evil.example` from even attempting to issue authenticated requests, by getting the browser to refuse to read the response.

## Scope

- Bearer-token enforcement (previous slice) protects the request itself.
- Origin allow-list (this slice) protects the browser from leaking responses to disallowed origins.
- Both layers are independently useful and orthogonal: tests, curl, and server-to-server clients do not send an `Origin` header and continue to work without changes.

## Design

### Constructor option

```js
new ApiServer({ eventBus, toolFacade, port, maxBodyBytes, token, allowedOrigins })
```

- `allowedOrigins` is one of:
  - `undefined` / `null` — use a sensible dev default: `['http://localhost:5173', 'http://127.0.0.1:5173']`.
  - `Array<string>` — an explicit allow-list.
  - `'*'` — echo whatever `Origin` the request sent (matches today's wildcard behavior).

### Request behavior

For every request that the server normally handles (OPTIONS preflight, `POST /api/call`, `GET /events`):

1. Read the request's `Origin` header.
2. If `Origin` is missing → no ACAO header is set (non-browser clients ignore CORS; this preserves curl/test behavior).
3. If `Origin` is present and is on the allow-list (or the list is `'*'`) → respond with `Access-Control-Allow-Origin: <that-origin>` (echoed exactly, never `*` when a specific value is known).
4. If `Origin` is present and is *not* on the allow-list → no ACAO header is set, so the browser refuses to expose the response to the calling JS. The request itself still processes; the auth check (when a token is configured) is the actual security gate.

### Env var

`TOAD_API_ALLOWED_ORIGINS` is a comma-separated string, e.g. `http://localhost:5173,http://127.0.0.1:5173`, or the literal string `*`. `LocalToadRuntime` parses it once and forwards the array (or `'*'`) to the `ApiServer` constructor. Unset → use the default dev list.

## Changes

### Backend

- `src/transport/apiServer.js`:
  - New `allowedOrigins` option.
  - `#setCorsHeaders(req, res)` now reads `req.headers.origin` and writes a specific echoed ACAO when allowed, omits it otherwise.
  - All call sites (OPTIONS branch, `/api/call`, `/events`) pass `req` to the helper.
- `src/app/LocalToadRuntime.js` — parses `process.env.TOAD_API_ALLOWED_ORIGINS` and forwards.

### Tests

- `test/apiServer.test.js`:
  - Origin on allow-list → response carries `Access-Control-Allow-Origin: <that origin>` (not `*`).
  - Origin NOT on allow-list → no ACAO header on the response.
  - `allowedOrigins` defaults include `http://localhost:5173` and `http://127.0.0.1:5173`.
  - `allowedOrigins: '*'` echoes any origin.
  - OPTIONS preflight from a disallowed origin still returns 204 (the request itself is fine; the browser blocks the JS from reading the response by virtue of the missing ACAO).

### Docs

- `README.md` — document `TOAD_API_ALLOWED_ORIGINS` alongside the existing token env vars.

## Test command

```powershell
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

All 26 backend test files pass; UI lint and build pass.

## Out Of Scope

- mTLS or signed nonces. Only matters if the server stops binding to loopback.
- `Access-Control-Allow-Credentials` — bearer tokens travel in `Authorization`, not cookies, so credentialed CORS is not needed.
- Per-method CORS scoping. Single allow-list for all endpoints.
