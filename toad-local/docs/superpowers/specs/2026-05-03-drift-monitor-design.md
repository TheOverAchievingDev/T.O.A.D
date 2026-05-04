# Drift Monitor — Design

**Status:** approved (slice 1, deterministic engine)
**Author:** kaydenraquel + Claude (brainstorming session 2026-05-03)
**Source idea:** `C:\Users\Nova_\Downloads\drift_monitor_sketch.md`

---

## 1. Problem

A multi-agent team can drift away from its original spec in many ways: tasks
skip lifecycle states, code lands outside declared scope, "done" tasks never
actually merge, agents call tools their role shouldn't, reviewers rubber-stamp,
provider-specific code creeps into core modules. None of these are caught by
the existing safety rails (role authority, risk classifier) — those prevent
catastrophic failures, not gradual divergence.

The drift monitor surfaces a single, scrolling-friendly **drift score** plus a
list of **findings** so the operator can spot divergence early and intervene
before the team's output stops matching the Foundry spec.

## 2. Scope (slice 1)

**In scope:**
- Deterministic check engine (7 named checks listed below)
- SQLite persistence of findings + score history
- `drift_run` local tool / MCP command (read-only, role-guarded)
- Periodic + event-triggered + on-demand evaluation cadence
- Dedicated "Drift" screen in the UI sidebar
- Per-task drift badges on task cards

**Explicitly deferred:**
- LLM-semantic tier (slice 2)
- Correction-task generation (slice 3)
- Auto-fix application (slice 4)
- Titlebar drift chip (slice 2)

## 3. Architecture

```
drift_run({teamId, trigger}) ── localToolFacade command
   │
   ▼
buildSnapshot(teamId, deps) ──► DriftSnapshot
   │   reads:
   │   - taskBoard.listTasks
   │   - taskBoard.listTaskEvents
   │   - eventLog.listEvents
   │   - foundryStore.readDocs (architecture/steering/dod/checklist)
   │   - worktreeManager.listWorktrees
   │   - diffComputer.computeDiff per active worktree
   │   - taskEvents of type 'task.integration_merged' (merge evidence)
   │
   ▼
runChecks(snapshot, registry) ──► DriftFinding[]
   each check is src/drift/checks/<name>.js, pure function
   ─ checkInvalidTransitions
   ─ checkOutOfScopeFiles
   ─ checkMissingTestArtifacts
   ─ checkRolePermissionViolations
   ─ checkReviewWithoutFindings
   ─ checkProviderLogicLeakage
   ─ checkDoneWithoutMergeEvidence
   │
   ▼
scoreFindings(findings) ──► { teamScore, perTaskScores,
                              categoryScores, status }
   │
   ▼
driftStore.recordRun(score, findings, trigger) ──► SQLite
   │
   ▼
return { runId, asOf, teamScore, status, findings,
         categoryScores, perTaskScores, history, trigger }
```

### 3.1 Module layout

New module: `src/drift/`

| File | Responsibility |
|---|---|
| `driftEngine.js` | `runDrift({teamId, trigger, deps})` orchestrator |
| `buildSnapshot.js` | Gathers all inputs into `DriftSnapshot` |
| `scoreFindings.js` | Pure scoring (severity weights, thresholds, capping) |
| `driftStore.js` | SQLite reader/writer (current findings + score history) |
| `checks/checkInvalidTransitions.js` | Replay task lifecycle, flag illegal moves |
| `checks/checkOutOfScopeFiles.js` | Diff vs declared task scope |
| `checks/checkMissingTestArtifacts.js` | testing→merge_ready without test commands |
| `checks/checkRolePermissionViolations.js` | Count `tool_call_denied` events |
| `checks/checkReviewWithoutFindings.js` | review→testing without `review_feedback` |
| `checks/checkProviderLogicLeakage.js` | Provider imports inside core paths |
| `checks/checkDoneWithoutMergeEvidence.js` | done status, no merge_completed |

### 3.2 Wiring

- `LocalToolFacade` constructor adds `driftEngine` injection (default `null` for tests that don't need it; production wires the real one)
- `dev-api-server.mjs` constructs `DriftEngine` once with deps (`taskBoard`, `eventLog`, `foundryStore`, `worktreeManager`, `diffComputer`, `driftStore`, `runGit`), passes to facade
- New `drift_run` command in `command-contract.js`, role-guarded to `lead | architect | human`
- Periodic ticker lives in a new `DriftMonitor` class (parallel to `StuckRuntimeMonitor`), constructed in `dev-api-server.mjs`, runs every 60s while at least one runtime is live
- `task_event` listener kicks an off-cycle run after status transitions in `{review, testing, merge_ready, done}`

## 4. Schema

### 4.1 New SQLite tables

Migration appended to `src/storage/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS drift_findings (
  finding_id      TEXT PRIMARY KEY,           -- stable hash(category|taskId|kind)
  run_id          TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  task_id         TEXT,                       -- nullable: team-level findings have none
  category        TEXT NOT NULL,              -- architecture|checklist|slice_scope|test_truth|risk
  severity        TEXT NOT NULL,              -- info|low|medium|high|critical
  check_name      TEXT NOT NULL,
  title           TEXT NOT NULL,
  evidence_json   TEXT NOT NULL,              -- JSON array of strings
  expected        TEXT NOT NULL,
  actual          TEXT NOT NULL,
  recommended     TEXT NOT NULL,
  auto_fixable    INTEGER NOT NULL DEFAULT 0, -- bool 0/1; reserved for slice 3
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_findings_team ON drift_findings(team_id);
CREATE INDEX IF NOT EXISTS idx_drift_findings_task ON drift_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_drift_findings_run  ON drift_findings(run_id);

CREATE TABLE IF NOT EXISTS drift_score_history (
  run_id              TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL,
  team_score          INTEGER NOT NULL,         -- 0..100
  status              TEXT NOT NULL,            -- healthy|watch|warning|critical
  category_scores_json TEXT NOT NULL,           -- {"architecture": 6, ...}
  per_task_scores_json TEXT NOT NULL,           -- {"task-123": 32, ...}
  findings_count      INTEGER NOT NULL,
  trigger             TEXT NOT NULL,            -- 'manual' | 'periodic' | 'task_event'
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_score_history_team_time
  ON drift_score_history(team_id, created_at DESC);
```

### 4.2 Finding rotation

`drift_findings` is replaced wholesale on every successful run (delete-by-`team_id`, then insert new rows). The engine is the only writer. UI + `drift_run` callers are read-only.

### 4.3 History pruning

`driftStore.pruneHistory({teamId, keep: 500})` runs on every write. At a 60s cadence, 500 rows ≈ 8 hours of history per team. Older rows drop; findings auto-roll because the next run replaces them.

### 4.4 In-memory shapes (TypeScript-ish)

```ts
type DriftSnapshot = {
  teamId: string
  asOf: string
  tasks: Task[]
  taskEvents: TaskEvent[]
  runtimeEvents: RuntimeEvent[]
  foundryDocs: {
    architecture?: string
    steering?: string
    designDecisions?: string
    definitionOfDone?: string
    checklist?: string
  }
  worktrees: { taskId: string, path: string, baseRef: string }[]
  diffsByTask: Record<string, ComputedDiff>
}

type DriftFinding = {
  id: string
  runId: string
  teamId: string
  taskId: string | null
  category: 'architecture' | 'checklist' | 'slice_scope' | 'test_truth' | 'risk'
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  checkName: string
  title: string
  evidence: string[]
  expected: string
  actual: string
  recommendedCorrection: string
  autoFixable: boolean
}

type DriftRunResult = {
  runId: string
  asOf: string
  teamScore: number
  status: 'healthy' | 'watch' | 'warning' | 'critical'
  findings: DriftFinding[]
  categoryScores: Record<string, number>  // per-category 0..100
  perTaskScores: Record<string, number>   // {taskId: score}
  history: { runId: string, teamScore: number, createdAt: string }[]
  trigger: 'manual' | 'periodic' | 'task_event'
}
```

### 4.5 Scoring constants

From the source sketch, codified:

```js
const SEVERITY_WEIGHT = { info: 1, low: 3, medium: 8, high: 15, critical: 25 }
const STATUS_THRESHOLDS = [
  { max: 20, status: 'healthy' },
  { max: 40, status: 'watch' },
  { max: 65, status: 'warning' },
  { max: 100, status: 'critical' },
]
const TEAM_SCORE_CAP = 100
const PER_TASK_SCORE_CAP = 100
```

**Team score:** Sum of all finding weights (team-level + per-task), capped at 100.
**Per-task score:** Sum of weights for findings tagged with that `taskId`, capped at 100.
**Category score:** Filled-bar style — 100 means "no findings in this category"; computed as `100 - min(100, sum(weights in category))`. Matches the source sketch's "Architecture: 94%" wording where high = healthy.

## 5. Deterministic checks

| # | Check | Trigger condition | Severity | Category |
|---|---|---|---|---|
| 1 | `checkInvalidTransitions` | Replay `taskEvents`; any pair where `validateTaskStatusTransition({from, to})` returns `ok: false`. | high | architecture |
| 2 | `checkOutOfScopeFiles` | For each task in `{in_progress, review, testing, merge_ready}` with a worktree, compute diff. A changed file is out-of-scope when (a) `task.forbiddenFiles[]` matches it, OR (b) `task.allowedFiles[]` is non-empty and does NOT match it. (Both fields are projected on `Task` by `inMemoryTaskBoard.projectTask`.) | medium | slice_scope |
| 3 | `checkMissingTestArtifacts` | Tasks that transitioned `testing → merge_ready` without a `tool_call:Bash` runtime event since entering `testing` whose command matches one of: (a) any string in `task.testCommands[]` if the task declared them, OR (b) the fallback regex set `/\b(npm|pnpm|yarn) (test|run test)\b/`, `/\bpytest\b/`, `/\bcargo test\b/`, `/\bgo test\b/`, `/\bnode --test\b/`. | high | test_truth |
| 4 | `checkRolePermissionViolations` | Count `tool_call_denied` events in `runtimeEvents` since last run. One finding per denial. | medium | risk |
| 5 | `checkReviewWithoutFindings` | Tasks that transitioned `review → testing` with zero `review_feedback` events recorded during their `review` window. | low | checklist |
| 6 | `checkProviderLogicLeakage` | Static path-based heuristic: any file matching `src/{broker,task,team,security,policy,read,storage,delivery}/**` (the project's actual neutral subsystems) that contains an import of `@anthropic-ai/`, `openai`, `@google/generative-ai`, or `@lydell/node-pty`. | medium | architecture |
| 7 | `checkDoneWithoutMergeEvidence` | Tasks where status = `done` but the projected `task.integration` is null AND no `task.integration_merged` event exists in `taskEvents` for that task. | high | architecture |

Each check returns `DriftFinding[]`. Each `DriftFinding.id` is a stable hash of `(category, taskId ?? 'team', checkName, salient evidence keys)` so re-runs of the same check on the same offending state produce the same `finding_id` (lets the UI diff "fixed since last run" in slice 2 trivially).

## 6. UI

### 6.1 Drift screen

Path: `ui/src/components/DriftScreen.tsx`. Entry in `SidebarNav` between Audit and Costs.

Layout (top to bottom):
- **Header row:** Team drift score (big number + status pill) on the left; sparkline of last 30 runs + peak/current callout on the right; "Run check" button refreshes on demand.
- **Category breakdown:** Five horizontal bars, one per category, fill toward green when low drift.
- **Top drift sources:** First 4 findings sorted by severity weight desc, with a colored severity pill.
- **All findings:** Expandable cards per `DriftFinding`. Each card shows `title`, `category`, `taskId` (linkified), `expected`, `actual`, `evidence[]`, `recommendedCorrection`. Filter dropdown by `category` and `severity`.

Polling: on-mount + 60s interval (matches the backend periodic-tick cadence so the UI sees fresh data on each tick). The `drift_run` command returns cached results between actual engine ticks. Manual "Run check" forces an off-cycle run that bypasses the cache.

### 6.2 Per-task badges

Small pill on each task card in `TasksScreen` and `Workspace`'s board view:
- Color from severity threshold of the per-task score (green/yellow/orange/red)
- Text: `{score}%`
- Click jumps to Drift screen with task filter pre-applied

Source data: `perTaskScores` from `drift_run`'s return, surfaced via the same `useToadData` polling.

## 7. Testing strategy

TDD throughout — every check ships with a failing test that exercises a known-bad snapshot before its implementation lands.

| Piece | Test approach | New file |
|---|---|---|
| Each check (×7) | Build a synthetic `DriftSnapshot` fixture, call the check, assert findings shape + count + severity. | `test/drift/checks/<name>.test.js` × 7 |
| `scoreFindings` | Pure function, table-driven test with synthetic findings → expected scores + status. | `test/drift/scoreFindings.test.js` |
| `buildSnapshot` | Inject fakes for taskBoard / eventLog / foundryStore / worktreeManager / diffComputer; assert snapshot fields. | `test/drift/buildSnapshot.test.js` |
| `driftStore` | sqlite-backed; reuses existing pattern (see `sqliteRuntimeEventLog.test.js`). | `test/drift/driftStore.test.js` |
| `driftEngine` integration | Real builders + checks, against an in-memory team with seeded events. | `test/drift/driftEngine.test.js` |
| `drift_run` MCP/local-tool | Existing `localToolFacade.test.js` pattern: command shape, role guard, return contract. | Append to `test/localToolFacade.test.js` |

`package.json`'s `test` script is extended with the new files in dependency order (checks first, then scoring, then store, then engine, then facade integration).

## 8. Risk + non-goals

- **Not** a substitute for human review. Drift score is a heuristic; high score should prompt a closer look, not auto-revert.
- **Not** a replacement for `riskClassifier` or `roleAuthority`. Those prevent specific bad actions; drift detects gradual divergence.
- The provider-logic-leakage check is path+import based and will produce false positives in transitional refactors. Severity is medium for that reason.
- Periodic + event-triggered evaluation can produce overlapping runs; the engine takes a per-team mutex so only one `drift_run` is in flight at a time.

## 9. Open questions (for slice 2+)

- Should `DriftFinding.id` collisions across runs (same finding reappearing) suppress duplicates in the score? Slice 1: count each occurrence. Slice 2 may add diff-aware scoring.
- Should team-level findings (no `taskId`) decay over time if not surfaced again? Slice 1: replaced wholesale on every run, so they vanish if a check stops firing.
- LLM-semantic tier (slice 2): one new check file per question (e.g. `checkPlanStillAlignsWithSteering.js`), gated on a config flag, runs only on-demand or once per N periodic ticks.

## 10. Decisions log (from brainstorming)

- **Q1:** Hybrid cadence (deterministic continuous + LLM on-demand), but slice 1 ships only deterministic continuous.
- **Q2:** Per-task scores + team rollup. Per-task badges on cards, full dashboard in dedicated screen.
- **Q3:** Engine only (read-only) for slice 1. No correction-task generation, no auto-fix.
- **Q4:** Persist findings + score history to SQLite from day one.
- **Q5:** Dedicated Drift screen in SidebarNav. No titlebar chip in slice 1.
- **Approach:** Pluggable check registry (one pure function per check file) over single-engine-function or class+strategy.
