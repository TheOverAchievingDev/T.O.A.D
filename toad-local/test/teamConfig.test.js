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
