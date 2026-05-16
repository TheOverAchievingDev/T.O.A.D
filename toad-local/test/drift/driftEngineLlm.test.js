/**
 * DriftEngine L3 path integration tests (Slice-A un-pause).
 *
 * Exercises the engine-internal L3 path: l3Gate → buildL3Packet →
 * l3Judge (injected), per-(team,key) verdict cache, manual cache
 * bypass, periodic never-invoke, over-budget meta+skip, judge
 * failure meta-not-cached, and the §3.4 rate-cap circuit breaker.
 *
 * Harness mirrors driftEngine.test.js: in-memory SQLite +
 * SqliteDriftStore. The judge is injected via the engine's
 * `l3JudgeImpl` constructor option so no provider subprocess spawns.
 */
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

/**
 * A tier-1 check that emits ONE needsSemanticReview finding.
 *
 * IMPORTANT: the finding's taskId is `null` — mirroring the REAL
 * production whole-tree scanners (check_structural_undeclared_present
 * and observe-mode check_constitution emit taskId:null by
 * construction). This regression-locks the Fix-C boundary contract:
 * the engine MUST treat a taskId:null needsSemanticReview finding as
 * in-scope for the submission boundary under review, or the un-pause
 * is inert (gate sees [] → not_ambiguous → L3 never fires).
 */
function flaggingCheck(taskId = 'task-1') {
  return {
    name: 'check_structural_undeclared_present',
    tier: 1,
    fn: async () => [{
      id: `f_flag_${taskId}`,
      runId: '', teamId: 'team-a', taskId: null,
      category: 'architecture', severity: 'medium',
      checkName: 'check_structural_undeclared_present',
      title: 'Undeclared module present',
      expected: 'declared in spec.structure',
      actual: 'present but undeclared',
      evidence: ['src/foo.js'],
      recommendedCorrection: 'Add to spec.structure or remove',
      autoFixable: false,
      needsSemanticReview: true,
    }],
  };
}

/** Injectable judge: records calls, returns scripted verdict (or throws). */
function scriptedJudge(verdict = { findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' }) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (verdict instanceof Error) throw verdict;
    return verdict;
  };
  fn.calls = calls;
  return fn;
}

// ── periodic → L3 never invoked ───────────────────────────────────────────

test('L3: periodic trigger never invokes the judge (gate rejects periodic)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge();
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  const r = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  assert.equal(judge.calls.length, 0);
  assert.equal(r.l3.status, 'skipped:periodic');
});

// ── task_event review + flagged finding → invoke ──────────────────────────

test('L3: task_event review transition with a flagged finding invokes the judge', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({
    findings: [{
      category: 'architecture', severity: 'high',
      title: 'Confirmed structural drift',
      expected: 'declared', actual: 'undeclared',
      evidence: ['src/foo.js'], recommendedCorrection: 'declare it',
    }],
    tier: 'haiku', confidence: 'high', rawText: '{"verdict":"drift"}',
  });
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1, 'judge invoked once');
  assert.equal(r.l3.status, 'completed:haiku');
  // Judge received the plan-shaped provider object.
  const provider = judge.calls[0].provider;
  assert.equal(provider.cli, 'claude');
  assert.equal(provider.tier1, 'haiku', 'tier1 model resolved');
  assert.equal(provider.tier2, 'sonnet', 'tier2 model resolved (NOT undefined)');
  // Brief was written + cwd passed (HOME-isolation mechanics).
  assert.ok(typeof judge.calls[0].briefPath === 'string' && judge.calls[0].briefPath.endsWith('brief.md'));
  assert.ok(typeof judge.calls[0].cwd === 'string' && judge.calls[0].cwd.length > 0);
  // L3 finding stamped with check_llm_semantic + drift kind, merged in.
  const l3f = r.findings.find((f) => f.checkName === 'check_llm_semantic' && f.title === 'Confirmed structural drift');
  assert.ok(l3f, 'L3 finding present');
  assert.equal(l3f.kind, 'drift');
  assert.equal(l3f.taskId, 'task-1');
});

// ── task_event non-submission status (testing) → skip ─────────────────────

test('L3: task_event with non-submission status does NOT invoke', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge();
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'testing', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 0);
  assert.equal(r.l3.status, 'skipped:non_submission_status');
});

// ── task_event review but finding NOT flagged → skip (not_ambiguous) ──────

test('L3: review boundary with no needsSemanticReview finding skips (not_ambiguous)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge();
  const plainCheck = {
    name: 'check_done_without_merge_evidence',
    tier: 1,
    fn: async () => [{
      id: 'f_plain', runId: '', teamId: 'team-a', taskId: 'task-1',
      category: 'lifecycle', severity: 'medium',
      checkName: 'check_done_without_merge_evidence',
      title: 'plain', expected: 'x', actual: 'y',
      evidence: [], recommendedCorrection: 'z', autoFixable: false,
      needsSemanticReview: false,
    }],
  };
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [plainCheck],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 0);
  assert.equal(r.l3.status, 'skipped:not_ambiguous');
});

// ── verdict cache: second identical task_event served from cache ──────────

test('L3: verdict is cached; a second identical task_event serves from cache (no 2nd judge call)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({
    findings: [{ category: 'risk', severity: 'medium', title: 'cached one',
      expected: 'e', actual: 'a', evidence: ['x'], recommendedCorrection: 'c' }],
    tier: 'haiku', confidence: 'high', rawText: '{}',
  });
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  const r1 = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1);
  assert.equal(r1.l3.status, 'completed:haiku');

  const r2 = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1, 'no second judge call — served from cache');
  assert.equal(r2.l3.status, 'served_cached:haiku');
});

// ── manual bypasses the cache ─────────────────────────────────────────────

test('L3: manual trigger bypasses the verdict cache (re-invokes)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  const engine = new DriftEngine({
    deps: makeDeps({ tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'review' }] }),
    store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  // Seed cache via task_event.
  await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1);
  // Manual with the same boundary task — must bypass cache → re-invoke.
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'manual', boundaryTaskId: 'task-1', boundaryTo: 'review',
  });
  assert.equal(judge.calls.length, 2, 'manual re-invokes; cache bypassed');
  assert.equal(r.l3.status, 'completed:haiku');
});

// ── over-budget → meta + skip, no judge call ──────────────────────────────

test('L3: over-budget packet emits an info meta + skips (no judge call, never truncates)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge();
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0, l3PacketBudgetBytes: 8 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 0, 'no judge call when over budget');
  assert.equal(r.l3.status, 'skipped:over_budget');
  const meta = r.findings.find((f) => f.checkName === 'check_llm_semantic' && f.title.includes('over budget'));
  assert.ok(meta, 'over-budget meta finding emitted');
  assert.equal(meta.severity, 'info');
});

// ── judge failure → meta, NOT cached (retries next boundary) ──────────────

test('L3: judge failure emits a medium meta and is NOT cached (retry next boundary)', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge(new Error('spawn_failed: exit 1'));
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  const r1 = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(r1.l3.status, 'failed');
  const meta = r1.findings.find((f) => f.checkName === 'check_llm_semantic' && f.title.includes('judge failed'));
  assert.ok(meta, 'judge_failed meta emitted');
  assert.equal(meta.severity, 'medium');

  // Not cached → a second identical boundary retries (judge called again).
  const okJudge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  engine.l3JudgeImpl = okJudge;
  const r2 = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(okJudge.calls.length, 1, 'failure was not cached — judge retried');
  assert.equal(r2.l3.status, 'completed:haiku');
});

// ── §3.4 rate cap → observer meta, no judge call, not cached ──────────────

test('L3: rate cap trips → observer-severity meta, judge not called, cache untouched', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  let clock = 1_000_000;
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    now: () => clock,
    // Cap of 1/h: first invoke consumes the window, second trips the cap.
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0, l3RateCapPerHour: 1 } },
  });
  // First task_event for task-1 → invokes (window = [t0]).
  const r1 = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1);
  assert.equal(r1.l3.status, 'completed:haiku');

  // Manual for the SAME task → manual bypasses the verdict cache, so
  // we reach the rate-window check; the window is already at cap (1)
  // → circuit breaker trips before any second judge spawn.
  clock += 1000;
  const r2 = await engine.runDrift({
    teamId: 'team-a', trigger: 'manual', boundaryTaskId: 'task-1', boundaryTo: 'review',
  });
  assert.equal(judge.calls.length, 1, 'rate cap prevented a second judge spawn');
  assert.equal(r2.l3.status, 'skipped:rate_cap');
  const meta = r2.findings.find((f) => f.checkName === 'check_llm_semantic' && f.title.includes('rate cap'));
  assert.ok(meta, 'rate_cap meta emitted');
  assert.equal(meta.severity, 'observer');
});

// ── llmTierEnabled=false disables L3 ──────────────────────────────────────

test('L3: llmTierEnabled=false → skipped:disabled, judge never called', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge();
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [flaggingCheck('task-1')],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: false, periodicCooldownMs: 0 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 0);
  assert.equal(r.l3.status, 'skipped:disabled');
});

// ── result shape ──────────────────────────────────────────────────────────

test('L3: result carries l3.status, not the old llm.tier1/tier2 shape', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({
    deps: makeDeps(), store, checks: [],
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0 } },
  });
  const r = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.ok('l3' in r);
  assert.ok('status' in r.l3);
  assert.equal('llm' in r, false, 'old llm field must be gone');
  // manual with no boundary task → gate skips with no_boundary_task.
  assert.equal(r.l3.status, 'skipped:no_boundary_task');
});
