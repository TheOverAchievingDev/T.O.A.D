# Symphony UI re-envisioning — design spec

**Status:** draft, awaiting user review.
**Purpose:** Define the firm UI vision so individual screen redesigns (Cockpit, power-user mode, etc.) inherit a coherent shape. Firm enough to hand to Claude Design as a mockup brief.

---

## 1. Why this exists

Symphony has shipped a deep set of capabilities — Foundry's discovery chat, the runtime supervisor, drift, approvals, costs, plugins, reopen flow, bug-fix tasks, GitHub auth, risk policies — but discovery is buried. The Project picker exists and works; the only way to reach it is `⌘K → Open Project picker`. Same story for ~30 other actions. A new user staring at Cockpit has no way to know any of them exist.

The current UI evolved one screen at a time. Each individual screen is fine; the cross-screen experience is fragmented. The titlebar's project tabs sit next to a logo "T" and a search bar — three visually distinct treatments competing for the same row. The sidebar is flat (9 items + Settings) with no grouping. The command palette is the only door to many features.

**This doc decides the structural shape.** Visual treatment (colors, typography, spacing, motion) is downstream — Claude Design owns that once this spec is approved.

---

## 2. Personas

The audience splits two ways. Both ship as defaults of the same app, gated by a Settings toggle.

| | "FOR me" (default) | "WITH me" (power user) |
|---|---|---|
| Who | Non-developer with ideas, priced out of pro software dev | Developer who wants to pair with a team of agents |
| Landing | Cockpit — passive observation | Cockpit + code editor side-by-side |
| Validations | Run by agents, surfaced in Inspector | Inline manual runner with kind selector + history |
| Diffs | Auto-applied; revert per task | Per-hunk keep/revert in editor pane |
| Terminal | Hidden | First-class panel |
| Risk gates | Approval modal blocks | Operator can override with attestation |
| Drift findings | "Create correction task" button | Edit / dismiss / mark won't-fix |
| Foundry | Chat-driven discovery | Direct doc editing in editor pane |
| Costs | Single estimated total up front | Per-call live tracking |

The mode is **one toggle, one effect on every screen.** Settings → General → Developer mode. Sets `tweaks.developerMode: boolean`. Every component reads it and renders accordingly. No separate dev-mode codebase, no fork.

---

## 3. Information architecture

### 3.1 Top-level structure

```
┌─────────────────────────────────────────────────────────────────────┐
│  MENUBAR    File  Edit  View  Project  Run  Terminal  Help          │
├─────────────────────────────────────────────────────────────────────┤
│  TITLEBAR  ▸ project context + global actions                       │
├──────┬──────────────────────────────────────────────────────────────┤
│      │                                                              │
│  S   │              MAIN  ▸ active screen                           │
│  I   │              (resizable panes inside; e.g. files / editor /  │
│  D   │               agents-inbox; collapsible bottom terminal)     │
│  E   │                                                              │
│  B   │                                                              │
│  A   │                                                              │
│  R   │                                                              │
│      ├──────────────────────────────────────────────────────────────┤
│      │  BOTTOM PANEL  ▸ terminal / output / problems (resizable)    │
├──────┴──────────────────────────────────────────────────────────────┤
│  STATUSBAR  ▸ ambient state (drift, runtimes, cost, git)            │
└─────────────────────────────────────────────────────────────────────┘
```

Four persistent regions: menubar (familiar Cursor/VS Code pattern), titlebar (project + global), sidebar (screen nav), statusbar (ambient state). Main area swaps. Drawers and modals overlay. Bottom panel (terminal/output/problems) is per-screen — visible by default on Code screen, hidden on calm screens like Drift/Costs, but always toggleable via menu bar (`View → Toggle Terminal`) or shortcut.

**Pane resizability is a first-class commitment.** Every divider between persistent regions is drag-resizable: sidebar width, bottom panel height, right-side inspector width. State persists in settings per-screen. Double-click a divider to reset to default. Bottom panel has a collapse button in its header strip plus a close button — both reopenable via `View → Toggle Terminal` in the menu bar. This is the Cursor pattern, locked in.

### 3.2 What's primary, secondary, tertiary

- **Primary surfaces** (sidebar nav): Cockpit, Foundry, Code, Tasks, Drift, Costs, Diagnostics. These are the things you DO.
- **Secondary surfaces** (drawers): Runtimes, Approvals, Notifications, Audit log, Diagnostics-runner. Toggle from titlebar or statusbar. Don't take the main area; they're ambient inspection.
- **Tertiary surfaces** (modals): project picker, create team, task creation, correction task, providers, shortcuts. Transient — open, do one thing, close.
- **Configuration** (Settings screen with sub-sections): general, workspace, providers, GitHub, risk policy, drift, foundry, plugins, MCP, notifications, advanced, about. Sticky sub-nav inside the screen.

Today's sidebar mixes primary (Cockpit, Foundry, Code, Tasks, Drift) and secondary (Runtimes, Approvals, Diagnostics). Moving Runtimes / Approvals / Diagnostics to drawers frees sidebar real estate and matches their actual usage pattern (open, glance, dismiss).

---

## 4. Menubar — the familiar top-of-window menu

Sits as the highest row in the window. Modeled directly on Cursor's menu structure (screenshots referenced in `Reference material/Cursor/Screenshots/`), with Symphony-specific deviations called out per-menu. Items that don't apply to Symphony are dropped; items unique to Symphony are added.

```
File   Edit   Selection   View   Go   Run   Terminal   Help
```

Keyboard shortcuts use `Ctrl` on Win/Linux, `⌘` on macOS — the menu shows the right one per platform. Sub-menus marked `▸`.

### 4.1 File

| Item | Shortcut | Notes |
|---|---|---|
| New File | `Ctrl+N` | New blank file in the Code screen editor |
| New Window | `Ctrl+Shift+N` | Spawns a second Symphony window (Tauri multi-window) |
| ─── | | |
| Open Project Folder… | `Ctrl+O` | Folder picker; loads `.toad/` if present (reopen flow) |
| Open Recent ▸ | | Sub-menu, recent projects newest first |
| ─── | | |
| Save | `Ctrl+S` | Active file in Code screen |
| Save As… | `Ctrl+Shift+S` | |
| Save All | `Ctrl+K S` | |
| ─── | | |
| Auto Save | (toggle) | Setting passthrough |
| Preferences ▸ | | → Settings, Keyboard Shortcuts, Color Theme |
| ─── | | |
| Revert File | | Discard unsaved changes in active editor |
| Close Editor | `Ctrl+F4` | Close active editor tab |
| Close Project | `Ctrl+K F` | End the project's session (was "Close Folder" in Cursor) |
| Close Window | `Alt+F4` | |
| ─── | | |
| Exit | | |

**Dropped from Cursor:** New Text File (redundant with New File), New Agents Window (Cursor-specific), New Window with Profile (no profiles in Symphony), Open File (Symphony works at project level, not loose files), Open Workspace from File / Add Folder to Workspace / Save Workspace As / Duplicate Workspace (no multi-folder workspaces), Share (Cursor cloud feature).

### 4.2 Edit

Identical to Cursor with one Symphony deviation: text-editing items only fire when the Code screen is active.

| Item | Shortcut |
|---|---|
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Y` |
| ─── | |
| Cut | `Ctrl+X` |
| Copy | `Ctrl+C` |
| Paste | `Ctrl+V` |
| ─── | |
| Find | `Ctrl+F` |
| Replace | `Ctrl+H` |
| ─── | |
| Find in Files | `Ctrl+Shift+F` |
| Replace in Files | `Ctrl+Shift+H` |
| ─── | |
| Toggle Line Comment | `Ctrl+/` |
| Toggle Block Comment | `Shift+Alt+A` |
| Emmet: Expand Abbreviation | `Tab` |

### 4.3 Selection

Identical to Cursor — these are universal text-editor multi-cursor operations and there's no Symphony-specific take that improves them.

Select All / Expand Selection / Shrink Selection / Copy Line Up·Down / Move Line Up·Down / Duplicate Selection / Add Cursor Above·Below / Add Cursors to Line Ends / Add Next·Previous Occurrence / Select All Occurrences / Switch to Ctrl+Click for Multi-Cursor / Column Selection Mode.

### 4.4 View

This is where Symphony deviates most. Cursor's View menu surfaces VS Code's panel system (Explorer, Search, Source Control, Extensions, etc.). Symphony's View menu surfaces Symphony's *screens*.

| Item | Shortcut | Notes |
|---|---|---|
| Command Palette… | `Ctrl+Shift+P` | Existing palette |
| Open View… | | Quick-jump to any screen by name |
| ─── | | |
| Appearance ▸ | | Theme (Dark / Light / System), zoom level |
| Editor Layout ▸ | | Split vertical / horizontal / single (Code screen) |
| ─── | | |
| **Symphony screens (jumps):** | | |
| Cockpit | `Ctrl+1` | |
| Foundry | `Ctrl+2` | |
| Code | `Ctrl+3` | |
| Tasks | `Ctrl+4` | |
| Drift | `Ctrl+5` | |
| Costs | `Ctrl+6` | |
| Audit | `Ctrl+7` | |
| Settings | `Ctrl+,` | |
| ─── | | |
| Toggle Sidebar | `Ctrl+B` | Show/hide left screen nav |
| Toggle Bottom Panel | `Ctrl+J` | Show/hide terminal / output / problems |
| Toggle Right Panel | `Ctrl+Alt+I` | Show/hide Agent Inbox |
| ─── | | |
| Word Wrap | `Alt+Z` | Code screen |
| Developer Mode | (toggle) | `tweaks.developerMode` |

**Dropped from Cursor:** Explorer / Search / Source Control / Run / Extensions / Problems / Output / Debug Console / Terminal as top-level "open this panel" items — Symphony uses screens for these instead of VS-Code-style panels. (Problems / Output / Terminal are tabs WITHIN the bottom panel; you toggle the panel itself.)

### 4.5 Go

Identical to Cursor for the navigation primitives — they're universal editor moves — with two Symphony-specific replacements.

| Item | Shortcut | Notes |
|---|---|---|
| Back | `Alt+LeftArrow` | Screen navigation history |
| Forward | `Alt+RightArrow` | |
| Last Edit Location | `Ctrl+K Ctrl+Q` | Code screen |
| ─── | | |
| Switch Editor ▸ | | Code screen — between open file tabs |
| Switch Group ▸ | | Between split editor groups |
| ─── | | |
| Go to File… | `Ctrl+P` | Quick-open file by name |
| Go to Symbol in Workspace… | `Ctrl+T` | |
| Go to Symbol in Editor… | `Ctrl+Shift+O` | |
| ─── | | |
| Go to Definition | `F12` | |
| Go to Declaration | | |
| Go to Type Definition | | |
| Go to Implementations | `Ctrl+F12` | |
| Go to References | `Shift+F12` | |
| **Add Symbol to Agent Inbox** | `Shift+F12` ✱ | **Symphony deviation** — Cursor has "Add Symbol to Current/New Chat"; Symphony's equivalent is sending the symbol context to the Agent Inbox |
| ─── | | |
| Go to Line/Column… | `Ctrl+G` | |
| Go to Bracket | `Ctrl+Shift+\` | |
| ─── | | |
| Next Problem | `F8` | |
| Previous Problem | `Shift+F8` | |
| Next Change | `Alt+F3` | |
| Previous Change | `Shift+Alt+F3` | |

### 4.6 Run

**Biggest Symphony deviation.** Cursor's Run menu is debugger UI (Start Debugging, Step Over, Breakpoints). Symphony doesn't have an integrated debugger — agents do the work, operators observe. So Run becomes "team operations."

| Item | Shortcut | Notes |
|---|---|---|
| Start / Resume Team | `F5` | |
| Pause Team | `Shift+F5` | |
| ─── | | |
| Run Drift Check | `Ctrl+Shift+D` | Force a manual drift_run |
| Run Validations on Active Task | `Ctrl+Shift+V` | Test / lint / typecheck — kind picker in Settings |
| Trigger Foundry Refinement Pass | | Re-run the planning agent on the active Foundry session |
| ─── | | |
| Approve Pending… | `Ctrl+Shift+A` | Opens ApprovalsDrawer |
| End Team | | Confirmed dialog, then teardown |

**Future (placeholder, not in initial rollout):** integrated debugger sub-section for power-user-mode operators who want to step through the agents' Bash tool calls or the generated code. Tracked, not built.

### 4.7 Terminal

Cursor's Terminal menu maps cleanly. Symphony additions: validation-kind selector pre-bound.

| Item | Shortcut | Notes |
|---|---|---|
| New Terminal | `` Ctrl+Shift+` `` | New terminal in bottom panel |
| Split Terminal | `Ctrl+Shift+5` | |
| Kill Active Terminal | `Ctrl+Shift+W` | |
| Clear | `Ctrl+L` | |
| ─── | | |
| Run Task… | | |
| Run Build Task… | `Ctrl+Shift+B` | |
| Run Active File | | Code screen |
| Run Selected Text | | Code screen |
| ─── | | |
| Choose Validation Kind ▸ | | test / lint / typecheck / build / security / install |
| ─── | | |
| Show Running Tasks… | | |
| Restart Running Task… | | |
| Terminate Task… | | |
| ─── | | |
| Configure Tasks… | | |
| Configure Default Build Task… | | |

### 4.8 Help

| Item | Shortcut | Notes |
|---|---|---|
| Show All Commands | `Ctrl+Shift+P` | Same as Command Palette |
| Documentation | | Opens docs URL in default browser |
| Keyboard Shortcuts… | `Ctrl+K Ctrl+S` | Opens ShortcutsModal |
| Symphony Tour | | Re-runs first-run cards across all screens |
| Show Welcome Banner | | |
| ─── | | |
| Give Feedback… | | Opens email / GitHub issue prefill |
| Report Issue… | | Pre-fills a GitHub issue with diagnostics |
| ─── | | |
| View License | | |
| Toggle Developer Tools | | Tauri DevTools |
| Open Process Explorer | | Sidecar + plugin processes |
| ─── | | |
| Restart to Update | | Apply update if downloaded |
| About Symphony | | Opens Settings → About |

**Dropped from Cursor:** Editor Playground (Cursor-specific tutorial), Get Started with Accessibility Features (could be re-added later as a Symphony Accessibility section).

---

### 4.9 Implementation note

Tauri 2 supports both native OS menus (macOS top-of-screen, Windows in-window) and HTML-rendered in-window menus. For visual consistency across platforms and to keep the custom titlebar pattern below the menu, we use the HTML-rendered approach — same as Cursor on Windows. Native macOS menu wiring can be added later as a platform-conditional override without changing the IA.

---

## 5. Titlebar — project context + global actions

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Symphony] ▸ Project ⌄ [my-app · symphony-demo] ▸  [+ new]          │
│             ◇  ⌘K  search anything                                  │
│                          [🔔3] [👥4 runtimes] [⚙] [─][□][×]         │
└─────────────────────────────────────────────────────────────────────┘
```

Three zones, fixed proportions:

**Left zone — project context.** No more "T" logo as a button. A "Symphony" wordmark (small, brand-y, non-interactive) + a project dropdown showing the active project name. Click the dropdown → opens the Project picker as an overlay popover (NOT a full screen — the screen is reserved for the work). "+ new" inline = create new project (routes to Foundry). The today-version's project-tabs-row pattern is removed — tabs are good for short-lived browser-style switching, but Symphony projects are heavyweight (each has a runtime, a worktree, a team). Project switching is a project-switch, not a tab-switch.

**Center zone — command palette trigger.** Same `⌘K` affordance, but framed as "Search anything" with examples (typed placeholder rotating: "Search anything · run drift · open settings · switch project"). Wider than today. The palette is power-user, but the entry point teaches what's possible.

**Right zone — ambient + global.** Three icons max:
- **Notifications** (bell + badge) — opens NotificationsDrawer
- **Runtimes** (people icon + live/total count) — opens RuntimeDrawer
- **Account** (gear) — opens a small menu with: Settings, Theme toggle, Plan & quota, Sign out / Switch account, About

Everything else currently in the titlebar (Approvals, Providers, GitHub, Diagnostics) becomes either: a sidebar primary, a drawer toggle from the sidebar/statusbar, or a Settings sub-section. Less noise, more legible.

---

## 6. Sidebar — primary navigation

```
┌──────────┐
│ COCKPIT  │  ← active
│ FOUNDRY  │
│ CODE     │
│ TASKS    │
│ ─────    │
│ DRIFT    │  ← grouped: "Watch"
│ COSTS    │
│ ─────    │
│ AUDIT    │  ← grouped: "Inspect" (was "Diagnostics" screen)
│          │
│ SETTINGS │
└──────────┘
```

**Items, in order:**

| Item | Purpose | Persona reach |
|---|---|---|
| Cockpit | The default landing — agents working in real time | Both |
| Foundry | Chat with an AI to draft specs / plan a project | Both |
| Code | Editor + file tree for the active project | Both (WITH-me lands here) |
| Tasks | Full kanban + history | Both |
| **Drift** | Drift findings + score | Both |
| **Costs** | Token + dollar telemetry | Both |
| **Audit** | The event log viewer | WITH-me primarily |
| Settings | Configuration | Both |

**Visual grouping** with thin dividers + tiny section labels ("Build" / "Watch" / "Inspect" — labels optional, dividers required). Today's flat list reads as a shopping list; grouping creates rhythm.

**Removed from sidebar** (moved to drawers, opened from sidebar buttons in a secondary row or from statusbar):
- Runtimes — became right-side RuntimeDrawer toggle
- Approvals — became right-side ApprovalsDrawer toggle  
- Diagnostics — stays as "Audit" sidebar entry (the screen). The diagnostic *run* (live monitoring) becomes a statusbar surface.

**Power-user-mode-only additions** (appear in sidebar when `developerMode: true`):
- **Terminal** — bottom drawer toggle, but also a screen
- **Events** — raw SQLite event log explorer with filters + JSON inspect

---

## 7. Statusbar — ambient state

The big missing surface in today's UI. A persistent thin bar at the bottom with non-interactive ambient indicators and quick-toggle drawer launchers.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ● drift 31% (watch)  │  4/4 runtimes  │  ~$2.40 today  │  ⎇ main ✓ │
└─────────────────────────────────────────────────────────────────────┘
```

Four segments, each click opens the relevant drawer or jumps to the relevant screen:
- **Drift score** — click → Drift screen. Pulse animation when a new run lands.
- **Runtime health** — click → RuntimeDrawer. Color: green (all live), amber (some stuck), red (some failed).
- **Cost ticker** — click → Costs screen. Today's spend visible at all times — solves the "am I burning money?" anxiety the audience has.
- **Git status** — branch + clean/dirty indicator. Click → opens git drawer with recent commits (NEW; doesn't exist today). Power-user mode shows ahead/behind too.

Power-user mode adds a fifth segment: **provider latency / quota** — small bar showing claude/codex/gemini quota burn through the 5h window.

---

## 8. Main area — per-screen design

Each screen below gets a paragraph of intent + the key layout decision. Detail-level wireframes are Claude Design's job; this spec gives them the skeleton.

### 8.1 Cockpit (the default landing)

The "what's happening right now" surface. Two modes:

**FOR-me Cockpit** — calm, observational. Three columns, all resizable:
- Left (240px default): agent cards stacked (lead/dev/reviewer/QA), each showing status + current task
- Center (flex): the active task's flow — a vertical timeline of what just happened, plain-English, with the most recent action expanded
- Right (320px default): Inspector — task detail / agent detail / drift summary, swappable tabs

No tabs above the center column for today's "Tasks / Files / Agents" — that's UI-organized-by-data-type, not by user intent. The center area always shows "what's happening" in plain language. If the user wants raw data, that's what the Files / Code / Tasks sidebar entries are for.

**WITH-me Cockpit** — code-first, Cursor-style. Two columns + bottom panel + optional right panel:
- Left (260px default, resizable): file tree at the top + agent cards stacked below in a collapsible section
- Center (flex): editor pane (Monaco) with **file tabs across the top** — every open file is a tab, exactly like Cursor / VS Code. The active task's diff opens automatically when an agent starts work; user can pin tabs or close them. A small chip in each tab shows "in scope for t_42" when the file belongs to an active task.
- Right (optional, hidden by default, 360px when open): **Agent Inbox panel** — see §8.1.1 below
- Bottom panel (resizable, default 200px, collapsible + closable + reopenable via menu): terminal / output / problems / validation runner. Replaces today's cramped strip entirely.

The toggle between modes is the `developerMode` boolean — but it's not just "show more"; it's a different default layout.

#### 8.1.1 The right-side panel — Agent Inbox, not "ask AI a question"

Cursor's right-side Agent panel is a generic AI chat. Symphony's right-side panel is different by design, because Symphony's agents are *not* generic AI assistants — they're a specific team of autonomous workers with roles (lead / developer / reviewer / QA), each holding state about ongoing tasks.

The panel is the **Agent Inbox** (`AgentInbox.tsx` already exists in the codebase, with three modes already wired):

- **Ask** — direct question to a chosen agent; they answer in chat, no work taken
- **Delegate** — assign a piece of work; the agent treats it as a task
- **Interrupt** — pre-empt the agent; stop current work and follow this instead

The operator picks the target agent from a dropdown at the top of the panel ("lead" / "dev-1" / "reviewer-1" / "tester-1"). The conversation thread is per-agent and persists across sessions.

**Why not the Foundry chat in this slot:** Foundry is project-*planning* (draft the spec, design the team, kickoff). The Cockpit/Code Agent Inbox is project-*operation* (talk to your running team). Two different conceptual modes; conflating them would confuse what the AI on the other end can actually DO right now. Foundry stays its own screen.

**Why hidden by default:** in FOR-me mode the operator mostly watches and lets the team work. The Inbox is an "I want to interject" surface, not an always-on one. WITH-me users can pin it open via `View → Toggle Right Panel` (default `Ctrl+Alt+I`).

### 8.2 Foundry

Already shipped a great chat-driven flow. Re-envisioning keeps it almost as-is, with three adds:
- **Inline doc editing** (WITH-me only) — the 7 generated docs (brief, tech_spec, roadmap, etc.) become editable in a side pane while the chat continues. Today they're read-only artifacts.
- **Provider switcher** at session start, surfaced visibly (not buried in settings). "Plan with Claude / GPT / Gemini" choice up front.
- **Progress map** down the left side — shows which of the 7 phases (brief → spec → roadmap → tasks → ...) you've reached. Lifts the implicit phase pipeline into the UI.

### 8.3 Code

The IDE pane. Cursor-pattern layout, same skeleton as WITH-me Cockpit but with code as the primary focus:

- **Left (resizable, 260px default):** file tree with a search box at the top. Today there's no in-tree search; add a `Ctrl+P` quick-open file search and a `Ctrl+Shift+F` find-in-project. Folder tree groups expand/collapse with chevrons.
- **Center (flex):** editor pane with **a tab strip across the top** — every file the user (or an agent) opens becomes a tab. Tabs can be pinned (Ctrl+K Ctrl+Enter), closed (`×` on hover or `Ctrl+W`), or split into a second editor group (`Ctrl+\`). Active tab shows in-scope-for badge when relevant ("in scope for t_42 · authored by dev-1"). Unsaved-changes dot in the tab.
- **Right side (optional, hidden by default):** Agent Inbox panel — same surface as Cockpit's right panel (§8.1.1). Pinnable, hideable.
- **Bottom panel (resizable, collapsible):** terminal / output / problems. Same surface as everywhere; the View menu controls it.

Editor itself is Monaco; that's already chosen. Theme follows the global Theme setting. Minimap can be toggled per-editor in Settings.

### 8.4 Tasks

Today's kanban-ish view stays but adds:
- **Group-by toggle**: by status (default), by assignee, by task type (bug-fix vs feature vs correction), by risk class
- **Inline create**: add-task input pinned to the top, no modal for simple cases
- **Saved filters**: chips for "my work" / "blocked" / "in review" / "done this week"

### 8.5 Drift

Today's screen is fine — already redesigned in M.1c. The re-envisioning add: **"Drift narrative"** banner at top, plain English: *"Score 31%, watch level. 3 active findings, mostly architecture. No new findings since 2h ago."* Replaces the raw "Last 3 runs · peak 31% · current 31%" line, which is information-dense but not actionable.

### 8.6 Costs

Today's screen exists. Re-envisioning: split into **Estimated** (what the agents projected when planning) vs **Actual** (what's been spent). The gap is the most useful single number — "you're 18% over budget" or "23% under." Power-user mode adds per-call breakdown.

### 8.7 Audit (was Diagnostics screen)

Today's diagnostics drawer is run-on-demand; the full event log isn't browsable. The new Audit screen:
- Filterable table of all events (task / runtime / approval / drift / cost)
- Time range + event type + team + agent filters
- Click a row → JSON inspector
- Export to JSON / CSV

WITH-me only. FOR-me users land on a placeholder: "Audit log shows every event Symphony recorded. Most users don't need this. Open in power-user mode if you do."

### 8.8 Settings

The code already has sub-sections (`ui/src/components/settings/`). The IA fix is grouping them. Proposed order with section headers:

| Group | Sub-sections |
|---|---|
| **You** | General (theme, developer mode), Account, Notifications |
| **Project** | Workspace (paths), Foundry (defaults), Drift, Risk policy |
| **Providers & integrations** | Providers (claude/codex/gemini), GitHub, MCP servers, Plugins |
| **Advanced** | Advanced, About |

Left rail: sticky sub-nav with these groups. Right pane: the selected sub-section. Today's flat-scroll Settings becomes a two-pane.

---

## 9. Discoverability — the cross-cutting concern

Three patterns, applied everywhere:

### 9.1 Visible primary actions

Every screen shows its 2-3 most common actions as buttons in a header strip. No more "you have to know about ⌘K to use this app."

Examples:
- Cockpit: [Resume team] [Add task] [Run drift]
- Drift: [Run check] [Open Settings → Drift]  
- Costs: [Set budget] [Export report]
- Tasks: [+ New task] [+ Bug fix] [+ Correction] [Filter ▾]

### 9.2 Per-screen "?" help

A small `?` icon top-right of every screen. Click → side panel listing every command-palette action relevant to this screen, with descriptions. Solves "this app has a feature for that but I can't find it."

### 9.3 Command palette stays — but as power tool, not only door

Keep ⌘K with its full command list. Stop hiding capabilities behind it. The palette becomes "fast access," not "secret access."

---

## 10. Onboarding & first-run

### 10.1 First-run (no projects, no Foundry sessions)

Already exists (M.1a). Keep. Polish: the welcome banner should preview the three core paths visually — "Start with an idea" (Foundry), "Open existing project" (folder picker), "Try the demo" (seeded symphony-demo).

### 10.2 Reopen flow (has `.toad/` folder)

Today: silent. M.1a routes user to Cockpit. User has no idea what happened.

Fix: **a non-blocking banner across the top of Cockpit on reopen**, dismissible:
> "Welcome back to **my-app**. Resumed your team from last session — 4 tasks in flight, 1 awaiting review. Last run: 2 days ago."

The banner becomes invisible permanently once dismissed for that project.

### 10.3 Contextual "did you know" overlays

When a user has been on a screen for >2 minutes without using its primary actions, surface a tiny non-blocking toast: *"Tip: you can [primary action] from here with ⌘[shortcut]."* One per screen per session.

### 10.4 First-time-on-each-screen tour

Each sidebar screen, the first time a user visits it, shows a one-paragraph "what this is for" card at the top. Dismissible permanently. Removes the "what does Foundry do?" guesswork without forcing a tutorial mode.

---

## 11. Visual language (intent, not specifics)

Claude Design owns the visual treatment. Constraints to honor:

- **Dark by default, light supported.** Current `--clay` accent (#d97757) reads as warm/human and pairs well with neutral grays. Keep the warm-accent direction.
- **Information density: moderate.** Linear / Cursor density, not Notion (too loose) or Vim (too dense). The audience reads better than they navigate.
- **Motion: minimal.** Drift score pulse, agent-card status dots, a subtle scale-up on screen transition. No big animations.
- **Typography: monospace for code/data, sans for UI chrome.** Today's mix works; just lock it in.
- **Icons: line-weight, single style.** Today's icon set (Lucide-ish) is fine — keep it consistent. No mixed icon styles.

---

## 12. What this design explicitly does NOT change

To keep scope honest:

- Backend APIs, event sourcing, SQLite schema, drift engine — none of this changes.
- The two-process Tauri + Node sidecar architecture is unchanged.
- The agent role model (lead / developer / reviewer / QA / human) is unchanged.
- Foundry's seven-doc artifact set is unchanged.
- Risk policy, approvals, drift findings — all the behavioral primitives stay.

This is purely a UI re-org. No data model touches, no API touches.

---

## 13. Phasing

The implementation order, sized so each phase ships independently:

**Phase 1 — Foundations (1 slice, ~3 days work).** New Titlebar (project dropdown + new center palette), grouped Sidebar (Build/Watch/Inspect), Statusbar (drift / runtimes / costs / git segments). No screen-level redesigns yet. This alone closes the visibility gap on project switching, ambient state, and feature discovery.

**Phase 2 — Cockpit redesign (1 slice, ~4 days).** Rebuild Cockpit's three-column layout. Remove the cramped bottom panel. Implement the FOR-me / WITH-me mode toggle (the toggle exists in `tweaks.developerMode` — just needs UI wiring).

**Phase 3 — Per-screen polish (1 slice each, parallel).** Foundry inline editing, Code task badge, Tasks group-by + saved filters, Drift narrative banner, Costs estimated-vs-actual, Audit screen (new), Settings two-pane.

**Phase 4 — Discoverability (1 slice, ~2 days).** Visible primary actions on every screen, `?` help panel, first-time-on-screen cards, did-you-know toasts, reopen banner. This is where the cross-screen consistency gets enforced.

Each phase produces working, shippable software on its own. Phase 1 alone would close 60% of the discoverability complaints.

---

## 14. Open questions — RESOLVED

All open questions resolved by user review (2026-05-11). The spec below is final pending one optional item (Audit visibility, see #5).

| # | Question | Resolution |
|---|---|---|
| 1 | Menu bar contents | ✅ Locked — §4 now matches Cursor's menu structure exactly (screenshots in `Reference material/Cursor/Screenshots/`) with Symphony-specific deviations called out per-menu |
| 2 | Right-side panel = Agent Inbox vs Foundry chat | ✅ **Agent Inbox** — user confirmed "perfect" |
| 3 | Project switching = dropdown vs tabs | ✅ **Dropdown** — user confirmed |
| 4 | Runtimes / Approvals as drawers vs sidebar | ✅ **Drawers** — user confirmed |
| 5 | Audit screen visibility | ⚪ Open — defaulting to "WITH-me only with cushion for FOR-me" unless user pushes back |
| 6 | Statusbar git segment | ✅ **Add it** — user confirmed |
| 7 | Phasing order | ✅ **Foundations first** — user confirmed |

The only remaining decision is whether the Audit screen is power-user-mode-only or visible-to-everyone-with-a-"this-is-dense"-cushion. Spec currently sits at WITH-me-only per the original proposal; flag this if you want it changed.

---

## 15. Handoff to Claude Design

Once this spec is approved, the brief for Claude Design is:

> "Build hi-fi mockups for Symphony AI's UI re-envisioning. Reference IDE: **Cursor** — match its look-and-feel as the starting point, with Symphony-specific deviations called out in the spec at `docs/specs/2026-05-11-ui-re-envisioning-design.md`.
>
> Produce mockups for:
> 1. **Menubar** (§4) — File / Edit / View / Project / Run / Terminal / Help, in-window-rendered (like Cursor on Windows). Show each menu open with its items.
> 2. **Titlebar** (§5) — three-zone: project dropdown + command palette + ambient/global icons.
> 3. **Statusbar** (§7) — four ambient segments (drift / runtimes / costs / git) plus power-user fifth.
> 4. **Sidebar** (§6) — grouped Build / Watch / Inspect, both personas.
> 5. **Cockpit** (§8.1) — FOR-me three-column AND WITH-me Cursor-style code-first with file tabs.
> 6. **Code** (§8.3) — Cursor-style: file tree (with search) + tab strip + editor + optional right panel + bottom terminal panel. Show resize handles.
> 7. **Foundry, Tasks, Drift, Costs, Audit, Settings** — one mockup each, FOR-me default.
> 8. **Agent Inbox** (§8.1.1) — the right-side panel with Ask / Delegate / Interrupt modes and agent picker dropdown.
> 9. **Reopen banner, first-time-on-screen card, ? help panel** (§9-§10).
>
> Visual treatment: dark theme primary, warm accent (#d97757 lineage), Cursor-style information density, line-weight icons, minimal motion. Resize handles between all major regions. Locked palette + type scale + spacing system as deliverables.
>
> Deviations from Cursor to call out visually:
> - Right-side panel is **Agent Inbox** (Ask/Delegate/Interrupt a specific role-bound agent), NOT a generic AI chat
> - Project switching is via **titlebar dropdown**, not folder open/close
> - Statusbar is **richer** than Cursor's (drift score, runtime health, cost ticker added)
> - Cockpit FOR-me mode is **a calm three-column observation surface** — no equivalent in Cursor; design it from scratch."

That's it. Approve, edit, or push back on §14's open questions and we ship the spec to Claude Design.
