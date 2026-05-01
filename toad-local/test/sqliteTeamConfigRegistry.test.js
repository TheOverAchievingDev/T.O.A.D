import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamConfig } from '../src/team/teamConfig.js';
import { SqliteTeamConfigRegistry } from '../src/team/sqliteTeamConfigRegistry.js';

test('SqliteTeamConfigRegistry registers and retrieves a team config', () => {
  const registry = new SqliteTeamConfigRegistry();
  const config = new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead', command: 'claude', args: ['--print'] },
    teammates: [{ agentId: 'worker-1' }],
  });

  registry.registerTeam(config);
  const retrieved = registry.getTeam('team-a');

  assert.ok(retrieved);
  assert.equal(retrieved.teamId, 'team-a');
  assert.equal(retrieved.lead.command, 'claude');
  assert.deepEqual(retrieved.lead.args, ['--print']);
  assert.equal(retrieved.teammates.length, 1);
  assert.equal(retrieved.teammates[0].agentId, 'worker-1');
  registry.close();
});

test('SqliteTeamConfigRegistry getTeam returns null for unknown teamId', () => {
  const registry = new SqliteTeamConfigRegistry();
  assert.equal(registry.getTeam('nope'), null);
  registry.close();
});

test('SqliteTeamConfigRegistry registerTeam upserts on duplicate teamId (legacy parity)', () => {
  const registry = new SqliteTeamConfigRegistry();
  registry.registerTeam(new TeamConfig({ teamId: 'team-a', lead: { agentId: 'lead', prompt: 'first' } }));
  registry.registerTeam(new TeamConfig({ teamId: 'team-a', lead: { agentId: 'lead', prompt: 'second' } }));

  const retrieved = registry.getTeam('team-a');
  assert.equal(retrieved.lead.prompt, 'second');
  assert.equal(registry.listTeams().length, 1);
  registry.close();
});

test('SqliteTeamConfigRegistry listTeams returns all configs', () => {
  const registry = new SqliteTeamConfigRegistry();
  registry.registerTeam(new TeamConfig({ teamId: 'team-a' }));
  registry.registerTeam(new TeamConfig({ teamId: 'team-b' }));

  const teams = registry.listTeams().map((t) => t.teamId).sort();
  assert.deepEqual(teams, ['team-a', 'team-b']);
  registry.close();
});

test('SqliteTeamConfigRegistry deleteTeam removes the config and returns true', () => {
  const registry = new SqliteTeamConfigRegistry();
  registry.registerTeam(new TeamConfig({ teamId: 'team-a' }));

  const removed = registry.deleteTeam('team-a');
  assert.equal(removed, true);
  assert.equal(registry.getTeam('team-a'), null);
  assert.equal(registry.listTeams().length, 0);
  registry.close();
});

test('SqliteTeamConfigRegistry deleteTeam returns false when teamId is unknown', () => {
  const registry = new SqliteTeamConfigRegistry();
  assert.equal(registry.deleteTeam('ghost'), false);
  registry.close();
});

test('SqliteTeamConfigRegistry persists across two instances against the same dbPath', (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-team-cfg-'));
  const dbPath = join(tmpDir, 'toad.db');
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const a = new SqliteTeamConfigRegistry({ filePath: dbPath });
  a.registerTeam(new TeamConfig({
    teamId: 'team-persist',
    lead: { agentId: 'lead', command: 'claude', args: ['--bare'], prompt: 'be brief' },
    teammates: [{ agentId: 'worker-1', command: 'claude' }],
  }));
  a.close();

  const b = new SqliteTeamConfigRegistry({ filePath: dbPath });
  const retrieved = b.getTeam('team-persist');
  assert.ok(retrieved, 'team config must survive a registry restart');
  assert.equal(retrieved.lead.prompt, 'be brief');
  assert.deepEqual(retrieved.lead.args, ['--bare']);
  assert.equal(retrieved.teammates[0].agentId, 'worker-1');
  b.close();
});
