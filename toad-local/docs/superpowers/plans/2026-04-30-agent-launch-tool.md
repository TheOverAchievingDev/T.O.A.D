# `agent_launch` MCP Tool + Dashboard Launcher

Slice: 2026-04-30
Status: complete

## Goal

`LocalToadRuntime.launchAgent(input)` already exists and is unit-tested, but it is **only callable from inside the orchestrator process** — there is no way to spawn a runtime from the API or the dashboard. As a result, TOAD has been an observation-only dashboard for runtimes started by some other code path.

This slice adds a new `agent_launch` MCP-shaped tool that calls `LocalToadRuntime.launchAgent` through the `LocalToolFacade`, plus a small Launch Agent panel in the dashboard. After this slice, an operator can spawn a Claude runtime from the dashboard form (or an MCP client) without writing JavaScript.

## Design

### Backend

- New command constant `COMMANDS.AGENT_LAUNCH = 'agent_launch'`, listed in `MUTATING_COMMANDS` so the API/MCP layer requires an idempotencyKey.
- New MCP tool definition `agent_launch` with required `teamId`, `agentId`, `runtimeId`, `command`; optional `args` (string array), `cwd`, `env` (object), `providerId`.
- `LocalToolFacade` accepts a new `launchAgent` callback (typed as a function returning a runtime record). When the facade receives `agent_launch`, it forwards the args to that callback. If `launchAgent` is null (DI missing), it throws a clear "agent_launch is not configured" error.
- `LocalToadRuntime` passes `this.launchAgent.bind(this)` as `launchAgent` to the facade. That preserves the runtime's adapter-map setup (which `supervisor.launchAgent` alone does not do).

### UI

A new "Launch Agent" panel above System Housekeeping in the dashboard. Five inputs:

- `teamId` — text
- `agentId` — text
- `runtimeId` — text (caller-supplied; for now, the operator picks a unique ID)
- `command` — text, defaults to `claude`
- `cwd` — text, optional

A submit button calls `/api/call` with `method: 'agent_launch'` and a UI-generated idempotency key. On success, the runtime appears in the existing Active Runtimes list within a few hundred ms via the SSE event stream. On failure, the error message renders inline.

Args/env are intentionally **not** in the UI form for now — they require array/object inputs that complicate the form. They remain available via `/api/call` for power users.

### Idempotency semantics

`launchAgent` itself is not idempotent — calling it twice with the same `runtimeId` will fail because the runtime already exists in the registry. The idempotency key on `agent_launch` is the standard mutating-command requirement; the facade does not deduplicate by it. If a future slice wants real "launch-once" semantics, it can be added in a separate facade layer.

## Changes

- `src/commands/command-contract.js` — add `AGENT_LAUNCH`, list in `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — add the tool def.
- `src/tools/localToolFacade.js` — accept `launchAgent` callback; route `agent_launch` to it.
- `src/app/LocalToadRuntime.js` — pass `this.launchAgent.bind(this)` to the facade.
- `test/localToolFacade.test.js` — new tests for the facade dispatch.
- `test/localMcpToolDefinitions.test.js` — assert `agent_launch` is present, mutating, and has the expected required keys.
- `ui/src/components/Dashboard.jsx` — Launch Agent panel.

## Verification

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

All 27 backend test files pass; UI lint and build pass.

## Out Of Scope

- Validating that the `command` actually exists on the host. SQLite-equivalent: the supervisor will surface the spawn error if it fails.
- Team-config integration. Launching from a stored team template (legacy `TeamCreate` / `TeamProvisioningService`) is a much bigger slice.
- Stop button in the UI for active runtimes. `LocalToadRuntime.stopAgent` exists but is not yet API-exposed; companion slice if wanted.
- Persisting form values in `localStorage`. Nice-to-have; not load-bearing for the slice.
