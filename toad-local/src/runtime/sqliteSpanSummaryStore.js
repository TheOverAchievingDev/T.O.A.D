import { randomUUID } from 'node:crypto';
import { openToadDatabase } from '../storage/sqlite.js';

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

/**
 * Durable projection of P3b's per-span summaries — mirrors
 * SqliteNarrationStore (own connection, ensure-team FK, idempotent
 * append). One row per CLOSED span; idempotency key is span_id
 * (closed spans are content-stable, so first-write-wins is correct).
 */
export class SqliteSpanSummaryStore {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  #ensureTeam(teamId) {
    this.db.prepare(
      `
        INSERT INTO teams (team_id, display_name, created_at)
        VALUES (?, NULL, ?)
        ON CONFLICT(team_id) DO NOTHING
      `
    ).run(teamId, new Date().toISOString());
  }

  #getBySpanId(spanId) {
    const row = this.db
      .prepare('SELECT * FROM span_summaries WHERE span_id = ?')
      .get(spanId);
    return row ? this.#rowToSummary(row) : null;
  }

  #rowToSummary(row) {
    return {
      summaryId: row.summary_id,
      spanId: row.span_id,
      teamId: row.team_id,
      runtimeId: row.runtime_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      summaryText: row.summary_text,
      model: row.model,
      cli: row.cli,
      spanStartedAt: row.span_started_at,
      spanEndedAt: row.span_ended_at,
      rowCount: row.row_count,
      tokens: row.tokens,
      createdAt: row.created_at,
    };
  }

  appendSummary(input) {
    const spanId = requireString(input.spanId, 'spanId');
    const existing = this.#getBySpanId(spanId);
    if (existing) return { inserted: false, row: existing };

    const row = {
      summaryId: randomUUID(),
      spanId,
      teamId: requireString(input.teamId, 'teamId'),
      runtimeId: requireString(input.runtimeId, 'runtimeId'),
      agentId: requireString(input.agentId, 'agentId'),
      sessionId:
        typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      summaryText: requireString(input.summaryText, 'summaryText'),
      model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null,
      cli: typeof input.cli === 'string' && input.cli.trim() ? input.cli.trim() : null,
      spanStartedAt: requireString(input.spanStartedAt, 'spanStartedAt'),
      spanEndedAt: requireString(input.spanEndedAt, 'spanEndedAt'),
      rowCount: requireNonNegativeInteger(input.rowCount, 'rowCount'),
      tokens:
        typeof input.tokens === 'number' && Number.isFinite(input.tokens) ? input.tokens : null,
      createdAt: input.createdAt || new Date().toISOString(),
    };
    this.#ensureTeam(row.teamId);
    this.db.prepare(
      `
        INSERT INTO span_summaries (
          summary_id, span_id, team_id, runtime_id, agent_id, session_id,
          summary_text, model, cli, span_started_at, span_ended_at,
          row_count, tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      row.summaryId, row.spanId, row.teamId, row.runtimeId, row.agentId, row.sessionId,
      row.summaryText, row.model, row.cli, row.spanStartedAt, row.spanEndedAt,
      row.rowCount, row.tokens, row.createdAt
    );
    return { inserted: true, row };
  }

  listSummaries({ teamId, runtimeId = null } = {}) {
    const team = requireString(teamId, 'teamId');
    if (runtimeId) {
      return this.db
        .prepare('SELECT * FROM span_summaries WHERE team_id = ? AND runtime_id = ? ORDER BY created_at ASC, summary_id ASC')
        .all(team, runtimeId)
        .map((r) => this.#rowToSummary(r));
    }
    return this.db
      .prepare('SELECT * FROM span_summaries WHERE team_id = ? ORDER BY created_at ASC, summary_id ASC')
      .all(team)
      .map((r) => this.#rowToSummary(r));
  }
}
