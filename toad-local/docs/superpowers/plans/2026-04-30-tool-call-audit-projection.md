# Tool-Call Audit Projection

Slice: 2026-04-30
Status: complete

## Goal

Add a tool-call-specific read-model projection so tool activity is inspectable
without needing to filter the full event log. Surfaces tool name, tool use ID,
agent, input, runtime, and timestamp through `listToolCalls()` and integrates
into the team overview counts.

## Changes

### Modified files

- `src/read/LocalReadModel.js` — added `listToolCalls({ teamId, runtimeId? })`
  method that filters event log for `tool_use` events and projects them with
  structured fields: `type`, `id`, `teamId`, `agentId`, `runtimeId`, `toolName`,
  `toolUseId`, `input`, `createdAt`. Also added `toolCalls` count to
  `getTeamOverview`.

- `src/app/LocalToadRuntime.js` — added `listToolCalls(input)` delegate to
  expose the new read-model method through the runtime facade.

### Modified test files

- `test/localReadModel.test.js` — expanded event log fixture with tool_use,
  turn_completed, and approval_request events. Added 4 new tests:
  - returns only tool_use events (filtering correctness)
  - filters by runtimeId
  - returns empty when event log unavailable
  - includes runtimeId and createdAt fields
  Updated existing tests for new event counts.

## Test command

```powershell
npm.cmd test
```

All 21 test files pass (read model now has 7 tests instead of 3).
