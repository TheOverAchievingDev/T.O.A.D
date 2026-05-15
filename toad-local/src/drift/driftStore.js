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

    // Defensive ensure-team row before insert. drift_findings and
    // drift_score_history both FK reference teams(team_id); without
    // this, a drift_run against a team that hasn't otherwise touched
    // the DB yet (e.g. a team_id surfaced by a stale UI cache after
    // a project switch — 2026-05-15 bug report) fails with
    // "FOREIGN KEY constraint failed" and the engine surfaces an
    // opaque ERR_SQLITE_ERROR to the caller. Other stores already do
    // this (sqliteBroker, sqliteTaskBoard, sqliteRuntimeRegistry,
    // sqliteApprovalBroker, sqliteRuntimeEventLog) — drift was the
    // only writer missing the pattern.
    const ensureTeam = this.db.prepare(`
      INSERT INTO teams (team_id, display_name, created_at)
      VALUES (?, NULL, ?)
      ON CONFLICT(team_id) DO NOTHING
    `);
    const deleteFindings = this.db.prepare('DELETE FROM drift_findings WHERE team_id = ?');
    const insertFinding = this.db.prepare(`INSERT INTO drift_findings
      (finding_id, run_id, team_id, task_id, category, severity, check_name,
       title, evidence_json, expected, actual, recommended, auto_fixable,
       correction_task_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertHistory = this.db.prepare(`INSERT INTO drift_score_history
      (run_id, team_id, team_score, status, category_scores_json,
       per_task_scores_json, findings_count, trigger, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      ensureTeam.run(teamId, asOf || new Date().toISOString());
      deleteFindings.run(teamId);
      for (const f of findingsArr) {
        insertFinding.run(
          f.id, runId, teamId, f.taskId ?? null, f.category, f.severity,
          f.checkName, f.title, JSON.stringify(f.evidence ?? []),
          f.expected, f.actual, f.recommendedCorrection,
          f.autoFixable ? 1 : 0,
          f.correctionTaskId ?? null,
          asOf
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
    if (!teamId || !taskBoard || typeof taskBoard.getTask !== 'function') {
      return { reaped: 0 };
    }
    const linkages = this.getCorrectionLinkages({ teamId });
    if (linkages.size === 0) return { reaped: 0 };

    const RESOLVED_OR_GONE = (taskId) => {
      const task = taskBoard.getTask({ teamId, taskId });
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
    correctionTaskId: r.correction_task_id ?? null,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
