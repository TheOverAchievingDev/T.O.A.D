# `runtime_send_input` MCP Tool

Slice: 2026-04-30
Status: complete

## Goal

Mirror the legacy app's `TEAM_PROCESS_SEND` IPC handler: a path for writing arbitrary text directly to a running runtime's stdin via its adapter, bypassing the broker. The existing `message_send` path is durable (persists to the broker, then the delivery worker pushes to the adapter); `runtime_send_input` is the ephemeral counterpart.

Use cases:

- Sending a slash command to a Claude runtime (`/clear`, `/usage`, `/compact`, etc.) — these are CLI directives, not chat messages, and should not appear in message history.
- One-off ad-hoc prompts from an operator that aren't intended to be part of the durable conversation log.
- Test harnesses that want to drive a runtime without contaminating the broker.

## Naming

The legacy IPC name `TEAM_PROCESS_SEND` is Electron-specific and team-keyed. TOAD addresses runtimes by `runtimeId` directly (the same key already used by `runtime_events`, `tool_activity`, `agent_status`, `agent_launch`, `agent_stop`). The natural TOAD-side name is `runtime_send_input`.

## Design

`LocalToolFacade` already has the `adapters` injection (a `Map<runtimeId, adapter>`) — used today by `approval_respond` to deliver control responses. The same map is what `runtime_send_input` consumes.

Handler flow:

1. Require `runtimeId` and `text` (both non-empty strings).
2. Look up the adapter in the map. If missing → throw a clear error with the runtimeId.
3. Call `adapter.sendTurn({ message: { text } })`.
4. Return the receipt the adapter produced (`{ accepted, responseState, receipt }`).

The MCP tool is mutating (requires `idempotencyKey`), but the facade does **not** dedupe — `adapter.sendTurn` is intentionally not idempotent. The idempotency key is the standard mutating-command requirement so the API/MCP layer's expectations stay consistent across all mutating tools.

## Changes

- `src/commands/command-contract.js` — `RUNTIME_SEND_INPUT = 'runtime_send_input'` in `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — new tool def with required `runtimeId` + `text`.
- `src/tools/localToolFacade.js` — new `#runtimeSendInput` async handler.
- `test/localToolFacade.test.js` — new TDD tests (forwarding to adapter, missing-adapter rejection, sync idempotencyKey check).
- `test/localMcpToolDefinitions.test.js` — `runtime_send_input` in expected names + mutating-tools assertion.

## Verification

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

All 28 backend test files pass.

## Out Of Scope

- Capturing the runtime's response to the input. The reply (if any) will flow back through the existing runtime-event ingestion path as `assistant_text`, just like any other turn. We don't synchronously wait for it here.
- Sending structured input (tool results, control responses). Those have their own dedicated paths (`approval_respond` and the tool-result delivery loop). `runtime_send_input` is text-only.
- Targeting by `teamId` + `agentId` instead of `runtimeId`. Operators can resolve via `agent_status` or use the deterministic `runtime-<teamId>-<agentId>` IDs from `team_launch`.
