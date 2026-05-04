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

function makeDeps() {
  return {
    taskBoard: { listTasks: () => [], listEvents: () => [] },
    eventLog: { listEvents: () => [] },
  };
}

function tier1HighFinding() {
  return {
    id: 'f_tier1_high', runId: '', teamId: 'team-a', taskId: null,
    category: 'architecture', severity: 'critical',
    checkName: 'check_llm_semantic_t1',
    title: 'Tier-1 found something nasty',
    expected: 'e', actual: 'a', evidence: ['ev'],
    recommendedCorrection: 'r', autoFixable: false,
  };
}

test('DriftEngine: tier 2 skipped when score below threshold', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [
      { name: 'check_t1_empty', tier: 1, fn: async () => [] },
      { name: 'check_t2_should_not_run', tier: 2, fn: async () => {
        throw new Error('tier 2 should not run');
      } },
    ],
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.llm.tier1, 'completed');
  assert.equal(result.llm.tier2, 'skipped:below_threshold');
});

test('DriftEngine: tier 2 runs when tier-1 score >= threshold', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let tier2Called = false;
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [
      // 3 highs (15×3=45) crosses threshold 41
      { name: 'check_t1', tier: 1, fn: async () => [
        { ...tier1HighFinding(), id: 'a', severity: 'high', title: 'a' },
        { ...tier1HighFinding(), id: 'b', severity: 'high', title: 'b' },
        { ...tier1HighFinding(), id: 'c', severity: 'high', title: 'c' },
      ] },
      { name: 'check_t2', tier: 2, fn: async () => {
        tier2Called = true;
        return [];
      } },
    ],
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(tier2Called, true, 'tier 2 should have run');
  assert.equal(result.llm.tier2, 'completed');
});

test('DriftEngine: tier 2 cooldown suppresses re-run within window', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let tier2Calls = 0;
  const checks = [
    { name: 'check_t1', tier: 1, fn: async () => [
      { ...tier1HighFinding(), id: 'a', severity: 'high', title: 'a' },
      { ...tier1HighFinding(), id: 'b', severity: 'high', title: 'b' },
      { ...tier1HighFinding(), id: 'c', severity: 'high', title: 'c' },
    ] },
    { name: 'check_t2', tier: 2, fn: async () => { tier2Calls += 1; return []; } },
  ];
  const engine = new DriftEngine({
    deps: makeDeps(), store, checks,
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' }); // immediately
  assert.equal(tier2Calls, 1, 'second run within cooldown should be skipped');
});

test('DriftEngine: tier 2 failure surfaces in result.llm.tier2', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [
      { name: 'check_t1', tier: 1, fn: async () => [
        { ...tier1HighFinding(), id: 'a', severity: 'high', title: 'a' },
        { ...tier1HighFinding(), id: 'b', severity: 'high', title: 'b' },
        { ...tier1HighFinding(), id: 'c', severity: 'high', title: 'c' },
      ] },
      { name: 'check_t2', tier: 2, fn: async () => {
        throw new Error('opus quota exhausted');
      } },
    ],
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.ok(typeof result.llm.tier2 === 'object');
  assert.ok(result.llm.tier2.failed);
  assert.match(result.llm.tier2.failed, /opus quota/);
});

test('DriftEngine: llmTierEnabled=false skips both LLM tiers', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let t1Called = false; let t2Called = false;
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [
      { name: 'check_llm_semantic_t1', tier: 1, fn: async () => { t1Called = true; return []; } },
      { name: 'check_llm_semantic_t2', tier: 2, fn: async () => { t2Called = true; return []; } },
    ],
    settings: { drift: { llmTierEnabled: false, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(t1Called, false);
  assert.equal(t2Called, false);
});
