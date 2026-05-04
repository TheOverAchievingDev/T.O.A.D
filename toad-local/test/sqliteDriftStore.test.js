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
