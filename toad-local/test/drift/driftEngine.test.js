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
  // manual (not periodic) — this asserts history WINDOWING, and under
  // the periodic-cooldown contract only manual/task_event force a
  // distinct run each call. 35 manual runs → history windowed to 30.
  for (let i = 0; i < 35; i += 1) {
    await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  }
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.history.length, 30);
});

// ── Periodic-trigger cooldown (the 2026-05-15 double-trigger fix) ──
// The backend monitor (5min) AND the UI poll (60s) both issue
// trigger:'periodic' runDrift calls. Without a guard every periodic
// call does a full whole-tree re-scan (buildSnapshot walks the
// project: scanConstitution + scanContracts) + a new persisted run.
// Only `manual` (explicit operator intent) and `task_event` (real
// activity must surface immediately) force a fresh compute; a
// `periodic` call within periodicCooldownMs of the last computed run
// returns that result unchanged.

test('periodic within cooldown returns the cached result, persists no new run', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let clock = 1_000_000;
  const engine = new DriftEngine({ deps: makeDeps(), store, now: () => clock });

  const first = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  assert.equal(store.listScoreHistory({ teamId: 'team-a', limit: 50 }).length, 1);

  clock += 60_000; // a UI 60s poll — well inside the 5min cooldown
  const second = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  assert.equal(second.runId, first.runId, 'cached run reused, not recomputed');
  assert.equal(second.cached, true);
  assert.equal(
    store.listScoreHistory({ teamId: 'team-a', limit: 50 }).length,
    1,
    'no second persisted run — the whole-tree re-scan was skipped',
  );
});

test('manual always recomputes even within the periodic cooldown', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let clock = 1_000_000;
  const engine = new DriftEngine({ deps: makeDeps(), store, now: () => clock });

  const first = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  clock += 1_000;
  const manual = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.notEqual(manual.runId, first.runId);
  assert.notEqual(manual.cached, true);
  assert.equal(store.listScoreHistory({ teamId: 'team-a', limit: 50 }).length, 2);
});

test('task_event always recomputes even within the periodic cooldown', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let clock = 1_000_000;
  const engine = new DriftEngine({ deps: makeDeps(), store, now: () => clock });

  const first = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  clock += 1_000;
  const evt = await engine.runDrift({ teamId: 'team-a', trigger: 'task_event' });
  assert.notEqual(evt.runId, first.runId, 'real lifecycle activity must surface immediately');
  assert.equal(store.listScoreHistory({ teamId: 'team-a', limit: 50 }).length, 2);
});

test('periodic recomputes once the cooldown has elapsed', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let clock = 1_000_000;
  const engine = new DriftEngine({ deps: makeDeps(), store, now: () => clock });

  const first = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  clock += 300_000 + 1; // past the 5min default cooldown
  const later = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  assert.notEqual(later.runId, first.runId);
  assert.notEqual(later.cached, true);
  assert.equal(store.listScoreHistory({ teamId: 'team-a', limit: 50 }).length, 2);
});

test('DriftEngine awaits async check.fn results', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  // Custom async check that resolves with a finding after a tick.
  const asyncCheck = {
    name: 'check_async_test',
    tier: 1,
    fn: async ({ snapshot }) => {
      await new Promise((r) => setTimeout(r, 5));
      return [{
        id: 'f_async', runId: '', teamId: snapshot.teamId,
        taskId: null, category: 'risk', severity: 'low',
        checkName: 'check_async_test', title: 'Async OK',
        expected: 'e', actual: 'a', evidence: ['ev'],
        recommendedCorrection: 'r', autoFixable: false,
      }];
    },
  };
  const engine = new DriftEngine({
    deps: makeDeps(), store, checks: [asyncCheck],
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'Async OK');
});

test('runDrift filters findings with active correctionTaskId out of score', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });

  // Manually seed one prior finding + link it (simulate operator created a correction)
  store.recordRun({
    runId: 'r0', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [{
      id: 'f_existing', taskId: 't1', category: 'lifecycle', severity: 'medium',
      checkName: 'test', title: 'still drifting', evidence: [],
      expected: 'x', actual: 'y', recommendedCorrection: 'z', autoFixable: false,
    }],
  });
  store.linkCorrection({ findingIds: ['f_existing'], correctionTaskId: 'task_active' });

  // Build a check that emits the SAME finding ID (would otherwise count toward score)
  const stableId = 'f_existing';
  const repeatCheck = {
    name: 'test_repeat',
    tier: 1,
    fn: async () => [{
      id: stableId, taskId: 't1', category: 'lifecycle', severity: 'medium',
      checkName: 'test_repeat', title: 'still drifting', evidence: [],
      expected: 'x', actual: 'y', recommendedCorrection: 'z',
    }],
  };

  const engine = new DriftEngine({
    deps: makeDeps(), store, checks: [repeatCheck],
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });

  // Score should be 0 (the only finding is suppressed)
  assert.equal(result.teamScore, 0);
  // But the finding should still appear in result.findings (UI needs to render in-progress badge)
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].correctionTaskId, 'task_active');
});

test('runDrift calls reapResolvedCorrections with deps.taskBoard each run', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });

  // Seed a linked finding whose correction task is "done"
  store.recordRun({
    runId: 'r0', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [{
      id: 'f_to_reap', taskId: 't1', category: 'lifecycle', severity: 'medium',
      checkName: 'test', title: 'old', evidence: [],
      expected: 'x', actual: 'y', recommendedCorrection: 'z', autoFixable: false,
    }],
  });
  store.linkCorrection({ findingIds: ['f_to_reap'], correctionTaskId: 'task_done' });

  // taskBoard reports the linked task as done
  const deps = {
    ...makeDeps(),
    taskBoard: {
      listTasks: () => [],
      listEvents: () => [],
      getTask: ({ taskId }) => taskId === 'task_done' ? { taskId, status: 'done' } : null,
    },
  };

  // Engine runs with no checks (so result.findings is empty after recordRun's wholesale-replace)
  const engine = new DriftEngine({
    deps, store, checks: [],
  });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });

  // After the run, the linkage should have been reaped
  const linkagesAfter = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(linkagesAfter.size, 0, 'reap should have cleared the done-task linkage');
});

test('DriftEngine.runDrift bails early with reason="no_team_config" when team has no config', async () => {
  // 2026-05-15 regression: UI cached a stale teamId across a project
  // switch (different SQLite DB). drift_run fired against a teamId
  // the new DB had never heard of. The pre-fix engine ran checks
  // anyway against an empty snapshot, produced 0 findings, then hit
  // an FK constraint when persisting "healthy" results to a team_id
  // with no parent row in the teams table. The new behavior: bail
  // before any check runs, return an explicit "no_team_config"
  // result so callers know to clear their stale state instead of
  // treating the empty result as a healthy team.
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  // teamConfigRegistry that returns null for the requested team —
  // simulates the post-project-switch state where the team_id
  // exists in UI memory but not in the new project's DB.
  const teamConfigRegistry = {
    getTeam: (teamId) => null,
  };
  const deps = { ...makeDeps(), teamConfigRegistry };
  const engine = new DriftEngine({ deps, store, checks: [] });

  const result = await engine.runDrift({ teamId: 'ghost-team', trigger: 'manual' });

  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'no_team_config');
  assert.equal(result.teamId, 'ghost-team');
  assert.equal(result.teamScore, 0);
  assert.deepEqual(result.findings, []);
  assert.match(result.message, /stale UI state|no config/);
  // Nothing was persisted (no FK violation, no spurious history row).
  const rows = db.prepare('SELECT COUNT(*) AS n FROM drift_score_history WHERE team_id = ?').get('ghost-team');
  assert.equal(rows.n, 0, 'no score history should be recorded for an unknown team');
});

test('DriftEngine.runDrift runs normally when teamConfigRegistry resolves the team (back-compat)', async () => {
  // The early-bail check only fires when teamConfigRegistry is wired
  // AND returns null. When the registry resolves the team, drift
  // proceeds as it always did. Belt-and-suspenders against the
  // bail accidentally short-circuiting healthy paths.
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const teamConfigRegistry = {
    getTeam: (teamId) => (teamId === 'team-a' ? { teamId, lead: { agentId: 'lead' } } : null),
  };
  const deps = { ...makeDeps(), teamConfigRegistry };
  const engine = new DriftEngine({ deps, store, checks: [] });

  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });

  assert.equal(result.status, 'healthy', 'real teams should run to completion');
  assert.notEqual(result.reason, 'no_team_config');
});

test('DriftEngine.runDrift runs normally when teamConfigRegistry is not wired into deps (legacy callers)', async () => {
  // Older deployments / test harnesses that don't pass
  // teamConfigRegistry should still work — the early-bail check
  // only fires when the registry is present.
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  // deps WITHOUT teamConfigRegistry — original test pattern.
  const engine = new DriftEngine({ deps: makeDeps(), store, checks: [] });

  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.status, 'healthy');
  assert.notEqual(result.reason, 'no_team_config');
});
