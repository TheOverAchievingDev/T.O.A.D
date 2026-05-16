import test from 'node:test';
import assert from 'node:assert/strict';
import { findingTier } from './findingTier.ts';

// L3 reform collapsed check_llm_semantic_t1/_t2 into a single
// check_llm_semantic (kind 'drift'). The badge taxonomy must follow:
// L3 semantic findings → 'llm' (renders the "AI" badge on DriftScreen);
// everything else → 'deterministic' (no badge). The old _t1/_t2
// names no longer exist and must NOT be special-cased anymore.

test('check_llm_semantic → llm (the single collapsed L3 check)', () => {
  assert.equal(findingTier('check_llm_semantic'), 'llm');
});

test('deterministic L1 checks → deterministic', () => {
  assert.equal(findingTier('check_dependency_drift'), 'deterministic');
  assert.equal(findingTier('check_structural_undeclared_present'), 'deterministic');
});

test('the deleted _t1/_t2 names are NOT special-cased (regression guard)', () => {
  assert.equal(findingTier('check_llm_semantic_t1'), 'deterministic');
  assert.equal(findingTier('check_llm_semantic_t2'), 'deterministic');
});
