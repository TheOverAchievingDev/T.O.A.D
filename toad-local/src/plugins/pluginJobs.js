import { randomUUID } from 'node:crypto';
import { openToadDatabase, jsonParseObject } from '../storage/sqlite.js';

const LOG_TAIL_MAX = 64 * 1024; // 64KB cap

/**
 * SQLite-backed background-job tracker. Mostly unused in slice 1
 * (Railway is synchronous); slice 2 (EAS) is the first plugin to
 * actually populate this with running jobs. Schema lives in
 * src/storage/schema.sql.
 */
export class SqlitePluginJobs {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  create({ teamId, pluginId, action, args, jobId, now = new Date().toISOString() }) {
    const id = jobId || `job_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO plugin_jobs
        (job_id, team_id, plugin_id, action, state, args_json,
         log_tail, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, '', ?, ?)`
    ).run(id, teamId, pluginId, action, JSON.stringify(args ?? {}), now, now);
    return this.get({ jobId: id });
  }

  /**
   * Note: passing `error: null` or `finishedAt: null` does NOT clear an existing
   * value (COALESCE preserves the prior value). To clear, use a follow-up direct
   * DB write — slice 2 may add explicit transitions if retry-with-clear becomes
   * a real flow.
   */
  update({ jobId, state, logChunk, finishedAt, error, now = new Date().toISOString() }) {
    const existing = this.get({ jobId });
    if (!existing) throw new Error(`pluginJobs.update: no job ${jobId}`);
    let nextLog = existing.logTail || '';
    if (typeof logChunk === 'string' && logChunk.length > 0) {
      nextLog = (nextLog + logChunk).slice(-LOG_TAIL_MAX);
    }
    this.db.prepare(
      `UPDATE plugin_jobs
        SET state = ?, log_tail = ?, updated_at = ?,
            finished_at = COALESCE(?, finished_at),
            error = COALESCE(?, error)
       WHERE job_id = ?`
    ).run(
      state ?? existing.state,
      nextLog,
      now,
      finishedAt ?? null,
      error ?? null,
      jobId,
    );
    return this.get({ jobId });
  }

  get({ jobId }) {
    const row = this.db.prepare('SELECT * FROM plugin_jobs WHERE job_id = ?').get(jobId);
    return row ? rowToJob(row) : null;
  }

  list({ teamId, state, limit = 100 } = {}) {
    const conditions = [];
    const params = [];
    if (teamId) { conditions.push('team_id = ?'); params.push(teamId); }
    if (state)  { conditions.push('state = ?');   params.push(state); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM plugin_jobs ${where}
       ORDER BY started_at DESC, job_id DESC
       LIMIT ?`
    ).all(...params, limit);
    return rows.map(rowToJob);
  }
}

function rowToJob(r) {
  return {
    jobId: r.job_id,
    teamId: r.team_id,
    pluginId: r.plugin_id,
    action: r.action,
    state: r.state,
    args: jsonParseObject(r.args_json, {}),
    logTail: r.log_tail || '',
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    error: r.error,
  };
}

