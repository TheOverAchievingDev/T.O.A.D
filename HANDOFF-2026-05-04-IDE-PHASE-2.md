# Session Handoff — IDE Phase 2 brainstorm in flight

**Date:** 2026-05-04 evening session.
**Session goal coming in:** "lets proceed in the best order you think."
**Status:** Two features merged to main this session; third (IDE Phase 2 Slice A) brainstormed up to Q2; halted for context-budget reasons.

> Read the long-running `HANDOFF-NEXT-AGENT.md` only if you need pre-2026-05-04 backstory. Everything you need to resume is below.

---

## 1. What shipped this session (both already on main)

### a. Plugin Slice 0+1 (Railway) — merged commit `fe73cb4`
Plugin infrastructure (registry, auth helpers, jobs/resources stores, secret redactor) plus the first concrete plugin (Railway, Postgres-only). 8 new MCP tools, two new SQLite tables, Settings → Plugins tab, secret-masking in agent activity stream, team-delete warning when live resources exist. Spec: `toad-local/docs/superpowers/specs/2026-05-04-plugin-slice-0-1-railway-design.md`. Plan: `toad-local/docs/superpowers/plans/2026-05-04-plugin-slice-0-1-railway.md`.

### b. Drift Monitor Slice 3 (correction-task generation) — merged commit `188f2aa`
Closes the loop from "engine reports drift" to "team fixes drift." Multi-select drift findings → editable modal → task lands in backlog with offending evidence baked in. In-flight findings excluded from score + skip LLM re-emit until correction hits done/rejected. New `correction_task_id` column on `drift_findings`, 3 new SqliteDriftStore methods (`linkCorrection` / `getCorrectionLinkages` / `reapResolvedCorrections`), engine pre-read + filter + reap hooks, `drift_correction_create` MCP command + role gate (architect/lead/human), new `CorrectionTaskModal.tsx`, DriftScreen multi-select + "Create correction task" action bar + green "Correction in progress" chip. Spec: `toad-local/docs/superpowers/specs/2026-05-04-drift-slice-3-correction-tasks-design.md`. Plan: `toad-local/docs/superpowers/plans/2026-05-04-drift-slice-3-correction-tasks.md`. Drift follow-ups tracker Section A is now fully ticked off.

**Final-review caught two real bugs that fixed in `188f2aa`:**
1. *Critical* — `reapResolvedCorrections` called `taskBoard.get()` but production boards expose `.getTask()`. Was a silent no-op; the entire auto-reap closing loop never fired in prod. Fixed; new regression test added.
2. *Important* — facade's `taskBoardAdapter` (used by `#driftCorrectionCreate` to bridge `taskBoard.appendEvent` ↔ the helper's `taskBoard.create` contract) dropped the caller's `idempotencyKey`, so retries created duplicate tasks. Fixed; `idempotencyKey` now threaded through.

---

## 2. Strategic ordering I proposed (user approved "take as long as need")

1. ✅ Drift Slice 3 (correction-task generation) — DONE
2. **▶ IDE Phase 2 Step 1 (Monaco bare reading surface)** — IN PROGRESS, brainstorming
3. Plugin Slice 2 (EAS) — exercises the unused `plugin_jobs` background-poller table
4. IDE Phase 2 Step 2 (live diffs + keep/revert per hunk) — leverages job patterns from #3
5. Plugin Slice 3 (Vercel) — pairs with IDE for in-editor PR previews
6. IDE Phase 5 (diagnostics + debug) when the rest settles

**Rationale for IDE Phase 2 next:** the north-star doc explicitly says Phase 2 wants more existing surface area to wrap around — we just shipped plugins + drift slice 3, so there's plenty of material. Phase 2 BEFORE Plugin Slice 2 means EAS background jobs + Vercel deploys can surface natively in the editor instead of being retrofitted later. Plugin Slice 2 (EAS) before Plugin Slice 3 (Vercel) because EAS validates the long-running-job pattern that's currently theoretical — better to find out if the design is wrong before building Vercel on top of it.

---

## 3. ▶ Where to resume — IDE Phase 2 Slice A brainstorming

The brainstorming skill is mid-flow. Two questions answered, several still to ask before the design proposal.

**North-star reference:** `toad-local/docs/superpowers/specs/2026-05-04-symphony-ide-north-star.md` — Phase 2 row + the "Phase 2 first concrete task" Open Question.

### Decisions locked so far

**Q1 (scope) — answer: A.** Just the bare reading surface. New "Code" SidebarNav entry, file tree of selected team's worktree, click a file → opens read-only in Monaco. NO editing, NO diffs, NO agent integration, NO markdown side-by-side preview, NO multi-tab, NO search. Estimated ~600 LOC, 2-3 days. Future slices (2.B editing, 2.C diff view, 2.D multi-tab/search, 2.E markdown preview, 2.F agent overlay) deferred — each gets its own brainstorming round.

**Q2 (UI placement) — answer: A.** New "Code" SidebarNav entry as a full-screen view next to Workspace / Tasks / Foundry / Drift / Plugins (← yes, Plugins shipped its own Settings tab, but other features got SidebarNav entries; Code follows that older pattern) / Costs / Audit / Settings. Reasons: clean isolated surface for validating Monaco-in-Tauri loads; doesn't collide with existing Workspace/TasksScreen logic; the Phase 3 cockpit refactor is its own brainstorming round per the north-star.

### Questions still to ask (in priority order)

**Q3 (worktree source).** When the operator opens "Code," what does the file tree show?

- A — **Team's `projectCwd`** (the main repo). Simplest. No task selector. Shows what's on disk.
- B — **Active task's worktree** (with a task picker dropdown). Matches the north-star's literal wording ("render the active task's worktree files"). Shows what an agent is editing right now.
- C — **Both, with a toggle.** Default to projectCwd; dropdown to switch to a task's worktree.

  Recommendation: **C.** Default to projectCwd (zero friction — pick a team, see code). Optional task picker for "show me what task X's agent is working on." Best of both demos. ~50 extra LOC over A.

**Q4 (file tree implementation).** Expanding folders, lazy-loading children, file-system watcher for live updates?

- A — **Static one-shot read of full tree at view-mount**, no watcher, manual refresh button. Simplest. Fine for slice A — operator can hit Refresh after an agent edits.
- B — **Static read + chokidar watcher** that re-reads tree on file changes. Live-updates as agents work. More plumbing.
- C — **Lazy-load children on folder expand** + watcher. Scales to huge repos but real complexity.

  Recommendation: **A.** Manual refresh is fine for slice A. The watcher lift belongs to a later sub-slice. Most repos are small enough that one-shot reads finish in <100ms.

**Q5 (file content delivery).** How does the UI fetch file contents?

- A — **New MCP command `ide_read_file({teamId, taskId?, relativePath})` returning `{content, encoding, sizeBytes}`.** Server-side reads, role-gated (read-only file access via existing roleAuthority — probably any role). Caps at e.g. 5 MB per file; rejects binary unless explicit override. Mirrors how every other Symphony surface works (no direct fs access from the React layer).
- B — **Direct fetch via dev-api-server static route `/files/<teamId>/<path>`.** Simpler; bypasses the facade. But: bypasses risk classifier, role authority, audit log. Inconsistent with the rest of the architecture.

  Recommendation: **A**, strongly. The facade is the authority point for everything else; the editor doesn't get a free pass.

**Q6 (Monaco bundle integration).** Monaco is large (~3-4MB minified). How does it ship?

- A — **`@monaco-editor/react` + the default CDN loader.** Easy. But: hits monaco's CDN at runtime; offline use breaks. Symphony is local-first.
- B — **`monaco-editor` + Vite's `?worker` syntax + manual webpack-style bundling.** Bundles Monaco into the Tauri app. Larger build (~+4MB to current ~400KB) but fully offline.

  Recommendation: **B.** Symphony is local-first; CDN loader violates the bedrock principle. The bundle bloat is real but acceptable for the IDE pivot.

**Q7 (read-only enforcement).** Slice A is read-only. How is this enforced?

- A — **Set Monaco's `readOnly: true` option.** Single config flag. User can still copy/paste, search, etc — just can't type.
- B — **Skip A; validate at file-write time** (since slice A doesn't have a save action anyway, the readOnly UX is just UI sugar).

  Recommendation: **A**. Free; keeps the cursor from blinking insertion points everywhere; future slices flip the flag when editing arrives.

After Q3-Q7, propose the design (architecture + components + data flow + testing strategy) → spec doc → plan → execute.

---

## 4. Open architectural questions to flag during the design proposal (not Q&A)

These came up while thinking but aren't decision-blockers — answer in the design doc itself:

- **`ide_session` schema (per north-star Open Q)**: do we even need the `ide_session_*` MCP commands the north-star lists for slice A? Probably no — slice A is read-only, no session state to track. The session concept enters when editing arrives (slice 2.B). For slice A, the editor surface is stateless: open Code → see file tree → click file → read.

- **TypeScript vs JavaScript for the new file-read backend module**: existing backend is `.js` ESM. New module follows same pattern.

- **CSP (Content Security Policy) for Tauri**: Monaco evaluates strings as JS for syntax highlighting. The current Tauri config may have CSP that breaks Monaco. Verify before committing — add `'unsafe-eval'` to script-src if needed (offline app, less worrying than a web app).

- **The "Code" tab needs an icon.** Existing IconName union doesn't include a "code" or "file-code" glyph. Add `code2` or similar to `Icon.tsx`, or reuse the existing `'code'` icon (which is already in the union — see line 7 of `ui/src/components/Icon.tsx`).

---

## 5. Mechanical resume protocol for the next agent

1. **Acknowledge the handoff:** read this file, confirm understanding.
2. **Re-enter brainstorming skill:** the user already invoked `superpowers:brainstorming` — the HARD-GATE remains in effect. Don't write code yet.
3. **Continue from Q3 (worktree source):** quote the question above and ask the user to pick A/B/C.
4. **Cycle through Q3–Q7:** one at a time, multiple-choice, lead with recommendation.
5. **Propose the design:** architecture, file structure, data flow, testing.
6. **Write spec to** `toad-local/docs/superpowers/specs/2026-05-04-ide-phase-2-slice-a-monaco-reading-surface-design.md`.
7. **Commit + ask for review.**
8. **Invoke writing-plans skill.**
9. **Execute via subagent-driven-development** (user's preferred pattern; pick `sonnet` model — `haiku` rejected long prompts earlier in the session). Worktree at `C:/toad-ide-phase-2/`, branch `feature/ide-phase-2-slice-a`.

---

## 6. Auto-mode rules in effect

Everything below from the user's slash-command preamble:
- "Auto mode is active. The user chose continuous, autonomous execution."
- "Execute immediately. Make reasonable assumptions and proceed on low-risk work."
- "Minimize interruptions — Prefer making reasonable assumptions over asking questions for routine decisions."
- "Prefer action over planning — Do not enter plan mode unless the user explicitly asks."
- "Expect course corrections — The user may provide suggestions or course corrections at any point."
- "Do not take overly destructive actions — Auto mode is not a license to destroy."

These do NOT override the brainstorming skill's HARD-GATE — design must be approved before implementation. They DO mean: minimize round-trips, lead with recommendations, batch questions only where the answer genuinely matters.

---

## 7. Project state cheat sheet

- **Repo root:** `C:/Project-TOAD/` (worktree on `main`)
- **Project subdirectory:** `C:/Project-TOAD/toad-local/` (the actual Symphony AI codebase; `npm test` from here)
- **Recent worktrees (cleaned up):** `C:/toad-plugins/` (plugin slice 0+1) and `C:/toad-drift-3/` (drift slice 3) — both removed via `git worktree remove`
- **Active branch:** `main`
- **Latest commits on main (newest first):**
  - `188f2aa` fix(drift): reap uses taskBoard.getTask + adapter forwards idempotencyKey
  - `ad10fae` ship(drift): slice 3 verified end-to-end
  - `fe73cb4` ship(plugins): slice 0+1 verified end-to-end
  - `ee0ac86` docs: drift slice 3 implementation plan
  - `fce1ef6` docs: drift slice 3 design
  - `52bbbab` docs: plugin slice 0+1 implementation plan
  - `ad2d4c3` docs: plugin slice 0+1 design
- **Test suite:** `cd toad-local && npm test` — should pass clean (~75+ test files, 0 failures)
- **UI typecheck:** `cd toad-local/ui && npx tsc --noEmit` — should pass clean
- **User email for git commits:** `kaydenraquel@gmail.com` (Co-Authored-By trailer: `Claude Opus 4.7 (1M context) <noreply@anthropic.com>`)

---

## 8. Things NOT to do

- ❌ Don't read the long `HANDOFF-NEXT-AGENT.md` unless you need pre-2026-05-04 context. The user has been pushing forward from there for a long time; that doc is historical record, not current state.
- ❌ Don't start implementation before the IDE Phase 2 design is approved — the brainstorming skill's HARD-GATE is real.
- ❌ Don't widen scope beyond Slice A (read-only viewer, no editing, no diffs). The user explicitly chose A on Q1.
- ❌ Don't add tests for the existing `localToolFacade.test.js` role-deny path on `drift_correction_create` (was flagged minor in final review — defer to a coverage-tightening sub-slice).
- ❌ Don't go public until the user says so. Earlier in the session the user said "we don't have to go public in a week, we can take as long as we need."

---

End of handoff. Good luck — Phase 2 is the strategic pivot point. Make it count.
