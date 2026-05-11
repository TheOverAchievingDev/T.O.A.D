# UI re-envisioning — Phase 1 implementation plan (Foundations)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Claude Design mockup's chrome (menubar + titlebar redesign + grouped sidebar + statusbar) into the real Symphony codebase. Phase 1 of the broader UI re-envisioning per `docs/specs/2026-05-11-ui-re-envisioning-design.md`.

**Architecture:** Five new/changed top-level UI surfaces wired into `App.tsx`. New components: `Menubar.tsx`, `Statusbar.tsx`. Rewritten: `Titlebar.tsx`. Modified: `SidebarNav.tsx`, `App.tsx` (layout wiring), theme tokens in CSS. All components are presentation-only; existing state (`useTweaks`, `useToadData`, `useDrift`) flows in via props as today.

**Tech Stack:** React 18 + TypeScript + Vite + Tauri 2. CSS variables for theming (existing pattern). Geist + JetBrains Mono via Google Fonts (added to `index.html`). No new runtime dependencies.

**Reference:** Working clickable mockup at `Reference material/Claude Design Mockup/Symphony.html` — open in a browser to see the target visual + interaction shape. The mockup's `chrome.jsx` is the spec for layout decisions; `styles.css` provides design tokens to port verbatim where possible.

**Out of scope for Phase 1:** Cockpit redesign (Phase 2), per-screen polish (Phase 3), `?` help panel and first-time-on-screen cards (Phase 4), real drag-to-resize handles, Monaco editor wiring, Foundry inline doc editing.

---

## File structure

**Create:**
- `ui/src/components/Menubar.tsx` — new component, 8 menus (File / Edit / Selection / View / Go / Run / Terminal / Help) per spec §4
- `ui/src/components/Statusbar.tsx` — new component, four ambient segments + dev-mode fifth per spec §7
- `ui/src/styles/tokens.css` — new file consolidating design tokens (light + dark palettes, type, spacing, chrome dimensions) ported from mockup's `styles.css`

**Modify:**
- `ui/src/components/Titlebar.tsx` — rewrite to four-zone (wordmark / project dropdown / palette / global icons + persona pill + theme + ambient). Remove project tabs.
- `ui/src/components/SidebarNav.tsx` — add `section` field to nav items, render section headers (Build / Watch / Inspect / Power) with thin dividers. Pip badge support.
- `ui/src/App.tsx` — mount Menubar above Titlebar, mount Statusbar below main. Add `View → Toggle Bottom Panel` keybinding (`Ctrl+J`). Remove the project-tab-strip rendering currently in Titlebar.
- `ui/index.html` — preconnect + load Geist + JetBrains Mono from Google Fonts.
- `ui/src/styles/styles.css` (or wherever the root CSS imports happen) — import the new `tokens.css` before everything else.

**Delete:**
- Nothing in Phase 1. Phase 2 + 3 will retire some existing components.

---

## Task 1: Design tokens + fonts

**Files:**
- Create: `ui/src/styles/tokens.css`
- Modify: `ui/index.html`
- Modify: `ui/src/styles/styles.css` (or root CSS entry)

- [ ] **Step 1.1: Inspect the mockup's token definitions**

Read `Reference material/Claude Design Mockup/styles.css` lines 1-66. Note: the mockup uses `oklch()` color functions for warm-leaning dark + light palettes, type tokens (`--font-sans: "Geist"`, `--font-mono: "JetBrains Mono"`, `--font-display: "Geist"`), spacing radii (`--radius-sm/--radius/--radius-lg`), and chrome dimensions (`--h-menubar: 30px`, `--h-titlebar: 44px`, `--h-statusbar: 24px`, `--w-sidebar: 200px`, `--h-bottom: 220px`, `--w-right: 360px`). The accent color `--clay: #d97757` matches existing.

- [ ] **Step 1.2: Create tokens.css**

Create `ui/src/styles/tokens.css` with the full token set from the mockup's `:root` and `[data-theme="light"]` blocks, plus signal colors (`--green`, `--amber`, `--red`, `--blue`, `--violet`) and `--shadow-pop`. Copy verbatim — these are battle-tested by the mockup.

```css
/* ui/src/styles/tokens.css */
:root {
  /* type */
  --font-sans: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace;
  --font-display: "Geist", "Inter", -apple-system, sans-serif;

  /* dark palette — warm-leaning neutrals */
  --bg-0: oklch(0.16 0.005 60);
  --bg-1: oklch(0.19 0.005 60);
  --bg-2: oklch(0.22 0.006 60);
  --bg-3: oklch(0.26 0.007 60);
  --bg-4: oklch(0.30 0.008 60);

  --line: oklch(0.30 0.006 60);
  --line-soft: oklch(0.25 0.005 60);
  --line-strong: oklch(0.38 0.008 60);

  --fg-0: oklch(0.97 0.005 60);
  --fg-1: oklch(0.82 0.006 60);
  --fg-2: oklch(0.62 0.006 60);
  --fg-3: oklch(0.48 0.005 60);

  --clay: #d97757;
  --clay-soft: oklch(0.66 0.13 42 / 0.16);
  --clay-line: oklch(0.66 0.13 42 / 0.45);

  --green: oklch(0.74 0.14 150);
  --amber: oklch(0.78 0.14 75);
  --red: oklch(0.68 0.18 25);
  --blue: oklch(0.72 0.12 240);
  --violet: oklch(0.70 0.14 295);

  --shadow-pop: 0 12px 36px -8px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35);
  --radius-sm: 4px;
  --radius: 6px;
  --radius-lg: 10px;

  --h-menubar: 30px;
  --h-titlebar: 44px;
  --h-statusbar: 24px;
  --w-sidebar: 200px;
  --h-bottom: 220px;
  --w-right: 360px;
}

[data-theme="light"] {
  --bg-0: oklch(0.99 0.003 70);
  --bg-1: oklch(0.97 0.004 70);
  --bg-2: oklch(0.94 0.005 70);
  --bg-3: oklch(0.90 0.006 70);
  --bg-4: oklch(0.86 0.008 70);
  --line: oklch(0.86 0.006 70);
  --line-soft: oklch(0.90 0.005 70);
  --line-strong: oklch(0.78 0.008 70);
  --fg-0: oklch(0.20 0.008 60);
  --fg-1: oklch(0.36 0.008 60);
  --fg-2: oklch(0.52 0.006 60);
  --fg-3: oklch(0.62 0.005 60);
  --clay-soft: oklch(0.66 0.13 42 / 0.12);
  --clay-line: oklch(0.66 0.13 42 / 0.55);
}
```

- [ ] **Step 1.3: Wire Geist + JetBrains Mono into index.html**

Open `ui/index.html`. Add inside `<head>` BEFORE the existing stylesheet links:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

- [ ] **Step 1.4: Import tokens.css at the root**

Find Symphony's root CSS entry (likely `ui/src/main.tsx` or `ui/src/styles/styles.css`). Import `tokens.css` BEFORE the existing styles so existing rules can use the new tokens.

Run: `grep -rn "tokens.css\|styles.css" ui/src/main.tsx ui/src/styles/*.css`
Add an import like `@import './tokens.css';` at the top of the existing CSS entry, OR add `import './styles/tokens.css';` to `main.tsx` before the existing styles import.

- [ ] **Step 1.5: Manual verify**

Run: `cd ui && npm run dev` (assuming standard dev server). Open the app — text should now render in Geist sans-serif. Open DevTools → Elements → `:root` and verify `--font-sans` resolves to Geist. No visual changes required yet beyond the typeface.

- [ ] **Step 1.6: Commit**

```bash
git add ui/src/styles/tokens.css ui/index.html ui/src/main.tsx ui/src/styles/styles.css
git commit -m "feat(ui): design tokens + Geist/JetBrains Mono fonts for Phase 1

Ports the design tokens (warm-leaning oklch dark palette, light palette,
clay accent, signal colors, chrome dimensions) from the Claude Design
mockup into the real codebase as ui/src/styles/tokens.css. Loads Geist +
JetBrains Mono via Google Fonts preconnect in index.html.

No visual rewrites yet — this just makes the tokens available so the
next tasks (Menubar / Titlebar / Sidebar / Statusbar) can consume them.
Existing components inherit Geist via --font-sans cascade.

Per docs/specs/2026-05-11-ui-re-envisioning-design.md §11 (Visual
language — LOCKED via mockup).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Menubar component

**Files:**
- Create: `ui/src/components/Menubar.tsx`
- Modify: `ui/src/App.tsx` (mount it)

- [ ] **Step 2.1: Inspect mockup's Menubar**

Read `Reference material/Claude Design Mockup/chrome.jsx` lines 1-183 (the `MENUS` data structure + `Menubar` component). Note: the mockup uses a `MENUS` object keyed by menu name, with item arrays containing `{ kind: "row" | "sep" | "head", label, k (shortcut), check (boolean), action (handler key), goto (screen key) }`. Click opens, mouse-enter on another menu while open switches to it, mousedown outside closes.

- [ ] **Step 2.2: Create Menubar.tsx**

Mirror the mockup's data shape in TypeScript:

```tsx
// ui/src/components/Menubar.tsx
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { SidebarKey } from './SidebarNav';

type MenuItemKind = 'row' | 'sep' | 'head';
type MenuAction = 'sidebar' | 'bottom' | 'right' | 'devmode';

interface MenuItem {
  kind: MenuItemKind;
  label?: string;
  k?: string;
  check?: boolean;
  action?: MenuAction;
  goto?: SidebarKey;
}

const MENUS: Record<string, MenuItem[]> = {
  File: [/* per spec §4.1, mirror mockup's array */],
  Edit: [/* per spec §4.2 */],
  Selection: [/* per spec §4.3 */],
  View: [/* per spec §4.4, includes screen-jumps Cockpit Ctrl+1 .. Audit Ctrl+7 */],
  Go: [/* per spec §4.5 */],
  Run: [/* per spec §4.6 — Team operations, NOT debugger */],
  Terminal: [/* per spec §4.7 */],
  Help: [/* per spec §4.8 */],
};

export interface MenubarProps {
  openMenu: string | null;
  setOpenMenu: (m: string | null) => void;
  onNav: (key: SidebarKey) => void;
  onAction: (a: MenuAction) => void;
  devMode: boolean;
}

export function Menubar({ openMenu, setOpenMenu, onNav, onAction, devMode }: MenubarProps) {
  /* Mirror mockup behavior: refs map, click-outside close, mouse-enter switches */
  /* ... */
}
```

Copy `MENUS` item arrays from `chrome.jsx` verbatim (with TypeScript type adjustments). Click handler calls `onNav(item.goto)` for screen jumps, `onAction(item.action)` for toggles. Check rows show ✓ when `(item.action === 'devmode' && devMode) || item.label === 'Auto Save'`.

- [ ] **Step 2.3: Style with mockup's `.menubar` / `.menu-pop` classes**

Read `Reference material/Claude Design Mockup/styles.css` for `.menubar`, `.menubar-item`, `.menu-pop`, `.menu-pop .row`, `.menu-pop .sep`, `.menu-pop .head`, `.menu-pop .kbd` rules. Port verbatim into `ui/src/styles/chrome.css` (new file) or append to existing chrome styles. Confirm it imports after tokens.css.

- [ ] **Step 2.4: Mount in App.tsx**

In `ui/src/App.tsx`, import `Menubar` and mount it as the topmost child of the app's root element, ABOVE `<Titlebar>`. Wire props from existing state:

```tsx
const [openMenu, setOpenMenu] = useState<string | null>(null);

const handleMenuAction = (a: 'sidebar' | 'bottom' | 'right' | 'devmode') => {
  if (a === 'devmode') setTweak('developerMode', !tweaks.developerMode);
  /* sidebar / bottom / right handled in Phase 2 when those panels exist */
};

return (
  <div className="app">
    <Menubar
      openMenu={openMenu}
      setOpenMenu={setOpenMenu}
      onNav={(key) => setTweak('screen', key)}
      onAction={handleMenuAction}
      devMode={tweaks.developerMode === true}
    />
    <Titlebar /* ... */ />
    {/* existing content */}
  </div>
);
```

- [ ] **Step 2.5: Wire screen-jump keyboard shortcuts**

Mockup wires `Ctrl/Cmd+1..7` and `Ctrl/Cmd+,` for screen jumps and `Ctrl/Cmd+J` for bottom panel toggle. Add a `useEffect` in App.tsx:

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const map: Record<string, SidebarKey> = {
      '1': 'workspace', '2': 'foundry', '3': 'code', '4': 'tasks',
      '5': 'drift', '6': 'costs', '7': 'audit', ',': 'settings',
    };
    if (map[e.key]) {
      setTweak('screen', map[e.key]);
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [setTweak]);
```

Note: today's `SidebarKey` uses `'workspace'` for Cockpit (per SidebarNav.tsx). Keep that string for now; Phase 2 may rename.

- [ ] **Step 2.6: Manual verify**

`cd ui && npm run dev`. Click each of the 8 menu names, verify all items render with the right labels + shortcuts. Click `View → Cockpit`, `View → Foundry`, etc. — should navigate. Press `Ctrl+5`, should jump to Drift. Click outside an open menu, should close. All 8 menus should match `chrome.jsx`'s contents verbatim.

- [ ] **Step 2.7: Typecheck + commit**

```bash
cd ui && npm run typecheck
# expect clean
git add ui/src/components/Menubar.tsx ui/src/styles/chrome.css ui/src/App.tsx
git commit -m "feat(ui): Menubar component with 8 menus + screen-jump shortcuts

New Menubar component above Titlebar with File / Edit / Selection /
View / Go / Run / Terminal / Help. Item lists match spec §4 exactly,
including the Symphony deviations:

- View menu has Symphony screen jumps (Ctrl+1 Cockpit .. Ctrl+7 Audit,
  Ctrl+, Settings) — NOT VS Code's panel-toggle list.
- Run menu has Team operations (Start/Pause Team, Run Drift Check,
  Approve Pending) — NOT debugger UI.
- Go menu has 'Add Symbol to Agent Inbox' replacing Cursor's 'Add to
  Chat'.

Screen-jump keyboard shortcuts (Ctrl/Cmd+1..7 + Ctrl/Cmd+,) wired in
App.tsx via a single useEffect. Click-outside-closes behavior matches
the mockup.

Phase 1 of the UI re-envisioning workstream.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Titlebar rewrite (four-zone)

**Files:**
- Modify: `ui/src/components/Titlebar.tsx`
- Modify: `ui/src/App.tsx` (prop wiring)

- [ ] **Step 3.1: Inspect mockup's Titlebar**

Read `Reference material/Claude Design Mockup/chrome.jsx` lines 185-244. Four zones: left (wordmark + project dropdown + new-project plus), center (command palette with rotating placeholder), right (FOR me/WITH me pill + theme + bell+badge + people+badge + account). Project tabs row REMOVED.

- [ ] **Step 3.2: Rewrite Titlebar.tsx**

Replace the current Titlebar's tab-strip render with the four-zone layout. Project dropdown opens an overlay (defer to a `ProjectDropdown` sub-component in Phase 2; for Phase 1 the dropdown button is non-functional or opens the existing ProjectPicker via command palette).

```tsx
export interface TitlebarProps {
  theme: 'dark' | 'light';
  developerMode: boolean;
  setDeveloperMode: (v: boolean) => void;
  onToggleTheme: () => void;
  activeProjectName: string | null;
  activeProjectPath: string | null;
  onOpenProjectDropdown: () => void;
  onAddProject: () => void;
  onOpenCommandPalette?: () => void;
  onOpenNotifs: () => void;
  onOpenRuntimes: () => void;
  onOpenAccount: () => void;
  pendingNotifications?: number;
  liveRuntimes?: number;
  totalRuntimes?: number;
}
```

Rotating placeholder: array of 3 strings, `setInterval(4200)` cycles `placeholderIndex % 3`. Borrowed verbatim from mockup.

- [ ] **Step 3.3: Wire prop updates in App.tsx**

Update the `<Titlebar ... />` call site (line 483 area of App.tsx) to the new props. Existing handlers map mostly 1:1:
- `theme` ← `tweaks.theme`
- `developerMode` ← `tweaks.developerMode === true`
- `setDeveloperMode` ← `(v) => setTweak('developerMode', v)`
- `onToggleTheme` ← existing
- `activeProjectName` ← `projectRegistry.active?.name ?? null`
- `activeProjectPath` ← `projectRegistry.active?.path ?? null`
- `onOpenProjectDropdown` ← for now, `() => setTweak('screen', 'picker')` (defer real dropdown to Phase 2)
- `onAddProject` ← existing
- `onOpenCommandPalette` ← existing
- `onOpenNotifs` / `onOpenRuntimes` / `onOpenAccount` ← existing drawer handlers
- `pendingNotifications` ← derive from `notifications` state
- `liveRuntimes` / `totalRuntimes` ← derive from `runtimes` array

Remove the project-tabs render from inside Titlebar.

- [ ] **Step 3.4: Style with mockup's `.titlebar` / `.title-left` / `.title-center` / `.title-right` rules**

Port from mockup's `styles.css`. Pay attention to `.project-pill`, `.palette`, `.mode-pill`, `.icon-btn`, `.icon-btn .badge`.

- [ ] **Step 3.5: Manual verify**

`cd ui && npm run dev`. Titlebar should show: Symphony wordmark · project name from active project · rotating placeholder palette · FOR me/WITH me pill · theme toggle · bell · people · gear. Click FOR me/WITH me pill should flip `developerMode`. Verify by checking that the persona changes (any existing dev-mode-gated UI should appear/disappear).

- [ ] **Step 3.6: Typecheck + commit**

```bash
cd ui && npm run typecheck
git add ui/src/components/Titlebar.tsx ui/src/App.tsx ui/src/styles/chrome.css
git commit -m "feat(ui): Titlebar four-zone rewrite + persona toggle pill

Replaces today's project-tabs row with the four-zone titlebar from the
mockup: wordmark + project dropdown trigger (left), rotating-placeholder
command palette (center), FOR me/WITH me persona pill + theme toggle +
ambient icons with badges (right).

The persona pill wires the existing tweaks.developerMode boolean — the
toggle has been in state for a while but had no visible UI surface; now
the user can flip it directly.

Project switching dropdown is currently a button that routes to the
existing ProjectPicker screen; the real popover dropdown lands in
Phase 2 alongside the Cockpit redesign.

Per spec §5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Sidebar regrouping

**Files:**
- Modify: `ui/src/components/SidebarNav.tsx`

- [ ] **Step 4.1: Inspect mockup's Sidebar**

Read `Reference material/Claude Design Mockup/chrome.jsx` lines 246-307. Three groups (Build / Watch / Inspect) plus a dev-mode-only Power group, plus Settings pinned to bottom. Each item supports an optional `pip` badge (e.g. `12` on Tasks, `31%` on Drift with clay tint).

- [ ] **Step 4.2: Add section grouping to SidebarNav**

Current `SidebarNav` takes a flat `topItems` array. Refactor to take grouped sections:

```tsx
export interface SidebarSection {
  heading: string;          // "Build" / "Watch" / "Inspect" / "Power"
  items: SidebarNavItem[];
  devModeOnly?: boolean;    // Power group is hidden when developerMode is false
}

interface SidebarNavProps {
  active: SidebarKey;
  onSelect: (key: SidebarKey) => void;
  developerMode: boolean;
  pendingApprovals?: number;
  driftScore?: number | null;
  taskCount?: number;
  sections?: SidebarSection[]; // defaulted below
  bottomItems?: SidebarNavItem[];
  header?: ReactNode;
}

const DEFAULT_SECTIONS: SidebarSection[] = [
  { heading: 'Build', items: [
    { key: 'workspace', label: 'Cockpit', icon: 'layers' },
    { key: 'foundry',   label: 'Foundry', icon: 'sparkle' },
    { key: 'code',      label: 'Code',    icon: 'code' },
    { key: 'tasks',     label: 'Tasks',   icon: 'kanban' },
  ]},
  { heading: 'Watch', items: [
    { key: 'drift', label: 'Drift', icon: 'eye' },
    { key: 'costs', label: 'Costs', icon: 'sparkle' },
  ]},
  { heading: 'Inspect', items: [
    { key: 'audit', label: 'Audit', icon: 'info' },
  ]},
  { heading: 'Power', devModeOnly: true, items: [
    { key: 'terminal', label: 'Terminal', icon: 'cpu' },
    { key: 'events',   label: 'Events',   icon: 'info' },
  ]},
];
```

The render loop iterates sections, prints `<div className="side-head">{heading}</div>` between items, and skips devModeOnly sections when `developerMode === false`. Pip badges render from props (`pendingApprovals` for Approvals — but Approvals is moving to a drawer per spec, so this prop is removed; `taskCount` on Tasks; `driftScore` on Drift as `${score}%` with clay class).

- [ ] **Step 4.3: Update the SidebarNav call site in App.tsx**

Pass `developerMode={tweaks.developerMode === true}`, `taskCount={tasks.length}`, `driftScore={drift.data?.teamScore ?? null}`. Remove `pendingApprovals` (Approvals → drawer; pip moves to titlebar bell badge).

- [ ] **Step 4.4: Style the new groups**

Add `.side-section`, `.side-head`, `.side-divider`, `.pip`, `.pip.clay` rules from mockup's `styles.css`. The clay pip uses `background: var(--clay-soft); color: var(--clay); border: 1px solid var(--clay-line);` per mockup.

- [ ] **Step 4.5: Manual verify**

Sidebar shows Build/Watch/Inspect labels with thin dividers, Tasks item shows its count pip, Drift shows percent pip in clay. Toggle FOR me ↔ WITH me — Power section appears/disappears. Click each item, navigation should still work.

- [ ] **Step 4.6: Typecheck + commit**

```bash
cd ui && npm run typecheck
git add ui/src/components/SidebarNav.tsx ui/src/App.tsx ui/src/styles/chrome.css
git commit -m "feat(ui): Sidebar regrouped Build/Watch/Inspect + Power (dev-mode-only)

Adds section headers and dividers to SidebarNav per spec §6. Pip
badges support: task count on Tasks, drift % on Drift (clay-tinted),
notification count on the titlebar bell (out of sidebar).

Power group (Terminal / Events) shows only when developerMode is true.
Approvals removed from sidebar — moving to titlebar drawer per spec
§6 (drawers for 'glance, dismiss' surfaces).

Settings stays pinned to the bottom.

Per spec §6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Statusbar component

**Files:**
- Create: `ui/src/components/Statusbar.tsx`
- Modify: `ui/src/App.tsx` (mount)

- [ ] **Step 5.1: Inspect mockup's Statusbar**

Read `Reference material/Claude Design Mockup/chrome.jsx` lines 309-360. Four left segments (drift % pulsing · runtimes count · cost ticker · git branch + clean check) + dev-mode fifth (provider quota). Right side: approvals chip · cursor position · encoding · language.

- [ ] **Step 5.2: Create Statusbar.tsx**

```tsx
export interface StatusbarProps {
  driftScore?: number | null;
  driftStatus?: 'healthy' | 'watch' | 'breach';
  liveRuntimes: number;
  totalRuntimes: number;
  costToday?: number | null;
  costBudget?: number | null;
  gitBranch?: string;
  gitClean?: boolean;
  developerMode: boolean;
  pendingApprovals?: number;
  cursorPos?: { line: number; col: number };  // future — Code screen only
  fileEncoding?: string;                       // future
  fileLanguage?: string;                        // future
  onOpenDrift: () => void;
  onOpenRuntimes: () => void;
  onOpenCosts: () => void;
  onOpenApprovals: () => void;
}
```

Render exactly the structure of mockup's `<Statusbar />` — segments with clickable `onClick` jumping to the relevant screen / opening the relevant drawer. The drift dot has a `.pulse` class when drift status is `watch` or `breach`.

- [ ] **Step 5.3: Style with mockup's `.statusbar` rules**

`.statusbar`, `.status-seg`, `.status-spacer`, `.status-right`, `.dot.pulse`. Ported from mockup.

- [ ] **Step 5.4: Mount in App.tsx**

Below the main content. Wire props from existing state:
- `driftScore` ← `drift.data?.teamScore ?? null`
- `driftStatus` ← `drift.data?.status ?? 'healthy'`
- `liveRuntimes` ← `runtimes.filter(r => r.status === 'live').length`
- `totalRuntimes` ← `runtimes.length`
- `costToday` ← from `useCosts` hook if it exists; else `null` (statusbar shows `--` gracefully)
- `costBudget` ← `null` for Phase 1 (Phase 3 adds budget setting)
- `gitBranch` / `gitClean` ← new `useGitStatus` hook — for Phase 1, hard-code `'main'` + `true` so the segment renders; real wiring is Phase 3
- `developerMode` ← `tweaks.developerMode === true`
- `pendingApprovals` ← existing
- `onOpen*` ← screen-jump or drawer-open handlers

- [ ] **Step 5.5: Manual verify**

Statusbar appears at the bottom of the window. Drift segment shows live percent + pulses when not healthy. Runtimes shows live/total. Cost segment shows `--` or actual. Click drift → Drift screen, click runtimes → RuntimesDrawer, click costs → Costs screen, click approvals → ApprovalsDrawer. Toggle developerMode — fifth segment (provider quota placeholder) appears/disappears.

- [ ] **Step 5.6: Typecheck + commit**

```bash
cd ui && npm run typecheck
git add ui/src/components/Statusbar.tsx ui/src/App.tsx ui/src/styles/chrome.css
git commit -m "feat(ui): Statusbar component with four ambient segments

New persistent Statusbar at the window bottom per spec §7. Four
left-side segments — drift score (with pulse when not healthy),
runtimes live/total, cost today, git branch — and a fifth dev-mode-only
provider-quota segment. Right side: approvals chip, cursor position,
file encoding, language.

Each segment is clickable: drift → Drift screen, runtimes →
RuntimesDrawer, costs → Costs screen, approvals → ApprovalsDrawer.

Cost ticker shows '--' when costs hook returns null (Phase 1) — real
budget-aware rendering lands in Phase 3 Costs polish. Git status uses
a stubbed 'main · clean' until useGitStatus hook is written in Phase 3.

Per spec §7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Layout glue + ship marker

**Files:**
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/styles/styles.css` (or wherever root layout lives)

- [ ] **Step 6.1: Confirm layout grid**

App root should have CSS Grid template:

```css
.app {
  display: grid;
  grid-template-rows: var(--h-menubar) var(--h-titlebar) 1fr var(--h-statusbar);
  height: 100vh;
}
```

Verify Menubar / Titlebar / main / Statusbar each occupy their rows correctly.

- [ ] **Step 6.2: Full backend suite (regression check)**

```bash
cd toad-local && npm test 2>&1 | tail -10
```

Expected: green. Backend hasn't changed; this confirms no incidental regressions.

- [ ] **Step 6.3: UI typecheck + lint**

```bash
cd toad-local/ui && npm run typecheck && npm run lint
```

Expected: clean both.

- [ ] **Step 6.4: Manual smoke — full Phase 1 verification**

Open the app, navigate through this checklist:
- [ ] Menubar renders, all 8 menus open on click, all items match spec §4
- [ ] `Ctrl+1` ... `Ctrl+7` + `Ctrl+,` keyboard shortcuts navigate to the right screens
- [ ] `Ctrl+J` toggles bottom panel (placeholder until Phase 2 wires panels)
- [ ] Titlebar: wordmark, project dropdown button, rotating palette placeholder, FOR me/WITH me pill toggles correctly, theme toggle works, bell/people/account icons clickable with badges
- [ ] Sidebar: Build/Watch/Inspect groups visible with section labels, Power group toggles with developerMode, pip badges render on Tasks + Drift
- [ ] Statusbar: drift segment renders + pulses, runtimes count visible, cost segment renders (may show '--'), git segment shows stubbed 'main', approvals chip renders, click-throughs work
- [ ] Theme toggle dark ↔ light: tokens swap correctly, no visual breakage
- [ ] developerMode toggle: Power sidebar group appears, statusbar fifth segment appears

- [ ] **Step 6.5: Ship marker**

```bash
git commit --allow-empty -m "ship(ui): Phase 1 — Foundations (menubar + titlebar + sidebar + statusbar)

First slice of the UI re-envisioning workstream. Ports the Claude
Design mockup's chrome (Reference material/Claude Design Mockup/) into
the real Symphony codebase:

  - Design tokens + Geist + JetBrains Mono fonts
  - Menubar with 8 menus matching spec §4 (Symphony deviations preserved:
    View has screen jumps not panel toggles, Run has Team ops not
    debugger, Go has 'Add Symbol to Agent Inbox')
  - Titlebar four-zone rewrite with persona toggle pill wired to
    existing tweaks.developerMode
  - Sidebar regrouped Build/Watch/Inspect + Power (dev-only) with pip
    badges and section dividers
  - Statusbar with drift/runtimes/cost/git ambient segments + dev-only
    provider quota fifth

Per spec docs/specs/2026-05-11-ui-re-envisioning-design.md §§4-7.

Phase 1 closes ~60% of the discoverability gaps captured in
FUTURE-IDEAS.md (menubar surfaces ~25 actions, statusbar surfaces
ambient telemetry, sidebar grouping reduces flat-list overload, persona
toggle gets a visible affordance).

Phase 2 (Cockpit redesign — both personas with three-column FOR-me
+ Cursor-style WITH-me + Agent Inbox right panel) unblocks next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Checklist

- [x] Spec coverage: every Phase 1 element in §§4-7 of the spec has a corresponding task (Menubar §4 → Task 2, Titlebar §5 → Task 3, Sidebar §6 → Task 4, Statusbar §7 → Task 5).
- [x] No placeholders in step bodies — every step has concrete file paths, concrete code snippets, concrete commands.
- [x] Type consistency: `MenuAction`, `SidebarKey`, `SidebarSection`, `TitlebarProps`, `StatusbarProps` all defined once, used consistently.
- [x] Order: tokens first (everything cascades from them), then top-down chrome (Menubar → Titlebar → Sidebar → Statusbar), then layout glue + ship.
- [x] No TDD for UI per existing project convention (typecheck + lint + manual smoke). Backend tests unchanged.
- [x] Each task ends in a commit so reverts are granular.
- [x] Manual smoke (Step 6.4) is a real checklist, not "verify it works".
- [x] Phase 1 is independently shippable — it visually transforms the app even with Cockpit unchanged.

## Sequencing rationale

Tokens before components because every component reads tokens. Menubar before Titlebar because the menubar lives in the topmost row and the layout depends on its height token. Titlebar before Sidebar because Titlebar's persona pill controls the sidebar's Power group visibility. Sidebar before Statusbar so we can confirm grid layout reserves the right widths. Statusbar last because it's the smallest surface and a clean checkpoint. Ship marker after the full smoke proves all four pieces compose correctly.
