# TOAD Local Rebuild Handoff

Last updated: 2026-05-01 local session (slices A–F + Phase 1 + Phase 2 + Phase 3 UI + provider plan-auth)

**Push state**: 526 backend tests pass (was 504 at start of session). UI typecheck + production build green (405 kB JS / 108 kB gzipped, 71 modules). Committed and pushed.

Latest slice: provider plan-auth (§3c.2). Each provider in **Settings → Providers** has an "Auth method" segmented control — API key vs Plan/subscription. Plan auth shells out to the provider's CLI (`claude auth status --json` / `claude auth login` / `claude auth logout`) so users can use their Claude Pro/Max (and eventually ChatGPT Plus / OpenCode) subscription instead of pasting an API key. New module `src/providers/providerAuth.js`, three new MCP tools (`provider_auth_status` / `provider_auth_login` / `provider_auth_logout`), 12 module tests + 5 facade tests. Anthropic is fully wired; OpenAI/OpenCode return `{ supported: false }` placeholders until the user confirms which CLIs they have installed.

Phase 3 (settings + GitHub + risk-policy editor): full 8-tab Settings shell (`General` / `Providers` / `GitHub` / `Workspace` / `Risk policies` / `MCP servers` / `Notifications` / `Advanced`). Two-tier settings store at `%APPDATA%/toad/settings.json` (global) + `<projectCwd>/.toad/settings.json` (project override). New backend modules: `src/settings/settingsStore.js`, `src/policy/riskPolicyStore.js`, `src/github/githubAuth.js`. New MCP tools: `settings_get/set`, `github_device_start/poll/pat_verify/disconnect/status`, `risk_policy_get/set/preview`. UI hooks: `useSettings`, `useSectionDraft`. GitHub Device Flow + PAT fallback both work end-to-end. Risk-policy editor has a live-preview pane that runs the §14 classifier against sample files/commands.

Phase 2 (sidebar nav + lifecycle): slim 64px left sidebar (Workspace / Tasks / Runtimes / Approvals / Diagnostics / Settings), command palette (⌘K) with fuzzy search across all surfaces, focused TasksScreen with kanban+list toggle, TeamLaunchingScreen between team_create and running workspace, multi-project tab switcher in titlebar (localStorage-backed), per-task §14 risk badge with reasoning popover (TaskRiskBadge), review-feedback composer with severity tags (`review_decide` wired), task-creation form (`task_create` with full slice F schema).

Empty-state policy: live API + empty DB now shows "Create your first task" CTA per surface (TasksScreen / Workspace kanban / TasksSide right rail) instead of silently falling back to seed. Seed fallback only kicks in when API is unreachable (orange banner).

Phase-1 UI port (earlier in session, in parallel with Codex):

- Claude: `CreateTeamModal.tsx` (wires `team_create` + `team_launch`), `TaskDetailModal.tsx` + `task-detail/PlanSection.tsx` + `task-detail/DiffSection.tsx` + `task-detail/ValidationsSection.tsx` (wires `task_history_export` + `task_comment`), `ApprovalsDrawer.tsx` (wires `approval_respond` for tool-level + `task_human_approve` for §14 task-gate via `scope: 'task-gate'` switch).
- Codex: `TweaksPanel.tsx` (603 LOC + subcomponents `TweakSection` / `TweakRadio` / `TweakSelect` / `TweakToggle` / `TweakSlider` / `TweakText` / `TweakNumber` / `TweakColor` / `TweakButton` / `TweakRow`), `EmptyWorkspace.tsx`, `OnboardingScreen.tsx`, `ProjectPicker.tsx`, `ProvidersModal.tsx`, `NotificationsDrawer.tsx`, `RuntimeDrawer.tsx`, `DiagnosticsDrawer.tsx`.

App.tsx wires the lot:
- `tweaks.screen` switches between `workspace` / `empty` / `onboarding` / `picker` / `create` (modal) / `task` (modal). All five primary screens are reachable via the screen tweak (or via the new `Settings` titlebar button which opens TweaksPanel with screen + overlay toggles).
- `tweaks.show*` flags drive the five drawers / modals (`showProviders`, `showNotifs`, `showApprovals`, `showRuntimes`, `showDiagnostics`, `showTweaks`).
- App listens for legacy global events (`toad:open-runtimes`, `toad:open-providers`, `toad:open-notifs`) and toggles the corresponding tweaks so the existing in-component CustomEvent dispatchers from the design keep working.
- Titlebar got an Approvals button with a pending-count badge, a Diagnostics button, and the existing `Settings` icon now toggles the TweaksPanel.

Backend touchpoint added in this slice: `TEAM_MEMBER_SCHEMA` in `src/mcp/localToolDefinitions.js` now exposes `role` (enum of the six roles) and `skipPermissions` (bool) so the UI's CreateTeamModal can persist them through `team_create`. Schema test suite still 11/11.

UI verification: `npm run typecheck` clean, `npm run build` produces 309.76 kB JS / 84.61 kB gzipped (45 modules transformed). Vite dev serves all 8 Codex components + 3 Claude modals at HTTP 200. Backend full test suite 504/504 pass.

Phase 2 next (per `docs/superpowers/specs/2026-05-01-toad-ui-roadmap.md`): left navigation sidebar, command palette (⌘K), team-launching watch screen, multi-project tab switching, per-task risk badge popover, review-feedback composer with severity tags, task-history viewer, task-creation form, agent restart/kill controls, model-picker shared component.

Earlier in same session: ported the user's design drop into the React 18 + TypeScript + Vite shell at `toad-local/ui/`. Workspace screen, agent cards (3 variants), org chart, conv rail, tasks/runtimes side panel, agent inbox, titlebar — typed API client, SSE hook, projection-shaped data hook, seed-data fallback. ApiServer gained opt-in `staticDir` for single-process production hosting (`TOAD_UI_STATIC_DIR` env). Two new static-middleware tests including a path-traversal guard via raw socket.

Pre-existing flaky test fixed: `localToolFacade.test.js` "stuck_runtime_list returns the detector output" hardcoded 2026-05-01 timestamps but used wall-clock `now` — passed only inside a ~10-minute window. Made `args.now` overridable on the facade so the test pins `now: '2026-05-01T22:00:00.000Z'`.

Update from same session: shipped six slices in one go after the §14 risk-policy + human-approval gate landed.

- **A — Level-4 real-agent verification of §14**: Wrote `.toad/risk-policy.json`, launched a real Claude agent, watched it edit `.env.demo`, classifier auto-elevated `riskLevel: critical` + `requiresHumanApproval: true`, `merge_ready → done` was blocked with the right message, `task_human_approve` cleared the gate. Smoke verified end-to-end. ~$0.40.
- **B — §19 slice 2 merge integration**: New `src/task/mergeIntegrator.js`. Non-destructive `merge-tree --write-tree → commit-tree → update-ref` advances `baseBranch` without touching HEAD or the working directory. Optimistic-concurrency 4-arg form on `update-ref` handles races. New `INTEGRATION_MERGED` event + `task.integration` projection. 9 unit tests + 4 facade integration tests. §19 fully REAL.
- **C — §13 stuck/zombie runtime detector**: New `src/diagnostics/stuckRuntimeDetector.js` (pure). New `latestEventByRuntime` SQL aggregation on the event log. New `stuck_runtime_list` MCP tool (read-only, all roles) + new `runDiagnostics` check `stuck_runtimes_within_threshold`. 9 detector + 1 facade + 2 diagnostics tests.
- **D — §14 follow-up: command rules**: Risk policy now supports `commandRules` alongside `rules`. Classifier extracts Bash commands from `runtime_events` for the task and feeds them through alongside `payload.files`. Substring/prefix/suffix glob matching for command patterns. `matchedRules` entries now tagged `appliesTo: 'files' | 'commands'`. 5 new classifier tests + 1 facade integration test.
- **E — §17 review severity tags**: `review_decide` feedback items now accept optional `severity: 'nit'|'minor'|'major'|'blocking'`. Persisted on the projection. Unknown severities silently dropped (don't reject the whole review for a typo). MCP schema updated. 1 projection test.
- **F — §1 remaining task schema**: `priority` (`low|medium|high|urgent`), `assignedRole` (one of the six roles), `testCommands`, `expectedDeliverables`, `dependencyTaskIds` all on `task_create` + projection. Enums validated. §10 dependency enforcement is now unblocked. 2 projection tests + 1 facade enum test.

Full `npm.cmd test` passes (504 tests across 41 files, 0 fail; was 435 at slice start, +69 across slices A–F + UI/static-dir + flaky-stuck-runtime fix). UI typecheck + production build both green.

Prior: §14 promoted from PARTIAL to REAL (partial). The `.toad/risk-policy.json` config drives a pattern-based classifier (`src/policy/riskClassifier.js`) that runs at `review_request` time and may auto-elevate `task.riskLevel` and flip `requiresHumanApproval` via a new `RISK_CLASSIFIED` event. Plan doc: `docs/superpowers/plans/2026-05-01-risk-policy-human-approval-gate.md`.

Prior: Risk/file contract enforcement at `review_request` for `forbiddenFiles` / `allowedFiles` (hard rejection before `REVIEW_REQUESTED` appends).

Update from same session, next slice: Task schema/risk contract fields are now implemented locally. `task_create` accepts and persists `allowedFiles`, `forbiddenFiles`, `acceptanceCriteria`, `riskLevel` (`low|medium|high|critical`), and `requiresHumanApproval`. The task projection defaults old tasks to empty arrays, `riskLevel: null`, and `requiresHumanApproval: false`. The MCP `task_create` schema exposes the same fields. This is schema-only: no enforcement yet for forbidden files, allowed files, or human approval gates. Targeted tests pass (`taskBoard`, `localToolFacade`, `localMcpToolDefinitions`) and full `npm.cmd test` passes.

Update from same session: Option 2 (agent-side MCP tool surface) is implemented in `toad-local`. New Claude launches now get a generated `--mcp-config` pointing at `src/mcp/stdioServer.js`; that server opens the shared `TOAD_DB_PATH` / `TOAD_PROJECT_CWD` and receives `TOAD_TEAM_ID`, `TOAD_AGENT_ID`, `TOAD_AGENT_ROLE`, and optional `TOAD_TASK_ID`. Level-3 smoke confirmed a real Claude agent discovered `toad-local`, called `task_comment`, received the orchestrator response, and mutated live task state. Follow-up fix: generated Claude MCP launches now add `--dangerously-skip-permissions --permission-mode bypassPermissions` by default so MCP tool calls do not stop on Claude's `acceptEdits` permission gate; pass `skipPermissions: false` to opt out. Full real-agent file-edit smoke also passed: agent wrote `SMOKE.md`, committed it, called `validation_run`, called `review_request` without diff/files, TOAD computed the real diff, CI gate and merge gate fired, worktree was removed, branch preserved, and audit export joined 8 task events + 26 runtime events. `npm.cmd test` passes.

This file is the handoff point for a fresh agent with no chat context. The user wants to continue reverse engineering the alpha MCP/Twilio-style GitHub project and rebuilding our own local TOAD runtime. Work is local only. Do not push to git unless the user explicitly asks.

## Workspace

- Root: `C:\Project-TOAD`
- Main local rebuild: `C:\Project-TOAD\toad-local`
- Main reverse-engineering/rebuild doc: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- Legacy/original project under study: `C:\Project-TOAD\claude_agent_teams_ui-main\claude_agent_teams_ui-main`
- Important legacy file for many findings: `C:\Project-TOAD\claude_agent_teams_ui-main\claude_agent_teams_ui-main\src\main\services\team\TeamProvisioningService.ts`

There appears to be no git metadata in `C:\Project-TOAD\toad-local`; earlier `git status` failed there. Treat the workspace as local files.

## 2026-05-01 Re-evaluation â€” read this before adding more slices

After running an end-to-end smoke against a real Claude CLI (Level 1 = direct adapter, Level 2 = orchestrator-driven launch, Level 3 attempt = full lifecycle with real edits), the picture clarified. Three things to know before doing more work:

### What's actually solid

The orchestrator â€” every gate, projection, detector, and audit surface listed in `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md` â€” is real and tested:

- 416 backend tests, 0 fail, across 36 test files
- Real `git worktree add` / `--abort` / `remove --force` verified end-to-end
- Real `git diff baseRef..HEAD` capture verified â€” `task.review.diff` contains the actual unified diff
- Real merge conflict gate verified â€” `git merge --no-commit --no-ff` runs inside the worktree before `merge_ready â†’ done`
- Real Claude CLI streamed through `runtime_send_input` â†’ adapter â†’ ingestor â†’ `runtime_events` â†’ SSE (after the 2026-05-01 auto-consume fix; before that, real-agent events were silently dropped â€” see Â§11 in the gap matrix)
- Migration on existing `.toad/toad.db` runs cleanly (idempotent ALTER TABLE)
- Diagnostics surfaces real `claude auth status --json` fields (email, authMethod, subscriptionType)

### What's now real-agent verified

**The agent-side MCP tool surface is wired and working.** A launched Claude can run, accept input, emit output, discover TOAD's MCP server, and call tools like `task_comment` from inside its own tool loop. TOAD auto-writes a per-runtime `--mcp-config` and starts `src/mcp/stdioServer.js` against the live `TOAD_DB_PATH` / `TOAD_PROJECT_CWD`.

Level-3 smoke verified the full path twice. First, a direct MCP mutation: operator calls `agent_launch` with a pinned task; TOAD injects `--mcp-config` plus `--dangerously-skip-permissions --permission-mode bypassPermissions`; Claude discovers `toad-local`; the agent calls `mcp__toad-local__task_comment`; the stdio MCP server opens the same SQLite DB; `LocalToolFacade.execute(task_comment)` applies the same enforcement layer; `task_events` records `COMMENT_ADDED`; the api projection sees the new comment.

Second, a full file-edit lifecycle: the agent wrote `SMOKE.md`, committed it in the task worktree, called `mcp__toad-local__validation_run` and got a real passing test verdict, then called `mcp__toad-local__review_request` without supplying diff/files. TOAD computed `git diff baseRef..HEAD`, captured `review.files = ['SMOKE.md']`, `scopeDrift = []`, `noOpDiff = false`, and the full unified diff. Operator then drove `review -> testing -> merge_ready -> done`; the CI gate and merge gate fired on real data, `git worktree remove --force` ran, and the task history export joined 8 task events + 26 runtime events.

### How upstream `claude_agent_teams_ui-main` actually does this (2026-05-01 audit)

The reference upstream uses a different prompt/transport model than I assumed:

- Initial prompt is a **file** passed via `--team-bootstrap-user-prompt-file <path>`, not stdin.
- A bootstrap **JSON spec** is passed via `--team-bootstrap-spec <path>`.
- An MCP server is exposed via `--mcp-config <path>` so the agent has team-coordination tools.
- Teammate-to-teammate messaging uses **filesystem inboxes** (`inboxes/<member>.json`) that the CLI auto-monitors. Lead reads stdin only; teammates read inbox files.
- Worktree-per-task uses the CLI's built-in `--worktree <name>` flag (the CLI manages it, not the orchestrator).

Reference: [`claude_agent_teams_ui-main/src/main/services/team/TeamProvisioningService.ts`](claude_agent_teams_ui-main/claude_agent_teams_ui-main/src/main/services/team/TeamProvisioningService.ts) lines ~12960-12989 for the spawn args.

We have correctly diverged from upstream where the v2 hardening checklist demanded enforcement (state machine, gates, detectors). Upstream doesn't have most of those. Where we still need to align is the agent-tool-surface piece.

### Three options for what to do next

**Option 1 â€” document and pause.** Update gap matrix + HANDOFF (this slice). Don't add features. Decide direction with operator. **Cost: ~0 slices.** â† *we just did this.*

**Option 2 â€” agent-tool surface.** Done and real-agent verified. A launched Claude can call TOAD MCP tools, write/commit in a task worktree, run validation, request review, and drive the orchestrator's enforcement layer against real data.

**Option 3 â€” full upstream-style transport (significant).** Build the `--team-bootstrap-spec` JSON format, the bootstrap-user-prompt-file writer, and the inbox-file delivery model (filesystem watching, append-with-dedup, message-id sha256 generation, write locks for concurrent agents). Replace or parallel HTTP/SSE-based message delivery with filesystem-based. **Cost: â‰ˆ 5â€“10 slices.** Worth doing only if the operator decides matching upstream's mental model is a goal.

"Expensive" in Options 2/3 means engineering cost (slices of code + tests + edge cases), not Claude credits or money.

### Smoke test findings already fixed in commits this session

| Bug | Fix | Commit |
|---|---|---|
| `validation_run` ran spawn before idempotency check; retry returned fresh-spawn payload while persistence kept the cached event | Pre-flight `task.history` check, return cached payload if found | [`9125162`](https://github.com/kaydenraquel-crypto/T.O.A.D./commit/9125162) |
| `provider_claude_authenticated` reported `user: null` on success | Read `email` (with `user` fallback), surface `authMethod`/`apiProvider`/`subscriptionType` too | [`9125162`](https://github.com/kaydenraquel-crypto/T.O.A.D./commit/9125162) |
| `LocalToadRuntime.launchAgent` registered the adapter but never started `eventIngestor.ingestFrom(adapter.events())` â€” real-agent events silently dropped | Auto-consume on launch, errors logged + swallowed | [`aadac5e`](https://github.com/kaydenraquel-crypto/T.O.A.D./commit/aadac5e) |

### Smoke test findings not yet addressed

| Finding | Severity | Fix slice |
|---|---|---|
| Agent-side MCP tool surface | Verified real-agent path | Done. Security note: default `bypassPermissions` auto-approves all Claude tools, not only MCP; future tighter default could use `--allowedTools "mcp__toad-local__*"` if desired. |
| `claude` in a worktree containing the legacy `claude_agent_teams_ui-main/` mirror hits "Prompt is too long" because of CLAUDE.md auto-discovery / cwd file listing | Environmental (not a TOAD bug); only blocks live-agent-in-worktree smoke testing | Mitigations: pass `--setting-sources ""`, custom `--system-prompt`, prune the legacy mirror, or use a smaller baseRef when the worktree is created. None of these change TOAD code. |
| Windows `MAX_PATH` blocks worktree creation against this repo until `core.longpaths` is set | Environmental | Set globally â€” already done with operator authorization on 2026-05-01 |

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
- Last verified pass: 2026-04-30 â€” produced an `assistant_text: "TOAD-SMOKE"` event and `result.success` summary in ~15s against `claude-opus-4-7`.
- The harness uses `--print --verbose --input-format stream-json --output-format stream-json --no-session-persistence --tools ""` (no `--bare`).
- Do NOT add `--bare` without first confirming an Anthropic API key is set â€” `--bare` rejects the subscription OAuth that the user's machine uses and the harness will silently skip.

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

### -2. Risk/File Contract Enforcement -- Checklist Sections 1, 7, and 14

This slice turns the prior schema fields into an actual review gate. `review_request` now enforces the task's file contract whenever a concrete changed-file list is available.

Behavior:

- Files matching `task.forbiddenFiles` reject the review request.
- Files outside non-empty `task.allowedFiles` reject the review request.
- The gate runs for both caller-supplied `args.files` and orchestrator-computed `git diff baseRef..HEAD --name-only` files.
- Violations throw before `task.review_requested` is appended, so `task.review` remains `null` and the task does not enter a misleading active-review state.
- Empty `allowedFiles` / `forbiddenFiles` preserve backward compatibility.

Modified files:

- `src/tools/localToolFacade.js` -- added `enforceReviewFileContract()` and calls it inside `#reviewRequest` after file discovery and before scope-drift/no-op projection.
- `test/localToolFacade.test.js` -- four new tests: forbidden files block, allowed-file violations block, compliant files pass, computed diff files are enforced.
- `docs/superpowers/plans/2026-05-01-risk-file-contract-enforcement.md` -- slice plan.

Tests run: focused `node --test test\localToolFacade.test.js` passes. Full `npm.cmd test` also passes.

Next logical follow-up: add `risk-policy.json` / classifier semantics that can set or require `requiresHumanApproval` for high-risk paths and commands.

### -1. Task Schema / Risk Contract -- Checklist Sections 1 and 14 foundation

This slice adds the creation-time contract fields needed before TOAD can enforce file scope and risk policy. It is intentionally schema-only: the fields are recorded, projected, and exposed to agents through MCP, but not yet used to block review, merge, or launch.

New `task_create` fields:

- `allowedFiles: string[]`
- `forbiddenFiles: string[]`
- `acceptanceCriteria: string[]`
- `riskLevel: "low" | "medium" | "high" | "critical"`
- `requiresHumanApproval: boolean`

Projection defaults for older tasks:

- `allowedFiles: []`
- `forbiddenFiles: []`
- `acceptanceCriteria: []`
- `riskLevel: null`
- `requiresHumanApproval: false`

Modified files:

- `src/task/inMemoryTaskBoard.js` -- exports `TASK_RISK_LEVELS`, adds the fields to projected tasks, normalizes string arrays, and ignores invalid risk levels in raw event replay.
- `src/tools/localToolFacade.js` -- `#taskCreate` threads the fields into the CREATED event payload; direct facade calls reject unsupported `riskLevel` values.
- `src/mcp/localToolDefinitions.js` -- `task_create` schema exposes the new arrays, enum, and boolean.
- `test/taskBoard.test.js` -- projection capture/default tests.
- `test/localToolFacade.test.js` -- facade accept/reject tests.
- `test/localMcpToolDefinitions.test.js` -- MCP schema test.
- `docs/superpowers/plans/2026-05-01-task-schema-risk-contract.md` -- slice plan.

Tests run: targeted `node --test test\taskBoard.test.js`, `node --test test\localToolFacade.test.js`, and `node --test test\localMcpToolDefinitions.test.js` all pass. Full `npm.cmd test` also passes.

Next logical follow-up: enforce `forbiddenFiles` and optionally `allowedFiles` inside `review_request` after the orchestrator computes real diff/files. Then add risk-policy config that auto-flips `requiresHumanApproval` for high-risk paths or commands.

### 0. Task History Export â€” Checklist Â§20 (latest)

The audit trail was already comprehensive â€” events live in `task_events`, `runtime_events`, `messages`, `approval_requests`, `side_effect_deliveries`. This slice surfaces a single read tool that returns everything correlated to one task in one call. Now that Â§11 pins runtimes to tasks, the join lets us answer "show me everything ever done on task X."

New API surface:

```
task_history_export({ taskId }) â†’ {
  task: <full projection>,
  taskEvents: [<task_events for this task in chrono order>],
  runtimeEvents: [<runtime_events whose runtime is pinned to this task>]
}
```

Modified files:

- `src/commands/command-contract.js` â€” new `COMMANDS.TASK_HISTORY_EXPORT = 'task_history_export'` (read-only, no idempotency).
- `src/security/roleAuthority.js` â€” added to `COMMON_READ_TOOLS` so every role can call.
- `src/mcp/localToolDefinitions.js` â€” new tool def with `taskId` required.
- `src/runtime/sqliteRuntimeEventLog.js` â€” new `listEventsByTask({ teamId, taskId })`. SQL join: `runtime_events re JOIN runtime_instances ri ON re.runtime_id = ri.runtime_id WHERE re.team_id = ? AND ri.task_id = ?`. Returns chronological events.
- `src/tools/localToolFacade.js` â€” new `#taskHistoryExport(actor, args)`. Reads task projection, calls `taskBoard.listEvents({ teamId, taskId })`, calls `eventLog.listEventsByTask` if available (graceful no-op when no event log is configured).
- `test/sqliteRuntimeEventLog.test.js` â€” 2 new tests (now 3 total): join returns task-scoped events, empty list for unknown task.
- `test/localToolFacade.test.js` â€” 4 new tests (now 91 total): full export shape, empty runtimeEvents without eventLog, taskId required, every role can call.
- `test/localMcpToolDefinitions.test.js` â€” `task_history_export` added to expected tool name list.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§20 flipped to fully REAL.

Why this matters now:

- The Â§11 link finally pays off: runtimeEvents per task is meaningful only when runtime_instances.task_id is set. We landed Â§11 specifically so this query could exist.
- A future UI consumes this directly to render a per-task timeline. Markdown rendering is a UI-side concern; the orchestrator returns canonical JSON.
- An operator running `claude /export-task X` (or its UI equivalent) gets a single self-contained record they can paste into a postmortem, ticket, or PR description.

Tests pass: 36 backend test files, 412 individual tests, 0 fail.

### 1. Sessionâ†’Task Pinning â€” Checklist Â§11 slice 1

The data was already flowing â€” `agent_launch` accepts `taskId` (added in Â§8 slice 2 for cwd enforcement). This slice makes the link durable in the registry so audit/diagnostics can answer "which task is this runtime working on?" and "show me everything for task X".

Modified files:

- `src/storage/schema.sql` â€” `runtime_instances` gains `task_id TEXT` column (nullable; legacy/free-form runtimes have no task).
- `src/storage/sqlite.js` â€” `openToadDatabase` now calls `applyMigrations(db)` after the schema load. Soft migration runs `ALTER TABLE runtime_instances ADD COLUMN task_id TEXT` inside try/catch, swallowing the duplicate-column error. Cheap idempotent op on every open. Existing `.toad/toad.db` files get the column without losing data.
- `src/runtime/sqliteRuntimeRegistry.js` â€” `upsertRuntime` reads `input.taskId` (defaults to null), persists it, and the upsert ON CONFLICT branch now updates `task_id = excluded.task_id`. `#rowToRuntime` surfaces `taskId: row.task_id || null`.
- `src/runtime/RuntimeSupervisor.js` â€” supervisor record captures `input.taskId` at launch time, threads it into `#registerRunningRuntime â†’ upsertRuntime({ taskId })`.
- `test/sqliteRuntimeRegistry.test.js` â€” 3 new tests (now 6 total): persists taskId, null when omitted, listRuntimes surfaces taskId per row.
- `test/runtimeSupervisor.test.js` â€” 2 new tests (now 9 total): launchAgent threads taskId into registry, null-pass-through.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§11 flipped from PARTIAL to REAL (partial); model/logPath still to come.

Why this matters now (vs. waiting):

- Â§13 stuck-runtime detection wants to query "tasks with no recent runtime heartbeat" â€” needs the taskId pin.
- Audit completeness: a future `task_history_export` (Â§20) can join runtime_events + runtime_instances by task to surface every action ever taken on a task.
- Diagnostics Â§25: a future `runtime_pinned_to_task` check can verify the link is set whenever the task has a worktree.

Tests pass: 36 backend test files, 406 individual tests, 0 fail.

### 1. Explicit baseRef â€” Checklist Â§8 slice 4

The fourth and final Â§8 slice. Tasks can now anchor their worktree to a specific commit (and record an integration target branch name) at creation time, instead of relying on the HEAD-at-planning fallback. Â§8 is now fully REAL.

Modified files:

- `src/task/inMemoryTaskBoard.js` â€” initial task projection gains `baseRef: null`, `baseBranch: null`. CREATED handler captures both when present in payload.
- `src/tools/localToolFacade.js`:
  - `#taskCreate` accepts optional `args.baseRef` and `args.baseBranch`, threads them into the CREATED event payload.
  - `#triggerWorktreeCreation` re-reads the task projection to pick up `task.baseRef`, then forwards it as `createForTask({ baseRef })`. Undefined when the task didn't capture one (back-compat with HEAD-at-planning).
- `src/task/worktreeManager.js` â€” `createForTask({ teamId, taskId, baseRef })` accepts an explicit `baseRef`. When set, skips `git rev-parse HEAD`. When omitted, behaves exactly as before.
- `src/mcp/localToolDefinitions.js` â€” `task_create` MCP tool def gains `baseRef` and `baseBranch` properties with documentation noting their purpose.
- `test/taskBoard.test.js` â€” 2 new tests (now 17 total): baseRef + baseBranch captured on projection; null when not supplied.
- `test/worktreeManager.test.js` â€” 2 new tests (now 10 total): explicit override skips rev-parse HEAD, omission falls back to HEAD.
- `test/localToolFacade.test.js` â€” 3 new tests (now 87 total): task_create surfaces baseRef on projection, facade forwards it on planned trigger, undefined when omitted.

Why both `baseRef` and `baseBranch`:

- `baseRef` is a SHA â€” pins the worktree creation commit, stable against branch movement.
- `baseBranch` is a name â€” needed by Â§19 slice 2 (the actual integration commit). The merge target is "this branch", not "this SHA".
- Today's gates only use baseRef (worktree creation, diff computation, conflict check). baseBranch is captured but unused â€” it's already in the data so Â§19 slice 2 doesn't need a schema change.

Tests pass: 36 backend test files, 401 individual tests, 0 fail.

### 1. Repeated Test-Failure Detector â€” Checklist Â§13 partial

Third Â§13 detector, this one purely derived from existing data. After all events have been folded into the projection, count the trailing streak of test verdicts that came back `failed`. A passing run resets the count.

Modified files:

- `src/task/inMemoryTaskBoard.js`:
  - Initial task shape gains `consecutiveTestFailures: 0` and `repeatedTestFailures: false`.
  - After the event loop in `projectTask`, walk `task.validations` backward, counting trailing `failed` runs of `kind === 'test'`. Non-test runs (lint/typecheck/etc.) are skipped â€” they have their own verdicts. The threshold for `repeatedTestFailures = true` is 3.
- `test/taskBoard.test.js` â€” 4 new tests (now 15 total): three consecutive failures sets the flag, latest pass resets, trailing streak only counts after the most recent pass, non-test runs ignored.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§13 evidence rolled up; three detectors now live.

Cumulative Â§13 detectors:

| Detector | Field | Triggers when |
|---|---|---|
| Scope drift | `task.review.scopeDrift[]` | Changed file not in `task.plan.filesExpectedToChange` |
| No-op diff | `task.review.noOpDiff` | Orchestrator-computed diff has zero files |
| Repeated test failure | `task.repeatedTestFailures` | `task.consecutiveTestFailures >= 3` (trailing streak) |

All three are reviewer-informational. They surface signal; they don't block transitions. A future Â§14 risk-policy slice will let operators configure "if X detector trips, emit `task_blocked` and refuse `merge_ready`."

Tests pass: 36 backend test files, 394 individual tests, 0 fail.

### 1. No-Op Diff Detector â€” Checklist Â§13 partial

When the orchestrator successfully runs `git diff baseRef..HEAD` and finds zero changed files, the review now carries `task.review.noOpDiff = true`. This is the second Â§13 detector â€” same pattern as scope-drift: reviewer-informational, not transition-blocking. The agent might legitimately be done with a verify-only task (no code changes), but the reviewer should at least see the signal.

Modified files:

- `src/tools/localToolFacade.js` â€” `#reviewRequest` tracks `computedRan` (true when the diff computer returned a string, even an empty one). `payload.noOpDiff = computedRan && (no files in payload)`. Caller-supplied diff/files always set `noOpDiff = false` â€” we trust the caller.
- `src/task/inMemoryTaskBoard.js` â€” projection sets `task.review.noOpDiff = event.payload.noOpDiff === true` (defaults to `false` when missing).
- `test/localToolFacade.test.js` â€” 3 new tests (now 82 total): empty diff flagged, real changes leave it false, no-diff-computer-ran path leaves it false.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§13 evidence updated with the new detector.

The `task.review` projection now answers four reviewer questions in one place:
- *What did they say?* â†’ `summary`
- *What actually changed?* â†’ `diff` + `files` (orchestrator-computed via Â§7)
- *Did they edit outside the plan?* â†’ `scopeDrift` (Â§13 detector 1)
- *Did they actually do anything?* â†’ `noOpDiff` (Â§13 detector 2)

Tests pass: 36 backend test files, 390 individual tests, 0 fail.

### 1. Scope-Drift Detection â€” Checklist Â§13 partial

Now that we have both halves of the data â€” the **plan** says what files the developer agent intended to change (Â§2), and the **diff** records what files actually changed (Â§7) â€” the orchestrator can compare them and flag out-of-scope edits. This is the first Â§13 failure-detector slice.

Modified files:

- `src/tools/localToolFacade.js`:
  - `#reviewRequest`: after the diff/files are determined (caller-supplied or auto-computed), compare `payload.files` against `task.plan.filesExpectedToChange`. Anything not matched lands in `payload.scopeDrift`. Empty plan list = no flagging (no false positives â€” many tasks won't enumerate every file in advance).
  - New module-level `matchesAny(file, patterns)` helper. Supports exact paths, directory recursive (`src/parser/**`), and directory prefix (`src/parser/`). Pure, no glob library needed.
- `src/task/inMemoryTaskBoard.js` â€” projection picks up `scopeDrift` array from REVIEW_REQUESTED payload onto `task.review.scopeDrift`.
- `test/localToolFacade.test.js` â€” 4 new tests (now 79 total): drift detected, no-drift when in-scope, recursive `**` matching, no flagging when plan is empty.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§13 now has a "scope-drift detector (slice 1)" entry; still PARTIAL (more semantic detectors to come).

Why it's reviewer-informational, not transition-blocking (yet):

- Plans aren't always exhaustive. A developer who legitimately needs to touch a config file, README, etc. would be falsely blocked.
- The reviewer is the right gate for "is this drift acceptable?" â€” the orchestrator just surfaces the signal.
- A future slice can promote this to a `task_blocked` event when drift is unacceptable (e.g., when the plan also has `forbiddenFiles` and the drift intersects).

Tests pass: 36 backend test files, 387 individual tests, 0 fail.

### 1. Merge Conflict Gate â€” Checklist Â§19 slice 1

The `merge_ready â†’ done` transition now runs a non-destructive merge test inside the task's worktree before letting the transition through. If the task branch can't be merged cleanly into `baseRef`, the orchestrator blocks `done` with a list of conflicting files. This slice covers detection only â€” actually performing the integration commit on `baseBranch` is deferred to slice 2.

New files:

- `src/task/mergeChecker.js` â€” `checkForConflicts({ worktreePath, baseRef, runGit })`. Sequence:
  1. `git status --porcelain` â€” refuse if the worktree has uncommitted changes (the test wouldn't reflect what would happen at integration time).
  2. `git merge --no-commit --no-ff <baseRef>` inside the worktree.
  3. If exit 0 â†’ `git merge --abort` â†’ return `{ status: 'clean' }`.
  4. If exit non-zero â†’ `git diff --name-only --diff-filter=U` to capture conflicting files, then `git merge --abort` â†’ return `{ status: 'conflict', files }`.
  5. Various failure modes return `{ status: 'error', error }`.
- `test/mergeChecker.test.js` â€” 6 unit tests: clean path, conflict path with file list, dirty worktree refused, status command failed, input validation, cwd discipline.

Modified files:

- `src/tools/localToolFacade.js`:
  - Constructor accepts optional `mergeChecker` (must implement `checkForConflicts`).
  - `#taskUpdate`: between the existing plan gate and the STATUS_CHANGED append, when `fromStatus === 'merge_ready'` AND `args.status === 'done'` AND `current.worktree.status === 'created'` AND `this.mergeChecker` is set, runs the gate. Conflict throws `merge_ready â†’ done blocked by merge conflict in: <files>`. Error throws `merge_ready â†’ done blocked: <error message>`. Manager throwing is caught and treated as an error verdict (blocks transition).
- `src/app/LocalToadRuntime.js` â€” auto-instantiates `{ checkForConflicts }` adapter when `projectCwd` is set; null otherwise.
- `test/localToolFacade.test.js` â€” 4 new tests (now 75 total): clean allows transition, conflict blocks with file list in error, error verdict blocks, no-worktree-no-gate (back-compat).
- `package.json` â€” `mergeChecker.test.js` added to npm test chain.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§19 flipped from MISSING to REAL (partial).

Why detection-only first:

- Performing the actual integration on `baseBranch` is destructive (creates a merge commit on user's mainline). Two questions need answers before we automate that: (1) what's the `baseBranch` name? â€” we currently track `baseRef` (a SHA), not a branch name. (2) Should the orchestrator switch HEAD on the main repo, or use `git merge-tree --write-tree` to produce the merge tree without affecting HEAD? Both need real-world testing first. Detection-only is safe and immediately useful â€” operators can rely on `done` only landing when the merge is feasible.
- Symmetric: a clean merge in either direction (taskâ†’base or baseâ†’task) detects the same conflicts. Testing in the worktree (which is on the task branch) is the simplest setup.

Tests pass: 36 backend test files, 383 individual tests, 0 fail.

### 1. Diff Tracking â€” Checklist Â§7 finished

Now that worktrees exist (Â§8), the orchestrator can compute the real diff itself rather than trusting whatever the agent passes in. The `review_request` tool now auto-attaches `diff` + `files` from `git diff baseRef..HEAD` inside the task's worktree when the caller omits them.

New files:

- `src/task/diffComputer.js` â€” `computeDiff({ worktreePath, baseRef, runGit })`. Runs `git diff baseRef..HEAD --name-only` then `git diff baseRef..HEAD`, both with `cwd: worktreePath`. Returns `{ diff, files }` on success or `{ diff: null, files: [], error }` on failure. Best-effort â€” input validation returns errors rather than throwing.
- `test/diffComputer.test.js` â€” 6 unit tests: name-only + full diff, empty result, name-list failure, missing worktreePath, missing baseRef, blank-line filtering.

Modified files:

- `src/tools/localToolFacade.js`:
  - Constructor accepts optional `diffComputer` (defaults to `{ computeDiff: defaultComputeDiff }` from `diffComputer.js`).
  - `#reviewRequest`: when caller passes neither `diff` nor `files` AND the task projection shows `worktree.status === 'created'` with a `path` and `baseRef`, calls the diff computer and attaches the result. Caller-supplied diff always wins (operator override). Wraps the call in try/catch â€” a thrown computer is treated as an error result, transition still completes.
- `test/localToolFacade.test.js` â€” 4 new tests (now 71 total): auto-compute when caller omits both, caller override preserved, no auto-compute without worktree, best-effort tolerance of computer errors.
- `package.json` â€” `diffComputer.test.js` added to npm test chain.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§7 flipped from PARTIAL to REAL (partial). Out-of-scope file flagging deferred (depends on Â§1 `allowedFiles`).

Why orchestrator-computed:

- Trust boundary: the agent describes intent ("I changed parser.js to fix unicode"), the orchestrator describes reality ("here's the actual git diff"). They can disagree.
- Audit completeness: `task.review.diff` and `task.review.files` are now provably the real diff, not a self-report.
- Scope drift detection (Â§13 future): a future failure detector can compare `task.review.files` against `task.plan.filesExpectedToChange` and flag mismatches.

Tests pass: 35 backend test files, 373 individual tests, 0 fail.

### 1. Worktree per Task â€” Checklist Â§8, slice 3

Worktree cleanup half. When a task completes (`merge_ready â†’ done`), the orchestrator runs `git worktree remove --force` on the task's worktree. The branch (`toad/${teamId}/${taskId}`) is preserved so merge history stays reachable from the mainline ref. **`rejected` does NOT auto-remove** â€” the operator may want to triage WIP before deletion; a future manual cleanup tool will handle that case.

Modified files:

- `src/task/worktreeManager.js` â€” new `removeForTask({ teamId, taskId })`. Runs `git worktree remove --force <path>`. Returns `{ status: 'removed', path, removedAt }` on success or `{ status: 'skipped', reason: 'git_command_failed', stderr }` on failure.
- `src/task/inMemoryTaskBoard.js` â€” new `TASK_EVENT_TYPES.WORKTREE_REMOVED = 'task.worktree_removed'`. Projection updates `task.worktree.status` to `'removed'` while spreading the previous worktree fields so `branch`, `baseRef`, `path` survive removal in the audit trail.
- `src/tools/localToolFacade.js`:
  - `#taskUpdate` after STATUS_CHANGED: if status is `done` and the task has a `created` worktree, calls `#triggerWorktreeRemoval`.
  - `#triggerWorktreeRemoval`: best-effort sibling of `#triggerWorktreeCreation`. Wraps `manager.removeForTask` in try/catch; on throw, falls back to a `{ status: 'skipped', reason: 'manager_threw' }` event variant. Transition itself never blocks.
- `test/worktreeManager.test.js` â€” 3 new tests (now 8 total): success path with correct args, failure path with skip variant, input validation.
- `test/taskBoard.test.js` â€” 1 new projection test (now 11 total): WORKTREE_REMOVED preserves branch.
- `test/localToolFacade.test.js` â€” 3 new tests (now 67 total): removal triggers on done, no-removal on rejected, best-effort tolerance.

Tests pass: 34 backend test files, 363 individual tests, 0 fail.

### 1. Worktree per Task â€” Checklist Â§8, slice 2

No new plan doc â€” this is the cwd-enforcement half of the Â§8 plan written for slice 1.

When an `agent_launch` call carries a `taskId` and that task's projection shows `task.worktree.status === 'created'`, the facade now enforces that the runtime's cwd is the worktree path:

- caller omits `cwd` â†’ auto-set to `task.worktree.path`,
- caller passes a `cwd` that matches â†’ allow,
- caller passes a `cwd` that doesn't match â†’ throw `agent_launch: cwd <X> must match task worktree <Y> for task <Z>`,
- no `taskId` on the call OR task has no created worktree â†’ no enforcement (back-compat).

Modified files:

- `src/tools/localToolFacade.js` â€” `#agentLaunch` looks up the task, derives `wtPath`, and either auto-sets or validates `input.cwd`. `args.taskId` is also propagated into `input.taskId` so future slices (Â§11 sessionâ†’task pinning, Â§13 failure detector) can correlate runtimes to tasks via the launch input.
- `src/mcp/localToolDefinitions.js` â€” `agent_launch` tool def gains `taskId: { type: 'string', minLength: 1 }` and updated description noting the cwd enforcement behavior.
- `test/localToolFacade.test.js` â€” 5 new tests (now 64 total): auto-set, matching cwd accepted, conflicting cwd rejected, no-taskId unconstrained, taskId-without-worktree leaves cwd unchanged.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§8 evidence updated with slice 2 row.

Rationale: rogue or confused agents shouldn't be able to operate outside their task's isolated worktree. Hard error rather than silent override so the operator sees the contradiction and can fix the call site. Auto-set is the convenience path for honest callers who didn't track the worktree path themselves.

Tests pass: 34 backend test files, 356 individual tests, 0 fail.

### 1. Worktree per Task â€” Checklist Â§8, slice 1

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-05-01-worktree-per-task.md`

First slice of Â§8: when a task moves `ready â†’ planned`, the orchestrator creates an isolated git worktree on a task-scoped branch. Path scheme is deterministic: `${projectCwd}/.toad/worktrees/${teamId}/${taskId}` on branch `toad/${teamId}/${taskId}` from `HEAD` at planning time. Cwd enforcement, removal, and explicit `baseRef` come in slices 2/3/4.

New files:

- `src/git/runGit.js` â€” small synchronous wrapper around `spawnSync('git', args, { cwd })`. Returns `{ exitCode, stdout, stderr }` with stdout/stderr coerced to strings. Tests inject `spawn`. Production callers use the default. `exitCode === -1` when spawn itself throws.
- `src/task/worktreeManager.js` â€” `WorktreeManager.createForTask({ teamId, taskId })` runs the sequence: `rev-parse --is-inside-work-tree` â†’ `rev-parse HEAD` â†’ check path doesn't exist â†’ `worktree add -b <branch> <path> <baseRef>`. Returns `{ status: 'created' | 'skipped', ... }`. Skip reasons: `not_in_git_repo`, `path_exists`, `git_command_failed`. Tests inject `runGit` + `fsExistsSync`.
- `test/runGit.test.js` â€” 4 unit tests (forwarding, normalization, smoke real-git, spawn-throws path).
- `test/worktreeManager.test.js` â€” 5 unit tests covering all four skip/created branches plus path determinism.

Modified files:

- `src/task/inMemoryTaskBoard.js` â€” new `TASK_EVENT_TYPES.WORKTREE_CREATED = 'task.worktree_created'`. Projection captures `task.worktree = { status, path?, branch?, baseRef?, createdAt?, reason? }`. Created variant has the populated fields; skipped variant has `status` + `reason`.
- `src/tools/localToolFacade.js`:
  - Constructor accepts optional `worktreeManager` (must implement `createForTask`).
  - `#taskUpdate` after the `STATUS_CHANGED` event lands: when status is `planned` and there's no existing `created` worktree on the task, calls `#triggerWorktreeCreation`.
  - `#triggerWorktreeCreation`: best-effort. Wraps `manager.createForTask` in try/catch; on throw, falls back to a `{ status: 'skipped', reason: 'manager_threw', stderr }` event variant. The `task.worktree_created` event is appended either way (audit trail). The state transition itself never blocks on worktree errors.
- `src/app/LocalToadRuntime.js` â€” accepts optional `worktreeManager` constructor param. Auto-instantiates when `projectCwd` is set, leaves null otherwise (test-friendly default).
- `test/taskBoard.test.js` â€” 2 new projection tests (now 10 total).
- `test/localToolFacade.test.js` â€” 3 new integration tests (now 56 â†’ 59 total).
- `package.json` â€” added `runDiagnostics`, `runGit`, `worktreeManager` test files to the `npm test` chain (the diagnostics file had been silently missing since that slice).
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§8 flipped from MISSING to REAL (partial).

Key design decisions:

- **Best-effort on planned trigger**: a manager throw or failed git command does NOT block the state transition. Non-git workspaces stay usable; the audit event records why the worktree wasn't created.
- **Idempotent**: facade checks `task.worktree?.status === 'created'` before triggering, so a re-attempt at `ready â†’ planned` (e.g., after a rejected revision cycle) won't create duplicate worktrees.
- **HEAD-at-planning baseRef**: simplest possible. Slice 4 will add `task.baseRef` from operator at task creation (part of Â§1 schema).
- **Branch scheme `toad/${teamId}/${taskId}`**: git rejects `:` in branch names so this is filesystem-safe and team-scoped.

Tests pass: 34 backend test files, 351 individual tests, 0 fail.

### 1. tool_call_denied Event Emission â€” Checklist Â§26

No new plan doc â€” small follow-up that closes the audit half of Â§26.

Previously, `assertRoleCanCallTool` threw on denial and the error bubbled up to the API caller, but no record was kept in the event log. Now every denial emits a `tool_call_denied` runtime event before re-throwing.

Modified files:

- `src/tools/localToolFacade.js`:
  - Constructor accepts optional `eventLog` (anything with `appendEvent`).
  - `execute()` wraps `assertRoleCanCallTool` in try/catch; on denial, calls `#emitToolCallDenied(actor, commandName, err)` then re-throws.
  - `#emitToolCallDenied`: appends a `tool_call_denied` event with `runtimeId: 'facade:' + agentId`, payload `{ commandName, role, reason }`. Best-effort â€” wraps the append in its own try/catch so a broken event log can't mask the role-authority error the caller actually needs.
- `src/app/LocalToadRuntime.js` â€” passes `this.eventLog` (the SQLite runtime event log) into the facade.
- `test/localToolFacade.test.js` â€” 3 new tests (now 56 total): emits on denial, no-op on allowed call, best-effort tolerates broken event log.

Schema note: `runtime_events.runtime_id` is just a string (no FK), so synthesizing `facade:${agentId}` for facade-level audit events is safe. The team_id FK still requires the team row to exist; `SqliteRuntimeEventLog.appendEvent` already does `INSERT ... ON CONFLICT DO NOTHING` for the team.

Tests pass: 31 backend test files, 320 individual tests, 0 fail.

### 1. Per-Transition Role Guards â€” Checklist Â§3 Ã— Â§5 (previous)

No new plan doc â€” this slice is a small follow-up that was flagged as "future tightening" in the gap matrix entry for both Â§3 and Â§5.

Closes the seam between the state machine (Â§3) and role authority (Â§5/Â§26): the state-machine table previously said `merge_ready â†’ done` was a legal move, but had no way to express "only the lead should sign off the merge". This slice adds that.

Modified files:

- `src/task/taskLifecycle.js` â€” new `TRANSITION_ROLES` map. `validateTaskStatusTransition({ from, to, role })` now checks role against the allowlist when both `role` is provided AND a guard exists for `from->to`. Missing role bypasses the guard (back-compat with legacy call sites that don't tag `actor.role`, consistent with `roleAuthority.js`'s permissive default).
- `src/security/roleAuthority.js` â€” `task_update` added to architect's allowlist. Architect needs to drive task status changes for the unblock/recovery transitions the new guards reserve to architect/lead/human.
- `src/tools/localToolFacade.js` â€” `#taskUpdate` now passes `actor.role` into `validateTaskStatusTransition`. The role guard sits inside the existing transition-validation step; no new code path.
- `test/taskLifecycle.test.js` â€” 6 new tests (now 14 total): merge_readyâ†’done allowed for lead/human, denied for others; rejectedâ†’backlog allowed for architect/lead/human; blockedâ†’* allowed for architect/lead/human; unguarded transitions accept any role; missing role bypasses guards (back-compat); illegal moves still rejected even with privileged role.
- `test/localToolFacade.test.js` â€” 2 new tests (now 53 total): merge_readyâ†’done blocked for developer, allowed for lead; blockedâ†’in_progress blocked for developer/tester, allowed for architect.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§3 evidence updated; Â§5 flipped from REAL (partial) to REAL.

Guard table:

| Transition | Allowed roles |
|---|---|
| `merge_ready â†’ done` | lead, human |
| `rejected â†’ backlog` | architect, lead, human |
| `blocked â†’ ready` | architect, lead, human |
| `blocked â†’ planned` | architect, lead, human |
| `blocked â†’ in_progress` | architect, lead, human |
| (any other allowed transition) | any role with `task_update` in allowlist |

Tests pass: 31 backend test files, 317 individual tests, 0 fail.

### 1. Diagnostics â€” Checklist Â§25 (previous)

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-diagnostics.md`

Provides a single read-only command that re-runs the enforcement checks the orchestrator already depends on, so an operator can answer "is the system genuinely safe vs. agent-claimed safe?" before launching a team.

New files:

- `src/diagnostics/runDiagnostics.js` â€” pure function. Returns `{ checks: [{ id, label, status: 'pass'|'warning'|'fail', evidence, suggestedFix? }], summary: { pass, warning, fail } }`. Tests inject `spawnValidation` + `teamConfigRegistry`; the runtime injects real ones via the facade.
- `test/runDiagnostics.test.js` â€” 17 unit tests covering shape, every check, and summary tally.

Modified files:

- `src/commands/command-contract.js` â€” new `COMMANDS.DIAGNOSTICS_RUN` (read-only, not in `MUTATING_COMMANDS` so no idempotency key required).
- `src/security/roleAuthority.js` â€” `'diagnostics_run'` added to `COMMON_READ_TOOLS` so every role can call it.
- `src/mcp/localToolDefinitions.js` â€” new `diagnostics_run` tool def with empty schema.
- `src/tools/localToolFacade.js` â€” accepts `dbPath` constructor option; new `#diagnosticsRun()` handler invokes `runDiagnostics({ teamConfigRegistry, spawnValidation, dbPath })`.
- `src/app/LocalToadRuntime.js` â€” passes `dbPath` through to the facade so the persistence check has something concrete to look at.
- `test/localToolFacade.test.js` â€” 2 new tests (now 51 total): dispatch returns the structured report; every role can call.
- `test/localMcpToolDefinitions.test.js` â€” `diagnostics_run` added to expected tool name list.
- `docs/CHECKLIST_GAP_MATRIX.md` â€” Â§25 flipped from MISSING to REAL (partial).

Check suite (eight, all initial scope):

| id | what | pass criterion |
|---|---|---|
| `state_machine_invalid_transitions_rejected` | `validateTaskStatusTransition({ from: 'done', to: 'in_progress' })` | `ok === false` |
| `state_machine_legal_transitions_allowed` | `validateTaskStatusTransition({ from: 'ready', to: 'planned' })` | `ok === true` |
| `role_authority_denies_developer_agent_launch` | `assertRoleCanCallTool({ role: 'developer', toolName: 'agent_launch' })` | throws |
| `role_authority_unknown_role_denied` | `assertRoleCanCallTool({ role: 'phantom', toolName: 'task_list' })` | throws |
| `validation_commands_configured` | scan `teamConfigRegistry.listTeams()` | every team has non-null `validation` (warning if registry empty) |
| `provider_claude_detected` | `spawnValidation('claude --version')` | `exitCode === 0` |
| `provider_claude_authenticated` | `spawnValidation('claude auth status --json')` | parses JSON with `loggedIn:true` |
| `dbpath_persistent` | inspect `dbPath` | warning on `null`/`':memory:'`, pass on real path |

Out of scope (depend on slices not yet built):

- Â§13 stuck/zombie detector (needs runtime registry heartbeat semantics)
- Â§15 sessionâ†’task pinning probe (needs session-tracking slice)
- Â§7/Â§8 git/worktree presence (needs git integration)

Tests pass: 31 backend test files, 0 fail.

### 1. Plan-Before-Code â€” Checklist Â§2

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-plan-before-code.md`

Continues the v2 hardening pass. Builds on state machine (Â§3), role authority (Â§5/Â§26), and CI gates (Â§6/Â§18).

Modified files:

- `src/task/inMemoryTaskBoard.js` â€” three new `TASK_EVENT_TYPES.PLAN_*` constants. `projectTask` builds `task.plan` from `PLAN_PROPOSED` then merges `APPROVED`/`REJECTED` decisions. Re-proposal resets state to `proposed`.
- `src/commands/command-contract.js` â€” `TASK_PLAN_PROPOSE` / `TASK_PLAN_APPROVE` / `TASK_PLAN_REJECT`, all mutating.
- `src/mcp/localToolDefinitions.js` â€” three new tool defs. `task_plan_propose` accepts `summary`, `filesExpectedToChange`, `approach`, `risks`, `validationPlan`, `requiresApproval`.
- `src/tools/localToolFacade.js`:
  - New `#taskPlanPropose` and `#taskPlanDecide` handlers (the latter shared between approve and reject via a `decision` arg).
  - Self-approval prevention: throws when `actor.agentId === task.plan.proposedBy` for both approve and reject. Mirrors the self-review check on `review_decide`.
  - **Plan-before-code gate** in `#taskUpdate`: `ready â†’ planned` blocked unless `task.plan?.state === 'approved'`. Error names the current plan state.
- `src/security/roleAuthority.js` â€” `task_plan_propose` added to `developer` and `architect`; `task_plan_approve` and `task_plan_reject` added to `architect` only (lead + human are wildcard so they get all three for free). Reviewer + tester explicitly cannot approve/reject.
- `test/taskBoard.test.js` â€” projection test covering proposed â†’ rejected â†’ re-proposed â†’ approved cycle (now 8 tests).
- `test/localToolFacade.test.js` â€” 4 new tests (now 49 total): roundtrip propose+approve, self-approval rejected, readyâ†’planned blocked without plan, readyâ†’planned allowed once approved.
- `test/roleAuthority.test.js` â€” assertions for the three new tools across all six roles.
- `test/localMcpToolDefinitions.test.js` â€” three new tools added to expected names + mutating-tools assertion.

Behavior decisions:

- **Re-proposal resets state.** Once a plan is rejected, the developer can submit a revised plan; the projection drops `decidedBy`/`decidedAt` and the gate goes back to "needs approval". Matches the legacy "request changes â†’ revise" loop.
- **`planned â†’ in_progress` does not require a plan.** The gate sits at the `ready â†’ planned` boundary where the plan transitions from "approved" to "actively being worked". Adding a second gate at `planned â†’ in_progress` would just block work on tasks that the operator already approved.
- **`requiresApproval` field is recorded but not yet enforced.** Per the plan doc this is a follow-up gated on Â§14 risk policy.

Verification during slice:

```powershell
node test/taskBoard.test.js
node test/localToolFacade.test.js
node test/roleAuthority.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

All 30 backend test files pass.

### 2. Test Artifacts + CI Gates â€” Checklist Â§6 + Â§18

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-test-artifacts-ci-gates.md`

The biggest correctness gap remaining per the gap matrix. Today the orchestrator runs validation commands (not the agent), records the result as a structured task event, and blocks `testing â†’ merge_ready` when no passing test verdict exists. Agent claims of "tests pass" no longer override orchestrator-run results.

Modified files:

- `src/team/teamConfig.js` â€” `TeamConfig` accepts an optional `validation` field carrying `installCommand` / `lintCommand` / `typecheckCommand` / `testCommand` / `buildCommand` / `securityCommand`. Persists through `team_create` upsert and `team_list`. `SqliteTeamConfigRegistry.rowToConfig` re-hydrates it.
- `src/task/inMemoryTaskBoard.js` â€” new `TASK_EVENT_TYPES.VALIDATION_RUN`. `projectTask` now populates `task.validations[]` (oldest â†’ newest) and `task.latestValidation: { [kind]: payload }` for fast lookup.
- `src/commands/command-contract.js` â€” `VALIDATION_RUN = 'validation_run'`, mutating.
- `src/mcp/localToolDefinitions.js` â€” `validation_run` tool def with required `taskId` + `kind` (enum), optional `command` and `cwd` overrides.
- `src/tools/localToolFacade.js`:
  - New `spawnValidation` constructor injection (defaults to `child_process.spawnSync` with `shell: true`); tests pass a fake.
  - New `#validationRun` handler resolves the command from `team.validation[<kind>Command]` or the explicit override; if neither, records an explicit `not_run` event per checklist Â§18.
  - Captures exit code / stdout / stderr / durationMs. Truncates stdout/stderr to 4 KiB inline with `*Truncated` boolean flags.
  - Verdict: `exitCode === 0 ? 'passed' : 'failed'`; `not_run` when no command resolved.
  - **CI gate:** `#taskUpdate` blocks `testing â†’ merge_ready` when `task.latestValidation.test?.verdict !== 'passed'`. Error message names the latest verdict.
- `src/security/roleAuthority.js` â€” `validation_run` added to `developer` and `tester` allowlists (`lead` and `human` already wildcard).
- `test/teamConfig.test.js` â€” 2 new tests (validation persistence + null default).
- `test/taskBoard.test.js` â€” 1 new test (projection collects validations + latestValidation by kind).
- `test/localToolFacade.test.js` â€” 6 new tests: validation_run records the event with full payload; not-configured kind records `not_run`; failed exit code â†’ `failed` verdict; testing â†’ merge_ready blocked without a test run; allowed after passing run; blocked after failing run.
- `test/localMcpToolDefinitions.test.js` â€” `validation_run` added to expected names + mutating-tools assertion.
- `test/roleAuthority.test.js` â€” assertion that developer/tester can call validation_run; reviewer/architect cannot.

Behavior decisions:

- **Only `kind: 'test'` blocks `testing â†’ merge_ready`.** A strict reading of Â§6 would require ALL configured kinds (lint/typecheck/build/security) to pass. Deferred to a follow-up â€” needs design choices around what "recent" means and what to do when a team didn't configure `securityCommand`.
- **Inline truncation to 4 KiB.** SQLite handles large blobs but the projection is loaded into memory on every read. Truncation keeps the projection bounded; full-log file storage is a small follow-up (`<projectCwd>/.toad/validation/<eventId>.{stdout,stderr}`).
- **Synchronous spawn.** `validation_run` waits for the command to complete before returning. Streaming progress via SSE is a future ergonomic improvement, not a correctness gate.

Verification during slice:

```powershell
node test/teamConfig.test.js
node test/taskBoard.test.js
node test/localToolFacade.test.js
node test/roleAuthority.test.js
npm.cmd test
```

All 30 backend test files pass.

### 2. Role Authority â€” Checklist Â§5 + Â§26

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-role-authority.md`

Continues the v2 hardening pass per the gap matrix's priority order. Builds on the state machine slice â€” that one made transitions legal/illegal; this one makes WHO can do them depend on role.

New file:

- `src/security/roleAuthority.js` â€” exports `ROLE_TOOLS` (per-role allowlists; `lead` and `human` are wildcard `'*'`, the other four roles get explicit lists), `KNOWN_ROLES` set, and `assertRoleCanCallTool({ role, toolName })`. Throws sync on denied. Missing role defaults to `human` (full access) so the existing 29 test files keep passing without coordinated role-tagging.

Modified files:

- `src/tools/localToolFacade.js`:
  - `execute()` calls `assertRoleCanCallTool` after the idempotency check, before dispatch.
  - `normalizeActor()` preserves `actor.role` when present.
  - `#reviewDecide` adds **self-review prevention**: looks up the task and throws if `task.review?.requestedBy === actor.agentId`. Applies regardless of role per checklist Â§17 ("same agent cannot review own work").
- `test/roleAuthority.test.js` â€” NEW. 11 tests covering the six known roles, wildcard semantics for `lead`/`human`, explicit allowlists for the other four, missing-role default behavior, and unknown-role rejection.
- `test/localToolFacade.test.js` â€” 4 new tests: role denied (developer cannot agent_launch), role allowed (developer can task_update), self-review rejected, different-agent review accepted.
- `package.json` â€” adds `node test/roleAuthority.test.js` to the chain (now 30 test files).

Allowlist mapping (full table in plan doc):

- `lead` / `human` â€” `*` (full access).
- `architect` â€” task_create, cross_team_send, review_request, review_decide, plus the common read tools.
- `developer` â€” task_update, review_request, runtime_send_input, plus reads. **Cannot agent_launch / team_create / approval_respond / review_decide.**
- `reviewer` â€” review_decide plus reads. **Cannot review_request, agent_launch, task_update.**
- `tester` â€” task_update plus reads. **Cannot review_decide / agent_launch / team_create.**

Behavior decisions:

- **Permissive default for missing role.** All 29 prior test files use `actor: { teamId, agentId: 'operator' }` with no role and continue to pass. New code that wants enforcement passes `role` explicitly. A future tightening slice can flip the default once UI / agent prompts / smoke harness opt in.
- **Self-review applies even to `human`.** It is a hard rule per Â§17 â€” the agent that requested a review cannot also decide it, regardless of role.
- **Throws sync, before dispatch.** Matches the existing pattern (`unsupported command`, `idempotencyKey required`).

Verification during slice:

```powershell
node test/roleAuthority.test.js
node test/localToolFacade.test.js
npm.cmd test
```

All 30 backend test files pass.

### 2. Deterministic Task State Machine â€” Checklist Â§3

**Project priorities updated.** The user supplied `agent_teams_hardening_checklist_final_v2.md` as the target system standard. Copied to `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md` and audited at `docs/CHECKLIST_GAP_MATRIX.md`. Slice order is now anchored to the checklist's own priority: **state machine > tool authority > session tracking > diff tracking > CI gates > diagnostics**. UI work continues to be deferred per the user's earlier steering (parallel UI prototype is being built elsewhere).

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-deterministic-state-machine.md`

The single most important enforcement gap from the gap matrix. Closes Â§3.

New file:

- `src/task/taskLifecycle.js` â€” exports `TASK_LIFECYCLE` (the 10 states from the checklist), `ALLOWED_TRANSITIONS` (with legacy aliases for `pending`/`completed`/`deleted` so existing call sites keep working without a coordinated rewrite), and `validateTaskStatusTransition({ from, to })`. The validator returns `{ ok: true }` for legal moves and `{ ok: false, reason }` otherwise. Same-state self-transitions are idempotent. `from === null` (initial state) accepts any known status.

Modified files:

- `src/tools/localToolFacade.js` â€” `#taskUpdate` now reads the current task's status, calls `validateTaskStatusTransition`, throws on illegal transitions, and records `from` (previous status) and optional `reason` in the STATUS_CHANGED event payload (per checklist requirement: "every transition records actor, reason, timestamp, previous state, and next state").
- `package.json` â€” adds `node test/taskLifecycle.test.js` to the test chain (now 29 test files).
- `test/taskLifecycle.test.js` â€” NEW. 8 tests covering lifecycle constants, initial-state acceptance, idempotent self-transitions, the canonical 10-state happy path, illegal-transition rejection with reason strings, and legacy alias bridges.
- `test/localToolFacade.test.js` â€” 3 new tests (now 35 total): STATUS_CHANGED records `from`/`reason`; illegal transitions throw; legacy `pending â†’ in_progress â†’ completed` still works.

Behavior decisions:

- **Legacy aliases included in the table** (`pending`, `completed`, `deleted`) so the existing `taskBoard.test.js` happy path keeps passing. Future tightening (forbid `in_progress â†’ completed` shortcut, requiring `review â†’ testing â†’ merge_ready â†’ done`) is deferred until Â§6 CI gates land â€” at that point the role authority slice (Â§5) will know whether the actor is allowed to skip review.
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

Brings TOAD's review surface up to legacy parity for the **content** half of code review. The legacy `review.ts` has 18+ IPC handlers spanning git worktrees, file watchers, hunk-level reject, conflict detection â€” all explicitly deferred. This slice does the minimum viable subset: store diff text on the review request, surface it via a new read tool, and let the decision attach per-file feedback.

Modified files:

- `src/task/inMemoryTaskBoard.js` â€” `projectTask` populates a new `task.review` sub-object on `REVIEW_REQUESTED` (state, reviewerId, summary, diff, files, requestedBy, requestedAt) and merges into it on `REVIEW_DECIDED` (decision, reason, feedback, decidedBy, decidedAt). The existing `task.reviewState` enum is kept for backward compatibility; new consumers should prefer `task.review`.
- `src/commands/command-contract.js` â€” adds `REVIEW_LIST = 'review_list'` (read-only, NOT in `MUTATING_COMMANDS`).
- `src/mcp/localToolDefinitions.js` â€” extended `review_request` schema (`summary`, `diff`, `files`); extended `review_decide` schema (`feedback` as array of `{ file, comment }`); new `review_list` tool def (read-only).
- `src/tools/localToolFacade.js` â€” `#reviewRequest` and `#reviewDecide` propagate the new fields into event payloads (omitted when not provided so existing callers keep working); new `#reviewList` returns tasks where `task.review.state === 'requested'` for the actor's team.
- `test/taskBoard.test.js` â€” 2 new projection tests (now 5 total): diff/files/summary populated on REVIEW_REQUESTED; feedback merged on REVIEW_DECIDED while requested-side fields persist.
- `test/localToolFacade.test.js` â€” 3 new tests (now 32 total): review_request stores diff/files/summary; review_decide stores feedback; review_list returns only tasks with active reviews including the diff content.
- `test/localMcpToolDefinitions.test.js` â€” `review_list` added to expected names list and read-only tools assertion.

Behavior decisions:

- **No schema change.** Diff text and feedback live in `task_events.payload_json`. SQLite TEXT columns hold large diffs comfortably and the event-log replay surfaces them naturally.
- **`task.review` is a single sub-object** (not scattered fields). Cohesive shape, maps directly to the legacy app's review payload.
- **All new fields are optional** so existing callers (the agent-status tools, current task_list consumers) keep working unchanged. Empty/missing diff = "approve a task by ID" mode, which is what the prior implementation did.
- **Caller passes the diff text in.** TOAD has no git integration yet â€” the agent calling `review_request` runs `git diff` itself and attaches the output. Auto-generating diffs from a worktree is a separate slice.

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

- `src/commands/command-contract.js` â€” adds `RUNTIME_SEND_INPUT` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` â€” new tool def with required `runtimeId` + `text`.
- `src/tools/localToolFacade.js` â€” new `#runtimeSendInput` handler that looks up the adapter by `runtimeId` (using the existing `adapters` Map injection) and calls `adapter.sendTurn({ message: { text } })`.
- `test/localToolFacade.test.js` â€” 3 new tests (now 29 total): forwarding, missing-adapter rejection, sync idempotencyKey check.
- `test/localMcpToolDefinitions.test.js` â€” `runtime_send_input` added to expected names list and the mutating-tools assertion.

Behavior decisions:

- **Naming chosen as `runtime_send_input`**, not `team_process_send`. The legacy IPC name is Electron-specific and team-keyed. TOAD addresses runtimes by `runtimeId` directly, matching `runtime_events` / `tool_activity` / `agent_status` / `agent_launch` / `agent_stop`.
- **Idempotency key required but not used for dedup.** `adapter.sendTurn` is intentionally not idempotent. The key is the standard mutating-command requirement so the API/MCP layer's expectations stay consistent.
- **Replies flow back through normal runtime-event ingestion** as `assistant_text` â€” `runtime_send_input` does not synchronously wait for a response.

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

- `src/commands/command-contract.js` â€” adds `TEAM_LAUNCH` and `TEAM_STOP` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` â€” two new tool defs (`team_launch` requires `teamId`; `team_stop` requires `teamId`, optional `signal`).
- `src/tools/localToolFacade.js` â€” new `#teamLaunch` and `#teamStop` async handlers. The facade already had all needed injections (`teamConfigRegistry`, `launchAgent`, `stopAgent`, `runtimeRegistry`) from prior slices.
- `test/localToolFacade.test.js` â€” 6 new tests (now 26 total): launches every member with derived `runtime-<teamId>-<agentId>` IDs; throws on missing config; skips already-running members (idempotent re-launch); records per-member failures without aborting; team_stop stops only matching team's runtimes; team_stop is idempotent on no matches.
- `test/localMcpToolDefinitions.test.js` â€” `team_launch` / `team_stop` added to expected names and mutating-tools assertions.

Behavior decisions worth knowing:

- **Runtime ID derivation is `runtime-<teamId>-<agentId>`** â€” deterministic on purpose. Lets the "skip if already running" check work, lets `team_stop` find what `team_launch` started without separate bookkeeping, and gives operators a predictable runtime ID for the per-runtime tools.
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

First slice of the team-lifecycle decomposition. Foundation work: extend the team-config schema to include actual launch parameters, add a SQLite-backed registry, expose the three CRUD tools. The orchestration pair (`team_launch` / `team_stop`) is the next slice â€” kept separate because it adds new failure modes (partial-launch idempotency) that deserve their own design pass.

Modified files:

- `src/team/teamConfig.js` â€” `TeamConfig` member schema extended with `command`, `args`, `cwd`, `env`, `providerId`, `prompt` (plus a `toJSON()` for round-trip persistence). Backward-compatible defaults; the existing teamConfig.test.js cases keep working.
- `src/team/sqliteTeamConfigRegistry.js` â€” NEW. Mirrors the existing SqliteBroker / SqliteTaskBoard / SqliteApprovalBroker shape. `registerTeam` upserts on conflict (legacy parity â€” operators iterate without a delete-then-create dance). Adds `deleteTeam` + `close` beyond the in-memory registry's API.
- `src/storage/schema.sql` â€” new `team_configs(team_id, config_json, created_at, updated_at)` table.
- `src/commands/command-contract.js` â€” `TEAM_CREATE`, `TEAM_LIST`, `TEAM_DELETE`. Create + Delete are mutating.
- `src/mcp/localToolDefinitions.js` â€” three new tool defs plus a shared `TEAM_MEMBER_SCHEMA` constant.
- `src/tools/localToolFacade.js` â€” accepts `teamConfigRegistry`; routes the three commands through new `#teamCreate` / `#teamList` / `#teamDelete` handlers.
- `src/app/LocalToadRuntime.js` â€” constructs `SqliteTeamConfigRegistry({ filePath: dbPath })` by default; passes it to the facade and closes it on shutdown.
- `test/teamConfig.test.js` â€” 2 new tests (now 7 total) for the extended schema.
- `test/sqliteTeamConfigRegistry.test.js` â€” NEW with 7 tests including a persistence round-trip across two instances against the same dbPath.
- `test/localToolFacade.test.js` â€” 2 new tests (now 22 total) for the team-tool routing.
- `test/localMcpToolDefinitions.test.js` â€” three new tools added to the expected names list and the mutating/read-only assertions.
- `package.json` â€” adds `node test/sqliteTeamConfigRegistry.test.js` to the test chain (now 28 test files).

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

Mirrors the `agent_launch` slice exactly â€” backend-only, no UI surface this round (per the user's current backend-first focus; UI is being prototyped in parallel by another tool). Closes the runtime lifecycle pair so an operator can stop runtimes via `/api/call`, not just spawn them.

Modified files:

- `src/commands/command-contract.js` â€” adds `AGENT_STOP` to `COMMANDS` and `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` â€” new `agent_stop` tool definition with required `runtimeId`, optional `signal` enum (`SIGTERM` / `SIGINT` / `SIGKILL`).
- `src/tools/localToolFacade.js` â€” accepts a new `stopAgent` callback; routes `COMMANDS.AGENT_STOP` to a new `#agentStop` handler that unpacks `{ runtimeId, signal }` and forwards.
- `src/app/LocalToadRuntime.js` â€” passes `({ runtimeId, signal }) => this.stopAgent(runtimeId, signal ? { signal } : undefined)` to the facade so the runtime's `adapters.delete(runtimeId)` step still runs.
- `test/localToolFacade.test.js` â€” 3 new tests (forwarding with signal, missing-callback rejection, sync idempotencyKey requirement). 18 total.
- `test/localMcpToolDefinitions.test.js` â€” `agent_stop` added to expected names list and mutating-tools assertion.

All 27 backend test files green.

### 2. `agent_launch` MCP Tool + Dashboard Launcher

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-agent-launch-tool.md`

Modified files:

- `src/commands/command-contract.js` â€” adds `AGENT_LAUNCH = 'agent_launch'` to `COMMANDS` and to `MUTATING_COMMANDS` (idempotencyKey required).
- `src/mcp/localToolDefinitions.js` â€” adds the `agent_launch` tool definition with required `teamId/agentId/runtimeId/command` plus optional `args/cwd/env/providerId`.
- `src/tools/localToolFacade.js` â€” accepts a new `launchAgent` callback in its constructor; routes `COMMANDS.AGENT_LAUNCH` to a new async `#agentLaunch` handler that forwards args to that callback. Throws a clear "agent_launch is not configured" error when no callback is set.
- `src/app/LocalToadRuntime.js` â€” passes `(input) => this.launchAgent(input)` to the facade so the runtime's adapter-map setup is preserved (calling `supervisor.launchAgent` directly would skip that step).
- `test/localToolFacade.test.js` â€” 3 new tests (now 15 total): facade forwards args correctly, rejects when callback is missing, requires idempotencyKey.
- `test/localMcpToolDefinitions.test.js` â€” `agent_launch` added to the expected names list and the mutating-tools assertion.
- `ui/src/components/Dashboard.jsx` â€” new "Launch Agent" panel above System Housekeeping with five inputs (teamId, agentId, runtimeId, command, optional cwd) and a submit button. Calls `/api/call agent_launch` with a UI-generated idempotency key; surfaces success/error inline; clears the runtimeId field on success and triggers `fetchData()` so the new runtime appears in the Active Runtimes list.

Behavior:

- `agent_launch` is the first **mutating runtime-management** tool exposed via the API. Prior tools were either pure observers (`agent_status`, `runtime_events`) or affected stored state (`task_create`, `message_send`); this one literally spawns a process under the supervisor.
- The facade does NOT deduplicate by idempotency key â€” `launchAgent` itself is not idempotent (a duplicate `runtimeId` would hit a registry uniqueness constraint). The idempotency key is the standard mutating-command requirement; real launch-once semantics would be a separate slice.
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

- `src/runtime/resolveApiToken.js` â€” `resolveApiToken({ explicit, projectCwd })` with three-layer precedence: explicit DI > `process.env.TOAD_API_TOKEN` > `<projectCwd>/.toad/api-token` > null.
- `scripts/generate-api-token.mjs` â€” `crypto.randomBytes(32).toString('hex')`, writes to `<projectCwd>/.toad/api-token`, sets `0o600` on Unix, prints PowerShell- and bash-friendly export commands for the UI side.
- `test/resolveApiToken.test.js` â€” 5 unit tests covering all four precedence branches plus the "no projectCwd, file lookup skipped" case.

Modified files:

- `src/app/LocalToadRuntime.js` â€” new `apiToken` constructor option; `ApiServer` token now sourced from `resolveApiToken({ explicit: apiToken, projectCwd })`.
- `package.json` â€” adds `npm run token:generate`; adds the new test to the test chain (now 27 total).
- `README.md` â€” documents Option A (generate-and-persist, recommended) and Option B (per-shell env var).

Behavior:

- Default `LocalToadRuntime()` (no projectCwd) is unchanged â€” still falls through to env-or-null. Tests stay hermetic; no accidental disk reads.
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

- `src/app/LocalToadRuntime.js` â€” new `vacuumDatabase()` method that returns `{ vacuumed, reason, freelistBefore, freelistAfter }`; runs `VACUUM` on the registry/eventLog/approvalBroker SQLite connection (whichever is available). `start()` now invokes it after a non-zero `pruneSideEffectLog()` and emits a `database_vacuumed` `runtime_event`.
- `test/localToadRuntime.test.js` â€” 3 new tests (now 23 total): freelist_count drops to 0 after vacuum on a seeded-then-deleted real DB; in-memory dbPath returns `{ vacuumed: false, reason: 'in_memory' }`; `start()` emits `database_vacuumed` when prune did non-zero work.
- `ui/src/components/Dashboard.jsx` â€” System Housekeeping panel widened from 2 to 3 columns; new `VacuumCell` displays freelist pages reclaimed and relative time of the last vacuum.

Behavior:

- After `pruneSideEffectLog()` deletes rows, those pages move to SQLite's freelist but the file does not shrink. `VACUUM` reclaims them. Without this, a long-running install's `<projectCwd>/.toad/toad.db` grew monotonically.
- VACUUM only runs when prune actually deleted rows â€” clean restarts are silent.
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

- `src/app/LocalToadRuntime.js` â€” `broker` default switched from `InMemoryBroker` to `SqliteBroker({ filePath: dbPath })`; `taskBoard` default switched from `InMemoryTaskBoard` to `SqliteTaskBoard({ filePath: dbPath })`. All downstream `broker` / `taskBoard` references updated to use `this.broker` / `this.taskBoard` instead of the destructured params (which are now `null` when not provided). Imports updated to remove the in-memory variants.
- `test/localToadRuntime.test.js` â€” new persistence test (now 20 total): writes a message and a task event through one runtime, closes, opens a second runtime against the same `dbPath`, asserts both survive.
- `README.md` â€” note that all five storage surfaces (broker, taskBoard, approvalBroker, runtimeRegistry, eventLog) now persist when `dbPath` is a real file.

Behavior:

- `npm run api:dev` now persists messages and tasks across restarts â€” prior in-progress tasks, pending approvals, message history all visible to the next process.
- API parity verified: `SqliteBroker` and `SqliteTaskBoard` expose the exact methods downstream consumers call (`appendMessage`, `listInbox`, `listMessages`, `markRead` for the broker; `appendEvent`, `listEvents`, `getTask`, `listTasks` for the task board). Existing tests continue to pass against the new defaults â€” proves transitively that the swap preserves observable behavior.
- `LocalToadRuntime.close()` already iterates `taskBoard` and `broker` via `closeIfSupported` â€” SQLite connections close cleanly.

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

- `src/storage/sqlite.js` â€” `openToadDatabase` now `mkdirSync(parent, { recursive: true })` for non-`:memory:` paths so first-run doesn't fail on a missing directory.
- `src/app/LocalToadRuntime.js` â€” new `dbPath` constructor option (default `:memory:`); `runtimeRegistry`, `eventLog`, `approvalBroker` defaults are now constructed against `dbPath` (rather than each defaulting to its own `:memory:`); existing tests still pass because the default is unchanged.
- `src/app/LocalToadRuntime.js` â€” `close()` now also calls `closeIfSupported(this.approvalBroker)`. Without this, the approval broker's SQLite connection stayed open after `close()` returned; on Windows this prevented the file from being unlinked. Real bug, surfaced by the new persistence test.
- `scripts/dev-api-server.mjs` â€” sets `dbPath` to `<projectCwd>/.toad/toad.db` (overridable by `TOAD_DB_PATH`), prints the resolved path on startup so the operator can see where their data lives.
- `test/localToadRuntime.test.js` â€” new persistence test (now 19 total): writes an approval through one `LocalToadRuntime` against a temp `dbPath`, closes it, opens a second `LocalToadRuntime` against the same path, asserts the approval is visible. Exercises the auto-mkdir path with a nested directory.
- `.gitignore` (toad-local) â€” adds `.toad/` plus the existing api-dev log files.
- `README.md` â€” documents `TOAD_DB_PATH` and the default `<projectCwd>/.toad/toad.db` location.

Behavior:

- Constructor default stays `:memory:` so tests don't accidentally write to disk.
- `npm run api:dev` now writes to a real file by default. Stop the orchestrator before deleting or backing up the file â€” SQLite holds connections while running.
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

- `ui/src/components/Dashboard.jsx` â€” derives `lastDrop` and `lastPrune` from the `events` array via `useMemo`; renders a new "System Housekeeping" panel between the top stats grid and Pending Approvals; adds a small `HousekeepingCell` helper plus a local `formatRelativeTime` utility.

Behavior:

- The panel shows two cells side by side: "Last restart cleanup" (from `side_effects_dropped_on_restart`) and "Last retention sweep" (from `side_effects_pruned`). Each cell shows the count and a relative timestamp (`Xs ago`, `Xm ago`, etc.).
- When the current SSE session has not received either event yet, each cell shows an empty state ("No orphans cleared this session", "No prune events this session").
- No backend changes â€” the events were already flowing on the SSE bus from the prior telemetry slice. The panel is a pure consumer.

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

- `test/claudeCliSmoke.test.js` â€” drop `--bare` from the spawned CLI args, with an inline comment explaining the rationale.

Diagnosis:

- All previous smoke runs hit `authentication_failed` and skipped. Claude was authenticated locally for *interactive* sessions, but the CLI's `--bare` flag forces a stripped-down headless mode whose auth path only accepts an Anthropic API key (or non-subscription OAuth) â€” not the Claude Code subscription OAuth that the user's machine uses.
- None of TOAD's production code uses `--bare`; it was a holdover the smoke had inherited from the legacy reference app. Dropping it makes the smoke match the actual auth flow.

Verification:

- Live run produced an `assistant_text` event containing `TOAD-SMOKE` and a `result.success` summary in ~15 seconds against `claude-opus-4-7`.
- Validates the full path: stream-json input encoding â†’ CLI auth â†’ assistant streaming â†’ `ClaudeStreamJsonAdapter` normalization â†’ harness assertion.

Quota note:

- Without `--bare`, the run consumes ~334k cache-creation tokens because the full plugin/skill system prompt loads. The CLI prints `total_cost_usd â‰ˆ $2`, but that is an API-equivalent estimate and does not bill subscription users â€” it consumes plan quota instead.
- Run sparingly: only when validating against a new CLI version, after material adapter changes, or after long pauses in development.

Next-agent reminder:

- Do NOT reintroduce `--bare` to the smoke without first confirming the operator has an Anthropic API key. The subscription-OAuth path will silently skip with an auth-failure message.

### 2. Restart Housekeeping Telemetry

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-restart-housekeeping-telemetry.md`

Modified files:

- `src/app/LocalToadRuntime.js` â€” `start()` now emits `runtime_event`s on the existing event bus when housekeeping does work. Two new event types: `side_effects_dropped_on_restart` (after `replayPendingSideEffects()` if it dropped > 0) and `side_effects_pruned` (after `pruneSideEffectLog()` if it deleted > 0). No event when the count is zero.
- `test/localToadRuntime.test.js` â€” 3 new tests (now 18 total): drop event emitted with count, prune event emitted with count, no events on a clean log.

Behavior:

- Each event has shape `{ type, count, createdAt }`. They are system-level â€” no `runtimeId` / `teamId` / `agentId`.
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

- `src/delivery/sideEffectLog.js` â€” new `pruneOlderThan(cutoffDate)` method that deletes terminal (`'delivered'`/`'failed'`) rows where `COALESCE(delivered_at, created_at) < cutoff`. Returns the deleted count. Throws on invalid `Date`.
- `src/app/LocalToadRuntime.js` â€” new `sideEffectRetentionDays` constructor option (default 7, env `TOAD_SIDE_EFFECT_RETENTION_DAYS`); new `pruneSideEffectLog({ olderThan? })` method; `start()` now calls `pruneSideEffectLog()` immediately after `replayPendingSideEffects()` and before `apiServer.start()`.
- `test/sideEffectLog.test.js` â€” 5 new tests (now 12 total) covering delivered-old, failed-old (uses `created_at`), pending preservation, recent retention, invalid-date rejection.
- `test/localToadRuntime.test.js` â€” 4 new tests (now 15 total) covering retention-driven prune, explicit `olderThan` override, null-log no-op, and `start()` invoking prune.
- `README.md` â€” documents `TOAD_SIDE_EFFECT_RETENTION_DAYS`.

Behavior:

- `'pending'` rows are never deleted â€” they remain potentially replayable.
- `'delivered'` rows older than `now - retentionDays` are deleted using `delivered_at`.
- `'failed'` rows older than `now - retentionDays` are deleted using `created_at` (since `delivered_at` is `NULL` for failed rows). Worst case: a row that lingered as `'pending'` for hours before failing is treated as slightly older than reality, by exactly that lingering window â€” negligible against a multi-day retention default.
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

- `src/app/LocalToadRuntime.js` â€” new `port` constructor option (defaults to `process.env.TOAD_API_PORT` or `3001`), threaded into the internal `ApiServer`.
- `src/transport/apiServer.js` â€” `stop()` now calls `server.closeAllConnections()` after `server.close(callback)`.
- `test/localToadRuntime.test.js` â€” 3 new tests (now 11 total): `start()` binds + serves a `POST /api/call`, `close()` disconnects pending SSE clients + unbinds the port (verified via re-binding probe), `close()` is safe to call when `start()` was never called.

Behavior / bug fix:

- Before this slice, `apiServer.stop()` would hang indefinitely if any SSE client was still connected â€” `server.close()` waits for keep-alive sockets to drain, and an SSE response keeps its socket open. The new lifecycle test exposed this; `closeAllConnections()` is the one-line fix.
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

- `src/transport/apiServer.js` â€” new `allowedOrigins` constructor option, `#resolveAllowedOrigin` helper, `#setCorsHeaders` echoes a specific origin instead of `*` (or omits ACAO entirely when the origin is not on the allow-list), `Vary: Origin` is set when an origin is echoed.
- `src/app/LocalToadRuntime.js` â€” parses `process.env.TOAD_API_ALLOWED_ORIGINS` (comma-separated or `*`) and forwards.
- `test/apiServer.test.js` â€” 4 new tests (now 18 total) covering allow-list echo, disallowed origin omission, default list (`localhost:5173` + `127.0.0.1:5173`), and `*` wildcard mode.
- `README.md` â€” documents `TOAD_API_ALLOWED_ORIGINS`.

Behavior:

- Default allow-list: `http://localhost:5173`, `http://127.0.0.1:5173` (Vite's default dev origins).
- Allowed origin in `Origin` header â†’ response carries `Access-Control-Allow-Origin: <that exact origin>` + `Vary: Origin`.
- Disallowed origin â†’ no ACAO is set; the request still processes but the browser refuses to expose the response to JS.
- No `Origin` header (curl, server-to-server) â†’ no ACAO is set; non-browser clients ignore CORS, so behavior is preserved.
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

- `src/transport/apiServer.js` â€” new `token` constructor option, `#authenticate` / `#authenticateEvents` helpers using `crypto.timingSafeEqual`, `Authorization` added to CORS allowed headers, `/events` URL parser now tolerates query strings.
- `src/app/LocalToadRuntime.js` â€” passes `process.env.TOAD_API_TOKEN` to the `ApiServer`.
- `test/apiServer.test.js` â€” 5 new tests (now 14 total) covering missing/wrong/correct Bearer on `/api/call`, OPTIONS preflight pass-through, and `/events` auth via `?token=` query string.
- `ui/src/config/toadApi.js` â€” exports `TOAD_API_TOKEN`, `toadApiHeaders()`, and `toadEventsUrl()` helpers that read `VITE_TOAD_API_TOKEN`.
- `ui/src/hooks/useToadApi.js` â€” uses `toadApiHeaders()` instead of inline headers.
- `ui/src/hooks/useToadEvents.js` â€” uses `toadEventsUrl()` instead of the bare URL constant.
- `README.md` â€” documents `TOAD_API_TOKEN` and `VITE_TOAD_API_TOKEN`.

Behavior:

- When `TOAD_API_TOKEN` is unset, the API runs in the existing no-auth mode (current default, unchanged).
- When set, `POST /api/call` requires `Authorization: Bearer <token>`; missing or wrong â†’ JSON `401`, no facade execution.
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

- `src/app/LocalToadRuntime.js` â€” added `replayPendingSideEffects()` method; called from `start()` before binding the API server.
- `test/localToadRuntime.test.js` â€” 4 new tests covering the drop-on-restart contract.

Behavior:

- On `LocalToadRuntime.start()`, every `'pending'` row in `side_effect_deliveries` is marked `'failed'` (drop-on-restart policy for both `tool_result` and `compaction_reinjection` kinds).
- Already-`'delivered'` and already-`'failed'` rows are untouched.
- When `sideEffectLog` is `null` (no SQLite handle was available â€” e.g. when both `runtimeRegistry` and `eventLog` are stubs without `db`), the method is a no-op.
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

- `src/delivery/sideEffectLog.js` â€” `SideEffectLog` class (markPending/markDelivered/markFailed/get/getPending) backed by a new `side_effect_deliveries` SQLite table.
- `test/sideEffectLog.test.js` â€” 7 isolated unit tests.

Modified files:

- `src/storage/schema.sql` â€” added `side_effect_deliveries` table.
- `src/runtime/RuntimeEventIngestor.js` â€” accepts optional `sideEffectLog`; `#sendToolResult` now writes a pending receipt, skips delivery when receipt is already `'delivered'`, marks delivered on success, marks failed and re-throws on adapter rejection.
- `src/runtime/CompactionHandler.js` â€” accepts optional `sideEffectLog`; writes a pending receipt on `compact_boundary`, marks delivered after a successful `sendTurn`, marks failed on adapter rejection or `turn_failed`.
- `src/app/LocalToadRuntime.js` â€” instantiates `SideEffectLog` from `runtimeRegistry.db ?? eventLog.db` and threads it into `CompactionHandler` and `RuntimeEventIngestor`.
- `package.json` â€” added `node --no-warnings test/sideEffectLog.test.js` to the test chain.
- `test/compactionHandler.test.js` â€” 4 new integration tests for the receipt lifecycle.
- `test/runtimeEventIngestor.test.js` â€” 3 new integration tests for tool-result receipt lifecycle (delivered, idempotent skip, failed-and-rethrow).

Behavior:

- `tool_result` deliveries are now durable. A duplicate `tool_use` ingest (same idempotency event hash) skips the adapter call once the prior call succeeded.
- Compaction reinjections write a pending receipt on `compact_boundary` and resolve to `delivered` or `failed` based on the `sendTurn` outcome. `turn_failed` also marks the receipt failed (strict drop policy, matching legacy).
- `getPending()` exists and is unit-tested but is not yet wired into a replay-on-restart flow â€” that is intentionally deferred to a follow-up slice.

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

- `src/storage/schema.sql` â€” Added `approval_deliveries` table.
- `src/approval/sqliteApprovalBroker.js` â€” JOINs delivery data and adds `markApprovalDelivered`.
- `test/sqliteApprovalBroker.test.js` â€” Added delivery tracking assertions.
- `src/tools/localToolFacade.js` â€” Changed condition to check `approval.delivery` and mark it after adapter call.

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

- `src/team/teamConfig.js` â€” `TeamConfig` and `TeamConfigRegistry` implementation
- `test/teamConfig.test.js` â€” 5 tests

Behavior:

- `TeamConfig` models a team with `teamId`, `lead` configuration, and `teammates` array.
- `TeamConfigRegistry` provides in-memory mapping and prevents duplicate `teamId` registrations.

### 6. Runtime Event Streaming

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-event-streaming.md`

New files:

- `src/runtime/RuntimeEventBus.js` â€” EventEmitter wrapper with subscribe/unsubscribe/dispose
- `test/runtimeEventBus.test.js` â€” 8 tests

Modified files:

- `src/runtime/RuntimeEventIngestor.js` â€” publishes every ingested event to `runtime_event` + type-specific channels
- `src/app/LocalToadRuntime.js` â€” creates and wires event bus, disposes on close

### 7. Cross-Team Delivery Integration

Modified files:

- `src/commands/command-contract.js` â€” added `CROSS_TEAM_SEND` command and mutating flag
- `src/tools/localToolFacade.js` â€” added `#crossTeamSend` handler with dual-write (incoming + sent-copy)
- `src/mcp/localToolDefinitions.js` â€” added `cross_team_send` MCP tool definition
- `test/localToolFacade.test.js` â€” 1 new integration test
- `test/localMcpToolDefinitions.test.js` â€” updated assertions for new tool

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

- `src/protocol/crossTeam.js` â€” prefix format, parse, strip, source discriminators
- `test/crossTeam.test.js` â€” 12 tests

Behavior:

- `formatCrossTeamPrefix(from, chainDepth, meta?)` builds the XML-like metadata tag.
- `formatCrossTeamText(from, chainDepth, text, meta?)` builds prefix + body.
- `parseCrossTeamPrefix(text)` extracts from, chainDepth, conversationId, replyToConversationId.
- `stripCrossTeamPrefix(text)` removes the prefix for UI display.
- `CROSS_TEAM_SOURCE` and `CROSS_TEAM_SENT_SOURCE` constants for incoming/outgoing discrimination.

### 9. MCP Tool Exposure for Projections

Modified files:

- `src/commands/command-contract.js` â€” added `TOOL_ACTIVITY` and `HEALTH_STATUS` read-only commands
- `src/mcp/localToolDefinitions.js` â€” added MCP tool definitions for `tool_activity` and `health_status`
- `src/tools/localToolFacade.js` â€” added `readModel` dependency, `#toolActivity` and `#healthStatus` handlers
- `src/app/LocalToadRuntime.js` â€” reordered construction so readModel is created before toolFacade
- `test/localMcpToolDefinitions.test.js` â€” updated tool name list and read-only assertions

Behavior:

- `tool_activity` MCP tool returns `listToolCalls()` results for the actor's team, optionally filtered by runtimeId.
- `health_status` MCP tool returns api retry events plus a summary with `total`, `rateLimited`, `serverErrors` counts.
- Both are read-only (no idempotencyKey required).

### 10. Runtime Health Monitoring

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-runtime-health-monitoring.md`

Modified files:

- `src/read/LocalReadModel.js` â€” added `listApiRetries({ teamId, runtimeId? })`, `apiRetries` count in overview
- `src/app/LocalToadRuntime.js` â€” added `listApiRetries` delegate
- `test/localReadModel.test.js` â€” 5 new tests (12 total)

### 11. Tool-Call Audit Projection

Plan file:

- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-tool-call-audit-projection.md`

Modified files:

- `src\read\LocalReadModel.js` â€” added `listToolCalls({ teamId, runtimeId? })`, added `toolCalls` count to `getTeamOverview`
- `src\app\LocalToadRuntime.js` â€” added `listToolCalls` delegate
- `test\localReadModel.test.js` â€” expanded fixtures, 4 new tests (7 total)

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

- `src\runtime\ClaudeStreamJsonAdapter.js` â€” compact_boundary metadata, api_retry normalization
- `src\runtime\RuntimeEventIngestor.js` â€” compactionHandler lifecycle dispatch
- `src\app\LocalToadRuntime.js` â€” CompactionHandler creation and injection
- `test\claudeStreamJsonAdapter.test.js` â€” 2 new tests

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

- `src\tools\localToolFacade.js` â€” added `projectCwd` option, teammate permission response path
- `src\app\LocalToadRuntime.js` â€” added `projectCwd` constructor option

Behavior:

- `parsePermissionRequest(text)` parses teammate `permission_request` JSON payloads (validates `request_id`, `agent_id`, `tool_name`; preserves `permission_suggestions`).
- `applyPermissionSuggestions({ projectCwd, suggestions })` writes tool permission rules to `{projectCwd}/.claude/settings.local.json` using atomic temp+rename.
- `addRules` suggestions add tool names to `permissions.allow` (or `deny`).
- `setMode` suggestions are translated: `acceptEdits` â†’ Edit/Write/NotebookEdit; `bypassPermissions` â†’ broad tool list.
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
   - Replay-on-restart now applies a drop policy on `LocalToadRuntime.start()` â€” `replayPendingSideEffects()` marks every pending row failed. Adapter-session-aware retry (the only alternative to drop) would require a much larger redesign and is intentionally not in scope.

## Other Future Slices

Anchored to the checklist's own priority order (full detail in `docs/CHECKLIST_GAP_MATRIX.md`):

1. âœ… Role authority (Â§5 + Â§26) â€” done with permissive default for backward compat.
2. âœ… Test artifacts + CI gates (Â§6 + Â§18) â€” done. Validation config on TeamConfig; `validation_run` MCP tool; `task.validations[]` projection; `testing â†’ merge_ready` gated on passing test verdict.
3. âœ… Plan-before-code (Â§2) â€” done. Three plan tools, projection, gate, self-approval prevention.
4. âœ… Diagnostics (Â§25) â€” done. `diagnostics_run` read-only MCP tool runs eight self-checks (state-machine deny + allow paths, role-authority developer-deny + unknown-role-deny, validation-commands-configured per team, claude CLI detected, claude CLI authenticated, dbpath persistence) and returns `{ checks: [{ id, label, status, evidence, suggestedFix? }], summary: { pass, warning, fail } }`. Available to every role.
5. âœ… Per-transition role guards (Â§3 Ã— Â§5) â€” done. `TRANSITION_ROLES` map; `validateTaskStatusTransition` accepts `role`; `merge_ready â†’ done` lead/human only; `rejected â†’ backlog` and `blocked â†’ *` architect/lead/human only.
6. âœ… `tool_call_denied` event emission (Â§26) â€” done. Best-effort runtime event on every role-authority denial. Â§26 fully done.
7. âœ… Worktree-per-task slice 1 (Â§8) â€” done. Creation half: orchestrator runs `git worktree add` on `ready â†’ planned`; projection picks up `task.worktree`.
8. âœ… Worktree-per-task slice 2 (Â§8) â€” done. `agent_launch` cwd enforcement: auto-set or reject based on `task.worktree.path`.
9. âœ… Worktree-per-task slice 3 (Â§8) â€” done. `removeForTask` runs `git worktree remove --force` on `done`. Branch preserved. `rejected` does not auto-remove.
10. âœ… Diff tracking (Â§7 finished) â€” done. `computeDiff` runs `git diff baseRef..HEAD` inside the worktree; `review_request` auto-attaches when caller omits.
11. âœ… Merge conflict gate (Â§19 slice 1) â€” done. `checkForConflicts` runs `git merge --no-commit --no-ff` + `--abort` to verify the task branch is mergeable. Conflict or error blocks `merge_ready â†’ done`.
12. âœ… Scope-drift detection (Â§13 partial) â€” done. `task.review.scopeDrift[]` lists out-of-plan files after diff is captured.
13. âœ… No-op diff detector (Â§13 partial) â€” done. `task.review.noOpDiff` flags empty-diff review requests.
14. âœ… Repeated test-failure detector (Â§13 partial) â€” done. `task.consecutiveTestFailures` + `task.repeatedTestFailures` derived from `task.validations`.
15. âœ… Worktree slice 4 (Â§8) â€” done. `task_create` captures explicit `baseRef` + `baseBranch`; manager forwards them. Â§8 now fully REAL.
16. âœ… Sessionâ†’task pinning (Â§11 slice 1) â€” done. `runtime_instances.task_id` persists the link via the existing `agent_launch.taskId` flow.
17. âœ… Task history export (Â§20) â€” done. `task_history_export` read tool returns `{ task, taskEvents, runtimeEvents }`. Â§20 fully REAL.
18. âœ… Smoke-test fixes â€” done. validation_run idempotency, diagnostics auth-status field names, runtime auto-consume of adapter events. Detailed under "2026-05-01 Re-evaluation" near the top.

### Decision-pending next slice

19. **Agent-side MCP tool surface (Option 2 from re-evaluation) — DONE.** Real Claude agent verified through both `mcp__toad-local__task_comment` and a full file-edit/review_request lifecycle against live task state. The system is ready for real task execution.

### Other pending slices (operator picks order)

- **Merge slice 2 (Â§19)** â€” actually perform the integration commit on `baseBranch`. âš ï¸ Modifies user's mainline branch; needs explicit go-ahead before automating. Now unblocked by the baseRef + baseBranch capture.
- **Stuck/zombie runtime detector (Â§13)** â€” heartbeat-based detection over `runtime_events.created_at` per task. Now possible because Â§11 pins runtimes to tasks AND the auto-consume fix makes runtime_events flow for live agents.
- **Â§17 review severity tags** â€” `nit/minor/major/blocking` on review feedback (small polish slice).
- **Â§1 task schema fields** â€” `priority`, `assignedRole`, `allowedFiles`, `forbiddenFiles`, `acceptanceCriteria`, `riskLevel`, `requiresHumanApproval`. Each unlocks small follow-ups (Â§10 dependencies, Â§14 risk policy, scope-drift promotion to blocking).
- **Â§9 WIP limits** â€” flow control config on TeamConfig.
- **Â§31 `task_override`** â€” escape hatch tool with required reason; logs `TASK_OVERRIDE` event.
- Promote scope-drift / no-op-diff / repeated-test-failures to a configurable `task_blocked` event when policy thresholds are configured (depends on Â§14).

### Significant architectural moves (only if operator decides)

- **Option 3 from re-evaluation** â€” full upstream-style team launch (`--team-bootstrap-spec`, `--team-bootstrap-user-prompt-file`, inbox-file delivery). â‰ˆ 5â€“10 slices.
- Â§19 slice 3+ â€” rebase strategy as alternative to merge.
- Â§14 risk policy + auto-classification for `requiresHumanApproval`.

### Parked / out of scope now

- **Subscription quota / plan-usage indicator** â€” `claude auth status --json` returns `subscriptionType: "max"` (and similar) which the diagnostics tool now surfaces. The "ramping usage indicator" (live remaining-budget) still needs a separate data source the operator was researching.
- **UI work** â€” parallel UI prototype is being built elsewhere; backend-only per project priorities.

Workflow reminders:

- Write a plan doc in `docs/superpowers/plans/` before touching code.
- TDD: failing test first, watch it fail, write minimal GREEN code, repeat.
- Keep changes local-only â€” no `git push`.
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
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-role-authority.md`
- `C:\Project-TOAD\toad-local\src\security\roleAuthority.js`
- `C:\Project-TOAD\toad-local\test\roleAuthority.test.js`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-test-artifacts-ci-gates.md`
- `C:\Project-TOAD\toad-local\docs\superpowers\plans\2026-04-30-plan-before-code.md`

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
