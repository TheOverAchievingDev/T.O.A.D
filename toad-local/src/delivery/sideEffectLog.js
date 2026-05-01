/**
 * Durable delivery receipt log for runtime side effects.
 *
 * Tracks tool-result deliveries and compaction reinjections in SQLite so
 * the orchestration process can detect already-delivered effects after a restart
 * and avoid sending duplicates.
 *
 * Kind values:
 *   'tool_result'             — adapter.sendToolResult() calls
 *   'compaction_reinjection'  — adapter.sendTurn() calls from CompactionHandler
 */
export class SideEffectLog {
  #db;

  constructor(db) {
    if (!db) throw new TypeError('db is required');
    this.#db = db;
  }

  /**
   * Insert a new pending record. Safe to call multiple times with the same
   * idempotencyKey — subsequent calls are silently ignored (ON CONFLICT DO NOTHING).
   */
  markPending({ deliveryId, idempotencyKey, kind, runtimeId }) {
    this.#db.prepare(`
      INSERT INTO side_effect_deliveries
        (delivery_id, idempotency_key, kind, runtime_id, status, created_at, delivered_at)
      VALUES (?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      requireString(deliveryId, 'deliveryId'),
      requireString(idempotencyKey, 'idempotencyKey'),
      requireString(kind, 'kind'),
      requireString(runtimeId, 'runtimeId'),
      new Date().toISOString(),
    );
  }

  /** Mark a pending record as successfully delivered. */
  markDelivered(idempotencyKey) {
    this.#db.prepare(`
      UPDATE side_effect_deliveries
      SET status = 'delivered', delivered_at = ?
      WHERE idempotency_key = ?
    `).run(new Date().toISOString(), requireString(idempotencyKey, 'idempotencyKey'));
  }

  /** Mark a pending record as failed. */
  markFailed(idempotencyKey) {
    this.#db.prepare(`
      UPDATE side_effect_deliveries
      SET status = 'failed'
      WHERE idempotency_key = ?
    `).run(requireString(idempotencyKey, 'idempotencyKey'));
  }

  /**
   * Returns all pending records, optionally filtered by kind.
   * Used on restart to replay undelivered side effects.
   */
  getPending(kind = null) {
    const rows = kind
      ? this.#db.prepare(
          `SELECT * FROM side_effect_deliveries WHERE status = 'pending' AND kind = ? ORDER BY created_at ASC`
        ).all(kind)
      : this.#db.prepare(
          `SELECT * FROM side_effect_deliveries WHERE status = 'pending' ORDER BY created_at ASC`
        ).all();
    return rows.map(rowToRecord);
  }

  /**
   * Deletes terminal ('delivered' / 'failed') records whose effective age exceeds
   * the given cutoff. Effective age is delivered_at when present, otherwise created_at.
   * Pending records are never deleted by this method. Returns the number of rows removed.
   */
  pruneOlderThan(cutoffDate) {
    if (!(cutoffDate instanceof Date) || Number.isNaN(cutoffDate.getTime())) {
      throw new TypeError('cutoffDate must be a valid Date');
    }
    const result = this.#db.prepare(`
      DELETE FROM side_effect_deliveries
      WHERE status IN ('delivered', 'failed')
        AND COALESCE(delivered_at, created_at) < ?
    `).run(cutoffDate.toISOString());
    return result.changes;
  }

  /** Returns a single record by idempotency key, or null. */
  get(idempotencyKey) {
    const row = this.#db
      .prepare(`SELECT * FROM side_effect_deliveries WHERE idempotency_key = ?`)
      .get(requireString(idempotencyKey, 'idempotencyKey'));
    return row ? rowToRecord(row) : null;
  }
}

function rowToRecord(row) {
  return {
    deliveryId: row.delivery_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    runtimeId: row.runtime_id,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null,
  };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
