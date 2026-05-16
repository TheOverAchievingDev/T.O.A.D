import test from 'node:test';
import assert from 'node:assert/strict';
import { buildL3Packet, L3_PACKET_BUDGET_BYTES } from '../../../src/drift/llm/buildL3Packet.js';

const SNAP = {
  teamId: 't',
  spec: { version: 1, provenance: { reviewed: true }, constitution: { rules: [{ id: 'r' }] } },
  diffsByTask: {
    'T-1': { changedFiles: ['src/a.rs'], diff: 'diff --git a/src/a.rs\n+fn x() {}\n', error: null },
  },
};
const SIGNAL = { kind: 'flagged', finding: { checkName: 'check_constitution', title: 'rule obs', file: 'src/a.rs', line: 1 } };

test('packet contains the task diff, the whole spec.json, and the L1 signal — no prose docs', () => {
  const r = buildL3Packet({ snapshot: SNAP, boundaryTaskId: 'T-1', l1Signal: SIGNAL });
  assert.ok(!r.overBudget);
  assert.match(r.packet, /src\/a\.rs/);
  assert.match(r.packet, /"version": ?1|"version":1/);
  assert.match(r.packet, /check_constitution|rule obs/);
  assert.doesNotMatch(r.packet, /foundryDocs|## Foundry docs|product-brief/);
});

test('default budget is 32 KB and is exported', () => {
  assert.equal(L3_PACKET_BUDGET_BYTES, 32 * 1024);
});

test('over-budget task → overBudget signal, NOT a truncated packet', () => {
  const huge = 'x'.repeat(40 * 1024);
  const snap = { ...SNAP, diffsByTask: { 'T-1': { changedFiles: ['big.rs'], diff: huge, error: null } } };
  const r = buildL3Packet({ snapshot: snap, boundaryTaskId: 'T-1', l1Signal: SIGNAL });
  assert.equal(r.overBudget, true);
  assert.equal(typeof r.bytes, 'number');
  assert.ok(r.bytes > L3_PACKET_BUDGET_BYTES);
  assert.equal(r.packet, undefined, 'must NOT return a truncated packet');
});

test('missing diff for the task → still builds (spec + signal), not over budget', () => {
  const r = buildL3Packet({ snapshot: { ...SNAP, diffsByTask: {} }, boundaryTaskId: 'T-1', l1Signal: SIGNAL });
  assert.ok(!r.overBudget);
  assert.match(r.packet, /\(no diff/i);
});

test('configurable budget override is honored', () => {
  const r = buildL3Packet({ snapshot: SNAP, boundaryTaskId: 'T-1', l1Signal: SIGNAL, budgetBytes: 10 });
  assert.equal(r.overBudget, true);
});
