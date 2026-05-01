export class InMemoryApprovalBroker {
  #approvals = new Map();
  #responsesByKey = new Map();

  requestApproval(input) {
    const approvalId = requireString(input.approvalId, 'approvalId');
    const approval = {
      approvalId,
      teamId: requireString(input.teamId, 'teamId'),
      agentId: requireString(input.agentId, 'agentId'),
      runtimeId:
        typeof input.runtimeId === 'string' && input.runtimeId.trim() ? input.runtimeId.trim() : null,
      prompt: requireString(input.prompt, 'prompt'),
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
      status: 'pending',
      decision: null,
      reason: '',
      requestedAt: input.requestedAt || new Date().toISOString(),
      respondedAt: null,
      respondedBy: null,
    };
    this.#approvals.set(approvalId, approval);
    return cloneApproval(approval);
  }

  respondApproval(input) {
    const approvalId = requireString(input.approvalId, 'approvalId');
    const idempotencyKey = requireString(input.idempotencyKey, 'idempotencyKey');
    const existingId = this.#responsesByKey.get(idempotencyKey);
    if (existingId) {
      return cloneApproval(this.#requireApproval(existingId));
    }

    const approval = this.#requireApproval(approvalId);
    const decision = normalizeDecision(input.decision);
    approval.status = decision;
    approval.decision = decision;
    approval.reason = typeof input.reason === 'string' ? input.reason : '';
    approval.respondedAt = input.respondedAt || new Date().toISOString();
    approval.respondedBy = normalizeActor(input.actor);
    this.#responsesByKey.set(idempotencyKey, approvalId);
    return cloneApproval(approval);
  }

  getApproval(approvalId) {
    const approval = this.#approvals.get(requireString(approvalId, 'approvalId'));
    return approval ? cloneApproval(approval) : null;
  }

  listApprovals({ teamId = null } = {}) {
    return [...this.#approvals.values()]
      .filter((approval) => !teamId || approval.teamId === teamId)
      .map(cloneApproval);
  }

  #requireApproval(approvalId) {
    const approval = this.#approvals.get(approvalId);
    if (!approval) throw new Error(`unknown approval: ${approvalId}`);
    return approval;
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

function cloneApproval(approval) {
  return {
    ...approval,
    metadata: { ...approval.metadata },
    respondedBy: approval.respondedBy ? { ...approval.respondedBy } : null,
  };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
