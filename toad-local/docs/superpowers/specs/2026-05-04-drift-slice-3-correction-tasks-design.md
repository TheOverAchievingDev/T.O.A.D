# Drift Monitor — Slice 3 (Correction-Task Generation) Design

**Status:** brainstormed 2026-05-04. Closes the loop from "engine reports drift" → "team fixes drift." Ready for plan + implementation.

**Cross-references:**
- Original drift design: `2026-05-03-drift-monitor-design.md` (slice 1 + §2 future-actions framing)
- Slice 2 spec: `2026-05-04-drift-slice-2-llm-tier-design.md` (LLM-semantic tier; introduced stable finding IDs that slice 3 leans on)
- Follow-up tracker: `2026-05-04-drift-followups-tracker.md` Section A (the bullets this spec resolves) — tick those boxes when this slice ships

## The pitch

Slices 1 + 2 produce findings. The operator sees them, swears, and remembers (or doesn't) to act on them. Slice 3 makes findings actionable: select one or more on the Drift screen, click **Create correction task**, edit the pre-filled subject/description/risk, submit, and the team gets a real task in backlog with the offending evidence baked in. Findings that are under remediation are visibly marked, excluded from score, and not re-emitted by the LLM tier — until the correction task hits `done` or `rejected`, at which point the engine re-evaluates from scratch.

## Decisions log (from brainstorming)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Manual vs automatic correction creation | **Manual primary.** Automatic auto-creation is deferred to slice 3.5 — needs real data on which findings become useful corrections before we set a default policy. The original Q3 of slice 1 said "engine read-only"; slice 3 punches through that wall on the conservative side. |
| Q2 | Direct task_create vs task_plan_propose vs editable modal | **Editable modal.** Operator edits subject/description/risk before submission; submit calls `task_create` directly. Findings are already the spec — `task_plan_propose` adds ceremony without signal. The modal is also where multi-select clustering happens. |
| Q3 | Correction-storm prevention | **Multi-select checkboxes** on finding cards; modal description aggregates all selected findings. The "select 3 → one task with combined description" pattern matches how email clients handle "archive all selected." |
| Q4 | Finding lifecycle once correction is in flight | **Visually distinguished + auto-resolve + skip re-emit.** Findings stay visible (auditability) but render with `opacity: 0.55` + a "Correction in progress: task #N" chip. Score subtracts in-flight findings. LLM tier-1/tier-2 skip-re-emit by `findingId` keeps Opus calls down. When the correction task hits `done` or `rejected`, the engine clears `correction_task_id` on the next run; if drift truly persists, the deterministic check re-emits. |

## 1. Architecture + data flow

```
DriftScreen finding list ──┐
  [✓] [✓] [ ] [✓]          │ operator selects 1+ findings, clicks "Create correction task"
                           ▼
            ┌──────────────────────────┐
            │ CorrectionTaskModal      │  edit subject/description/risk
            │ (pre-filled from         │  (description aggregates if multi-select)
            │  selected findings)      │
            └──────────┬───────────────┘
                       │ submit
                       ▼
              drift_correction_create  (new MCP command)
                       │
                       ├─→ taskBoard.create  (existing —
                       │     subject + description + riskLevel)
                       │     returns { taskId }
                       │
                       └─→ driftStore.linkCorrection(findingIds, taskId)
                              (new method — sets correction_task_id on each finding row)
```

Subsequent drift runs:

```
runDrift → checks emit findings → engine pre-filters via
                driftStore.findingsAwaitingCorrection(teamId)
              → matching finding IDs are SKIPPED (not emitted, not scored)
              → on each tick, engine also calls
                driftStore.reapResolvedCorrections(teamId, taskBoard)
                   → for any finding with correction_task_id set, look up task.status
                   → if status ∈ {done, rejected}: clear correction_task_id
                   → next deterministic re-check naturally re-emits if drift truly persists
```

## 2. Data model

**SQLite schema migration** (drift_findings already exists from slice 1):

```sql
ALTER TABLE drift_findings ADD COLUMN correction_task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_drift_findings_correction
  ON drift_findings(correction_task_id) WHERE correction_task_id IS NOT NULL;
```

The partial index makes "is this finding under remediation?" a single-row index lookup; same shape as `idx_plugin_resources_live` from slice 0+1.

**`DriftFinding` type** (in `src/drift/types.js` or wherever shipped today) gets one optional field:

```ts
correctionTaskId?: string | null
```

When `null`/missing: finding is active, contributes to score, eligible for LLM re-emit.
When set: finding is under remediation. Excluded from active score. LLM tier-1/tier-2 skip emitting any finding whose stable ID is in the suppressed Set.

## 3. Backend modules

### 3.1 `src/drift/driftCorrection.js` (new)

~80 LOC. Single-purpose orchestration helper:

```js
/**
 * Create a correction task and link it to the given findings.
 * Wraps taskBoard.create + driftStore.linkCorrection in a single
 * transactional flow. If task creation fails, no findings are linked.
 *
 * Returns { taskId, linkedFindingCount, riskLevel }.
 *
 * @param {object} args
 * @param {string} args.teamId
 * @param {string[]} args.findingIds          one or more finding IDs to link
 * @param {string} args.subject               1-line task subject
 * @param {string} args.description           markdown description (caller pre-aggregates if multi)
 * @param {'low'|'medium'|'high'} args.riskLevel
 * @param {object} args.taskBoard             InMemoryTaskBoard or SqliteTaskBoard
 * @param {object} args.driftStore            SqliteDriftStore
 */
export async function createDriftCorrection({
  teamId, findingIds, subject, description, riskLevel,
  taskBoard, driftStore,
}) { ... }
```

Validation:
- `findingIds` must be a non-empty array
- `subject` must be a non-empty string
- `riskLevel` must be one of low/medium/high (per existing risk rubric)
- All `findingIds` must exist in `drift_findings` for `teamId` (rejects cross-team linking)

### 3.2 `SqliteDriftStore` gains three methods

```js
/** Set correction_task_id on each finding row. Idempotent. */
linkCorrection({ findingIds, correctionTaskId })

/** Returns a Set<findingId> for findings with correction_task_id IS NOT NULL. */
findingsAwaitingCorrection({ teamId })

/**
 * For each finding with correction_task_id set, look up taskBoard.get(taskId).
 * If task.status is 'done' or 'rejected', clear correction_task_id on the row.
 * Returns the count of findings whose correction was reaped.
 */
reapResolvedCorrections({ teamId, taskBoard })
```

`linkCorrection` is idempotent — calling it twice with the same `correctionTaskId` is a no-op. Critical for the engine's per-run reap-then-link cycle in case of a re-run.

`reapResolvedCorrections` reads task status via the injected taskBoard; no direct cross-table SQL. Keeps the dependency direction one-way (drift → task), matching how slice 1 already reads `task_status` from snapshot.

### 3.3 New MCP command + facade dispatch

In `src/commands/command-contract.js`:

```js
DRIFT_CORRECTION_CREATE: 'drift_correction_create',
```

Add to `MUTATING_COMMANDS` (state-changing — needs idempotency).

In `src/security/roleAuthority.js`:
- `architect`, `lead`, `human` allowed
- `developer`, `reviewer`, `tester` denied (correction-task creation is a project-level coordination action, not implementation work)

In `src/tools/localToolFacade.js`:
- New constructor param `driftStore` already exists (slice 1) — no new injection
- New private handler `#driftCorrectionCreate(actor, args)` — delegates to `createDriftCorrection`
- New `case COMMANDS.DRIFT_CORRECTION_CREATE` in execute switch

In `src/mcp/localToolDefinitions.js`:
- Register `drift_correction_create` so MCP-mode agents (architect role) can call it

## 4. Engine integration

`src/drift/driftEngine.js` — `runDrift({ teamId, ... })` flow gains two pre/post steps:

```js
// BEFORE checks run
const suppressedIds = driftStore.findingsAwaitingCorrection({ teamId });

// (each check is called as today; they don't know about suppression)
const findings = await runChecks(snapshot, ...);

// AFTER checks emit, BEFORE scoring
const active = findings.filter(f => !suppressedIds.has(f.id));
const score = scoreFindings(active);

// AFTER scoring, BEFORE persisting + returning
const reaped = driftStore.reapResolvedCorrections({ teamId, taskBoard });
// Persist `findings` (the unfiltered list) so the UI can still render
// "Correction in progress" findings; persist `score` from the filtered set.
```

**Why filter at the engine, not in `scoreFindings`:** keeps `scoreFindings` pure — same input, same output. Engine owns the policy of which findings count.

**Why persist the unfiltered list:** the UI needs to render in-flight findings (greyed out + correction chip). If we dropped them at persist time, the UI would have no way to show "this is being remediated."

**Why call reap *after* scoring:** if a correction completes between two runs, the previous run's persisted score should reflect the finding still being suppressed. Reaping at the end means the *next* run picks up the cleared `correction_task_id` and either re-emits (if drift persists) or goes silent (if the correction worked).

## 5. UI changes

### 5.1 `DriftScreen.tsx` modifications

- Each finding card gets `<input type="checkbox" />` on the left edge
- Top of findings list: an action bar
  ```
  [Selected: 3]  [Create correction task]  ◯ Hide remediated findings
  ```
  - "Create correction task" button is disabled when 0 findings selected
  - "Hide remediated findings" toggle defaults to off
- Findings with `correctionTaskId` set render:
  - `opacity: 0.55`
  - A chip: `Correction in progress: task #abc123` (clickable → routes to task in TasksScreen)
  - Checkbox is disabled (can't select an already-remediated finding for re-correction)
- Score badge tooltip extension: "(2 findings under remediation)" appended when `findingsAwaitingCorrection.size > 0`

### 5.2 `ui/src/components/CorrectionTaskModal.tsx` (new)

~150 LOC. Modal triggered by the "Create correction task" button. Props:

```ts
interface Props {
  open: boolean;
  onClose: () => void;
  selectedFindings: DriftFinding[];   // 1+ findings
  teamId: string;
  onCreated: (result: { taskId: string }) => void;  // triggers refresh in parent
}
```

**Pre-fill logic:**
- `subject`:
  - 1 finding selected: use the finding's `title`
  - 2+ selected: `Drift correction (${count} findings)`
- `description` (markdown):
  ```md
  # Drift findings to address
  
  ## 1. {finding[0].title}
  - **Expected:** {finding[0].expected}
  - **Actual:** {finding[0].actual}
  - **Recommended correction:** {finding[0].recommendedCorrection}
  
  ## 2. {finding[1].title}
  ...
  ```
- `riskLevel`: max severity across selected findings, mapped:
  - `critical` or `high` → `high`
  - `medium` → `medium`
  - `low` → `low`

All three fields are editable in the modal (textarea for description, select for riskLevel). Submit button is disabled until subject is non-empty.

On submit:
```ts
await callTool({
  actor: { teamId, agentId: 'ui-client', role: 'human' },
  method: 'drift_correction_create',
  args: { findingIds, subject, description, riskLevel },
  idempotencyKey: `drift-correction-${Date.now()}-${selectedFindings[0].id}`,
});
```

On success: close modal, call `onCreated({ taskId })` → parent triggers DriftScreen refresh.

### 5.3 No styling beyond inline + existing `.btn` class

Slice 1+2 used inline styles for new finding-card affordances; slice 3 follows the same pattern to avoid the CSS-architecture rabbit hole. The modal uses an overlay div + a fixed-position card matching the existing approval-modal pattern in `ApprovalsDrawer.tsx`.

## 6. Testing

| File | New/Extend | Tests |
|------|-----------|-------|
| `test/drift/driftCorrection.test.js` | new | createDriftCorrection happy path; rejects empty findingIds; rejects bad riskLevel; rolls back link if task_create throws; rejects cross-team finding IDs |
| `test/sqliteDriftStore.test.js` | extend | linkCorrection idempotent; findingsAwaitingCorrection returns correct Set; reapResolvedCorrections clears for done; clears for rejected; leaves alone for in_progress |
| `test/drift/driftEngine.test.js` | extend | runDrift filters suppressed findings out of score; persists unfiltered findings; calls reap once per run; re-emits a finding after its correction task is rejected |
| `test/localToolFacade.test.js` | extend | drift_correction_create dispatches; role-gates architect/lead/human/deny developer; rejects when driftStore not configured |
| `test/roleAuthority.test.js` | extend | drift_correction_create role allowlist matches design |
| `test/drift/driftCorrection.integration.test.js` | new | end-to-end with real SqliteDriftStore + InMemoryTaskBoard: emit finding → create correction → next runDrift skips finding → mark task done → next runDrift re-emits |

Total: ~25 new test cases. UI changes verified via `cd ui && npx tsc --noEmit` (matching slice 2 — no UI runtime test infrastructure today; not adding it here).

## 7. Risks / non-goals

**Non-goals (slice 3):**
- Auto-creation of correction tasks (deferred to 3.5)
- Correction templates / boilerplate (e.g. "for a `out_of_scope_files` finding, auto-suggest `git revert`") — judgment-call territory; ship with operator-edited descriptions and add templates later if a real pattern emerges
- Bulk-resolve UI (mark multiple corrections done from drift screen) — operators do that via TasksScreen today
- Correction-task analytics (e.g. "drift findings have a 70% correction rate") — needs slice 3 to ship and accumulate data first

**Risks:**
- *Operator creates a correction, then drift re-runs before they assign it.* The finding stays suppressed; no double-task. Acceptable.
- *LLM tier-2 finding gets corrected, but the `recommendedCorrection` was wrong.* Operator edits the modal description. Worst case they create a useless task; cost is one task to triage + reject. Mitigation: this is exactly why the modal is editable.
- *Operator marks the correction task `done` without actually fixing anything.* Engine re-evaluates on next run; if drift persists, finding re-emits. The `done` status is operator-attested truth, not engine-attested.
- *Multi-select with mixed severities.* Modal pre-fills with max severity; operator can edit down. No special UX needed.

## 8. Module layout

```
src/drift/
  driftCorrection.js              ← NEW (orchestration helper)
  driftEngine.js                  ← MODIFY (suppression + reap hooks)
  sqliteDriftStore.js             ← MODIFY (3 new methods)
  types.js                        ← MODIFY (add correctionTaskId field)

src/storage/schema.sql            ← MODIFY (ALTER TABLE + new index)
src/commands/command-contract.js  ← MODIFY (DRIFT_CORRECTION_CREATE + MUTATING_COMMANDS)
src/security/roleAuthority.js     ← MODIFY (allowlist for architect/lead/human)
src/tools/localToolFacade.js      ← MODIFY (handler + dispatch)
src/mcp/localToolDefinitions.js   ← MODIFY (MCP registration)

ui/src/components/
  DriftScreen.tsx                 ← MODIFY (checkboxes + action bar + finding badge)
  CorrectionTaskModal.tsx         ← NEW

test/drift/
  driftCorrection.test.js         ← NEW
  driftCorrection.integration.test.js  ← NEW
  driftEngine.test.js             ← MODIFY (extend)
test/sqliteDriftStore.test.js     ← MODIFY (extend)
test/localToolFacade.test.js      ← MODIFY (extend)
test/roleAuthority.test.js        ← MODIFY (extend)
```

## 9. Estimated scope

- ~12-14 tasks for the implementation plan
- ~600-800 LOC backend + ~250 LOC UI
- 25 new test cases
- 2-3 days of subagent-driven execution

## 10. Self-review

- **Placeholders:** none (all sections concrete; data types named; method signatures shown).
- **Internal consistency:** decisions log Q1-Q4 ↔ architecture diagram ↔ testing matrix all line up. The "filter at engine, not in scoreFindings" rationale matches the slice-1 + slice-2 pattern (engine owns policy, checks/scoring stay pure).
- **Scope:** focused on a single coherent feature (correction-task generation). No multi-subsystem decomposition needed.
- **Ambiguity:** "max severity across selected findings" is explicit; "auto-resolve" semantics are explicit (clear `correction_task_id` when status ∈ {done, rejected}); "skip re-emit" is at the engine, not the check, so checks stay pure.
