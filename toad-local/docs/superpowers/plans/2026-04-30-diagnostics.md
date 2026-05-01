# System Diagnostics — Checklist §25

Slice: 2026-04-30
Status: in progress

Maps to: **§25** of `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`. Reads from / probes the slices already in place (state machine §3, role authority §5/§26, CI gates §6/§18, plan-before-code §2) plus database + provider availability.

## Goal

Provide a single read-only command that answers "is the system genuinely safe vs. agent-claimed safe?" by re-running the enforcement checks the rest of the orchestrator depends on. Operators / architects / leads call this before launching a team to confirm:

- The state machine still rejects illegal transitions and accepts legal ones.
- Role authority still denies low-trust roles from privileged tools.
- Self-review and self-approval gates exist (smoke check via deny-path).
- Each registered team has validation commands wired (so CI gates can fire).
- The `claude` CLI is available and authenticated in the parent shell.
- The shared SQLite database is reachable through the registry layer.
- The database is persistent (not `:memory:`) — warning only, since tests use memory dbs.

Checks that depend on slices we have not built yet (§7 diff capture, §8 worktrees, §15 session→task wiring, §13 failure detection) are explicitly out of scope.

## Design

### New module — `src/diagnostics/runDiagnostics.js`

Pure function. Takes a `dependencies` object (so tests can inject fakes) and returns a structured report. No mutation, no event emission.

```js
runDiagnostics({
  teamConfigRegistry,    // .listTeams()
  spawnValidation,       // (cmd, { cwd }) → { exitCode, stdout, stderr, durationMs }
  dbPath = null,         // optional — informational only
}) → {
  checks: [
    { id, label, status: 'pass' | 'warning' | 'fail', evidence, suggestedFix? },
    ...
  ],
  summary: { pass, warning, fail }
}
```

### Check suite (initial set)

| id | what | pass criterion |
|---|---|---|
| `state_machine_invalid_transitions_rejected` | call `validateTaskStatusTransition({ from: 'done', to: 'in_progress' })` | `ok === false` |
| `state_machine_legal_transitions_allowed` | call `validateTaskStatusTransition({ from: 'ready', to: 'planned' })` | `ok === true` |
| `role_authority_denies_developer_agent_launch` | `assertRoleCanCallTool({ role: 'developer', toolName: 'agent_launch' })` | throws |
| `role_authority_unknown_role_denied` | `assertRoleCanCallTool({ role: 'phantom', toolName: 'task_list' })` | throws |
| `validation_commands_configured` | scan `teamConfigRegistry.listTeams()` | every team has a non-null `validation` (warning if zero teams configured at all) |
| `provider_claude_detected` | `spawnValidation('claude --version')` | `exitCode === 0` |
| `provider_claude_authenticated` | `spawnValidation('claude auth status --json')` (or fallback `--print "/login"`) | parses; reports user; warning on auth failure |
| `dbpath_persistent` | inspect `dbPath` | warning if `null` / `:memory:` / undefined |

### New command `COMMANDS.DIAGNOSTICS_RUN`

- Read-only — added to `COMMON_READ_TOOLS` in `roleAuthority.js` so every role can call it.
- Not in `MUTATING_COMMANDS` — no idempotency key required.
- New entry in `localToolDefinitions.js` so the MCP surface exposes it.

### Facade integration

`LocalToolFacade` gains a `#diagnosticsRun(actor, args)` handler that calls `runDiagnostics(...)` with the registry + spawn + dbPath the runtime injected at construction. Reuses the existing `spawnValidation` injection point (already used by validation runs).

### Wiring

`LocalToadRuntime` already passes `teamConfigRegistry` to the facade. Add `dbPath` (the SQLite filename) so the persistence check has something concrete to look at.

## TDD plan

One test file: `test/runDiagnostics.test.js`. RED before each GREEN.

1. State machine deny path returns `pass`.
2. State machine allow path returns `pass`.
3. Role authority deny path returns `pass`.
4. Validation-config check fails when a team has no validation, passes when all do, warns when registry is empty.
5. Provider-detected check passes on exit 0, fails on non-zero (injected spawn).
6. Provider-authenticated check passes on `loggedIn:true` JSON, warns otherwise (injected spawn).
7. `dbpath_persistent` warns on `:memory:` and on null, passes on a real filesystem path.
8. Summary tallies match per-check status.

Then a small facade test: `localToolFacade.test.js` confirms `diagnostics_run` dispatches and returns the structured report.

## Out of scope (future slices)

- §13 stuck/zombie detection — requires runtime registry + heartbeat semantics we do not yet enforce.
- §15 session→task pinning checks — depends on session-tracking slice.
- §7 diff capture and §8 worktree presence — depend on git integration.
- Notifications / alerts on `fail` (the operator decides what to do with the report).
