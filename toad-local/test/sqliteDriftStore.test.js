import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDriftStore } from '../src/drift/driftStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'storage', 'schema.sql');

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  // FK requires a parent teams row before any drift insert.
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-03T00:00:00Z')`).run();
  return { db, store: new SqliteDriftStore({ db }) };
}

test('schema.sql defines drift_findings and drift_score_history with required columns', () => {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(sql);

  // Parent row required by FOREIGN KEY (team_id) REFERENCES teams(team_id).
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('t1', 'Team 1', '2026-05-03T00:00:00Z')`).run();

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
