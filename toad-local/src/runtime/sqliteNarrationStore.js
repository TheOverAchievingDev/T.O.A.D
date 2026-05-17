import { randomUUID } from 'node:crypto';
import { openToadDatabase } from '../storage/sqlite.js';

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Durable projection of eventNarration.narrate() — mirrors
 * SqliteRuntimeEventLog (own connection, idempotent append, ensure-team
 * FK discipline). One row per narrated runtime event.
 */
export class SqliteNarrationStore {
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

  #getByIdempotencyKey(idempotencyKey) {
    const row = this.db
      .prepare('SELECT * FROM narrated_lines WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? this.#rowToNarration(row) : null;
  }

  #rowToNarration(row) {
    return {
      narrationId: row.narration_id,
      idempotencyKey: row.idempotency_key,
      eventId: row.event_id,
      runtimeId: row.runtime_id,
      teamId: row.team_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      createdAt: row.created_at,
      line: row.line,
      kind: row.kind,
      tokens: row.tokens,
    };
  }

  appendNarration(input) {
    const idempotencyKey = input.idempotencyKey || null;
    if (idempotencyKey) {
      const existing = this.#getByIdempotencyKey(idempotencyKey);
      if (existing) return { inserted: false, row: existing };
    }
    const row = {
      narrationId: randomUUID(),
      idempotencyKey,
      eventId: typeof input.eventId === 'string' && input.eventId ? input.eventId : null,
      runtimeId: requireString(input.runtimeId, 'runtimeId'),
      teamId: requireString(input.teamId, 'teamId'),
      agentId: requireString(input.agentId, 'agentId'),
      sessionId:
        typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      eventType: requireString(input.eventType, 'eventType'),
      createdAt: input.createdAt || new Date().toISOString(),
      line: typeof input.line === 'string' ? input.line : '',
      kind: requireString(input.kind, 'kind'),
      tokens: typeof input.tokens === 'number' && Number.isFinite(input.tokens) ? input.tokens : null,
    };
    this.#ensureTeam(row.teamId);
    this.db.prepare(
      `
        INSERT INTO narrated_lines (
          narration_id, idempotency_key, event_id, runtime_id, team_id,
          agent_id, session_id, event_type, created_at, line, kind, tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      row.narrationId, row.idempotencyKey, row.eventId, row.runtimeId, row.teamId,
      row.agentId, row.sessionId, row.eventType, row.createdAt, row.line, row.kind, row.tokens
    );
    return { inserted: true, row };
  }

  listNarration({ teamId, runtimeId = null } = {}) {
    const team = requireString(teamId, 'teamId');
    if (runtimeId) {
      return this.db
        .prepare('SELECT * FROM narrated_lines WHERE team_id = ? AND runtime_id = ? ORDER BY created_at ASC, narration_id ASC')
        .all(team, runtimeId)
        .map((r) => this.#rowToNarration(r));
    }
    return this.db
      .prepare('SELECT * FROM narrated_lines WHERE team_id = ? ORDER BY created_at ASC, narration_id ASC')
      .all(team)
      .map((r) => this.#rowToNarration(r));
  }
}
