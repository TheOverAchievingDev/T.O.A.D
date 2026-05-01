# `team_launch` / `team_stop` Orchestration

Slice: 2026-04-30
Status: complete

## Goal

Second half of the team-lifecycle decomposition. The previous slice persisted team configs and exposed `team_create` / `team_list` / `team_delete`. This slice adds the orchestration tools that actually start and stop a team's runtimes as a unit, by composing the existing `agent_launch` / `agent_stop` callbacks with the team config registry and the runtime registry.

After this slice an operator can run a single `/api/call team_launch { teamId }` and get the lead and every teammate spawned in one shot.

## Design

### Runtime ID derivation

`team_launch` does not accept caller-supplied runtime IDs. It derives them deterministically as:

```
runtime-<teamId>-<agentId>
```

Determinism is load-bearing: it lets the "skip if already running" check work, lets `team_stop` find what `team_launch` started without bookkeeping, and gives operators a predictable runtime ID to use with the existing per-runtime tools (`runtime_events`, `tool_activity`, `agent_status`).

### `team_launch` semantics

1. Look up the team config by `teamId`. If missing → throw `team_launch: no config for teamId <id>`.
2. Build the member list as `[lead, ...teammates]`.
3. For each member, derive `runtimeId = runtime-<teamId>-<agentId>`.
4. **If a runtime with that ID already exists with `status === 'running'`**, skip the launch and record `status: 'already_running'`. This makes re-issuing `team_launch` on a partially-running team idempotent in the common case (the lead came up but a teammate failed to spawn last time, operator retries, only the missing teammate is launched).
5. Otherwise, call the `launchAgent` callback with the member's launch parameters and record `status` from the returned runtime (typically `'starting'`).
6. **Per-member errors are caught**, recorded as `{ status: 'failed', error: <message> }`, and do **not** abort the rest of the loop. The whole call returns a per-member result array. Roll-back-on-partial-failure is intentionally NOT implemented — leaving partially-launched runtimes running matches the legacy app's "best effort, surface what happened" semantics, and lets the operator fix the failed member without losing the working ones.

Return shape:

```js
{
  teamId,
  members: [
    { runtimeId, agentId, status: 'starting' | 'already_running' | 'failed', error? },
    ...
  ],
}
```

### `team_stop` semantics

1. Query `runtimeRegistry.listRuntimes({ teamId })`.
2. Filter to `status === 'running'`.
3. For each, call the `stopAgent` callback with the optional `signal`.
4. Aggregate per-member results in the same shape as `team_launch`.

Empty result (no running runtimes) is **not** an error — `team_stop` is idempotent. Per-runtime stop failures are caught and recorded individually, same as launch.

### Tool surface

Both are mutating (require `idempotencyKey`):

- `team_launch` — required: `teamId`. No optional fields in this slice (the registry holds the launch params).
- `team_stop` — required: `teamId`. Optional: `signal` (`SIGTERM` / `SIGINT` / `SIGKILL`).

## Changes

- `src/commands/command-contract.js` — add `TEAM_LAUNCH` and `TEAM_STOP` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — two new tool defs.
- `src/tools/localToolFacade.js` — new `#teamLaunch` and `#teamStop` handlers; the facade already has `teamConfigRegistry`, `launchAgent`, `stopAgent`, and `runtimeRegistry` injections from prior slices.
- `test/localToolFacade.test.js` — new TDD-style tests covering: launches all members, derives runtime IDs deterministically, throws on missing team config, skips members already running, captures per-member failures without aborting, stops all running runtimes for a team, idempotent on no matches.
- `test/localMcpToolDefinitions.test.js` — `team_launch` and `team_stop` added to the expected names list and the mutating-tools assertion.

## Verification

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

All 28 backend test files pass.

## Out Of Scope

- Provisioning hooks (git init, worktree creation) before launching a team. The legacy app does this via `TEAM_PREPARE_PROVISIONING` / `TEAM_INITIALIZE_GIT_REPOSITORY`. Will become its own slice once we're ready to take on the git-integration story.
- A timeout / wait-for-ready phase. `agent_launch` returns once the supervisor has spawned the process; the runtime may still be starting up. The legacy app polls `process_alive` to know when an agent is "really up". Add when needed.
- Roll-back on partial failure. See design notes above — intentionally not implemented.
- Cross-team launch. `team_launch` operates on a single teamId per call.
