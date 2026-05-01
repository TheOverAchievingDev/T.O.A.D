import { randomUUID } from 'node:crypto';
import { jsonParseObject, jsonStringify, openToadDatabase } from '../storage/sqlite.js';

export class SqliteRuntimeEventLog {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  appendEvent(input) {
    const idempotencyKey = input.idempotencyKey || null;
    if (idempotencyKey) {
      const existing = this.#getEventByIdempotencyKey(idempotencyKey);
      if (existing) return { inserted: false, event: existing };
    }

    const event = {
      eventId: input.eventId || randomUUID(),
      idempotencyKey,
      runtimeId: requireString(input.runtimeId, 'runtimeId'),
      teamId: requireString(input.teamId, 'teamId'),
      agentId: requireString(input.agentId, 'agentId'),
      eventType: requireString(input.eventType, 'eventType'),
      sessionId:
        typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      createdAt: input.createdAt || new Date().toISOString(),
      payload: input.payload && typeof input.payload === 'object' ? { ...input.payload } : {},
    };

    this.#ensureTeam(event.teamId);
    this.db.prepare(
      `
        INSERT INTO runtime_events (
          event_id,
          idempotency_key,
          runtime_id,
          team_id,
          agent_id,
          event_type,
          session_id,
          created_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      event.eventId,
      event.idempotencyKey,
      event.runtimeId,
      event.teamId,
      event.agentId,
      event.eventType,
      event.sessionId,
      event.createdAt,
      jsonStringify(event.payload)
    );

    return { inserted: true, event: this.getEvent(event.eventId) };
  }

  getEvent(eventId) {
    const row = this.db
      .prepare('SELECT * FROM runtime_events WHERE event_id = ?')
      .get(requireString(eventId, 'eventId'));
    return row ? this.#rowToEvent(row) : null;
  }

  /**
   * List runtime events whose runtime is pinned to a specific task. Joins
   * `runtime_events.runtime_id` against `runtime_instances.task_id`. Returns
   * events in chronological order. §11 wires task_id; §20 task_history_export
   * relies on this join.
   */
  listEventsByTask({ teamId, taskId } = {}) {
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new TypeError('teamId must be a non-empty string');
    }
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new TypeError('taskId must be a non-empty string');
    }
    return this.db
      .prepare(
        `
          SELECT re.*
          FROM runtime_events re
          JOIN runtime_instances ri ON re.runtime_id = ri.runtime_id
          WHERE re.team_id = ? AND ri.task_id = ?
          ORDER BY re.created_at ASC, re.event_id ASC
        `
      )
      .all(teamId, taskId)
      .map((row) => this.#rowToEvent(row));
  }

  listEvents({ runtimeId = null, teamId = null } = {}) {
    if (runtimeId) {
      return this.db
        .prepare(
          'SELECT * FROM runtime_events WHERE runtime_id = ? ORDER BY created_at ASC, event_id ASC'
        )
        .all(runtimeId)
        .map((row) => this.#rowToEvent(row));
    }
    if (teamId) {
      return this.db
        .prepare('SELECT * FROM runtime_events WHERE team_id = ? ORDER BY created_at ASC, event_id ASC')
        .all(teamId)
        .map((row) => this.#rowToEvent(row));
    }
    return this.db
      .prepare('SELECT * FROM runtime_events ORDER BY created_at ASC, event_id ASC')
      .all()
      .map((row) => this.#rowToEvent(row));
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

  #getEventByIdempotencyKey(idempotencyKey) {
    const row = this.db
      .prepare('SELECT * FROM runtime_events WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? this.#rowToEvent(row) : null;
  }

  #rowToEvent(row) {
    return {
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      runtimeId: row.runtime_id,
      teamId: row.team_id,
      agentId: row.agent_id,
      eventType: row.event_type,
      sessionId: row.session_id,
      createdAt: row.created_at,
      payload: jsonParseObject(row.payload_json),
    };
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
