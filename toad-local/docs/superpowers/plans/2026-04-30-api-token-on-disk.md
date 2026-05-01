# API Token On Disk

Slice: 2026-04-30
Status: complete

## Goal

`TOAD_API_TOKEN` currently lives only in shell environment. Every new terminal needs to re-set it; long-running daemons need shell-level configuration; rotating means coordinating multiple shells. Adding a small file fallback (`<projectCwd>/.toad/api-token`) and a generation script gives the operator a persistent, single-source-of-truth token without touching any code.

## Design

### Token resolution

A new helper `resolveApiToken({ explicit, projectCwd })` returns the first non-empty value from:

1. `explicit` — the `apiToken` constructor option on `LocalToadRuntime` (highest precedence; lets DI override file/env in tests and embedded use).
2. `process.env.TOAD_API_TOKEN` — unchanged behavior; still wins over the file so an operator can override per-shell.
3. `<projectCwd>/.toad/api-token` — read synchronously during constructor; trimmed; ignored if file is missing or empty.
4. `null` — auth disabled (current default).

The file lookup is skipped entirely when `projectCwd` is not set. That keeps unit tests hermetic — the default `LocalToadRuntime()` constructor never reads from disk.

### Generation script

`scripts/generate-api-token.mjs`:

- Generates `crypto.randomBytes(32).toString('hex')` — 64 hex characters, ~256 bits of entropy.
- Writes to `<projectCwd>/.toad/api-token` (auto-creates the directory; same dir that holds `toad.db`).
- On Unix, sets file mode to `0o600` so only the user can read it. On Windows, the file inherits the user-owned directory's ACL — effectively user-only.
- Prints PowerShell- and bash-friendly export commands for the UI side, since the dashboard's Vite build still needs `VITE_TOAD_API_TOKEN` at build time.

### Tests

Three small unit tests on the resolution helper:

- `resolveApiToken returns the explicit token when provided`.
- `resolveApiToken returns the env var when explicit is missing`.
- `resolveApiToken returns the file content when env and explicit are missing`.
- `resolveApiToken returns null when nothing is configured`.

The integration with `LocalToadRuntime` is exercised transitively by every existing test that constructs a default runtime — they continue to pass because constructors that don't pass `projectCwd` skip the file lookup.

## Changes

- `src/runtime/resolveApiToken.js` — new helper (kept in `runtime/` next to the other auth pieces; could move to `transport/` later if it grows).
- `src/app/LocalToadRuntime.js` — accepts an `apiToken` constructor option; `ApiServer` is now constructed with `token: resolveApiToken({ explicit: apiToken, projectCwd })`.
- `scripts/generate-api-token.mjs` — generation script.
- `test/resolveApiToken.test.js` — 4 unit tests.
- `package.json` — adds `npm run token:generate`; adds the new test to the test chain.
- `README.md` — documents the new file-based flow.

## Verification

```powershell
npm.cmd test
npm.cmd run token:generate
```

All 27 backend test files pass.

## Out Of Scope

- Token rotation that simultaneously restarts the API server and re-issues to live SSE clients. The current model: stop the orchestrator, regenerate, restart. Live rotation would require an admin endpoint and broadcast; not worth the surface yet.
- A matching UI flow that swaps the embedded `VITE_TOAD_API_TOKEN` at runtime. The dashboard still consumes the build-time env var.
- Encrypting the on-disk token. The threat model is same-host opportunistic processes, which the file's user-only ACL already addresses.
