# Drift Monitor — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-03-drift-monitor-design.md`

**Goal:** Ship a deterministic drift-monitor engine that scores team divergence, runs 7 named checks, persists findings + score history to SQLite, and surfaces a dedicated Drift screen with per-task drift badges.

**Architecture:** Pluggable check registry — each of 7 checks is a pure function in `src/drift/checks/<name>.js`. Engine builds a `DriftSnapshot`, runs every registered check, scores findings via severity weights, persists results, and returns the rollup. Periodic 60s tick + on-demand UI button + post-`task_event` triggers. UI mounts a dedicated screen + per-task badges on task cards.

**Tech Stack:** Node 20+ ESM, `node:sqlite` (DatabaseSync), `node:test`, React 18 + TypeScript (UI), no new runtime deps.

**Test discipline:** TDD throughout. Each check ships with a failing test exercising a known-bad snapshot before the implementation lands.

---

## Phase 1 — Schema + Storage

### Task 1: SQLite schema migration for drift tables

**Files:**
- Modify: `src/storage/schema.sql` (append two new tables + indexes)
- Test: `test/sqliteDriftStore.test.js` (new — partial coverage; full driftStore tests in Task 2)

- [ ] **Step 1: Write the failing test (schema-only smoke)**

Append to a new test file `test/sqliteDriftStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'storage', 'schema.sql');

test('schema.sql defines drift_findings and drift_score_history with required columns', () => {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(sql);

  // drift_findings — sanity-insert one row, then query columns by name.
  db.prepare(`INSERT INTO drift_findings
    (finding_id, run_id, team_id, task_id, category, severity, check_name,
     title, evidence_json, expected, actual, recommended, auto_fixable, created_at)
    VALUES ('f1', 'r1', 't1', 'task-1', 'architecture', 'high', 'check_x',
            'Title', '["e1"]', 'e', 'a', 'r', 0, '2026-05-03T00:00:00Z')`).run();
  const row = db.prepare('SELECT * FROM drift_findings WHERE finding_id = ?').get('f1');
  assert.equal(row.team_id, 't1');
  assert.equal(row.severity, 'high');

  // drift_score_history
  db.prepare(`INSERT INTO drift_score_history
    (run_id, team_id, team_score, status, category_scores_json,
     per_task_scores_json, findings_count, trigger, created_at)
    VALUES ('r1', 't1', 18, 'healthy', '{}', '{}', 0, 'manual',
            '2026-05-03T00:00:00Z')`).run();
  const hist = db.prepare('SELECT * FROM drift_score_history WHERE run_id = ?').get('r1');
  assert.equal(hist.team_score, 18);
  assert.equal(hist.status, 'healthy');

  // Indexes — confirm they were created.
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_drift_%'`).all();
  const names = idx.map((r) => r.name).sort();
  assert.deepEqual(names, [
    'idx_drift_findings_run',
    'idx_drift_findings_task',
    'idx_drift_findings_team',
    'idx_drift_score_history_team_time',
  ]);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings test/sqliteDriftStore.test.js`
Expected: FAIL — "no such table: drift_findings"

- [ ] **Step 3: Append schema to `src/storage/schema.sql`**

```sql
-- Drift Monitor (slice 1) — see docs/superpowers/specs/2026-05-03-drift-monitor-design.md
-- Findings are replaced wholesale per run (delete-by-team_id, insert-new).
CREATE TABLE IF NOT EXISTS drift_findings (
  finding_id      TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  task_id         TEXT,
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL,
  check_name      TEXT NOT NULL,
  title           TEXT NOT NULL,
  evidence_json   TEXT NOT NULL,
  expected        TEXT NOT NULL,
  actual          TEXT NOT NULL,
  recommended     TEXT NOT NULL,
  auto_fixable    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_findings_team ON drift_findings(team_id);
CREATE INDEX IF NOT EXISTS idx_drift_findings_task ON drift_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_drift_findings_run  ON drift_findings(run_id);

-- One row per run; pruned to last 500 per team.
CREATE TABLE IF NOT EXISTS drift_score_history (
  run_id              TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL,
  team_score          INTEGER NOT NULL,
  status              TEXT NOT NULL,
  category_scores_json TEXT NOT NULL,
  per_task_scores_json TEXT NOT NULL,
  findings_count      INTEGER NOT NULL,
  trigger             TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drift_score_history_team_time
  ON drift_score_history(team_id, created_at DESC);
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings test/sqliteDriftStore.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.sql test/sqliteDriftStore.test.js
git commit -m "feat(drift): schema for drift_findings + drift_score_history"
```

---

### Task 2: SqliteDriftStore reader/writer class

**Files:**
- Create: `src/drift/driftStore.js`
- Modify: `test/sqliteDriftStore.test.js` (extend with full coverage)

- [ ] **Step 1: Extend test file with full coverage**

Append to `test/sqliteDriftStore.test.js`:

```js
import { SqliteDriftStore } from '../src/drift/driftStore.js';

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return { db, store: new SqliteDriftStore({ db }) };
}

test('SqliteDriftStore.recordRun writes findings + score-history rows atomically', () => {
  const { store } = makeStore();
  const result = store.recordRun({
    runId: 'r1',
    teamId: 'team-a',
    asOf: '2026-05-03T10:00:00Z',
    teamScore: 18,
    status: 'healthy',
    categoryScores: { architecture: 94, checklist: 82 },
    perTaskScores: { 'task-1': 8 },
    trigger: 'manual',
    findings: [
      {
        id: 'f1', runId: 'r1', teamId: 'team-a', taskId: 'task-1',
        category: 'architecture', severity: 'high', checkName: 'check_invalid_transitions',
        title: 'Bad transition', evidence: ['ev1', 'ev2'],
        expected: 'planned', actual: 'done', recommendedCorrection: 'roll back',
        autoFixable: false,
      },
    ],
  });
  assert.equal(result.findingsWritten, 1);
});

test('SqliteDriftStore.listLatestFindings returns the most-recent run for the team', () => {
  const { store } = makeStore();
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    teamScore: 18, status: 'healthy', categoryScores: {}, perTaskScores: {},
    trigger: 'manual',
    findings: [{ id: 'f1', runId: 'r1', teamId: 'team-a', taskId: null,
      category: 'risk', severity: 'low', checkName: 'check_x', title: 'T',
      evidence: [], expected: 'e', actual: 'a', recommendedCorrection: 'r',
      autoFixable: false }],
  });
  store.recordRun({
    runId: 'r2', teamId: 'team-a', asOf: '2026-05-03T10:01:00Z',
    teamScore: 8, status: 'healthy', categoryScores: {}, perTaskScores: {},
    trigger: 'periodic', findings: [],
  });
  // Latest run for team-a is r2 with zero findings — recordRun must wipe r1's rows.
  const out = store.listLatestFindings({ teamId: 'team-a' });
  assert.equal(out.length, 0);
});

test('SqliteDriftStore.listScoreHistory returns rows newest-first capped to limit', () => {
  const { store } = makeStore();
  for (let i = 0; i < 5; i += 1) {
    store.recordRun({
      runId: `r${i}`, teamId: 'team-a', asOf: `2026-05-03T10:0${i}:00Z`,
      teamScore: i, status: 'healthy', categoryScores: {}, perTaskScores: {},
      trigger: 'periodic', findings: [],
    });
  }
  const hist = store.listScoreHistory({ teamId: 'team-a', limit: 3 });
  assert.equal(hist.length, 3);
  assert.deepEqual(hist.map((h) => h.runId), ['r4', 'r3', 'r2']);
});

test('SqliteDriftStore.pruneHistory keeps the N most recent rows per team', () => {
  const { store } = makeStore();
  for (let i = 0; i < 12; i += 1) {
    store.recordRun({
      runId: `r${i}`, teamId: 'team-a', asOf: `2026-05-03T10:00:${String(i).padStart(2, '0')}Z`,
      teamScore: i, status: 'healthy', categoryScores: {}, perTaskScores: {},
      trigger: 'periodic', findings: [],
    });
  }
  store.pruneHistory({ teamId: 'team-a', keep: 5 });
  const hist = store.listScoreHistory({ teamId: 'team-a', limit: 100 });
  assert.equal(hist.length, 5);
  assert.deepEqual(hist.map((h) => h.runId), ['r11', 'r10', 'r9', 'r8', 'r7']);
});
```

- [ ] **Step 2: Run tests, watch them fail**

Run: `node --no-warnings test/sqliteDriftStore.test.js`
Expected: FAIL — "Cannot find module '../src/drift/driftStore.js'"

- [ ] **Step 3: Implement `src/drift/driftStore.js`**

```js
/**
 * SQLite-backed reader/writer for drift findings + score history.
 * Engine is the only writer; UI + drift_run callers read.
 *
 * recordRun is atomic: deletes prior findings for the team, inserts the new
 * findings, inserts one score-history row, and runs pruneHistory in a
 * single transaction so a partial run can't leave the tables inconsistent.
 */
export class SqliteDriftStore {
  constructor({ db, historyKeep = 500 } = {}) {
    if (!db || typeof db.prepare !== 'function') {
      throw new TypeError('SqliteDriftStore: db with prepare() required');
    }
    this.db = db;
    this.historyKeep = historyKeep;
  }

  recordRun({ runId, teamId, asOf, teamScore, status, categoryScores,
              perTaskScores, trigger, findings }) {
    if (!runId || !teamId) throw new TypeError('runId and teamId are required');
    const findingsArr = Array.isArray(findings) ? findings : [];

    const deleteFindings = this.db.prepare('DELETE FROM drift_findings WHERE team_id = ?');
    const insertFinding = this.db.prepare(`INSERT INTO drift_findings
      (finding_id, run_id, team_id, task_id, category, severity, check_name,
       title, evidence_json, expected, actual, recommended, auto_fixable, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertHistory = this.db.prepare(`INSERT INTO drift_score_history
      (run_id, team_id, team_score, status, category_scores_json,
       per_task_scores_json, findings_count, trigger, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      deleteFindings.run(teamId);
      for (const f of findingsArr) {
        insertFinding.run(
          f.id, runId, teamId, f.taskId ?? null, f.category, f.severity,
          f.checkName, f.title, JSON.stringify(f.evidence ?? []),
          f.expected, f.actual, f.recommendedCorrection,
          f.autoFixable ? 1 : 0, asOf
        );
      }
      insertHistory.run(
        runId, teamId, teamScore, status,
        JSON.stringify(categoryScores ?? {}),
        JSON.stringify(perTaskScores ?? {}),
        findingsArr.length, trigger, asOf
      );
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }
    this.pruneHistory({ teamId, keep: this.historyKeep });
    return { findingsWritten: findingsArr.length };
  }

  listLatestFindings({ teamId } = {}) {
    if (!teamId) return [];
    const rows = this.db.prepare(
      `SELECT * FROM drift_findings WHERE team_id = ? ORDER BY severity, finding_id`
    ).all(teamId);
    return rows.map(rowToFinding);
  }

  listScoreHistory({ teamId, limit = 30 } = {}) {
    if (!teamId) return [];
    const rows = this.db.prepare(
      `SELECT * FROM drift_score_history
       WHERE team_id = ?
       ORDER BY created_at DESC, run_id DESC
       LIMIT ?`
    ).all(teamId, limit);
    return rows.map((r) => ({
      runId: r.run_id,
      teamId: r.team_id,
      teamScore: r.team_score,
      status: r.status,
      categoryScores: safeParse(r.category_scores_json, {}),
      perTaskScores: safeParse(r.per_task_scores_json, {}),
      findingsCount: r.findings_count,
      trigger: r.trigger,
      createdAt: r.created_at,
    }));
  }

  pruneHistory({ teamId, keep = 500 } = {}) {
    if (!teamId) return { deleted: 0 };
    const result = this.db.prepare(
      `DELETE FROM drift_score_history
       WHERE team_id = ?
         AND run_id NOT IN (
           SELECT run_id FROM drift_score_history
           WHERE team_id = ?
           ORDER BY created_at DESC, run_id DESC
           LIMIT ?
         )`
    ).run(teamId, teamId, keep);
    return { deleted: result.changes };
  }
}

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
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
```

- [ ] **Step 4: Run tests, watch them pass**

Run: `node --no-warnings test/sqliteDriftStore.test.js`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/driftStore.js test/sqliteDriftStore.test.js
git commit -m "feat(drift): SqliteDriftStore for findings + score history"
```

---

## Phase 2 — Pure scoring + snapshot builder

### Task 3: scoreFindings pure function

**Files:**
- Create: `src/drift/scoreFindings.js`
- Test: `test/drift/scoreFindings.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/scoreFindings.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFindings, SEVERITY_WEIGHT, statusForScore } from '../../src/drift/scoreFindings.js';

function f({ id = 'x', taskId = null, category = 'architecture',
            severity = 'low', checkName = 'check_x' } = {}) {
  return {
    id, runId: 'r', teamId: 't', taskId, category, severity, checkName,
    title: 'T', evidence: [], expected: 'e', actual: 'a',
    recommendedCorrection: 'r', autoFixable: false,
  };
}

test('SEVERITY_WEIGHT matches the spec', () => {
  assert.deepEqual(SEVERITY_WEIGHT,
    { info: 1, low: 3, medium: 8, high: 15, critical: 25 });
});

test('statusForScore maps to thresholds correctly', () => {
  assert.equal(statusForScore(0), 'healthy');
  assert.equal(statusForScore(20), 'healthy');
  assert.equal(statusForScore(21), 'watch');
  assert.equal(statusForScore(40), 'watch');
  assert.equal(statusForScore(41), 'warning');
  assert.equal(statusForScore(65), 'warning');
  assert.equal(statusForScore(66), 'critical');
  assert.equal(statusForScore(150), 'critical'); // out-of-range still classifies
});

test('scoreFindings sums weights, caps at 100, classifies', () => {
  const findings = [
    f({ severity: 'critical' }), // 25
    f({ severity: 'high' }),     // 15
    f({ severity: 'medium' }),   // 8 → 48 total → warning
  ];
  const result = scoreFindings(findings);
  assert.equal(result.teamScore, 48);
  assert.equal(result.status, 'warning');
});

test('scoreFindings caps team score at 100', () => {
  const findings = Array.from({ length: 10 }, () => f({ severity: 'critical' })); // 250
  const result = scoreFindings(findings);
  assert.equal(result.teamScore, 100);
  assert.equal(result.status, 'critical');
});

test('scoreFindings produces per-task scores tagged by taskId', () => {
  const findings = [
    f({ taskId: 'task-1', severity: 'high' }),    // 15
    f({ taskId: 'task-1', severity: 'low' }),     // 3 → task-1 = 18
    f({ taskId: 'task-2', severity: 'medium' }),  // task-2 = 8
    f({ taskId: null,     severity: 'info' }),    // team-only, ignored per-task
  ];
  const result = scoreFindings(findings);
  assert.deepEqual(result.perTaskScores, { 'task-1': 18, 'task-2': 8 });
});

test('scoreFindings produces category scores filled-bar style (100 = healthy)', () => {
  const findings = [
    f({ category: 'architecture', severity: 'high' }),   // 15 → arch = 85
    f({ category: 'checklist',    severity: 'low' }),    // 3  → check = 97
  ];
  const result = scoreFindings(findings);
  assert.equal(result.categoryScores.architecture, 85);
  assert.equal(result.categoryScores.checklist, 97);
  // categories with zero findings come back as 100 (no drift = healthy bar)
  assert.equal(result.categoryScores.slice_scope, 100);
  assert.equal(result.categoryScores.test_truth, 100);
  assert.equal(result.categoryScores.risk, 100);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/scoreFindings.test.js`
Expected: FAIL — "Cannot find module '../../src/drift/scoreFindings.js'"

- [ ] **Step 3: Implement `src/drift/scoreFindings.js`**

```js
/**
 * Pure-function scoring for drift findings. No I/O, no state.
 *
 * Severity weights and thresholds come from the spec
 * (docs/superpowers/specs/2026-05-03-drift-monitor-design.md §4.5).
 *
 * Score semantics:
 *   teamScore = sum of weights, capped at TEAM_SCORE_CAP — higher = worse
 *   perTaskScores = same, grouped by taskId (team-level findings excluded)
 *   categoryScores = inverted: 100 - sum(weights in category), so HIGHER = HEALTHIER
 *     This matches the spec's "Architecture: 94%" reading (94% healthy).
 */

export const SEVERITY_WEIGHT = Object.freeze({
  info: 1, low: 3, medium: 8, high: 15, critical: 25,
});

export const STATUS_THRESHOLDS = Object.freeze([
  { max: 20, status: 'healthy' },
  { max: 40, status: 'watch' },
  { max: 65, status: 'warning' },
  { max: 100, status: 'critical' },
]);

export const TEAM_SCORE_CAP = 100;
export const PER_TASK_SCORE_CAP = 100;

export const ALL_CATEGORIES = Object.freeze([
  'architecture', 'checklist', 'slice_scope', 'test_truth', 'risk',
]);

export function statusForScore(score) {
  for (const t of STATUS_THRESHOLDS) {
    if (score <= t.max) return t.status;
  }
  return 'critical';
}

function weightOf(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_WEIGHT, severity)
    ? SEVERITY_WEIGHT[severity]
    : 0;
}

export function scoreFindings(findings) {
  const list = Array.isArray(findings) ? findings : [];
  let teamRaw = 0;
  const perTaskRaw = {};
  const perCategoryRaw = {};
  for (const c of ALL_CATEGORIES) perCategoryRaw[c] = 0;

  for (const f of list) {
    const w = weightOf(f.severity);
    teamRaw += w;
    if (f.taskId) {
      perTaskRaw[f.taskId] = (perTaskRaw[f.taskId] ?? 0) + w;
    }
    if (Object.prototype.hasOwnProperty.call(perCategoryRaw, f.category)) {
      perCategoryRaw[f.category] += w;
    }
  }

  const teamScore = Math.min(TEAM_SCORE_CAP, teamRaw);
  const perTaskScores = {};
  for (const [tid, raw] of Object.entries(perTaskRaw)) {
    perTaskScores[tid] = Math.min(PER_TASK_SCORE_CAP, raw);
  }
  // Filled-bar style: 100 = healthy.
  const categoryScores = {};
  for (const c of ALL_CATEGORIES) {
    categoryScores[c] = Math.max(0, 100 - Math.min(100, perCategoryRaw[c]));
  }

  return {
    teamScore,
    status: statusForScore(teamScore),
    perTaskScores,
    categoryScores,
  };
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/scoreFindings.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/scoreFindings.js test/drift/scoreFindings.test.js
git commit -m "feat(drift): scoreFindings pure function with severity weights"
```

---

### Task 4: buildSnapshot — gather inputs into DriftSnapshot

**Files:**
- Create: `src/drift/buildSnapshot.js`
- Test: `test/drift/buildSnapshot.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/buildSnapshot.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../src/drift/buildSnapshot.js';

function fakeTaskBoard() {
  return {
    listTasks: ({ teamId }) =>
      teamId === 'team-a'
        ? [{ teamId, taskId: 'task-1', status: 'in_progress',
             worktree: '/wt/task-1', baseRef: 'main',
             allowedFiles: ['src/billing/**'], forbiddenFiles: [],
             testCommands: ['npm test'] }]
        : [],
    listEvents: ({ teamId }) =>
      teamId === 'team-a'
        ? [
            { teamId, taskId: 'task-1', eventType: 'task.created',
              createdAt: '2026-05-03T09:00:00Z', payload: { subject: 'X' } },
            { teamId, taskId: 'task-1', eventType: 'task.status_changed',
              createdAt: '2026-05-03T09:05:00Z',
              payload: { from: 'ready', to: 'in_progress' } },
          ]
        : [],
  };
}
function fakeEventLog() {
  return {
    listEvents: ({ teamId }) =>
      teamId === 'team-a'
        ? [{ teamId, eventType: 'tool_call_denied', createdAt: '2026-05-03T09:10:00Z',
             payload: { agentId: 'dev-1', toolName: 'task_delete' } }]
        : [],
  };
}
function fakeFoundryStore() {
  return {
    readDocs: ({ teamId }) => ({
      architecture: teamId === 'team-a' ? '# Arch' : null,
      steering: '# Steering',
      definitionOfDone: null, designDecisions: null, checklist: null,
    }),
  };
}
function fakeWorktreeManager() {
  return {
    listWorktrees: ({ teamId }) =>
      teamId === 'team-a'
        ? [{ taskId: 'task-1', path: '/wt/task-1', baseRef: 'main' }]
        : [],
  };
}
function fakeDiffComputer() {
  return {
    computeDiff: ({ worktreePath }) => ({
      changedFiles: worktreePath === '/wt/task-1'
        ? ['src/billing/invoice.js', 'src/auth/oauth.js']
        : [],
    }),
  };
}

test('buildSnapshot returns DriftSnapshot with all inputs collected', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
      foundryStore: fakeFoundryStore(),
      worktreeManager: fakeWorktreeManager(),
      diffComputer: fakeDiffComputer(),
    },
  });
  assert.equal(snap.teamId, 'team-a');
  assert.ok(snap.asOf, 'asOf timestamp present');
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0].taskId, 'task-1');
  assert.equal(snap.taskEvents.length, 2);
  assert.equal(snap.runtimeEvents.length, 1);
  assert.equal(snap.foundryDocs.architecture, '# Arch');
  assert.equal(snap.worktrees.length, 1);
  assert.deepEqual(snap.diffsByTask['task-1'].changedFiles,
    ['src/billing/invoice.js', 'src/auth/oauth.js']);
});

test('buildSnapshot tolerates missing optional deps (no foundryStore, no worktreeManager)', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
      // no foundryStore, no worktreeManager, no diffComputer
    },
  });
  assert.deepEqual(snap.foundryDocs, {});
  assert.deepEqual(snap.worktrees, []);
  assert.deepEqual(snap.diffsByTask, {});
});

test('buildSnapshot returns empty arrays for an unknown team rather than throwing', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-zzz',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
    },
  });
  assert.equal(snap.tasks.length, 0);
  assert.equal(snap.taskEvents.length, 0);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/buildSnapshot.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/buildSnapshot.js`**

```js
/**
 * Gather all inputs the deterministic checks need into a single snapshot.
 * The engine calls this once per run; checks read it without further I/O.
 *
 * Tolerates missing optional deps so `drift_run` can succeed even when the
 * worktree manager or foundry store isn't wired (e.g. very early projects
 * before the first Foundry session).
 */
export async function buildSnapshot({ teamId, deps = {} } = {}) {
  if (typeof teamId !== 'string' || teamId.length === 0) {
    throw new TypeError('buildSnapshot: teamId required');
  }
  const { taskBoard, eventLog, foundryStore, worktreeManager, diffComputer } = deps;
  if (!taskBoard || typeof taskBoard.listTasks !== 'function') {
    throw new TypeError('buildSnapshot: deps.taskBoard with listTasks required');
  }
  if (!eventLog || typeof eventLog.listEvents !== 'function') {
    throw new TypeError('buildSnapshot: deps.eventLog with listEvents required');
  }

  const tasks = safeArray(taskBoard.listTasks({ teamId }));
  const taskEvents = typeof taskBoard.listEvents === 'function'
    ? safeArray(taskBoard.listEvents({ teamId }))
    : [];
  const runtimeEvents = safeArray(eventLog.listEvents({ teamId }));

  let foundryDocs = {};
  if (foundryStore && typeof foundryStore.readDocs === 'function') {
    try {
      const docs = foundryStore.readDocs({ teamId }) || {};
      foundryDocs = pickStringFields(docs, [
        'architecture', 'steering', 'designDecisions',
        'definitionOfDone', 'checklist',
      ]);
    } catch {
      foundryDocs = {};
    }
  }

  let worktrees = [];
  if (worktreeManager && typeof worktreeManager.listWorktrees === 'function') {
    try {
      worktrees = safeArray(worktreeManager.listWorktrees({ teamId }));
    } catch {
      worktrees = [];
    }
  }

  const diffsByTask = {};
  if (diffComputer && typeof diffComputer.computeDiff === 'function') {
    for (const wt of worktrees) {
      if (!wt || typeof wt.path !== 'string' || typeof wt.taskId !== 'string') continue;
      try {
        diffsByTask[wt.taskId] = diffComputer.computeDiff({
          worktreePath: wt.path,
          baseRef: wt.baseRef ?? 'main',
        });
      } catch {
        // skip — the check that needs the diff will treat it as empty
      }
    }
  }

  return {
    teamId,
    asOf: new Date().toISOString(),
    tasks,
    taskEvents,
    runtimeEvents,
    foundryDocs,
    worktrees,
    diffsByTask,
  };
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function pickStringFields(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].length > 0) out[k] = obj[k];
  }
  return out;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/buildSnapshot.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/buildSnapshot.js test/drift/buildSnapshot.test.js
git commit -m "feat(drift): buildSnapshot gathers inputs for deterministic checks"
```

---

## Phase 3 — The 7 deterministic checks

Each check follows the same TDD shape: build a synthetic snapshot, assert findings. Each check is a default-exported pure function with signature `({snapshot}) => DriftFinding[]`. The `id` field is a stable hash (tasks 5–11 all use the same `stableFindingId` helper, defined in Task 5 and reused).

### Task 5: checkInvalidTransitions

**Files:**
- Create: `src/drift/checks/_findingId.js` (shared helper)
- Create: `src/drift/checks/checkInvalidTransitions.js`
- Test: `test/drift/checks/checkInvalidTransitions.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkInvalidTransitions.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInvalidTransitions } from '../../../src/drift/checks/checkInvalidTransitions.js';

function snap(taskEvents) {
  return {
    teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    tasks: [], taskEvents, runtimeEvents: [],
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags ready→done as invalid transition', () => {
  const findings = checkInvalidTransitions({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.created',
        createdAt: '2026-05-03T09:00:00Z',
        payload: { subject: 'x', status: 'ready' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-03T09:05:00Z',
        payload: { from: 'ready', to: 'done' } },
    ]),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'architecture');
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].taskId, 'task-1');
  assert.equal(findings[0].checkName, 'check_invalid_transitions');
  assert.match(findings[0].actual, /ready/);
  assert.match(findings[0].actual, /done/);
});

test('does NOT flag legal transitions ready→planned→in_progress', () => {
  const findings = checkInvalidTransitions({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.created',
        createdAt: '2026-05-03T09:00:00Z',
        payload: { status: 'ready', subject: 'x' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-03T09:01:00Z',
        payload: { from: 'ready', to: 'planned' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-03T09:02:00Z',
        payload: { from: 'planned', to: 'in_progress' } },
    ]),
  });
  assert.equal(findings.length, 0);
});

test('produces stable finding id for the same offense across runs', () => {
  const events = [
    { taskId: 'task-1', eventType: 'task.created',
      createdAt: '2026-05-03T09:00:00Z',
      payload: { status: 'ready', subject: 'x' } },
    { taskId: 'task-1', eventType: 'task.status_changed',
      createdAt: '2026-05-03T09:05:00Z',
      payload: { from: 'ready', to: 'done' } },
  ];
  const a = checkInvalidTransitions({ snapshot: snap(events) });
  const b = checkInvalidTransitions({ snapshot: snap(events) });
  assert.equal(a[0].id, b[0].id);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkInvalidTransitions.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement helper + check**

Create `src/drift/checks/_findingId.js`:

```js
import { createHash } from 'node:crypto';

/**
 * Stable hash for a finding. The same offending state on two runs must
 * produce the same id so the UI (slice 2) can diff "fixed since last run".
 */
export function stableFindingId({ checkName, category, taskId, salient }) {
  const h = createHash('sha1');
  h.update(checkName);
  h.update('|');
  h.update(category);
  h.update('|');
  h.update(taskId ?? 'team');
  h.update('|');
  h.update(typeof salient === 'string' ? salient : JSON.stringify(salient ?? {}));
  return `f_${h.digest('hex').slice(0, 16)}`;
}
```

Create `src/drift/checks/checkInvalidTransitions.js`:

```js
import { validateTaskStatusTransition } from '../../task/taskLifecycle.js';
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_invalid_transitions';
const CATEGORY = 'architecture';

/**
 * Replay each task's status_changed events and flag any pair the lifecycle
 * doesn't allow. One finding per illegal transition (not per task), so a
 * task with two bad jumps produces two findings.
 */
export function checkInvalidTransitions({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const findings = [];

  // Group status_changed events by task.
  const byTask = new Map();
  for (const e of events) {
    if (e.eventType !== 'task.status_changed') continue;
    if (!e.taskId) continue;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  }

  for (const [taskId, list] of byTask) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const ev of list) {
      const from = ev.payload?.from;
      const to = ev.payload?.to;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      const verdict = validateTaskStatusTransition({ from, to });
      if (verdict.ok) continue;
      findings.push({
        id: stableFindingId({
          checkName: CHECK_NAME, category: CATEGORY, taskId,
          salient: `${from}->${to}@${ev.createdAt}`,
        }),
        runId: '',
        teamId: snapshot.teamId,
        taskId,
        category: CATEGORY,
        severity: 'high',
        checkName: CHECK_NAME,
        title: `Task ${taskId} took an illegal lifecycle transition`,
        evidence: [`task ${taskId}: ${from} → ${to} at ${ev.createdAt}`],
        expected: `legal transition out of "${from}" (${verdict.reason ?? 'see taskLifecycle.ALLOWED_TRANSITIONS'})`,
        actual: `${from} → ${to}`,
        recommendedCorrection: `Roll task ${taskId} back to "${from}" or to a legal next state.`,
        autoFixable: false,
      });
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/checks/checkInvalidTransitions.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/checks/_findingId.js src/drift/checks/checkInvalidTransitions.js test/drift/checks/checkInvalidTransitions.test.js
git commit -m "feat(drift): checkInvalidTransitions detects illegal lifecycle moves"
```

---

### Task 6: checkOutOfScopeFiles

**Files:**
- Create: `src/drift/checks/checkOutOfScopeFiles.js`
- Test: `test/drift/checks/checkOutOfScopeFiles.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkOutOfScopeFiles.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutOfScopeFiles } from '../../../src/drift/checks/checkOutOfScopeFiles.js';

const ACTIVE_STATUSES = ['in_progress', 'review', 'testing', 'merge_ready'];

function makeSnap({ allowedFiles = [], forbiddenFiles = [], changedFiles = [],
                    status = 'in_progress' } = {}) {
  return {
    teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    tasks: [{ teamId: 'team-a', taskId: 'task-1', status,
              allowedFiles, forbiddenFiles, worktree: '/wt/task-1' }],
    taskEvents: [], runtimeEvents: [],
    foundryDocs: {},
    worktrees: [{ taskId: 'task-1', path: '/wt/task-1', baseRef: 'main' }],
    diffsByTask: { 'task-1': { changedFiles } },
  };
}

test('flags files NOT in the task allowedFiles glob list', () => {
  const findings = checkOutOfScopeFiles({
    snapshot: makeSnap({
      allowedFiles: ['src/billing/**'],
      changedFiles: ['src/billing/invoice.js', 'src/auth/oauth.js'],
    }),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].actual, /src\/auth\/oauth\.js/);
  assert.equal(findings[0].category, 'slice_scope');
  assert.equal(findings[0].severity, 'medium');
});

test('flags files matching forbiddenFiles even when allowedFiles is empty', () => {
  const findings = checkOutOfScopeFiles({
    snapshot: makeSnap({
      allowedFiles: [],
      forbiddenFiles: ['src/auth/**'],
      changedFiles: ['src/auth/oauth.js'],
    }),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].actual, /src\/auth\/oauth\.js/);
});

test('does NOT flag a task with empty allowedFiles + empty forbiddenFiles (no contract)', () => {
  const findings = checkOutOfScopeFiles({
    snapshot: makeSnap({
      changedFiles: ['src/anything.js'],
    }),
  });
  assert.equal(findings.length, 0);
});

test('skips tasks not in active statuses', () => {
  for (const status of ['backlog', 'ready', 'planned', 'done', 'rejected']) {
    const findings = checkOutOfScopeFiles({
      snapshot: makeSnap({
        allowedFiles: ['src/billing/**'],
        changedFiles: ['src/auth/x.js'],
        status,
      }),
    });
    assert.equal(findings.length, 0, `status=${status} should be skipped`);
  }
  for (const status of ACTIVE_STATUSES) {
    const findings = checkOutOfScopeFiles({
      snapshot: makeSnap({
        allowedFiles: ['src/billing/**'],
        changedFiles: ['src/auth/x.js'],
        status,
      }),
    });
    assert.equal(findings.length, 1, `status=${status} should be checked`);
  }
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkOutOfScopeFiles.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/checks/checkOutOfScopeFiles.js`**

```js
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_out_of_scope_files';
const CATEGORY = 'slice_scope';
const ACTIVE_STATUSES = new Set(['in_progress', 'review', 'testing', 'merge_ready']);

/**
 * Compares each active task's diff against its declared scope contract.
 * A change is out-of-scope when:
 *   (a) any forbiddenFiles glob matches it, OR
 *   (b) allowedFiles is non-empty AND no allowedFiles glob matches it.
 *
 * A task with both arrays empty has no scope contract — no findings.
 */
export function checkOutOfScopeFiles({ snapshot } = {}) {
  if (!snapshot) return [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const diffs = snapshot.diffsByTask ?? {};
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.taskId) continue;
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    const allowed = Array.isArray(task.allowedFiles) ? task.allowedFiles : [];
    const forbidden = Array.isArray(task.forbiddenFiles) ? task.forbiddenFiles : [];
    if (allowed.length === 0 && forbidden.length === 0) continue;

    const diff = diffs[task.taskId];
    const changed = Array.isArray(diff?.changedFiles) ? diff.changedFiles : [];

    for (const file of changed) {
      let outOfScope = false;
      if (forbidden.some((pat) => globMatch(pat, file))) outOfScope = true;
      else if (allowed.length > 0 && !allowed.some((pat) => globMatch(pat, file))) outOfScope = true;
      if (!outOfScope) continue;
      findings.push({
        id: stableFindingId({
          checkName: CHECK_NAME, category: CATEGORY, taskId: task.taskId,
          salient: file,
        }),
        runId: '',
        teamId: snapshot.teamId,
        taskId: task.taskId,
        category: CATEGORY,
        severity: 'medium',
        checkName: CHECK_NAME,
        title: `Task ${task.taskId} changed an out-of-scope file`,
        evidence: [
          `task ${task.taskId}: changed ${file}`,
          `allowed: ${allowed.length ? allowed.join(', ') : '(none)'}`,
          `forbidden: ${forbidden.length ? forbidden.join(', ') : '(none)'}`,
        ],
        expected: `changes only within: ${allowed.join(', ') || '(no contract)'}`,
        actual: `changed ${file}`,
        recommendedCorrection: `Move the change to a separate task whose scope includes "${file}", or update task ${task.taskId}'s allowedFiles.`,
        autoFixable: false,
      });
    }
  }
  return findings;
}

/**
 * Minimal glob: supports **, *, and literal segments. Uses the same shape
 * the project's risk policy uses (see riskClassifier.js patterns).
 */
function globMatch(pattern, file) {
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@DOUBLESTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DOUBLESTAR@@/g, '.*')
    + '$');
  return re.test(file);
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/checks/checkOutOfScopeFiles.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/checks/checkOutOfScopeFiles.js test/drift/checks/checkOutOfScopeFiles.test.js
git commit -m "feat(drift): checkOutOfScopeFiles detects scope-contract violations"
```

---

### Task 7: checkMissingTestArtifacts

**Files:**
- Create: `src/drift/checks/checkMissingTestArtifacts.js`
- Test: `test/drift/checks/checkMissingTestArtifacts.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkMissingTestArtifacts.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMissingTestArtifacts } from '../../../src/drift/checks/checkMissingTestArtifacts.js';

function snap({ taskEvents = [], runtimeEvents = [], tasks = [] } = {}) {
  return {
    teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    tasks, taskEvents, runtimeEvents,
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags testing→merge_ready with no test command between', () => {
  const findings = checkMissingTestArtifacts({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'merge_ready',
                testCommands: [] }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T09:50:00Z',
          payload: { from: 'review', to: 'testing' } },
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T10:00:00Z',
          payload: { from: 'testing', to: 'merge_ready' } },
      ],
      runtimeEvents: [
        // no Bash tool_call between 09:50 and 10:00
      ],
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].category, 'test_truth');
  assert.equal(findings[0].taskId, 'task-1');
});

test('does NOT flag when a Bash test command ran in the testing window', () => {
  const findings = checkMissingTestArtifacts({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'merge_ready',
                testCommands: [] }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T09:50:00Z',
          payload: { from: 'review', to: 'testing' } },
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T10:00:00Z',
          payload: { from: 'testing', to: 'merge_ready' } },
      ],
      runtimeEvents: [
        { eventType: 'tool_call', createdAt: '2026-05-03T09:55:00Z',
          payload: { toolName: 'Bash', input: { command: 'npm test' } } },
      ],
    }),
  });
  assert.equal(findings.length, 0);
});

test('uses task.testCommands when declared (more specific than fallback regex)', () => {
  const findings = checkMissingTestArtifacts({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'merge_ready',
                testCommands: ['python -m pytest tests/foo'] }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T09:50:00Z',
          payload: { from: 'review', to: 'testing' } },
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T10:00:00Z',
          payload: { from: 'testing', to: 'merge_ready' } },
      ],
      runtimeEvents: [
        // ran some other command, not the declared testCommand
        { eventType: 'tool_call', createdAt: '2026-05-03T09:55:00Z',
          payload: { toolName: 'Bash', input: { command: 'pytest tests/bar' } } },
      ],
    }),
  });
  assert.equal(findings.length, 1, 'declared command did not run, fallback regex must NOT save it');
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkMissingTestArtifacts.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/checks/checkMissingTestArtifacts.js`**

```js
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_missing_test_artifacts';
const CATEGORY = 'test_truth';

const FALLBACK_TEST_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(test|run\s+test)\b/i,
  /\bpytest\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bnode\s+--test\b/i,
];

/**
 * For each task that transitioned testing → merge_ready, check whether a
 * Bash tool_call ran during the testing window. If the task declared
 * testCommands, look for an exact substring match. Otherwise fall back to
 * the generic test-runner regex set.
 */
export function checkMissingTestArtifacts({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const tools = Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const findings = [];

  const taskById = new Map();
  for (const t of tasks) if (t && t.taskId) taskById.set(t.taskId, t);

  // For each task, find pairs (enterTesting, leaveToMergeReady).
  const byTask = new Map();
  for (const e of events) {
    if (e.eventType !== 'task.status_changed') continue;
    if (!e.taskId) continue;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  }

  for (const [taskId, list] of byTask) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let enterTesting = null;
    for (const ev of list) {
      const from = ev.payload?.from;
      const to = ev.payload?.to;
      if (to === 'testing') enterTesting = ev.createdAt;
      else if (from === 'testing' && to === 'merge_ready' && enterTesting) {
        const start = enterTesting;
        const end = ev.createdAt;
        const declared = Array.isArray(taskById.get(taskId)?.testCommands)
          ? taskById.get(taskId).testCommands
          : [];
        const ran = ranTestCommand(tools, start, end, declared);
        if (!ran) {
          findings.push({
            id: stableFindingId({
              checkName: CHECK_NAME, category: CATEGORY, taskId,
              salient: `${start}->${end}`,
            }),
            runId: '',
            teamId: snapshot.teamId,
            taskId,
            category: CATEGORY,
            severity: 'high',
            checkName: CHECK_NAME,
            title: `Task ${taskId} reached merge_ready without running tests`,
            evidence: [
              `task ${taskId}: testing window ${start} → ${end}`,
              `declared testCommands: ${declared.length ? declared.join(', ') : '(none — falling back to runner regex)'}`,
            ],
            expected: declared.length
              ? `Bash tool_call running one of: ${declared.join(', ')}`
              : 'Bash tool_call matching a known test runner (npm/pnpm/yarn test, pytest, cargo test, go test, node --test)',
            actual: 'no matching Bash tool_call in the testing window',
            recommendedCorrection: `Roll task ${taskId} back to "testing" and require a real test run.`,
            autoFixable: false,
          });
        }
        enterTesting = null;
      }
    }
  }
  return findings;
}

function ranTestCommand(toolEvents, startISO, endISO, declared) {
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  for (const e of toolEvents) {
    if (e.eventType !== 'tool_call') continue;
    if (e.payload?.toolName !== 'Bash') continue;
    const ms = Date.parse(e.createdAt);
    if (Number.isNaN(ms) || ms < startMs || ms > endMs) continue;
    const cmd = String(e.payload?.input?.command ?? '');
    if (declared.length > 0) {
      if (declared.some((d) => cmd.includes(d))) return true;
    } else {
      if (FALLBACK_TEST_PATTERNS.some((re) => re.test(cmd))) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/checks/checkMissingTestArtifacts.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/checks/checkMissingTestArtifacts.js test/drift/checks/checkMissingTestArtifacts.test.js
git commit -m "feat(drift): checkMissingTestArtifacts catches testing→merge_ready without tests"
```

---

### Task 8: checkRolePermissionViolations

**Files:**
- Create: `src/drift/checks/checkRolePermissionViolations.js`
- Test: `test/drift/checks/checkRolePermissionViolations.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkRolePermissionViolations.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRolePermissionViolations } from '../../../src/drift/checks/checkRolePermissionViolations.js';

function snap(runtimeEvents) {
  return {
    teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    tasks: [], taskEvents: [], runtimeEvents,
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('one finding per tool_call_denied event', () => {
  const findings = checkRolePermissionViolations({
    snapshot: snap([
      { eventType: 'tool_call_denied', createdAt: '2026-05-03T09:01:00Z',
        payload: { agentId: 'dev-1', role: 'developer', toolName: 'task_delete', reason: 'role denied' } },
      { eventType: 'tool_call_denied', createdAt: '2026-05-03T09:02:00Z',
        payload: { agentId: 'dev-2', role: 'developer', toolName: 'team_delete', reason: 'role denied' } },
      { eventType: 'tool_call', createdAt: '2026-05-03T09:03:00Z',
        payload: { toolName: 'Bash' } },
    ]),
  });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'medium');
  assert.equal(findings[0].category, 'risk');
  assert.match(findings[0].evidence[0], /dev-1/);
  assert.match(findings[1].evidence[0], /dev-2/);
});

test('returns no findings when there are no denials', () => {
  const findings = checkRolePermissionViolations({ snapshot: snap([]) });
  assert.equal(findings.length, 0);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkRolePermissionViolations.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/checks/checkRolePermissionViolations.js`**

```js
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_role_permission_violations';
const CATEGORY = 'risk';

/**
 * Counts tool_call_denied events and emits one finding per denial. Severity
 * is medium per the spec — denials are already prevented by roleAuthority,
 * but a denial means an agent attempted something it shouldn't, which is a
 * drift signal worth surfacing.
 */
export function checkRolePermissionViolations({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : [];
  const findings = [];
  for (const e of events) {
    if (e.eventType !== 'tool_call_denied') continue;
    const agentId = e.payload?.agentId ?? 'unknown';
    const role = e.payload?.role ?? 'unknown';
    const toolName = e.payload?.toolName ?? 'unknown';
    const reason = e.payload?.reason ?? 'role denied';
    findings.push({
      id: stableFindingId({
        checkName: CHECK_NAME, category: CATEGORY, taskId: null,
        salient: `${agentId}|${toolName}|${e.createdAt}`,
      }),
      runId: '',
      teamId: snapshot.teamId,
      taskId: null,
      category: CATEGORY,
      severity: 'medium',
      checkName: CHECK_NAME,
      title: `Agent ${agentId} (${role}) was denied ${toolName}`,
      evidence: [`agent ${agentId} (${role}) attempted ${toolName} at ${e.createdAt} — ${reason}`],
      expected: `${role} only calls tools in its allowed set (see ROLE_TOOLS in roleAuthority.js)`,
      actual: `${role} attempted ${toolName}`,
      recommendedCorrection: `Investigate why ${agentId} reached for ${toolName}; either expand the role or correct the agent's instruction.`,
      autoFixable: false,
    });
  }
  return findings;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/checks/checkRolePermissionViolations.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/checks/checkRolePermissionViolations.js test/drift/checks/checkRolePermissionViolations.test.js
git commit -m "feat(drift): checkRolePermissionViolations counts tool_call_denied events"
```

---

### Task 9: checkReviewWithoutFindings

**Files:**
- Create: `src/drift/checks/checkReviewWithoutFindings.js`
- Test: `test/drift/checks/checkReviewWithoutFindings.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkReviewWithoutFindings.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReviewWithoutFindings } from '../../../src/drift/checks/checkReviewWithoutFindings.js';

function snap(taskEvents) {
  return {
    teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    tasks: [], taskEvents, runtimeEvents: [],
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags review→testing transition with zero review_feedback events', () => {
  const findings = checkReviewWithoutFindings({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-03T09:50:00Z',
        payload: { from: 'in_progress', to: 'review' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-03T09:54:00Z',
        payload: { from: 'review', to: 'testing' } },
    ]),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'low');
  assert.equal(findings[0].category, 'checklist');
  assert.equal(findings[0].taskId, 'task-1');
});

test('does NOT flag review with at least one review_feedback event in window', () => {
  const findings = checkReviewWithoutFindings({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-03T09:50:00Z',
        payload: { from: 'in_progress', to: 'review' } },
      { taskId: 'task-1', eventType: 'task.review_feedback',
        createdAt: '2026-05-03T09:52:00Z', payload: { severity: 'minor' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-03T09:54:00Z',
        payload: { from: 'review', to: 'testing' } },
    ]),
  });
  assert.equal(findings.length, 0);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkReviewWithoutFindings.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/checks/checkReviewWithoutFindings.js`**

```js
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_review_without_findings';
const CATEGORY = 'checklist';

/**
 * Catches "rubber-stamp" reviews — the review window opened, then closed
 * straight to testing with no review_feedback ever recorded. Severity is
 * low because some tasks legitimately need no feedback; the signal is
 * useful in aggregate but not a hard violation.
 */
export function checkReviewWithoutFindings({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const findings = [];

  const byTask = new Map();
  for (const e of events) {
    if (!e.taskId) continue;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  }

  for (const [taskId, list] of byTask) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let enterReview = null;
    for (const ev of list) {
      if (ev.eventType !== 'task.status_changed') continue;
      const from = ev.payload?.from;
      const to = ev.payload?.to;
      if (to === 'review') enterReview = ev.createdAt;
      else if (from === 'review' && to === 'testing' && enterReview) {
        const start = enterReview;
        const end = ev.createdAt;
        const fbCount = list.filter((x) =>
          x.eventType === 'task.review_feedback' &&
          Date.parse(x.createdAt) >= Date.parse(start) &&
          Date.parse(x.createdAt) <= Date.parse(end)
        ).length;
        if (fbCount === 0) {
          findings.push({
            id: stableFindingId({
              checkName: CHECK_NAME, category: CATEGORY, taskId,
              salient: `${start}->${end}`,
            }),
            runId: '',
            teamId: snapshot.teamId,
            taskId,
            category: CATEGORY,
            severity: 'low',
            checkName: CHECK_NAME,
            title: `Task ${taskId} review closed with zero feedback`,
            evidence: [`task ${taskId}: review window ${start} → ${end} produced 0 review_feedback events`],
            expected: 'at least one review_feedback (any severity) before review → testing',
            actual: 'review → testing with no feedback recorded',
            recommendedCorrection: `Confirm the review actually happened. If yes, file a "no findings" review_feedback; if no, roll task ${taskId} back to review.`,
            autoFixable: false,
          });
        }
        enterReview = null;
      }
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/checks/checkReviewWithoutFindings.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/checks/checkReviewWithoutFindings.js test/drift/checks/checkReviewWithoutFindings.test.js
git commit -m "feat(drift): checkReviewWithoutFindings catches rubber-stamped reviews"
```

---

### Task 10: checkProviderLogicLeakage

**Files:**
- Create: `src/drift/checks/checkProviderLogicLeakage.js`
- Test: `test/drift/checks/checkProviderLogicLeakage.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkProviderLogicLeakage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderLogicLeakage } from '../../../src/drift/checks/checkProviderLogicLeakage.js';

function snap(diffs) {
  return {
    teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    tasks: Object.keys(diffs).map((tid) => ({
      teamId: 'team-a', taskId: tid, status: 'in_progress',
      allowedFiles: [], forbiddenFiles: [],
    })),
    taskEvents: [], runtimeEvents: [],
    foundryDocs: {}, worktrees: [],
    diffsByTask: diffs,
  };
}

test('flags provider import inside src/team/**', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': {
        changedFiles: ['src/team/teamConfig.js'],
        fileContents: {
          'src/team/teamConfig.js': "import Anthropic from '@anthropic-ai/sdk';\nexport function x() {}\n",
        },
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'architecture');
  assert.equal(findings[0].severity, 'medium');
  assert.match(findings[0].actual, /@anthropic-ai/);
});

test('does NOT flag provider imports outside the protected paths', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': {
        changedFiles: ['src/providers/anthropicAdapter.js'],
        fileContents: {
          'src/providers/anthropicAdapter.js': "import Anthropic from '@anthropic-ai/sdk';",
        },
      },
    }),
  });
  assert.equal(findings.length, 0);
});

test('flags openai inside src/broker/**', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': {
        changedFiles: ['src/broker/inMemoryBroker.js'],
        fileContents: {
          'src/broker/inMemoryBroker.js': "import OpenAI from 'openai';",
        },
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].actual, /openai/);
});

test('skips files without contents (diff did not provide them)', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': { changedFiles: ['src/team/teamConfig.js'] }, // no fileContents
    }),
  });
  assert.equal(findings.length, 0);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkProviderLogicLeakage.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/checks/checkProviderLogicLeakage.js`**

```js
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_provider_logic_leakage';
const CATEGORY = 'architecture';

const PROTECTED_PATH_RES = [
  /^src\/broker\//,
  /^src\/task\//,
  /^src\/team\//,
  /^src\/security\//,
  /^src\/policy\//,
  /^src\/read\//,
  /^src\/storage\//,
  /^src\/delivery\//,
];

const PROVIDER_IMPORT_RES = [
  /from\s+['"]@anthropic-ai\//,
  /require\(['"]@anthropic-ai\//,
  /from\s+['"]openai['"]/,
  /require\(['"]openai['"]/,
  /from\s+['"]@google\/generative-ai['"]/,
  /require\(['"]@google\/generative-ai['"]/,
  /from\s+['"]@lydell\/node-pty['"]/,
  /require\(['"]@lydell\/node-pty['"]/,
];

/**
 * Static path+import heuristic. The diffComputer must populate
 * `diffsByTask[tid].fileContents[path]` for the changed file's text;
 * skipped silently when contents aren't available (the engine wires this).
 */
export function checkProviderLogicLeakage({ snapshot } = {}) {
  if (!snapshot) return [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const diffs = snapshot.diffsByTask ?? {};
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.taskId) continue;
    const diff = diffs[task.taskId];
    if (!diff || typeof diff.fileContents !== 'object') continue;
    const changed = Array.isArray(diff.changedFiles) ? diff.changedFiles : [];
    for (const file of changed) {
      if (!PROTECTED_PATH_RES.some((re) => re.test(file))) continue;
      const text = diff.fileContents[file];
      if (typeof text !== 'string' || text.length === 0) continue;
      const matches = PROVIDER_IMPORT_RES.filter((re) => re.test(text));
      if (matches.length === 0) continue;
      const matchedSnippet = text
        .split('\n')
        .find((line) => PROVIDER_IMPORT_RES.some((re) => re.test(line)))
        ?.trim() ?? '(provider import detected)';
      findings.push({
        id: stableFindingId({
          checkName: CHECK_NAME, category: CATEGORY, taskId: task.taskId,
          salient: file,
        }),
        runId: '',
        teamId: snapshot.teamId,
        taskId: task.taskId,
        category: CATEGORY,
        severity: 'medium',
        checkName: CHECK_NAME,
        title: `Provider-specific import inside neutral path: ${file}`,
        evidence: [`task ${task.taskId} touched ${file}: ${matchedSnippet}`],
        expected: `${file} stays provider-neutral; provider SDKs live under src/providers/**`,
        actual: matchedSnippet,
        recommendedCorrection: `Move the provider call into src/providers/, expose a neutral interface, and have ${file} consume that interface.`,
        autoFixable: false,
      });
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/checks/checkProviderLogicLeakage.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/checks/checkProviderLogicLeakage.js test/drift/checks/checkProviderLogicLeakage.test.js
git commit -m "feat(drift): checkProviderLogicLeakage catches provider imports in core paths"
```

---

### Task 11: checkDoneWithoutMergeEvidence

**Files:**
- Create: `src/drift/checks/checkDoneWithoutMergeEvidence.js`
- Test: `test/drift/checks/checkDoneWithoutMergeEvidence.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkDoneWithoutMergeEvidence.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDoneWithoutMergeEvidence } from '../../../src/drift/checks/checkDoneWithoutMergeEvidence.js';

function snap({ tasks, taskEvents = [] }) {
  return {
    teamId: 'team-a', asOf: '2026-05-03T10:00:00Z',
    tasks, taskEvents, runtimeEvents: [],
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags done task with null integration and no integration_merged event', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done', integration: null }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T09:50:00Z',
          payload: { from: 'merge_ready', to: 'done' } },
      ],
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'architecture');
  assert.equal(findings[0].severity, 'high');
});

test('does NOT flag done task with integration set', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done',
                integration: { mergeCommit: 'abc123', baseBranch: 'main' } }],
    }),
  });
  assert.equal(findings.length, 0);
});

test('does NOT flag done task with task.integration_merged event present', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done', integration: null }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.integration_merged',
          createdAt: '2026-05-03T09:49:00Z',
          payload: { mergeCommit: 'abc123' } },
      ],
    }),
  });
  assert.equal(findings.length, 0);
});

test('only checks tasks with status "done"', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'in_progress', integration: null }],
    }),
  });
  assert.equal(findings.length, 0);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkDoneWithoutMergeEvidence.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/checks/checkDoneWithoutMergeEvidence.js`**

```js
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_done_without_merge_evidence';
const CATEGORY = 'architecture';

/**
 * A task is "done" but never actually merged when:
 *   - the projected task.integration is null, AND
 *   - no task.integration_merged event exists in taskEvents for the task
 */
export function checkDoneWithoutMergeEvidence({ snapshot } = {}) {
  if (!snapshot) return [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const mergedTaskIds = new Set(
    events
      .filter((e) => e.eventType === 'task.integration_merged' && e.taskId)
      .map((e) => e.taskId)
  );
  const findings = [];

  for (const task of tasks) {
    if (!task || task.status !== 'done' || !task.taskId) continue;
    if (task.integration && typeof task.integration === 'object') continue;
    if (mergedTaskIds.has(task.taskId)) continue;
    findings.push({
      id: stableFindingId({
        checkName: CHECK_NAME, category: CATEGORY, taskId: task.taskId,
        salient: 'no-merge',
      }),
      runId: '',
      teamId: snapshot.teamId,
      taskId: task.taskId,
      category: CATEGORY,
      severity: 'high',
      checkName: CHECK_NAME,
      title: `Task ${task.taskId} marked done without merge evidence`,
      evidence: [
        `task ${task.taskId}: status=done, integration=null`,
        `no task.integration_merged event found in taskEvents`,
      ],
      expected: 'task.integration set to a merge commit, or a task.integration_merged event present',
      actual: 'no merge commit recorded',
      recommendedCorrection: `Investigate task ${task.taskId} — was it manually marked done? Run merge or roll back to merge_ready.`,
      autoFixable: false,
    });
  }
  return findings;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/checks/checkDoneWithoutMergeEvidence.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/checks/checkDoneWithoutMergeEvidence.js test/drift/checks/checkDoneWithoutMergeEvidence.test.js
git commit -m "feat(drift): checkDoneWithoutMergeEvidence catches done tasks with no merge"
```

---

## Phase 4 — Engine orchestrator

### Task 12: driftEngine.runDrift

**Files:**
- Create: `src/drift/driftEngine.js`
- Create: `src/drift/checks/index.js` (registry of all 7 checks)
- Test: `test/drift/driftEngine.test.js`

- [ ] **Step 1: Create the check registry**

`src/drift/checks/index.js`:

```js
import { checkInvalidTransitions } from './checkInvalidTransitions.js';
import { checkOutOfScopeFiles } from './checkOutOfScopeFiles.js';
import { checkMissingTestArtifacts } from './checkMissingTestArtifacts.js';
import { checkRolePermissionViolations } from './checkRolePermissionViolations.js';
import { checkReviewWithoutFindings } from './checkReviewWithoutFindings.js';
import { checkProviderLogicLeakage } from './checkProviderLogicLeakage.js';
import { checkDoneWithoutMergeEvidence } from './checkDoneWithoutMergeEvidence.js';

/**
 * The full registry of slice-1 deterministic checks. Each entry is
 * `{ name, fn }` where `fn({snapshot}) => DriftFinding[]`. New checks
 * (and the slice-2 LLM tier) get added here without touching the engine.
 */
export const DETERMINISTIC_CHECKS = Object.freeze([
  { name: 'check_invalid_transitions', fn: checkInvalidTransitions },
  { name: 'check_out_of_scope_files', fn: checkOutOfScopeFiles },
  { name: 'check_missing_test_artifacts', fn: checkMissingTestArtifacts },
  { name: 'check_role_permission_violations', fn: checkRolePermissionViolations },
  { name: 'check_review_without_findings', fn: checkReviewWithoutFindings },
  { name: 'check_provider_logic_leakage', fn: checkProviderLogicLeakage },
  { name: 'check_done_without_merge_evidence', fn: checkDoneWithoutMergeEvidence },
]);
```

- [ ] **Step 2: Write the failing engine test**

`test/drift/driftEngine.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DriftEngine } from '../../src/drift/driftEngine.js';
import { SqliteDriftStore } from '../../src/drift/driftStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function bootstrapDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function makeDeps({ tasks = [], taskEvents = [], runtimeEvents = [] } = {}) {
  return {
    taskBoard: {
      listTasks: () => tasks,
      listEvents: () => taskEvents,
    },
    eventLog: {
      listEvents: () => runtimeEvents,
    },
  };
}

test('DriftEngine.runDrift returns score 0 + healthy status when no findings', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({ deps: makeDeps(), store });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.teamScore, 0);
  assert.equal(result.status, 'healthy');
  assert.equal(result.findings.length, 0);
  assert.equal(result.trigger, 'manual');
});

test('DriftEngine.runDrift produces findings for an obvious violation', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({
    deps: makeDeps({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done', integration: null }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-03T09:00:00Z',
          payload: { from: 'merge_ready', to: 'done' } },
      ],
    }),
    store,
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].checkName, 'check_done_without_merge_evidence');
  assert.equal(result.teamScore, 15); // high severity
  assert.equal(result.status, 'healthy'); // 15 ≤ 20

  // Persisted history grows.
  const hist = store.listScoreHistory({ teamId: 'team-a', limit: 10 });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].teamScore, 15);
});

test('DriftEngine.runDrift takes a per-team mutex (concurrent calls return same result)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({ deps: makeDeps(), store });
  const [a, b] = await Promise.all([
    engine.runDrift({ teamId: 'team-a', trigger: 'manual' }),
    engine.runDrift({ teamId: 'team-a', trigger: 'manual' }),
  ]);
  assert.equal(a.runId, b.runId, 'concurrent calls share the in-flight runId');
});

test('DriftEngine.runDrift includes last 30 history rows in the result', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({ deps: makeDeps(), store });
  for (let i = 0; i < 35; i += 1) {
    await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  }
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.history.length, 30);
});
```

- [ ] **Step 3: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/driftEngine.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `src/drift/driftEngine.js`**

```js
import { randomUUID } from 'node:crypto';
import { buildSnapshot } from './buildSnapshot.js';
import { scoreFindings } from './scoreFindings.js';
import { DETERMINISTIC_CHECKS } from './checks/index.js';

/**
 * Orchestrator for slice-1 drift evaluation.
 *
 *   1. buildSnapshot(teamId)
 *   2. run every registered check, collect findings
 *   3. stamp each finding with runId + teamId + scoreFindings()
 *   4. driftStore.recordRun (deletes prior, inserts new, prunes history)
 *   5. return DriftRunResult with last 30 history rows for the sparkline
 *
 * Per-team mutex: only one runDrift({teamId}) is in flight at a time.
 * Overlapping callers share the in-flight Promise (no double work).
 */
export class DriftEngine {
  #inflight = new Map(); // teamId -> Promise<DriftRunResult>

  constructor({ deps, store, checks = DETERMINISTIC_CHECKS } = {}) {
    if (!deps) throw new TypeError('DriftEngine: deps required');
    if (!store || typeof store.recordRun !== 'function') {
      throw new TypeError('DriftEngine: store with recordRun required');
    }
    this.deps = deps;
    this.store = store;
    this.checks = checks;
  }

  async runDrift({ teamId, trigger = 'manual' } = {}) {
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new TypeError('runDrift: teamId required');
    }
    const existing = this.#inflight.get(teamId);
    if (existing) return existing;

    const promise = this.#runDriftInner({ teamId, trigger })
      .finally(() => this.#inflight.delete(teamId));
    this.#inflight.set(teamId, promise);
    return promise;
  }

  async #runDriftInner({ teamId, trigger }) {
    const runId = `run_${randomUUID()}`;
    const snapshot = await buildSnapshot({ teamId, deps: this.deps });

    const findings = [];
    for (const check of this.checks) {
      try {
        const out = check.fn({ snapshot }) || [];
        for (const f of out) {
          findings.push({
            ...f,
            runId,
            teamId,
            runtimeError: undefined,
          });
        }
      } catch (err) {
        findings.push({
          id: `f_check_error_${check.name}_${runId.slice(4, 12)}`,
          runId,
          teamId,
          taskId: null,
          category: 'risk',
          severity: 'medium',
          checkName: check.name,
          title: `Check ${check.name} threw during evaluation`,
          evidence: [String(err && err.message ? err.message : err)],
          expected: 'check returns DriftFinding[]',
          actual: 'check threw an exception',
          recommendedCorrection: `Inspect ${check.name}'s implementation against the snapshot it received.`,
          autoFixable: false,
        });
      }
    }

    const { teamScore, status, perTaskScores, categoryScores } = scoreFindings(findings);

    this.store.recordRun({
      runId,
      teamId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      categoryScores,
      perTaskScores,
      trigger,
      findings,
    });

    const history = this.store.listScoreHistory({ teamId, limit: 30 })
      .map((h) => ({ runId: h.runId, teamScore: h.teamScore, createdAt: h.createdAt }));

    return {
      runId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      findings,
      categoryScores,
      perTaskScores,
      history,
      trigger,
    };
  }
}
```

- [ ] **Step 5: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/driftEngine.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/drift/checks/index.js src/drift/driftEngine.js test/drift/driftEngine.test.js
git commit -m "feat(drift): DriftEngine orchestrator with per-team mutex"
```

---

## Phase 5 — Tool wiring + periodic ticker

### Task 13: drift_run command in command-contract + role guard

**Files:**
- Modify: `src/commands/command-contract.js` (add `DRIFT_RUN`)
- Modify: `src/security/roleAuthority.js` (add `drift_run` to allowed tools for lead/architect/human)
- Test: `test/roleAuthority.test.js` (extend)

- [ ] **Step 1: Locate the existing pattern**

Read these files:
- `src/commands/command-contract.js` — find the `COMMANDS` enum and add a new entry
- `src/security/roleAuthority.js` — find the `ROLE_TOOLS` map

- [ ] **Step 2: Add the failing role-authority test**

In `test/roleAuthority.test.js`, append:

```js
test('roleAuthority allows drift_run for lead, architect, human, but denies developer', () => {
  // Allowed roles
  for (const role of ['lead', 'architect', 'human']) {
    assert.doesNotThrow(
      () => assertRoleCanCallTool({ role, toolName: 'drift_run' }),
      `${role} should be allowed`
    );
  }
  // Denied
  assert.throws(
    () => assertRoleCanCallTool({ role: 'developer', toolName: 'drift_run' }),
    /not allowed/i,
    'developer should be denied'
  );
});
```

- [ ] **Step 3: Run test, watch it fail**

Run: `node test/roleAuthority.test.js`
Expected: FAIL — drift_run not in any role's allowlist

- [ ] **Step 4: Add the command + grant access**

In `src/commands/command-contract.js`, inside the `COMMANDS` object, add:

```js
DRIFT_RUN: 'drift_run',
```

In `src/security/roleAuthority.js`, inside `ROLE_TOOLS`, add `'drift_run'` to the allowed set for `lead`, `architect`, and `human`.

- [ ] **Step 5: Run test, watch it pass**

Run: `node test/roleAuthority.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/command-contract.js src/security/roleAuthority.js test/roleAuthority.test.js
git commit -m "feat(drift): add drift_run command + role guard (lead/architect/human)"
```

---

### Task 14: drift_run handler in localToolFacade

**Files:**
- Modify: `src/tools/localToolFacade.js` (add constructor injection + handler + dispatch)
- Test: `test/localToolFacade.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/localToolFacade.test.js`:

```js
test('LocalToolFacade drift_run delegates to driftEngine and returns DriftRunResult shape', async () => {
  const fakeEngine = {
    async runDrift({ teamId, trigger }) {
      assert.equal(teamId, 'team-a');
      assert.equal(trigger, 'manual');
      return {
        runId: 'run_1', asOf: '2026-05-03T10:00:00Z',
        teamScore: 18, status: 'healthy', findings: [],
        categoryScores: { architecture: 100 }, perTaskScores: {},
        history: [], trigger: 'manual',
      };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    driftEngine: fakeEngine,
  });
  const result = await facade.execute({
    commandName: COMMANDS.DRIFT_RUN,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { trigger: 'manual' },
  });
  assert.equal(result.teamScore, 18);
  assert.equal(result.status, 'healthy');
});

test('LocalToolFacade drift_run rejects when no driftEngine is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    facade.execute({
      commandName: COMMANDS.DRIFT_RUN,
      actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
      args: {},
    }),
    /drift engine not configured/i
  );
});
```

- [ ] **Step 2: Run tests, watch them fail**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: FAIL — `Unsupported command: drift_run` and/or driftEngine not injected

- [ ] **Step 3: Add to facade constructor + dispatch + handler**

In `src/tools/localToolFacade.js`:

1. Add `driftEngine = null` to the constructor's destructured params (after `claudeUsageProbe`).
2. Store it: `this.driftEngine = driftEngine && typeof driftEngine.runDrift === 'function' ? driftEngine : null;`
3. Add to the `switch` in `execute()`:

```js
case COMMANDS.DRIFT_RUN:
  return this.#driftRun(actor, args);
```

4. Add the handler method (near `#usageSummary`):

```js
async #driftRun(actor, args) {
  if (!this.driftEngine) {
    throw new Error('drift engine not configured for this facade');
  }
  const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
    ? args.teamId
    : actor.teamId;
  const trigger = ['manual', 'periodic', 'task_event'].includes(args?.trigger)
    ? args.trigger
    : 'manual';
  return this.driftEngine.runDrift({ teamId, trigger });
}
```

- [ ] **Step 4: Run tests, watch them pass**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: PASS (both new tests + all prior tests still passing)

- [ ] **Step 5: Commit**

```bash
git add src/tools/localToolFacade.js test/localToolFacade.test.js
git commit -m "feat(drift): wire drift_run through LocalToolFacade with engine injection"
```

---

### Task 15: DriftMonitor periodic ticker

**Files:**
- Create: `src/drift/driftMonitor.js`
- Test: `test/drift/driftMonitor.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/driftMonitor.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftMonitor } from '../../src/drift/driftMonitor.js';

function fakeEngine() {
  const calls = [];
  return {
    calls,
    async runDrift({ teamId, trigger }) {
      calls.push({ teamId, trigger });
      return { runId: `r_${calls.length}`, teamScore: 0, status: 'healthy',
               findings: [], categoryScores: {}, perTaskScores: {},
               history: [], trigger, asOf: new Date().toISOString() };
    },
  };
}

test('DriftMonitor.tickOnce runs drift for every team with a live runtime', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine,
    listLiveTeams: () => ['team-a', 'team-b'],
  });
  await monitor.tickOnce();
  assert.deepEqual(
    engine.calls.sort((a, b) => a.teamId.localeCompare(b.teamId)),
    [
      { teamId: 'team-a', trigger: 'periodic' },
      { teamId: 'team-b', trigger: 'periodic' },
    ]
  );
});

test('DriftMonitor.tickOnce skips when there are no live teams', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({ engine, listLiveTeams: () => [] });
  await monitor.tickOnce();
  assert.equal(engine.calls.length, 0);
});

test('DriftMonitor.start / stop runs ticks at the configured interval', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'], intervalMs: 20,
  });
  monitor.start();
  await new Promise((r) => setTimeout(r, 70));
  monitor.stop();
  // 70ms / 20ms ≈ 3-4 ticks; allow some jitter.
  assert.ok(engine.calls.length >= 2 && engine.calls.length <= 5,
    `expected 2-5 ticks, got ${engine.calls.length}`);
});

test('DriftMonitor.notifyTaskEvent fires an off-cycle run for status transitions of interest', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'],
  });
  await monitor.notifyTaskEvent({
    teamId: 'team-a',
    eventType: 'task.status_changed',
    payload: { from: 'in_progress', to: 'review' },
  });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].trigger, 'task_event');
});

test('DriftMonitor.notifyTaskEvent ignores transitions that are not in the trigger set', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'],
  });
  await monitor.notifyTaskEvent({
    teamId: 'team-a',
    eventType: 'task.status_changed',
    payload: { from: 'backlog', to: 'ready' },
  });
  assert.equal(engine.calls.length, 0);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/driftMonitor.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/driftMonitor.js`**

```js
/**
 * Periodic + event-triggered driver for the drift engine.
 *
 *   start()  → begin a setInterval(tickOnce, intervalMs)
 *   stop()   → clear the interval
 *   tickOnce() → call engine.runDrift for every live team, in parallel
 *   notifyTaskEvent({teamId, eventType, payload})
 *            → fire an off-cycle runDrift({trigger:'task_event'}) when the
 *              transition is in TRIGGER_TRANSITIONS
 *
 * Errors from any one runDrift are swallowed (and logged) so a single
 * misbehaving team can't take the whole monitor down.
 */
const DEFAULT_INTERVAL_MS = 60_000;

const TRIGGER_TRANSITIONS = new Set([
  'review', 'testing', 'merge_ready', 'done',
]);

export class DriftMonitor {
  #timer = null;

  constructor({ engine, listLiveTeams, intervalMs = DEFAULT_INTERVAL_MS, logger = null } = {}) {
    if (!engine || typeof engine.runDrift !== 'function') {
      throw new TypeError('DriftMonitor: engine.runDrift required');
    }
    if (typeof listLiveTeams !== 'function') {
      throw new TypeError('DriftMonitor: listLiveTeams() required');
    }
    this.engine = engine;
    this.listLiveTeams = listLiveTeams;
    this.intervalMs = intervalMs;
    this.logger = logger || console;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.tickOnce().catch((err) => this.logger.warn('[drift] tick failed:', err));
    }, this.intervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async tickOnce() {
    const teams = await Promise.resolve(this.listLiveTeams());
    if (!Array.isArray(teams) || teams.length === 0) return;
    await Promise.all(teams.map(async (teamId) => {
      try {
        await this.engine.runDrift({ teamId, trigger: 'periodic' });
      } catch (err) {
        this.logger.warn(`[drift] team=${teamId} runDrift failed:`, err);
      }
    }));
  }

  async notifyTaskEvent({ teamId, eventType, payload } = {}) {
    if (eventType !== 'task.status_changed') return;
    const to = payload?.to;
    if (typeof to !== 'string' || !TRIGGER_TRANSITIONS.has(to)) return;
    if (typeof teamId !== 'string' || teamId.length === 0) return;
    try {
      await this.engine.runDrift({ teamId, trigger: 'task_event' });
    } catch (err) {
      this.logger.warn(`[drift] team=${teamId} task_event runDrift failed:`, err);
    }
  }
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/driftMonitor.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drift/driftMonitor.js test/drift/driftMonitor.test.js
git commit -m "feat(drift): DriftMonitor periodic + event-triggered ticker"
```

---

### Task 16: Wire DriftEngine + DriftMonitor into dev-api-server

**Files:**
- Modify: `scripts/dev-api-server.mjs` (construct, inject, wire task_event listener)

- [ ] **Step 1: Locate existing wiring**

Read `scripts/dev-api-server.mjs` to find:
- where `LocalToolFacade` is constructed
- where `eventLog`, `taskBoard`, `worktreeManager`, `diffComputer`, `runtimeRegistry`, `foundryStore` are constructed
- where `task_event` is appended (for the trigger listener)

- [ ] **Step 2: Construct + inject**

In `dev-api-server.mjs`, before the `LocalToolFacade` construction, add:

```js
import { SqliteDriftStore } from '../src/drift/driftStore.js';
import { DriftEngine } from '../src/drift/driftEngine.js';
import { DriftMonitor } from '../src/drift/driftMonitor.js';

// ...

const driftStore = new SqliteDriftStore({ db });

const driftEngine = new DriftEngine({
  deps: {
    taskBoard,
    eventLog,
    foundryStore,
    worktreeManager,
    diffComputer,
  },
  store: driftStore,
});
```

Pass to facade construction:

```js
const facade = new LocalToolFacade({
  // ...existing args...
  driftEngine,
});
```

- [ ] **Step 3: Wire the periodic ticker**

After the facade is constructed, add:

```js
const driftMonitor = new DriftMonitor({
  engine: driftEngine,
  listLiveTeams: () => {
    const runtimes = runtimeRegistry.listRuntimes() || [];
    const liveTeams = new Set(
      runtimes
        .filter((r) => r.status === 'running' || r.status === 'live' || r.status === 'starting')
        .map((r) => r.teamId)
        .filter((tid) => typeof tid === 'string' && tid.length > 0)
    );
    return Array.from(liveTeams);
  },
});
driftMonitor.start();
```

- [ ] **Step 4: Hook the task_event listener**

Find where `task_event` is appended (likely a `taskBoard.appendEvent` or `taskBoard.subscribe` call site). After the event is committed, call:

```js
driftMonitor.notifyTaskEvent({
  teamId: event.teamId,
  eventType: event.eventType,
  payload: event.payload,
}).catch((err) => console.warn('[drift] notifyTaskEvent failed', err));
```

If `taskBoard` has no event subscriber pattern, hook into the same place that emits SSE events for task events — that's where the orchestrator already routes lifecycle changes.

- [ ] **Step 5: Smoke test by hand**

Run: `node --no-warnings scripts/dev-api-server.mjs`
Expected: server starts; logs show `[drift] tick` messages roughly every 60s when at least one team is live; no crash on cold start.

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-api-server.mjs
git commit -m "feat(drift): construct + start DriftEngine + DriftMonitor in dev-api-server"
```

---

## Phase 6 — UI surface

### Task 17: useDrift hook (polling + manual refresh)

**Files:**
- Create: `ui/src/hooks/useDrift.ts`

- [ ] **Step 1: Locate the existing API client + hook patterns**

Read:
- `ui/src/api/client.ts` — `callTool`/`callToadApi` signature
- `ui/src/hooks/useToadData.ts` (or similar) — existing polling pattern
- `ui/src/components/PlanUsagePanel.tsx` — the most recent in-component polling example we shipped

- [ ] **Step 2: Implement `ui/src/hooks/useDrift.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool as callToadApi } from '@/api/client';

export interface DriftFinding {
  id: string;
  runId: string;
  teamId: string;
  taskId: string | null;
  category: 'architecture' | 'checklist' | 'slice_scope' | 'test_truth' | 'risk';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  checkName: string;
  title: string;
  evidence: string[];
  expected: string;
  actual: string;
  recommendedCorrection: string;
  autoFixable: boolean;
}

export interface DriftRunResult {
  runId: string;
  asOf: string;
  teamScore: number;
  status: 'healthy' | 'watch' | 'warning' | 'critical';
  findings: DriftFinding[];
  categoryScores: Record<string, number>;
  perTaskScores: Record<string, number>;
  history: { runId: string; teamScore: number; createdAt: string }[];
  trigger: 'manual' | 'periodic' | 'task_event';
}

interface UseDriftOptions {
  teamId: string | null;
  intervalMs?: number;
}

/**
 * Polls drift_run on the active team. Cadence: on-mount + every 60s
 * (matches the backend periodic ticker so the UI sees fresh data each
 * tick). Manual `refresh()` issues a `trigger: 'manual'` run that
 * bypasses the engine cache.
 */
export function useDrift({ teamId, intervalMs = 60_000 }: UseDriftOptions) {
  const [data, setData] = useState<DriftRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback(async (trigger: 'manual' | 'periodic' = 'periodic') => {
    if (!teamId) return;
    try {
      const res = await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'drift_run',
        args: { teamId, trigger },
      });
      if (!cancelledRef.current && res && typeof res === 'object') {
        setData(res as DriftRunResult);
        setError(null);
      }
    } catch (err) {
      if (!cancelledRef.current) setError(String(err));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void fetchOnce('periodic');
    const id = window.setInterval(() => { void fetchOnce('periodic'); }, intervalMs);
    return () => { cancelledRef.current = true; window.clearInterval(id); };
  }, [fetchOnce, intervalMs]);

  return { data, loading, error, refresh: () => fetchOnce('manual') };
}
```

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add ui/src/hooks/useDrift.ts
git commit -m "feat(drift-ui): useDrift hook polls drift_run and exposes manual refresh"
```

---

### Task 18: DriftScreen component

**Files:**
- Create: `ui/src/components/DriftScreen.tsx`

- [ ] **Step 1: Implement `ui/src/components/DriftScreen.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useDrift, type DriftFinding } from '@/hooks/useDrift';

interface DriftScreenProps {
  teamId: string | null;
  onOpenTask?: (taskId: string) => void;
}

const SEVERITY_ORDER: Record<DriftFinding['severity'], number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
};
const SEVERITY_COLOR: Record<DriftFinding['severity'], string> = {
  critical: 'var(--err, #f87171)',
  high:     'var(--err, #f87171)',
  medium:   'var(--warn, #ffcd66)',
  low:      'var(--ok, #4ade80)',
  info:     'var(--fg-dim)',
};
const STATUS_COLOR: Record<string, string> = {
  healthy:  'var(--ok, #4ade80)',
  watch:    'var(--warn, #ffcd66)',
  warning:  'var(--warn, #ffcd66)',
  critical: 'var(--err, #f87171)',
};
const CATEGORY_LABEL: Record<string, string> = {
  architecture: 'Architecture',
  checklist:    'Checklist',
  slice_scope:  'Slice Scope',
  test_truth:   'Test Truth',
  risk:         'Risk',
};

export function DriftScreen({ teamId, onOpenTask }: DriftScreenProps) {
  const { data, loading, error, refresh } = useDrift({ teamId });
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sortedFindings = useMemo(() => {
    if (!data) return [];
    return [...data.findings].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  }, [data]);

  const filtered = useMemo(() => sortedFindings.filter((f) =>
    (filterCategory === 'all' || f.category === filterCategory) &&
    (filterSeverity === 'all' || f.severity === filterSeverity)
  ), [sortedFindings, filterCategory, filterSeverity]);

  const topFindings = sortedFindings.slice(0, 4);

  if (!teamId) {
    return <div className="empty-state" style={{ padding: 24 }}>Select a team to view drift.</div>;
  }
  if (loading && !data) {
    return <div className="empty-state" style={{ padding: 24 }}>Computing drift…</div>;
  }
  if (error) {
    return <div className="empty-state" style={{ padding: 24, color: 'var(--err)' }}>Drift fetch failed: {error}</div>;
  }
  if (!data) return null;

  const peak = data.history.length ? Math.max(...data.history.map((h) => h.teamScore)) : data.teamScore;

  return (
    <div className="screen-pad" style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Drift Monitor</h1>
        <button className="btn" onClick={() => void refresh()}>
          <Icon name="refresh" size={12} /> Run check
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Team drift
          </div>
          <div style={{ fontSize: 36, fontWeight: 700, color: STATUS_COLOR[data.status], margin: '8px 0' }}>
            {data.teamScore}%
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[data.status] }} />
            <span style={{ textTransform: 'capitalize', fontSize: 12 }}>{data.status}</span>
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6 }}>
            Last {data.history.length} runs · peak {peak}% · current {data.teamScore}%
          </div>
          <Sparkline points={data.history.map((h) => h.teamScore)} />
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12 }}>Category breakdown</div>
        {Object.entries(data.categoryScores).map(([cat, score]) => (
          <div key={cat} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 50px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11 }}>{CATEGORY_LABEL[cat] ?? cat}</span>
            <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                width: `${score}%`, height: '100%',
                background: score >= 80 ? STATUS_COLOR.healthy : score >= 60 ? STATUS_COLOR.watch : STATUS_COLOR.critical,
              }} />
            </div>
            <span style={{ fontSize: 11, textAlign: 'right' }}>{score}%</span>
          </div>
        ))}
      </div>

      {topFindings.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Top drift sources</div>
          {topFindings.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 0' }}>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                background: SEVERITY_COLOR[f.severity], color: '#000',
                textTransform: 'uppercase',
              }}>
                {f.severity}
              </span>
              <span>{f.title}</span>
              {f.taskId && (
                <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>· {f.taskId}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>All findings ({sortedFindings.length})</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="field-input mono" style={{ fontSize: 11, padding: '4px 6px' }}>
              <option value="all">All categories</option>
              {Object.keys(CATEGORY_LABEL).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
            <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)} className="field-input mono" style={{ fontSize: 11, padding: '4px 6px' }}>
              <option value="all">All severities</option>
              {(['critical', 'high', 'medium', 'low', 'info'] as const).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        {filtered.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: 8 }}>No findings match this filter.</div>
        )}
        {filtered.map((f) => {
          const open = expanded.has(f.id);
          return (
            <div key={f.id} style={{
              border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
              borderRadius: 6, padding: 12, marginBottom: 8,
            }}>
              <div
                onClick={() => setExpanded((s) => {
                  const next = new Set(s);
                  if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                  return next;
                })}
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
              >
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                  background: SEVERITY_COLOR[f.severity], color: '#000',
                  textTransform: 'uppercase',
                }}>
                  {f.severity}
                </span>
                <span style={{ fontWeight: 600, fontSize: 12, flex: 1 }}>{f.title}</span>
                <span style={{ color: 'var(--fg-dim)', fontSize: 10 }}>
                  {CATEGORY_LABEL[f.category] ?? f.category}
                  {f.taskId && (
                    <>
                      {' · '}
                      <span
                        onClick={(e) => { e.stopPropagation(); if (f.taskId) onOpenTask?.(f.taskId); }}
                        style={{ textDecoration: 'underline', cursor: 'pointer' }}
                      >
                        {f.taskId}
                      </span>
                    </>
                  )}
                </span>
              </div>
              {open && (
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-muted)' }}>
                  <div><strong>Expected:</strong> {f.expected}</div>
                  <div><strong>Actual:</strong> {f.actual}</div>
                  <div><strong>Evidence:</strong>
                    <ul style={{ margin: '4px 0 4px 16px' }}>
                      {f.evidence.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                  <div><strong>Recommended:</strong> {f.recommendedCorrection}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>No history yet</div>;
  const w = 200, h = 32;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${h - (p / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="var(--clay, #d97757)" strokeWidth={1.5} />
    </svg>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/DriftScreen.tsx
git commit -m "feat(drift-ui): DriftScreen dashboard with score, sparkline, findings"
```

---

### Task 19: SidebarNav entry + App.tsx routing

**Files:**
- Modify: `ui/src/components/SidebarNav.tsx` (add `drift` entry)
- Modify: `ui/src/App.tsx` (route + render `DriftScreen`)
- Modify: `ui/src/types.ts` (extend the `screen` union if it's typed)

- [ ] **Step 1: Locate the SidebarNav screen entries**

Read `ui/src/components/SidebarNav.tsx`. The icons + labels live near the top; the `screen` change handler dispatches `setTweak('screen', 'X')`.

- [ ] **Step 2: Add drift entry**

In `SidebarNav.tsx`, between the Audit and Costs nav entries, insert:

```tsx
{ key: 'drift', label: 'Drift', icon: 'activity' as const },
```

(Use whatever icon is closest to "trending/activity" in the project's icon set. If no `activity` icon exists, use `info` or `bell`.)

- [ ] **Step 3: Wire the screen in App.tsx**

In `ui/src/App.tsx`, add to the imports:

```tsx
import { DriftScreen } from '@/components/DriftScreen';
```

Add to the screen-routing switch (alongside `costs`, `audit`):

```tsx
{tweaks.screen === 'drift' && (
  <DriftScreen
    teamId={team.name || activeTeamId}
    onOpenTask={(id) => {
      setSelectedTaskId(id);
      setTweak('screen', 'task');
    }}
  />
)}
```

In the `useEffect` near line 224 that picker-redirects on no-projects, add `'drift'` to the allow list of screens that don't require a project:

```ts
... && tweaks.screen !== 'drift' ...
```

(If the existing list already permits any screen, skip this.)

- [ ] **Step 4: Extend the screen union if typed**

If `ui/src/types.ts` has a `Tweaks['screen']` union, append `| 'drift'`.

- [ ] **Step 5: Type-check + manual smoke**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

Manual: launch the app, click Drift in the sidebar, confirm the screen renders with `Computing drift…` while the first poll resolves, then shows real data.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/SidebarNav.tsx ui/src/App.tsx ui/src/types.ts
git commit -m "feat(drift-ui): SidebarNav 'Drift' entry and route in App.tsx"
```

---

### Task 20: Per-task drift badge on task cards

**Files:**
- Create: `ui/src/components/DriftBadge.tsx`
- Modify: `ui/src/components/TasksScreen.tsx` (mount the badge on each task card)
- Modify: `ui/src/components/Workspace.tsx` (same, for the board view; only if the file uses task cards)

- [ ] **Step 1: Implement DriftBadge**

```tsx
// ui/src/components/DriftBadge.tsx
interface DriftBadgeProps {
  score: number | undefined;
  onClick?: () => void;
}

/**
 * Tiny color-coded chip on a task card showing its drift %. Hides when
 * score is undefined (drift hasn't been computed for this task yet, or
 * the task is in a non-active status).
 */
export function DriftBadge({ score, onClick }: DriftBadgeProps) {
  if (typeof score !== 'number') return null;
  const color = score >= 66 ? 'var(--err, #f87171)'
    : score >= 41 ? 'var(--warn, #ffcd66)'
    : score >= 21 ? 'var(--warn, #ffcd66)'
    : 'var(--ok, #4ade80)';
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      title="Drift score — click to view in Drift screen"
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '1px 5px',
        borderRadius: 3,
        background: color,
        color: '#000',
        cursor: onClick ? 'pointer' : 'default',
        letterSpacing: '0.04em',
      }}
    >
      {score}%
    </span>
  );
}
```

- [ ] **Step 2: Wire perTaskScores into TasksScreen**

Read `ui/src/components/TasksScreen.tsx` to find where task cards are rendered.

At the top of the component, accept (or read via a hook) the perTaskScores:

```tsx
import { useDrift } from '@/hooks/useDrift';
import { DriftBadge } from './DriftBadge';

// inside the component:
const { data: drift } = useDrift({ teamId });
const perTask = drift?.perTaskScores ?? {};
```

In each task-card render, add (next to the status pill):

```tsx
<DriftBadge score={perTask[task.taskId]} onClick={() => onSwitchToDrift?.()} />
```

If the parent doesn't pass `onSwitchToDrift`, the badge stays read-only.

- [ ] **Step 3: Same wiring in Workspace.tsx if it renders task cards**

Inspect `Workspace.tsx`; if it has its own task-card rendering, repeat Step 2.

- [ ] **Step 4: Type-check + manual smoke**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

Manual: launch the app with a team that has at least one finding-producing condition (e.g. a task marked done with no integration). Confirm the offending task card shows a colored drift badge.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/DriftBadge.tsx ui/src/components/TasksScreen.tsx ui/src/components/Workspace.tsx
git commit -m "feat(drift-ui): per-task DriftBadge on task cards"
```

---

## Phase 7 — Final wire-up

### Task 21: Extend package.json test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Locate the test script**

Read `package.json` and find the `test` script.

- [ ] **Step 2: Append the new test files in dependency order**

Insert (preserving the existing `&&` chain) after the `claudeUsageProbe.test.js` entry:

```
 && node --no-warnings test/sqliteDriftStore.test.js
 && node --no-warnings --test test/drift/scoreFindings.test.js
 && node --no-warnings --test test/drift/buildSnapshot.test.js
 && node --no-warnings --test test/drift/checks/checkInvalidTransitions.test.js
 && node --no-warnings --test test/drift/checks/checkOutOfScopeFiles.test.js
 && node --no-warnings --test test/drift/checks/checkMissingTestArtifacts.test.js
 && node --no-warnings --test test/drift/checks/checkRolePermissionViolations.test.js
 && node --no-warnings --test test/drift/checks/checkReviewWithoutFindings.test.js
 && node --no-warnings --test test/drift/checks/checkProviderLogicLeakage.test.js
 && node --no-warnings --test test/drift/checks/checkDoneWithoutMergeEvidence.test.js
 && node --no-warnings --test test/drift/driftEngine.test.js
 && node --no-warnings --test test/drift/driftMonitor.test.js
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: every prior test still passes; every new drift test passes.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(drift): add drift tests to npm test chain"
```

---

### Task 22: End-to-end manual verification

This task has no test file — it's the human smoke test before declaring slice 1 done.

- [ ] **Step 1: Boot the sidecar + UI**

Run: `cd ui && npm run tauri:dev`
Wait for "Symphony AI API listening" + UI window.

- [ ] **Step 2: Click "Drift" in the SidebarNav**

Expected: `Computing drift…` for ~1 second, then the dashboard renders with score, status pill, sparkline (probably empty on first run), category bars, top sources (probably empty on a clean team), all findings.

- [ ] **Step 3: Manually produce a finding**

Easiest reproducible: in a test team, manually mark a task `done` via the API without going through merge_ready, OR mark `task.integration` as null on a done task. Within ~60s the periodic ticker should pick it up; click "Run check" to force immediate.

Expected: a HIGH finding for `check_done_without_merge_evidence` appears.

- [ ] **Step 4: Verify the per-task badge**

Expected: in the Tasks screen, the offending task's card shows a red drift badge.

- [ ] **Step 5: Verify history persists across sidecar restart**

Stop the sidecar, restart it, click Drift again.
Expected: the sparkline still shows the runs from before the restart (history is in SQLite).

- [ ] **Step 6: Final commit + ship note**

```bash
git commit --allow-empty -m "ship(drift): slice 1 verified end-to-end"
```

Note in the team chat or wherever ship notes go: *"Drift Monitor slice 1 shipped — deterministic engine, 7 checks, persisted history, dedicated screen + per-task badges. LLM tier and corrections deferred to slice 2/3 per spec."*

---

## Self-review checklist (filled in by plan author)

- [x] **Spec coverage** — every section of the spec maps to a task:
  - §3 Architecture / §3.1 Module layout → Tasks 2, 3, 4, 5–11, 12, 14, 15
  - §3.2 Wiring → Tasks 13, 14, 16
  - §4 Schema → Task 1, Task 2 (in-memory shapes referenced in handler)
  - §5 The 7 checks → Tasks 5–11 (one each)
  - §6.1 Drift screen → Tasks 17, 18, 19
  - §6.2 Per-task badges → Task 20
  - §7 Testing strategy → every implementation task ships its test file; Task 21 wires them into `npm test`
- [x] **Placeholder scan** — no TBD/TODO/"add error handling" pseudo-steps; every code change ships an exact code block
- [x] **Type consistency** — `DriftFinding` shape, `DriftRunResult` shape, `SEVERITY_WEIGHT` keys, status threshold names, and check function signatures are identical across tasks
- [x] **Method-name consistency** — `runDrift`, `recordRun`, `listScoreHistory`, `pruneHistory`, `notifyTaskEvent`, `tickOnce`, `stableFindingId` are spelled the same in every task that mentions them
