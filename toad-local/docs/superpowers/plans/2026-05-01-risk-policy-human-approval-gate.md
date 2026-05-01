# Risk Policy + Human Approval Gate — Checklist §14

Date: 2026-05-01
Status: in progress

Builds on the prior task-schema slice (`riskLevel` / `requiresHumanApproval` accepted at `task_create`) and the file-contract enforcement slice (`forbiddenFiles` / `allowedFiles` enforced on `review_request`).

## Goal

Two halves:

1. **Configurable risk policy.** A project-local `.toad/risk-policy.json` declares pattern-based rules. When `review_request` runs and the orchestrator has a concrete file list, a classifier applies the rules and may *elevate* the task's `riskLevel` and flip `requiresHumanApproval` to `true`. Operator-supplied values from `task_create` are baseline; the classifier can only elevate (cannot demote).

2. **Human approval gate.** When `task.requiresHumanApproval === true` (whether operator-set or auto-classified), the `merge_ready → done` transition is blocked until a separate `task_human_approve` event is recorded by a human or lead role.

## Risk policy shape

`.toad/risk-policy.json`:

```json
{
  "rules": [
    { "pattern": ".env*",            "riskLevel": "critical", "requiresHumanApproval": true },
    { "pattern": "**/secrets/**",    "riskLevel": "critical", "requiresHumanApproval": true },
    { "pattern": "**/migrations/**", "riskLevel": "high",     "requiresHumanApproval": true },
    { "pattern": "package.json",     "riskLevel": "medium" },
    { "pattern": "Dockerfile",       "riskLevel": "medium" }
  ]
}
```

- Each rule: `pattern` (string), `riskLevel` (one of `low`/`medium`/`high`/`critical`, optional), `requiresHumanApproval` (bool, optional).
- Pattern matcher is the same `matchesAny` used by `forbiddenFiles` (exact, `**` glob, directory prefix).
- No rules = no auto-classification (back-compat).
- Missing config file = no auto-classification.
- The classifier picks the **highest** matched riskLevel across all matching rules and any matching rule with `requiresHumanApproval: true` flips the flag.

## Classifier API

Pure function in `src/policy/riskClassifier.js`:

```js
classify({ files, policy, currentRiskLevel = null, currentRequiresHumanApproval = false })
  → { riskLevel, requiresHumanApproval, matchedRules: [{pattern, riskLevel?, requiresHumanApproval?}] }
```

- `riskLevel`: highest of (`currentRiskLevel`, all matched rules' `riskLevel`). Compared via index in `['low','medium','high','critical']`.
- `requiresHumanApproval`: `currentRequiresHumanApproval || any matched rule has requiresHumanApproval: true`.
- `matchedRules`: rules that matched at least one file (for audit trail).
- Pure, no I/O. The loader produces `policy`; the classifier consumes it.

## Loader

`src/policy/loadRiskPolicy.js`:

```js
loadRiskPolicy({ projectCwd })
  → { rules: [...], path: '<absolute>' }   // when file exists and parses
  → null                                    // when file missing or unreadable
```

- Reads `${projectCwd}/.toad/risk-policy.json` synchronously (called once on runtime start).
- Validates rules; bad rules logged + skipped, file-level errors return null.
- Empty `{ rules: [] }` is valid (active-but-no-rules).

## New event types

```js
TASK_EVENT_TYPES.RISK_CLASSIFIED  = 'task.risk_classified'
TASK_EVENT_TYPES.HUMAN_APPROVED   = 'task.human_approved'
```

`RISK_CLASSIFIED` payload: `{ riskLevel, requiresHumanApproval, matchedRules, source: 'risk_policy' }`.
`HUMAN_APPROVED` payload: `{ approverId, reason?, decidedAt }`.

## Projection updates

`task.humanApproval` (initial: `{ approved: false }`):

```js
task.humanApproval = {
  approved: boolean,
  approvedBy?: string,
  approvedAt?: string,
  reason?: string,
}
```

`task.riskLevel` and `task.requiresHumanApproval` already exist from the prior schema slice. The `RISK_CLASSIFIED` event updates them in place (only elevating).

## New MCP tool

`task_human_approve`:

- Mutating, requires `idempotencyKey`.
- Args: `{ taskId, reason? }`.
- Restricted to `lead` and `human` via `roleAuthority` (architect explicitly cannot — they propose plans, humans sign off).
- Self-approval prevention: the agent that requested the review can still call this if they're a lead/human, but the more interesting check is that `requiresHumanApproval` itself can't be bypassed by the agent who set it (no API for tasks to flip the flag down, only up via classifier).
- Emits `HUMAN_APPROVED`.

## Facade integration

### `#reviewRequest` — auto-classify after files are determined

After the diff/files are resolved (caller-supplied OR orchestrator-computed), and after the existing `enforceReviewFileContract`:

```js
if (this.riskPolicy && Array.isArray(payload.files) && payload.files.length > 0) {
  const result = classify({
    files: payload.files,
    policy: this.riskPolicy,
    currentRiskLevel: task.riskLevel,
    currentRequiresHumanApproval: task.requiresHumanApproval,
  });
  if (
    result.riskLevel !== task.riskLevel ||
    result.requiresHumanApproval !== task.requiresHumanApproval
  ) {
    // Append RISK_CLASSIFIED before REVIEW_REQUESTED so the projection sees
    // the elevated values when downstream consumers read the task.
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey: `${idempotencyKey}:risk_classified`,
      eventType: TASK_EVENT_TYPES.RISK_CLASSIFIED,
      actorId: actor.agentId,
      payload: {
        riskLevel: result.riskLevel,
        requiresHumanApproval: result.requiresHumanApproval,
        matchedRules: result.matchedRules,
        source: 'risk_policy',
      },
    });
  }
}
```

### `#taskUpdate` — gate `merge_ready → done`

After the existing merge-conflict gate, before STATUS_CHANGED:

```js
if (fromStatus === 'merge_ready' && args.status === 'done') {
  if (current?.requiresHumanApproval && current?.humanApproval?.approved !== true) {
    throw new Error(
      `task_update: merge_ready → done blocked by human-approval gate (riskLevel: ${current.riskLevel || 'unspecified'})`,
    );
  }
}
```

### New `#humanApprove` handler

```js
#humanApprove(actor, idempotencyKey, args) {
  const taskId = requireString(args.taskId, 'args.taskId');
  this.taskBoard.appendEvent({
    teamId: actor.teamId,
    taskId,
    idempotencyKey,
    eventType: TASK_EVENT_TYPES.HUMAN_APPROVED,
    actorId: actor.agentId,
    payload: {
      reason: typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : null,
    },
  });
  return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
}
```

## Runtime wiring

`LocalToadRuntime` constructor: load risk policy from `${projectCwd}/.toad/risk-policy.json` on construction (when `projectCwd` is set), pass `riskPolicy` to the facade.

## TDD plan

1. **`riskClassifier` unit tests** (8-ish): no rules returns null/baseline; one matching rule elevates; multiple matches pick highest; non-matching files don't elevate; `requiresHumanApproval` is OR; baseline level is preserved when no rule matches; baseline approval flag is preserved when no rule sets it; pattern syntax (exact, `**`, dir prefix).
2. **`loadRiskPolicy` unit tests** (3): file present + valid; file missing → null; file present but malformed → null with no throw.
3. **Projection tests** in `taskBoard.test.js` (4): `RISK_CLASSIFIED` elevates `riskLevel` and `requiresHumanApproval`; `HUMAN_APPROVED` populates `humanApproval`; `humanApproval.approved` is `false` by default; `RISK_CLASSIFIED` cannot DEMOTE (sanity).
4. **Facade tests** (5+):
   - `review_request` with policy that doesn't match → no `RISK_CLASSIFIED`.
   - `review_request` with policy that matches → `RISK_CLASSIFIED` event, projection shows elevated values.
   - `task_human_approve` records the event + projection.
   - `task_human_approve` blocked for non-lead/human roles via roleAuthority.
   - `merge_ready → done` blocked when `requiresHumanApproval && !humanApproval.approved`.
   - `merge_ready → done` allowed after `task_human_approve` is recorded.
   - Operator-set `requiresHumanApproval: true` (without policy) still blocks — proves the gate works on explicit input too.
5. **Runtime test**: `LocalToadRuntime` reads `.toad/risk-policy.json` from projectCwd on construction; passes to facade.

## Out of scope for this slice

- Command-pattern rules (the policy looks at file paths only). Bash command classification is a follow-up.
- Auto-rolling-back the elevation when files change (the classifier only elevates per `review_request` call; a re-review with fewer files won't lower the elevation).
- UI presentation of the risk-classified event (the gap matrix has a UI plan; this slice ships the data).
- Promoting scope-drift / no-op-diff to `task_blocked` events (orthogonal slice).
