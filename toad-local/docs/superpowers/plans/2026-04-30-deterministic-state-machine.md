# Deterministic Task State Machine

Slice: 2026-04-30
Status: complete

Maps to: **§3** of `AGENT_TEAMS_HARDENING_CHECKLIST.md` — the highest-priority unmet enforcement layer per the gap matrix.

## Goal

Today `task_update` accepts any string for `status` and the orchestrator does not own task state. The checklist's §3 requires that the orchestrator validate every transition against an explicit table, reject invalid moves, and record actor / from / to / reason / timestamp on every transition.

This slice adds the validator and wires it into `LocalToolFacade.#taskUpdate`. It does NOT yet add roles or block transitions on missing role authority — that's §5 in the next slice.

## Design

### Lifecycle constants

A new module `src/task/taskLifecycle.js` exports:

```js
export const TASK_LIFECYCLE = Object.freeze({
  BACKLOG:     'backlog',
  READY:       'ready',
  PLANNED:     'planned',
  IN_PROGRESS: 'in_progress',
  REVIEW:      'review',
  TESTING:     'testing',
  MERGE_READY: 'merge_ready',
  BLOCKED:     'blocked',
  DONE:        'done',
  REJECTED:    'rejected',
});
```

The existing `TASK_STATUS = { PENDING, IN_PROGRESS, COMPLETED, DELETED }` is **kept unchanged** for backward compatibility. New work should prefer `TASK_LIFECYCLE`; existing call sites continue to use whichever values they already use.

### Transition table

```js
export const ALLOWED_TRANSITIONS = Object.freeze({
  // Strict 10-state lifecycle (checklist §3)
  backlog:     ['ready', 'rejected'],
  ready:       ['planned', 'blocked'],
  planned:     ['in_progress', 'blocked'],
  in_progress: ['review', 'blocked', 'completed'],   // 'completed' bridges to legacy direct-finish
  review:      ['testing', 'in_progress', 'rejected'],
  testing:     ['merge_ready', 'in_progress', 'blocked'],
  merge_ready: ['done', 'in_progress'],
  blocked:     ['ready', 'planned', 'in_progress'],
  done:        [],
  rejected:    ['backlog'],
  // Legacy aliases — keep existing call sites working
  pending:     ['ready', 'in_progress', 'rejected', 'blocked', 'completed'],
  completed:   [],
  deleted:     ['backlog'],
});
```

Why bridges in both directions? Existing tests transition `pending → in_progress` and `in_progress → completed` (the legacy "direct finish" pattern). A clean checklist-only model would require `in_progress → review → testing → merge_ready → done`. To avoid breaking existing call sites in this slice, we explicitly allow legacy "shortcuts" in the table. A future tightening slice will narrow `in_progress → completed` once the role / CI gates are enforced.

### Validator

```js
export function validateTaskStatusTransition({ from, to }) {
  // Initial state (no prior status) — anything from the table is allowed.
  if (from === null || from === undefined) {
    return { ok: typeof to === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, to), reason: ... };
  }
  if (!ALLOWED_TRANSITIONS[from]) return { ok: false, reason: `unknown source status "${from}"` };
  if (from === to) return { ok: true };  // idempotent
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `${from} → ${to} is not an allowed transition` };
  }
  return { ok: true };
}
```

Idempotent self-transitions (`X → X`) are allowed — re-issuing `task_update status=X` when already X is a no-op-equivalent move, not a validation error.

### Facade wiring

`#taskUpdate` looks up the current task projection before appending the event:

1. Read current `task = taskBoard.getTask({ teamId, taskId })`
2. If args.status is provided, run `validateTaskStatusTransition({ from: task?.status ?? null, to: args.status })` and throw if not ok
3. Append the event with payload `{ status, from: task?.status ?? null, reason: args.reason ?? null, ownerId? }` — `from` and `reason` are added per checklist §3.
4. Existing ownerId / status fan-out preserved.

## Tests

### `test/taskLifecycle.test.js` (new)

- Initial state (no prior status) accepts any known status; rejects unknown.
- Same-state self-transition is allowed (idempotent).
- Each documented transition is allowed.
- Each illegal transition is rejected with the reason string.
- Legacy aliases are reachable (pending→in_progress, in_progress→completed, deleted→backlog).
- Terminal states (done, completed) reject all forward moves.

### `test/localToolFacade.test.js` (extended)

- `task_update` records `from` and `reason` in the STATUS_CHANGED event payload.
- `task_update` rejects an illegal transition (e.g. completed → review).
- Existing tests transitioning pending→in_progress, in_progress→completed continue to pass.

## Out of scope (explicit follow-ups)

- Role-based authority (§5/§26) — next slice.
- Blocking transitions until plan / test / review artifacts exist (§2/§17/§18).
- Tightening the legacy `in_progress → completed` shortcut — wait until CI gates land so we can require a passing test artifact for `merge_ready → done`.
- Migrating existing pending/completed/deleted values across the codebase. They keep working as today; new code should prefer the 10-state names.

## Verification

```powershell
node test/taskLifecycle.test.js
node test/localToolFacade.test.js
node test/taskBoard.test.js
npm.cmd test
```

All 29 backend test files pass.
