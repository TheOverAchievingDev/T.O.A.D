# UI re-envisioning — Phase 2 implementation plan (Cockpit redesign)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Cockpit per `docs/specs/2026-05-11-ui-re-envisioning-design.md` §8.1 — a calm three-column FOR-me observation layout for the default audience, and a Cursor-style WITH-me code-first layout with file tabs, Monaco editor, real resizable bottom panel (terminal / problems / output / validations), and an optional Agent Inbox right panel for power users.

**Architecture:** New Cockpit components live under `ui/src/components/cockpit/` so the existing 1,132-line `CockpitScreen.tsx` can stay intact while the new one is built. Once Task 11 verifies the new path, Task 12 retires the old. The persona toggle (`tweaks.developerMode`) drives which layout renders. Both layouts compose from a shared set of primitives (PaneSplitter, AgentCard, BottomPanel).

**Tech Stack:** Same as Phase 1 — React 18 + TypeScript + Vite + Tauri 2. New runtime dependency: `@monaco-editor/react` (or whichever Monaco wrapper the existing `IdeEditorPane` uses; verify in Task 7 before adding). All other behavior reuses existing hooks (`useToadData`, `useDrift`, drawer toggles) and components (`AgentInbox.tsx`, `IdeEditorPane.tsx`, `IdeFileTree.tsx`).

**Reference:** Clickable mockup at `Reference material/Claude Design Mockup/Symphony.html` — open in a browser to see the target visual + interaction shape. The mockup's `cockpit.jsx` is the layout spec; `styles.css` provides per-component styles to port verbatim where possible.

**Out of scope for Phase 2:** Foundry / Code / Tasks / Drift / Costs / Audit / Settings screen redesigns (those are Phase 3). The `?` help panel + first-time-on-screen cards (Phase 4). Real drag-to-resize Monaco split groups (Phase 3 polish on Code screen).

**Independently shippable sub-phases:** Phase 2a (foundations: pane splitter + bottom panel + menubar wiring) is shippable alone. Phase 2b (FOR-me) is shippable on top of 2a. Phase 2c (WITH-me) is shippable on top of 2b. Phase 2d (migration + ship marker) closes Phase 2. If any sub-phase reveals scope creep, ship what's done and re-plan the rest.

---

## File structure

**Create (new components under `ui/src/components/cockpit/`):**

- `cockpit/PaneSplitter.tsx` — generic horizontal/vertical resizable splitter; persists size to a tweak key
- `cockpit/AgentCard.tsx` — single-agent card (status dot + name + role + current task + spark indicator); used in both modes
- `cockpit/BottomPanel.tsx` — Terminal / Problems / Output / Validations tabs in a resizable+collapsible bottom strip
- `cockpit/FlowTimeline.tsx` — plain-English vertical event timeline (FOR-me center)
- `cockpit/Inspector.tsx` — right-column Task / Agent / Drift tabbed inspector (FOR-me right)
- `cockpit/FileTabs.tsx` — Cursor-style tab strip across top of editor pane (WITH-me center)
- `cockpit/AgentInboxPanel.tsx` — right-panel wrapper around the existing `AgentInbox.tsx` (WITH-me optional right)
- `cockpit/CockpitForMe.tsx` — three-column FOR-me assembly
- `cockpit/CockpitWithMe.tsx` — two-column + bottom + optional right WITH-me assembly
- `cockpit/CockpitScreenV2.tsx` — top-level switch on `developerMode` rendering ForMe or WithMe
- `ui/src/styles/cockpit.css` — all Phase 2 Cockpit styles, ported from the mockup's `styles.css` cockpit-related sections

**Modify:**
- `ui/src/App.tsx` — swap `<CockpitScreen ... />` for `<CockpitScreenV2 ... />` at the existing call site (Task 12). Wire the menubar's Toggle Sidebar / Bottom / Right Panel actions to real state (Task 3). Wire Run-menu Team operations to real handlers (Task 3).
- `ui/src/styles/index.css` — import `cockpit.css` after `chrome.css`.

**Delete (Task 12 cleanup):**
- `ui/src/components/CockpitScreen.tsx` — retired once V2 is wired and smoke-verified.

---

## Phase 2a — Foundations (Tasks 1-3)

### Task 1: PaneSplitter primitive

**Files:**
- Create: `ui/src/components/cockpit/PaneSplitter.tsx`
- Modify: `ui/src/styles/cockpit.css` (add splitter styles)

- [ ] **Step 1.1: Component signature**

```tsx
export type SplitOrientation = 'horizontal' | 'vertical';
export interface PaneSplitterProps {
  orientation: SplitOrientation;
  /** Default size of the FIRST pane (px for fixed, % for flex-grow). */
  defaultSize: number;
  /** Min/max in px to clamp the drag. */
  minSize?: number;
  maxSize?: number;
  /** Persistence key (e.g. 'cockpit.formMe.leftCol') → localStorage. */
  storageKey?: string;
  /** Optional collapse button — when true, splitter shows a tiny chevron
   *  on the divider that collapses the first pane to 0. */
  collapsible?: boolean;
  children: [ReactNode, ReactNode];
}
```

- [ ] **Step 1.2: Implementation** — `useState` for current size, `useEffect` to read storageKey on mount, mousedown on the divider starts a drag, mousemove updates size with clamp, mouseup persists to localStorage.

- [ ] **Step 1.3: CSS** — `.pane-splitter`, `.pane-splitter-divider` (4px wide on horizontal, 4px tall on vertical), hover state in `--clay`, drag cursor.

- [ ] **Step 1.4: Manual verify** — render two `<div>` siblings, drag the divider, refresh, size persists.

- [ ] **Step 1.5: Commit**

```
feat(ui): Phase 2 Task 1 — PaneSplitter primitive

Generic horizontal/vertical drag-resize splitter with localStorage
persistence. Used by every Phase 2 layout (FOR-me three-column,
WITH-me code-first, BottomPanel resize).
```

### Task 2: BottomPanel

**Files:**
- Create: `ui/src/components/cockpit/BottomPanel.tsx`
- Modify: `ui/src/styles/cockpit.css` (BottomPanel styles)

- [ ] **Step 2.1: Component**

```tsx
export type BottomPanelTab = 'terminal' | 'problems' | 'output' | 'validations';
export interface BottomPanelProps {
  open: boolean;
  onToggle: (open: boolean) => void;
  activeTab: BottomPanelTab;
  onChangeTab: (tab: BottomPanelTab) => void;
  /** Each tab's content rendered when active. */
  terminalSlot?: ReactNode;
  problemsSlot?: ReactNode;
  outputSlot?: ReactNode;
  validationsSlot?: ReactNode;
  /** Resizable height in px when open. Persisted via tweak. */
  height: number;
  onChangeHeight: (h: number) => void;
}
```

Header strip: 32px row with the four tabs (Cursor-style — each tab has its name + a kind picker for Terminal/Validations), action icons on the right (`+ new terminal`, `split`, `kill`, `close panel`). When `open === false`, only the tab strip shows (collapsed); clicking a tab opens.

- [ ] **Step 2.2: Wire `tweaks.showBottomPanel: boolean` + `tweaks.bottomPanelHeight: number` + `tweaks.bottomPanelTab: BottomPanelTab`** in `ui/src/hooks/useTweaks.ts` defaults.

- [ ] **Step 2.3: Manual verify** — drag-resize works, collapse hides content, close clears all four slots, the menubar `View → Toggle Bottom Panel` (`Ctrl+J`) flips it.

- [ ] **Step 2.4: Commit**

### Task 3: Menubar action wiring + tweaks for panels

**Files:**
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/hooks/useTweaks.ts` (add `showBottomPanel`, `showSidebar`, `showRightPanel`)

- [ ] **Step 3.1: Add tweaks** — defaults: `showBottomPanel: true`, `showSidebar: true`, `showRightPanel: false`, `bottomPanelHeight: 220`, `bottomPanelTab: 'terminal'`, `rightPanelAgent: string | null`.

- [ ] **Step 3.2: Wire `handleMenuAction` in App.tsx** — replace the three no-op cases with real `setTweak` calls.

```tsx
function handleMenuAction(a: MenuAction) {
  switch (a) {
    case 'devmode':
      setTweak('developerMode', !(tweaks.developerMode === true));
      return;
    case 'sidebar':
      setTweak('showSidebar', !(tweaks.showSidebar !== false));
      return;
    case 'bottom':
      setTweak('showBottomPanel', !(tweaks.showBottomPanel !== false));
      return;
    case 'right':
      setTweak('showRightPanel', !(tweaks.showRightPanel === true));
      return;
  }
}
```

- [ ] **Step 3.3: Wire keyboard shortcut for Ctrl+J** — already in the useEffect skeleton; uncomment/expand to call `handleMenuAction('bottom')`.

- [ ] **Step 3.4: Wire Run menu items** — Start/Resume Team → existing team_launch handler, Pause Team → team_pause (verify exists), Run Drift Check → `drift.refresh('manual')`, Run Validations → existing validation_run path, Approve Pending → setTweak('showApprovals', true).

- [ ] **Step 3.5: Apply `showSidebar` to SidebarNav rendering** — conditionally render `<SidebarNav />` based on tweak.

- [ ] **Step 3.6: Manual verify** — `Ctrl+B` hides sidebar, `Ctrl+J` toggles bottom panel (placeholder until Task 2 lands), `Ctrl+Alt+I` toggles right panel state.

- [ ] **Step 3.7: Commit**

---

## Phase 2b — Cockpit FOR-me (Tasks 4-7)

### Task 4: AgentCard

**Files:**
- Create: `ui/src/components/cockpit/AgentCard.tsx`
- Modify: `ui/src/styles/cockpit.css`

- [ ] **Step 4.1: Component**

```tsx
export interface AgentCardProps {
  agent: TeamMember;              // existing type from useToadData
  runtime?: Runtime | null;       // current runtime status
  currentTask?: UiTask | null;
  active?: boolean;
  onSelect: (agentId: string) => void;
}
```

Render: 28px circular avatar (initials), name + role label, current task ID + short title, spark indicator (4 dots filled by status), status dot color-coded by role.

- [ ] **Step 4.2: Styles** — port `.agent-card`, `.agent-card.active`, `.avatar`, `.status`, `.spark` from mockup's `styles.css` cockpit sections.

- [ ] **Step 4.3: Commit**

### Task 5: FlowTimeline (FOR-me center)

**Files:**
- Create: `ui/src/components/cockpit/FlowTimeline.tsx`
- Modify: `ui/src/styles/cockpit.css`

- [ ] **Step 5.1: Component**

```tsx
export interface TimelineEvent {
  id: string;
  when: string;                   // relative time string ("just now", "2 min", "1h ago")
  dot: 'clay' | 'green' | 'blue' | 'amber' | 'violet';
  expanded?: boolean;
  body: ReactNode;
}
export interface FlowTimelineProps {
  events: TimelineEvent[];
  /** Active task title rendered as the "What's happening" hero above
   *  the timeline. */
  activeTaskHero?: { id: string; title: string; subline: string };
}
```

- [ ] **Step 5.2: Plain-English projection** — Given the raw `agentStreams` + `tasks` data, produce TimelineEvent[]. Each event renders like:
  > `dev-1` is editing `ui/src/components/OrderForm.tsx` — adding bulk-quantity validation for box subscriptions.

  The projection function lives in `cockpit/timelineProjection.ts` (new file). Inputs: tasks, runtimes, agentStreams, drift findings. Output: TimelineEvent[].

- [ ] **Step 5.3: Styles** — port `.timeline`, `.tl-event`, `.tl-event.expanded`, `.when`, `.marker`, `.dot.*color*`, `.body`, `.meta` from mockup.

- [ ] **Step 5.4: Commit**

### Task 6: Inspector (FOR-me right)

**Files:**
- Create: `ui/src/components/cockpit/Inspector.tsx`
- Modify: `ui/src/styles/cockpit.css`

- [ ] **Step 6.1: Component**

```tsx
export type InspectorTab = 'task' | 'agent' | 'drift';
export interface InspectorProps {
  activeTab: InspectorTab;
  onChangeTab: (tab: InspectorTab) => void;
  selectedTask: UiTask | null;
  selectedAgent: TeamMember | null;
  driftSummary?: { teamScore: number; status: string; topFindings: DriftFinding[] };
  agentRuntimes: Map<string, Runtime>;
}
```

Each tab renders a rich card matching the mockup's screenshot you sent earlier:
- **Task**: id chip + feature/bug-fix/correction chip + status chip; title; description; progress bar with ETA; assignees with status; validations table (lint/typecheck/test/build with pass/flaky/not-run dots); files in scope with +/- diff stats.
- **Agent**: avatar + name + role; current task; runtime status (live/idle/stopped); recent activity (last 3 events); tokens used / total.
- **Drift**: score + status + sparkline; top 3 findings with severity chips; "Open drift screen" CTA.

- [ ] **Step 6.2: Styles** — port `.insp-tabs`, `.insp-tab`, `.insp-card`, `.insp-card.task`, `.insp-progress`, `.insp-validations`, `.insp-files`, `.insp-finding` from mockup.

- [ ] **Step 6.3: Commit**

### Task 7: CockpitForMe assembly

**Files:**
- Create: `ui/src/components/cockpit/CockpitForMe.tsx`
- Modify: `ui/src/styles/cockpit.css`

- [ ] **Step 7.1: Layout**

```
┌─────────────────────────────────────────────────────────────────┐
│ Welcome back banner (when reopenContext present, dismissible)   │
├──────────────┬──────────────────────────────────┬───────────────┤
│              │  [Resume team] [+ Task] [Drift]  │               │
│              │                                  │               │
│   AGENT      │  WHAT'S HAPPENING                │   INSPECTOR   │
│   CARDS      │  ┌───────────────────────────┐   │   (task/      │
│   (left)     │  │ Your team is working on   │   │   agent/      │
│              │  │ t_42 — bulk subscription  │   │   drift tabs) │
│   - lead     │  │                           │   │               │
│   - dev-1    │  └───────────────────────────┘   │               │
│   - dev-2    │                                  │               │
│   - reviewer │  TIMELINE                        │               │
│   - tester   │  - just now ...                  │               │
│              │  - 2 min ...                     │               │
│              │  - 8 min ...                     │               │
└──────────────┴──────────────────────────────────┴───────────────┘
```

Two PaneSplitters: outer horizontal splits left column from (center + right); inner horizontal splits center from right.

- [ ] **Step 7.2: Action strip** — header row with [Resume team] [+ Add task] [Run drift] buttons + spacer + `?` help button (Phase 4 wires the panel).

- [ ] **Step 7.3: ReopenBanner** — uses `reopenContext` prop, dismissible; persists dismissal per-project to localStorage.

- [ ] **Step 7.4: Wire to App.tsx props** — accept the same data shape `CockpitScreen` does today (team, tasks, runtimes, etc.) so the swap in Task 12 is mechanical.

- [ ] **Step 7.5: Commit**

---

## Phase 2c — Cockpit WITH-me (Tasks 8-10)

### Task 8: FileTabs strip

**Files:**
- Create: `ui/src/components/cockpit/FileTabs.tsx`
- Modify: `ui/src/styles/cockpit.css`

- [ ] **Step 8.1: Component** — array of open file paths, click to switch, `×` on hover to close, pin (Ctrl+K Ctrl+Enter), middle-click closes, drag to reorder (Phase 3 polish).

```tsx
export interface OpenFile {
  path: string;
  dirty: boolean;
  pinned?: boolean;
  /** Optional in-scope-for chip — when a task currently owns this file. */
  scopeTaskId?: string;
}
export interface FileTabsProps {
  files: OpenFile[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onPin?: (path: string) => void;
}
```

- [ ] **Step 8.2: Styles** — port `.file-tabs`, `.file-tab`, `.file-tab.active`, `.file-tab.dirty`, `.file-tab .scope-chip`.

- [ ] **Step 8.3: Commit**

### Task 9: AgentInboxPanel

**Files:**
- Create: `ui/src/components/cockpit/AgentInboxPanel.tsx`
- Modify: `ui/src/styles/cockpit.css`

- [ ] **Step 9.1: Wrapper** — renders the existing `AgentInbox.tsx` component but provides the right-panel chrome: agent picker dropdown at top (lists team.members), close button, persists last-selected agent to `tweaks.rightPanelAgent`.

```tsx
export interface AgentInboxPanelProps {
  team: Team;
  actor: Actor;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onClose: () => void;
  agentStreams: Record<string, StreamEntry[]>;
}
```

- [ ] **Step 9.2: Styles** — port `.right-panel`, `.right-panel-head`, `.agent-picker`.

- [ ] **Step 9.3: Commit**

### Task 10: CockpitWithMe assembly

**Files:**
- Create: `ui/src/components/cockpit/CockpitWithMe.tsx`
- Modify: `ui/src/styles/cockpit.css`

- [ ] **Step 10.1: Layout**

```
┌──────────┬───────────────────────────────────┬──────────────┐
│  FILE    │  FileTabs                         │              │
│  TREE    ├───────────────────────────────────┤  AGENT INBOX │
│          │                                   │  (optional)  │
│  +       │  Monaco editor pane               │              │
│  AGENT   │                                   │              │
│  CARDS   │                                   │              │
│  (bottom │                                   │              │
│   stack) │                                   │              │
├──────────┴───────────────────────────────────┴──────────────┤
│  BottomPanel (Terminal / Problems / Output / Validations)    │
└──────────────────────────────────────────────────────────────┘
```

- [ ] **Step 10.2: Reuse existing components** — `IdeFileTree` (left), `IdeEditorPane` (center editor below FileTabs), existing Monaco wiring.

- [ ] **Step 10.3: BottomPanel reuses Phase 2a Task 2.** Wire its slots — Terminal slot is a placeholder div ("Terminal coming in Phase 3") for now; Validations slot wraps the existing validation runner UI extracted from CockpitScreen.tsx; Problems and Output slots show empty states.

- [ ] **Step 10.4: AgentInbox right panel** rendered only when `tweaks.showRightPanel` AND `tweaks.developerMode` are both true.

- [ ] **Step 10.5: Commit**

---

## Phase 2d — Migration + ship (Tasks 11-12)

### Task 11: CockpitScreenV2 + persona switch

**Files:**
- Create: `ui/src/components/cockpit/CockpitScreenV2.tsx`
- Modify: `ui/src/App.tsx` (route to V2)

- [ ] **Step 11.1: Top-level switch**

```tsx
export function CockpitScreenV2(props: CockpitScreenProps) {
  if (props.developerMode) {
    return <CockpitWithMe {...props} />;
  }
  return <CockpitForMe {...props} />;
}
```

Both child components accept the same prop shape `CockpitScreen` uses today so the swap in App.tsx is one-line.

- [ ] **Step 11.2: Wire in App.tsx** — replace `<CockpitScreen ... />` at line ~700 with `<CockpitScreenV2 ... />`.

- [ ] **Step 11.3: Manual verify** — flip the FOR me/WITH me pill; layout swaps smoothly. Both pass typecheck + lint.

- [ ] **Step 11.4: Commit**

### Task 12: Retire old CockpitScreen + ship marker

**Files:**
- Delete: `ui/src/components/CockpitScreen.tsx`
- Modify: `ui/src/App.tsx` (drop the old import)

- [ ] **Step 12.1: Confirm no other references**

```bash
grep -rn "from '@/components/CockpitScreen'" ui/src/
```

Should be zero hits after Task 11. If any remain, fix or document.

- [ ] **Step 12.2: Full backend test regression**

```bash
cd toad-local && npm test 2>&1 | tail -8
```

- [ ] **Step 12.3: UI typecheck + lint + build**

```bash
cd toad-local/ui && npm run typecheck && npm run lint && npm run build
```

- [ ] **Step 12.4: Manual smoke**
  - [ ] `Ctrl+1` → Cockpit; default mode renders FOR-me three-column with agents left, timeline center, inspector right
  - [ ] Drag the column dividers — sizes persist after refresh
  - [ ] Click FOR me/WITH me pill — layout swaps to code-first
  - [ ] In WITH-me: file tree visible, editor opens active file (or a placeholder), file tabs render across the editor
  - [ ] `Ctrl+J` toggles bottom panel; tabs switch between Terminal / Problems / Output / Validations
  - [ ] `Ctrl+Alt+I` toggles right Agent Inbox panel (dev mode only)
  - [ ] ReopenBanner appears when reopenContext is present; dismiss persists per project
  - [ ] Inspector Task tab shows validations / files in scope / progress correctly
  - [ ] Run menu items (Start/Pause Team, Run Drift Check) work
  - [ ] `Ctrl+B` hides sidebar; menu item Toggle Sidebar matches state

- [ ] **Step 12.5: Delete `ui/src/components/CockpitScreen.tsx`**

- [ ] **Step 12.6: Ship marker**

```bash
git commit --allow-empty -m "ship(ui): Phase 2 — Cockpit redesign (both personas)

Cockpit rebuilt per spec §8.1. FOR-me lands as the calm three-column
observation surface; WITH-me lands as the Cursor-style code-first
layout with file tabs, Monaco editor, real resizable bottom panel
(Terminal / Problems / Output / Validations), and an optional Agent
Inbox right panel.

[task summary list...]

Phase 3 (per-screen polish — Foundry, Code, Tasks, Drift, Costs, Audit,
Settings) unblocks next.
"
```

---

## Self-Review Checklist

- [x] Spec coverage: every Phase 2 element in spec §8.1 has a task. PaneSplitter (Task 1) → resizable everywhere. BottomPanel (Task 2) → replaces cramped strip. Menubar wiring (Task 3) → makes Toggle Bottom/Right/Sidebar functional. AgentCard (Task 4), FlowTimeline (Task 5), Inspector (Task 6) → FOR-me primitives. CockpitForMe (Task 7) → assembly. FileTabs (Task 8), AgentInboxPanel (Task 9), CockpitWithMe (Task 10) → WITH-me. CockpitScreenV2 (Task 11) → switch glue. Retire + ship (Task 12).
- [x] No placeholders in step bodies — each task has concrete file paths, prop shapes, commit hints, manual-verify steps.
- [x] Type consistency: `BottomPanelTab`, `InspectorTab`, `OpenFile`, `TimelineEvent` defined once and used consistently across all tasks.
- [x] Sequencing: foundations (Tasks 1-3) before consumers (Tasks 4-10), assembly (7, 10) after primitives (4-6, 8-9), migration (11-12) last.
- [x] No TDD for UI per existing project convention (typecheck + lint + manual smoke). Backend unchanged.
- [x] Each task ends with a commit so reverts are granular. Sub-phase boundaries are natural ship points.
- [x] Independently shippable sub-phases — Phase 2a alone closes the bottom-panel + view-toggle gaps; Phase 2b alone delivers the headline FOR-me transformation; Phase 2c can wait for power-user demand if scope creeps.

## Sequencing rationale

PaneSplitter first because every layout uses it. BottomPanel + menubar wiring next so the `View → Toggle Bottom Panel` action stops being a no-op — closes the most visible "this menu item lies" gap. AgentCard before any layout that uses it. FlowTimeline + Inspector independently buildable, both consumed by CockpitForMe. CockpitForMe assembly proves the FOR-me layout end-to-end before WITH-me complexity. FileTabs and AgentInboxPanel independently buildable. CockpitWithMe ties WITH-me together. CockpitScreenV2 is the switch — last component built, mostly just routing. Retire + ship after smoke proves nothing leaked from the old CockpitScreen.tsx.

## Risk register

- **Monaco editor wiring**: WITH-me Task 10 reuses the existing `IdeEditorPane`. If that component has props that don't match what CockpitWithMe expects, adjust the prop adapter in Task 10 rather than touching IdeEditorPane (out-of-scope edit risk). Worst case: stub the editor with a `<pre>` showing file contents and defer real Monaco to Phase 3.
- **TimelineEvent projection complexity**: turning raw `agentStreams` into plain-English narration is the trickiest part of Task 5. If the projection logic gets ugly, ship a simpler version (event type + agent + raw payload one-line) for Phase 2 and polish to true narration in Phase 3.
- **Resizable bottom panel + grid layout**: BottomPanel sits inside CockpitWithMe but its height affects the parent's row height. Make sure `app-shell.css`'s flex container can accommodate the new region without breaking the `.app-body` overflow rules.
- **Persona swap not smooth**: if React re-mounts every component on persona change, the user loses state (file selection, scroll position). Test this in Task 11; use `useMemo` / stable keys if needed.
