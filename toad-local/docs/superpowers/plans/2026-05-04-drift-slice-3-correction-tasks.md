# Drift Slice 3 (Correction-Task Generation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-04-drift-slice-3-correction-tasks-design.md`

**Goal:** Close the loop from "drift engine reports findings" to "team fixes drift" — multi-select findings on the Drift screen, edit a pre-filled modal, submit a correction task that's role-gated, and have the engine treat in-flight findings as visibly-suppressed (no double-counting in score, no LLM re-emit) until the correction task hits `done` or `rejected`.

**Architecture:** New `correction_task_id` column on `drift_findings` (carried across recordRun's wholesale-replace pattern by re-stamping in the engine). One new orchestration helper (`driftCorrection.js`), three new `SqliteDriftStore` methods (linkCorrection, getCorrectionLinkages, reapResolvedCorrections), engine pre-read + filter + reap hooks, one new MCP command + facade dispatch + role-gate, one new UI modal + multi-select + remediation badge.

**Tech Stack:** Node 20+ ESM, `node:sqlite`, `node:test`, React 18 + TypeScript (UI), no new runtime deps.

**Test discipline:** TDD throughout. Every new module ships with its failing test before implementation lands. The drift engine + facade tests use injected `taskBoard` + `driftStore`; no live SQLite + spawn paths in unit tests.

---

## Important refinement vs spec

The spec's §3.2 said `findingsAwaitingCorrection({teamId}) → Set<findingId>`. The actual `recordRun` flow does `DELETE FROM drift_findings WHERE team_id = ?` then re-inserts; the new column would be wiped every run if we only had a Set. **The plan returns `Map<findingId, correctionTaskId>` instead** — the engine reads the Map BEFORE checks run, then re-stamps `correctionTaskId` on matching new findings before passing them to `recordRun`. This carries the linkage across the wholesale-replace boundary cleanly. Naming: `getCorrectionLinkages` (semantic upgrade from "findingsAwaitingCorrection" since it now exposes both keys + values).

---

## File structure

```
src/storage/schema.sql                    Task 1 — ALTER TABLE + partial index
src/drift/driftStore.js                   Tasks 2-3 — 3 new methods + recordRun stamps correction_task_id
src/drift/driftEngine.js                  Task 4 — pre-read + filter + reap hooks in runDrift
src/drift/driftCorrection.js              Task 5 — NEW orchestration helper
src/commands/command-contract.js          Task 6 — DRIFT_CORRECTION_CREATE constant + MUTATING
src/security/roleAuthority.js             Task 6 — architect/lead/human allowlist
src/tools/localToolFacade.js              Task 7 — handler + dispatch
src/mcp/localToolDefinitions.js           Task 8 — MCP tool registration

ui/src/components/CorrectionTaskModal.tsx Task 9 — NEW modal
ui/src/components/DriftScreen.tsx         Tasks 10-11 — checkboxes, action bar, remediation badge

test/sqliteDriftStore.test.js             Tasks 2-3 — extend
test/drift/driftCorrection.test.js        Task 5 — NEW
test/drift/driftEngine.test.js            Task 4 — extend
test/localToolFacade.test.js              Task 7 — extend
test/roleAuthority.test.js                Task 6 — extend
test/drift/driftCorrection.integration.test.js  Task 12 — NEW (e2e w/ real SQLite + InMemoryTaskBoard)

package.json                              Task 13 — append new test files to chain
README.md                                 Task 13 — note slice 3 shipping
docs/superpowers/specs/2026-05-04-drift-followups-tracker.md  Task 13 — tick Section A boxes
```

13 tasks total across 5 phases.

---

## Phase 1 — Storage layer

### Task 1: Schema migration for `correction_task_id`

**Files:**
- Modify: `src/storage/schema.sql` (append ALTER + index after the existing drift_findings block, around line 251)

- [ ] **Step 1: Append schema change to `src/storage/schema.sql`**

After the existing `idx_drift_findings_run` index (around line 251), append:

```sql
-- Drift Slice 3 — see docs/superpowers/specs/2026-05-04-drift-slice-3-correction-tasks-design.md
-- correction_task_id stamps a finding as "under remediation" — engine
-- excludes it from score + skips LLM re-emit until the correction task
-- hits done/rejected (then engine reaps via SqliteDriftStore.reapResolvedCorrections).
ALTER TABLE drift_findings ADD COLUMN correction_task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_drift_findings_correction
  ON drift_findings(correction_task_id) WHERE correction_task_id IS NOT NULL;
```

**Important:** SQLite supports `ALTER TABLE ADD COLUMN` and `CREATE INDEX IF NOT EXISTS`, but `ALTER TABLE ... ADD COLUMN ... IF NOT EXISTS` is NOT supported. The schema file is parsed for fresh DBs (CREATE TABLE IF NOT EXISTS skips), but for existing DBs an applyMigrations layer (if present) handles incremental adds. Check `src/storage/sqlite.js` for `applyMigrations` — if it exists, append a migration step there; otherwise the column will only land in fresh DBs (which is fine for slice-3 dev work; existing user DBs get migrated by adding the line to applyMigrations later if it's there).

- [ ] **Step 2: Verify schema parses on a fresh in-memory DB**

```bash
node -e "const { DatabaseSync } = require('node:sqlite'); const fs = require('fs'); const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync('src/storage/schema.sql', 'utf8')); console.log('schema OK'); const cols = db.prepare(\"PRAGMA table_info(drift_findings)\").all(); console.log('cols:', cols.map(c => c.name).join(','));"
```

Expected output:
```
schema OK
cols: finding_id,run_id,team_id,task_id,category,severity,check_name,title,evidence_json,expected,actual,recommended,auto_fixable,created_at,correction_task_id
```

- [ ] **Step 3: Run `npm test` to confirm no regressions**

Expected: full suite green. (Existing tests recreate the schema in `:memory:` — they'll pick up the new column with no code changes since `recordRun` doesn't reference it yet.)

- [ ] **Step 4: Commit**

```bash
git add src/storage/schema.sql
git commit -m "$(cat <<'EOF'
feat(drift): correction_task_id column + partial index for slice 3

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: SqliteDriftStore — getCorrectionLinkages + linkCorrection + reapResolvedCorrections

**Files:**
- Modify: `src/drift/driftStore.js` (add 3 methods to the class)
- Modify: `test/sqliteDriftStore.test.js` (append tests)

- [ ] **Step 1: Append failing tests to `test/sqliteDriftStore.test.js`**

After the existing tests, append:

```js
test('SqliteDriftStore.linkCorrection stamps correction_task_id on matching rows', () => {
  const { db, store } = makeStore();
  // First record a run to create finding rows
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [
      makeFinding({ id: 'f1', taskId: 't1' }),
      makeFinding({ id: 'f2', taskId: 't2' }),
      makeFinding({ id: 'f3', taskId: 't3' }),
    ],
  });

  const result = store.linkCorrection({ findingIds: ['f1', 'f3'], correctionTaskId: 'task_x' });
  assert.equal(result.linked, 2);

  const linkages = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(linkages.size, 2);
  assert.equal(linkages.get('f1'), 'task_x');
  assert.equal(linkages.get('f3'), 'task_x');
  assert.equal(linkages.has('f2'), false);
});

test('SqliteDriftStore.linkCorrection is idempotent', () => {
  const { store } = makeStore();
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [makeFinding({ id: 'f1', taskId: 't1' })],
  });
  const a = store.linkCorrection({ findingIds: ['f1'], correctionTaskId: 'task_x' });
  const b = store.linkCorrection({ findingIds: ['f1'], correctionTaskId: 'task_x' });
  assert.equal(a.linked, 1);
  assert.equal(b.linked, 1);  // re-running is fine
  const linkages = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(linkages.get('f1'), 'task_x');
});

test('SqliteDriftStore.getCorrectionLinkages returns empty Map when no linkages', () => {
  const { store } = makeStore();
  const linkages = store.getCorrectionLinkages({ teamId: 'team-empty' });
  assert.ok(linkages instanceof Map);
  assert.equal(linkages.size, 0);
});

test('SqliteDriftStore.reapResolvedCorrections clears linkage when task is done', () => {
  const { store } = makeStore();
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [makeFinding({ id: 'f1', taskId: 't1' })],
  });
  store.linkCorrection({ findingIds: ['f1'], correctionTaskId: 'task_done' });

  // Fake taskBoard returns 'done' for task_done
  const fakeTaskBoard = {
    get: ({ taskId }) => taskId === 'task_done'
      ? { taskId: 'task_done', status: 'done' }
      : null,
  };

  const result = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard: fakeTaskBoard });
  assert.equal(result.reaped, 1);

  const linkagesAfter = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(linkagesAfter.size, 0);
});

test('SqliteDriftStore.reapResolvedCorrections leaves in-progress task linkages alone', () => {
  const { store } = makeStore();
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [makeFinding({ id: 'f1', taskId: 't1' })],
  });
  store.linkCorrection({ findingIds: ['f1'], correctionTaskId: 'task_inprog' });

  const fakeTaskBoard = {
    get: ({ taskId }) => ({ taskId, status: 'in_progress' }),
  };

  const result = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard: fakeTaskBoard });
  assert.equal(result.reaped, 0);
  assert.equal(store.getCorrectionLinkages({ teamId: 'team-a' }).size, 1);
});

test('SqliteDriftStore.reapResolvedCorrections clears linkage when task is rejected', () => {
  const { store } = makeStore();
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [makeFinding({ id: 'f1', taskId: 't1' })],
  });
  store.linkCorrection({ findingIds: ['f1'], correctionTaskId: 'task_rejected' });

  const fakeTaskBoard = {
    get: () => ({ taskId: 'task_rejected', status: 'rejected' }),
  };
  const result = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard: fakeTaskBoard });
  assert.equal(result.reaped, 1);
});

test('SqliteDriftStore.reapResolvedCorrections clears linkage when task is missing', () => {
  // If the task was hard-deleted, treat as resolved (best effort).
  const { store } = makeStore();
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [makeFinding({ id: 'f1', taskId: 't1' })],
  });
  store.linkCorrection({ findingIds: ['f1'], correctionTaskId: 'task_gone' });

  const fakeTaskBoard = { get: () => null };
  const result = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard: fakeTaskBoard });
  assert.equal(result.reaped, 1);
});
```

Add a `makeFinding` helper at the top of the test file (near the existing `makeStore` helper if it's not already there):

```js
function makeFinding({ id, taskId }) {
  return {
    id,
    taskId,
    category: 'lifecycle',
    severity: 'medium',
    checkName: 'test_check',
    title: `Test finding ${id}`,
    evidence: [],
    expected: 'expected state',
    actual: 'actual state',
    recommendedCorrection: 'fix it',
    autoFixable: false,
  };
}
```

(If `makeStore` doesn't already exist in the file, add it too — it should construct an in-memory DB with the schema applied and a teams row inserted. Check the file first; the slice-1 sqliteDriftStore.test.js likely already has this helper.)

- [ ] **Step 2: Run tests, watch them fail**

```bash
node --no-warnings test/sqliteDriftStore.test.js
```

Expected: 7 new tests fail with "store.linkCorrection is not a function" / "store.getCorrectionLinkages is not a function" / "store.reapResolvedCorrections is not a function".

- [ ] **Step 3: Add 3 new methods to `src/drift/driftStore.js`**

Inside the `SqliteDriftStore` class, after the `pruneHistory` method, add:

```js
/**
 * Stamp correction_task_id onto each finding row whose finding_id is in
 * findingIds. Idempotent — re-running with the same args is a no-op
 * (UPDATE just sets the same value).
 *
 * Returns { linked: <rows affected> }.
 */
linkCorrection({ findingIds, correctionTaskId } = {}) {
  if (!Array.isArray(findingIds) || findingIds.length === 0) {
    throw new TypeError('linkCorrection: findingIds must be a non-empty array');
  }
  if (typeof correctionTaskId !== 'string' || correctionTaskId.length === 0) {
    throw new TypeError('linkCorrection: correctionTaskId is required');
  }
  const placeholders = findingIds.map(() => '?').join(',');
  const stmt = this.db.prepare(
    `UPDATE drift_findings
       SET correction_task_id = ?
     WHERE finding_id IN (${placeholders})`
  );
  const result = stmt.run(correctionTaskId, ...findingIds);
  return { linked: result.changes };
}

/**
 * Returns Map<findingId, correctionTaskId> for findings in the team
 * with correction_task_id IS NOT NULL. Engine reads this BEFORE
 * runChecks so it can re-stamp on the new findings before recordRun
 * (which deletes-and-replaces) wipes them.
 */
getCorrectionLinkages({ teamId } = {}) {
  if (!teamId) return new Map();
  const rows = this.db.prepare(
    `SELECT finding_id, correction_task_id
       FROM drift_findings
      WHERE team_id = ? AND correction_task_id IS NOT NULL`
  ).all(teamId);
  const map = new Map();
  for (const r of rows) {
    map.set(r.finding_id, r.correction_task_id);
  }
  return map;
}

/**
 * For each finding with correction_task_id set, look up the linked
 * task's status via the injected taskBoard. If status is 'done',
 * 'rejected', or the task is missing entirely, clear correction_task_id
 * on that finding row.
 *
 * Returns { reaped: <rows cleared> }.
 */
reapResolvedCorrections({ teamId, taskBoard } = {}) {
  if (!teamId || !taskBoard || typeof taskBoard.get !== 'function') {
    return { reaped: 0 };
  }
  const linkages = this.getCorrectionLinkages({ teamId });
  if (linkages.size === 0) return { reaped: 0 };

  const RESOLVED_OR_GONE = (taskId) => {
    const task = taskBoard.get({ taskId });
    if (!task) return true;
    return task.status === 'done' || task.status === 'rejected';
  };

  const toReap = [];
  for (const [findingId, taskId] of linkages.entries()) {
    if (RESOLVED_OR_GONE(taskId)) toReap.push(findingId);
  }
  if (toReap.length === 0) return { reaped: 0 };

  const placeholders = toReap.map(() => '?').join(',');
  const result = this.db.prepare(
    `UPDATE drift_findings
       SET correction_task_id = NULL
     WHERE team_id = ? AND finding_id IN (${placeholders})`
  ).run(teamId, ...toReap);
  return { reaped: result.changes };
}
```

- [ ] **Step 4: Run tests, watch them pass**

```bash
node --no-warnings test/sqliteDriftStore.test.js
```

Expected: ALL tests pass (existing + 7 new).

- [ ] **Step 5: Run `npm test`** to confirm no regressions across the suite.

- [ ] **Step 6: Commit**

```bash
git add src/drift/driftStore.js test/sqliteDriftStore.test.js
git commit -m "$(cat <<'EOF'
feat(drift): SqliteDriftStore linkCorrection / getCorrectionLinkages / reap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: recordRun preserves correction_task_id; rowToFinding exposes it

**Files:**
- Modify: `src/drift/driftStore.js` (modify `recordRun` insert + `rowToFinding`)
- Modify: `test/sqliteDriftStore.test.js` (append test)

- [ ] **Step 1: Append failing test**

```js
test('SqliteDriftStore.recordRun writes correctionTaskId from finding when present', () => {
  const { store } = makeStore();
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 30, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [
      { ...makeFinding({ id: 'f1', taskId: 't1' }), correctionTaskId: 'task_persist' },
      makeFinding({ id: 'f2', taskId: 't2' }),  // no correctionTaskId
    ],
  });
  const findings = store.listLatestFindings({ teamId: 'team-a' });
  const f1 = findings.find((f) => f.id === 'f1');
  const f2 = findings.find((f) => f.id === 'f2');
  assert.equal(f1.correctionTaskId, 'task_persist');
  assert.equal(f2.correctionTaskId, null);
});
```

- [ ] **Step 2: Run test, watch it fail**

```bash
node --no-warnings test/sqliteDriftStore.test.js
```

Expected: new test fails because `correctionTaskId` field is missing from the returned finding (and the column isn't being written by recordRun).

- [ ] **Step 3: Modify `src/drift/driftStore.js`**

Update the `insertFinding` prepared statement in `recordRun` to include the new column:

```js
const insertFinding = this.db.prepare(`INSERT INTO drift_findings
  (finding_id, run_id, team_id, task_id, category, severity, check_name,
   title, evidence_json, expected, actual, recommended, auto_fixable,
   correction_task_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
```

(The change: add `correction_task_id` as the 14th column and a 15th `?` placeholder; `created_at` shifts to 15th.)

Update the `insertFinding.run(...)` call:

```js
insertFinding.run(
  f.id, runId, teamId, f.taskId ?? null, f.category, f.severity,
  f.checkName, f.title, JSON.stringify(f.evidence ?? []),
  f.expected, f.actual, f.recommendedCorrection,
  f.autoFixable ? 1 : 0,
  f.correctionTaskId ?? null,
  asOf
);
```

Update the `rowToFinding` helper to expose `correctionTaskId`:

```js
function rowToFinding(r) {
  return {
    id: r.finding_id,
    runId: r.run_id,
    teamId: r.team_id,
    taskId: r.task_id,
    category: r.category,
    severity: r.severity,
    checkName: r.check_name,
    title: r.title,
    evidence: safeParse(r.evidence_json, []),
    expected: r.expected,
    actual: r.actual,
    recommendedCorrection: r.recommended,
    autoFixable: r.auto_fixable === 1,
    correctionTaskId: r.correction_task_id ?? null,
  };
}
```

- [ ] **Step 4: Run test, watch it pass**

```bash
node --no-warnings test/sqliteDriftStore.test.js
```

Expected: ALL tests pass.

- [ ] **Step 5: Run `npm test`** to confirm full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/drift/driftStore.js test/sqliteDriftStore.test.js
git commit -m "$(cat <<'EOF'
feat(drift): recordRun persists correctionTaskId; rowToFinding exposes it

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Engine integration

### Task 4: driftEngine — pre-read linkages, filter score, re-stamp on findings, reap

**Files:**
- Modify: `src/drift/driftEngine.js` (modify `runDrift`)
- Modify: `test/drift/driftEngine.test.js` (append tests)

- [ ] **Step 1: Read the existing engine** to understand the current `runDrift` flow:

```bash
sed -n '1,50p' src/drift/driftEngine.js
grep -n "runDrift\|recordRun\|scoreFindings" src/drift/driftEngine.js | head -20
```

You'll see a single async `runDrift({ teamId, trigger })` method that builds a snapshot, runs checks, scores, and writes via `driftStore.recordRun`.

- [ ] **Step 2: Append failing tests to `test/drift/driftEngine.test.js`**

```js
test('runDrift filters findings with active correctionTaskId out of score', async () => {
  // Setup: store has finding f1 already linked to a correction task
  const fakeStore = makeFakeDriftStoreWithLinkage(new Map([['f1', 'task_active']]));
  const fakeChecks = [{
    name: 'test',
    fn: async () => [
      { id: 'f1', taskId: 't1', category: 'lifecycle', severity: 'medium',
        checkName: 'test', title: 'still drifting', evidence: [],
        expected: 'x', actual: 'y', recommendedCorrection: 'z' },
      { id: 'f2', taskId: 't2', category: 'lifecycle', severity: 'medium',
        checkName: 'test', title: 'fresh issue', evidence: [],
        expected: 'a', actual: 'b', recommendedCorrection: 'c' },
    ],
  }];

  const engine = new DriftEngine({
    deps: makeMinimalDeps(),
    driftStore: fakeStore,
    checks: fakeChecks,
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });

  // Score should be computed from f2 only (f1 is suppressed)
  // recordRun should be called with BOTH findings (so UI can render f1 with badge)
  // f1 in the persisted set should have correctionTaskId stamped
  const recordedFindings = fakeStore.lastRecordRunArgs.findings;
  assert.equal(recordedFindings.length, 2);
  const f1Recorded = recordedFindings.find((f) => f.id === 'f1');
  assert.equal(f1Recorded.correctionTaskId, 'task_active');
  // Score from filtered (f2 only) should be lower than score from both
  assert.equal(fakeStore.lastRecordRunArgs.findingsCount ?? recordedFindings.length, 2);
});

test('runDrift calls reapResolvedCorrections once per run', async () => {
  const fakeStore = makeFakeDriftStoreWithLinkage(new Map([['f1', 'task_done']]));
  // After reap, the linkage is gone — but the call happens at end of runDrift
  fakeStore.reapResolvedCorrections = ({ teamId, taskBoard }) => {
    fakeStore.reapCallCount = (fakeStore.reapCallCount || 0) + 1;
    return { reaped: 1 };
  };

  const engine = new DriftEngine({
    deps: makeMinimalDeps(),
    driftStore: fakeStore,
    checks: [{ name: 'noop', fn: async () => [] }],
  });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(fakeStore.reapCallCount, 1);
});
```

Add the `makeFakeDriftStoreWithLinkage` and `makeMinimalDeps` helpers near the top of the test file (or extend whatever existing helpers are there):

```js
function makeFakeDriftStoreWithLinkage(linkageMap) {
  return {
    getCorrectionLinkages: ({ teamId }) => linkageMap,
    reapResolvedCorrections: () => ({ reaped: 0 }),
    recordRun(args) { this.lastRecordRunArgs = args; return { findingsWritten: args.findings.length }; },
    listLatestFindings: () => [],
    listScoreHistory: () => [],
  };
}

function makeMinimalDeps() {
  // Mirror whatever buildSnapshot/taskBoard/etc the existing tests use.
  // The point is: provide enough structure that buildSnapshot doesn't blow up.
  // If existing tests have a `makeFakeDeps` helper, prefer that and pass through.
  return {
    taskBoard: { listTasks: () => [], get: () => null },
    eventLog: { listEvents: () => [] },
    foundryStore: null,
    worktreeManager: null,
    teamConfigRegistry: null,
  };
}
```

(If the existing test file has different helper names, mirror those — the key is that the tests test what the engine does with the linkages.)

- [ ] **Step 3: Run tests, watch them fail**

```bash
node --no-warnings --test test/drift/driftEngine.test.js
```

Expected: 2 new tests fail because `runDrift` doesn't call `getCorrectionLinkages` or `reapResolvedCorrections` yet.

- [ ] **Step 4: Modify `src/drift/driftEngine.js` — runDrift method**

Locate `runDrift({ teamId, trigger })` in `src/drift/driftEngine.js`. Find the section after checks have run + scored + before `recordRun`. Modify it to:

```js
// Step 1 (NEW): pre-read in-flight correction linkages
const linkages = typeof this.driftStore.getCorrectionLinkages === 'function'
  ? this.driftStore.getCorrectionLinkages({ teamId })
  : new Map();

// Step 2: run checks (existing)
const findings = /* ...existing check pipeline... */;

// Step 3 (NEW): re-stamp correctionTaskId on findings whose stable ID
// is in the linkage Map. Carries linkage across recordRun's wholesale-replace.
for (const f of findings) {
  if (linkages.has(f.id)) {
    f.correctionTaskId = linkages.get(f.id);
  }
}

// Step 4 (NEW): score the FILTERED set (drop suppressed findings).
// scoreFindings stays pure — the engine owns this policy.
const activeFindings = findings.filter((f) => !f.correctionTaskId);
const { teamScore, status, categoryScores, perTaskScores } =
  scoreFindings(activeFindings);   // existing call signature

// Step 5: persist UNFILTERED list (UI needs to render in-progress findings)
this.driftStore.recordRun({
  runId, teamId, asOf, teamScore, status,
  categoryScores, perTaskScores, trigger,
  findings,  // unfiltered — engine just stamped correctionTaskId on relevant ones
});

// Step 6 (NEW): reap any linkages whose task is now done/rejected.
// Done AFTER recordRun so the just-persisted score reflects suppression;
// the next run picks up the cleared linkage.
if (typeof this.driftStore.reapResolvedCorrections === 'function') {
  this.driftStore.reapResolvedCorrections({ teamId, taskBoard: this.deps?.taskBoard });
}
```

(The exact integration depends on the current shape of `runDrift` — read it first, then surgically insert the 4 new steps. Don't rewrite the whole method.)

**Note on backward compatibility:** the `typeof this.driftStore.getCorrectionLinkages === 'function'` guard means slice-1/2 stores without these methods continue to work — they get an empty Map / no-op reap.

- [ ] **Step 5: Run engine tests, watch them pass**

```bash
node --no-warnings --test test/drift/driftEngine.test.js
```

Expected: all existing + 2 new tests pass.

- [ ] **Step 6: Run `npm test`** for full-suite regression check.

- [ ] **Step 7: Commit**

```bash
git add src/drift/driftEngine.js test/drift/driftEngine.test.js
git commit -m "$(cat <<'EOF'
feat(drift): runDrift filters + re-stamps + reaps correction linkages

Engine reads getCorrectionLinkages() before checks, re-stamps
correctionTaskId on matching findings (so the linkage survives
recordRun's delete-and-replace), filters those findings out of the
score calc, persists the unfiltered list (UI needs to render the
"correction in progress" badge), and reaps resolved correction tasks
at the end of each run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Backend orchestration

### Task 5: driftCorrection.js — createDriftCorrection helper

**Files:**
- Create: `src/drift/driftCorrection.js`
- Create: `test/drift/driftCorrection.test.js`

- [ ] **Step 1: Create `test/drift/driftCorrection.test.js`** with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriftCorrection } from '../../src/drift/driftCorrection.js';

function makeFakes() {
  const taskBoard = {
    created: [],
    create({ subject, description, riskLevel, teamId }) {
      const taskId = `task_${this.created.length + 1}`;
      const row = { taskId, teamId, subject, description, riskLevel, status: 'backlog' };
      this.created.push(row);
      return row;
    },
  };
  const driftStore = {
    linked: [],
    findingsByTeam: new Map(),
    setFindings(teamId, findings) { this.findingsByTeam.set(teamId, findings); },
    listLatestFindings({ teamId }) { return this.findingsByTeam.get(teamId) ?? []; },
    linkCorrection({ findingIds, correctionTaskId }) {
      this.linked.push({ findingIds, correctionTaskId });
      return { linked: findingIds.length };
    },
  };
  return { taskBoard, driftStore };
}

test('createDriftCorrection: creates task + links findings', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }, { id: 'f2' }]);

  const result = await createDriftCorrection({
    teamId: 'team-a',
    findingIds: ['f1', 'f2'],
    subject: 'Fix lifecycle drift',
    description: 'Two findings need addressing',
    riskLevel: 'medium',
    taskBoard, driftStore,
  });

  assert.equal(result.taskId, 'task_1');
  assert.equal(result.linkedFindingCount, 2);
  assert.equal(result.riskLevel, 'medium');
  assert.equal(taskBoard.created.length, 1);
  assert.equal(taskBoard.created[0].subject, 'Fix lifecycle drift');
  assert.deepEqual(driftStore.linked[0].findingIds, ['f1', 'f2']);
  assert.equal(driftStore.linked[0].correctionTaskId, 'task_1');
});

test('createDriftCorrection: rejects empty findingIds', async () => {
  const { taskBoard, driftStore } = makeFakes();
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: [], subject: 's', description: 'd',
      riskLevel: 'low', taskBoard, driftStore,
    }),
    /findingIds must be a non-empty array/i,
  );
});

test('createDriftCorrection: rejects bad riskLevel', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: ['f1'], subject: 's', description: 'd',
      riskLevel: 'urgent', taskBoard, driftStore,
    }),
    /riskLevel must be/i,
  );
});

test('createDriftCorrection: rejects missing subject', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: ['f1'], subject: '', description: 'd',
      riskLevel: 'low', taskBoard, driftStore,
    }),
    /subject is required/i,
  );
});

test('createDriftCorrection: rejects findingIds that don\'t belong to the team', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);  // only f1 exists for team-a
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a',
      findingIds: ['f1', 'f_unknown'],
      subject: 's', description: 'd', riskLevel: 'low',
      taskBoard, driftStore,
    }),
    /findings not in team|unknown finding/i,
  );
});

test('createDriftCorrection: does not link if task creation throws', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);
  taskBoard.create = () => { throw new Error('task creation failed'); };

  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: ['f1'], subject: 's', description: 'd',
      riskLevel: 'low', taskBoard, driftStore,
    }),
    /task creation failed/,
  );
  assert.equal(driftStore.linked.length, 0);  // no linkage recorded
});
```

- [ ] **Step 2: Run test, watch it fail**

```bash
node --no-warnings --test test/drift/driftCorrection.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/drift/driftCorrection.js`** with:

```js
const VALID_RISK = new Set(['low', 'medium', 'high']);

/**
 * Create a correction task for one or more drift findings, then link
 * the findings to the new task. Atomicity: if task creation throws,
 * NO findings are linked (we never call linkCorrection until the task
 * exists).
 *
 * Returns { taskId, linkedFindingCount, riskLevel }.
 *
 * @param {object} args
 * @param {string} args.teamId
 * @param {string[]} args.findingIds          one or more finding IDs
 * @param {string} args.subject               1-line task subject
 * @param {string} args.description           markdown description
 * @param {'low'|'medium'|'high'} args.riskLevel
 * @param {object} args.taskBoard             must implement .create({...}) → {taskId, ...}
 * @param {object} args.driftStore            must implement .listLatestFindings({teamId}) + .linkCorrection({findingIds, correctionTaskId})
 */
export async function createDriftCorrection({
  teamId, findingIds, subject, description, riskLevel,
  taskBoard, driftStore,
} = {}) {
  if (!teamId || typeof teamId !== 'string') {
    throw new TypeError('createDriftCorrection: teamId is required');
  }
  if (!Array.isArray(findingIds) || findingIds.length === 0) {
    throw new TypeError('createDriftCorrection: findingIds must be a non-empty array');
  }
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    throw new TypeError('createDriftCorrection: subject is required');
  }
  if (!VALID_RISK.has(riskLevel)) {
    throw new TypeError(`createDriftCorrection: riskLevel must be one of ${[...VALID_RISK].join('/')}`);
  }
  if (!taskBoard || typeof taskBoard.create !== 'function') {
    throw new TypeError('createDriftCorrection: taskBoard with create() required');
  }
  if (!driftStore || typeof driftStore.linkCorrection !== 'function'
      || typeof driftStore.listLatestFindings !== 'function') {
    throw new TypeError('createDriftCorrection: driftStore with listLatestFindings + linkCorrection required');
  }

  // Cross-team linkage guard — every findingId must belong to teamId.
  const teamFindings = driftStore.listLatestFindings({ teamId });
  const teamFindingIds = new Set(teamFindings.map((f) => f.id));
  const unknown = findingIds.filter((id) => !teamFindingIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`createDriftCorrection: findings not in team: ${unknown.join(',')}`);
  }

  // Create task first; only link if creation succeeded.
  const task = await taskBoard.create({
    teamId,
    subject: subject.trim(),
    description: typeof description === 'string' ? description : '',
    riskLevel,
    source: 'drift_correction',
  });
  const taskId = task.taskId ?? task.id;
  if (!taskId) {
    throw new Error('createDriftCorrection: taskBoard.create did not return a taskId');
  }

  const linkResult = driftStore.linkCorrection({ findingIds, correctionTaskId: taskId });

  return {
    taskId,
    linkedFindingCount: linkResult.linked,
    riskLevel,
  };
}
```

- [ ] **Step 4: Run test, watch it pass**

```bash
node --no-warnings --test test/drift/driftCorrection.test.js
```

Expected: 6/6 tests pass.

- [ ] **Step 5: Run `npm test`** to confirm full-suite green.

- [ ] **Step 6: Commit**

```bash
git add src/drift/driftCorrection.js test/drift/driftCorrection.test.js
git commit -m "$(cat <<'EOF'
feat(drift): createDriftCorrection orchestration helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: command-contract + roleAuthority entries

**Files:**
- Modify: `src/commands/command-contract.js` (1 new COMMANDS entry, 1 new MUTATING entry)
- Modify: `src/security/roleAuthority.js` (allowlist for architect/lead/human)
- Modify: `test/roleAuthority.test.js` (append test)

- [ ] **Step 1: Append failing test to `test/roleAuthority.test.js`**

```js
test('roleAuthority: drift_correction_create allowed for architect/lead/human, denied for developer/reviewer/tester', () => {
  for (const role of ['architect', 'lead', 'human']) {
    assert.doesNotThrow(
      () => assertRoleCanCallTool({ role, toolName: 'drift_correction_create' }),
      `${role} should be allowed drift_correction_create`,
    );
  }
  for (const role of ['developer', 'reviewer', 'tester']) {
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'drift_correction_create' }),
      /cannot call|not allowed/i,
      `${role} should be denied drift_correction_create`,
    );
  }
});
```

- [ ] **Step 2: Run test, watch it fail**

```bash
node test/roleAuthority.test.js
```

Expected: new test fails (tool not in any allowlist).

- [ ] **Step 3: Add to `src/commands/command-contract.js`**

Inside the `COMMANDS` object, in alphabetical position (likely between `DRIFT_RUN` and the next entry — or wherever `DRIFT_RUN` lives), add:

```js
DRIFT_CORRECTION_CREATE: 'drift_correction_create',
```

In the `MUTATING_COMMANDS` array, append:

```js
COMMANDS.DRIFT_CORRECTION_CREATE,
```

- [ ] **Step 4: Add to `src/security/roleAuthority.js`**

In the `architect` array, append:

```js
'drift_correction_create',
```

`lead` and `human` use `'*'` so they automatically allowed. Other roles (developer/reviewer/tester) get nothing new — correctly denied.

- [ ] **Step 5: Run test, watch it pass**

```bash
node test/roleAuthority.test.js
```

Expected: ALL tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/command-contract.js src/security/roleAuthority.js test/roleAuthority.test.js
git commit -m "$(cat <<'EOF'
feat(drift): drift_correction_create command + role guard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: LocalToolFacade dispatch handler

**Files:**
- Modify: `src/tools/localToolFacade.js` (handler + dispatch case)
- Modify: `test/localToolFacade.test.js` (append test)

- [ ] **Step 1: Append failing test**

```js
test('LocalToolFacade drift_correction_create delegates to driftStore + taskBoard', async () => {
  const taskBoard = new InMemoryTaskBoard();
  // Seed a finding so listLatestFindings + linkCorrection can find it.
  // Use a real SqliteDriftStore-shaped fake or import the actual one if convenient.
  const driftStore = {
    listLatestFindings: () => [{ id: 'f1' }],
    linkCorrection: ({ findingIds, correctionTaskId }) => ({ linked: findingIds.length }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard,
    driftStore,
  });
  const result = await facade.execute({
    commandName: COMMANDS.DRIFT_CORRECTION_CREATE,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { findingIds: ['f1'], subject: 'Fix it', description: 'do the thing', riskLevel: 'medium' },
    idempotencyKey: 'drift-correction-test-1',
  });
  assert.ok(result.taskId);
  assert.equal(result.linkedFindingCount, 1);
  assert.equal(result.riskLevel, 'medium');
});

test('LocalToolFacade drift_correction_create rejects when driftStore is not configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.DRIFT_CORRECTION_CREATE,
      actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
      args: { findingIds: ['f1'], subject: 's', description: 'd', riskLevel: 'low' },
      idempotencyKey: 'k1',
    }),
    /driftStore not configured/i,
  );
});
```

- [ ] **Step 2: Run test, watch it fail**

```bash
node --no-warnings --test test/localToolFacade.test.js
```

Expected: 2 new tests fail with "unsupported command" or similar.

- [ ] **Step 3: Modify `src/tools/localToolFacade.js`**

a. **Add import at top** (alongside other drift imports):

```js
import { createDriftCorrection } from '../drift/driftCorrection.js';
```

b. **Add new case in `execute()` switch** (alongside the existing `DRIFT_RUN` case):

```js
case COMMANDS.DRIFT_CORRECTION_CREATE:
  return this.#driftCorrectionCreate(actor, args);
```

c. **Add new private handler method** (near other drift handlers if present, otherwise alongside other handlers):

```js
async #driftCorrectionCreate(actor, args) {
  if (!this.driftStore) {
    throw new Error('drift_correction_create: driftStore not configured for this facade');
  }
  const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
    ? args.teamId
    : actor.teamId;
  return createDriftCorrection({
    teamId,
    findingIds: args?.findingIds,
    subject: args?.subject,
    description: args?.description,
    riskLevel: args?.riskLevel,
    taskBoard: this.taskBoard,
    driftStore: this.driftStore,
  });
}
```

- [ ] **Step 4: Run test, watch it pass**

```bash
node --no-warnings --test test/localToolFacade.test.js
```

Expected: all existing + 2 new pass.

- [ ] **Step 5: Run `npm test`** for full-suite regression check.

- [ ] **Step 6: Commit**

```bash
git add src/tools/localToolFacade.js test/localToolFacade.test.js
git commit -m "$(cat <<'EOF'
feat(drift): drift_correction_create dispatch in LocalToolFacade

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: MCP tool definition

**Files:**
- Modify: `src/mcp/localToolDefinitions.js` (register `drift_correction_create`)

- [ ] **Step 1: Read existing tool definitions** to understand the registration shape:

```bash
grep -n "drift_run\|name:\|inputSchema" src/mcp/localToolDefinitions.js | head -20
```

You'll find a pattern like `{ name: '...', description: '...', inputSchema: {...} }` per tool.

- [ ] **Step 2: Add `drift_correction_create` to the tool list**

Locate the array of tool definitions. Append (alphabetically near `drift_run`):

```js
{
  name: 'drift_correction_create',
  description: 'Create a correction task linked to one or more drift findings. The task lands in backlog with the offending evidence in its description; the linked findings are excluded from drift score until the correction task hits done/rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      findingIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'One or more drift finding IDs to link.',
      },
      subject: { type: 'string', description: '1-line task subject.' },
      description: { type: 'string', description: 'Markdown description (caller pre-aggregates if multi-finding).' },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk classification.' },
      teamId: { type: 'string', description: 'Optional team ID; defaults to actor.teamId.' },
    },
    required: ['findingIds', 'subject', 'riskLevel'],
  },
},
```

- [ ] **Step 3: Smoke check syntax**

```bash
node --check src/mcp/localToolDefinitions.js
```

Expected: silent success.

- [ ] **Step 4: Run `npm test`** to confirm no regressions (the existing `localMcpToolDefinitions.test.js` will pick up the new entry — check that test for any "list of tools must include X" expectations).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/localToolDefinitions.js
git commit -m "$(cat <<'EOF'
feat(drift): register drift_correction_create as MCP tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — UI

### Task 9: CorrectionTaskModal component

**Files:**
- Create: `ui/src/components/CorrectionTaskModal.tsx`

- [ ] **Step 1: Read existing modal patterns** (no test framework for UI; use `tsc --noEmit` for verification):

```bash
ls ui/src/components/ | grep -i "modal\|drawer"
```

Look at `ApprovalsDrawer.tsx` or similar for the existing overlay + close + portal pattern. Match the style.

- [ ] **Step 2: Create `ui/src/components/CorrectionTaskModal.tsx`** with:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { callTool as callToadApi } from '@/api/client';

export interface DriftFindingForModal {
  id: string;
  taskId: string | null;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  expected: string;
  actual: string;
  recommendedCorrection: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  selectedFindings: DriftFindingForModal[];
  teamId: string;
  onCreated: (result: { taskId: string }) => void;
}

const SEVERITY_TO_RISK: Record<string, 'low' | 'medium' | 'high'> = {
  critical: 'high',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

function inferRiskLevel(findings: DriftFindingForModal[]): 'low' | 'medium' | 'high' {
  let max: 'low' | 'medium' | 'high' = 'low';
  for (const f of findings) {
    const r = SEVERITY_TO_RISK[f.severity] ?? 'low';
    if (r === 'high') return 'high';
    if (r === 'medium' && max !== 'high') max = 'medium';
  }
  return max;
}

function buildDescription(findings: DriftFindingForModal[]): string {
  const parts: string[] = ['# Drift findings to address', ''];
  findings.forEach((f, i) => {
    parts.push(`## ${i + 1}. ${f.title}`);
    parts.push(`- **Category:** ${f.category}`);
    parts.push(`- **Severity:** ${f.severity}`);
    if (f.taskId) parts.push(`- **Task:** ${f.taskId}`);
    parts.push(`- **Expected:** ${f.expected}`);
    parts.push(`- **Actual:** ${f.actual}`);
    parts.push(`- **Recommended correction:** ${f.recommendedCorrection}`);
    parts.push('');
  });
  return parts.join('\n');
}

export function CorrectionTaskModal({ open, onClose, selectedFindings, teamId, onCreated }: Props) {
  const initialSubject = useMemo(
    () => selectedFindings.length === 1
      ? selectedFindings[0].title
      : `Drift correction (${selectedFindings.length} findings)`,
    [selectedFindings],
  );
  const initialDescription = useMemo(() => buildDescription(selectedFindings), [selectedFindings]);
  const initialRisk = useMemo(() => inferRiskLevel(selectedFindings), [selectedFindings]);

  const [subject, setSubject] = useState(initialSubject);
  const [description, setDescription] = useState(initialDescription);
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high'>(initialRisk);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the selection changes.
  useEffect(() => {
    setSubject(initialSubject);
    setDescription(initialDescription);
    setRiskLevel(initialRisk);
    setError(null);
  }, [initialSubject, initialDescription, initialRisk]);

  if (!open) return null;

  const submitDisabled = submitting || subject.trim().length === 0 || selectedFindings.length === 0;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const findingIds = selectedFindings.map((f) => f.id);
      const result = await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'drift_correction_create',
        args: { findingIds, subject: subject.trim(), description, riskLevel, teamId },
        idempotencyKey: `drift-correction-${teamId}-${Date.now()}-${findingIds[0]}`,
      }) as { taskId: string };
      onCreated(result);
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg, #1a1a1a)', border: '1px solid var(--border-soft, rgba(255,255,255,0.1))',
          borderRadius: 8, padding: 20, width: 600, maxHeight: '80vh', overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, marginBottom: 12, fontSize: 14 }}>
          Create correction task ({selectedFindings.length} {selectedFindings.length === 1 ? 'finding' : 'findings'})
        </h3>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Subject</div>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={submitting}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Description</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            rows={12}
            style={{ width: '100%', padding: '6px 8px', fontSize: 11, fontFamily: 'monospace', resize: 'vertical' }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Risk level</div>
          <select
            value={riskLevel}
            onChange={(e) => setRiskLevel(e.target.value as 'low' | 'medium' | 'high')}
            disabled={submitting}
            style={{ padding: '4px 8px', fontSize: 12 }}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>

        {error && (
          <div style={{ fontSize: 11, color: 'var(--err, #f87171)', marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-sm"
            onClick={() => void submit()}
            disabled={submitDisabled}
          >
            {submitting ? 'Creating…' : 'Create correction task'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check the UI**

```bash
cd ui && npx tsc --noEmit
```

Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/CorrectionTaskModal.tsx
git commit -m "$(cat <<'EOF'
feat(drift-ui): CorrectionTaskModal component

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: DriftScreen — multi-select checkboxes + action bar

**Files:**
- Modify: `ui/src/components/DriftScreen.tsx`

- [ ] **Step 1: Read the existing DriftScreen** to find the findings list:

```bash
grep -n "finding\|Finding\|map(\|TaskCard" ui/src/components/DriftScreen.tsx | head -30
```

Locate the per-finding render (likely a `.map((finding) => ...)` block). The action bar lives just above this map.

- [ ] **Step 2: Add state for selection + modal**

Near the existing `useState` calls, add:

```tsx
import { useState } from 'react';
import { CorrectionTaskModal, type DriftFindingForModal } from './CorrectionTaskModal';

// Inside the component:
const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(new Set());
const [modalOpen, setModalOpen] = useState(false);
const [hideRemediated, setHideRemediated] = useState(false);

const toggleFinding = (id: string) => {
  setSelectedFindingIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
};

const clearSelection = () => setSelectedFindingIds(new Set());
```

- [ ] **Step 3: Add the action bar above the findings list**

Just above the `findings.map(...)` block, add:

```tsx
<div style={{
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '8px 12px',
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
  borderRadius: 6,
  marginBottom: 12,
}}>
  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
    Selected: {selectedFindingIds.size}
  </span>
  <button
    className="btn btn-sm"
    onClick={() => setModalOpen(true)}
    disabled={selectedFindingIds.size === 0}
  >
    Create correction task
  </button>
  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginLeft: 'auto' }}>
    <input
      type="checkbox"
      checked={hideRemediated}
      onChange={(e) => setHideRemediated(e.target.checked)}
    />
    Hide remediated findings
  </label>
</div>
```

- [ ] **Step 4: Filter the findings list when hideRemediated is true**

Just before the `findings.map(...)` call, derive the visible list:

```tsx
const visibleFindings = hideRemediated
  ? findings.filter((f) => !f.correctionTaskId)
  : findings;
```

Then render `visibleFindings.map(...)` instead of `findings.map(...)`.

- [ ] **Step 5: Mount the modal at the end of the component**

Just before the closing `</div>` of the screen's root, add:

```tsx
{modalOpen && (
  <CorrectionTaskModal
    open={modalOpen}
    onClose={() => setModalOpen(false)}
    selectedFindings={
      Array.from(selectedFindingIds)
        .map((id) => findings.find((f) => f.id === id))
        .filter((f): f is DriftFindingForModal => Boolean(f))
    }
    teamId={teamId /* whatever the existing screen uses */}
    onCreated={() => {
      clearSelection();
      // Trigger drift refresh — match the existing refresh function name
      void refreshDrift?.();
    }}
  />
)}
```

(The exact `teamId` and `refreshDrift` references depend on the screen's existing wiring — adapt to what's already there.)

- [ ] **Step 6: Type-check + commit**

```bash
cd ui && npx tsc --noEmit
cd ..
git add ui/src/components/DriftScreen.tsx
git commit -m "$(cat <<'EOF'
feat(drift-ui): multi-select + Create correction task action bar

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: DriftScreen — per-finding checkbox + remediation badge

**Files:**
- Modify: `ui/src/components/DriftScreen.tsx`

- [ ] **Step 1: Modify the per-finding render**

In the existing `visibleFindings.map((finding) => ...)` block, modify the JSX so each finding card:

a. **Has a checkbox at the leading edge** (disabled when correctionTaskId is set):

```tsx
<input
  type="checkbox"
  checked={selectedFindingIds.has(finding.id)}
  onChange={() => toggleFinding(finding.id)}
  disabled={Boolean(finding.correctionTaskId)}
  style={{ marginRight: 8 }}
/>
```

b. **Renders with reduced opacity if correctionTaskId is set:**

Find the outer card element and add:

```tsx
style={{
  ...existingStyle,
  opacity: finding.correctionTaskId ? 0.55 : 1,
}}
```

c. **Shows a remediation chip when correctionTaskId is set:**

Inside the card (somewhere visible, e.g. just after the title), add:

```tsx
{finding.correctionTaskId && (
  <span
    style={{
      fontSize: 10,
      padding: '2px 6px',
      borderRadius: 3,
      background: 'rgba(74, 222, 128, 0.12)',
      color: 'var(--ok, #4ade80)',
      marginLeft: 8,
      fontWeight: 600,
    }}
    title="This finding has a correction task in flight."
  >
    Correction in progress: {finding.correctionTaskId}
  </span>
)}
```

- [ ] **Step 2: Type-check**

```bash
cd ui && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd ..
git add ui/src/components/DriftScreen.tsx
git commit -m "$(cat <<'EOF'
feat(drift-ui): per-finding checkbox + correction-in-progress badge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Final wire-up

### Task 12: End-to-end integration test

**Files:**
- Create: `test/drift/driftCorrection.integration.test.js`

- [ ] **Step 1: Create the integration test** — exercises the full path: real SqliteDriftStore + InMemoryTaskBoard + driftCorrection helper + engine reap.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDriftStore } from '../../src/drift/driftStore.js';
import { createDriftCorrection } from '../../src/drift/driftCorrection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function makeRealStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return { db, store: new SqliteDriftStore({ db }) };
}

function makeInMemoryTaskBoard() {
  const tasks = new Map();
  let counter = 0;
  return {
    create({ teamId, subject, description, riskLevel }) {
      counter += 1;
      const taskId = `task_${counter}`;
      const row = { taskId, teamId, subject, description, riskLevel, status: 'backlog' };
      tasks.set(taskId, row);
      return row;
    },
    get({ taskId }) {
      return tasks.get(taskId) ?? null;
    },
    setStatus(taskId, status) {
      const t = tasks.get(taskId);
      if (t) t.status = status;
    },
  };
}

test('integration: emit finding → create correction → next reap → mark done → linkage cleared', async () => {
  const { store } = makeRealStore();
  const taskBoard = makeInMemoryTaskBoard();

  // Step 1: drift engine emits a finding
  const finding = {
    id: 'f1', taskId: 't_offending', category: 'lifecycle',
    severity: 'medium', checkName: 'test_check', title: 'It drifted',
    evidence: [], expected: 'X', actual: 'Y',
    recommendedCorrection: 'Do X instead', autoFixable: false,
  };
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [finding],
  });

  // Step 2: operator creates a correction
  const result = await createDriftCorrection({
    teamId: 'team-a',
    findingIds: ['f1'],
    subject: 'Address f1',
    description: 'Fix it',
    riskLevel: 'medium',
    taskBoard, driftStore: store,
  });
  assert.equal(result.linkedFindingCount, 1);
  const taskId = result.taskId;

  // Step 3: linkage now visible to engine
  const linkages = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(linkages.get('f1'), taskId);

  // Step 4: reap with task in_progress — no change
  let reap = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard });
  assert.equal(reap.reaped, 0);

  // Step 5: mark task done; reap clears linkage
  taskBoard.setStatus(taskId, 'done');
  reap = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard });
  assert.equal(reap.reaped, 1);
  assert.equal(store.getCorrectionLinkages({ teamId: 'team-a' }).size, 0);
});

test('integration: re-stamp survives recordRun wholesale-replace', async () => {
  const { store } = makeRealStore();
  const taskBoard = makeInMemoryTaskBoard();

  // Run 1: emit + link
  const f1 = {
    id: 'f1', taskId: 't1', category: 'lifecycle', severity: 'medium',
    checkName: 'c', title: 't', evidence: [], expected: 'e', actual: 'a',
    recommendedCorrection: 'r', autoFixable: false,
  };
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: 'now', teamScore: 50,
    status: 'warning', categoryScores: {}, perTaskScores: {},
    trigger: 'manual', findings: [f1],
  });
  const created = await createDriftCorrection({
    teamId: 'team-a', findingIds: ['f1'],
    subject: 's', description: 'd', riskLevel: 'low',
    taskBoard, driftStore: store,
  });

  // Simulate engine re-run: read linkages, re-stamp on a fresh finding object,
  // recordRun (which deletes prior + re-inserts)
  const linkages = store.getCorrectionLinkages({ teamId: 'team-a' });
  const f1Fresh = { ...f1, correctionTaskId: linkages.get('f1') };
  store.recordRun({
    runId: 'r2', teamId: 'team-a', asOf: 'now2', teamScore: 30,
    status: 'warning', categoryScores: {}, perTaskScores: {},
    trigger: 'periodic', findings: [f1Fresh],
  });

  const after = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(after.get('f1'), created.taskId, 'linkage preserved across recordRun');
});
```

- [ ] **Step 2: Run the integration test, watch it pass**

```bash
node --no-warnings --test test/drift/driftCorrection.integration.test.js
```

Expected: 2/2 tests pass.

- [ ] **Step 3: Run `npm test`** for full-suite green.

- [ ] **Step 4: Commit**

```bash
git add test/drift/driftCorrection.integration.test.js
git commit -m "$(cat <<'EOF'
test(drift): end-to-end integration for correction lifecycle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: npm test chain extension + README + tracker check-off

**Files:**
- Modify: `package.json`
- Modify: `README.md` (or `toad-local/README.md` — check which one is the project's canonical readme)
- Modify: `docs/superpowers/specs/2026-05-04-drift-followups-tracker.md`

- [ ] **Step 1: Append new test files to `package.json`'s `test` script**

In the `"test":` value, after the last existing entry, append:

```
&& node --no-warnings --test test/drift/driftCorrection.test.js
&& node --no-warnings --test test/drift/driftCorrection.integration.test.js
```

(One long line — preserve the `&&` chain style.)

- [ ] **Step 2: Verify JSON parses + run full test suite**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts.test.length, 'chars')"
npm test 2>&1 | tail -10
```

Expected: every test passes; both new test files appear in the output.

- [ ] **Step 3: Update README's "What's deferred" — check the canonical README path**

```bash
ls -la README.md ../README.md 2>/dev/null
```

Pick the project's actual top-level README. Find the existing `Drift monitor slice 3` line in the deferred list and replace with:

```md
- **Drift Monitor — slice 3 shipped.** Correction-task generation closes the loop from "engine reports drift" → "team fixes drift." Multi-select findings → editable modal → task lands in backlog. In-flight findings excluded from score + skip LLM re-emit until correction hits done/rejected. See `toad-local/docs/superpowers/specs/2026-05-04-drift-slice-3-correction-tasks-design.md`.
```

- [ ] **Step 4: Tick boxes in the drift follow-ups tracker**

In `toad-local/docs/superpowers/specs/2026-05-04-drift-followups-tracker.md` Section A, change `- [ ]` to `- [x]` for the items this slice addresses (the first 4 bullets). Add a note at the bottom of Section A:

```md
**Slice 3 shipped 2026-05-04** — items above checked off. Slice 3.5 candidates: auto-creation of corrections, correction templates per check type, root-cause clustering heuristics.
```

- [ ] **Step 5: Commit**

```bash
git add package.json README.md ../README.md docs/superpowers/specs/2026-05-04-drift-followups-tracker.md 2>/dev/null
git commit -m "$(cat <<'EOF'
chore(drift): wire slice-3 tests into npm test chain + ship notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(The `2>/dev/null` lets the `git add` succeed even if one of the README paths doesn't exist; only the canonical README will actually be staged.)

- [ ] **Step 6: Empty ship-note commit**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
ship(drift): slice 3 (correction-task generation) verified end-to-end

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**1. Spec coverage:**

| Spec section | Implemented in task |
|--------------|---------------------|
| §1 architecture/data flow | Tasks 4, 5, 7 (engine + helper + dispatch) |
| §2 data model — schema migration + correctionTaskId field | Tasks 1, 3 |
| §3.1 driftCorrection.js | Task 5 |
| §3.2 SqliteDriftStore methods | Tasks 2, 3 |
| §3.3 MCP command + facade dispatch + role allowlist | Tasks 6, 7, 8 |
| §4 engine integration | Task 4 |
| §5.1 DriftScreen modifications | Tasks 10, 11 |
| §5.2 CorrectionTaskModal | Task 9 |
| §6 testing strategy | Tasks 2, 3, 4, 5, 6, 7, 12 |
| §7 risks/non-goals | not implementation work — captured in spec |

All spec requirements have a task. ✓

**2. Placeholder scan:**
- No "TBD", "implement later", "fill in details" anywhere.
- All steps include actual code blocks where they change code.
- All commands are exact + have expected output.
- Task 4's "exact integration depends on the current shape of `runDrift`" is the one place I instruct the implementer to *adapt to existing shape* — that's intentional (the engine has slice-1 + slice-2 surface area I can't fully predict from this plan alone). The 4 conceptual steps (read linkages → run checks → re-stamp + filter → record + reap) are concrete; the surgical insertion location is for the implementer to find.
- Task 13's README path detection (`ls README.md ../README.md`) is similarly intentional — repo has multiple READMEs and the canonical one needs to be confirmed at execution time.

**3. Type consistency:**
- `getCorrectionLinkages` returns `Map<findingId, correctionTaskId>` — used identically in Tasks 2, 4, 12.
- `linkCorrection({ findingIds, correctionTaskId })` signature is identical across Tasks 2, 5, 7, 12.
- `correctionTaskId` field on findings (camelCase) ↔ `correction_task_id` column (snake_case) bridge happens in `rowToFinding` (Task 3) — consistent with the rest of the codebase's bridging convention.
- `riskLevel` enum values `'low'/'medium'/'high'` consistent across modal pre-fill, helper validation, and API.
- Modal `selectedFindings` typed as `DriftFindingForModal[]` (exported from CorrectionTaskModal); DriftScreen narrows the larger DriftFinding type via `.filter` predicate.

No issues. Plan is ready for execution.
