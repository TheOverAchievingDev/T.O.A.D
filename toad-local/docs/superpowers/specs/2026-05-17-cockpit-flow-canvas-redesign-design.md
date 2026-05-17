# Cockpit Flow-Canvas Redesign — Design

**Status:** Approved (brainstorm complete 2026-05-17)
**Area:** `toad-local/ui` only — front-end. NO backend / `dev-api-server` / drift / spanSummary change.

## 1. Goal

Finish the stalled "For Me → Flow" cockpit redesign by rebuilding the flow
canvas to match the operator-supplied mockup (`Symphony flow canvas.zip`),
adapted responsively to Symphony's real, dynamic team/task data, on top of the
other agent's already-built (uncommitted) flow **shell**. This also resolves the
current "flow renders but looks broken" defect (a CSS/markup mismatch).

## 2. Background & root cause

The other agent began a For-Me cockpit redesign and stalled (out of usage). Its
work is uncommitted in the working tree and is **typecheck-clean** with passing
pure-model tests:

- New pure models + passing `node:test` suites: `ui/src/components/cockpit/forMeViewMode.ts`
  (`'timeline' | 'flow'` toggle, localStorage `cockpit.forMe.viewMode`),
  `ui/src/components/cockpit/forMeFlowPanels.ts` (left/right panel
  collapsed/expanded state), `ui/src/components/flowCanvasModel.ts`
  (`buildFlowStages` — groups tasks by **status**).
- A built flow **shell** in `ui/src/components/cockpit/CockpitForMe.tsx`
  (`cockpit-for-flow-shell` grid → `cockpit-flow-side-left` Team panel →
  `cockpit-flow-main` → `cockpit-flow-side-right` inspector; the `viewMode==='flow'`
  branch; the Timeline/Flow toggle) + new shell/hero CSS in
  `ui/src/styles/cockpit.css`.

**Root cause of "looks broken":** the redesign restyled the *shell* and now
nests `<CockpitFlowCanvas>` inside `.cockpit-flow-main`, but
`CockpitFlowCanvas.tsx` was never updated — it still emits the *old* standalone
markup (`.flow-hero/.eyebrow/.flow-map/.flow-pipeline/.flow-stage/.flow-work-node/
.flow-agent-strip`) whose surviving `app-shell.css` rules were authored for the
old full-page flow, not a nested shell cell. Those viewport-scale rules collide
inside the new grid/flex shell.

The fix is not a CSS patch — per the operator we **finish the redesign** by
rebuilding the canvas to the mockup's design.

## 3. The mockup (operator's target)

Extracted to `toad-local/.mockup-symphony-flow/` (untracked, local reference
only — NEVER committed; deleted at end of implementation). It is a standalone
React-CDN prototype: absolute-positioned nodes + a full SVG bezier connector
engine + hardcoded sample data. The operator wants **parts of it**, adapted —
NOT a pixel clone, NOT the absolute-positioning/bezier engine.

**Adopted (operator-selected):**
- The **top ticker bar**: `● N live · N open · N in review · N blocked · N done`
  + a `DRIFT ▭▭▭ NN%` meter.
- **Per-agent pivot columns**: Lead Agent card + each member as a
  pipeline-ordered agent card, **each card with that agent's assigned tasks
  stacked vertically underneath it**.
- The **Lead Agent card** (left) + the end-of-pipeline **Done/Ready bucket**.
- **Approval / Drift warning cards** (amber), wired to real signals.
- **Light connector lines** (lead→agents fan, pipeline backbone, agent→tasks
  spine) — simple decorative lines derived from layout, NOT the bezier engine.

**Explicitly NOT adopted:** the canvas legend, the "All work / Needs attention /
Mine" filter toolbar, the absolute-positioning + full SVG bezier engine, the
mockup's `oklch` palette / `styles.css` (raw), the mockup's tweaks panel.

## 4. Scope

**In scope (`toad-local/ui` only):**
- Rewrite the pure model `ui/src/components/flowCanvasModel.ts` (+ its test)
  from status-grouping → **agent-pivot**.
- Rewrite `ui/src/components/CockpitFlowCanvas.tsx` to the mockup design,
  consuming the new model, rendered correctly nested in `.cockpit-flow-main`.
- Consolidate all flow-canvas CSS into `ui/src/styles/cockpit.css` using the
  project's existing design tokens; remove dead old standalone-flow rules from
  `ui/src/styles/app-shell.css`.
- Commit the other agent's stalled **foundation** that the flow depends on
  (`forMeViewMode.ts`/`forMeFlowPanels.ts` + their tests, the
  `CockpitForMe.tsx` flow-branch wiring, the `CockpitScreenV2.tsx` 1-line, the
  `cockpit.css` shell rules) — staged by explicit path.

**Reused unchanged (the stalled foundation — keep, do NOT clobber):**
`forMeViewMode.ts`, `forMeFlowPanels.ts` (and their passing tests); the
`CockpitForMe.tsx` shell structure + `viewMode==='flow'` branch + Timeline/Flow
toggle + collapsible Team panel + the right inspector; the timeline branch.

**Out of scope:** any backend / `dev-api-server` / drift-engine / spanSummary
change; the operator's separate **grid-view** track; the **Sub-project C** demo
changes in the working tree (`ui/src-tauri/src/main.rs`,
`ui/src-tauri/tauri.conf.json`, and all backend compaction files); the
right-inspector internals (kept as-is); the mockup absolute/bezier engine.

## 5. The pure model — `ui/src/components/flowCanvasModel.ts` (rewrite)

One deterministic, React-free, fully-unit-tested function over the real UI
types (`Team`/`Agent`, `UiTask`, `Runtime`, drift result).

**Real type facts (grounded in `ui/src/types/index.ts`):**
- `RoleId = 'lead' | 'developer' | 'reviewer' | 'researcher' | 'debugger' | 'qa' | 'architect' | 'designer'`
- `AgentStatus = 'thinking' | 'live' | 'idle' | 'launching' | 'error'`
- `TaskStatus = 'todo' | 'in-progress' | 'review' | 'done' | 'blocked' | 'rejected'`
- `RuntimeStatus = 'live' | 'idle' | 'launching' | 'stopped' | 'error'`
- `Agent`: `{ id, name, role: RoleId, avatar, status: AgentStatus, task: string|null, activity?: AgentActivity|null }`
- `UiTask`: `{ id, title, status: TaskStatus, assignee: string, type, riskLevel?, requiresHumanApproval?, humanApproved?, matchedRules? }`
- `Team`: `{ name, status, members: Agent[] }`; `Runtime`: `{ id, agent, provider, model, status: RuntimeStatus }`
- Drift result (from `useDrift`): `{ teamScore, perTaskScores: Record<string,number>, status }`

**Signature:**

```ts
buildFlowCanvas(input: {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  drift: DriftRunResult | null;
  // Injected so the model stays pure AND consistent with the rest of the UI.
  // Grounded from the existing DriftBadge/useDrift severity at impl time;
  // defaults to a no-op (returns false) so absence never fabricates warnings.
  isDriftElevated?: (score: number) => boolean;
}): FlowCanvasModel
```

**Output `FlowCanvasModel`:**

```ts
interface FlowCanvasModel {
  ticker: { live: number; open: number; inReview: number;
            blocked: number; done: number; driftPct: number | null };
  lead: {
    member: Agent; runtimeStatus: RuntimeStatus | AgentStatus;
    activity: string;            // resolved blurb
    coordinating: number;        // non-lead member count
  } | null;
  agents: Array<{
    member: Agent;
    runtimeStatus: RuntimeStatus | AgentStatus;
    statusLabel: string;
    activity: string;
    tasks: UiTask[];             // assignee===member.id, active only, stable order
    taskCount: number;
  }>;
  doneBucket: { count: number; recent: UiTask[] };  // recent = up to 5
  warnings: Array<{
    id: string;
    kind: 'approval' | 'drift';
    title: string; sub: string; desc: string;
    taskId?: string;
  }>;
}
```

**Rules (deterministic, total, never throws):**
- **Lead** = `members.find(m => m.role === 'lead') ?? members[0] ?? null`.
- **Pipeline order** of `agents` (non-lead members): sort by a fixed `RoleId`
  rank — `architect(0) → researcher(1) → developer(2) → debugger(3) →
  reviewer(4) → qa(5) → designer(6)`; any role not listed → rank `99`; ties
  broken by stable original `members` order. (The mockup's
  Architect/Developer/Reviewer/Tester maps here; Symphony has `qa`, not
  `tester`.)
- **`tasks` under an agent** = `tasks.filter(t => t.assignee === member.id &&
  t.status !== 'done' && t.status !== 'rejected')`, original order preserved.
- **`doneBucket`** = tasks with `status === 'done'`; `recent` = the last up-to-5
  by input order.
- **`ticker`**: `live` = runtimes whose `status` is `'live'|'launching'`;
  `open` = tasks with `status` not in `{done,rejected}`; `inReview` =
  `status==='review'`; `blocked` = `status==='blocked'`; `done` =
  `status==='done'`; `driftPct` = `drift ? drift.teamScore : null`.
- **`warnings`**: for each task with `requiresHumanApproval && !humanApproved`
  → `{kind:'approval', title:'Approval needed', sub:task.id,
  desc:task.title, taskId}`; for each `drift.perTaskScores[id]` whose score the
  app **already** treats as elevated → `{kind:'drift', title:`Drift on ${id}`,
  sub:'spec ≠ build', desc:'Build approach diverged; review suggested.',
  taskId:id}`. The drift threshold is **not invented here** — at implementation
  time it is grounded from the existing `DriftBadge`/`useDrift` severity logic
  and the model takes it as an injected predicate/threshold parameter so it
  stays pure and consistent with the rest of the UI. None → `[]` (honest empty
  — NO fabricated warnings).
- **`activity`** in model output = `member.activity?.label ?? ''` ONLY (pure;
  the model is deliberately not given `messages`/`agentStreams`). The component
  composes the *displayed* activity as `latestByAgent.get(id) ?? model.activity
  ?? <role fallback>` — the live message/stream blurb stays a component concern,
  keeping the model pure & small.
- Runtime lookup: a `Map(runtimes by runtime.agent → member.id)`; missing
  runtime → fall back to `member.status`.
- Edge cases yield well-formed empties: empty team → `lead:null, agents:[],
  doneBucket:{count:0,recent:[]}, warnings:[], ticker all 0/null`; lead-only →
  `agents:[]`; no drift → `driftPct:null, no drift warnings`; unassigned tasks
  → not under any agent (counted in ticker only); no runtimes → status from
  `member.status`.

## 6. The component — `ui/src/components/CockpitFlowCanvas.tsx` (rewrite)

Inbound props **unchanged** (`team, tasks, runtimes, messages, agentStreams,
selectedTaskId, selectedAgentId, driftData, onSelectTask, onSelectAgent,
onOpenTask, onOpenLogs, onCreateTask`). Calls `buildFlowCanvas({team, tasks,
runtimes, drift: driftData})` once via `useMemo`. Renders top→bottom inside the
existing `.cockpit-flow-main` cell:

1. **Ticker bar** — `model.ticker` rendered as `● N live · N open · N in review
   · N blocked · N done` + a `DRIFT` meter (`driftPct` → bar width + `NN%`;
   `null` → `-`). Distinct from the existing action strip (Pause/Resume/Add
   task/Run drift/Timeline·Flow toggle stays where the other agent placed it).
2. **Pipeline** — a horizontally-scrollable flex row:
   - **Lead column**: Lead Agent card (avatar, "Lead Agent", `lead.member.name`,
     resolved activity, `coordinating` agents stat) with the **warning cards**
     (`model.warnings`) stacked beneath; warning CTA ("Review now" / "Investigate")
     → `onSelectTask(taskId)` (or `onSelectAgent` for non-task) so the existing
     right inspector surfaces it. No new backend, no new handler.
   - **Agent columns** (from `model.agents`, pipeline order): agent card
     (avatar, `role`, `name`, status pulse+label via the existing
     `runtimeStatusClass`, activity line, footer = `taskCount` tasks + status —
     **no fabricated capacity bars**) with **that agent's task cards stacked
     vertically underneath**, joined by a light vertical spine. Task card =
     type icon + `T-id` + title + existing `TaskRiskBadge`/`DriftBadge` +
     marker chips.
   - **Done/Ready bucket** (rightmost): "Ready" card — `doneBucket.count` +
     the `recent` `T-id title` lines.
3. **Light connectors** — an `aria-hidden` decorative layer (lightweight inline
   SVG or CSS pseudo-elements) derived from the responsive flex layout (NO
   hardcoded coords, NO bezier engine): subtle lead→agents fan, pipeline
   backbone between agent columns, agent→tasks vertical spine.
4. **Interactions preserved exactly:** single-click → `onSelectAgent` /
   `onSelectTask`; double-click task → `onOpenTask`; double-click agent →
   `onOpenLogs(runtime.id)` when a runtime exists; the existing
   `team.members.length===0 && activeTasks.length===0` empty state ("No active
   team graph" + Create-task CTA) is preserved.
5. **Activity blurb** reuses the current component's `latestByAgent` memo
   (newest stream/message) with `member.activity?.label` fallback (kept in the
   component — pure model stays message/stream-free).

## 7. Styling

- Consolidate **all** flow-canvas CSS into `ui/src/styles/cockpit.css`,
  authored for the nested, scrollable `.cockpit-flow-main` context (the canvas
  scrolls within its grid cell; the ticker is a non-scrolling canvas header;
  the pipeline row is the horizontal scroll area).
- Use the project's **existing design tokens** (role colors via the existing
  `roleStyle()`, `var(--clay)`, `var(--font-display)`, status-dot / surface /
  border tokens) to render the mockup's dark aesthetic. Do **NOT** raw-import
  the mockup's `oklch` palette or its `styles.css`.
- Remove the now-dead old standalone-flow rules from
  `ui/src/styles/app-shell.css` — **only** classes no other component
  references (verified during planning by grepping component usages);
  `app-shell.css` otherwise byte-stable.
- Net: one component ↔ one consolidated flow stylesheet inside the existing
  shell. This is what fixes the original "looks broken" mismatch.

## 8. Testing

- **Pure-model TDD** — `ui/test/flowCanvasModel.test.mjs` (rewrite), `node
  --test` (same harness as the existing `.mjs` ui tests). Covers: pipeline
  ordering (lead-first; the role rank; unmapped→99; stable same-role); tasks
  filtering (assignee match, active-only, excludes done/rejected, stable);
  `doneBucket` (count + recent≤5); `ticker` (each count + driftPct null/number);
  `warnings` (approval, drift threshold, empty when none); edge cases (empty
  team, lead-only, no tasks, no drift, unassigned tasks, no runtimes); total /
  never throws. Strict red→green.
- The existing `forMeViewMode`/`forMeFlowPanels` tests stay green (unchanged).
- **Component** (view-layer; no GUI e2e harness for the Tauri app — consistent
  with how the foundation models were verified): `cd ui && npm run typecheck`
  **clean (zero TS errors)** and `npm run build` **passes**.
- Regression guard (no backend change, cheap safety): root `node
  scripts/run-test-suites.mjs` stays **fail 0**.

## 9. Commit decomposition — 2 commits (pure-core-first, the project's cadence)

- **Commit 1 — pure models:** `ui/src/components/flowCanvasModel.ts` (rewrite)
  + `ui/test/flowCanvasModel.test.mjs` (rewrite), AND the stalled foundation
  pure models the flow depends on: `ui/src/components/cockpit/forMeViewMode.ts`,
  `ui/test/forMeViewMode.test.mjs`, `ui/src/components/cockpit/forMeFlowPanels.ts`,
  `ui/test/forMeFlowPanels.test.mjs`. All `node --test` green.
- **Commit 2 — components + styling:** `ui/src/components/CockpitFlowCanvas.tsx`
  (rewrite), `ui/src/components/cockpit/CockpitForMe.tsx` (the stalled
  flow-branch shell wiring), `ui/src/components/cockpit/CockpitScreenV2.tsx`
  (the 1-line), `ui/src/styles/cockpit.css`, `ui/src/styles/app-shell.css`.
  `typecheck` + `build` green.

**Commit-hygiene gate (hard, controller-verified — the P3b-2 lesson):** each
commit stages **only** its explicitly enumerated paths (`git add <exact
paths>`, never `-A`/`.`). Before each commit the controller independently:
(a) `git diff --cached --name-only` shows exactly the intended set;
(b) greps the staged `CockpitForMe.tsx`/`forMeViewMode.ts`/`forMeFlowPanels.ts`
for any **grid-view** symbols/markup → confirms NONE (no clobber of the
operator's grid track; `forMeViewMode` is `'timeline'|'flow'` only);
(c) confirms **no Sub-project C** file (`src-tauri/main.rs`,
`tauri.conf.json`, backend) and **no** `.mockup-symphony-flow/` is staged;
(d) post-commit `git show --stat HEAD` == exactly the intended files;
out-of-scope diff EMPTY for `toad-local/src` (backend untouched).

## 10. Coordination with the operator's grid-view track

`CockpitForMe.tsx` is the likely shared file. The operator confirmed (brainstorm
decision) their grid-view edits are not yet in these foundation files. The
commit-hygiene gate's grid-view grep is the safety net. After Commit 2 the
controller hands the operator the exact committed file list so the grid track
can rebase/coordinate cleanly. `forMeViewMode.ts`'s mode union stays
`'timeline' | 'flow'` (no `'grid'`) — grid is the operator's separate addition,
not introduced or blocked here.

## 11. Conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed
paths, `git -c commit.gpgsign=false`, trailer
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
Subagent-driven execution: fresh implementer per task, two-stage review
(spec-compliance then code-quality), controller independently verifies every
DONE; the canvas-component rewrite + the commit-hygiene gate are the epicenters.
The `.mockup-symphony-flow/` extraction is a local visual reference for
implementers and is deleted before completion (never committed).
