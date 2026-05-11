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
│  TITLEBAR  ▸ project context + global actions                       │
├──────┬──────────────────────────────────────────────────────────────┤
│      │                                                              │
│  S   │                                                              │
│  I   │                                                              │
│  D   │              MAIN  ▸ active screen                          │
│  E   │                                                              │
│  B   │                                                              │
│  A   │                                                              │
│  R   │                                                              │
│      │                                                              │
├──────┴──────────────────────────────────────────────────────────────┤
│  STATUSBAR  ▸ ambient state (drift, runtimes, cost, git)            │
└─────────────────────────────────────────────────────────────────────┘
```

Three persistent regions: titlebar (project + global), sidebar (screen nav), statusbar (ambient state). Main area swaps. Drawers and modals overlay.

### 3.2 What's primary, secondary, tertiary

- **Primary surfaces** (sidebar nav): Cockpit, Foundry, Code, Tasks, Drift, Costs, Diagnostics. These are the things you DO.
- **Secondary surfaces** (drawers): Runtimes, Approvals, Notifications, Audit log, Diagnostics-runner. Toggle from titlebar or statusbar. Don't take the main area; they're ambient inspection.
- **Tertiary surfaces** (modals): project picker, create team, task creation, correction task, providers, shortcuts. Transient — open, do one thing, close.
- **Configuration** (Settings screen with sub-sections): general, workspace, providers, GitHub, risk policy, drift, foundry, plugins, MCP, notifications, advanced, about. Sticky sub-nav inside the screen.

Today's sidebar mixes primary (Cockpit, Foundry, Code, Tasks, Drift) and secondary (Runtimes, Approvals, Diagnostics). Moving Runtimes / Approvals / Diagnostics to drawers frees sidebar real estate and matches their actual usage pattern (open, glance, dismiss).

---

## 4. Titlebar — project context + global actions

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

## 5. Sidebar — primary navigation

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

## 6. Statusbar — ambient state

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

## 7. Main area — per-screen design

Each screen below gets a paragraph of intent + the key layout decision. Detail-level wireframes are Claude Design's job; this spec gives them the skeleton.

### 7.1 Cockpit (the default landing)

The "what's happening right now" surface. Two modes:

**FOR-me Cockpit** — calm, observational. Three columns:
- Left (240px): agent cards stacked (lead/dev/reviewer/QA), each showing status + current task
- Center (flex): the active task's flow — a vertical timeline of what just happened, plain-English, with the most recent action expanded
- Right (320px): Inspector — task detail / agent detail / drift summary, swappable tabs

No tabs above the center column today's "Tasks / Files / Agents" — that's UI-organized-by-data-type, not by user intent. The center area always shows "what's happening" in plain language. If the user wants raw data, that's what the Files / Code / Tasks sidebar entries are for.

**WITH-me Cockpit** — code-first. Two columns + bottom drawer:
- Left (260px): collapsible file tree + agent cards as a sub-section
- Right (flex): editor pane (Monaco) showing the active task's diff
- Bottom drawer (resizable, default 200px): terminal + validation runner + raw events, kind-selectable. This replaces today's cramped strip.

The toggle between modes is the `developerMode` boolean — but it's not just "show more"; it's a different default layout.

### 7.2 Foundry

Already shipped a great chat-driven flow. Re-envisioning keeps it almost as-is, with three adds:
- **Inline doc editing** (WITH-me only) — the 7 generated docs (brief, tech_spec, roadmap, etc.) become editable in a side pane while the chat continues. Today they're read-only artifacts.
- **Provider switcher** at session start, surfaced visibly (not buried in settings). "Plan with Claude / GPT / Gemini" choice up front.
- **Progress map** down the left side — shows which of the 7 phases (brief → spec → roadmap → tasks → ...) you've reached. Lifts the implicit phase pipeline into the UI.

### 7.3 Code

The IDE pane. Already exists. The redesign:
- File tree (left) gets a **search box** at the top (today: no in-tree search)
- Editor (center) gets a **task badge** showing which task this file is in scope for — "in scope for t_42 · authored by dev-1"
- Right side: a slim "AI suggestions" rail — when an agent is actively working on this file, their last action shows here as a Cursor-style suggestion strip.

### 7.4 Tasks

Today's kanban-ish view stays but adds:
- **Group-by toggle**: by status (default), by assignee, by task type (bug-fix vs feature vs correction), by risk class
- **Inline create**: add-task input pinned to the top, no modal for simple cases
- **Saved filters**: chips for "my work" / "blocked" / "in review" / "done this week"

### 7.5 Drift

Today's screen is fine — already redesigned in M.1c. The re-envisioning add: **"Drift narrative"** banner at top, plain English: *"Score 31%, watch level. 3 active findings, mostly architecture. No new findings since 2h ago."* Replaces the raw "Last 3 runs · peak 31% · current 31%" line, which is information-dense but not actionable.

### 7.6 Costs

Today's screen exists. Re-envisioning: split into **Estimated** (what the agents projected when planning) vs **Actual** (what's been spent). The gap is the most useful single number — "you're 18% over budget" or "23% under." Power-user mode adds per-call breakdown.

### 7.7 Audit (was Diagnostics screen)

Today's diagnostics drawer is run-on-demand; the full event log isn't browsable. The new Audit screen:
- Filterable table of all events (task / runtime / approval / drift / cost)
- Time range + event type + team + agent filters
- Click a row → JSON inspector
- Export to JSON / CSV

WITH-me only. FOR-me users land on a placeholder: "Audit log shows every event Symphony recorded. Most users don't need this. Open in power-user mode if you do."

### 7.8 Settings

The code already has sub-sections (`ui/src/components/settings/`). The IA fix is grouping them. Proposed order with section headers:

| Group | Sub-sections |
|---|---|
| **You** | General (theme, developer mode), Account, Notifications |
| **Project** | Workspace (paths), Foundry (defaults), Drift, Risk policy |
| **Providers & integrations** | Providers (claude/codex/gemini), GitHub, MCP servers, Plugins |
| **Advanced** | Advanced, About |

Left rail: sticky sub-nav with these groups. Right pane: the selected sub-section. Today's flat-scroll Settings becomes a two-pane.

---

## 8. Discoverability — the cross-cutting concern

Three patterns, applied everywhere:

### 8.1 Visible primary actions

Every screen shows its 2-3 most common actions as buttons in a header strip. No more "you have to know about ⌘K to use this app."

Examples:
- Cockpit: [Resume team] [Add task] [Run drift]
- Drift: [Run check] [Open Settings → Drift]  
- Costs: [Set budget] [Export report]
- Tasks: [+ New task] [+ Bug fix] [+ Correction] [Filter ▾]

### 8.2 Per-screen "?" help

A small `?` icon top-right of every screen. Click → side panel listing every command-palette action relevant to this screen, with descriptions. Solves "this app has a feature for that but I can't find it."

### 8.3 Command palette stays — but as power tool, not only door

Keep ⌘K with its full command list. Stop hiding capabilities behind it. The palette becomes "fast access," not "secret access."

---

## 9. Onboarding & first-run

### 9.1 First-run (no projects, no Foundry sessions)

Already exists (M.1a). Keep. Polish: the welcome banner should preview the three core paths visually — "Start with an idea" (Foundry), "Open existing project" (folder picker), "Try the demo" (seeded symphony-demo).

### 9.2 Reopen flow (has `.toad/` folder)

Today: silent. M.1a routes user to Cockpit. User has no idea what happened.

Fix: **a non-blocking banner across the top of Cockpit on reopen**, dismissible:
> "Welcome back to **my-app**. Resumed your team from last session — 4 tasks in flight, 1 awaiting review. Last run: 2 days ago."

The banner becomes invisible permanently once dismissed for that project.

### 9.3 Contextual "did you know" overlays

When a user has been on a screen for >2 minutes without using its primary actions, surface a tiny non-blocking toast: *"Tip: you can [primary action] from here with ⌘[shortcut]."* One per screen per session.

### 9.4 First-time-on-each-screen tour

Each sidebar screen, the first time a user visits it, shows a one-paragraph "what this is for" card at the top. Dismissible permanently. Removes the "what does Foundry do?" guesswork without forcing a tutorial mode.

---

## 10. Visual language (intent, not specifics)

Claude Design owns the visual treatment. Constraints to honor:

- **Dark by default, light supported.** Current `--clay` accent (#d97757) reads as warm/human and pairs well with neutral grays. Keep the warm-accent direction.
- **Information density: moderate.** Linear / Cursor density, not Notion (too loose) or Vim (too dense). The audience reads better than they navigate.
- **Motion: minimal.** Drift score pulse, agent-card status dots, a subtle scale-up on screen transition. No big animations.
- **Typography: monospace for code/data, sans for UI chrome.** Today's mix works; just lock it in.
- **Icons: line-weight, single style.** Today's icon set (Lucide-ish) is fine — keep it consistent. No mixed icon styles.

---

## 11. What this design explicitly does NOT change

To keep scope honest:

- Backend APIs, event sourcing, SQLite schema, drift engine — none of this changes.
- The two-process Tauri + Node sidecar architecture is unchanged.
- The agent role model (lead / developer / reviewer / QA / human) is unchanged.
- Foundry's seven-doc artifact set is unchanged.
- Risk policy, approvals, drift findings — all the behavioral primitives stay.

This is purely a UI re-org. No data model touches, no API touches.

---

## 12. Phasing

The implementation order, sized so each phase ships independently:

**Phase 1 — Foundations (1 slice, ~3 days work).** New Titlebar (project dropdown + new center palette), grouped Sidebar (Build/Watch/Inspect), Statusbar (drift / runtimes / costs / git segments). No screen-level redesigns yet. This alone closes the visibility gap on project switching, ambient state, and feature discovery.

**Phase 2 — Cockpit redesign (1 slice, ~4 days).** Rebuild Cockpit's three-column layout. Remove the cramped bottom panel. Implement the FOR-me / WITH-me mode toggle (the toggle exists in `tweaks.developerMode` — just needs UI wiring).

**Phase 3 — Per-screen polish (1 slice each, parallel).** Foundry inline editing, Code task badge, Tasks group-by + saved filters, Drift narrative banner, Costs estimated-vs-actual, Audit screen (new), Settings two-pane.

**Phase 4 — Discoverability (1 slice, ~2 days).** Visible primary actions on every screen, `?` help panel, first-time-on-screen cards, did-you-know toasts, reopen banner. This is where the cross-screen consistency gets enforced.

Each phase produces working, shippable software on its own. Phase 1 alone would close 60% of the discoverability complaints.

---

## 13. Open questions for the user

Marked here for the brainstorm review, not for Claude Design:

1. **Project switching as dropdown vs. tabs**: this spec proposes dropdown. Tabs work in browsers because pages are cheap; Symphony projects aren't. Are you OK losing the tab-strip metaphor?
2. **Removing Runtimes / Approvals from the sidebar**: this spec moves them to drawers. The intuition is they're "check on, dismiss" surfaces, not "live in." Agree?
3. **Audit screen for power-user only**: FOR-me users won't ever need it. Is that the right call, or should it be visible for everyone but with a "this is dense" cushion?
4. **Statusbar's git segment** is new — git status isn't surfaced in UI today, only in the Code screen indirectly. Are you OK adding git state as ambient context?
5. **Phasing order**: I sequenced foundations → Cockpit → polish → discoverability. Would you rather lead with Cockpit (most visible win) or foundations (broadest unblock)?

---

## 14. Handoff to Claude Design

Once this spec is approved, the brief for Claude Design is:

> "Build hi-fi mockups for Symphony AI's UI re-envisioning. Specs in `docs/specs/2026-05-11-ui-re-envisioning-design.md`. Produce:
> 1. Titlebar (three-zone layout, dropdown + palette + ambient)
> 2. Statusbar (four segments + power-user fifth)
> 3. Sidebar (grouped, both personas)
> 4. Cockpit — both FOR-me and WITH-me layouts
> 5. Foundry, Code, Tasks, Drift, Costs, Audit, Settings — one mockup each, FOR-me default
> 6. Reopen banner, first-time-on-screen card, ? help panel
>
> Visual treatment: dark theme primary, warm accent (#d97757 lineage), Linear-density information layout, line-weight icons, minimal motion. Locked palette + type scale + spacing system as deliverables."

That's it. Approve, edit, or push back on §13's open questions and we ship the spec to Claude Design.
