import test from 'node:test';
import assert from 'node:assert/strict';
import { escalationGate } from '../../../src/drift/llm/escalationGate.js';

const BASE = {
  threshold: 41,
  cooldownMs: 300_000,
  scoreDelta: 10,
  now: 1_700_000_000_000,
};

test('escalationGate: below threshold → no escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 30, lastT2RunAt: null, lastT2Score: null,
  });
  assert.equal(result.escalate, false);
  assert.equal(result.reason, 'below_threshold');
});

test('escalationGate: above threshold + no prior run → escalate (first_time)', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 50, lastT2RunAt: null, lastT2Score: null,
  });
  assert.equal(result.escalate, true);
  assert.equal(result.reason, 'first_time');
});

test('escalationGate: above threshold + within cooldown → no escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 50,
    lastT2RunAt: BASE.now - 60_000, // 1 min ago, cooldown is 5 min
    lastT2Score: 50,
  });
  assert.equal(result.escalate, false);
  assert.equal(result.reason, 'cooldown');
});

test('escalationGate: above threshold + cooldown expired + score-delta sufficient → escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 65,
    lastT2RunAt: BASE.now - 600_000, // 10 min ago
    lastT2Score: 50, // delta = 15, threshold delta = 10
  });
  assert.equal(result.escalate, true);
  assert.equal(result.reason, 'score_delta');
});

test('escalationGate: above threshold + cooldown expired + score-delta too small → no escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 53,
    lastT2RunAt: BASE.now - 600_000,
    lastT2Score: 50, // delta = 3, threshold delta = 10
  });
  assert.equal(result.escalate, false);
  assert.equal(result.reason, 'no_material_change');
});

test('escalationGate: above threshold + lastT2Score missing treated as 0 → escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 50,
    lastT2RunAt: BASE.now - 600_000,
    lastT2Score: null, // counts as 0; delta = 50, threshold = 10
  });
  assert.equal(result.escalate, true);
  assert.equal(result.reason, 'score_delta');
});

test('escalationGate: exactly at threshold escalates', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 41, lastT2RunAt: null, lastT2Score: null,
  });
  assert.equal(result.escalate, true);
});
