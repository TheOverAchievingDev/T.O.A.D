# TOAD

> A local-first multi-agent CLI orchestrator. Backend is a Node + SQLite event-sourced
> core; the UI is a React/TypeScript desktop dashboard. Built by reverse-engineering
> the original `claude_agent_teams_ui-main` prototype into something that can actually
> survive real CLI agents misbehaving in real ways.

---

## Table of contents

- [What is TOAD?](#what-is-toad)
- [Repo layout](#repo-layout)
- [Quickstart](#quickstart)
- [Architecture in five paragraphs](#architecture-in-five-paragraphs)
- [The §-numbered hardening checklist](#the-numbered-hardening-checklist)
- [UI roadmap](#ui-roadmap)
- [Settings storage](#settings-storage)
- [Risk policy & §14 human-approval gate](#risk-policy--14-human-approval-gate)
- [GitHub auth](#github-auth)
- [Provider plan-auth](#provider-plan-auth)
- [Environment variables](#environment-variables)
- [Verification](#verification)
- [What's deferred](#whats-deferred)

---

## What is TOAD?

TOAD spawns and coordinates real CLI coding agents — Anthropic Claude, OpenAI
Codex, OpenCode — into structured teams. A **lead** agent delegates tasks to
specialists (developer, reviewer, researcher, debugger, QA, architect,
designer); the orchestrator gates risky operations, runs validation commands,
captures real diffs, and surfaces a complete audit trail. You watch the team
work in a desktop UI rather than juggling terminals.

The hard part isn't spawning processes. It's:

- Making the orchestrator's view of the world durable when CLI processes die
  or get killed mid-task.
- Stopping a misbehaving agent from editing `.env`, force-pushing the wrong
  branch, or quietly modifying files outside its planned scope.
- Catching when an agent gets stuck in a tool-loop or stops emitting events.
- Giving humans a clean way to intervene without throwing away all the
  agent's accumulated context.
- Doing all of this **locally** — no cloud control plane, no shared SaaS,
  your code stays on your machine.

Every gate, projection, and audit surface in TOAD comes from one of the items
in [`toad-local/docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`](toad-local/docs/AGENT_TEAMS_HARDENING_CHECKLIST.md).
The §-numbered references throughout the codebase (`§14`, `§19`, etc.) all
trace back to that document.

## Repo layout

```
C:\Project-TOAD\
├─ README.md                    # ← you are here
├─ HANDOFF-NEXT-AGENT.md        # rolling handoff doc — what was just done, what's next
├─ TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md
├─ AGENT-COMMUNICATION-REVERSE-ENGINEERING-NOTES.md
├─ UI Sketch/                   # the original design drop (kept for reference)
├─ claude_agent_teams_ui-main/  # the upstream we're reverse-engineering
├─ start-dev.bat                # boots backend + UI together
└─ toad-local/                  # the actual rebuild
   ├─ README.md                 # subproject README
   ├─ src/                      # backend
   │  ├─ app/LocalToadRuntime.js        # composes everything
   │  ├─ broker/                # durable message broker (SQLite)
   │  ├─ task/                  # task board + worktree manager + merge integrator
   │  ├─ runtime/               # supervisor, registry, event log, ingestor
   │  ├─ tools/localToolFacade.js # the MCP/HTTP tool surface
   │  ├─ mcp/stdioServer.js     # MCP server agents talk to
   │  ├─ transport/apiServer.js # HTTP + SSE bridge for the UI
   │  ├─ policy/                # §14 risk classifier + risk-policy store
   │  ├─ settings/              # §3 two-tier settings store
   │  ├─ github/                # §3c GitHub Device Flow + PAT auth + REST client
   │  ├─ providers/             # §3c.2 plan-auth helpers
   │  └─ diagnostics/           # §13 stuck-runtime detector + diagnostic checks
   ├─ test/                     # 526+ tests, pure node:test
   ├─ ui/                       # React 18 + TypeScript + Vite desktop UI
   │  └─ src/
   │     ├─ App.tsx                     # shell + routing
   │     ├─ components/                 # workspace, modals, drawers, settings
   │     ├─ components/settings/        # 8-tab settings shell
   │     ├─ hooks/                      # useToadData, useSettings, useTweaks, …
   │     ├─ api/                        # typed client + SSE
   │     └─ data/                       # types + seed
   └─ docs/
      ├─ AGENT_TEAMS_HARDENING_CHECKLIST.md   # the §-numbered spec
      ├─ ARCHITECTURE.md
      ├─ CHECKLIST_GAP_MATRIX.md              # which §s are real vs partial vs todo
      ├─ UI_LAYOUT_PLAN.md
      └─ superpowers/specs/2026-05-01-toad-ui-roadmap.md
```

## Quickstart

Backend + UI in two terminals:

```powershell
# Terminal 1 — orchestrator API on http://127.0.0.1:3001
cd C:\Project-TOAD\toad-local
npm.cmd run api:dev

# Terminal 2 — UI dev server on http://localhost:5173
cd C:\Project-TOAD\toad-local\ui
npm.cmd run dev
```

Or in one go:

```powershell
C:\Project-TOAD\start-dev.bat
```

The UI talks to the API at `127.0.0.1:3001` by default; override with
`VITE_TOAD_API_BASE_URL`. If the API is unreachable, the UI falls back to seed
data and shows a banner — useful for design preview without a backend.

For single-process production hosting, build the UI and point the API at the
output:

```powershell
cd C:\Project-TOAD\toad-local\ui
npm.cmd run build
$env:TOAD_UI_STATIC_DIR = "C:\Project-TOAD\toad-local\ui\dist"
cd ..; npm.cmd run api:dev
# now http://127.0.0.1:3001/ serves the UI
```

For a real desktop app (one icon, one window, no terminals), there's a
Tauri 2 wrapper at [`toad-local/ui/src-tauri/`](toad-local/ui/src-tauri/):

```powershell
cd C:\Project-TOAD\toad-local\ui
npm.cmd install              # one-time
npm.cmd run tauri:icon ..\toad-source.png   # one-time, needs a 1024x1024 PNG
npm.cmd run tauri:dev        # spawns API + opens TOAD in a real window
npm.cmd run tauri:build      # builds .msi/.exe (Win), .dmg/.app (Mac), .AppImage (Linux)
```

Setup details (Rust toolchain, platform-native deps, icon generation) live in
[`toad-local/ui/TAURI.md`](toad-local/ui/TAURI.md).

## Architecture in five paragraphs

**Durable events, transient processes.** The source of truth is the SQLite
database at `<project>/.toad/toad.db`. Every meaningful state change — task
created, status moved, plan proposed, review decided, runtime launched, tool
invoked, approval requested — is an event row. CLI processes are an
adapter; the UI is a projection. Killing both leaves the system in a known
state. Restart, re-attach, replay.

**Layered tool surface.** Agents call MCP tools (`task_comment`, `review_request`,
`task_human_approve`, `validation_run`, …) which are dispatched through
[`LocalToolFacade`](toad-local/src/tools/localToolFacade.js). The same facade
backs the HTTP `/api/call` endpoint the UI uses, so there is exactly one
authority point for permission checks, idempotency, role authority, and the
risk-policy gate. There is no separate UI API layer.

**Roles and authority.** Each agent carries a `role` (`lead`, `architect`,
`developer`, `reviewer`, `tester`, plus `human` for operators). The
[role-authority module](toad-local/src/security/roleAuthority.js) gates which
tools each role can call. Read-only tools are common; mutations are scoped
narrowly. Lead and human have full access; everyone else is on an explicit
allowlist.

**Real Git, real worktrees.** Tasks open inside per-task `git worktree`s
under the project. Diff capture uses the actual `git diff baseRef..HEAD`, not
agent-reported file lists. The §19 merge integrator advances the base branch
non-destructively via `git merge-tree --write-tree` + `git commit-tree` +
`git update-ref` with optimistic concurrency — never touching `HEAD` or the
working directory.

**Browser as the desktop.** The UI is a React 18 + TypeScript SPA built with
Vite. It reads via HTTP (`/api/call`) and listens to live updates over SSE
(`/events`). State lives in two places: server-authoritative projections via
[`useToadData`](toad-local/ui/src/hooks/useToadData.ts), and browser-local UI
preferences via [`useTweaks`](toad-local/ui/src/hooks/useTweaks.ts). Real
machine-wide settings (provider keys, GitHub auth, risk policy) are
persisted via the [§3 settings store](toad-local/src/settings/settingsStore.js).

## The §-numbered hardening checklist

The checklist is the contract for "what does it mean for TOAD to be
production-ish". The current state is mirrored in
[`CHECKLIST_GAP_MATRIX.md`](toad-local/docs/CHECKLIST_GAP_MATRIX.md). Highlights:

| § | Topic | Status |
|---|---|---|
| 1  | Task schema (priority/role/files/acceptance/risk/deps) | **Real** |
| 8  | Worktree per task with explicit `baseRef`/`baseBranch` | **Real** |
| 10 | Task dependency enforcement (ready ← deps done) | **Real** |
| 11 | Runtime instances pin `task_id` from `agent_launch` | **Real** |
| 13 | Stuck-runtime detector (silent past threshold) | **Real** |
| 14 | Risk-policy classifier + human-approval gate | **Real** + UI editor |
| 17 | Review feedback severity (nit/minor/major/blocking) | **Real** |
| 19 | Non-destructive merge integrator | **Real** |
| 20 | `task_history_export` joins task + runtime events | **Real** |
| 3  | Two-tier settings store + UI editors | **Real** (this push) |
| 3c | GitHub Device Flow + PAT auth | **Real** (this push) |
| 3c.2 | Provider plan-auth (Anthropic wired, others stubbed) | **Partial** |
| 3d | Risk-policy editor with live preview | **Real** (this push) |

Run `npm test` from `toad-local/` to verify — at the time of this commit,
**526 tests pass, 0 fail across 47 test files**.

## UI roadmap

The UI evolved across three phases, each shipping green:

**Phase 1 — Modal completeness.** Every screen in the original sketch ported
to TSX with proper types: workspace, agent cards (3 variants), org chart,
conversation rail, task side panel, agent inbox, titlebar, plus all modals
and drawers (CreateTeam, TaskDetail w/ Plan/Diff/Validations, Approvals,
Notifications, Providers, Runtime, Diagnostics, Onboarding, Empty,
ProjectPicker, TweaksPanel).

**Phase 2 — Lifecycle + nav.** Left sidebar nav (Workspace / Tasks /
Runtimes / Approvals / Diagnostics / Settings), command palette (⌘K) with
fuzzy search across every surface, focused Tasks screen with kanban+list
toggle, Team-launching watch screen between create and running, multi-project
tab switcher in titlebar, per-task §14 risk badge with reasoning popover,
review-feedback composer with severity tags, task-creation form wired to the
full slice F schema.

**Phase 3 — Settings + GitHub + risk-policy editor.** 8-tab Settings shell
(General, Providers, GitHub, Workspace, Risk policies, MCP servers,
Notifications, Advanced) backed by a `useSectionDraft` hook over the
`settings_get` / `settings_set` MCP tools. GitHub Device Flow + PAT auth.
Risk-policy editor with file rules, command rules, and a live preview pane
that runs the §14 classifier against sample inputs.

The full roadmap (including Phase 4 polish items still pending) lives at
[`toad-local/docs/superpowers/specs/2026-05-01-toad-ui-roadmap.md`](toad-local/docs/superpowers/specs/2026-05-01-toad-ui-roadmap.md).

## Settings storage

Two-tier, JSON files, no schema validation in the store itself (writers
validate; UI re-validates on read).

| Tier | Path | What lives here |
|---|---|---|
| Global | `%APPDATA%\toad\settings.json` (Windows) / `~/.config/toad/settings.json` (Unix) | Provider keys, GitHub token, theme defaults |
| Project | `<projectCwd>/.toad/settings.json` | Project-specific overrides |
| Risk policy | `<projectCwd>/.toad/risk-policy.json` | §14 file + command rules |

Project values shallow-merge over global values per top-level section. Each
section is one of: `general`, `providers`, `github`, `workspace`, `risk`,
`mcp`, `notifications`, `advanced`. The merged result includes a `_sources`
field telling the UI which file each section came from, so the settings
screen can show "this came from the project file."

## Risk policy & §14 human-approval gate

When an agent calls `review_request`, the orchestrator runs the
[risk classifier](toad-local/src/policy/riskClassifier.js) with two inputs:

1. The files in the task's diff (matched against `rules` glob patterns).
2. The bash commands from the task's `runtime_events` stream (matched against
   `commandRules` substring/prefix patterns).

If a rule fires, the task's `riskLevel` may be auto-elevated and
`requiresHumanApproval` may be set to `true`. While that flag is set, the
task is blocked from `merge_ready → done` until a human (or the lead role)
calls `task_human_approve`.

Edit the policy in the UI: **Settings → Risk policies**. The editor has a
live preview pane — paste sample files / commands and see what the
classifier would decide.

## GitHub auth

Two flows, both implemented in [`src/github/githubAuth.js`](toad-local/src/github/githubAuth.js):

- **Device Flow (preferred).** Click "Sign in with GitHub" → modal shows a
  user code → click "Open GitHub" → enter the code in the browser →
  authorize → the UI auto-polls until the token is granted, then verifies
  it by calling `/user`. No callback URL, no client-secret distribution.
  Requires registering a GitHub OAuth App and setting `TOAD_GITHUB_CLIENT_ID`.
- **PAT fallback.** Paste a Personal Access Token, the orchestrator verifies
  by calling `/user`, captures user + scopes, persists. Works without a
  client_id — useful for fully offline / single-user setups.

Tokens persist under `settings.github` in the global settings file. Click
**Disconnect** any time to clear them (the OAuth client_id is preserved).

## Provider plan-auth

Each LLM provider has its own subscription/plan auth managed by its CLI:

- **Anthropic**: `claude auth status --json` / `claude auth login` /
  `claude auth logout` — fully wired.
- **OpenAI Codex**: wired via filesystem detection of `~/.codex/auth.json`
  plus `codex login` / `codex logout` (the CLI exposes login/logout as
  top-level commands, not under an `auth` prefix).
- **Gemini**: wired via filesystem detection of
  `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json`, with
  `gemini auth login` / `gemini auth logout`.
- **OpenCode**: API-only by design — no subscription/plan auth flow
  exists. The Providers tab hides the plan-auth toggle for it
  accordingly.

In **Settings → Providers**, switch any provider's "Auth method" segmented
control to **Plan / subscription** to see the per-provider auth panel next
to the model selection. Status pulls from the CLI, sign-in spawns
`<cli> auth login` and polls every 5 seconds until you authorize. Status
results are cached at module level
([`providerAuthCache.ts`](toad-local/ui/src/components/settings/providerAuthCache.ts))
so the toggle row and per-provider badge share a single fetch and stay in
sync after a login or logout.

## Environment variables

| Variable | Purpose |
|---|---|
| `TOAD_DB_PATH` | Path to the SQLite file (default `<projectCwd>/.toad/toad.db`) |
| `TOAD_API_PORT` | API server port (default 3001) |
| `TOAD_API_TOKEN` | Bearer token required by `/api/call` and `/events` |
| `TOAD_API_ALLOWED_ORIGINS` | CORS origin allowlist for the SPA |
| `TOAD_UI_STATIC_DIR` | When set, ApiServer serves the built UI at `/` |
| `TOAD_GITHUB_CLIENT_ID` | OAuth client_id for the GitHub Device Flow |
| `TOAD_SETTINGS_PATH` | Override the global settings file path |
| `TOAD_SIDE_EFFECT_RETENTION_DAYS` | Side-effect log pruning window |
| `VITE_TOAD_API_BASE_URL` | UI: API base URL (default 127.0.0.1:3001) |
| `VITE_TOAD_API_TOKEN` | UI: bearer token sent with each request |

## Verification

```powershell
# Backend — full suite, ~526 tests across ~47 files
cd C:\Project-TOAD\toad-local
npm.cmd test

# UI — typecheck + production build
cd C:\Project-TOAD\toad-local\ui
npm.cmd run typecheck
npm.cmd run build
```

CI for this repo isn't set up yet (it's a local-first tool); both commands
should exit 0 on every commit. The `toad-local/test/` files use Node's
built-in `node:test` runner — no Jest, Vitest, or other harness.

## What's deferred

Tracked on the roadmap; flagged here so nothing is hidden:

- **OpenCode plan-auth**: not wired — OpenCode is API-only by design (no
  subscription/plan auth flow exists for it). The Providers tab hides the
  plan-auth toggle for it accordingly.
- **Tauri desktop wrapper**: scaffold landed at
  [`toad-local/ui/src-tauri/`](toad-local/ui/src-tauri/) with
  `npm run tauri:dev` / `tauri:build` scripts. Rust shell + Node-sidecar +
  React UI all compile cleanly (`cargo check` and `cargo build` both pass
  on Windows with the placeholder icons currently committed). Real TOAD
  branding still needs to land in
  [`src-tauri/icons/`](toad-local/ui/src-tauri/icons/) before public
  release — drop a 1024×1024 PNG over `src-tauri/toad-source.png` and run
  `npm run tauri:icon src-tauri/toad-source.png`. See
  [`toad-local/ui/TAURI.md`](toad-local/ui/TAURI.md) for the full setup.
- **Backend GitHub-driven actions**: complete —
  [`src/github/githubApi.js`](toad-local/src/github/githubApi.js) exposes
  `getRepository`, `getBranchProtection`, and `createPullRequest`, and
  [`src/task/remoteMergePolicy.js`](toad-local/src/task/remoteMergePolicy.js)
  + [`src/task/buildRemoteMergePolicy.js`](toad-local/src/task/buildRemoteMergePolicy.js)
  wire branch protection into the §19 merge gate. When a task transitions
  `merge_ready → done` and the remote base branch's protection requires
  PRs, the local merge is refused with a clear error pointing at
  `github_create_pull_request`. The orchestrator stays advisory when the
  origin remote isn't on github.com or no token is stored — only an
  explicit "protected AND requires PR" verdict blocks the transition,
  so transient GitHub outages don't stop teams from completing tasks.
  Tools surfaced to agents: `github_get_repository`,
  `github_get_branch_protection`, `github_origin_remote` (all in
  `COMMON_READ_TOOLS`); plus the mutating `github_create_pull_request`
  (lead/human only, idempotency key required). The Task Detail modal in
  the UI shows an "Open pull request" affordance via
  [`OpenPullRequestButton`](toad-local/ui/src/components/OpenPullRequestButton.tsx)
  that auto-discovers the origin repo, calls
  `github_create_pull_request` with the task's worktree + base, and
  surfaces 422 validation errors verbatim ("PR already exists", "head
  not pushed").

The `HANDOFF-NEXT-AGENT.md` at the repo root tracks the rolling state
between sessions — read that first if you're picking up the project cold.
