# UI Runtime Detail Drawer Design

## Goal

Add a focused runtime detail drawer to the dashboard so an operator can inspect one runtime without losing the main dashboard context.

## Approach

Use a right-side drawer opened from a runtime row. The drawer will reuse current `/api/call` plumbing and existing runtime projections where possible. Add one read-only facade/MCP command, `runtime_events`, for recent runtime audit events; reuse `tool_activity` and `health_status` with `runtimeId` for tool calls and API retry health.

## Backend Scope

- Add `COMMANDS.RUNTIME_EVENTS` with value `runtime_events`.
- Expose `runtime_events` as a read-only MCP-shaped tool with optional `runtimeId`.
- Route `LocalToolFacade` to `readModel.listRuntimeAudit({ teamId, runtimeId })`.
- Do not add tables or new persistence.
- Do not make `runtime_events` mutating or require idempotency.

## UI Scope

- Add a Details button to each runtime card.
- Open a right-side drawer for the selected runtime.
- Show runtime identity, status, team, agent, PID, provider/session fields when present.
- Fetch and show three runtime-scoped projections:
  - recent runtime events via `runtime_events`
  - recent tool calls via `tool_activity`
  - API retry summary and rows via `health_status`
- Refresh drawer data when opened, when the selected runtime changes, after relevant SSE events, and through existing polling.
- Keep the drawer local-only and use the existing fixed API URL behavior for this slice.

## Error Handling

If drawer detail fetches fail, keep the drawer open and show empty sections through the existing dashboard fetch error logging path. If a selected runtime disappears from the runtime list, clear the selected runtime and close the drawer on the next refresh.

## Testing

- Backend tests prove `runtime_events` is exposed as read-only and calls `readModel.listRuntimeAudit()` with the actor team and optional runtime id.
- UI verification uses the existing Vite lint and build checks.
- Full backend regression remains `npm.cmd test`.
