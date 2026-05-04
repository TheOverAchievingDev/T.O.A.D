# Symphony AI — Agentic IDE North Star

**Status:** captured 2026-05-04 from product brainstorm. Authoritative source for "what is Symphony AI trying to be." All future feature work should map back to this doc.

---

## The pitch

> Symphony AI is an agentic IDE for building software with AI coding teams.
> Autonomous agents plan, code, test, review, and recover inside controlled
> task/worktree environments. Human developers get a full IDE cockpit to
> inspect, steer, debug, accept, reject, and understand every change.

Cursor is an editor with AI bolted on. Symphony is an orchestrator with an IDE wrapped around it. Different center of gravity.

## The rule (don't violate this)

```
IDE can show and edit.
Symphony decides state.
Git proves changes.
CI proves execution.
Review proves quality.
Human approves risk.
```

The IDE never owns truth. Every state change still goes through `LocalToolFacade` and lands in the SQLite event log. Editor cursors, expanded folders, open tabs are UI-local. Anything that affects the team or the codebase goes through the orchestrator.

## The mental model

```
┌─────────────────────────────────────────────────────────────┐
│ Top bar: project, branch/worktree, drift score, CI status   │
├───────────────┬─────────────────────────────┬───────────────┤
│ Task / Agent  │ Code editor / Markdown      │ Agent output  │
│ board         │ Diff / diagnostics          │ Review notes  │
├───────────────┴─────────────────────────────┴───────────────┤
│ Terminal / scripts / test runner / debug console            │
└─────────────────────────────────────────────────────────────┘
```

Center pane swappable: code editor, diff viewer, markdown spec editor, test output, debug view, drift report, review report.

## What the IDE adds

Beyond what slices 1+2 already ship:

- **Live changed-files panel** per task — shows changed-vs-planned, out-of-scope flags, error-bearing files
- **Real editor surface** — file tree, tabs, syntax highlighting, search, inline errors, formatting, diff view, markdown editing
- **Agent activity overlay** — for files an agent is editing, show which agent / which task / which step / change-line count + per-hunk accept/reject/explain controls
- **Keep / revert / checkpoint** — git-backed; checkpoint before agent starts, accept/revert per hunk or per task, save as patch
- **Inline diagnostics** — TS errors, lint, test failures, runtime exceptions; **distinguished from** orchestrator-run validation results (the orchestrator's verdict is what gates lifecycle, the IDE's is informational)
- **Markdown/spec workspace** — `/docs/`, `.symphony/` (or `.toad/`), Foundry kiro docs, ADRs, drift reports all editable in the same editor
- **Scripts + task runner** — user terminal (free) vs agent tool runner (gated). Same shell, different blast radius
- **Debug tools** — breakpoints, debug console, logs, runtime process view, test-failure reproduction, stack traces, port/process manager
- **Drift monitor in the gutter** — findings rendered as squigglies/decorations on the actual lines they describe, not just a side panel

## Architecture split

```
Symphony Core (existing)               IDE Surface (new)
─────────────────────────               ────────────────
task state                              editor UI
agent sessions                          file tree
role/tool permissions                   human terminal
worktrees                               markdown editing
diffs                                   diagnostics display
CI/test artifacts                       debug UI
review artifacts                        diff display
risk gates                              gutter decorations
drift score
audit trail
```

Boundary: **task worktree**. Both sides treat it as the source of truth. The IDE reads from it; the orchestrator writes to it via agents.

## Agent access model

Agents do NOT use the IDE like a human. They get tools:

```
read_file       run_test
write_file      run_lint
search_repo     create_review
get_diagnostics request_approval
get_diff        create_task
```

Human gets the IDE. Agents get the tool surface. This preserves the existing safety model — `roleAuthority`, risk classifier, §14 human-approval gate all keep working unchanged.

## Build phases

| Phase | What | Status |
|---|---|---|
| **1. Orchestration spine** | State machine, role/tool authority, CI/test artifacts, task schema, session/task link | **Mostly done** — slice 1 + slice 2 + existing infra |
| **2. Worktree-based IDE session** | `ide_session_{create,stop,list,health}` commands; per-task editor surface | NOT STARTED |
| **3. Main dev page (cockpit)** | Left: tasks/agents. Center: embedded editor. Right: agent output/review/drift. Bottom: terminal/scripts/tests | NOT STARTED — meaningful UI refactor; existing Workspace/Tasks/Drift/Foundry/Costs/Audit screens collapse into tabs/zones |
| **4. Live diffs + keep/revert** | Task diff viewer, accept/reject per hunk, revert task, checkpoint task — git-backed, NOT UI-local snapshots | NOT STARTED — depends on Phase 2 |
| **5. Diagnostics + debugging** | Inline diagnostics, test-failure mapping, logs, debug console, runtime process viewer | NOT STARTED — bigger lift; LSP integration; code-server might enter the picture here |
| **6. Agent-aware IDE features** | Ask agent about selection, send range to reviewer, generate test for function, explain current error, create task from diagnostic, create drift correction task from gutter marker | NOT STARTED — ties into drift slice 3 (correction tasks) |

## Tech-stack guidance

**Phase 2 starts with Monaco-in-Tauri**, NOT code-server. Reasons:
- Tauri's webview is already Chromium; Monaco loads as a regular React component
- Monaco gives us syntax highlighting, search, tabs, diff view, markdown out of the box
- No separate Node service to manage
- `model.deltaDecorations(...)` lets us paint drift findings + risk badges + agent-edit indicators as gutter markers — *with the same visual language as TypeScript errors*. This is a stronger UX than a side panel.
- LSP integration is achievable in-browser via [monaco-languageclient](https://github.com/TypeFox/monaco-languageclient) when we want it

**Phase 5 reconsiders** — when we need the full VSCode debugger, extension marketplace, or richer language-server support, evaluate code-server / OpenVSCode-server / Theia. Don't guess at it now.

**Don't fork VSCode.** Maintenance burden is enormous and rarely earns its keep for a small team.

## What changes about the existing UI

Slice-1 and slice-2 work shipped six "screens" via the SidebarNav: Workspace, Tasks, Foundry, Drift, Costs, Audit. Under the cockpit model these become **panels/zones inside one main view**, not full-screen takeovers. The TweaksPanel's existing layout-mode toggle (kanban vs chat-first vs org-chart) becomes the seed for "which IDE layout do you want today."

This is a meaningful UI refactor. Don't try to retrofit it incrementally — it deserves its own brainstorming round when Phase 3 picks up.

## What stays the same

- Backend stays where it is. `LocalToolFacade`, `dev-api-server.mjs`, the SQLite event log, all the existing commands (`task_*`, `team_*`, `drift_run`, etc) keep working unchanged.
- Tauri shell stays where it is — this is still a desktop-first app.
- The drift monitor + foundry + risk policy + GitHub auth + provider plan-auth + everything else slices 1-2 shipped: all stays. The IDE renders it; doesn't replace it.
- The MCP tool surface stays — agents see the same tools they already see, just running inside `ide_session`-scoped worktrees.

## Open questions for when we pick this up

- **Phase 2 first concrete task** — embed Monaco in a basic "code" tab + render the active task's worktree files. Bare minimum so we have a reading surface.
- **`ide_session` schema** — does it pin to a `task_id` like agents do? (Probably yes — same boundary applies.)
- **Markdown rendering** — Monaco can render markdown with syntax highlighting. Do we ALSO want a side-by-side preview pane like Cursor does? (Probably yes for spec/foundry docs.)
- **How do agents and the human edit the same file?** Last-write-wins is bad. Do we lock the file when the agent starts editing, surface a conflict marker, or queue the human's edits behind the agent's session? Worth real thought.
- **Diff hunks** — do we use git's hunk format or our own? Git's is well-understood and tools-compatible. Probably use git.
- **Terminal** — `xterm.js` is the obvious choice for the in-IDE shell. Spawn a real `pwsh.exe` / `bash` per session.
- **Cost** — embedding Monaco + adding LSP later + xterm.js + the Tauri shell will inflate the bundle. Worth tracking; not blocking.

## How this relates to the drift-followups tracker

The drift tracker (`2026-05-04-drift-followups-tracker.md`) is the canonical list of *what's left in the drift feature*. This doc is the canonical list of *where the product is heading*. Some drift items (slice 3 correction tasks, drift findings as gutter markers) are also Phase-3/Phase-6 items here — they're cataloged in both places. Drift slice 3 is a natural early Phase-3 win because it makes findings actionable inside whatever cockpit comes next.

## Naming note

The infrastructure-plugin-system idea note (`2026-05-04-infrastructure-plugin-system-idea.md`) and this doc are both "future direction" specs. They live alongside the implemented-feature specs but ARE NOT IMPLEMENTATION PLANS. Don't dispatch implementers against them. They exist to be referenced by future brainstorming rounds when those features are picked up.
