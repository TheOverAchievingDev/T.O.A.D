import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlitePluginResources } from '../../src/plugins/pluginResources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return { db, resources: new SqlitePluginResources({ db }) };
}

test('SqlitePluginResources.insert + listForTeam (live only)', () => {
  const { resources } = makeStore();
  resources.insert({
    teamId: 'team-a', pluginId: 'railway', kind: 'postgres',
    externalId: 'svc_abc', metadata: { region: 'us-west-2' },
  });
  const live = resources.listForTeam({ teamId: 'team-a' });
  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'postgres');
  assert.equal(live[0].externalId, 'svc_abc');
});

test('SqlitePluginResources.findLive returns the unique live resource per (team, plugin, kind)', () => {
  const { resources } = makeStore();
  resources.insert({
    teamId: 'team-a', pluginId: 'railway', kind: 'postgres', externalId: 'svc_1',
  });
  const found = resources.findLive({ teamId: 'team-a', pluginId: 'railway', kind: 'postgres' });
  assert.ok(found);
  assert.equal(found.externalId, 'svc_1');

  const notFound = resources.findLive({ teamId: 'team-a', pluginId: 'railway', kind: 'redis' });
  assert.equal(notFound, null);
});

test('SqlitePluginResources.markDeprovisioned excludes from live list', () => {
  const { resources } = makeStore();
  const r = resources.insert({
    teamId: 'team-a', pluginId: 'railway', kind: 'postgres', externalId: 'svc_x',
  });
  resources.markDeprovisioned({ resourceId: r.resourceId });
  assert.equal(resources.findLive({ teamId: 'team-a', pluginId: 'railway', kind: 'postgres' }), null);
  assert.equal(resources.listForTeam({ teamId: 'team-a' }).length, 0);
  // But the row still exists for audit purposes:
  const all = resources.listForTeam({ teamId: 'team-a', includeDeprovisioned: true });
  assert.equal(all.length, 1);
  assert.ok(all[0].deprovisionedAt);
});
