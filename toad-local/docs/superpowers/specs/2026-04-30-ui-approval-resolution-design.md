# UI Approval Resolution Design

## Goal

Let the dashboard show pending approval requests and resolve them with Approve/Deny actions without leaving the TOAD UI.

## Design

Use the existing read-model and facade pattern. Add a read-only `approval_list` command to `LocalToolFacade` and MCP tool definitions so the UI can fetch approvals through the same `/api/call` bridge as `task_list`, `agent_status`, and `health_status`.

In the React dashboard, add an approval panel near the runtime/event views. It will show pending approvals first with tool name, agent, runtime, prompt, input preview, and status. Each pending approval has Approve and Deny controls that call `approval_respond` with a stable idempotency key derived from the approval id and decision. After a decision, refresh dashboard data; SSE/polling remains the fallback refresh path.

## Scope

- Add backend read command: `approval_list`.
- Add MCP/facade tests for command exposure and read-only behavior.
- Add dashboard state for approvals, pending count, and response actions.
- Keep the UI local-only and use existing fixed API URL behavior for this slice.

## Non-Goals

- No modal workflow yet.
- No authentication or API hardening.
- No new backend tables.
- No browser automation screenshot pass unless a later visual QA slice starts a dev server.

## Verification

- `node test/localToolFacade.test.js`
- `node test/localMcpToolDefinitions.test.js`
- `npm.cmd test`
- `npm.cmd run lint` in `ui/`
- `npm.cmd run build` in `ui/`
