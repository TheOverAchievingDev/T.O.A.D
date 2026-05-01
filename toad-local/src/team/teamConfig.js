export class TeamConfig {
  constructor({ teamId, lead = {}, teammates = [] }) {
    if (typeof teamId !== 'string' || teamId.trim() === '') {
      throw new TypeError('teamId must be a non-empty string');
    }
    this.teamId = teamId.trim();
    
    this.lead = {
      agentId: lead.agentId || 'lead',
      prompt: lead.prompt || ''
    };
    
    this.teammates = teammates.map(t => ({
      agentId: t.agentId || 'worker',
      prompt: t.prompt || ''
    }));
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
