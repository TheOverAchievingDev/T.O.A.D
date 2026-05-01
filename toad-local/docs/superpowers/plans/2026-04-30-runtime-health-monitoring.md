# Runtime Health Monitoring

Slice: 2026-04-30
Status: complete

## Goal

Add an api_retry-specific read-model projection so retry/rate-limit activity
is inspectable without filtering the full event log.

## Changes

### Modified files

- `src/read/LocalReadModel.js` — added `listApiRetries({ teamId, runtimeId? })`
  method that filters event log for `api_retry` events and projects them with:
  `type`, `id`, `teamId`, `agentId`, `runtimeId`, `attempt`, `maxRetries`,
  `errorStatus`, `error`, `errorMessage`, `retryDelayMs`, `createdAt`. Added
  `apiRetries` count to `getTeamOverview`.

- `src/app/LocalToadRuntime.js` — added `listApiRetries` delegate.

### Modified test files

- `test/localReadModel.test.js` — added dedicated fixture with api_retry events,
  5 new tests (12 total): filtering correctness, runtimeId filter, unavailable
  event log, field presence, overview count integration.

## Test command

```powershell
npm.cmd test
```

All 21 test files pass.
