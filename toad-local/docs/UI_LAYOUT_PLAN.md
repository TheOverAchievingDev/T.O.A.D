# TOAD UI Layout Plan

Source-of-truth document for the desktop frontend. Hand this (plus the screenshot references) to Claude Design to sketch HTML/CSS, then we wire it to the existing `/api/call` + `/events` SSE endpoints.

**Visual direction** is anchored on the operator's reference screenshots in `~/Downloads/TOAD.zip`:
- Dark theme, single-window app (Electron-style chrome optional, browser also fine)
- Persistent left tab bar with `Teams` / `<team-name>` tabs
- Persistent right rail with `Tasks` / `Sessions` toggle
- Top-right action cluster: `+ Create`, notifications bell, agents avatar group, providers icon, GitHub, settings, more
- Strong color-coded accents per agent (green/blue/orange tints on member rows)
- Live activity colored bars on the left edge of cards

---

## 1 · App Shell (always visible)

| Region | What | Backend wiring |
|---|---|---|
| Title bar (top) | App icon, window controls. | — |
| Top right action cluster | `+ New` (split: New Team / New Task / Open Project), notifications bell with badge count, agents online avatar group, providers panel toggle, GitHub link, settings ⚙, overflow `…` | Notifications: `runtime_events` filtered to attention-needed + `approval_list`. Agents online: `agent_status` across all teams. |
| Left tab strip | `Teams` tab pinned first, then one tab per active team (color-tinted). Click reorders. Right-click → close team workspace tab. | `team_list` populates open tabs (persisted in local storage). |
| Right rail (collapsible) | Two segments toggled by `Tasks` / `Sessions` header. Persistent across all main screens. | `Tasks` segment: `task_list` from current team or "all teams". `Sessions` segment: `agent_status` listing live runtimes. |
| Bottom-left | `Context` button — opens system context drawer (diagnostics, db path, version) | `diagnostics_run` |

**Right rail — Tasks segment**
- Search input
- `Group by:` `None` / `Project` / `Time` chips
- Sort + filter icons (right-aligned)
- Empty state: "No tasks found" with task-list icon
- Otherwise grouped task cards: subject, project, team, owner avatar, status pill, badge for scope drift / failed tests / pending review

**Right rail — Sessions segment**
- Active runtime list, one row per `runtime_instances.status='running'`
- Runtime row: agent avatar + name, team color, taskId pill if pinned (§11), live token-count, kebab menu (`Open`, `Send input…`, `Stop`)
- "Connected providers" card at bottom

---

## 2 · Screen: Project Picker (initial state, no team selected)

Shown when the `Teams` tab is active and no specific team workspace is open. Same layout as Screenshot 145148.

| Section | Contents |
|---|---|
| Top live status banner | If any team is currently launching, condensed launch progress card sticks to the top (collapsible). |
| Hero search + Select Team | `Select Team` button (opens team picker dropdown) and `Search projects…` input with `⌘K` hotkey. |
| Recent projects grid | Card grid: project icon, name, color tag, path, badges (`1 done`, `4 pending`), member avatars, last-active relative time, completion progress bar. Cards 3-4 columns wide. |
| Empty card "Select Folder" | First card slot for "add another project root". |
| Bottom | `Load more` button. |

**Backend wiring:**
- Recent projects = local-storage list seeded by `team_list` cwd values + manually-added folders
- Per-card stats = `task_list` filtered by team(s) operating on that project
- "Done count" = tasks with status `done`
- Progress bar = completed / total

---

## 3 · Screen: Team Workspace (the main work surface)

Shown when a team tab is active. Three-column layout (left rail, center stage, right rail). Reference Screenshot 112435.

### 3.1 Left rail (per-team)

| Pane | Contents |
|---|---|
| Header | Team name + status dot (`launching` / `running` / `stopped`), gear icon, …menu (Stop team, Delete, Backup) |
| Claude logs feed | Scrollable list of recent CLI events: tool uses, assistant messages, hooks. Color tinted per member. Each item has a tiny token count pill. Filter chips: `Tools`, `Assistant`, `System`, `Errors`. |
| Messages composer | Sticky-bottom card. From-pill (`Do` / `Ask` / `Delegate` mode), recipient pill (`lead` / specific member / team), text input, mic icon, `Send` button. Tip line below: "Use @ for members/files and # for tasks". |
| Empty messages state | Icon + "No messages — Send a message to a member to see activity" |

**Backend wiring:**
- Logs feed: `runtime_events` for the team, joined with `tool_activity` for richer tool detail
- Composer Send: `message_send` (when recipient is agent/team) or `runtime_send_input` (when targeting a specific runtime by id)
- Mode pills (`Do` / `Ask` / `Delegate`) = structural prefix to the message that the agent sees

### 3.2 Center stage

Vertically stacked panels, each collapsible:

#### Panel A — Launch progress (only while team is launching)
Reference Screenshot 112435. Horizontal stepper: `Starting` → `Team setup` → `Members joining` → `Finalizing`. Each step shows a check or in-progress spinner.
- `Live output` box with last CLI output lines.
- `CLI logs` summary chips listing recent tools used (e.g. `TeamCreate`, `ToolSearch`).
- `Cancel` button top-right.

**Backend wiring:** synthesized from a sequence of `runtime_events` types (`team_starting`, `agent_launched`, `bootstrap_confirmed`, etc.). Currently approximated; needs an explicit launch-state projection when we land §11 fully.

#### Panel B — Team members
Header `Team` with member count pill, `Graph` toggle, `Member` toggle, `+` button.
Each member row: color tint stripe, avatar, name, role pill (`Team Lead` / `Reviewer` / `Developer` / etc.), status pill (`waiting` / `running` / `stopped`), task count, message-count badge, kebab actions (`Send DM`, `Stop`, `Restart`, `Open session`, `Logs`).

**Backend wiring:**
- Member list = `team_list` + `agent_status` per member
- Task count per member = `task_list` filtered by `ownerId === member.agentId`
- DM action: `message_send` recipient `{kind:'agent', agentId}`
- Logs: opens the runtime detail drawer (§3.4)

#### Panel C — Sessions
Collapsible list of session ids per active runtime, click to open the runtime detail drawer.

**Backend wiring:** `agent_status` returns per-runtime `sessionId`s seen in `runtime_events`.

#### Panel D — Kanban
Reference Screenshot 112435. Header `Kanban` with task count pill, `+ Task` button on right.
- Filter row: `Search tasks (#id or text)`, `<>` filter, sort, view toggles (list / kanban / scope-drift-only)
- Columns: `TODO`, `IN PROGRESS`, `REVIEW`, `TESTING`, `MERGE READY`, `DONE`, `BLOCKED`, `REJECTED`. Sticky horizontal scroll.
- Each card: subject, agent owner avatar/color, plan-state pill (`needs plan` / `awaiting approval` / `approved`), test-verdict mini-badge (✓ / ✗ / —), scope-drift warning, file-count, last-update relative time, `+` add-task button at column foot.
- Drag-and-drop between columns triggers `task_update` (gates fire — show toast on rejection).

**Backend wiring:**
- `task_list` filtered by team. Group by `task.status`.
- Plan state badge: `task.plan?.state`.
- Test verdict mini-badge: `task.latestValidation?.test?.verdict`.
- Scope drift indicator: `task.review?.scopeDrift?.length > 0`
- Repeated test failures: `task.repeatedTestFailures` (red dot)
- Drop into column = `task_update({status})` — UI reverts on gate-rejection error and surfaces the message inline.

---

## 4 · Screen: Task Detail Drawer / Page

Reference Screenshots 145236 + 145250.

Opens as a sheet over the workspace (or full-page route `/team/:teamId/task/:taskId`). Top-bar: status pill (`Approved` / `In Progress` / etc.), task subject, owner avatar+ago, kebab menu (Move, Reassign, Delete), `Open team` shortcut, close `×`.

Vertically scrolling sections, each collapsible:

| Section | Contents | Backend wiring |
|---|---|---|
| **Description** | Task description + acceptance criteria + plan description if approved. "Show more" expander for long text. | `task.description`, `task.plan.summary`, `task.plan.approach`, `task.plan.risks`, `task.plan.validationPlan` |
| **Plan** | Plan card showing: state, summary, files expected, approach, risks, validation steps, proposer, decider, decision time. Buttons (per role): `Approve plan`, `Request changes`, `Re-propose`. | `task_plan_propose` / `task_plan_approve` / `task_plan_reject`. Show plan history (replaceable) below. |
| **Worktree** | Path, branch, baseRef, baseBranch, status (`created` / `skipped` / `removed`), reason if skipped. Open-in-explorer button. Open-in-VSCode button. | `task.worktree` projection. |
| **Attachments** | File-pill list with size and download. | (Future feature — leave a `coming soon` hint for now.) |
| **Changes (Diff)** | Per-file unified diff view. Show files-changed list with stats. Highlight scope-drift files in red. Highlight forbidden-file matches if §1 lands. Side-by-side toggle. Inline-comment widgets per hunk. | `task.review.diff` (orchestrator-computed). `task.review.files`. `task.review.scopeDrift`. |
| **Task Logs** | Filtered runtime events for this task (joined via `runtime_instances.task_id`). Tool uses with input/output. Color-coded per agent. | `task_history_export` returns `runtimeEvents` already correlated. |
| **Validations** | Each test/lint/typecheck/build/security run as a row: kind, command, exit code, duration, verdict pill, expandable stdout/stderr. `Run again` button. | `task.validations[]`. `validation_run` to re-run. |
| **Workflow History** | Vertical timeline of every task event: created, status changes, plan events, review request/decision, worktree create/remove, validation runs, comments. | `task_history_export.taskEvents` |
| **Comments** | Threaded comments. Composer at top. `@member` and `#task` mentions. | `task.comments`, `task_comment` |

**Sticky right side actions panel** (when room): primary actions for the current state — `Move to Review`, `Approve Review`, `Request Changes`, `Move to Testing`, `Run tests`, `Move to Merge Ready`, `Move to Done`. Disabled buttons show why ("requires passing test verdict"). On click, calls `task_update` / `review_decide` / `validation_run`.

---

## 5 · Modal: Create Team

Reference Screenshots 112314 + 112352.

Triggered from `+ New` → `New Team`. Full-window modal with close-X.

| Section | Fields |
|---|---|
| Header | "Create Team" + subtitle "Team provisioning via local Claude CLI" |
| Team name | Text input. Validation: lowercase, hyphens, unique. |
| Members | `Solo team` checkbox. List of member rows: name, role dropdown (`reviewer` / `developer` / `tester` / `architect` / `lead` / `human`), `Workflow >` expandable, `Model >` expandable, delete trash. `+ Add member`. `Edit as JSON` link. Per-member model panel: provider chips (Anthropic / Codex / Gemini / OpenCode), model presets (Default / Opus / Sonnet / Haiku). Info banner: "Claude Code doesn't support per-member model selection yet — all teammates inherit the team launch model. We plan to solve this via a local proxy." |
| Run command after create | Checkbox + subtitle "Start the team immediately via local Claude CLI." |
| Project | Tabs: `From project list` / `Custom path`. Folder picker. |
| Optional launch settings | Collapsible. Prompt for team lead (textarea), model (provider chips + presets), effort (Default / Low / Medium / High), `Limit context to 200K tokens` checkbox, `Auto-approve all tools` checkbox with warning banner, `> Advanced` expander (extra CLI args). |
| Optional team details | Color picker, description, tags. |
| Footer | `Cancel` left, `Create Team` right (primary). |

**Backend wiring:**
- `team_create` with `lead`, `teammates`, `validation` (default test command), launch settings.
- If `Run command after create` checked → `team_launch`.

---

## 6 · Modal: Create Task

Triggered from `+ New` → `New Task` or kanban `+ Task`.

| Section | Fields |
|---|---|
| Subject | Required. |
| Description | Markdown. |
| Owner (assignee) | Member picker with avatars. |
| Initial status | `pending` / `ready`. |
| Base ref | Optional. Auto-fills with `git rev-parse HEAD` of project. |
| Base branch | Optional. Auto-fills with current branch. |
| Files expected to change | Tag input. |
| Acceptance criteria | List input. |
| Validation override | "Use team default test command" checkbox; if unchecked, custom test/lint/build commands. |

**Backend wiring:** `task_create({ taskId, subject, description, ownerId, status, baseRef, baseBranch })`. Plan `filesExpectedToChange` is set later via `task_plan_propose`.

---

## 7 · Modal: System Setup / Providers

Reference Screenshots 135542 + 145112.

Triggered from the providers icon in the top-right action cluster. Full-window modal.

| Section | Contents | Backend wiring |
|---|---|---|
| Providers list | Each provider card: status dot (`connected` / `not installed` / `auth failed`), name, account info (e.g. "Anthropic - Connected via Anthropic subscription"), models supported, token usage stats per model + plan, `Manage` / `Disconnect` buttons. Multi-model selector. | Anthropic: `diagnostics_run` `provider_claude_*` checks + `runtime_events` usage aggregate. Codex / Gemini / OpenCode: future provider abstractions (§12). |
| WSL setup card | "WSL has only service distributions… Install a Linux distribution such as Ubuntu for teammate runtime support." `Install Ubuntu in WSL`, `Manual guide`, `Show setup steps`, `Re-check` buttons. | Detection runs `wsl --list --quiet` and friends. |
| Tmux install card | When tmux is missing: "tmux is not installed, tmux verification failed". `Retry install`, `Manual guide`, `Show setup steps`, `Re-check`. Live install log streaming. | Spawn `apt install tmux` and stream stdout. |
| Diagnostics summary | Pass/warning/fail counters from `diagnostics_run`. Click → opens diagnostics drawer with full check list. | `diagnostics_run` |

---

## 8 · Drawer: Runtime Detail

Triggered from `Sessions` rail row, member row → `Open session`, or runtime kebab → `Open`.

Three tabs:
1. **Activity** — live event stream (assistant_text, tool_use, tool_result, thinking-text). Per-event token cost. Auto-scroll toggle.
2. **Context** — 6-category breakdown (claude-md / mentioned-file / tool-output / thinking-text / team-coordination / user-message) with token counts. Token-budget bar.
3. **Inputs** — composer to send `runtime_send_input` directly, history of sent messages.

Footer: `Stop`, `Restart`, `Open in IDE`, `Tail logs`, `Export session`.

**Backend wiring:** `runtime_events` filtered by `runtimeId`, `agent_status`, `runtime_send_input`, `agent_stop`.

---

## 9 · Drawer: Approvals

Triggered by the bell icon when `approval_list` returns pending requests, or directly from a runtime in attention state.

Each pending request: agent name, tool name, input preview, requested-at relative time, `Approve` / `Deny` buttons (with optional `Reason`). Filters: pending / approved / denied.

**Backend wiring:** `approval_list`, `approval_respond({ approvalId, decision, reason })`.

---

## 10 · Drawer: Cross-Team Inbox

Triggered from the agents icon or top-right. Two-panel: conversation list left, message thread right. Compose to other team. Search.

**Backend wiring:** `cross_team_messages`, `cross_team_send`.

---

## 11 · Drawer: Diagnostics

Triggered from the bottom-left `Context` button or settings. Renders the full `diagnostics_run` report with rerun button.

| Element | Contents |
|---|---|
| Summary header | Pass / Warning / Fail counters. Last run timestamp. `Run again` button. |
| Check list | One row per check id: status pill, label, evidence collapsible, `suggestedFix` callout. |
| DB info | dbPath, file size, table row counts. |

---

## 12 · Drawer: Settings

Triggered from the top-right gear. Tabs:

1. **General** — theme, font size, default project root, default model.
2. **Providers** — same content as the Providers modal.
3. **API server** — host, port, token (with copy + regenerate), allowed origins.
4. **Database** — path, retention, vacuum-now button, export.
5. **Notifications** — categories, sound, OS bridge.
6. **Keybindings** — full list + customize.
7. **About** — version, link to docs, link to gap matrix.

---

## 13 · Notifications panel

Reference: red badge on bell icon (Screenshot 145148 shows `21`).

Triggered from bell. Vertical list of: pending approvals, failed validations, repeated-test-failures (`task.repeatedTestFailures`), scope-drift detections, agent stops, db retention prunes, side-effects-dropped-on-restart events.

**Backend wiring:** projection over `runtime_events` filtered to attention-needed types + `approval_list` + the §13 detector flags on tasks.

---

## 14 · Color / state legend (consistent across screens)

| Element | Color |
|---|---|
| Member tint stripe | One per member, generated from agentId hash (matches reference: green/blue/orange/purple) |
| Status pill — running | Solid green |
| Status pill — paused/waiting | Soft yellow |
| Status pill — error/stopped | Red outline |
| Plan state — proposed | Blue |
| Plan state — approved | Green |
| Plan state — rejected | Red |
| Test verdict — passed | Green check |
| Test verdict — failed | Red x |
| Test verdict — not_run | Gray dash |
| Scope drift indicator | Amber warning triangle |
| No-op diff indicator | Amber warning triangle |
| Repeated test failures | Red dot pulse |

---

## 15 · Routing / state

- `/teams` — project picker
- `/team/:teamId` — workspace (default tab: Kanban panel scroll)
- `/team/:teamId/task/:taskId` — task detail (drawer over workspace)
- `/team/:teamId/runtime/:runtimeId` — runtime detail
- `/settings`, `/providers`, `/diagnostics`, `/inbox`, `/approvals` — modals

State: light Zustand store. Tabs persist in localStorage. Single SSE connection multiplexed across panes.

---

## 16 · What we already have in `toad-local/ui/`

[`Dashboard.jsx`](../ui/src/components/Dashboard.jsx) is one 934-line component covering most read-only surfaces (task list, runtime audit, cross-team messages, housekeeping events). It's the right starting set of API hooks but needs to be exploded into the multi-pane layout above. The hooks ([`useToadApi`](../ui/src/hooks/useToadApi.js), [`useToadEvents`](../ui/src/hooks/useToadEvents.js)) are reusable.

---

## 17 · Build sequence (when Claude Design returns HTML)

1. **App shell + tab strip + right rail** (skeleton). Wire `team_list` + `task_list` only.
2. **Project picker** screen. Wire recent-projects card grid.
3. **Team workspace** — left rail (logs + composer) + center kanban panel + right rail tasks.
4. **Task detail drawer** with description + comments + workflow-history. Skip diff/plan/validations panels in v1.
5. **Create Team modal**. Wire `team_create` + optional `team_launch`.
6. **Plan section** in task detail. Wire `task_plan_propose` / `_approve` / `_reject`.
7. **Diff section** in task detail. Wire to `task.review.diff` / `files` / `scopeDrift` / `noOpDiff`.
8. **Validations section** + `validation_run` button.
9. **Runtime detail drawer**. Wire `runtime_send_input` + SSE event tail.
10. **Approvals drawer**.
11. **Diagnostics drawer**.
12. **Cross-team inbox**.
13. **Notifications panel**.
14. **Settings**.
15. **Providers / setup modal**.

Each step ends with the same gate: backend regression still passes, real-Claude smoke still passes, no UI feature lands without the backend tool surface that powers it.
