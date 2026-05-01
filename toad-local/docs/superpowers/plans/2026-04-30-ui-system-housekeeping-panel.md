# UI System Housekeeping Panel

Slice: 2026-04-30
Status: complete

## Goal

The previous slice wired `LocalToadRuntime.start()` to emit `side_effects_dropped_on_restart` and `side_effects_pruned` runtime events whenever the corresponding pass did non-zero work. These events ride the existing SSE bus straight into the dashboard's event stream, but no UI element actually shows them. This slice adds a small "System Housekeeping" panel so an operator can glance at the dashboard and see the last restart's drop count and the last retention sweep's prune count.

## Scope

- New compact panel rendered between the top-stats row and the Pending Approvals section in `Dashboard.jsx`.
- Two indicators side-by-side:
  - **Last Restart Cleanup** — count + relative time, sourced from the most recent `side_effects_dropped_on_restart` event.
  - **Last Retention Sweep** — count + relative time, sourced from the most recent `side_effects_pruned` event.
- "Awaiting first restart" empty state when neither event has been received in the current session.
- No backend changes. No new MCP tools. No new API endpoints. The events are already flowing.

## Design Notes

- The data lives entirely in the dashboard's existing `events` array (from `useToadEvents`). The panel derives `lastDrop` and `lastPrune` by scanning the array for the most recent matching `event.type`.
- Relative time helper (`formatRelativeTime(iso)`) is local to the dashboard for now — small enough to live inline rather than promoted to a util module.
- Visual style matches the existing glass-card / glass-panel idiom; no new CSS or design tokens.
- The panel only shows events received during the current SSE session. We are not back-filling from a persistent store. If the operator wants historical housekeeping data, that would be a separate feature against `runtime_events` projection.

## Changes

- `ui/src/components/Dashboard.jsx`:
  - Derive `lastDrop` and `lastPrune` via `useMemo` over `events`.
  - Add the System Housekeeping panel between the top stats grid and the Approvals panel.

## Verification

```powershell
cd ui
npm.cmd run lint
npm.cmd run build
```

UI lint passes; UI build succeeds. Backend regression untouched (no backend changes).

Manual smoke (optional, requires the API running and a runtime restart with seeded pending receipts) — confirm the panel populates after a `LocalToadRuntime.start()` that does housekeeping work.

## Out Of Scope

- Historical housekeeping audit view backed by a query over the `runtime_events` table.
- A "Last N events" timeline panel for system events.
- User-triggered prune ("clean up now") from the UI — `pruneSideEffectLog()` is callable from the orchestrator but not yet exposed via the API; could be a small follow-up.
