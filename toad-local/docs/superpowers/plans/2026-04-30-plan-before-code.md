# Plan Before Code — Checklist §2

Slice: 2026-04-30
Status: complete

Maps to: **§2** of `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`. Builds on the state machine (§3), role authority (§5/§26), and CI gates (§6/§18) slices.

## Goal

Before a developer agent starts editing files, they must submit a structured plan that a lead / architect / human approves. The state machine then enforces:

- `ready → planned` requires an **approved** plan on the task.

This adds three new MCP tools, three new task event types, a `task.plan` projection sub-object, a state-machine gate, and a self-approval check.

## Design

### `AgentPlan` shape

Per checklist §2:

```ts
type AgentPlan = {
  summary: string                  // required
  filesExpectedToChange: string[]
  approach: string[]
  risks: string[]
  validationPlan: string[]
  requiresApproval: boolean        // not enforced yet — see Out of Scope
}
```

The plan is stored in the `PLAN_PROPOSED` event payload. Multiple plans can be proposed per task (revision history is preserved in `task.history`); the projection always reflects the latest one.

### New event types

```js
TASK_EVENT_TYPES.PLAN_PROPOSED  = 'task.plan_proposed'
TASK_EVENT_TYPES.PLAN_APPROVED  = 'task.plan_approved'
TASK_EVENT_TYPES.PLAN_REJECTED  = 'task.plan_rejected'
```

### Task projection

A new `task.plan` sub-object groups everything plan-related:

```js
task.plan = {
  state:        'proposed' | 'approved' | 'rejected',
  summary:      string | null,
  filesExpectedToChange: string[],
  approach:     string[],
  risks:        string[],
  validationPlan: string[],
  proposedBy:   string,    // event.actorId of the latest PLAN_PROPOSED
  proposedAt:   string,
  decidedBy?:   string,    // event.actorId of the latest APPROVED/REJECTED
  decidedAt?:   string,
  reason?:      string,    // approver's reason on approve/reject
}
```

If `PLAN_PROPOSED` arrives **after** an `APPROVED`/`REJECTED`, the new propose resets the plan back to `proposed`. This preserves the legacy "request changes → revise plan → re-approve" loop.

### MCP tools

| Tool | Mutating | Required args | Optional |
|---|---|---|---|
| `task_plan_propose` | yes | `taskId` | `summary`, `filesExpectedToChange`, `approach`, `risks`, `validationPlan`, `requiresApproval` |
| `task_plan_approve` | yes | `taskId` | `reason` |
| `task_plan_reject` | yes | `taskId` | `reason` |

### Role allowlist

- `task_plan_propose` — `developer` + `lead` / `architect` / `human` (anyone who can `task_update`).
- `task_plan_approve` / `task_plan_reject` — `lead` / `architect` / `human` only. Developers and reviewers and testers cannot approve plans.

### Self-approval prevention

`task_plan_approve` and `task_plan_reject` reject when `actor.agentId === task.plan.proposedBy`. Same pattern as the self-review check on `review_decide`. Applies regardless of role.

### State-machine integration

A new transition guard inside `#taskUpdate`: when the requested move is `ready → planned`, look up `task.plan` and refuse the move unless `state === 'approved'`. Error message:

```
task_update: ready → planned requires an approved plan (current: <state | none>)
```

`planned → in_progress` does **not** require a plan (the gate is at the `ready → planned` step where the plan transitions from "approved" to "actively being worked"). This keeps the gate at the boundary where it makes operational sense.

## Out of scope (explicit follow-ups)

- **`requiresApproval` enforcement.** Plans can self-mark as `requiresApproval: true|false`. Currently the field is recorded but the gate always requires an approval event. Future tightening can let "low-risk" plans auto-approve once §14 risk policy is in place.
- **"Actual files differ from planned files" detection.** Per checklist: "If actual changed files differ from planned files, flag the task." Needs §7 (real diff tracking) finished first.
- **Plan revision history surfaced via a read tool.** Today the latest plan is in `task.plan`; full history is in `task.history`. A `task_plan_history` read tool can come later if needed.

## Changes

- `src/task/inMemoryTaskBoard.js` — three new `TASK_EVENT_TYPES.PLAN_*` constants. `projectTask` builds `task.plan` from PLAN_PROPOSED + (APPROVED|REJECTED) events.
- `src/commands/command-contract.js` — three new commands, all in `MUTATING_COMMANDS`.
- `src/mcp/localToolDefinitions.js` — three new tool defs.
- `src/tools/localToolFacade.js` — three new handler methods. `#taskUpdate` adds the `ready → planned` gate. Self-approval prevention in approve/reject handlers.
- `src/security/roleAuthority.js` — `task_plan_propose` added to `developer`; all three plan tools added to `architect`. Reviewer / tester explicitly excluded from approve/reject.
- `test/taskBoard.test.js` — projection test (proposed → approved → re-proposed cycle).
- `test/localToolFacade.test.js` — propose/approve/reject roundtrip; ready→planned blocked without plan; ready→planned blocked when plan rejected; ready→planned allowed when plan approved; self-approval rejected.
- `test/roleAuthority.test.js` — assertions for the new tools.
- `test/localMcpToolDefinitions.test.js` — three new tools in expected names + mutating-tools assertion.

## Verification

```powershell
node test/taskBoard.test.js
node test/localToolFacade.test.js
node test/roleAuthority.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

All 30 backend test files pass.
