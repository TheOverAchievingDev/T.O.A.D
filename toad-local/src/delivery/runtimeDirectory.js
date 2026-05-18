const DELIVERY_MODES = new Set([
  'runtime_stdin',
  'runtime_bridge',
  'pollable_inbox',
  'offline_queue',
  // SP1a: per-turn Codex (CodexExecAdapter) session agents. Not a live
  // stdin — DeliveryWorker (RUNTIME_DELIVERY_MODES) correctly queues it
  // (queued_for_recipient); Stage-2 wake-on-message owns its routing.
  'session_turn',
]);

export class RuntimeDirectory {
  #agents = new Map();

  registerAgent(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const deliveryMode = requireString(input.deliveryMode, 'deliveryMode');
    if (!DELIVERY_MODES.has(deliveryMode)) {
      throw new Error(`unsupported delivery mode: ${deliveryMode}`);
    }
    this.#agents.set(buildAgentKey(teamId, agentId), {
      teamId,
      agentId,
      runtimeId,
      deliveryMode,
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
    });
  }

  unregisterAgent(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    return this.#agents.delete(buildAgentKey(teamId, agentId));
  }

  listAgents() {
    return Array.from(this.#agents.values()).map((agent) => ({
      ...agent,
      metadata: { ...agent.metadata },
    }));
  }

  resolve(recipient) {
    if (!recipient || typeof recipient !== 'object') {
      throw new TypeError('recipient is required');
    }
    if (recipient.kind === 'user' || recipient.kind === 'system') {
      return {
        runtimeId: `${recipient.kind}:local`,
        deliveryMode: 'pollable_inbox',
        destination: { kind: recipient.kind },
      };
    }
    if (recipient.kind === 'team') {
      const teamId = requireString(recipient.teamId, 'recipient.teamId');
      return {
        runtimeId: `team:${teamId}`,
        deliveryMode: 'pollable_inbox',
        destination: { kind: 'team', teamId },
      };
    }
    if (recipient.kind !== 'agent') {
      throw new Error(`unsupported recipient kind: ${recipient.kind}`);
    }

    const teamId = requireString(recipient.teamId, 'recipient.teamId');
    const agentId = requireString(recipient.agentId, 'recipient.agentId');
    const registered = this.#agents.get(buildAgentKey(teamId, agentId));
    if (registered) {
      return {
        runtimeId: registered.runtimeId,
        deliveryMode: registered.deliveryMode,
        destination: { kind: registered.deliveryMode, teamId, agentId },
        metadata: registered.metadata,
      };
    }

    return {
      runtimeId: `offline:${teamId}:${agentId}`,
      deliveryMode: 'offline_queue',
      destination: { kind: 'offline_queue', teamId, agentId },
    };
  }
}

function buildAgentKey(teamId, agentId) {
  return `${teamId}:${agentId}`;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
