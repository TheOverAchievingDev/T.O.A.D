import test from 'node:test';
import assert from 'node:assert/strict';
import { stableFindingId } from '../../../src/drift/checks/_findingId.js';

test('stableFindingId is stable: same inputs → same id (within the same team)', () => {
  const a = stableFindingId({
    teamId: 'team-a', checkName: 'check_x', category: 'risk',
    taskId: 't-1', salient: 'same',
  });
  const b = stableFindingId({
    teamId: 'team-a', checkName: 'check_x', category: 'risk',
    taskId: 't-1', salient: 'same',
  });
  assert.equal(a, b);
});

test('stableFindingId isolates teams: same inputs but different teamId → different ids', () => {
  // Cross-team collisions used to crash recordRun because drift_findings.finding_id
  // is a table-wide primary key. Two teams producing identical-looking findings
  // (e.g. judge_failed meta-findings with the same salient text) must hash to
  // different ids.
  const a = stableFindingId({
    teamId: 'team-a', checkName: 'check_x', category: 'risk',
    taskId: null, salient: 'failed:judge_failed',
  });
  const b = stableFindingId({
    teamId: 'team-b', checkName: 'check_x', category: 'risk',
    taskId: null, salient: 'failed:judge_failed',
  });
  assert.notEqual(a, b);
});

test('stableFindingId falls back to "no-team" when teamId is missing', () => {
  // Defensive: callers should always pass teamId, but the function must not
  // throw if a check forgets — it should hash a sentinel so the UI surfaces
  // a single bucket rather than crashing the run.
  const a = stableFindingId({
    checkName: 'check_x', category: 'risk', taskId: null, salient: 'x',
  });
  const b = stableFindingId({
    teamId: '', checkName: 'check_x', category: 'risk', taskId: null, salient: 'x',
  });
  const c = stableFindingId({
    teamId: 'no-team', checkName: 'check_x', category: 'risk', taskId: null, salient: 'x',
  });
  assert.equal(a, b);
  assert.equal(a, c);
});

test('stableFindingId distinguishes checks, categories, tasks, and salients', () => {
  const base = { teamId: 't', checkName: 'c', category: 'risk', taskId: 'tk', salient: 's' };
  const id = stableFindingId(base);
  assert.notEqual(id, stableFindingId({ ...base, checkName: 'c2' }));
  assert.notEqual(id, stableFindingId({ ...base, category: 'architecture' }));
  assert.notEqual(id, stableFindingId({ ...base, taskId: 'tk2' }));
  assert.notEqual(id, stableFindingId({ ...base, salient: 's2' }));
});

test('stableFindingId result is prefixed and bounded', () => {
  const id = stableFindingId({
    teamId: 't', checkName: 'c', category: 'risk', taskId: 'tk', salient: 's',
  });
  assert.match(id, /^f_[0-9a-f]{16}$/);
});
