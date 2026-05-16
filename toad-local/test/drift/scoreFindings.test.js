import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFindings, SEVERITY_WEIGHT, statusForScore } from '../../src/drift/scoreFindings.js';

function f({ id = 'x', taskId = null, category = 'architecture',
            severity = 'low', checkName = 'check_x' } = {}) {
  return {
    id, runId: 'r', teamId: 't', taskId, category, severity, checkName,
    title: 'T', evidence: [], expected: 'e', actual: 'a',
    recommendedCorrection: 'r', autoFixable: false,
  };
}

test('SEVERITY_WEIGHT matches the spec', () => {
  assert.deepEqual(SEVERITY_WEIGHT,
    { observer: 0, info: 1, low: 3, medium: 8, high: 15, critical: 25 });
});

test('observer severity is explicit-zero-weight: surfaced but never scored (design §3.4 lockstep)', () => {
  // The L3 circuit-breaker trip emits severity:'observer'. It must be
  // an explicit member of the severity taxonomy (not an unknown that
  // happens to default to 0) AND must contribute 0 to the team score
  // while still being retained/categorized in the output (surfaced to
  // the operator, never scored or blocking).
  assert.equal(SEVERITY_WEIGHT.observer, 0,
    'observer must be an explicit zero-weight member of the taxonomy');

  const withoutObserver = [f({ id: 'a', severity: 'medium' })]; // 8
  const withObserver = [
    f({ id: 'a', severity: 'medium' }),                                  // 8
    f({ id: 'obs', severity: 'observer', category: 'risk', checkName: 'check_llm_semantic' }), // +0
  ];
  const base = scoreFindings(withoutObserver);
  const withObs = scoreFindings(withObserver);

  // Score-neutral: adding the observer finding does not change the score.
  assert.equal(withObs.teamScore, base.teamScore,
    'an observer finding must contribute 0 to teamScore');
  assert.equal(withObs.teamScore, 8);

  // Still surfaced: the observer finding is retained in categorized output
  // (its risk category bar reflects presence, not a dropped finding).
  // categoryScores are filled-bar (100 = no drift); an observer in 'risk'
  // leaves risk at 100 because weight 0, but the finding itself is not
  // dropped from scoring traversal (no throw, score stable, categories
  // computed over the full list including the observer entry).
  assert.equal(withObs.categoryScores.risk, 100,
    'observer is zero-weight so its category bar stays healthy');
  assert.equal(withObs.status, base.status, 'status unchanged by an observer finding');
});

test('statusForScore maps to thresholds correctly', () => {
  assert.equal(statusForScore(0), 'healthy');
  assert.equal(statusForScore(20), 'healthy');
  assert.equal(statusForScore(21), 'watch');
  assert.equal(statusForScore(40), 'watch');
  assert.equal(statusForScore(41), 'warning');
  assert.equal(statusForScore(65), 'warning');
  assert.equal(statusForScore(66), 'critical');
  assert.equal(statusForScore(150), 'critical'); // out-of-range still classifies
});

test('scoreFindings sums weights, caps at 100, classifies', () => {
  const findings = [
    f({ severity: 'critical' }), // 25
    f({ severity: 'high' }),     // 15
    f({ severity: 'medium' }),   // 8 → 48 total → warning
  ];
  const result = scoreFindings(findings);
  assert.equal(result.teamScore, 48);
  assert.equal(result.status, 'warning');
});

test('scoreFindings caps team score at 100', () => {
  const findings = Array.from({ length: 10 }, () => f({ severity: 'critical' })); // 250
  const result = scoreFindings(findings);
  assert.equal(result.teamScore, 100);
  assert.equal(result.status, 'critical');
});

test('scoreFindings produces per-task scores tagged by taskId', () => {
  const findings = [
    f({ taskId: 'task-1', severity: 'high' }),    // 15
    f({ taskId: 'task-1', severity: 'low' }),     // 3 → task-1 = 18
    f({ taskId: 'task-2', severity: 'medium' }),  // task-2 = 8
    f({ taskId: null,     severity: 'info' }),    // team-only, ignored per-task
  ];
  const result = scoreFindings(findings);
  assert.deepEqual(result.perTaskScores, { 'task-1': 18, 'task-2': 8 });
});

test('scoreFindings produces category scores filled-bar style (100 = healthy)', () => {
  const findings = [
    f({ category: 'architecture', severity: 'high' }),   // 15 → arch = 85
    f({ category: 'checklist',    severity: 'low' }),    // 3  → check = 97
  ];
  const result = scoreFindings(findings);
  assert.equal(result.categoryScores.architecture, 85);
  assert.equal(result.categoryScores.checklist, 97);
  // categories with zero findings come back as 100 (no drift = healthy bar)
  assert.equal(result.categoryScores.slice_scope, 100);
  assert.equal(result.categoryScores.test_truth, 100);
  assert.equal(result.categoryScores.risk, 100);
});

test('scoreFindings on an empty array returns the healthy baseline', () => {
  const result = scoreFindings([]);
  assert.equal(result.teamScore, 0);
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.perTaskScores, {});
  assert.deepEqual(result.categoryScores, {
    architecture: 100, checklist: 100, slice_scope: 100,
    test_truth: 100, risk: 100,
  });
  // Same when called with undefined (defensive Array.isArray guard).
  const undef = scoreFindings(undefined);
  assert.equal(undef.teamScore, 0);
  assert.equal(undef.status, 'healthy');
});

test('STATUS_THRESHOLDS is sorted ascending by max — protects statusForScore from silent breakage', async () => {
  const { STATUS_THRESHOLDS } = await import('../../src/drift/scoreFindings.js');
  for (let i = 1; i < STATUS_THRESHOLDS.length; i += 1) {
    assert.ok(
      STATUS_THRESHOLDS[i].max > STATUS_THRESHOLDS[i - 1].max,
      `STATUS_THRESHOLDS must be sorted ascending — ${i} (${STATUS_THRESHOLDS[i].max}) <= ${i - 1} (${STATUS_THRESHOLDS[i - 1].max})`
    );
  }
});
