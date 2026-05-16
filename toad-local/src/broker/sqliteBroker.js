import { randomUUID } from 'node:crypto';
import { createMessageEnvelope } from '../protocol/envelopes.js';
import { jsonParseObject, jsonStringify, openToadDatabase } from '../storage/sqlite.js';

export class SqliteBroker {
  #subscribers = new Set();

  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  /**
   * Register a subscriber that fires AFTER each successfully-inserted
   * message. Mirrors SqliteTaskBoard.subscribe's contract verbatim:
   * does NOT fire on idempotent dedup hits; subscriber exceptions are
   * caught + logged so they cannot break the broker write path.
   *
   * Durability contract: fires synchronously after the message is
   * recorded; the message is queryable via this broker on the same
   * connection from within the handler. No stronger cross-process
   * disk-durability guarantee is made.
   */
  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('SqliteBroker.subscribe: fn must be a function');
    }
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

  appendMessage(input) {
    const envelope = createMessageEnvelope(input);
    const existing = envelope.idempotencyKey
      ? this.#getMessageByIdempotencyKey(envelope.idempotencyKey)
      : null;
    if (existing) {
      return { inserted: false, message: existing };
    }

    this.#ensureTeam(envelope.teamId);
    this.db.prepare(
      `
        INSERT INTO messages (
          message_id,
          conversation_id,
          idempotency_key,
          team_id,
          from_kind,
          from_id,
          to_kind,
          to_team_id,
          to_agent_id,
          kind,
          text,
          created_at,
          reply_to_message_id,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      envelope.messageId,
      envelope.conversationId,
      envelope.idempotencyKey,
      envelope.teamId,
      envelope.from.kind,
      envelope.from.id,
      envelope.to.kind,
      envelope.to.teamId || null,
      envelope.to.agentId || null,
      envelope.kind,
      envelope.text,
      envelope.createdAt,
      envelope.replyToMessageId,
      jsonStringify(envelope.metadata)
    );

    for (const ref of envelope.taskRefs) {
      if (!ref || typeof ref !== 'object') continue;
      const taskId = typeof ref.taskId === 'string' && ref.taskId.trim() ? ref.taskId.trim() : '';
      if (!taskId) continue;
      this.db.prepare(
        'INSERT OR IGNORE INTO message_task_refs (message_id, task_id) VALUES (?, ?)'
      ).run(envelope.messageId, taskId);
    }

    const message = this.getMessage(envelope.messageId);
    this.#fireSubscribers(message);
    return { inserted: true, message };
  }

  #fireSubscribers(message) {
    for (const fn of this.#subscribers) {
      try {
        fn(message);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[broker] subscriber threw:', err && err.message ? err.message : err);
      }
    }
  }

  getMessage(messageId) {
    const row = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
    return row ? this.#rowToMessage(row) : null;
  }

  listInbox({ teamId, recipient }) {
    const rows = this.db.prepare(
      `
        SELECT *
        FROM messages
        WHERE team_id = ?
          AND to_kind = ?
          AND COALESCE(to_team_id, '') = ?
          AND COALESCE(to_agent_id, '') = ?
        ORDER BY created_at ASC, message_id ASC
      `
    ).all(
      teamId,
      recipient.kind,
      recipient.teamId || '',
      recipient.agentId || ''
    );
    return rows.map((row) => this.#rowToMessage(row));
  }

  /**
   * List agent-targeted messages whose only delivery attempt was a fallback
   * (offline_queue) — i.e. the originating process couldn't resolve the
   * recipient. Used by the main sidecar's retry sweep to re-attempt delivery
   * with its own (live) adapters/directory.
   *
   * Skips messages that already have a successful runtime_stdin (or
   * runtime_bridge) delivery — those landed correctly the first time.
   *
   * Returns messages in oldest-first order so the recipient sees them in
   * causal order. Caller is responsible for invoking the DeliveryWorker
   * with each message id.
   */
  listMessagesNeedingDelivery({ limit = 200 } = {}) {
    const rows = this.db.prepare(
      `
        SELECT m.*
        FROM messages m
        WHERE m.to_kind = 'agent'
          AND NOT EXISTS (
            SELECT 1 FROM delivery_attempts da
            WHERE da.message_id = m.message_id
              AND da.status = 'committed'
              AND da.delivery_kind IN ('runtime_stdin', 'runtime_bridge')
          )
          AND EXISTS (
            SELECT 1 FROM delivery_attempts da
            WHERE da.message_id = m.message_id
              AND da.delivery_kind = 'offline_queue'
          )
        ORDER BY m.created_at ASC, m.message_id ASC
        LIMIT ?
      `
    ).all(Number.isInteger(limit) && limit > 0 ? limit : 200);
    return rows.map((row) => this.#rowToMessage(row));
  }

  listMessages({ teamId = null, conversationId = null, limit = null } = {}) {
    const clauses = [];
    const params = [];
    if (teamId) {
      clauses.push('team_id = ?');
      params.push(teamId);
    }
    if (conversationId) {
      clauses.push('conversation_id = ?');
      params.push(conversationId);
    }
    const limitClause = Number.isInteger(limit) && limit >= 0 ? 'LIMIT ?' : '';
    if (limitClause) params.push(limit);
    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `
        SELECT *
        FROM messages
        ${whereClause}
        ORDER BY created_at ASC, message_id ASC
        ${limitClause}
      `
    ).all(...params);
    return rows.map((row) => this.#rowToMessage(row));
  }

  markRead({ messageId, readerId, readAt = new Date().toISOString() }) {
    if (!this.getMessage(messageId)) {
      throw new Error(`unknown message: ${messageId}`);
    }
    this.db.prepare(
      `
        INSERT INTO message_reads (message_id, reader_id, read_at)
        VALUES (?, ?, ?)
        ON CONFLICT(message_id, reader_id)
        DO UPDATE SET read_at = excluded.read_at
      `
    ).run(messageId, readerId, readAt);
    return { messageId, readerId, readAt };
  }

  beginDeliveryAttempt({
    messageId,
    runtimeId,
    destination,
    idempotencyKey = null,
    payloadHash = null,
    deliveryKind = 'unknown',
    responseState = null,
  }) {
    if (!this.getMessage(messageId)) {
      throw new Error(`unknown message: ${messageId}`);
    }
    if (idempotencyKey) {
      const existing = this.#getDeliveryAttemptByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.payloadHash && payloadHash && existing.payloadHash !== payloadHash) {
          throw new Error(`delivery idempotency conflict: ${idempotencyKey}`);
        }
        return this.#deliveryAttemptResult(false, existing);
      }
    }
    const now = new Date().toISOString();
    const attempt = {
      attemptId: randomUUID(),
      idempotencyKey,
      payloadHash,
      messageId,
      runtimeId,
      deliveryKind,
      destination,
      status: 'pending',
      responseState,
      createdAt: now,
      updatedAt: now,
      receipt: null,
      error: null,
    };
    this.db.prepare(
      `
        INSERT INTO delivery_attempts (
          attempt_id,
          idempotency_key,
          payload_hash,
          message_id,
          runtime_id,
          delivery_kind,
          destination_json,
          status,
          response_state,
          created_at,
          updated_at,
          receipt_json,
          error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      attempt.attemptId,
      attempt.idempotencyKey,
      attempt.payloadHash,
      attempt.messageId,
      attempt.runtimeId,
      attempt.deliveryKind,
      jsonStringify(attempt.destination),
      attempt.status,
      attempt.responseState,
      attempt.createdAt,
      attempt.updatedAt,
      null,
      null
    );
    return this.#deliveryAttemptResult(true, attempt);
  }

  commitDeliveryAttempt({ attemptId, receipt, responseState = null }) {
    this.#assertAttemptExists(attemptId);
    const updatedAt = new Date().toISOString();
    this.db.prepare(
      `
        UPDATE delivery_attempts
        SET status = 'committed',
            receipt_json = ?,
            error = NULL,
            response_state = COALESCE(?, response_state),
            updated_at = ?
        WHERE attempt_id = ?
      `
    ).run(jsonStringify(receipt || {}), responseState, updatedAt, attemptId);
    return this.#getDeliveryAttempt(attemptId);
  }

  failDeliveryAttempt({ attemptId, error, retryable = true, responseState = null }) {
    this.#assertAttemptExists(attemptId);
    const updatedAt = new Date().toISOString();
    this.db.prepare(
      `
        UPDATE delivery_attempts
        SET status = ?,
            error = ?,
            response_state = COALESCE(?, response_state),
            updated_at = ?
        WHERE attempt_id = ?
      `
    ).run(
      retryable ? 'failed_retryable' : 'failed_terminal',
      String(error || 'unknown delivery failure'),
      responseState,
      updatedAt,
      attemptId
    );
    return this.#getDeliveryAttempt(attemptId);
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

  #getMessageByIdempotencyKey(idempotencyKey) {
    const row = this.db.prepare('SELECT * FROM messages WHERE idempotency_key = ?').get(idempotencyKey);
    return row ? this.#rowToMessage(row) : null;
  }

  #deliveryAttemptResult(inserted, attempt) {
    return { inserted, attempt, ...attempt };
  }

  #rowToMessage(row) {
    const taskRefs = this.db.prepare(
      'SELECT task_id FROM message_task_refs WHERE message_id = ? ORDER BY task_id ASC'
    ).all(row.message_id);
    return {
      messageId: row.message_id,
      conversationId: row.conversation_id,
      idempotencyKey: row.idempotency_key,
      teamId: row.team_id,
      from: {
        kind: row.from_kind,
        id: row.from_id,
        teamId: row.team_id,
      },
      to: {
        kind: row.to_kind,
        ...(row.to_team_id ? { teamId: row.to_team_id } : {}),
        ...(row.to_agent_id ? { agentId: row.to_agent_id } : {}),
      },
      kind: row.kind,
      text: row.text,
      createdAt: row.created_at,
      replyToMessageId: row.reply_to_message_id,
      taskRefs: taskRefs.map((ref) => ({ taskId: ref.task_id })),
      metadata: jsonParseObject(row.metadata_json),
    };
  }

  #assertAttemptExists(attemptId) {
    if (!this.#getDeliveryAttempt(attemptId)) {
      throw new Error(`unknown delivery attempt: ${attemptId}`);
    }
  }

  #getDeliveryAttempt(attemptId) {
    const row = this.db.prepare('SELECT * FROM delivery_attempts WHERE attempt_id = ?').get(attemptId);
    if (!row) return null;
    return this.#rowToDeliveryAttempt(row);
  }

  #getDeliveryAttemptByIdempotencyKey(idempotencyKey) {
    const row = this.db
      .prepare('SELECT * FROM delivery_attempts WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? this.#rowToDeliveryAttempt(row) : null;
  }

  #rowToDeliveryAttempt(row) {
    return {
      attemptId: row.attempt_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      messageId: row.message_id,
      runtimeId: row.runtime_id,
      deliveryKind: row.delivery_kind,
      destination: jsonParseObject(row.destination_json),
      status: row.status,
      responseState: row.response_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      receipt: row.receipt_json ? jsonParseObject(row.receipt_json) : null,
      error: row.error,
    };
  }
}
