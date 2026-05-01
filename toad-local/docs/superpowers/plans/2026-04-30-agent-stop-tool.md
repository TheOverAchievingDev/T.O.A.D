# `agent_stop` MCP Tool

Slice: 2026-04-30
Status: complete

## Goal

`LocalToadRuntime.stopAgent(runtimeId, options)` exists and is unit-tested, but is not callable from the API. After the prior slice exposed `agent_launch`, the lifecycle pair was unbalanced: an operator could spawn runtimes via `/api/call` but had to drop into the orchestrator process to stop them.

This slice mirrors the agent_launch design exactly, exposing `stopAgent` as a mutating MCP tool. Backend-only — no UI surface in this slice per the project's current backend-first focus.

## Design

Direct parallel to `agent_launch`:

- New `COMMANDS.AGENT_STOP = 'agent_stop'`, listed in `MUTATING_COMMANDS`.
- New MCP tool def with required `runtimeId`, optional `signal` (string, default `'SIGTERM'`).
- `LocalToolFacade` accepts a `stopAgent` callback in its constructor; `#agentStop` handler unpacks `{ runtimeId, signal }` and forwards.
- `LocalToadRuntime` supplies `(input) => this.stopAgent(input.runtimeId, input.signal ? { signal: input.signal } : undefined)` so the runtime's adapter cleanup (`this.adapters.delete(runtimeId)`) keeps running.

## Changes

- `src/commands/command-contract.js` — add `AGENT_STOP` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — add the tool def.
- `src/tools/localToolFacade.js` — accept `stopAgent` callback; route `agent_stop` to a new `#agentStop` handler.
- `src/app/LocalToadRuntime.js` — pass `stopAgent` adapter to the facade.
- `test/localToolFacade.test.js` — 3 new tests (forwarding, missing-callback rejection, idempotencyKey requirement) mirroring the agent_launch tests.
- `test/localMcpToolDefinitions.test.js` — `agent_stop` added to the expected names list and the mutating-tools assertion.

## Verification

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

All 27 backend test files pass.

## Out Of Scope

- Forced-kill semantics (`SIGKILL` after grace period). The `signal` option already supports passing `SIGKILL`; if richer drain-then-kill is wanted, add a `gracePeriodMs` field in a follow-up.
- Stop-all-in-team. The next slice in the queue (team lifecycle: `team_stop`) handles team-wide shutdown.
- UI stop button. Deferred per project's current backend-first focus.
