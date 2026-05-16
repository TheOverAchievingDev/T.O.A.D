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

// ── Slice B helpers ───────────────────────────────────────────────────────

/**
 * A tier-1 check that emits a NON-flagged finding (L1 not silent on
 * the task but no needsSemanticReview) — proves silent path is
 * independent of non-flagged findings.
 */
function plainCheck() {
  return { name: 'check_dep', tier: 1, fn: async () => [{
    id: 'f_plain', runId: '', teamId: 'team-a', taskId: 'task-1',
    category: 'risk', severity: 'low', checkName: 'check_dep',
    title: 'dep', expected: '', actual: '', evidence: [],
    recommendedCorrection: '', autoFixable: false, needsSemanticReview: false,
  }] };
}

/**
 * Extract the L1 signal JSON string from the packet that was passed
 * directly to l3JudgeImpl. The packet contains a section:
 *   ## The deterministic L1 signal to adjudicate
 *   ```json
 *   <json>
 *   ```
 * We extract the JSON block from that section.
 */
function readBriefL1Signal(call) {
  const packet = call.packet;
  if (typeof packet !== 'string') throw new Error('No packet in judge call');
  const marker = '## The deterministic L1 signal to adjudicate\n```json\n';
  const start = packet.indexOf(marker);
  if (start === -1) throw new Error('L1 signal section not found in packet');
  const jsonStart = start + marker.length;
  const end = packet.indexOf('\n```', jsonStart);
  if (end === -1) throw new Error('L1 signal closing ``` not found');
  return packet.slice(jsonStart, end);
}

/**
 * Build deps that inject a synthetic spec and diffsByTask via the
 * real buildSnapshot seam (existsSyncImpl / readFileSyncImpl /
 * projectCwd / worktreeManager / diffComputer).
 */
function makeDepsWithDiff(spec, diffsByTaskMap = {}) {
  const FAKE_CWD = '/fake-project-t7';
  const SPEC_PATH = `${FAKE_CWD}/docs/foundry/spec.json`;
  const specJson = JSON.stringify(spec);
  return {
    taskBoard: { listTasks: () => [], listEvents: () => [] },
    eventLog: { listEvents: () => [] },
    projectCwd: FAKE_CWD,
    existsSyncImpl: (p) => p === SPEC_PATH,
    readFileSyncImpl: (p) => {
      if (p === SPEC_PATH) return specJson;
      throw new Error(`unexpected read: ${p}`);
    },
    worktreeManager: {
      listWorktrees: () => Object.keys(diffsByTaskMap).map((taskId) => ({
        taskId, path: `${FAKE_CWD}/${taskId}`, baseRef: 'main',
      })),
    },
    diffComputer: {
      computeDiff: ({ worktreePath }) => {
        const taskId = Object.keys(diffsByTaskMap)
          .find((id) => worktreePath === `${FAKE_CWD}/${id}`);
        if (!taskId) return { files: [], diff: '', error: null };
        const entry = diffsByTaskMap[taskId];
        return { files: entry.changedFiles, diff: entry.diff, error: null };
      },
    },
  };
}

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

// ── Slice B engine integration tests ──────────────────────────────────────

test('L3 Slice B: silent path (declared+significant, NO flag) → invoke with kind silent_significant', async () => {
  const db = bootstrapDb(); const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  // 12 added lines → ≥ floor of 10
  const body = ['+++ b/src/sampler.rs', '@@ @@'].concat(
    Array.from({ length: 12 }, (_, i) => `+l${i}=1;`),
  ).join('\n');
  const spec = {
    version: 1,
    structure: { required: [{ kind: 'module', name: 's', evidence: 'src/sampler.rs' }] },
    provenance: { reviewed: true },
  };
  const engine = new DriftEngine({
    deps: makeDepsWithDiff(spec, { 'task-1': { changedFiles: ['src/sampler.rs'], diff: body } }),
    store,
    checks: [plainCheck()],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0, l3SilentMagnitudeFloor: 10 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1, 'silent path invoked the judge');
  const l1 = JSON.parse(readBriefL1Signal(judge.calls[0]));
  assert.equal(l1.kind, 'silent_significant');
  assert.ok(Array.isArray(l1.declaredFiles) && l1.declaredFiles.includes('src/sampler.rs'));
  void r;
});

test('L3 Slice B: silent + CLEAN verdict → exactly one observer silent_clean meta, not lead-bundled, not cached', async () => {
  const db = bootstrapDb(); const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  const body = ['+++ b/src/sampler.rs', '@@ @@'].concat(
    Array.from({ length: 12 }, (_, i) => `+l${i}=1;`),
  ).join('\n');
  const spec = {
    version: 1,
    structure: { required: [{ kind: 'module', name: 's', evidence: 'src/sampler.rs' }] },
    provenance: { reviewed: true },
  };
  const engine = new DriftEngine({
    deps: makeDepsWithDiff(spec, { 'task-1': { changedFiles: ['src/sampler.rs'], diff: body } }),
    store,
    checks: [plainCheck()],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0, l3SilentMagnitudeFloor: 10 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1, 'first run invoked judge');
  const cleanMetas = r.findings.filter(
    (f) => f.severity === 'observer' && /silent.?clean/i.test(f.title),
  );
  assert.equal(cleanMetas.length, 1, 'exactly one silent_clean observer meta');

  // Second identical run → served from cache (no second judge call, no new telemetry).
  const r2 = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1, 'cache served — no second judge call');
  assert.equal(r2.l3.status, 'served_cached:haiku');
  // Cache-serve must not re-emit the silent_clean observer meta.
  const cleanMetas2 = r2.findings.filter(
    (f) => f.severity === 'observer' && /silent.?clean/i.test(f.title),
  );
  assert.equal(cleanMetas2.length, 0, 'cache-serve emits no silent_clean telemetry');
});

test('L3 Slice B: periodic never computes the predicate (cheap-eligibility guard)', async () => {
  const db = bootstrapDb(); const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  // Even with a meaningful spec+diff wired, periodic must short-circuit
  // via l3CheapEligible before any predicate work.
  const body = ['+++ b/src/sampler.rs', '@@ @@'].concat(
    Array.from({ length: 12 }, (_, i) => `+l${i}=1;`),
  ).join('\n');
  const spec = {
    version: 1,
    structure: { required: [{ kind: 'module', name: 's', evidence: 'src/sampler.rs' }] },
    provenance: { reviewed: true },
  };
  // TRIPWIRE: changedFiles is a real Array (so Array.isArray() in
  // buildSnapshot passes and the reference is stored verbatim on
  // snapshot.diffsByTask['task-1'].changedFiles) whose `.some` THROWS.
  // buildSnapshot only does Array.isArray() — it never iterates the
  // array — so the snapshot builds fine on every trigger. The ONLY
  // caller that does `changedFiles.some(...)` is touchesDeclaredSurface,
  // invoked exclusively from silentButSignificant (the expensive
  // predicate). So if a regression deletes the l3CheapEligible(...)
  // cost guard — even though the gate still skips periodic — the
  // predicate WOULD run on this periodic tick and this test would
  // THROW, not merely mis-assert. The test passing is positive proof
  // the predicate was never reached on a periodic run (design §6/§7
  // cost discipline, not just the observable skip).
  const trapFiles = ['src/sampler.rs'];
  trapFiles.some = () => {
    throw new Error(
      'TRIPWIRE: silentButSignificant computed the diff predicate on a '
      + 'periodic run — the l3CheapEligible cost guard was bypassed.',
    );
  };
  const deps = {
    taskBoard: { listTasks: () => [], listEvents: () => [] },
    eventLog: { listEvents: () => [] },
    projectCwd: '/fake-project-t7-periodic',
    existsSyncImpl: (p) => p === '/fake-project-t7-periodic/docs/foundry/spec.json',
    readFileSyncImpl: (p) => {
      if (p === '/fake-project-t7-periodic/docs/foundry/spec.json') return JSON.stringify(spec);
      throw new Error(`unexpected read: ${p}`);
    },
    worktreeManager: {
      listWorktrees: () => [{
        taskId: 'task-1', path: '/fake-project-t7-periodic/task-1', baseRef: 'main',
      }],
    },
    diffComputer: {
      computeDiff: () => ({ files: trapFiles, diff: body, error: null }),
    },
  };
  const engine = new DriftEngine({
    deps,
    store,
    checks: [plainCheck()],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0, l3SilentMagnitudeFloor: 10 } },
  });
  const r = await engine.runDrift({ teamId: 'team-a', trigger: 'periodic' });
  assert.equal(r.l3.status, 'skipped:periodic');
  assert.equal(judge.calls.length, 0);
});

test('L3 Slice B: flagged precedence — when a needsSemanticReview finding exists, l1Signal.kind is flagged', async () => {
  const db = bootstrapDb(); const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  const body = ['+++ b/src/sampler.rs', '@@ @@'].concat(
    Array.from({ length: 12 }, (_, i) => `+l${i}=1;`),
  ).join('\n');
  const spec = {
    version: 1,
    structure: { required: [{ kind: 'module', name: 's', evidence: 'src/sampler.rs' }] },
    provenance: { reviewed: true },
  };
  const engine = new DriftEngine({
    deps: makeDepsWithDiff(spec, { 'task-1': { changedFiles: ['src/sampler.rs'], diff: body } }),
    store,
    checks: [flaggingCheck('task-1')],  // emits needsSemanticReview: true
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0, l3SilentMagnitudeFloor: 10 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1, 'judge invoked');
  const l1 = JSON.parse(readBriefL1Signal(judge.calls[0]));
  assert.equal(l1.kind, 'flagged', 'flagged path wins when needsSemanticReview finding present');
  void r;
});

test('L3 Slice B: declaredFiles capped at 20 with declaredFilesTotal/Truncated', async () => {
  const db = bootstrapDb(); const store = new SqliteDriftStore({ db });
  const judge = scriptedJudge({ findings: [], tier: 'haiku', confidence: 'high', rawText: '{}' });
  // 25 declared modules, each with 1 added line.
  const N = 25;
  const required = Array.from({ length: N }, (_, i) => ({
    kind: 'module', name: `m${i}`, evidence: `src/m${i}.rs`,
  }));
  const changedFiles = required.map((m) => m.evidence);
  const diffLines = changedFiles.flatMap((f) => [
    `+++ b/${f}`, '@@ @@', '+line1;',
  ]);
  const body = diffLines.join('\n');
  const spec = {
    version: 1,
    structure: { required },
    provenance: { reviewed: true },
  };
  const engine = new DriftEngine({
    deps: makeDepsWithDiff(spec, { 'task-1': { changedFiles, diff: body } }),
    store,
    checks: [],
    l3JudgeImpl: judge,
    settings: { drift: { llmTierEnabled: true, periodicCooldownMs: 0, l3SilentMagnitudeFloor: 10 } },
  });
  const r = await engine.runDrift({
    teamId: 'team-a', trigger: 'task_event',
    boundaryTo: 'review', boundaryTaskId: 'task-1',
  });
  assert.equal(judge.calls.length, 1, 'judge invoked for silent significant path');
  const l1 = JSON.parse(readBriefL1Signal(judge.calls[0]));
  assert.equal(l1.kind, 'silent_significant');
  assert.equal(l1.declaredFiles.length, 20, 'capped at 20');
  assert.equal(l1.declaredFilesTotal, 25);
  assert.equal(l1.declaredFilesTruncated, true);
  assert.ok(/showing 20 of 25/.test(l1.note), `note should mention "showing 20 of 25", got: ${l1.note}`);
  void r;
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
