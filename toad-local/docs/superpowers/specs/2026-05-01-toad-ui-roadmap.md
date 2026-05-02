# TOAD UI Roadmap — 2026-05-01

This is the agreed roadmap for completing the TOAD desktop UI on top of the
React 18 + TypeScript + Vite shell already running under `toad-local/ui/`.

The original `Downloads/TOAD (2)/` JSX drop is treated as a sketch. This spec
extends it into a full product surface — onboarding, GitHub auth, settings,
multi-project switching, observability — and phases the work so we can ship
incrementally without leaving partial features lying around.

## Decisions locked in

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | GitHub auth | **Device Flow** (with PAT fallback) | No callback URL or client-secret distribution; works the same locally and shipped via Tauri. UX: click Connect → browser opens to `github.com/login/device` → user pastes code → UI polls until granted. |
| 2 | Settings storage | **Global** (`%APPDATA%/toad/settings.json` on Windows, `~/.config/toad/settings.json` on Unix) with optional project-local overrides at `.toad/settings.json` | Most settings (provider creds, GitHub auth, theme) belong to the user, not the project. Project file overrides for things like default branch policy. |
| 3 | Multi-project | **Project switcher in titlebar.** Each project = own `.toad/toad.db`. Switcher opens a different DB. | Matches the titlebar tabs already in the sketch. Lets one TOAD instance hop between local projects without restart. |
| 4 | Live log viewer | **Both** — stdout pass-through tab + tool-call event timeline tab | Devs need raw stream when debugging adapter issues; PMs need the high-level event timeline. Same drawer, two tabs. |
| 5 | Toast policy | **Quiet by default** — only flagged severities (`error`, `blocking-review`, `human-approval-required`, `stuck-runtime`) toast. Everything else lands silently in NotificationsDrawer. Loud mode opt-in via Settings. | Default-loud is unusable for a multi-agent tool that emits dozens of events per minute. |

## Inventory — full UI surface

Grouped by user journey. Each item lists current status:
- ✅ done
- 🟡 in flight (this session, Claude or Codex)
- 🔵 phase 2
- 🟣 phase 3
- ⚪ phase 4

### 1. First-run / onboarding
- ⚪ App-level welcome (separate from in-product onboarding)
- 🟡 Provider connection (Anthropic / OpenAI / OpenCode) — Codex porting
- 🟣 GitHub connection (Device Flow)
- 🟣 MCP server registration (auto, with status indicator)
- 🟡 Workspace path picker — Codex (ProjectPicker)
- 🟡 First team template chooser — Codex (OnboardingScreen)

### 2. Shell / navigation
- ✅ Titlebar
- 🔵 Left navigation sidebar (Workspace / Tasks / Runtimes / Approvals / Diagnostics / Settings)
- 🔵 Command palette (⌘K)
- ⚪ Toast / inline notification system

### 3. Project & workspace
- 🟡 ProjectPicker — Codex
- 🟡 EmptyWorkspace — Codex
- ✅ Workspace (org + chat + tasks)
- 🔵 Multi-project tab management (real switching between `.toad/toad.db` files)
- 🟣 Workspace settings (rename, change path, archive)

### 4. Team lifecycle (CRITICAL — currently missing)
- 🟡 CreateTeamModal — Claude
- 🔵 Team launching screen (watch agents come online with provider auth checks)
- ✅ Team running state (= current workspace)
- 🔵 Team paused / stopped state
- 🟣 Team settings (members editor — add/remove/reassign role/swap provider)
- 🟣 Team archival / deletion (with confirm gate)
- 🟣 Team templates (save current as template, load template)

### 5. Agent
- ✅ AgentCard variants (detail / compact / terminal)
- ✅ AgentInbox
- 🟣 Agent settings panel (provider / model / role / token budget / permissions / system prompt overrides)
- 🔵 Agent restart / kill / interrupt controls

### 6. Task
- ✅ Kanban (in workspace)
- 🟡 TaskDetailModal — Claude
- 🔵 Task creation form (priority, role, files, acceptance criteria, dependencies, test commands)
- ⚪ Task lifecycle visualizer (the 10-state machine)
- 🟡 PlanSection / DiffSection / ValidationsSection (chunk-b) — Claude integrating into TaskDetailModal
- 🔵 Review feedback composer (severity tags, blocking comments)
- 🔵 Task history / audit log viewer

### 7. Risk & approvals (§14 product surface)
- 🟡 ApprovalsDrawer — Claude
- 🟣 Risk-policy editor (file rules + command rules — currently `.toad/risk-policy.json` only)
- 🔵 Per-task risk badge + reasoning popover (why elevated?)
- ⚪ Audit trail of approvals

### 8. GitHub integration
- 🟣 GitHub Device Flow auth + PAT fallback
- 🟣 Repo selection per project
- 🟣 Branch list + status
- 🟣 Worktree status panel (which agent owns which branch)
- 🟣 Merge integrator status (§19)
- 🟣 PR creation from a `done` task
- ⚪ PR list / review inline

### 9. Runtime & observability
- ✅ TasksSide → Runtimes tab
- 🟡 RuntimeDrawer — Codex
- 🟡 DiagnosticsDrawer — Codex
- ⚪ Live log viewer (per runtime, scrollable, filterable, two tabs: stdout + event timeline)
- ⚪ Runtime cost / token tracking dashboard
- ⚪ Stuck-runtime alerts (§13 detector → toast + banner)

### 10. Provider management
- 🟡 ProvidersModal — Codex
- 🟣 Provider settings page (API key rotation, default model per role, cost caps)
- 🔵 Model picker (used in agent settings + task creation)

### 11. Settings (global — currently no entry point)
- 🟣 General (theme / density / locale / auto-update / telemetry)
- 🟣 Providers (account list, OAuth re-auth)
- 🟣 GitHub (account, default org, default branch policy)
- 🟣 Workspace defaults (default project path, worktree-on-launch toggle)
- 🟣 Risk policies (file/command rule editor)
- 🟣 MCP servers (TOAD's own + extras)
- 🟣 Notifications (which events emit toasts / drawer entries / push)
- ⚪ Keyboard shortcuts (view + customize)
- 🟣 Advanced (DB path, port, log level, dev tools toggle)

### 12. Notifications
- 🟡 NotificationsDrawer — Codex
- ⚪ Toast system (transient, success/info/warn/error)
- 🟣 Notification preferences UI (in Settings)

### 13. Dev
- 🟡 TweaksPanel — Codex
- ⚪ Storybook-style component gallery (optional)

## Phasing

### Phase 1 — Modal completeness (in flight, this session)

Goal: lock in every visible surface that the sketch already has, so we can do a
proper internal demo of the workspace + modals.

Claude builds:
- `CreateTeamModal.tsx` — wires `team_create` + `team_launch`
- `TaskDetailModal.tsx` — wires `task_history_export` + lifecycle actions, integrates `PlanSection` / `DiffSection` / `ValidationsSection` from chunk-b
- `ApprovalsDrawer.tsx` — wires `task_human_approve` (§14 gate)

Codex builds:
- `TweaksPanel.tsx`
- `EmptyWorkspace.tsx`
- `OnboardingScreen.tsx`
- `ProjectPicker.tsx`
- `ProvidersModal.tsx`
- `NotificationsDrawer.tsx`
- `RuntimeDrawer.tsx`
- `DiagnosticsDrawer.tsx`

Acceptance: typecheck + production build green; every modal openable from titlebar/workspace; seed data renders cleanly.

### Phase 2 — Lifecycle + navigation

Goal: TOAD becomes navigable. Multiple teams/projects become first-class.

- Left sidebar (nav between Workspace / Tasks / Runtimes / Approvals / Diagnostics / Settings)
- Command palette (⌘K) — searchable across teams, tasks, agents, settings
- Team launching screen (watch agents come online one-by-one with provider auth checks)
- Team paused / stopped state
- Multi-project tab switching (real DB swap)
- Per-task risk badge + reasoning popover
- Review feedback composer (severity tags)
- Task history / audit log viewer
- Task creation form
- Agent restart / kill / interrupt controls
- Model picker (shared component)

### Phase 3 — Settings + GitHub

Goal: TOAD becomes configurable and source-control-aware.

- Settings shell (general / providers / github / workspace / risk / mcp / notifications / advanced)
- GitHub Device Flow auth
- GitHub repo selection
- Branch + worktree status panel
- Merge integrator status panel (§19)
- PR creation from `done` task
- Risk-policy editor (file rules + command rules, validation, preview)
- Provider settings (rotate keys, default model per role, cost caps)
- Workspace defaults
- MCP server registry
- Team settings + member editor
- Team templates
- Agent settings panel
- App-level welcome
- MCP server registration UX

### Phase 4 — Polish + observability

Goal: TOAD becomes trustworthy day-to-day.

- Toast system (quiet by default per decision #5)
- Live log viewer (per-runtime; stdout tab + event timeline tab per decision #4)
- Runtime cost / token tracking dashboard
- Stuck-runtime alerts surface
- Audit trail viewer (approvals, role authority, side effects)
- PR list / review inline
- Keyboard shortcuts viewer + customizer
- Task lifecycle visualizer
- Notification preferences UI
- Storybook-style component gallery (optional)

## File / module conventions

All UI work follows the patterns already in `toad-local/ui/src/`:

- TypeScript strict; no `any`; no `// @ts-ignore`
- Path alias `@/` resolves to `src/`
- Types in `src/types/index.ts` — extend, don't duplicate
- Role helpers in `src/data/roles.ts`
- Seed data in `src/data/seed.ts`
- Icons via `<Icon name="…" />` from `src/components/Icon.tsx`
- Backend calls via `callTool({ actor, method, args })` from `src/api/client.ts`
- SSE via `useToadEvents` from `src/api/events.ts`
- Projection-shaped data via `useToadData` (extend rather than duplicate)
- CSS classes from the design's `styles.css` / `chunk-*.css` are global; just use them
- One component per file unless tightly coupled (e.g. AgentInbox + StreamItem)
- Pure visual ports take props; no `window.X` globals
- All modals/drawers take an `onClose` callback and a typed prop bag — no internal data fetching unless the modal owns its own state machine (CreateTeamModal does, ProvidersModal doesn't)

## Backend touchpoints expected per phase

Phase 1: nothing new. Existing `team_create`, `team_launch`, `task_history_export`, `task_human_approve`, `task_update`, `runtime_list`, `task_list` cover everything.

Phase 2: probably need `task_create` schema fields validated end-to-end (already done — slice F), plus a new `team_pause` / `team_resume` pair if we want non-destructive pause.

Phase 3: GitHub OAuth Device Flow handler in ApiServer (new endpoint `/auth/github/device-start`, `/auth/github/device-poll`); settings file IO (new `settings_get` / `settings_set` tools); risk-policy CRUD tools (`risk_policy_get` / `risk_policy_set`).

Phase 4: cost rollup query (new `runtime_cost_summary` tool); audit-log query already covered by `task_history_export` + a new `audit_log_query`.

## Out of scope for this roadmap

- Mobile / responsive layouts (TOAD is a desktop tool)
- Multi-user / SaaS deployment
- Plugin marketplace
- Theme customization beyond dark/light (covered by `data-theme` already)
- i18n (Phase 4+ if at all)
