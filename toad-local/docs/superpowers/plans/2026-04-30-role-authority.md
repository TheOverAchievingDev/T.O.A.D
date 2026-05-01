# Role Authority — Checklist §5 + §26

Slice: 2026-04-30
Status: complete

Maps to: **§5** (role permissions / authority boundaries) and **§26** (tool / MCP authority by role) of `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`.

## Goal

Today every actor reaches every MCP tool. The state machine slice that just landed enforces "in_progress can't go straight to done" but does nothing about "the agent that wrote the code can't be the one who approves the review". Per the gap matrix, this is the next-most-load-bearing enforcement gap.

This slice introduces:

1. A role concept on the actor (`actor.role`).
2. A per-role tool allowlist enforced inside `LocalToolFacade.execute`.
3. Self-review prevention inside `#reviewDecide`.

It does **not** yet enforce per-transition role rules (e.g. "only lead can move `merge_ready → done`"). That's a logical follow-up that builds on this slice — the state machine table can be extended with role guards once roles are reliably present.

## Design

### Roles

The six roles from §5: `lead`, `architect`, `developer`, `reviewer`, `tester`, `human`. `human` is the operator role (the person driving the dashboard / API directly) — broadest authority. Agents impersonate the other five.

### Backward-compat default

`actor.role` is **optional**. When absent, the facade treats the actor as `human` (full access). This is the only realistic way to land role authority without breaking ~28 prior test files that all use `actor: { teamId, agentId: 'operator' }` with no role. New code that wants enforcement passes a role explicitly. A future tightening slice can require role on all actors once the upstream callers (UI form, Claude agent prompts, smoke harness) all opt in.

### Allowlist

A new module `src/security/roleAuthority.js` exports:

```js
export const ROLE_TOOLS = Object.freeze({
  lead: '*',              // sentinel — all tools
  architect: [...],       // read-heavy, design-focused
  developer: [...],       // implement, comment, request reviews
  reviewer: [...],        // decide reviews, comment
  tester: [...],          // run tests (validation_run when §6 lands), comment
  human: '*',             // operator — same as lead for now
});

export function assertRoleCanCallTool({ role, toolName }) { ... }
```

Concrete allowlist (from §5 / §26 mapping into TOAD's current 24-tool surface):

| Tool | lead | architect | developer | reviewer | tester | human |
|---|---|---|---|---|---|---|
| `task_create` | ✓ | ✓ | — | — | — | ✓ |
| `task_update` | ✓ | — | ✓ | — | ✓ | ✓ |
| `task_comment` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `task_list` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `message_send` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cross_team_send` | ✓ | ✓ | — | — | — | ✓ |
| `cross_team_messages` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `agent_status` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `agent_launch` | ✓ | — | — | — | — | ✓ |
| `agent_stop` | ✓ | — | — | — | — | ✓ |
| `team_create` | ✓ | — | — | — | — | ✓ |
| `team_list` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `team_delete` | ✓ | — | — | — | — | ✓ |
| `team_launch` | ✓ | — | — | — | — | ✓ |
| `team_stop` | ✓ | — | — | — | — | ✓ |
| `runtime_send_input` | ✓ | — | ✓ | — | — | ✓ |
| `review_request` | ✓ | ✓ | ✓ | — | — | ✓ |
| `review_decide` | ✓ | ✓ | — | ✓ | — | ✓ |
| `review_list` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approval_list` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `approval_respond` | ✓ | — | — | — | — | ✓ |
| `runtime_events` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tool_activity` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `health_status` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

`lead` and `human` use the `'*'` sentinel for compactness — the helper short-circuits.

### Self-review prevention

Inside `#reviewDecide`, after looking up the task, check:

```
if (task.review?.requestedBy === actor.agentId) {
  throw new Error('review_decide: same agent cannot review own work');
}
```

This is a hard rule per §17 ("same agent cannot review own work") and applies regardless of role — even a `human` operator who launched the work shouldn't approve their own review.

### Failure mode

`assertRoleCanCallTool` throws synchronously, before the idempotency check. This matches the existing pattern (`unsupported command: X` already throws sync).

The error message names the role and tool: `role authority: developer cannot call agent_launch`.

## Changes

- `src/security/roleAuthority.js` — NEW. Exports `ROLE_TOOLS`, `KNOWN_ROLES`, `assertRoleCanCallTool`.
- `src/tools/localToolFacade.js` — `execute()` calls `assertRoleCanCallTool` after `commandRequiresIdempotency` check; `#reviewDecide` adds self-review prevention.
- `test/roleAuthority.test.js` — NEW. Helper unit tests.
- `test/localToolFacade.test.js` — new tests for facade enforcement and self-review.
- `package.json` — adds `node test/roleAuthority.test.js`.

## Verification

```powershell
node test/roleAuthority.test.js
node test/localToolFacade.test.js
npm.cmd test
```

All 30 backend test files pass.

## Out of scope (explicit follow-ups)

- **Per-transition role guards.** "Only `lead` can move `merge_ready → done`" — needs a role-aware extension of `validateTaskStatusTransition`. Cleanly stacks on top of this slice.
- **Logging denied calls.** §26 says "every denied tool call should be logged". Currently denied calls throw and the throw bubbles to `/api/call`, which logs the error — but they don't land in the runtime event log. Future slice: emit a `tool_call_denied` event when `assertRoleCanCallTool` throws.
- **Removing the permissive `human` default.** Eventually all callers should specify a role. Current slice keeps the default permissive to avoid breaking the 29 prior test files.
- **Human approval prompts** for high-risk operations. §14 risk policy is a separate slice.
