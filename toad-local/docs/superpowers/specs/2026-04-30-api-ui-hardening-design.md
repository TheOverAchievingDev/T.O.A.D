# API/UI Hardening Design

## Goal

Make the local dashboard less brittle by validating `/api/call` requests before they reach the facade and by moving dashboard API URLs out of hard-coded hook constants.

## Backend Scope

- Add `ApiServer` constructor option `maxBodyBytes`, defaulting to 1 MiB.
- Return `413` JSON for request bodies larger than `maxBodyBytes`.
- Return `400` JSON for malformed JSON.
- Return `400` JSON when `/api/call` payloads are missing:
  - object payload
  - actor object with non-empty `teamId` and `agentId`
  - non-empty string `method`
  - object `args` when provided
  - string `idempotencyKey` when provided
- Preserve existing `503` behavior when `toolFacade` is missing.
- Keep facade execution errors as `500` for now.

## UI Scope

- Add a small config module for dashboard URLs.
- Use `import.meta.env.VITE_TOAD_API_BASE_URL` when present.
- Default to `http://127.0.0.1:3001`.
- Derive:
  - API call URL: `${base}/api/call`
  - SSE URL: `${base}/events`
- Keep all existing hook call signatures unchanged.

## Non-Goals

- No authentication.
- No token protection.
- No network exposure beyond current loopback server binding.
- No broader command schema validation inside `ApiServer`; command-specific validation remains in tools/facade.

## Testing

- `test/apiServer.test.js` covers malformed JSON, invalid payload shape, and body limit.
- UI verification uses `npm.cmd run lint` and `npm.cmd run build`.
- Full backend regression remains `npm.cmd test`.
