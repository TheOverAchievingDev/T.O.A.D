# UI re-envisioning — Phase 3 implementation plan (Per-screen polish)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 2's deferred Cockpit items (Monaco editor + real file tree + bottom-panel content) and bring each per-screen experience (Foundry, Code, Tasks, Drift, Costs, Audit, Settings) up to spec §8.2-§8.8. Phase 4 (discoverability — `?` help panel, first-time cards) lands after.

**Architecture:** All Phase 3 work is additive — no architecture changes. We reuse Phase 1 + 2 primitives (PaneSplitter, BottomPanel, AgentCard, FileTabs, Inspector) and the existing project hooks (`useToadData`, `useDrift`, `useTweaks`). Existing screens get rewrites in place; new screens (Audit) live alongside.

**Tech Stack:** Same as Phase 1+2. New runtime adds for Phase 3a: `@monaco-editor/react` if not already a dep — verify by reading current `IdeEditorPane.tsx` integration in Task 3a-1.

**Reference:** Mockup at `Reference material/Claude Design Mockup/` for visual targets, spec `docs/specs/2026-05-11-ui-re-envisioning-design.md` §§8.2-8.8 for per-screen IA.

**Out of scope for Phase 3:** Phase 4 patterns (`?` help panel, first-time-on-screen cards, did-you-know toasts). Real backend changes to enable per-call cost tracking (Phase 5 candidate). Drag-to-resize beyond what PaneSplitter already provides. Anything in `docs/FUTURE-IDEAS.md` other than this phase's explicit scope.

**Independently shippable sub-phases:** Each of 3a-3e ships independently. Pause and re-plan if any sub-phase reveals scope creep.

---

## Sub-phases & tasks

### Phase 3a — Cockpit completion (5 tasks)

Finishes Phase 2's deferred items. The persona swap is shipped, but the WITH-me Cockpit's editor + file tree + bottom panel are placeholders. This sub-phase swaps them for real implementations.

- [ ] **Task 1: Wire `IdeFileTree` into WITH-me left rail**
  - File: `ui/src/components/cockpit/CockpitWithMe.tsx`
  - Replace the placeholder "File tree lands in Phase 3" div with the existing `IdeFileTree` component from `ui/src/components/IdeFileTree.tsx`.
  - File tree sits ABOVE the agent cards in the left rail (per spec §8.1 WITH-me: "file tree at top + agent cards stacked below in a collapsible section").
  - PaneSplitter (vertical) splits the left rail into tree (top) | agents (bottom, collapsible).
  - File tree's `onSelect(path)` adds the path to `openFiles` state, sets `activePath`.
  - Verify build + manual smoke — selecting a file opens a tab in FileTabs.

- [ ] **Task 2: Wire `IdeEditorPane` (Monaco) into WITH-me editor body**
  - File: `ui/src/components/cockpit/CockpitWithMe.tsx` `EditorRegion`
  - Replace placeholder with `IdeEditorPane` reading `activePath`.
  - Editor consumes the existing project's file-read MCP path (whatever IdeEditorPane already uses on the Code screen).
  - In-scope-for chip on FileTabs activates when the file matches an active task's `allowedFiles` contract — wire from `tasks` array.

- [ ] **Task 3: Real BottomPanel slots — Terminal (xterm/PTY placeholder), Validations (existing runner), Problems / Output (live event tap)**
  - File: `ui/src/components/cockpit/CockpitWithMe.tsx`
  - **Terminal slot**: For Phase 3, render a stub showing "Terminal coming in Phase 5" — actual xterm/PTY wiring is its own slice. Keep the slot prop so a future PR can drop a real terminal in.
  - **Validations slot**: extract the validation runner UI from the old retired CockpitScreen.tsx git history; wire to the existing `validation_run` MCP method. Active task's id comes from CockpitWithMe state (extend to track `selectedTaskId`).
  - **Problems slot**: derive from `IdeEditorPane`'s LSP/diagnostics events if available; else show empty state.
  - **Output slot**: tap `agentStreams` and render the most recent 50 tool-call outputs across all agents.

- [-] **Task 4: Drag-to-reorder FileTabs — DEFERRED**
  - File: `ui/src/components/cockpit/FileTabs.tsx`
  - **Status:** Deferred. Phase 3a Task 2 swapped CockpitWithMe to render the existing IdeEditorPane (which manages its own internal tabs) instead of our FileTabs primitive. FileTabs has no active consumer; adding drag-reorder ships dead-code complexity.
  - **Revive when:** a future task re-introduces FileTabs as the active editor-tab UI (e.g. to add the in-scope-for chip + drag-reorder on top of a custom editor surface). The Phase 2 commit history preserves the component for that day.
  - Plan: revisit during Phase 4 or 5 if user demand surfaces; otherwise this task closes on the FileTabs primitive's eventual deletion.

- [ ] **Task 5: Task lifecycle events in FlowTimeline projection**
  - File: `ui/src/components/cockpit/timelineProjection.tsx`
  - Today: only stream entries + drift score changes. Phase 3 adds task lifecycle transitions.
  - Source: `task_events` history — needs the backend to expose recent transitions via a new MCP method (`task_events_list_recent({ teamId, limit })`) OR derive from existing `tasks` array by comparing snapshots over time (cheaper, smaller risk; pick this).
  - Render: "lead created t_44 — refactor checkout flow and assigned dev-2", "reviewer-1 approved api/orders/route.ts", "dev-1 finished t_40".

**Phase 3a ship marker** — completes Phase 2's "what's still placeholder" list.

### Phase 3b — Tasks screen polish (3 tasks)

- [ ] **Task 6: Group-by toggle**
  - File: `ui/src/components/TasksScreen.tsx`
  - Toggle in the screen header: by status (default), by assignee, by type (feature / bug / correction), by risk class.
  - Each grouping rerenders the same kanban-style columns with different grouping keys.
  - Persist selection to `tweaks.tasksGroupBy`.

- [ ] **Task 7: Inline create**
  - File: `ui/src/components/TasksScreen.tsx`
  - Add-task input pinned to the top of the screen. Enter creates a minimal task (title + default type=feature); modal still available for richer cases via the `+` button.
  - Calls existing `task_create` MCP method.

- [ ] **Task 8: Saved filter chips**
  - File: `ui/src/components/TasksScreen.tsx`
  - Chips at the top: "My work" / "Blocked" / "In review" / "Done this week" / "All".
  - Filters apply on top of the grouping. Persist active chip to `tweaks.tasksFilter`.

### Phase 3c — Foundry polish (3 tasks)

- [x] **Task 9: Visible provider switcher at session start — ALREADY SHIPPED**
  - File: `ui/src/components/FoundryScreen.tsx`
  - Spec said "surface a 'Plan with Claude / GPT / Gemini' choice up front." Re-check on 2026-05-12 found this is already in place — the new-session row (`.foundry-create`) has a `<select>` next to the title input with Claude / Codex options, value bound to `newSessionProvider` state, dispatched via the `foundry_session_create` MCP call.
  - No change required. Phase 3c Task 9 closes as already-done.

- [ ] **Task 10: 7-phase progress map (left rail)**
  - File: `ui/src/components/FoundryScreen.tsx`
  - Vertical progress indicator down the left side showing: brief → tech_spec → roadmap → tasks → architecture → risks → kickoff.
  - Highlights the current phase, checkmarks completed phases.
  - Click jumps to that phase's draft doc in the right panel.

- [x] **Task 11: Inline doc editing — ALREADY SHIPPED**
  - File: `ui/src/components/FoundryScreen.tsx`
  - Spec said "existing artifacts panel is read-only mock; convert to editable textarea." Re-check on 2026-05-12 found the artifacts panel is ALREADY a working editor: `<textarea>` bound to `artifactDraft` state, Save button that calls `foundry_artifact_upsert`, status chip + version display in `.foundry-editor-bar`.
  - Decision: dropped the "WITH-me only" gating that was in the spec. Foundry is collaborative project planning even for FOR-me users; reading the docs as read-only and editing them are both fair operator activities. Locking the editor behind a persona toggle would frustrate without protecting anything (artifacts are drafts, not destructive). If a future scenario surfaces where edits are dangerous, we can re-add the gate.
  - No change required. Phase 3c Task 11 closes as already-done.

### Phase 3d — Code screen polish (3 tasks)

- [ ] **Task 12: File tree search box**
  - File: `ui/src/components/CodeScreen.tsx` + `ui/src/components/IdeFileTree.tsx`
  - `Ctrl+P` quick-open file by name. Search input above the tree.
  - Fuzzy match against the existing tree's flat path list.
  - Result highlight shows match positions.

- [ ] **Task 13: Task badge on editor header**
  - File: `ui/src/components/IdeEditorPane.tsx` (modify) + `ui/src/components/CodeScreen.tsx`
  - When the active file path matches an active task's `allowedFiles` contract, render a chip in the editor header: "in scope for t_42 · authored by dev-1".
  - Derives from existing `tasks` array.

- [ ] **Task 14: AI suggestions rail (right side, when agent active)**
  - File: `ui/src/components/CodeScreen.tsx`
  - When `agentStreams` shows an agent edited the active file in the last 60s, render a slim right rail (160px) showing their most recent action: "dev-1 just added bulk-quantity validation".
  - Cursor-style "ghost" suggestion treatment. Closes when agent goes idle.

### Phase 3e — Drift / Costs / Audit / Settings polish (4 tasks)

- [ ] **Task 15: Drift narrative banner**
  - File: `ui/src/components/DriftScreen.tsx`
  - Plain-English summary banner at the top: *"Score 31%, watch level. 3 active findings, mostly architecture. No new findings since 2h ago."*
  - Replaces the raw "Last 3 runs · peak 31% · current 31%" line.
  - Pure presentation — data already in `drift.data`.

- [ ] **Task 16: Costs estimated vs actual**
  - File: `ui/src/components/CostsScreen.tsx`
  - Split the top metric: **Estimated** (what the planning agent projected) vs **Actual** (what's been spent).
  - The gap is the headline number — "18% under budget" / "23% over."
  - Per-agent bars show actual usage broken down by role.
  - Power-user mode adds per-call breakdown table.

- [ ] **Task 17: Audit screen (new)**
  - File: `ui/src/components/AuditScreen.tsx` (new)
  - Filterable table of all events (task / runtime / approval / drift / cost).
  - Filters: time range + event type + team + agent.
  - Click row → JSON inspector panel right side.
  - Export to JSON / CSV.
  - Mount in App.tsx behind the existing `'diagnostics'` screen key (renamed in label only — Phase 1 already shows "Audit" in the sidebar).
  - WITH-me only. FOR-me users land on a cushion: "Audit log shows every event. Most users don't need this. Open in power-user mode if you do."

- [ ] **Task 18: Settings two-pane with grouped sticky sub-nav**
  - Files: `ui/src/components/settings/SettingsScreen.tsx` + `SettingsLayout.tsx`
  - Left sticky sub-nav grouped: **You** (General / Account / Notifications), **Project** (Workspace / Foundry / Drift / Risk policy), **Providers & integrations** (Providers / GitHub / MCP / Plugins), **Advanced** (Advanced / About).
  - Right pane shows the selected sub-section.
  - Replaces today's flat-scroll Settings.

**Phase 3 ship marker** — closes per-screen polish. Phase 4 (discoverability) unblocks next.

---

## Sequencing rationale

3a first because it finishes Phase 2's visible placeholders — the WITH-me Monaco / file tree / bottom panel content gaps are what a user notices immediately after Phase 2 ship. 3b-3e are independent in any order; alphabetical by screen for predictability.

Within 3a: file tree (Task 1) before editor (Task 2) because the editor needs `activePath` from tree selection. Bottom panel slots (Task 3) after editor wires because Validations / Problems / Output draw from editor + agent state. Drag-reorder (Task 4) is standalone polish. Lifecycle events (Task 5) is standalone enrichment.

## Risk register

- **Monaco prop graph (Task 2)**: `IdeEditorPane` is heavily used by the Code screen. If its props don't map cleanly to CockpitWithMe's needs, write a thin adapter component rather than touching IdeEditorPane directly. Worst case: keep the placeholder for Phase 3 and tackle Monaco in a Phase 5 slice.
- **Task lifecycle events (Task 5)**: deriving from `tasks` snapshot deltas is cheap but loses event detail (who triggered the transition). If the projection looks too synthetic, expose a new MCP method `task_events_list_recent` — backend addition. Defer if the cheap path produces good-enough narration.
- **Foundry inline editing (Task 11)**: changes the artifact panel from a read-only display to a stateful editor. Reload behavior (what happens when an artifact is regenerated by the agent while user is mid-edit?) needs a clear rule. Phase 3 can ship "agent regenerate overwrites local edits, with a warning toast"; Phase 4+ can add merge UI.
- **Audit screen (Task 17)**: full event log table can render a LOT of rows. Use virtualization (`react-window` or similar) if the list crosses ~1000 events. If virtualization adds too much complexity, cap the visible window to last 500 events with a "load more" button.
