/**
 * SQLite-backed reader/writer for drift findings + score history.
 * Engine is the only writer; UI + drift_run callers read.
 *
 * recordRun is atomic for findings + history: deletes prior findings for
 * the team, inserts the new findings, and inserts one score-history row,
 * all in a single BEGIN/COMMIT transaction. After the transaction
 * commits, pruneHistory runs as best-effort cleanup (a crash between
 * commit and prune leaves data correct, just over-sized — the next
 * recordRun trims again).
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
      try { rollback.run(); } catch { /* transaction already aborted */ }
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

  pruneHistory({ teamId, keep } = {}) {
    if (!teamId) return { deleted: 0 };
    const limit = typeof keep === 'number' ? keep : this.historyKeep;
    const result = this.db.prepare(
      `DELETE FROM drift_score_history
       WHERE team_id = ?
         AND run_id NOT IN (
           SELECT run_id FROM drift_score_history
           WHERE team_id = ?
           ORDER BY created_at DESC, run_id DESC
           LIMIT ?
         )`
    ).run(teamId, teamId, limit);
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
