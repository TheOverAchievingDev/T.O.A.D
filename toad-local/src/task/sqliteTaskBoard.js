import {
  createTaskEvent,
  projectTask,
} from './inMemoryTaskBoard.js';
import { jsonParseObject, jsonStringify, openToadDatabase } from '../storage/sqlite.js';

export class SqliteTaskBoard {
  #subscribers = new Set();

  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  /**
   * Register a subscriber that fires AFTER each successfully-inserted event.
   * Mirrors InMemoryTaskBoard.subscribe's contract — see that class for
   * full docs. Subscribers do NOT fire on idempotent dedup hits, and
   * subscriber exceptions are caught + logged so they can't break the
   * orchestrator's write path.
   */
  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('SqliteTaskBoard.subscribe: fn must be a function');
    }
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

  appendEvent(input) {
    const event = createTaskEvent(input);
    const existing = event.idempotencyKey
      ? this.#getEventByIdempotencyKey(event.idempotencyKey)
      : null;
    if (existing) {
      return { inserted: false, event: existing };
    }

    this.#ensureTeam(event.teamId);
    this.db.prepare(
      `
        INSERT INTO task_events (
          event_id,
          idempotency_key,
          team_id,
          task_id,
          event_type,
          actor_id,
          created_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      event.eventId,
      event.idempotencyKey,
      event.teamId,
      event.taskId,
      event.eventType,
      event.actorId,
      event.createdAt,
      jsonStringify(event.payload)
    );

    const inserted = this.#getEvent(event.eventId);
    this.#fireSubscribers(inserted);
    return { inserted: true, event: inserted };
  }

  #fireSubscribers(event) {
    for (const fn of this.#subscribers) {
      try {
        fn(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[taskBoard] subscriber threw:', err && err.message ? err.message : err);
      }
    }
  }

  listEvents({ teamId, taskId } = {}) {
    if (teamId && taskId) {
      return this.db.prepare(
        `
          SELECT *
          FROM task_events
          WHERE team_id = ? AND task_id = ?
          ORDER BY created_at ASC, event_id ASC
        `
      ).all(teamId, taskId).map(rowToTaskEvent);
    }
    if (teamId) {
      return this.db.prepare(
        `
          SELECT *
          FROM task_events
          WHERE team_id = ?
          ORDER BY created_at ASC, event_id ASC
        `
      ).all(teamId).map(rowToTaskEvent);
    }
    return this.db.prepare(
      `
        SELECT *
        FROM task_events
        ORDER BY created_at ASC, event_id ASC
      `
    ).all().map(rowToTaskEvent);
  }

  getTask({ teamId, taskId }) {
    const events = this.listEvents({ teamId, taskId });
    if (events.length === 0) return null;
    return projectTask(events);
  }

  listTasks({ teamId }) {
    const byTask = new Map();
    for (const event of this.listEvents({ teamId })) {
      const list = byTask.get(event.taskId) || [];
      list.push(event);
      byTask.set(event.taskId, list);
    }
    return [...byTask.values()].map(projectTask);
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

  #getEvent(eventId) {
    const row = this.db.prepare('SELECT * FROM task_events WHERE event_id = ?').get(eventId);
    return row ? rowToTaskEvent(row) : null;
  }

  #getEventByIdempotencyKey(idempotencyKey) {
    const row = this.db.prepare('SELECT * FROM task_events WHERE idempotency_key = ?').get(idempotencyKey);
    return row ? rowToTaskEvent(row) : null;
  }
}

function rowToTaskEvent(row) {
  return {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    teamId: row.team_id,
    taskId: row.task_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    createdAt: row.created_at,
    payload: jsonParseObject(row.payload_json),
  };
}

