import { jsonParseObject, jsonStringify, openToadDatabase } from '../storage/sqlite.js';

export class SqliteApprovalBroker {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  requestApproval(input) {
    const approval = {
      approvalId: requireString(input.approvalId, 'approvalId'),
      teamId: requireString(input.teamId, 'teamId'),
      agentId: requireString(input.agentId, 'agentId'),
      runtimeId:
        typeof input.runtimeId === 'string' && input.runtimeId.trim()
          ? input.runtimeId.trim()
          : 'runtime:unknown',
      prompt: requireString(input.prompt, 'prompt'),
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
      status: 'pending',
      decision: null,
      reason: '',
      requestedAt: input.requestedAt || new Date().toISOString(),
      respondedAt: null,
      respondedBy: null,
    };
    this.#ensureTeam(approval.teamId);
    this.db.prepare(
      `
        INSERT INTO approval_requests (
          approval_id,
          team_id,
          runtime_id,
          agent_id,
          tool_name,
          input_json,
          status,
          created_at,
          resolved_at,
          decision_json,
          response_idempotency_key,
          responded_by_team_id,
          responded_by_agent_id,
          reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
        ON CONFLICT(approval_id) DO NOTHING
      `
    ).run(
      approval.approvalId,
      approval.teamId,
      approval.runtimeId,
      approval.agentId,
      'approval_request',
      jsonStringify({ prompt: approval.prompt, metadata: approval.metadata }),
      approval.status,
      approval.requestedAt
    );

    return this.getApproval(approval.approvalId);
  }

  respondApproval(input) {
    const approvalId = requireString(input.approvalId, 'approvalId');
    const idempotencyKey = requireString(input.idempotencyKey, 'idempotencyKey');
    const existing = this.#getApprovalByResponseKey(idempotencyKey);
    if (existing) return existing;

    if (!this.getApproval(approvalId)) {
      throw new Error(`unknown approval: ${approvalId}`);
    }

    const decision = normalizeDecision(input.decision);
    const actor = normalizeActor(input.actor);
    const reason = typeof input.reason === 'string' ? input.reason : '';
    const respondedAt = input.respondedAt || new Date().toISOString();
    this.db.prepare(
      `
        UPDATE approval_requests
        SET status = ?,
            resolved_at = ?,
            decision_json = ?,
            response_idempotency_key = ?,
            responded_by_team_id = ?,
            responded_by_agent_id = ?,
            reason = ?
        WHERE approval_id = ?
      `
    ).run(
      decision,
      respondedAt,
      jsonStringify({ decision }),
      idempotencyKey,
      actor.teamId,
      actor.agentId,
      reason,
      approvalId
    );

    return this.getApproval(approvalId);
  }

  getApproval(approvalId) {
    const row = this.db
      .prepare(`
        SELECT ar.*, ad.runtime_id AS delivered_to_runtime_id, ad.delivered_at 
        FROM approval_requests ar 
        LEFT JOIN approval_deliveries ad ON ar.approval_id = ad.approval_id
        WHERE ar.approval_id = ?
      `)
      .get(requireString(approvalId, 'approvalId'));
    return row ? this.#rowToApproval(row) : null;
  }

  listApprovals({ teamId = null } = {}) {
    const query = `
      SELECT ar.*, ad.runtime_id AS delivered_to_runtime_id, ad.delivered_at 
      FROM approval_requests ar 
      LEFT JOIN approval_deliveries ad ON ar.approval_id = ad.approval_id
      ${teamId ? 'WHERE ar.team_id = ?' : ''}
      ORDER BY ar.created_at ASC, ar.approval_id ASC
    `;
    const rows = teamId
      ? this.db.prepare(query).all(teamId)
      : this.db.prepare(query).all();
    return rows.map((row) => this.#rowToApproval(row));
  }

  markApprovalDelivered(input) {
    const approvalId = requireString(input.approvalId, 'approvalId');
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const deliveredAt = input.deliveredAt || new Date().toISOString();
    
    // We use approval_id as the delivery_id for 1:1 mapping, or a specific id.
    const deliveryId = `delivery-${approvalId}`;

    this.db.prepare(`
      INSERT INTO approval_deliveries (delivery_id, approval_id, runtime_id, delivered_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(approval_id) DO NOTHING
    `).run(deliveryId, approvalId, runtimeId, deliveredAt);
    
    return this.getApproval(approvalId);
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

  #getApprovalByResponseKey(idempotencyKey) {
    const row = this.db
      .prepare(`
        SELECT ar.*, ad.runtime_id AS delivered_to_runtime_id, ad.delivered_at 
        FROM approval_requests ar 
        LEFT JOIN approval_deliveries ad ON ar.approval_id = ad.approval_id
        WHERE ar.response_idempotency_key = ?
      `)
      .get(idempotencyKey);
    return row ? this.#rowToApproval(row) : null;
  }

  #rowToApproval(row) {
    const input = jsonParseObject(row.input_json);
    const decision = jsonParseObject(row.decision_json, null);
    return {
      approvalId: row.approval_id,
      teamId: row.team_id,
      agentId: row.agent_id,
      runtimeId: row.runtime_id === 'runtime:unknown' ? null : row.runtime_id,
      prompt: typeof input.prompt === 'string' ? input.prompt : row.tool_name,
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      status: row.status,
      decision: typeof decision?.decision === 'string' ? decision.decision : null,
      reason: row.reason || '',
      requestedAt: row.created_at,
      respondedAt: row.resolved_at,
      respondedBy:
        row.responded_by_team_id && row.responded_by_agent_id
          ? {
              teamId: row.responded_by_team_id,
              agentId: row.responded_by_agent_id,
            }
          : null,
      delivery: row.delivered_to_runtime_id
        ? {
            runtimeId: row.delivered_to_runtime_id,
            deliveredAt: row.delivered_at,
          }
        : null,
    };
  }
}

function normalizeDecision(value) {
  const decision = requireString(value, 'decision');
  if (decision !== 'approved' && decision !== 'denied') {
    throw new Error(`unsupported approval decision: ${decision}`);
  }
  return decision;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') throw new TypeError('actor is required');
  return {
    teamId: requireString(actor.teamId, 'actor.teamId'),
    agentId: requireString(actor.agentId, 'actor.agentId'),
  };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
