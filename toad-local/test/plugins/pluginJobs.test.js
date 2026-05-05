import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlitePluginJobs } from '../../src/plugins/pluginJobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return { db, jobs: new SqlitePluginJobs({ db }) };
}

test('SqlitePluginJobs.create inserts a queued job', () => {
  const { jobs } = makeStore();
  const job = jobs.create({
    teamId: 'team-a',
    pluginId: 'railway',
    action: 'provision_db',
    args: { type: 'postgres' },
  });
  assert.ok(job.jobId);
  assert.equal(job.state, 'queued');
  assert.equal(job.teamId, 'team-a');
});

test('SqlitePluginJobs.update moves state + appends log_tail', () => {
  const { jobs } = makeStore();
  const job = jobs.create({
    teamId: 'team-a', pluginId: 'railway', action: 'x', args: {},
  });
  jobs.update({ jobId: job.jobId, state: 'running', logChunk: 'starting...\n' });
  jobs.update({ jobId: job.jobId, state: 'success', logChunk: 'done\n', finishedAt: '2026-05-04T10:00:00Z' });
  const fetched = jobs.get({ jobId: job.jobId });
  assert.equal(fetched.state, 'success');
  assert.match(fetched.logTail, /starting/);
  assert.match(fetched.logTail, /done/);
  assert.equal(fetched.finishedAt, '2026-05-04T10:00:00Z');
});

test('SqlitePluginJobs.list filters by team and state', () => {
  const { jobs } = makeStore();
  jobs.create({ teamId: 'team-a', pluginId: 'railway', action: 'a', args: {} });
  jobs.create({ teamId: 'team-a', pluginId: 'railway', action: 'b', args: {} });
  const queued = jobs.list({ teamId: 'team-a', state: 'queued' });
  assert.equal(queued.length, 2);
});

test('SqlitePluginJobs.get returns null for unknown jobId', () => {
  const { jobs } = makeStore();
  assert.equal(jobs.get({ jobId: 'nonexistent' }), null);
});

test('SqlitePluginJobs.update throws on unknown jobId', () => {
  const { jobs } = makeStore();
  assert.throws(() => jobs.update({ jobId: 'nope', state: 'running' }), /no job/);
});
