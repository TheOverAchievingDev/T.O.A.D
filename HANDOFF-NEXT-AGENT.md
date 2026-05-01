# TOAD Local Rebuild Handoff

Last updated: 2026-04-30 local session (deterministic state machine — checklist §3)

This file is the handoff point for a fresh agent with no chat context. The user wants to continue reverse engineering the alpha MCP/Twilio-style GitHub project and rebuilding our own local TOAD runtime. Work is local only. Do not push to git unless the user explicitly asks.

## Workspace

- Root: `C:\Project-TOAD`
- Main local rebuild: `C:\Project-TOAD\toad-local`
- Main reverse-engineering/rebuild doc: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- Legacy/original project under study: `C:\Project-TOAD\claude_agent_teams_ui-main\claude_agent_teams_ui-main`
- Important legacy file for many findings: `C:\Project-TOAD\claude_agent_teams_ui-main\claude_agent_teams_ui-main\src\main\services\team\TeamProvisioningService.ts`

There appears to be no git metadata in `C:\Project-TOAD\toad-local`; earlier `git status` failed there. Treat the workspace as local files.

## User Preferences / Constraints

- Keep work local for now. No git push.
- Continue in small logical slices.
- Use tests first for behavior changes.
- Use `apply_patch` for manual edits.
- Use PowerShell commands from `C:\Project-TOAD\toad-local`.
- Approval policy is `never`; do not request elevated/sandbox permissions.

## Current Test Command

Run full regression from `C:\Project-TOAD\toad-local`:

```powershell
npm.cmd test
```

Last full backend regression passed after the durable side-effect delivery receipts slice on 2026-04-30 (26 test files). UI lint and UI build last passed after the API/UI hardening slice (UI was not touched in this slice).

Current `package.json` test chain:

```powershell
node test/broker.test.js && node test/taskBoard.test.js && node test/approvalBroker.test.js && node --no-warnings test/sqliteApprovalBroker.test.js && node --no-warnings test/sqliteBroker.test.js && node --no-warnings test/sqliteTaskBoard.test.js && node test/localToolFacade.test.js && node test/localMcpToolDefinitions.test.js && node --no-warnings test/localMcpServer.test.js && node test/deliveryWorker.test.js && node test/claudeStreamJsonAdapter.test.js && node --no-warnings test/sqliteRuntimeRegistry.test.js && node --no-warnings test/sqliteRuntimeEventLog.test.js && node test/runtimeEventIngestor.test.js && node test/runtimeSupervisor.test.js && node test/localReadModel.test.js && node --no-warnings test/localToadRuntime.test.js && node test/parsePermissionRequest.test.js && node test/claudeSettingsWriter.test.js && node test/teammatePermission.test.js && node test/compactionHandler.test.js && node test/crossTeam.test.js && node test/runtimeEventBus.test.js && node test/teamConfig.test.js && node test/apiServer.test.js && node --no-warnings test/sideEffectLog.test.js
```

Claude CLI smoke is now live-verified end-to-end:

- `claude` exists at `C:\Users\Nova_\.local\bin\claude.exe`
- Smoke harness: `C:\Project-TOAD\toad-local\test\claudeCliSmoke.test.js`
- Run with `TOAD_CLAUDE_SMOKE=1` (set `CLAUDE_BIN` if `claude` is not on PATH)
- Last verified pass: 2026-04-30 — produced an `assistant_text: "TOAD-SMOKE"` event and `result.success` summary in ~15s against `claude-opus-4-7`.
- The harness uses `--print --verbose --input-format stream-json --output-format stream-json --no-session-persistence --tools ""` (no `--bare`).
- Do NOT add `--bare` without first confirming an Anthropic API key is set — `--bare` rejects the subscription OAuth that the user's machine uses and the harness will silently skip.

## What Has Been Built

The local rebuild is a Node ESM project using `node:test` and `node:sqlite`.

Core pieces currently present:

- Protocol/message envelope core
- In-memory and SQLite broker
- Delivery attempts and runtime delivery worker
- Task board and review workflow
- Durable approval broker
- MCP-shaped local tool definitions and stdio server
- Runtime supervisor with restart policy
- SQLite runtime registry
- SQLite runtime event log
- Claude stream-json adapter
- Runtime event ingestion
- Runtime identity validation
- Local read model
- Local orchestrator `LocalToadRuntime`
- Teammate permission parser and Claude settings writer
- Runtime compaction handler
- Runtime event bus
- Cross-team message protocol
- Team config registry
- HTTP/SSE API server
- Vite React dashboard under `ui/`

Important files:

- `C:\Project-TOAD\toad-local\src\app\LocalToadRuntime.js`
- `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`
- `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
- `C:\Project-TOAD\toad-local\src\runtime\RuntimeSupervisor.js`
- `C:\Project-TOAD\toad-local\src\runtime\RuntimeIdentityValidator.js`
- `C:\Project-TOAD\toad-local\src\runtime\sqliteRuntimeRegistry.js`
- `C:\Project-TOAD\toad-local\src\runtime\sqliteRuntimeEventLog.js`
- `C:\Project-TOAD\toad-local\src\approval\inMemoryApprovalBroker.js`
- `C:\Project-TOAD\toad-local\src\approval\sqliteApprovalBroker.js`
- `C:\Project-TOAD\toad-local\src\tools\localToolFacade.js`
- `C:\Project-TOAD\toad-local\src\read\LocalReadModel.js`
- `C:\Project-TOAD\toad-local\src\mcp\localToolDefinitions.js`
- `C:\Project-TOAD\toad-local\src\mcp\localMcpServer.js`
- `C:\Project-TOAD\toad-local\src\mcp\stdioServer.js`
- `C:\Project-TOAD\toad-local\src\storage\schema.sql`
- `C:\Project-TOAD\toad-local\src\runtime\parsePermissionRequest.js`
- `C:\Project-TOAD\toad-local\src\runtime\claudeSettingsWriter.js`
- `C:\Project-TOAD\toad-local\src\runtime\CompactionHandler.js`
- `C:\Project-TOAD\toad-local\src\protocol\crossTeam.js`
- `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventBus.js`
- `C:\Project-TOAD\toad-local\src\team\teamConfig.js`
- `C:\Project-TOAD\toad-local\src\transport\apiServer.js`
- `C:\Project-TOAD\toad-local\src\delivery\sideEffectLog.js`
- `C:\Project-TOAD\toad-local\ui\`

## Latest Completed Slices

### 1. Deterministic Task State Machine — Checklist §3 (latest)

**Project priorities updated.** The user supplied `agent_teams_hardening_checklist_final_v2.md` as the target system standard. Copied to `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md` and audited at `docs/CHECKLIST_GAP_MATRIX.md`. Slice order is now anchored to the checklist's own priority: **state machine > tool authority > session tracking > diff tracking > CI gates > diagnostics**. UI work continues to be deferred per the user's earlier steering (parallel UI prototype is being built elsewhere).

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-deterministic-state-machine.md`

The single most important enforcement gap from the gap matrix. Closes §3.

New file:

- `src/task/taskLifecycle.js` — exports `TASK_LIFECYCLE` (the 10 states from the checklist), `ALLOWED_TRANSITIONS` (with legacy aliases for `pending`/`completed`/`deleted` so existing call sites keep working without a coordinated rewrite), and `validateTaskStatusTransition({ from, to })`. The validator returns `{ ok: true }` for legal moves and `{ ok: false, reason }` otherwise. Same-state self-transitions are idempotent. `from === null` (initial state) accepts any known status.

Modified files:

- `src/tools/localToolFacade.js` — `#taskUpdate` now reads the current task's status, calls `validateTaskStatusTransition`, throws on illegal transitions, and records `from` (previous status) and optional `reason` in the STATUS_CHANGED event payload (per checklist requirement: "every transition records actor, reason, timestamp, previous state, and next state").
- `package.json` — adds `node test/taskLifecycle.test.js` to the test chain (now 29 test files).
- `test/taskLifecycle.test.js` — NEW. 8 tests covering lifecycle constants, initial-state acceptance, idempotent self-transitions, the canonical 10-state happy path, illegal-transition rejection with reason strings, and legacy alias bridges.
- `test/localToolFacade.test.js` — 3 new tests (now 35 total): STATUS_CHANGED records `from`/`reason`; illegal transitions throw; legacy `pending → in_progress → completed` still works.

Behavior decisions:

- **Legacy aliases included in the table** (`pending`, `completed`, `deleted`) so the existing `taskBoard.test.js` happy path keeps passing. Future tightening (forbid `in_progress → completed` shortcut, requiring `review → testing → merge_ready → done`) is deferred until §6 CI gates land — at that point the role authority slice (§5) will know whether the actor is allowed to skip review.
- **Validation throws synchronously** from `#taskUpdate`. The mutating-command idempotency check is also sync, so behavior is consistent with `agent_launch` and `agent_stop`.
- **Same-state self-transitions are allowed.** Re-issuing `task_update status=X` when the task is already X is treated as a no-op rather than a validation error. Idempotency-friendly.

Verification during slice:

```powershell
node test/taskLifecycle.test.js
node test/localToolFacade.test.js
node test/taskBoard.test.js
npm.cmd test
```

All 29 backend test files pass.

### 2. Code Review With Diffs

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-review-with-diffs.md`

Brings TOAD's review surface up to legacy parity for the **content** half of code review. The legacy `review.ts` has 18+ IPC handlers spanning git worktrees, file watchers, hunk-level reject, conflict detection — all explicitly deferred. This slice does the minimum viable subset: store diff text on the review request, surface it via a new read tool, and let the decision attach per-file feedback.

Modified files:

- `src/task/inMemoryTaskBoard.js` — `projectTask` populates a new `task.review` sub-object on `REVIEW_REQUESTED` (state, reviewerId, summary, diff, files, requestedBy, requestedAt) and merges into it on `REVIEW_DECIDED` (decision, reason, feedback, decidedBy, decidedAt). The existing `task.reviewState` enum is kept for backward compatibility; new consumers should prefer `task.review`.
- `src/commands/command-contract.js` — adds `REVIEW_LIST = 'review_list'` (read-only, NOT in `MUTATING_COMMANDS`).
- `src/mcp/localToolDefinitions.js` — extended `review_request` schema (`summary`, `diff`, `files`); extended `review_decide` schema (`feedback` as array of `{ file, comment }`); new `review_list` tool def (read-only).
- `src/tools/localToolFacade.js` — `#reviewRequest` and `#reviewDecide` propagate the new fields into event payloads (omitted when not provided so existing callers keep working); new `#reviewList` returns tasks where `task.review.state === 'requested'` for the actor's team.
- `test/taskBoard.test.js` — 2 new projection tests (now 5 total): diff/files/summary populated on REVIEW_REQUESTED; feedback merged on REVIEW_DECIDED while requested-side fields persist.
- `test/localToolFacade.test.js` — 3 new tests (now 32 total): review_request stores diff/files/summary; review_decide stores feedback; review_list returns only tasks with active reviews including the diff content.
- `test/localMcpToolDefinitions.test.js` — `review_list` added to expected names list and read-only tools assertion.

Behavior decisions:

- **No schema change.** Diff text and feedback live in `task_events.payload_json`. SQLite TEXT columns hold large diffs comfortably and the event-log replay surfaces them naturally.
- **`task.review` is a single sub-object** (not scattered fields). Cohesive shape, maps directly to the legacy app's review payload.
- **All new fields are optional** so existing callers (the agent-status tools, current task_list consumers) keep working unchanged. Empty/missing diff = "approve a task by ID" mode, which is what the prior implementation did.
- **Caller passes the diff text in.** TOAD has no git integration yet — the agent calling `review_request` runs `git diff` itself and attaches the output. Auto-generating diffs from a worktree is a separate slice.

Verification during slice:

```powershell
node test/taskBoard.test.js
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

### 2. `runtime_send_input` MCP Tool

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-send-input.md`

Mirrors the legacy `TEAM_PROCESS_SEND` IPC handler. Writes arbitrary text directly to a runtime's stdin via its adapter, bypassing the broker. Counterpart to the durable `message_send` path. Use cases: slash commands (`/clear`, `/usage`, `/compact`), one-off ad-hoc prompts that should not appear in message history, test harnesses driving a runtime without contaminating the broker.

Modified files:

- `src/commands/command-contract.js` — adds `RUNTIME_SEND_INPUT` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — new tool def with required `runtimeId` + `text`.
- `src/tools/localToolFacade.js` — new `#runtimeSendInput` handler that looks up the adapter by `runtimeId` (using the existing `adapters` Map injection) and calls `adapter.sendTurn({ message: { text } })`.
- `test/localToolFacade.test.js` — 3 new tests (now 29 total): forwarding, missing-adapter rejection, sync idempotencyKey check.
- `test/localMcpToolDefinitions.test.js` — `runtime_send_input` added to expected names list and the mutating-tools assertion.

Behavior decisions:

- **Naming chosen as `runtime_send_input`**, not `team_process_send`. The legacy IPC name is Electron-specific and team-keyed. TOAD addresses runtimes by `runtimeId` directly, matching `runtime_events` / `tool_activity` / `agent_status` / `agent_launch` / `agent_stop`.
- **Idempotency key required but not used for dedup.** `adapter.sendTurn` is intentionally not idempotent. The key is the standard mutating-command requirement so the API/MCP layer's expectations stay consistent.
- **Replies flow back through normal runtime-event ingestion** as `assistant_text` — `runtime_send_input` does not synchronously wait for a response.

Verification during slice:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

### 2. `team_launch` / `team_stop` Orchestration

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-team-launch-stop.md`

Second half of the team-lifecycle decomposition. Composes the existing `agent_launch` / `agent_stop` callbacks with the team config registry and the runtime registry. After this slice an operator can run a single `/api/call team_launch { teamId }` and get the lead and every teammate spawned in one shot.

Modified files:

- `src/commands/command-contract.js` — adds `TEAM_LAUNCH` and `TEAM_STOP` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — two new tool defs (`team_launch` requires `teamId`; `team_stop` requires `teamId`, optional `signal`).
- `src/tools/localToolFacade.js` — new `#teamLaunch` and `#teamStop` async handlers. The facade already had all needed injections (`teamConfigRegistry`, `launchAgent`, `stopAgent`, `runtimeRegistry`) from prior slices.
- `test/localToolFacade.test.js` — 6 new tests (now 26 total): launches every member with derived `runtime-<teamId>-<agentId>` IDs; throws on missing config; skips already-running members (idempotent re-launch); records per-member failures without aborting; team_stop stops only matching team's runtimes; team_stop is idempotent on no matches.
- `test/localMcpToolDefinitions.test.js` — `team_launch` / `team_stop` added to expected names and mutating-tools assertions.

Behavior decisions worth knowing:

- **Runtime ID derivation is `runtime-<teamId>-<agentId>`** — deterministic on purpose. Lets the "skip if already running" check work, lets `team_stop` find what `team_launch` started without separate bookkeeping, and gives operators a predictable runtime ID for the per-runtime tools.
- **No roll-back on partial failure.** Per-member failures are caught and recorded as `{ status: 'failed', error }`; the loop continues. The whole call returns a per-member result array. Matches the legacy app's "best effort, surface what happened" semantics.
- **Skip-if-running** uses `runtimeRegistry.getRuntime(runtimeId)?.status === 'running'`. Re-issuing `team_launch` after a partial-launch failure only launches the missing members.

Verification during slice:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

### 2. Persistent Team Config + CRUD Tools

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-persistent-team-config.md`

First slice of the team-lifecycle decomposition. Foundation work: extend the team-config schema to include actual launch parameters, add a SQLite-backed registry, expose the three CRUD tools. The orchestration pair (`team_launch` / `team_stop`) is the next slice — kept separate because it adds new failure modes (partial-launch idempotency) that deserve their own design pass.

Modified files:

- `src/team/teamConfig.js` — `TeamConfig` member schema extended with `command`, `args`, `cwd`, `env`, `providerId`, `prompt` (plus a `toJSON()` for round-trip persistence). Backward-compatible defaults; the existing teamConfig.test.js cases keep working.
- `src/team/sqliteTeamConfigRegistry.js` — NEW. Mirrors the existing SqliteBroker / SqliteTaskBoard / SqliteApprovalBroker shape. `registerTeam` upserts on conflict (legacy parity — operators iterate without a delete-then-create dance). Adds `deleteTeam` + `close` beyond the in-memory registry's API.
- `src/storage/schema.sql` — new `team_configs(team_id, config_json, created_at, updated_at)` table.
- `src/commands/command-contract.js` — `TEAM_CREATE`, `TEAM_LIST`, `TEAM_DELETE`. Create + Delete are mutating.
- `src/mcp/localToolDefinitions.js` — three new tool defs plus a shared `TEAM_MEMBER_SCHEMA` constant.
- `src/tools/localToolFacade.js` — accepts `teamConfigRegistry`; routes the three commands through new `#teamCreate` / `#teamList` / `#teamDelete` handlers.
- `src/app/LocalToadRuntime.js` — constructs `SqliteTeamConfigRegistry({ filePath: dbPath })` by default; passes it to the facade and closes it on shutdown.
- `test/teamConfig.test.js` — 2 new tests (now 7 total) for the extended schema.
- `test/sqliteTeamConfigRegistry.test.js` — NEW with 7 tests including a persistence round-trip across two instances against the same dbPath.
- `test/localToolFacade.test.js` — 2 new tests (now 22 total) for the team-tool routing.
- `test/localMcpToolDefinitions.test.js` — three new tools added to the expected names list and the mutating/read-only assertions.
- `package.json` — adds `node test/sqliteTeamConfigRegistry.test.js` to the test chain (now 28 test files).

Verification during slice:

```powershell
node test/teamConfig.test.js
node test/sqliteTeamConfigRegistry.test.js
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

### 2. `agent_stop` MCP Tool

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-agent-stop-tool.md`

Mirrors the `agent_launch` slice exactly — backend-only, no UI surface this round (per the user's current backend-first focus; UI is being prototyped in parallel by another tool). Closes the runtime lifecycle pair so an operator can stop runtimes via `/api/call`, not just spawn them.

Modified files:

- `src/commands/command-contract.js` — adds `AGENT_STOP` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — new `agent_stop` tool definition with required `runtimeId`, optional `signal` enum (`SIGTERM` / `SIGINT` / `SIGKILL`).
- `src/tools/localToolFacade.js` — accepts a new `stopAgent` callback; routes `COMMANDS.AGENT_STOP` to a new `#agentStop` handler that unpacks `{ runtimeId, signal }` and forwards.
- `src/app/LocalToadRuntime.js` — passes `({ runtimeId, signal }) => this.stopAgent(runtimeId, signal ? { signal } : undefined)` to the facade so the runtime's `adapters.delete(runtimeId)` step still runs.
- `test/localToolFacade.test.js` — 3 new tests (forwarding with signal, missing-callback rejection, sync idempotencyKey requirement). 18 total.
- `test/localMcpToolDefinitions.test.js` — `agent_stop` added to expected names list and mutating-tools assertion.

All 27 backend test files green.

### 2. `agent_launch` MCP Tool + Dashboard Launcher

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-agent-launch-tool.md`

Modified files:

- `src/commands/command-contract.js` — adds `AGENT_LAUNCH = 'agent_launch'` to `COMMANDS` and to `MUTATING_COMMANDS` (idempotencyKey required).
- `src/mcp/localToolDefinitions.js` — adds the `agent_launch` tool definition with required `teamId/agentId/runtimeId/command` plus optional `args/cwd/env/providerId`.
- `src/tools/localToolFacade.js` — accepts a new `launchAgent` callback in its constructor; routes `COMMANDS.AGENT_LAUNCH` to a new async `#agentLaunch` handler that forwards args to that callback. Throws a clear "agent_launch is not configured" error when no callback is set.
- `src/app/LocalToadRuntime.js` — passes `(input) => this.launchAgent(input)` to the facade so the runtime's adapter-map setup is preserved (calling `supervisor.launchAgent` directly would skip that step).
- `test/localToolFacade.test.js` — 3 new tests (now 15 total): facade forwards args correctly, rejects when callback is missing, requires idempotencyKey.
- `test/localMcpToolDefinitions.test.js` — `agent_launch` added to the expected names list and the mutating-tools assertion.
- `ui/src/components/Dashboard.jsx` — new "Launch Agent" panel above System Housekeeping with five inputs (teamId, agentId, runtimeId, command, optional cwd) and a submit button. Calls `/api/call agent_launch` with a UI-generated idempotency key; surfaces success/error inline; clears the runtimeId field on success and triggers `fetchData()` so the new runtime appears in the Active Runtimes list.

Behavior:

- `agent_launch` is the first **mutating runtime-management** tool exposed via the API. Prior tools were either pure observers (`agent_status`, `runtime_events`) or affected stored state (`task_create`, `message_send`); this one literally spawns a process under the supervisor.
- The facade does NOT deduplicate by idempotency key — `launchAgent` itself is not idempotent (a duplicate `runtimeId` would hit a registry uniqueness constraint). The idempotency key is the standard mutating-command requirement; real launch-once semantics would be a separate slice.
- Args/env are intentionally absent from the UI form (array/object inputs complicate the form). They remain available via `/api/call` for power users.

Verification during slice:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

### 2. API Token On Disk

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-api-token-on-disk.md`

New files:

- `src/runtime/resolveApiToken.js` — `resolveApiToken({ explicit, projectCwd })` with three-layer precedence: explicit DI > `process.env.TOAD_API_TOKEN` > `<projectCwd>/.toad/api-token` > null.
- `scripts/generate-api-token.mjs` — `crypto.randomBytes(32).toString('hex')`, writes to `<projectCwd>/.toad/api-token`, sets `0o600` on Unix, prints PowerShell- and bash-friendly export commands for the UI side.
- `test/resolveApiToken.test.js` — 5 unit tests covering all four precedence branches plus the "no projectCwd, file lookup skipped" case.

Modified files:

- `src/app/LocalToadRuntime.js` — new `apiToken` constructor option; `ApiServer` token now sourced from `resolveApiToken({ explicit: apiToken, projectCwd })`.
- `package.json` — adds `npm run token:generate`; adds the new test to the test chain (now 27 total).
- `README.md` — documents Option A (generate-and-persist, recommended) and Option B (per-shell env var).

Behavior:

- Default `LocalToadRuntime()` (no projectCwd) is unchanged — still falls through to env-or-null. Tests stay hermetic; no accidental disk reads.
- `npm run token:generate` is idempotent-friendly: re-running rotates the token. Stop the orchestrator before rotating so live SSE clients aren't left holding a stale token.
- The dashboard's Vite build still requires `VITE_TOAD_API_TOKEN` at build time; the script prints exactly the export command needed.

Verification during slice:

```powershell
node test/resolveApiToken.test.js
npm.cmd test
npm.cmd run token:generate   # one-time setup or rotation
```

### 2. VACUUM On Retention

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-vacuum-on-retention.md`

Modified files:

- `src/app/LocalToadRuntime.js` — new `vacuumDatabase()` method that returns `{ vacuumed, reason, freelistBefore, freelistAfter }`; runs `VACUUM` on the registry/eventLog/approvalBroker SQLite connection (whichever is available). `start()` now invokes it after a non-zero `pruneSideEffectLog()` and emits a `database_vacuumed` `runtime_event`.
- `test/localToadRuntime.test.js` — 3 new tests (now 23 total): freelist_count drops to 0 after vacuum on a seeded-then-deleted real DB; in-memory dbPath returns `{ vacuumed: false, reason: 'in_memory' }`; `start()` emits `database_vacuumed` when prune did non-zero work.
- `ui/src/components/Dashboard.jsx` — System Housekeeping panel widened from 2 to 3 columns; new `VacuumCell` displays freelist pages reclaimed and relative time of the last vacuum.

Behavior:

- After `pruneSideEffectLog()` deletes rows, those pages move to SQLite's freelist but the file does not shrink. `VACUUM` reclaims them. Without this, a long-running install's `<projectCwd>/.toad/toad.db` grew monotonically.
- VACUUM only runs when prune actually deleted rows — clean restarts are silent.
- `:memory:` and stub-injected setups skip cleanly with explicit reason codes.
- The new event flows through the existing SSE bus and into the dashboard's housekeeping panel automatically.

Verification during slice:

```powershell
node test/localToadRuntime.test.js
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

### 2. Broker / TaskBoard Durability Swap

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-broker-taskboard-durability.md`

Modified files:

- `src/app/LocalToadRuntime.js` — `broker` default switched from `InMemoryBroker` to `SqliteBroker({ filePath: dbPath })`; `taskBoard` default switched from `InMemoryTaskBoard` to `SqliteTaskBoard({ filePath: dbPath })`. All downstream `broker` / `taskBoard` references updated to use `this.broker` / `this.taskBoard` instead of the destructured params (which are now `null` when not provided). Imports updated to remove the in-memory variants.
- `test/localToadRuntime.test.js` — new persistence test (now 20 total): writes a message and a task event through one runtime, closes, opens a second runtime against the same `dbPath`, asserts both survive.
- `README.md` — note that all five storage surfaces (broker, taskBoard, approvalBroker, runtimeRegistry, eventLog) now persist when `dbPath` is a real file.

Behavior:

- `npm run api:dev` now persists messages and tasks across restarts — prior in-progress tasks, pending approvals, message history all visible to the next process.
- API parity verified: `SqliteBroker` and `SqliteTaskBoard` expose the exact methods downstream consumers call (`appendMessage`, `listInbox`, `listMessages`, `markRead` for the broker; `appendEvent`, `listEvents`, `getTask`, `listTasks` for the task board). Existing tests continue to pass against the new defaults — proves transitively that the swap preserves observable behavior.
- `LocalToadRuntime.close()` already iterates `taskBoard` and `broker` via `closeIfSupported` — SQLite connections close cleanly.

Verification during slice:

```powershell
node test/localToadRuntime.test.js
npm.cmd test
```

### 2. Persistent Storage Configuration + close() leak fix

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-persistent-storage-configuration.md`

The discovery that drove this slice: `scripts/dev-api-server.mjs` constructed `LocalToadRuntime` with no storage paths, so all SQLite components defaulted to `:memory:`. The whole durability story (delivery receipts, approval persistence, runtime audit, side-effect replay-on-restart, retention) silently did nothing across a real `npm run api:dev` restart.

Modified files:

- `src/storage/sqlite.js` — `openToadDatabase` now `mkdirSync(parent, { recursive: true })` for non-`:memory:` paths so first-run doesn't fail on a missing directory.
- `src/app/LocalToadRuntime.js` — new `dbPath` constructor option (default `:memory:`); `runtimeRegistry`, `eventLog`, `approvalBroker` defaults are now constructed against `dbPath` (rather than each defaulting to its own `:memory:`); existing tests still pass because the default is unchanged.
- `src/app/LocalToadRuntime.js` — `close()` now also calls `closeIfSupported(this.approvalBroker)`. Without this, the approval broker's SQLite connection stayed open after `close()` returned; on Windows this prevented the file from being unlinked. Real bug, surfaced by the new persistence test.
- `scripts/dev-api-server.mjs` — sets `dbPath` to `<projectCwd>/.toad/toad.db` (overridable by `TOAD_DB_PATH`), prints the resolved path on startup so the operator can see where their data lives.
- `test/localToadRuntime.test.js` — new persistence test (now 19 total): writes an approval through one `LocalToadRuntime` against a temp `dbPath`, closes it, opens a second `LocalToadRuntime` against the same path, asserts the approval is visible. Exercises the auto-mkdir path with a nested directory.
- `.gitignore` (toad-local) — adds `.toad/` plus the existing api-dev log files.
- `README.md` — documents `TOAD_DB_PATH` and the default `<projectCwd>/.toad/toad.db` location.

Behavior:

- Constructor default stays `:memory:` so tests don't accidentally write to disk.
- `npm run api:dev` now writes to a real file by default. Stop the orchestrator before deleting or backing up the file — SQLite holds connections while running.
- Setting `TOAD_DB_PATH=:memory:` reverts to ephemeral mode if you want it back.

Verification during slice:

```powershell
node test/localToadRuntime.test.js
npm.cmd test
```

### 2. UI System Housekeeping Panel

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-system-housekeeping-panel.md`

Modified files:

- `ui/src/components/Dashboard.jsx` — derives `lastDrop` and `lastPrune` from the `events` array via `useMemo`; renders a new "System Housekeeping" panel between the top stats grid and Pending Approvals; adds a small `HousekeepingCell` helper plus a local `formatRelativeTime` utility.

Behavior:

- The panel shows two cells side by side: "Last restart cleanup" (from `side_effects_dropped_on_restart`) and "Last retention sweep" (from `side_effects_pruned`). Each cell shows the count and a relative timestamp (`Xs ago`, `Xm ago`, etc.).
- When the current SSE session has not received either event yet, each cell shows an empty state ("No orphans cleared this session", "No prune events this session").
- No backend changes — the events were already flowing on the SSE bus from the prior telemetry slice. The panel is a pure consumer.

Verification during slice:

```powershell
cd ui
npm.cmd run lint
npm.cmd run build
cd ..
npm.cmd test
```

### 2. Live Claude CLI Smoke Verified

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-live-claude-smoke.md`

Modified files:

- `test/claudeCliSmoke.test.js` — drop `--bare` from the spawned CLI args, with an inline comment explaining the rationale.

Diagnosis:

- All previous smoke runs hit `authentication_failed` and skipped. Claude was authenticated locally for *interactive* sessions, but the CLI's `--bare` flag forces a stripped-down headless mode whose auth path only accepts an Anthropic API key (or non-subscription OAuth) — not the Claude Code subscription OAuth that the user's machine uses.
- None of TOAD's production code uses `--bare`; it was a holdover the smoke had inherited from the legacy reference app. Dropping it makes the smoke match the actual auth flow.

Verification:

- Live run produced an `assistant_text` event containing `TOAD-SMOKE` and a `result.success` summary in ~15 seconds against `claude-opus-4-7`.
- Validates the full path: stream-json input encoding → CLI auth → assistant streaming → `ClaudeStreamJsonAdapter` normalization → harness assertion.

Quota note:

- Without `--bare`, the run consumes ~334k cache-creation tokens because the full plugin/skill system prompt loads. The CLI prints `total_cost_usd ≈ $2`, but that is an API-equivalent estimate and does not bill subscription users — it consumes plan quota instead.
- Run sparingly: only when validating against a new CLI version, after material adapter changes, or after long pauses in development.

Next-agent reminder:

- Do NOT reintroduce `--bare` to the smoke without first confirming the operator has an Anthropic API key. The subscription-OAuth path will silently skip with an auth-failure message.

### 2. Restart Housekeeping Telemetry

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-restart-housekeeping-telemetry.md`

Modified files:

- `src/app/LocalToadRuntime.js` — `start()` now emits `runtime_event`s on the existing event bus when housekeeping does work. Two new event types: `side_effects_dropped_on_restart` (after `replayPendingSideEffects()` if it dropped > 0) and `side_effects_pruned` (after `pruneSideEffectLog()` if it deleted > 0). No event when the count is zero.
- `test/localToadRuntime.test.js` — 3 new tests (now 18 total): drop event emitted with count, prune event emitted with count, no events on a clean log.

Behavior:

- Each event has shape `{ type, count, createdAt }`. They are system-level — no `runtimeId` / `teamId` / `agentId`.
- The `ApiServer` already relays the `runtime_event` channel to all SSE clients, so the dashboard automatically receives these without any further plumbing.
- Suppression on no-op keeps signal-to-noise high. A clean restart on a clean log is silent on the bus.

Verification during slice:

```powershell
node test/localToadRuntime.test.js
npm.cmd test
```

### 2. Side-Effect Log Retention

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-side-effect-log-retention.md`

Modified files:

- `src/delivery/sideEffectLog.js` — new `pruneOlderThan(cutoffDate)` method that deletes terminal (`'delivered'`/`'failed'`) rows where `COALESCE(delivered_at, created_at) < cutoff`. Returns the deleted count. Throws on invalid `Date`.
- `src/app/LocalToadRuntime.js` — new `sideEffectRetentionDays` constructor option (default 7, env `TOAD_SIDE_EFFECT_RETENTION_DAYS`); new `pruneSideEffectLog({ olderThan? })` method; `start()` now calls `pruneSideEffectLog()` immediately after `replayPendingSideEffects()` and before `apiServer.start()`.
- `test/sideEffectLog.test.js` — 5 new tests (now 12 total) covering delivered-old, failed-old (uses `created_at`), pending preservation, recent retention, invalid-date rejection.
- `test/localToadRuntime.test.js` — 4 new tests (now 15 total) covering retention-driven prune, explicit `olderThan` override, null-log no-op, and `start()` invoking prune.
- `README.md` — documents `TOAD_SIDE_EFFECT_RETENTION_DAYS`.

Behavior:

- `'pending'` rows are never deleted — they remain potentially replayable.
- `'delivered'` rows older than `now - retentionDays` are deleted using `delivered_at`.
- `'failed'` rows older than `now - retentionDays` are deleted using `created_at` (since `delivered_at` is `NULL` for failed rows). Worst case: a row that lingered as `'pending'` for hours before failing is treated as slightly older than reality, by exactly that lingering window — negligible against a multi-day retention default.
- Default retention: 7 days. Pruning is a one-shot per-`start()` sweep; no periodic timer.

Verification during slice:

```powershell
node test/sideEffectLog.test.js
node test/localToadRuntime.test.js
npm.cmd test
```

### 2. LocalToadRuntime Lifecycle Tests + SSE Shutdown Bug Fix

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-local-toad-runtime-lifecycle-tests.md`

Modified files:

- `src/app/LocalToadRuntime.js` — new `port` constructor option (defaults to `process.env.TOAD_API_PORT` or `3001`), threaded into the internal `ApiServer`.
- `src/transport/apiServer.js` — `stop()` now calls `server.closeAllConnections()` after `server.close(callback)`.
- `test/localToadRuntime.test.js` — 3 new tests (now 11 total): `start()` binds + serves a `POST /api/call`, `close()` disconnects pending SSE clients + unbinds the port (verified via re-binding probe), `close()` is safe to call when `start()` was never called.

Behavior / bug fix:

- Before this slice, `apiServer.stop()` would hang indefinitely if any SSE client was still connected — `server.close()` waits for keep-alive sockets to drain, and an SSE response keeps its socket open. The new lifecycle test exposed this; `closeAllConnections()` is the one-line fix.
- `close()` is now safe to call without `start()` (the underlying `server.close()` callback fires even when the server never bound).

Test pattern reminder for future SSE work:

- `http.IncomingMessage` is paused until something consumes it. To get `'close'` / `'end'` events to fire when the server destroys the socket, call `sseRes.resume()` or attach a `'data'` listener after receiving the response.

Verification during slice:

```powershell
node test/localToadRuntime.test.js
npm.cmd test
```

### 2. Origin-Restricted CORS

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-origin-restricted-cors.md`

Modified files:

- `src/transport/apiServer.js` — new `allowedOrigins` constructor option, `#resolveAllowedOrigin` helper, `#setCorsHeaders` echoes a specific origin instead of `*` (or omits ACAO entirely when the origin is not on the allow-list), `Vary: Origin` is set when an origin is echoed.
- `src/app/LocalToadRuntime.js` — parses `process.env.TOAD_API_ALLOWED_ORIGINS` (comma-separated or `*`) and forwards.
- `test/apiServer.test.js` — 4 new tests (now 18 total) covering allow-list echo, disallowed origin omission, default list (`localhost:5173` + `127.0.0.1:5173`), and `*` wildcard mode.
- `README.md` — documents `TOAD_API_ALLOWED_ORIGINS`.

Behavior:

- Default allow-list: `http://localhost:5173`, `http://127.0.0.1:5173` (Vite's default dev origins).
- Allowed origin in `Origin` header → response carries `Access-Control-Allow-Origin: <that exact origin>` + `Vary: Origin`.
- Disallowed origin → no ACAO is set; the request still processes but the browser refuses to expose the response to JS.
- No `Origin` header (curl, server-to-server) → no ACAO is set; non-browser clients ignore CORS, so behavior is preserved.
- `allowedOrigins: '*'` (or env `TOAD_API_ALLOWED_ORIGINS=*`) echoes whatever origin is sent, matching the legacy wildcard.

Verification during slice:

```powershell
node test/apiServer.test.js
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

### 2. API Token Protection

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-api-token-protection.md`

Modified files:

- `src/transport/apiServer.js` — new `token` constructor option, `#authenticate` / `#authenticateEvents` helpers using `crypto.timingSafeEqual`, `Authorization` added to CORS allowed headers, `/events` URL parser now tolerates query strings.
- `src/app/LocalToadRuntime.js` — passes `process.env.TOAD_API_TOKEN` to the `ApiServer`.
- `test/apiServer.test.js` — 5 new tests (now 14 total) covering missing/wrong/correct Bearer on `/api/call`, OPTIONS preflight pass-through, and `/events` auth via `?token=` query string.
- `ui/src/config/toadApi.js` — exports `TOAD_API_TOKEN`, `toadApiHeaders()`, and `toadEventsUrl()` helpers that read `VITE_TOAD_API_TOKEN`.
- `ui/src/hooks/useToadApi.js` — uses `toadApiHeaders()` instead of inline headers.
- `ui/src/hooks/useToadEvents.js` — uses `toadEventsUrl()` instead of the bare URL constant.
- `README.md` — documents `TOAD_API_TOKEN` and `VITE_TOAD_API_TOKEN`.

Behavior:

- When `TOAD_API_TOKEN` is unset, the API runs in the existing no-auth mode (current default, unchanged).
- When set, `POST /api/call` requires `Authorization: Bearer <token>`; missing or wrong → JSON `401`, no facade execution.
- `GET /events` requires the same token, accepted via either the `Authorization` header or the `?token=<token>` query string (the latter is needed because `EventSource` cannot send custom headers).
- OPTIONS preflight is unauthenticated and now advertises `Authorization` in `Access-Control-Allow-Headers`.
- Token comparison uses `crypto.timingSafeEqual` on equal-length buffers.

Verification during slice:

```powershell
node test/apiServer.test.js
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

### 2. Side-Effect Replay-on-Restart

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-side-effect-replay-on-restart.md`

Modified files:

- `src/app/LocalToadRuntime.js` — added `replayPendingSideEffects()` method; called from `start()` before binding the API server.
- `test/localToadRuntime.test.js` — 4 new tests covering the drop-on-restart contract.

Behavior:

- On `LocalToadRuntime.start()`, every `'pending'` row in `side_effect_deliveries` is marked `'failed'` (drop-on-restart policy for both `tool_result` and `compaction_reinjection` kinds).
- Already-`'delivered'` and already-`'failed'` rows are untouched.
- When `sideEffectLog` is `null` (no SQLite handle was available — e.g. when both `runtimeRegistry` and `eventLog` are stubs without `db`), the method is a no-op.
- Returns `{ dropped: number }` for caller observability.

Verification during slice:

```powershell
node test/localToadRuntime.test.js
npm.cmd test
```

### 2. Durable Side-Effect Delivery Receipts

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-side-effect-delivery-receipts.md`

New files:

- `src/delivery/sideEffectLog.js` — `SideEffectLog` class (markPending/markDelivered/markFailed/get/getPending) backed by a new `side_effect_deliveries` SQLite table.
- `test/sideEffectLog.test.js` — 7 isolated unit tests.

Modified files:

- `src/storage/schema.sql` — added `side_effect_deliveries` table.
- `src/runtime/RuntimeEventIngestor.js` — accepts optional `sideEffectLog`; `#sendToolResult` now writes a pending receipt, skips delivery when receipt is already `'delivered'`, marks delivered on success, marks failed and re-throws on adapter rejection.
- `src/runtime/CompactionHandler.js` — accepts optional `sideEffectLog`; writes a pending receipt on `compact_boundary`, marks delivered after a successful `sendTurn`, marks failed on adapter rejection or `turn_failed`.
- `src/app/LocalToadRuntime.js` — instantiates `SideEffectLog` from `runtimeRegistry.db ?? eventLog.db` and threads it into `CompactionHandler` and `RuntimeEventIngestor`.
- `package.json` — added `node --no-warnings test/sideEffectLog.test.js` to the test chain.
- `test/compactionHandler.test.js` — 4 new integration tests for the receipt lifecycle.
- `test/runtimeEventIngestor.test.js` — 3 new integration tests for tool-result receipt lifecycle (delivered, idempotent skip, failed-and-rethrow).

Behavior:

- `tool_result` deliveries are now durable. A duplicate `tool_use` ingest (same idempotency event hash) skips the adapter call once the prior call succeeded.
- Compaction reinjections write a pending receipt on `compact_boundary` and resolve to `delivered` or `failed` based on the `sendTurn` outcome. `turn_failed` also marks the receipt failed (strict drop policy, matching legacy).
- `getPending()` exists and is unit-tested but is not yet wired into a replay-on-restart flow — that is intentionally deferred to a follow-up slice.

Verification during slice:

```powershell
node test/sideEffectLog.test.js
node test/compactionHandler.test.js
node test/runtimeEventIngestor.test.js
npm.cmd test
```

### 2. API/UI Hardening

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-api-ui-hardening.md`

Spec file:

- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-api-ui-hardening-design.md`

Modified files:

- `src/transport/apiServer.js`
- `test/apiServer.test.js`
- `ui/src/config/toadApi.js`
- `ui/src/hooks/useToadApi.js`
- `ui/src/hooks/useToadEvents.js`
- `README.md`

Behavior:

- `/api/call` now returns JSON `400` for malformed JSON and invalid generic envelope shape before facade execution.
- `/api/call` now returns JSON `413` when a request body exceeds `maxBodyBytes` (default 1 MiB).
- Dashboard API/SSE URLs are derived from `VITE_TOAD_API_BASE_URL`, defaulting to `http://127.0.0.1:3001`.
- Existing hook APIs are unchanged.

Verification during slice:

```powershell
node test/apiServer.test.js
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

### 2. UI Cross-Team Chat

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-cross-team-chat.md`

Spec file:

- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-ui-cross-team-chat-design.md`

Modified files:

- `src/read/LocalReadModel.js`
- `src/commands/command-contract.js`
- `src/mcp/localToolDefinitions.js`
- `src/tools/localToolFacade.js`
- `test/localReadModel.test.js`
- `test/localToolFacade.test.js`
- `test/localMcpToolDefinitions.test.js`
- `ui/src/components/Dashboard.jsx`

Behavior:

- Added `LocalReadModel.listCrossTeamMessages({ teamId, limit })`.
- Projection filters `cross_team` and `cross_team_sent` rows, strips the cross-team prefix, and returns UI-ready inbound/outbound rows.
- Added read-only `cross_team_messages` command and MCP tool.
- Dashboard now shows a Cross-Team Chat panel with conversation list, selected thread, and compose form.
- Sending uses existing `cross_team_send` with a UI idempotency key and refreshes the panel.

Verification during slice:

```powershell
node test/localReadModel.test.js
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
cd ui
npm.cmd run lint
npm.cmd run build
```

### 2. UI Runtime Detail Drawer

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-runtime-detail-drawer.md`

Spec file:

- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-ui-runtime-detail-drawer-design.md`

Modified files:

- `src/commands/command-contract.js`
- `src/mcp/localToolDefinitions.js`
- `src/tools/localToolFacade.js`
- `test/localToolFacade.test.js`
- `test/localMcpToolDefinitions.test.js`
- `ui/src/components/Dashboard.jsx`

Behavior:

- Added read-only `runtime_events` command backed by `LocalReadModel.listRuntimeAudit({ teamId, runtimeId })`.
- Exposed `runtime_events` as a read-only MCP-shaped tool with optional `runtimeId`.
- Runtime cards now include a Details button.
- Details opens a right-side drawer with runtime identity, status, PID/provider fields, recent runtime events, tool calls, and runtime-scoped API retries.
- Drawer data refreshes through `/api/call`, fallback polling, and selected-runtime SSE updates.

Verification during slice:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
cd ui
npm.cmd run lint
npm.cmd run build
```

### 2. UI Approval Resolution

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-approval-resolution.md`

Spec file:

- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-ui-approval-resolution-design.md`

Modified files:

- `src/commands/command-contract.js`
- `src/mcp/localToolDefinitions.js`
- `src/tools/localToolFacade.js`
- `test/localToolFacade.test.js`
- `test/localMcpToolDefinitions.test.js`
- `ui/src/hooks/useToadApi.js`
- `ui/src/components/Dashboard.jsx`
- `scripts/dev-api-server.mjs`
- `package.json`
- `README.md`

Behavior:

- Added read-only `approval_list` command backed by `LocalReadModel.listApprovals({ teamId })`.
- Exposed `approval_list` as a read-only MCP-shaped tool with no idempotency key requirement.
- Dashboard fetches approvals through `/api/call`.
- Dashboard shows pending approvals with prompt, tool, agent, runtime, and input preview.
- Approve/Deny buttons call existing mutating `approval_respond` with stable UI idempotency keys.
- `useToadApi` now lifts `idempotencyKey` from args into the API request top level so mutating commands work through the HTTP bridge.
- Added `npm.cmd run api:dev` to start the local API bridge without shell-quoting an inline script.

Verification during slice:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
cd ui
npm.cmd run lint
npm.cmd run build
cd ..
npm.cmd run api:dev
```

### 2. UI Dashboard Integration

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-dashboard-integration.md`

Modified files:

- `src/transport/apiServer.js`
- `src/app/LocalToadRuntime.js`
- `ui/` directory

Behavior:

- Built an HTTP API zero-dependency bridge to expose the LocalToolFacade endpoints.
- Scaffolded a new Vite + React dashboard with modern aesthetics (glassmorphism, dark mode).
- Built `useToadEvents` for SSE and `useToadApi` for POST polling.
- Visualizes health, runtimes, tasks, and live streams.

### 2. Hardening Idempotent Approval Response Delivery

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-hardening-approval-delivery.md`

Modified files:

- `src/storage/schema.sql` — Added `approval_deliveries` table.
- `src/approval/sqliteApprovalBroker.js` — JOINs delivery data and adds `markApprovalDelivered`.
- `test/sqliteApprovalBroker.test.js` — Added delivery tracking assertions.
- `src/tools/localToolFacade.js` — Changed condition to check `approval.delivery` and mark it after adapter call.

Behavior:

- Replaced volatile memory guard (`previousApproval.status === 'pending'`) with a durable delivery receipt tracking mechanism.
- Provides exactly-once semantics for delivering approval responses to the runtime adapter, surviving local orchestration process restarts.

### 2. CLI Smoke Test Verification

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-cli-smoke-test.md`

Behavior:

- Ran the `smoke:claude` npm script.
- Originally verified that the `ClaudeStreamJsonAdapter` successfully executes the local Claude CLI in `--bare` mode and parses the `stream-json` payload up to the auth boundary (test correctly skipped with `authentication_failed`).
- The `--bare` flag was later removed in the live-smoke slice once we discovered it rejects subscription OAuth; see slice 1 (Live Claude CLI Smoke Verified) for the live end-to-end pass.

### 4. HTTP/SSE API Transport

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-http-event-transport.md`

Files:

- `src/transport/apiServer.js` - Built-in `http` SSE server plus `/api/call` bridge
- `test/apiServer.test.js` - 5 tests

Behavior:

- Wraps the `RuntimeEventBus` with a lightweight Server-Sent Events endpoint (`/events`).
- Routes `POST /api/call` into `LocalToolFacade`.
- Broadcasts `runtime_event`s to all connected UI clients.
- Implements keep-alive, disconnect handling, and CORS.

### 5. Team Configuration

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-team-config.md`

New files:

- `src/team/teamConfig.js` — `TeamConfig` and `TeamConfigRegistry` implementation
- `test/teamConfig.test.js` — 5 tests

Behavior:

- `TeamConfig` models a team with `teamId`, `lead` configuration, and `teammates` array.
- `TeamConfigRegistry` provides in-memory mapping and prevents duplicate `teamId` registrations.

### 6. Runtime Event Streaming

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-event-streaming.md`

New files:

- `src/runtime/RuntimeEventBus.js` — EventEmitter wrapper with subscribe/unsubscribe/dispose
- `test/runtimeEventBus.test.js` — 8 tests

Modified files:

- `src/runtime/RuntimeEventIngestor.js` — publishes every ingested event to `runtime_event` + type-specific channels
- `src/app/LocalToadRuntime.js` — creates and wires event bus, disposes on close

### 7. Cross-Team Delivery Integration

Modified files:

- `src/commands/command-contract.js` — added `CROSS_TEAM_SEND` command and mutating flag
- `src/tools/localToolFacade.js` — added `#crossTeamSend` handler with dual-write (incoming + sent-copy)
- `src/mcp/localToolDefinitions.js` — added `cross_team_send` MCP tool definition
- `test/localToolFacade.test.js` — 1 new integration test
- `test/localMcpToolDefinitions.test.js` — updated assertions for new tool

Behavior:

- `cross_team_send` uses `formatCrossTeamText` to encode metadata prefix.
- Writes incoming message to target team's broker inbox.
- Writes sent-copy to sender team's broker inbox.
- Requires `idempotencyKey` (mutating command).
- Returns `{ ok, messageId, targetTeamId, targetAgentId }`.

### 8. Cross-Team Message Protocol

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-cross-team-message-protocol.md`

New files:

- `src/protocol/crossTeam.js` — prefix format, parse, strip, source discriminators
- `test/crossTeam.test.js` — 12 tests

Behavior:

- `formatCrossTeamPrefix(from, chainDepth, meta?)` builds the XML-like metadata tag.
- `formatCrossTeamText(from, chainDepth, text, meta?)` builds prefix + body.
- `parseCrossTeamPrefix(text)` extracts from, chainDepth, conversationId, replyToConversationId.
- `stripCrossTeamPrefix(text)` removes the prefix for UI display.
- `CROSS_TEAM_SOURCE` and `CROSS_TEAM_SENT_SOURCE` constants for incoming/outgoing discrimination.

### 9. MCP Tool Exposure for Projections

Modified files:

- `src/commands/command-contract.js` — added `TOOL_ACTIVITY` and `HEALTH_STATUS` read-only commands
- `src/mcp/localToolDefinitions.js` — added MCP tool definitions for `tool_activity` and `health_status`
- `src/tools/localToolFacade.js` — added `readModel` dependency, `#toolActivity` and `#healthStatus` handlers
- `src/app/LocalToadRuntime.js` — reordered construction so readModel is created before toolFacade
- `test/localMcpToolDefinitions.test.js` — updated tool name list and read-only assertions

Behavior:

- `tool_activity` MCP tool returns `listToolCalls()` results for the actor's team, optionally filtered by runtimeId.
- `health_status` MCP tool returns api retry events plus a summary with `total`, `rateLimited`, `serverErrors` counts.
- Both are read-only (no idempotencyKey required).

### 10. Runtime Health Monitoring

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-health-monitoring.md`

Modified files:

- `src/read/LocalReadModel.js` — added `listApiRetries({ teamId, runtimeId? })`, `apiRetries` count in overview
- `src/app/LocalToadRuntime.js` — added `listApiRetries` delegate
- `test/localReadModel.test.js` — 5 new tests (12 total)

### 11. Tool-Call Audit Projection

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-tool-call-audit-projection.md`

Modified files:

- `src\read\LocalReadModel.js` — added `listToolCalls({ teamId, runtimeId? })`, added `toolCalls` count to `getTeamOverview`
- `src\app\LocalToadRuntime.js` — added `listToolCalls` delegate
- `test\localReadModel.test.js` — expanded fixtures, 4 new tests (7 total)

Behavior:

- `listToolCalls({ teamId, runtimeId? })` filters event log for `tool_use` events and projects them with: type, id, teamId, agentId, runtimeId, toolName, toolUseId, input, createdAt.
- `getTeamOverview` now includes `toolCalls` count.
- Gracefully returns empty when event log is unavailable.

### 12. Runtime Compaction Handling

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-compaction-handling.md`

New files:

- `src\runtime\CompactionHandler.js`
- `test\compactionHandler.test.js`

Modified files:

- `src\runtime\ClaudeStreamJsonAdapter.js` — compact_boundary metadata, api_retry normalization
- `src\runtime\RuntimeEventIngestor.js` — compactionHandler lifecycle dispatch
- `src\app\LocalToadRuntime.js` — CompactionHandler creation and injection
- `test\claudeStreamJsonAdapter.test.js` — 2 new tests

Behavior:

- `compact_boundary` events now include `trigger` and `preTokens` metadata.
- `api_retry` events are normalized with `attempt`, `maxRetries`, `errorStatus`, `error`, `errorMessage`, `retryDelayMs`.
- `CompactionHandler` tracks pending reinjection per runtimeId.
- On `turn_completed` after a compaction, injects a reinjection prompt via `adapter.sendTurn()` containing team identity, behavioral rules, and task board snapshot.
- On `turn_failed`, clears pending state without injecting (strict drop policy, matching legacy).
- Multiple compactions before idle produce a single reinjection.

### 13. Teammate Permission Request Ingestion

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-teammate-permission-request-ingestion.md`

New files:

- `src\runtime\parsePermissionRequest.js`
- `src\runtime\claudeSettingsWriter.js`
- `test\parsePermissionRequest.test.js`
- `test\claudeSettingsWriter.test.js`
- `test\teammatePermission.test.js`

Modified files:

- `src\tools\localToolFacade.js` — added `projectCwd` option, teammate permission response path
- `src\app\LocalToadRuntime.js` — added `projectCwd` constructor option

Behavior:

- `parsePermissionRequest(text)` parses teammate `permission_request` JSON payloads (validates `request_id`, `agent_id`, `tool_name`; preserves `permission_suggestions`).
- `applyPermissionSuggestions({ projectCwd, suggestions })` writes tool permission rules to `{projectCwd}/.claude/settings.local.json` using atomic temp+rename.
- `addRules` suggestions add tool names to `permissions.allow` (or `deny`).
- `setMode` suggestions are translated: `acceptEdits` → Edit/Write/NotebookEdit; `bypassPermissions` → broad tool list.
- `LocalToolFacade.#approvalRespond` detects teammate approvals (`metadata.source === 'teammate'`) and applies settings on approve; no file action on deny.
- Belt-and-suspenders `control_response` is also sent to the lead adapter when available.
- `LocalToadRuntime` passes `projectCwd` to the tool facade.

Legacy facts applied:

- `permission_response` to teammate inbox does NOT work.
- `control_response` via lead stdin does NOT match teammate `request_id`.
- The only working mechanism is mutating `.claude/settings.local.json`.

### 14. Durable SQLite Approval Broker

Files:

- `src\approval\inMemoryApprovalBroker.js`
- `src\approval\sqliteApprovalBroker.js`
- `src\storage\schema.sql`
- `test\approvalBroker.test.js`
- `test\sqliteApprovalBroker.test.js`

Behavior:

- Approval request records are durable.
- Approval responses are idempotent by response idempotency key.
- Approvals can be listed by team.
- Approval records carry `approvalId`, `teamId`, `agentId`, `runtimeId`, `prompt`, `metadata`, status/decision/reason/responded fields.

### 2. Approval Read Model

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-approval-read-model.md`

Files:

- `src\read\LocalReadModel.js`
- `src\app\LocalToadRuntime.js`
- `test\localReadModel.test.js`

Behavior:

- `LocalReadModel` accepts optional `approvalBroker`.
- Added `listApprovals({ teamId })`.
- `getTeamOverview({ teamId })` now includes:
  - `counts.approvals`
  - `counts.pendingApprovals`
  - `approvals`
  - `pendingApprovals`
- `LocalToadRuntime` passes its `approvalBroker` to the read model.

### 3. Runtime Approval Ingestion

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-approval-ingestion.md`

Files:

- `src\runtime\ClaudeStreamJsonAdapter.js`
- `src\runtime\RuntimeEventIngestor.js`
- `src\app\LocalToadRuntime.js`
- `test\claudeStreamJsonAdapter.test.js`
- `test\runtimeEventIngestor.test.js`
- `test\localToadRuntime.test.js`
- `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

Legacy finding:

- In legacy `TeamProvisioningService.ts`, lead Claude runtimes emit stream-json `control_request`.
- Relevant legacy shape:

```js
{
  type: 'control_request',
  request_id: 'approval-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Write',
    input: { file_path: 'README.md' },
  },
  session_id: 'session-1',
}
```

Implemented local behavior:

- `ClaudeStreamJsonAdapter` normalizes `control_request` with `request.subtype === 'can_use_tool'` into internal `approval_request`.
- Internal event shape includes:
  - `type: 'approval_request'`
  - `approvalId`
  - `prompt: "Approve <toolName>"`
  - `toolName`
  - `input`
  - runtime/team/agent/session fields
- Non-tool control requests remain audit-only `runtime_event`.
- `RuntimeEventIngestor` accepts `approvalBroker`.
- Ingesting `approval_request` validates runtime identity and calls `approvalBroker.requestApproval()`.
- `LocalToadRuntime` passes the existing approval broker into `RuntimeEventIngestor`.

### 4. Approval Response Delivery

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-approval-response-delivery.md`

Files:

- `src\runtime\ClaudeStreamJsonAdapter.js`
- `src\tools\localToolFacade.js`
- `src\app\LocalToadRuntime.js`
- `test\claudeStreamJsonAdapter.test.js`
- `test\localToolFacade.test.js`
- `test\localToadRuntime.test.js`
- `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

Legacy finding:

- The old app sends Claude control responses by writing this to stdin:

```js
{
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'allow', updatedInput: {} },
  },
}
```

For denial:

```js
{
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'deny', message: 'reason' },
  },
}
```

Implemented local behavior:

- `ClaudeStreamJsonAdapter.approve(input)` writes Claude `control_response` JSON lines to stdin.
- `decision: 'approved'` maps to `{ behavior: 'allow', updatedInput: {} }`.
- `decision: 'denied'` maps to `{ behavior: 'deny', message }`.
- Return shape:

```js
{
  accepted: true,
  responseState: 'approval_response_returned',
  receipt: { written: true, runtimeId, approvalId, decision },
}
```

- `LocalToolFacade` now accepts optional `adapters`.
- `approval_respond` still updates `approvalBroker.respondApproval()`.
- If the approval has a `runtimeId` and the adapter is live, it calls `adapter.approve()`.
- It includes `runtimeResponse` in the returned structured result when delivered.
- `LocalToadRuntime` passes the shared adapters map into `LocalToolFacade`.
- A guard checks previous approval status when possible. It only sends the runtime response when there was no previous approval lookup or the previous approval was still pending. This reduces duplicate control responses on idempotent replays.

## Current MCP Tools

See:

- `C:\Project-TOAD\toad-local\src\commands\command-contract.js`
- `C:\Project-TOAD\toad-local\src\mcp\localToolDefinitions.js`

Important supported commands:

- `message_send`
- `task_create`
- `task_update`
- `task_comment`
- `task_list`
- `review_request`
- `review_decide`
- `runtime_events`
- `agent_status`
- `approval_list`
- `approval_respond`
- `tool_activity`
- `health_status`
- `cross_team_messages`
- `cross_team_send`

Mutating tools require `idempotencyKey`.

## Current Runtime Event Support

`ClaudeStreamJsonAdapter` currently handles:

- `assistant` text -> `assistant_text`
- `assistant` tool_use blocks -> `tool_use`
- `result.success` -> `turn_completed`
- `result.error` -> `turn_failed`
- malformed line -> `parse_error`
- `system.compact_boundary` -> `compact_boundary`
- `system.api_retry` -> `api_retry`
- `control_request` with `can_use_tool` -> `approval_request`
- fallback -> `runtime_event`

`RuntimeEventIngestor` currently handles:

- `assistant_text`: appends broker reply to user
- `tool_use`: validates identity, dispatches allowlisted local tools, returns tool result to adapter
- `approval_request`: validates identity, persists approval through approval broker
- `compact_boundary`, `turn_completed`, `turn_failed`: dispatches compaction lifecycle when configured
- all events: publishes to `RuntimeEventBus` when configured
- everything else: audit-only event log

Allowlisted runtime tool names:

- `message_send`
- `task_create`
- `task_update`
- `task_comment`

## Known Gaps / Next Logical Work

The backend core is in good shape and the teammate permission slice is complete. Current practical next work is UI/product iteration and live smoke validation.

Completed backend parity highlights:

- Lead Claude approval loop: `control_request` -> durable approval -> `approval_respond` -> `control_response`.
- Teammate permission loop: `permission_request` parser, durable approval metadata, settings-file mutation via `permission_suggestions`, and defensive lead adapter response.
- Runtime compaction handling: compact boundary tracking and reinjection after turn completion.
- Runtime health projection: normalized `api_retry` events and `health_status` read tool.
- Tool-call projection: `tool_activity` read tool.
- Cross-team messaging: metadata prefix protocol plus dual-write broker integration.
- Runtime event bus and HTTP/SSE transport for UI.

Remaining gaps worth tracking:

1. Live authenticated Claude smoke
   - Run `claude /login`.
   - Then run `TOAD_CLAUDE_SMOKE=1 npm.cmd run smoke:claude`.
   - Current harness validates the CLI boundary but cannot prove a full live turn without auth/quota.

2. API hardening
   - Bearer-token gate is in place (opt-in via `TOAD_API_TOKEN` / `VITE_TOAD_API_TOKEN`). The server still binds to `127.0.0.1` only.
   - CORS is now origin-restricted (`TOAD_API_ALLOWED_ORIGINS`). Default is the Vite dev origins; `*` reproduces the legacy wildcard.
   - Lifecycle of `LocalToadRuntime.start()` / `close()` is now covered, including a real bug fix in `apiServer.stop()` that prevented clean shutdown when SSE clients were still connected.

3. Durable exactly-once gaps
   - Approval response adapter delivery has SQLite delivery receipts.
   - Tool-result delivery and compaction reinjection have SQLite delivery receipts (`side_effect_deliveries` table) wired through `RuntimeEventIngestor` and `CompactionHandler`.
   - Replay-on-restart now applies a drop policy on `LocalToadRuntime.start()` — `replayPendingSideEffects()` marks every pending row failed. Adapter-session-aware retry (the only alternative to drop) would require a much larger redesign and is intentionally not in scope.

## Other Future Slices

Anchored to the checklist's own priority order (full detail in `docs/CHECKLIST_GAP_MATRIX.md`):

1. **Role authority (§5 + §26) — NEXT.** Add `actor.role` (lead / architect / developer / reviewer / tester / human). Per-role allow-list checked in `LocalToolFacade.execute`. Self-review prevention (`actor.agentId !== task.review.requestedBy` for `review_decide`). Without this, the state machine's checklist rules like "developer cannot mark task done" and "tester cannot approve review" remain aspirational.
2. **Test artifacts + CI gates (§6 + §18).** Orchestrator-run validation commands stored as a structured `TestResult`. Failed tests block `merge_ready` transition. Biggest correctness gap between agent claims and system truth.
3. **Plan-before-code (§2).** New `task_plan_propose` / `task_plan_approve` MCP tools backed by `PLAN_PROPOSED` / `PLAN_APPROVED` events. Tied to the `ready → planned` transition.
4. **Diagnostics (§25).** `diagnostics_run` MCP tool returning `{ check, status: PASS/WARNING/FAIL, evidence, suggestedFix }[]`.
5. **Worktree enforcement (§8) → diff tracking (§7 finished) → merge workflow (§19).** Bigger lift because of git integration.
6. Smaller follow-ups: failure detection (§13), WIP limits (§9), dependency enforcement (§10), notifications, knowledge propagation.

Parked / out of scope now:

- **Subscription quota / plan-usage indicator** — user is investigating a reliable data source. `--print "/usage"` returns only an auth-status string in headless mode.
- **UI work** — parallel UI prototype is being built elsewhere; backend-only per project priorities.

Workflow reminders:

- Write a plan doc in `docs/superpowers/plans/` before touching code.
- TDD: failing test first, watch it fail, write minimal GREEN code, repeat.
- Keep changes local-only — no `git push`.
- Update `HANDOFF-NEXT-AGENT.md` and `TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md` after the slice lands.

## Important Design Takeaways From Reverse Engineering

Do not copy the legacy architecture directly.

Legacy risks documented in `TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`:

- Whole-array JSON file rewrites can lose inbox updates.
- File watchers became correctness paths.
- Lead delivery depended too much on prompt compliance.
- `TeamProvisioningService.ts` owns too many unrelated concerns.
- Plain text replies are ambiguous.
- Cross-team messaging was lead-inbox based.
- Permission approval path was split and brittle.
- Kanban/review projection could drift.

Local replacement direction:

- SQLite append-only writes with idempotency keys.
- Broker-level routing and delivery receipts.
- Runtime adapters only translate CLI/runtime protocol.
- Approval broker shared across lead and worker paths.
- Read model derives UI state.
- Supervisor owns lifecycle and liveness.

## Quick Orientation Commands

From `C:\Project-TOAD\toad-local`:

```powershell
rg -n "approval_request|control_request|control_response|permission_request" src test
rg -n "class LocalToadRuntime|class LocalToolFacade|class RuntimeEventIngestor|class ClaudeStreamJsonAdapter" src
npm.cmd test
```

Inspect local plans:

```powershell
Get-ChildItem docs\superpowers\plans | Sort-Object Name
```

Inspect reverse-engineering notes:

```powershell
rg -n "permission|control_request|approval|runtime adapter|watcher|relay" C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md C:\Project-TOAD\AGENT-COMMUNICATION-REVERSE-ENGINEERING-NOTES.md
```

## Files Most Recently Touched

- `C:\Project-TOAD\HANDOFF-NEXT-AGENT.md`
- `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-approval-read-model.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-approval-ingestion.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-approval-response-delivery.md`
- `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`
- `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
- `C:\Project-TOAD\toad-local\src\tools\localToolFacade.js`
- `C:\Project-TOAD\toad-local\src\app\LocalToadRuntime.js`
- `C:\Project-TOAD\toad-local\src\read\LocalReadModel.js`
- `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
- `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`
- `C:\Project-TOAD\toad-local\test\localToolFacade.test.js`
- `C:\Project-TOAD\toad-local\test\localReadModel.test.js`
- `C:\Project-TOAD\toad-local\test\localToadRuntime.test.js`
- `C:\Project-TOAD\toad-local\src\runtime\parsePermissionRequest.js`
- `C:\Project-TOAD\toad-local\src\runtime\claudeSettingsWriter.js`
- `C:\Project-TOAD\toad-local\test\parsePermissionRequest.test.js`
- `C:\Project-TOAD\toad-local\test\claudeSettingsWriter.test.js`
- `C:\Project-TOAD\toad-local\test\teammatePermission.test.js`
- `C:\Project-TOAD\toad-local\src\runtime\CompactionHandler.js`
- `C:\Project-TOAD\toad-local\test\compactionHandler.test.js`
- `C:\Project-TOAD\toad-local\package.json`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-dashboard-integration.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-approval-resolution.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-ui-approval-resolution-design.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-runtime-detail-drawer.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-ui-runtime-detail-drawer-design.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-cross-team-chat.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-ui-cross-team-chat-design.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-api-ui-hardening.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\specs\2026-04-30-api-ui-hardening-design.md`
- `C:\Project-TOAD\toad-local\README.md`
- `C:\Project-TOAD\toad-local\src\transport\apiServer.js`
- `C:\Project-TOAD\toad-local\test\apiServer.test.js`
- `C:\Project-TOAD\toad-local\ui\src\config\toadApi.js`
- `C:\Project-TOAD\toad-local\ui\src\hooks\useToadApi.js`
- `C:\Project-TOAD\toad-local\ui\src\hooks\useToadEvents.js`
- `C:\Project-TOAD\toad-local\src\commands\command-contract.js`
- `C:\Project-TOAD\toad-local\src\mcp\localToolDefinitions.js`
- `C:\Project-TOAD\toad-local\src\tools\localToolFacade.js`
- `C:\Project-TOAD\toad-local\src\read\LocalReadModel.js`
- `C:\Project-TOAD\toad-local\test\localReadModel.test.js`
- `C:\Project-TOAD\toad-local\test\localToolFacade.test.js`
- `C:\Project-TOAD\toad-local\test\localMcpToolDefinitions.test.js`
- `C:\Project-TOAD\toad-local\package.json`
- `C:\Project-TOAD\toad-local\scripts\dev-api-server.mjs`
- `C:\Project-TOAD\toad-local\ui\src\App.jsx`
- `C:\Project-TOAD\toad-local\ui\src\components\Dashboard.jsx`
- `C:\Project-TOAD\toad-local\ui\src\hooks\useToadApi.js`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-side-effect-delivery-receipts.md`
- `C:\Project-TOAD\toad-local\src\delivery\sideEffectLog.js`
- `C:\Project-TOAD\toad-local\src\storage\schema.sql`
- `C:\Project-TOAD\toad-local\src\runtime\CompactionHandler.js`
- `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
- `C:\Project-TOAD\toad-local\src\app\LocalToadRuntime.js`
- `C:\Project-TOAD\toad-local\test\sideEffectLog.test.js`
- `C:\Project-TOAD\toad-local\test\compactionHandler.test.js`
- `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`
- `C:\Project-TOAD\toad-local\package.json`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-side-effect-replay-on-restart.md`
- `C:\Project-TOAD\toad-local\test\localToadRuntime.test.js`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-api-token-protection.md`
- `C:\Project-TOAD\toad-local\src\transport\apiServer.js`
- `C:\Project-TOAD\toad-local\test\apiServer.test.js`
- `C:\Project-TOAD\toad-local\src\app\LocalToadRuntime.js`
- `C:\Project-TOAD\toad-local\ui\src\config\toadApi.js`
- `C:\Project-TOAD\toad-local\ui\src\hooks\useToadApi.js`
- `C:\Project-TOAD\toad-local\ui\src\hooks\useToadEvents.js`
- `C:\Project-TOAD\toad-local\README.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-origin-restricted-cors.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-local-toad-runtime-lifecycle-tests.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-side-effect-log-retention.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-restart-housekeeping-telemetry.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-live-claude-smoke.md`
- `C:\Project-TOAD\toad-local\test\claudeCliSmoke.test.js`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-ui-system-housekeeping-panel.md`
- `C:\Project-TOAD\toad-local\ui\src\components\Dashboard.jsx`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-persistent-storage-configuration.md`
- `C:\Project-TOAD\toad-local\src\storage\sqlite.js`
- `C:\Project-TOAD\toad-local\src\app\LocalToadRuntime.js`
- `C:\Project-TOAD\toad-local\scripts\dev-api-server.mjs`
- `C:\Project-TOAD\toad-local\.gitignore`
- `C:\Project-TOAD\toad-local\README.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-broker-taskboard-durability.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-vacuum-on-retention.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-api-token-on-disk.md`
- `C:\Project-TOAD\toad-local\src\runtime\resolveApiToken.js`
- `C:\Project-TOAD\toad-local\test\resolveApiToken.test.js`
- `C:\Project-TOAD\toad-local\scripts\generate-api-token.mjs`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-agent-launch-tool.md`
- `C:\Project-TOAD\toad-local\src\commands\command-contract.js`
- `C:\Project-TOAD\toad-local\src\mcp\localToolDefinitions.js`
- `C:\Project-TOAD\toad-local\src\tools\localToolFacade.js`
- `C:\Project-TOAD\toad-local\src\app\LocalToadRuntime.js`
- `C:\Project-TOAD\toad-local\test\localToolFacade.test.js`
- `C:\Project-TOAD\toad-local\test\localMcpToolDefinitions.test.js`
- `C:\Project-TOAD\toad-local\ui\src\components\Dashboard.jsx`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-agent-stop-tool.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-persistent-team-config.md`
- `C:\Project-TOAD\toad-local\src\team\teamConfig.js`
- `C:\Project-TOAD\toad-local\src\team\sqliteTeamConfigRegistry.js`
- `C:\Project-TOAD\toad-local\test\sqliteTeamConfigRegistry.test.js`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-team-launch-stop.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-send-input.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-review-with-diffs.md`
- `C:\Project-TOAD\toad-local\docs\AGENT_TEAMS_HARDENING_CHECKLIST.md`
- `C:\Project-TOAD\toad-local\docs\CHECKLIST_GAP_MATRIX.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-deterministic-state-machine.md`
- `C:\Project-TOAD\toad-local\src\task\taskLifecycle.js`
- `C:\Project-TOAD\toad-local\test\taskLifecycle.test.js`

## Suggested Opening Move For Next Agent

1. Read this file.
2. Read `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md` sections around Stage 4 and Current verification.
3. Run:

```powershell
cd C:\Project-TOAD\toad-local
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

4. Pick the next slice from the Other Future Slices section. Live Claude smoke or durable side-effect receipts are the recommended next slices.
5. Use TDD for backend changes.
