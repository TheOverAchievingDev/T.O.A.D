import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_LIFECYCLE,
  ALLOWED_TRANSITIONS,
  validateTaskStatusTransition,
} from '../src/task/taskLifecycle.js';

test('TASK_LIFECYCLE exposes the 10 checklist states', () => {
  const expected = [
    'backlog',
    'ready',
    'planned',
    'in_progress',
    'review',
    'testing',
    'merge_ready',
    'blocked',
    'done',
    'rejected',
  ].sort();
  const actual = Object.values(TASK_LIFECYCLE).sort();
  assert.deepEqual(actual, expected);
});

test('initial transition (from null) accepts known statuses, rejects unknown', () => {
  assert.equal(validateTaskStatusTransition({ from: null, to: 'backlog' }).ok, true);
  assert.equal(validateTaskStatusTransition({ from: null, to: 'in_progress' }).ok, true);
  assert.equal(validateTaskStatusTransition({ from: null, to: 'pending' }).ok, true);
  const bad = validateTaskStatusTransition({ from: null, to: 'lalala' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unknown.*lalala/i);
});

test('same-state self-transitions are allowed (idempotent)', () => {
  assert.equal(validateTaskStatusTransition({ from: 'in_progress', to: 'in_progress' }).ok, true);
  assert.equal(validateTaskStatusTransition({ from: 'done', to: 'done' }).ok, true);
});

test('canonical 10-state transitions are allowed', () => {
  const happyPath = [
    ['backlog', 'ready'],
    ['ready', 'planned'],
    ['planned', 'in_progress'],
    ['in_progress', 'review'],
    ['review', 'testing'],
    ['testing', 'merge_ready'],
    ['merge_ready', 'done'],
  ];
  for (const [from, to] of happyPath) {
    const result = validateTaskStatusTransition({ from, to });
    assert.equal(result.ok, true, `${from} → ${to}: ${result.reason || ''}`);
  }
});

test('illegal forward transitions are rejected with a reason', () => {
  const illegal = [
    ['backlog', 'in_progress'],
    ['ready', 'done'],
    ['planned', 'merge_ready'],
    ['done', 'in_progress'],     // terminal
    ['done', 'review'],
    ['merge_ready', 'review'],
    ['rejected', 'in_progress'],
  ];
  for (const [from, to] of illegal) {
    const result = validateTaskStatusTransition({ from, to });
    assert.equal(result.ok, false, `expected ${from} → ${to} to be rejected`);
    assert.match(result.reason, new RegExp(`${from}.*${to}|not an allowed transition`));
  }
});

test('legacy aliases bridge to the new lifecycle without rewriting existing call sites', () => {
  // pending → in_progress (existing taskBoard.test happy path)
  assert.equal(validateTaskStatusTransition({ from: 'pending', to: 'in_progress' }).ok, true);
  // pending → completed (existing taskBoard.test direct-finish path)
  assert.equal(validateTaskStatusTransition({ from: 'pending', to: 'completed' }).ok, true);
  // in_progress → completed (legacy direct finish — bridge)
  assert.equal(validateTaskStatusTransition({ from: 'in_progress', to: 'completed' }).ok, true);
  // deleted → backlog (legacy reopen)
  assert.equal(validateTaskStatusTransition({ from: 'deleted', to: 'backlog' }).ok, true);
});

test('legacy completed is terminal (no forward moves)', () => {
  assert.equal(validateTaskStatusTransition({ from: 'completed', to: 'in_progress' }).ok, false);
  assert.equal(validateTaskStatusTransition({ from: 'completed', to: 'done' }).ok, false);
  assert.equal(validateTaskStatusTransition({ from: 'completed', to: 'review' }).ok, false);
});

test('ALLOWED_TRANSITIONS table includes both 10-state and legacy keys', () => {
  for (const k of ['backlog', 'ready', 'planned', 'in_progress', 'review', 'testing', 'merge_ready', 'blocked', 'done', 'rejected']) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[k]), `expected key ${k}`);
  }
  for (const k of ['pending', 'completed', 'deleted']) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[k]), `expected legacy key ${k}`);
  }
});

// --- per-transition role guards ---

test('merge_ready → done is restricted to lead / human', () => {
  for (const role of ['lead', 'human']) {
    assert.equal(validateTaskStatusTransition({ from: 'merge_ready', to: 'done', role }).ok, true);
  }
  for (const role of ['developer', 'reviewer', 'tester', 'architect']) {
    const r = validateTaskStatusTransition({ from: 'merge_ready', to: 'done', role });
    assert.equal(r.ok, false, `expected ${role} to be rejected`);
    assert.match(r.reason, /role .*cannot/i);
  }
});

test('rejected → backlog is restricted to architect / lead / human', () => {
  for (const role of ['architect', 'lead', 'human']) {
    assert.equal(validateTaskStatusTransition({ from: 'rejected', to: 'backlog', role }).ok, true);
  }
  for (const role of ['developer', 'reviewer', 'tester']) {
    const r = validateTaskStatusTransition({ from: 'rejected', to: 'backlog', role });
    assert.equal(r.ok, false, `expected ${role} to be rejected`);
  }
});

test('blocked → ready/planned/in_progress is restricted to architect / lead / human', () => {
  for (const target of ['ready', 'planned', 'in_progress']) {
    for (const role of ['architect', 'lead', 'human']) {
      assert.equal(validateTaskStatusTransition({ from: 'blocked', to: target, role }).ok, true);
    }
    for (const role of ['developer', 'reviewer', 'tester']) {
      const r = validateTaskStatusTransition({ from: 'blocked', to: target, role });
      assert.equal(r.ok, false, `expected ${role} to be rejected for blocked → ${target}`);
    }
  }
});

test('unguarded transitions accept any role', () => {
  // ready → planned has no role guard; every role can do it
  for (const role of ['developer', 'reviewer', 'tester', 'architect', 'lead', 'human']) {
    assert.equal(validateTaskStatusTransition({ from: 'ready', to: 'planned', role }).ok, true);
  }
  // in_progress → review same
  for (const role of ['developer', 'reviewer', 'tester', 'architect', 'lead', 'human']) {
    assert.equal(validateTaskStatusTransition({ from: 'in_progress', to: 'review', role }).ok, true);
  }
});

test('missing role keeps backward compatibility (legacy call sites without role tagging)', () => {
  // No role provided — should not block guarded transitions
  assert.equal(validateTaskStatusTransition({ from: 'merge_ready', to: 'done' }).ok, true);
  assert.equal(validateTaskStatusTransition({ from: 'blocked', to: 'in_progress' }).ok, true);
  assert.equal(validateTaskStatusTransition({ from: 'rejected', to: 'backlog' }).ok, true);
});

test('role guard does not bypass the state-machine table — illegal moves still rejected even for lead', () => {
  // Even lead/human cannot do an illegal transition like done → in_progress
  for (const role of ['lead', 'human']) {
    const r = validateTaskStatusTransition({ from: 'done', to: 'in_progress', role });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not an allowed transition/);
  }
});
