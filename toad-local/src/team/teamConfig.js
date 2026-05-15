import { PROVIDER_COMMANDS, commandForProvider } from './providerCommands.js';

const KNOWN_COMMANDS = new Set(Object.values(PROVIDER_COMMANDS));

function normalizeMember(member, fallbackAgentId) {
  const m = member && typeof member === 'object' ? member : {};
  const agentId = (typeof m.agentId === 'string' && m.agentId.trim() ? m.agentId.trim() : fallbackAgentId);
  const providerId = typeof m.providerId === 'string' && m.providerId.trim()
    ? m.providerId.trim()
    : 'anthropic';
  // Command derivation precedence:
  //   1. m.command explicit AND consistent with providerId (or m.command
  //      is a custom binary outside the known set — e.g. claude-beta).
  //      Trusted as-is.
  //   2. m.command explicit BUT mismatched with providerId (operator
  //      picked Codex but command says 'claude'): auto-repair to the
  //      provider's canonical binary. This is the 2026-05-15 bug fix —
  //      existing broken team configs in SQLite get healed on the next
  //      read instead of staying silently wrong forever.
  //   3. m.command not set: derive from providerId via the canonical
  //      mapping. This is the new-team path the UI hits — CreateTeamModal
  //      sends only providerId.
  //   4. Unknown providerId: 'claude' fallback so legacy configs still
  //      spawn something rather than ENOENT-ing on an empty command.
  //
  // The 2026-05-15 "Codex selected but Claude spawned" bug: prior to
  // this fix, step 3 didn't exist — command silently defaulted to
  // 'claude' regardless of providerId. Mixed-provider teams (operator
  // picked Codex for dev, Gemini for tester) all spawned claude,
  // wasting Anthropic plan quota on agents that should have used the
  // operator's other subscriptions.
  let command;
  if (typeof m.command === 'string' && m.command.trim().length > 0) {
    const explicit = m.command.trim();
    const canonical = commandForProvider(providerId);
    if (canonical && KNOWN_COMMANDS.has(explicit) && canonical !== explicit) {
      // Both names belong to providers, but they pair up wrong. The
      // providerId is the operator's explicit choice (from the UI's
      // provider chip); the mismatched command field is almost
      // certainly a leftover from the pre-fix default-to-'claude'
      // bug. Auto-repair to the canonical pairing.
      command = canonical;
    } else {
      // Either consistent OR explicit override to a custom binary
      // outside the canonical set (e.g. a beta build path).
      command = explicit;
    }
  } else {
    command = commandForProvider(providerId) || 'claude';
  }
  return {
    agentId,
    command,
    args: Array.isArray(m.args) ? m.args.map((entry) => String(entry)) : [],
    cwd: typeof m.cwd === 'string' && m.cwd.trim() ? m.cwd.trim() : null,
    env: m.env && typeof m.env === 'object' && !Array.isArray(m.env) ? { ...m.env } : {},
    providerId,
    role: typeof m.role === 'string' && m.role.trim() ? m.role.trim() : null,
    skipPermissions: typeof m.skipPermissions === 'boolean' ? m.skipPermissions : true,
    prompt: typeof m.prompt === 'string' ? m.prompt : '',
    // Optional: path to a file whose contents are used as the launch prompt.
    // When both `prompt` and `promptPath` are set, `promptPath` wins because
    // the file is more likely to be the most-recently-edited source of truth
    // (mirrors upstream's --team-bootstrap-user-prompt-file behavior).
    promptPath: typeof m.promptPath === 'string' && m.promptPath.trim() ? m.promptPath.trim() : '',
  };
}

const VALIDATION_KIND_KEYS = Object.freeze([
  'installCommand',
  'lintCommand',
  'typecheckCommand',
  'testCommand',
  'buildCommand',
  'securityCommand',
]);

function normalizeValidation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  let any = false;
  for (const key of VALIDATION_KIND_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value.trim();
      any = true;
    }
  }
  return any ? out : null;
}

export class TeamConfig {
  constructor({ teamId, lead = {}, teammates = [], validation = null }) {
    if (typeof teamId !== 'string' || teamId.trim() === '') {
      throw new TypeError('teamId must be a non-empty string');
    }
    this.teamId = teamId.trim();
    this.lead = normalizeMember(lead, 'lead');
    this.teammates = Array.isArray(teammates)
      ? teammates.map((t, idx) => normalizeMember(t, `worker-${idx + 1}`))
      : [];
    this.validation = normalizeValidation(validation);
  }

  toJSON() {
    const json = {
      teamId: this.teamId,
      lead: { ...this.lead, env: { ...this.lead.env }, args: [...this.lead.args] },
      teammates: this.teammates.map((t) => ({ ...t, env: { ...t.env }, args: [...t.args] })),
    };
    if (this.validation) json.validation = { ...this.validation };
    return json;
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
