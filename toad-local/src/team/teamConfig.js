function normalizeMember(member, fallbackAgentId) {
  const m = member && typeof member === 'object' ? member : {};
  const agentId = (typeof m.agentId === 'string' && m.agentId.trim() ? m.agentId.trim() : fallbackAgentId);
  return {
    agentId,
    command: typeof m.command === 'string' && m.command.trim() ? m.command.trim() : 'claude',
    args: Array.isArray(m.args) ? m.args.map((entry) => String(entry)) : [],
    cwd: typeof m.cwd === 'string' && m.cwd.trim() ? m.cwd.trim() : null,
    env: m.env && typeof m.env === 'object' && !Array.isArray(m.env) ? { ...m.env } : {},
    providerId: typeof m.providerId === 'string' && m.providerId.trim() ? m.providerId.trim() : 'claude',
    prompt: typeof m.prompt === 'string' ? m.prompt : '',
  };
}

export class TeamConfig {
  constructor({ teamId, lead = {}, teammates = [] }) {
    if (typeof teamId !== 'string' || teamId.trim() === '') {
      throw new TypeError('teamId must be a non-empty string');
    }
    this.teamId = teamId.trim();
    this.lead = normalizeMember(lead, 'lead');
    this.teammates = Array.isArray(teammates)
      ? teammates.map((t, idx) => normalizeMember(t, `worker-${idx + 1}`))
      : [];
  }

  toJSON() {
    return {
      teamId: this.teamId,
      lead: { ...this.lead, env: { ...this.lead.env }, args: [...this.lead.args] },
      teammates: this.teammates.map((t) => ({ ...t, env: { ...t.env }, args: [...t.args] })),
    };
  }
}

export class TeamConfigRegistry {
  #teams = new Map();

  registerTeam(config) {
    if (!(config instanceof TeamConfig)) {
      throw new TypeError('config must be an instance of TeamConfig');
    }
    if (this.#teams.has(config.teamId)) {
      throw new Error(`Duplicate teamId: ${config.teamId}`);
    }
    this.#teams.set(config.teamId, config);
  }

  getTeam(teamId) {
    return this.#teams.get(teamId) || null;
  }

  listTeams() {
    return Array.from(this.#teams.values());
  }
}
