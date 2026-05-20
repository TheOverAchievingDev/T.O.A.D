import test from 'node:test';
import assert from 'node:assert/strict';
import { TeamConfigRegistry, TeamConfig } from '../src/team/teamConfig.js';

test('TeamConfig initializes with basic properties', () => {
  const config = new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead', prompt: 'You are the lead' },
    teammates: [
      { agentId: 'worker-1', prompt: 'You are a worker' }
    ]
  });

  assert.equal(config.teamId, 'team-a');
  assert.equal(config.lead.agentId, 'lead');
  assert.equal(config.lead.prompt, 'You are the lead');
  assert.equal(config.teammates.length, 1);
  assert.equal(config.teammates[0].agentId, 'worker-1');
});

test('TeamConfig default values', () => {
  const config = new TeamConfig({
    teamId: 'team-b'
  });

  assert.equal(config.teamId, 'team-b');
  assert.equal(config.lead.agentId, 'lead');
  assert.equal(typeof config.lead.prompt, 'string');
  assert.ok(Array.isArray(config.teammates));
  assert.equal(config.teammates.length, 0);
});

test('TeamConfigRegistry manages team configurations', () => {
  const registry = new TeamConfigRegistry();
  
  const config = new TeamConfig({
    teamId: 'team-b',
    lead: { agentId: 'lead', prompt: 'Lead B' }
  });

  registry.registerTeam(config);

  const retrieved = registry.getTeam('team-b');
  assert.ok(retrieved);
  assert.equal(retrieved.teamId, 'team-b');

  const all = registry.listTeams();
  assert.equal(all.length, 1);
  assert.equal(all[0].teamId, 'team-b');
});

test('TeamConfigRegistry throws when registering duplicate teamId', () => {
  const registry = new TeamConfigRegistry();
  const config = new TeamConfig({ teamId: 'team-c' });
  registry.registerTeam(config);

  assert.throws(() => registry.registerTeam(config), /Duplicate teamId: team-c/);
});

test('TeamConfigRegistry returns null for unknown teamId', () => {
  const registry = new TeamConfigRegistry();
  assert.equal(registry.getTeam('unknown'), null);
});

test('TeamConfig members carry launch fields with sensible defaults', () => {
  // providerId uses the canonical id ('anthropic') not the CLI binary
  // name. The 2026-05-15 fix tightened normalizeMember so this
  // distinction matters — see providerCommands.js for the mapping.
  const config = new TeamConfig({
    teamId: 'team-launch',
    lead: { agentId: 'lead', command: 'claude', args: ['--print'], cwd: 'C:\\proj', env: { K: 'v' }, providerId: 'anthropic', prompt: 'sys' },
    teammates: [
      { agentId: 'worker-1' },
    ],
  });

  assert.equal(config.lead.command, 'claude');
  assert.deepEqual(config.lead.args, ['--print']);
  assert.equal(config.lead.cwd, 'C:\\proj');
  assert.deepEqual(config.lead.env, { K: 'v' });
  assert.equal(config.lead.providerId, 'anthropic');
  assert.equal(config.lead.prompt, 'sys');

  // Teammate defaults: missing providerId now resolves to the
  // canonical 'anthropic' (was the literal 'claude' before the fix —
  // see "providerId defaults to anthropic when missing" test).
  // command falls through to 'claude' since providerId='anthropic'.
  assert.equal(config.teammates[0].command, 'claude');
  assert.deepEqual(config.teammates[0].args, []);
  assert.equal(config.teammates[0].cwd, null);
  assert.deepEqual(config.teammates[0].env, {});
  assert.equal(config.teammates[0].providerId, 'anthropic');
  assert.equal(config.teammates[0].prompt, '');
  assert.equal(config.teammates[0].systemPromptAppend, '');
});

test('TeamConfig persists validation commands when provided', () => {
  const config = new TeamConfig({
    teamId: 'team-validate',
    lead: { agentId: 'lead' },
    validation: {
      installCommand: 'npm.cmd install',
      lintCommand: 'npm.cmd run lint',
      typecheckCommand: null,
      testCommand: 'npm.cmd test',
      buildCommand: 'npm.cmd run build',
    },
  });
  assert.equal(config.validation.installCommand, 'npm.cmd install');
  assert.equal(config.validation.lintCommand, 'npm.cmd run lint');
  assert.equal(config.validation.testCommand, 'npm.cmd test');
  assert.equal(config.validation.buildCommand, 'npm.cmd run build');
  // null is normalized away (not preserved as a key)
  assert.equal(config.validation.typecheckCommand, undefined);
  // toJSON round-trips
  const json = config.toJSON();
  assert.equal(json.validation.installCommand, 'npm.cmd install');
});

test('TeamConfig validation defaults to null when not provided', () => {
  const config = new TeamConfig({ teamId: 'team-no-val' });
  assert.equal(config.validation, null);
});

test('TeamConfig coerces malformed args/env into defaults', () => {
  const config = new TeamConfig({
    teamId: 'team-malformed',
    lead: { agentId: 'lead', args: 'not-an-array', env: 'not-an-object' },
  });
  assert.deepEqual(config.lead.args, []);
  assert.deepEqual(config.lead.env, {});
});

test('TeamConfig derives command from providerId when command is not explicitly set (2026-05-15 fix)', () => {
  // The CreateTeamModal only sends providerId — it doesn't know about
  // CLI binaries. Prior to this fix, command defaulted to 'claude'
  // regardless of provider choice, so a "Codex developer" silently
  // spawned the claude binary. Now command is derived from providerId
  // via the canonical mapping.
  const config = new TeamConfig({
    teamId: 'team-mixed',
    lead: { agentId: 'lead', providerId: 'anthropic' },
    teammates: [
      { agentId: 'dev',    role: 'developer', providerId: 'openai' },
      { agentId: 'tester', role: 'tester',    providerId: 'gemini' },
      { agentId: 'arch',   role: 'architect', providerId: 'opencode' },
    ],
  });
  assert.equal(config.lead.command, 'claude');
  assert.equal(config.teammates[0].command, 'codex',  'openai → codex');
  assert.equal(config.teammates[1].command, 'gemini', 'gemini → gemini');
  assert.equal(config.teammates[2].command, 'opencode', 'opencode → opencode');
});

test('TeamConfig auto-repairs a mismatched (providerId, command) pair (heals legacy broken configs on read)', () => {
  // The pre-fix bug saved configs like { providerId:"openai",
  // command:"claude" } to SQLite — every read of those configs spawns
  // the wrong binary forever. Now: when both fields name known
  // providers but they pair up wrong, providerId wins and command is
  // auto-corrected at normalize time. Users don't have to recreate
  // their teams; existing SQLite-persisted configs heal on next load.
  const config = new TeamConfig({
    teamId: 'team-broken-saved',
    lead: { agentId: 'lead', providerId: 'anthropic', command: 'claude' },
    teammates: [
      // Saved by the buggy CreateTeam flow: dev was supposed to be Codex.
      { agentId: 'dev', role: 'developer', providerId: 'openai', command: 'claude' },
    ],
  });
  assert.equal(config.lead.command, 'claude', 'consistent pair left alone');
  assert.equal(config.teammates[0].command, 'codex', 'mismatched pair healed to canonical');
  assert.equal(config.teammates[0].providerId, 'openai', 'providerId is preserved');
});

test('TeamConfig preserves a custom command outside the canonical set (e.g. claude-beta binary path)', () => {
  const config = new TeamConfig({
    teamId: 'team-custom',
    lead: { agentId: 'lead', providerId: 'anthropic', command: '/opt/claude-beta/bin/claude' },
  });
  assert.equal(config.lead.command, '/opt/claude-beta/bin/claude');
});

test('TeamConfig providerId defaults to anthropic when missing (was "claude" which is not a real providerId)', () => {
  // Legacy fix: the prior default was the literal string 'claude' for
  // providerId, which then collided with the CLI command name and
  // confused downstream code that tried to look up provider metadata.
  // Now the default is the canonical providerId 'anthropic'.
  const config = new TeamConfig({
    teamId: 'team-legacy',
    lead: { agentId: 'lead' },
  });
  assert.equal(config.lead.providerId, 'anthropic');
  assert.equal(config.lead.command, 'claude');
});

test('TeamConfig preserves systemPromptAppend for per-agent skill injection', () => {
  const config = new TeamConfig({
    teamId: 'team-skills',
    lead: { agentId: 'lead', systemPromptAppend: 'Lead skill: enforce DRY across all modules.' },
    teammates: [
      { agentId: 'dev', role: 'developer', systemPromptAppend: 'Dev skill: always use async/await for I/O.' },
      { agentId: 'rev', role: 'reviewer', systemPromptAppend: '' },
    ],
  });
  assert.equal(config.lead.systemPromptAppend, 'Lead skill: enforce DRY across all modules.');
  assert.equal(config.teammates[0].systemPromptAppend, 'Dev skill: always use async/await for I/O.');
  assert.equal(config.teammates[1].systemPromptAppend, '');
  // toJSON round-trips
  const json = config.toJSON();
  assert.equal(json.lead.systemPromptAppend, 'Lead skill: enforce DRY across all modules.');
  assert.equal(json.teammates[0].systemPromptAppend, 'Dev skill: always use async/await for I/O.');
});