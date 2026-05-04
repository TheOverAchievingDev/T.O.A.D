import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DriftEngine } from '../../src/drift/driftEngine.js';
import { SqliteDriftStore } from '../../src/drift/driftStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function bootstrapDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  // FK requires a parent teams row before any drift insert.
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return db;
}

function makeDeps({ tasks = [], taskEvents = [], runtimeEvents = [] } = {}) {
  return {
    taskBoard: {
      listTasks: () => tasks,
      listEvents: () => taskEvents,
    },
    eventLog: {
      listEvents: () => runtimeEvents,
    },
  };
}

test('DriftEngine.runDrift returns score 0 + healthy status when no findings', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({ deps: makeDeps(), store });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.teamScore, 0);
  assert.equal(result.status, 'healthy');
  assert.equal(result.findings.length, 0);
  assert.equal(result.trigger, 'manual');
});

test('DriftEngine.runDrift produces findings for an obvious violation', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({
    deps: makeDeps({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done', integration: null }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T09:00:00Z',
          payload: { from: 'merge_ready', to: 'done' } },
      ],
    }),
    store,
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].checkName, 'check_done_without_merge_evidence');
  assert.equal(result.teamScore, 15); // high severity
  assert.equal(result.status, 'healthy'); // 15 ≤ 20

  // Persisted history grows.
  const hist = store.listScoreHistory({ teamId: 'team-a', limit: 10 });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].teamScore, 15);
});

test('DriftEngine.runDrift takes a per-team mutex (concurrent calls return same result)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({ deps: makeDeps(), store });
  const [a, b] = await Promise.all([
    engine.runDrift({ teamId: 'team-a', trigger: 'manual' }),
    engine.runDrift({ teamId: 'team-a', trigger: 'manual' }),
  ]);
  assert.equal(a.runId, b.runId, 'concurrent calls share the in-flight runId');
});

test('DriftEngine.runDrift includes last 30 history rows in the result', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({ deps: makeDeps(), store });
  for (let i = 0; i < 35; i += 1) {
    await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  }
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.history.length, 30);
});
