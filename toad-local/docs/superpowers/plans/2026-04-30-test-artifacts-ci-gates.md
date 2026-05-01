# Test Artifacts + CI Gates — Checklist §6 + §18

Slice: 2026-04-30
Status: complete

Maps to: **§6** (deterministic CI / test gates) and **§18** (test artifacts) of `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`. Per the gap matrix this is the biggest remaining correctness gap — today the orchestrator can't tell if tests actually passed, only what agents claim.

## Goal

Bring orchestrator-run validation into TOAD:

- Configure validation commands per team (install / lint / typecheck / test / build / security).
- Run them via a new `validation_run` MCP tool.
- Capture exit code, stdout/stderr, duration, timestamp, runner identity into a structured task event.
- Tighten the state machine so `testing → merge_ready` requires a **passing test verdict** in the task's validation history. Agent claims of "tests pass" no longer override orchestrator-run command results.

## Design

### Validation config on the team

`TeamConfig` gains an optional top-level `validation` object:

```ts
type TeamValidation = {
  installCommand?: string
  lintCommand?: string
  typecheckCommand?: string
  testCommand?: string
  buildCommand?: string
  securityCommand?: string
}
```

Persists with the team via the existing `team_create` upsert; reads via `team_list`. No schema change beyond extending the team's JSON blob.

### New task event type `task.validation_run`

Each invocation of `validation_run` appends:

```ts
type ValidationRunPayload = {
  kind: 'install' | 'lint' | 'typecheck' | 'test' | 'build' | 'security'
  command: string
  exitCode: number
  durationMs: number
  verdict: 'passed' | 'failed' | 'not_run'
  stdout: string       // truncated to ~4 KiB
  stderr: string       // truncated to ~4 KiB
  stdoutTruncated: boolean
  stderrTruncated: boolean
}
```

Truncation keeps the SQLite payload bounded; full logs for in-flight runs go to the runtime log directory. (Full-log file storage is a small follow-up — this slice keeps the inline-truncated form sufficient for the merge-ready gate.)

### Task projection

`projectTask` collects validation runs into `task.validations: ValidationRunPayload[]` (oldest → newest). Convenience field `task.latestValidation: { [kind]: ValidationRunPayload }` for the merge-ready gate to query without scanning.

### `validation_run` MCP tool

- Required: `taskId`, `kind`.
- Optional: `command` (override the configured command), `cwd` (override the team's cwd; defaults to the orchestrator's `projectCwd`).
- Mutating; requires `idempotencyKey`.
- Role allowlist: `lead`, `developer`, `tester`, `human`.

Execution flow:

1. Look up the team config and resolve the command from `kind` (or the explicit override).
2. If no command is configured **and** no override was provided → record a `not_run` event with `command: null` and return early. Per checklist §18: "‘Not run' must be explicit."
3. Else spawn the command via the injected `spawnSync` function (DI'd into the facade so tests don't shell out).
4. Capture exit code (verdict = `exitCode === 0 ? 'passed' : 'failed'`), stdout, stderr, duration.
5. Append the task event with the full payload.
6. Return the payload.

### State machine integration

A new transition guard inside `#taskUpdate`: when the requested move is `testing → merge_ready`, look up `task.latestValidation.test` and refuse the move unless the verdict is `passed`. Error message: `task_update: testing → merge_ready requires a passing test verdict (latest: failed)`.

The existing structural validation (`validateTaskStatusTransition`) runs first — this guard is layered on top, only triggers for the specific risky transition, and doesn't perturb other transitions.

### Why not require ALL kinds to pass?

The checklist says "failed command blocks merge_ready". A strict reading would require every configured kind (lint, typecheck, test, build, security) to have a recent passing run. That's a bigger design decision (what counts as "recent"? what if the team didn't configure `securityCommand`?) and is best deferred until after this slice proves the foundation. For now: only `kind: 'test'` blocks. Other kinds are recorded but not gates yet. A follow-up can expand.

## Changes

- `src/team/teamConfig.js` — `TeamConfig` constructor accepts and persists `validation`. Backward-compatible; missing → `null`.
- `src/task/inMemoryTaskBoard.js` — new `TASK_EVENT_TYPES.VALIDATION_RUN`. `projectTask` populates `task.validations[]` and `task.latestValidation` map.
- `src/commands/command-contract.js` — `VALIDATION_RUN = 'validation_run'`, in `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — `validation_run` tool def with required `taskId` + `kind` (enum).
- `src/tools/localToolFacade.js` — `#validationRun` handler. Accepts `spawnFn` injection for testability (defaults to a real `child_process.spawnSync`-based runner). Adds the `testing → merge_ready` guard inside `#taskUpdate`.
- `src/security/roleAuthority.js` — adds `validation_run` to `developer` and `tester` allowlists. (`lead` and `human` already wildcard.)
- `test/teamConfig.test.js` — extended for the validation field.
- `test/taskBoard.test.js` — extended for the new event type and projection.
- `test/localToolFacade.test.js` — new tests: validation_run records the event with full payload; not-configured kind records `not_run`; testing→merge_ready blocked without passing test; testing→merge_ready allowed with passing test.
- `test/roleAuthority.test.js` — extended assertions for validation_run.

## Verification

```powershell
node test/teamConfig.test.js
node test/taskBoard.test.js
node test/localToolFacade.test.js
node test/roleAuthority.test.js
npm.cmd test
```

All 30 backend test files pass.

## Out of scope (explicit follow-ups)

- **All-kinds gate.** Currently only `test` blocks `testing → merge_ready`. Future tightening: extend the gate to require recent passing runs for every configured kind.
- **Full-log file storage.** This slice truncates stdout/stderr to ~4 KiB inline. A follow-up can write full logs to `<projectCwd>/.toad/validation/<eventId>.{stdout,stderr}` and stash the path in the payload.
- **Live streaming of test output via SSE.** The runtime event bus already broadcasts; could add a `validation_chunk` event for the dashboard to show progress. Not load-bearing for the gate.
- **Background polling / scheduled re-runs.** §6 only requires that *failed runs* block merge_ready; it doesn't require continuous validation. Defer.
- **Security command interpretation.** TOAD just runs the command and reports the exit code; semantic interpretation of security-scan output is a separate concern.
