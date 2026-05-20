# Maintenance Mode Slice M.1b — Bug-Fix Task Type — Design

**Date:** 2026-05-10
**Slice:** M.1b of the post-F.2 Maintenance roadmap (second of three: M.1a reopen → **M.1b bug-fix task type** → M.1c drift retargeting).

---

## Goal

Add a `type` field to tasks (`'feature' | 'bug'`, default `'feature'`) and make the lead / developer / debugger agents behave differently for bug tasks: skip the plan-propose-approve cycle and go straight to **reproduce → root-cause → fix → verify**. Feature tasks keep the existing plan-first workflow.

The change rides entirely on the existing task event log and the team's system-prompt template. No schema migrations, no new lifecycle states, no new MCP tools.

## Non-goals

- **`'chore'` type** — deferred until usage data justifies a third value.
- **Custom lifecycle states** for bug work (e.g., `investigating`, `reproducing`) — existing `pending → in_progress → review → testing → merge_ready → done` states cover the work fine.
- **Drift-aware bug context** — M.1c slice.
- **Bug-specific risk policy** — bugs aren't inherently riskier than features; existing classifier stays in charge.
- **Auto-classification** — operator picks type manually. An LLM classifier inferring type from subject/description is a future polish.
- **Backfilling legacy tasks** — existing tasks (created without `type`) project as `'feature'` via fallback. No migration script.
- **Custom UI lanes for bug tasks** — kanban shape unchanged; bugs surface via a badge on the card.

---

## Architecture

The slice is shaped like F.2's provider-aware Foundry: small, surgical, adds a discriminator field that drives behavior changes in two places.

```
                   ┌────────────────────────────────────┐
                   │  TaskCreationModal (UI)             │
                   │  - Type radio: Feature / Bug        │
                   └──────────────────┬─────────────────┘
                                      │ type: 'feature' | 'bug'
                                      ▼
                   ┌────────────────────────────────────┐
                   │  task_create MCP tool               │
                   │  - validates type enum              │
                   │  - emits task.created event         │
                   │    with type in payload             │
                   └──────────────────┬─────────────────┘
                                      │
                                      ▼
                   ┌────────────────────────────────────┐
                   │  task_events SQLite table          │
                   │  (no schema change — type lives    │
                   │   in the payload_json column)      │
                   └──────────────────┬─────────────────┘
                                      │
                  ┌───────────────────┴────────────────────┐
                  ▼                                        ▼
       ┌─────────────────────┐                ┌───────────────────────┐
       │ Task projection      │                │ Agent reads task.type │
       │ (#projectTask)       │                │ via task_list /       │
       │ - exposes type field │                │ task_get               │
       │ - default 'feature'  │                │ - lead delegates       │
       │   when missing       │                │   accordingly          │
       └─────────────────────┘                │ - dev/debugger skips   │
                  │                            │   plan_propose when    │
                  ▼                            │   type === 'bug'       │
       ┌─────────────────────┐                └───────────────────────┘
       │ Kanban cards         │
       │ - bug badge          │                Behavior driven by
       │ - task detail header │                ROLE_GUIDANCE conditional
       └─────────────────────┘                language in teamSystemPrompts.js
```

## Components

### 1. Task projection — `src/task/inMemoryTaskBoard.js`

The CREATED event handler reads `event.payload.type` and writes it onto the projected task. Default `'feature'` when absent (back-compat for tasks created before this slice).

```js
const TASK_TYPES = Object.freeze(['feature', 'bug']);

if (event.eventType === TASK_EVENT_TYPES.CREATED) {
  // ... existing field projections
  const rawType = event.payload?.type;
  task.type = TASK_TYPES.includes(rawType) ? rawType : 'feature';
}
```

The initial task shape (the object that exists before any CREATED event is folded in) also gains `type: 'feature'` so partial projections behave predictably.

### 2. `task_create` MCP tool — `src/tools/localToolFacade.js` + `src/mcp/localToolDefinitions.js`

`#taskCreate` (or whatever the handler is named — find it in the facade) accepts an optional `type` arg. Validates against the enum. Passes through to the CREATED event payload.

MCP schema:

```js
{
  // ...existing task_create properties
  type: { type: 'string', enum: ['feature', 'bug'] },
}
```

Not added to `required` — defaults to `'feature'` when omitted, preserving back-compat with every existing caller (UI, agents, foundry materialize).

### 3. Agent behavior — `src/team/teamSystemPrompts.js`

Three role guidance entries gain task-type-aware language:

**Lead guidance addition** (one new line in the array):

```
'Tasks have a type field: "feature" (default) or "bug". For "feature" tasks, ensure the assignee proposes a plan via task_plan_propose before code work begins — feature work benefits from up-front design. For "bug" tasks, instruct the assignee to skip planning and go straight to investigation: reproduce → root-cause → minimal fix → verify. Set type: "bug" on task_create when the work is fixing existing broken behavior.',
```

**Developer guidance addition** (one new line):

```
'When you receive a task assignment, read the task type field. If type === "feature": propose a plan via task_plan_propose before writing code, wait for approval, then implement. If type === "bug": skip planning — first reproduce the issue, then identify the root cause, then implement the minimal fix, then run validation_run to confirm. Either way, follow the steering rules and the Definition of Done.',
```

**Debugger guidance addition** (one new line — slightly different since debuggers focus on diagnosis, not code):

```
'When the lead hands you a bug task (type === "bug"), skip planning — reproduce the failure, identify the root cause, and report your findings via message_send. The developer handles the actual fix unless the lead routes the fix back to you specifically.',
```

These are role-specific additions woven into the existing `ROLE_GUIDANCE` arrays in `teamSystemPrompts.js` lines 13-48.

### 4. UI — `ui/src/components/TaskCreationModal.tsx`

Add a "Type" segmented control or radio next to the existing fields (subject, description, assignedRole, priority). Two options: **Feature** (default selected) and **Bug**.

State:

```tsx
const [type, setType] = useState<'feature' | 'bug'>('feature');
```

Pass to the `task_create` MCP call args:

```tsx
await callTool({
  method: 'task_create',
  args: { ..., type },
  // ...
});
```

Reset to `'feature'` on modal open.

### 5. UI — Kanban card bug badge

In whichever component renders task cards (likely `TasksScreen.tsx` and/or `Workspace.tsx`), add a conditional bug badge when `task.type === 'bug'`. Render a small chip/pill next to the existing status/risk pills:

```tsx
{task.type === 'bug' && (
  <span className="task-bug-badge" title="Bug fix">
    Bug
  </span>
)}
```

No badge for `type === 'feature'` — reduces visual noise for the common case (most tasks).

### 6. UI — Task detail header

In `TaskDetailModal.tsx`, surface the type in the header next to other top-level fields (status, risk, assignee):

```tsx
<div className="task-detail-meta">
  <span>Status: {task.status}</span>
  <span>Type: {task.type === 'bug' ? 'Bug' : 'Feature'}</span>
  <span>Risk: {task.riskLevel || '—'}</span>
</div>
```

(Exact layout matches whatever the existing header structure is.)

### 7. CSS — `ui/src/styles/app-shell.css`

Add `.task-bug-badge` selector:

```css
.task-bug-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--clay, #d97757);
  border: 1px solid var(--clay-border, rgba(217, 119, 87, 0.4));
}
```

Uses the existing `--clay` accent token (the orange-red Symphony accent) since "bug" feels like an attention-needing state. Subtle enough not to dominate the card.

---

## Data flow — example

```
Operator opens TaskCreationModal for symphony-demo team
  └─> selects "Bug" in the Type radio, enters subject "Login form crashes on empty email"
        └─> clicks Create
              └─> callTool('task_create', { ..., type: 'bug' })
                    └─> LocalToolFacade.#taskCreate validates type, appends event
                          └─> taskBoard.appendEvent({ eventType: 'task.created', payload: { ..., type: 'bug' } })
                                └─> sqlite insert into task_events
                                      └─> projectTask returns { ..., type: 'bug' }
                                            └─> UI re-fetches; kanban card renders with Bug badge
                                                  └─> lead sees the new task via task_list, reads type === 'bug'
                                                        └─> lead delegates via message_send to developer:
                                                              "Task t_xyz is type=bug. Reproduce login crash with empty
                                                               email, find root cause, fix, then run validation."
                                                              └─> developer (per system prompt guidance for bug tasks):
                                                                    - reproduce
                                                                    - root-cause
                                                                    - implement fix
                                                                    - validation_run
                                                                    - message_send results to lead
```

For a feature task, the lead's delegation message includes "propose a plan first" guidance and the developer's system-prompt branches into the feature flow (propose → wait for approval → implement).

## Error handling

- **Invalid type value** at `task_create`: tool returns an error with the allowed enum values. The MCP schema's enum check also catches this client-side.
- **Legacy task** (no type in CREATED event): projection falls back to `'feature'`. Tasks created before this slice continue to work; agents see them as feature tasks (which they effectively were).
- **Agent ignores the type field** (training drift): the system-prompt guidance is strong direction but not a hard gate — see Q2 brainstorm answer. If an agent over-plans a bug task, the lead can correct via `message_send`. Worst case is a wasted plan_propose event, not data corruption.
- **UI fails to send type**: backend defaults to `'feature'`. Operator sees their task created as a feature; they can edit and recreate (or live with the default). No silent corruption.

## Testing

Backend (TDD):

- `test/inMemoryTaskBoard.test.js` (or `taskBoard.test.js`):
  - CREATED event with `type: 'bug'` → projected task has `type: 'bug'`.
  - CREATED event with `type: 'feature'` → projected task has `type: 'feature'`.
  - CREATED event with no type → projected task has `type: 'feature'` (back-compat default).
  - CREATED event with invalid type (e.g. `'banana'`) → projected task has `type: 'feature'` (defensive default; don't crash on malformed legacy data).
- `test/localToolFacade.test.js`:
  - `task_create` with `type: 'bug'` arg → CREATED event payload includes `type: 'bug'`.
  - `task_create` without `type` arg → CREATED event payload has no type OR has `type: 'feature'`; projection ends at `'feature'`.
  - `task_create` with invalid type → tool throws / rejects with a useful error.
- `test/localMcpToolDefinitions.test.js`:
  - `task_create` schema includes `type` as optional string enum `['feature', 'bug']`.
- `test/teamSystemPrompts.test.js`:
  - Lead guidance contains task-type conditional language (regex-match `/bug|feature/i` checks in both lead and dev guidance after the addition).
  - Developer guidance includes the type-aware branching.
  - Debugger guidance includes the bug-task instruction.

UI (typecheck + lint + manual smoke per existing UI convention):

- Manual smoke documented in plan:
  - Create a Feature task → verify it appears on the kanban WITHOUT a bug badge.
  - Create a Bug task → verify it appears WITH a "Bug" badge.
  - Open a Bug task's detail modal → verify the type is displayed in the header.
  - Inspect a legacy task (one created before this slice, e.g. demo-seeded tasks) → verify it renders as Feature without crashing.
  - (If a live team is running) Send a Bug task to the team → observe the lead's delegation message includes the bug-aware language. Optional — depends on whether the user has a live agent team to test against.

## What this slice does NOT change

- **Task lifecycle states** — `pending` / `in_progress` / `review` / `testing` / `merge_ready` / `done` all stay.
- **Risk classifier** — bugs go through `risk_classified` like features.
- **Review cycle** — bug fixes still need review.
- **Validation gates** — tests/lint/typecheck/build must pass for both types.
- **Merge integration** — `merge_ready → done` path identical for both types.
- **Foundry behavior** — Foundry only runs on fresh projects (`state === 'fresh'`); maintenance work uses task_create directly. The bug-vs-feature distinction is invisible to Foundry.
- **Drift monitor** — drift behavior unchanged in M.1b; M.1c covers drift retargeting for maintenance work.

## What this slice unblocks

- **M.1c (drift retargeting)** — once bug-fix tasks are first-class, drift can compare against the codebase's current state (relevant to bug context) instead of the original spec.
- **Polish: bug-specific risk policy** — if usage data shows bug fixes have different risk profiles than features, a polish slice can extend `risk_classified` to consider type.
- **Polish: third type (`chore`)** — if usage shows demand, expanding the enum is a 5-LOC migration.
- **Polish: LLM auto-classification** — a tiny classifier infers type from subject/description so operators don't have to pick.

---

## References

- M.1a spec: `docs/specs/2026-05-10-maintenance-mode-m1a-reopen-design.md` (the slice that enabled reopening a project to fix bugs in the first place)
- F.2 spec: `docs/specs/2026-05-10-foundry-slice-f2-provider-aware-design.md` (parallel pattern — provider field as discriminator)
- FUTURE-IDEAS.md "Maintenance mode" entry — "Fix bug task type — bypasses planning gates, agents go straight to investigation + fix"
- `src/task/inMemoryTaskBoard.js` — event-sourced task projection. Constants `TASK_EVENT_TYPES`, `TASK_STATUS`, `TASK_RISK_LEVELS`.
- `src/team/teamSystemPrompts.js` — `ROLE_GUIDANCE` constant where the conditional behavior lives.
- `src/tools/localToolFacade.js` — `task_create` handler.
- `src/mcp/localToolDefinitions.js` — `task_create` MCP schema.
