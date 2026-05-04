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
    { info: 1, low: 3, medium: 8, high: 15, critical: 25 });
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
