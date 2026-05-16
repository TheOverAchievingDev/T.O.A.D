import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kindForCheck,
  CONFORMANCE_CHECK_NAMES,
  DRIFT_CHECK_NAMES,
  CHECK_KIND,
} from '../../../src/drift/checks/checkKinds.js';
import { ALL_CHECKS } from '../../../src/drift/checks/index.js';

// PROJECT.md §8: two historically-conflated terms, now deliberately
// separated.
//   Conformance / process invariants — the 7 pre-L1 deterministic
//     checks. "Did the AGENTS follow the right PROCESS?"
//   Drift — the L1/L2/L3 layered system. "Does the ARTIFACT match
//     the SPEC?" (code-vs-spec; includes the LLM semantic tiers).
// This module is the single source of truth for that split. It must
// stay free of check-fn imports so the store's read path + UI can
// derive `kind` from a checkName cheaply (no schema column).

const CONFORMANCE_7 = [
  'check_invalid_transitions',
  'check_out_of_scope_files',
  'check_missing_test_artifacts',
  'check_role_permission_violations',
  'check_review_without_findings',
  'check_provider_logic_leakage',
  'check_done_without_merge_evidence',
];

const DRIFT = [
  'check_dependency_drift',
  'check_structural_declared_absent',
  'check_structural_undeclared_present',
  'check_constitution',
  'check_contract_drift',
  'check_llm_semantic',
];

test('the 7 pre-L1 process checks classify as conformance', () => {
  for (const name of CONFORMANCE_7) {
    assert.equal(kindForCheck(name), 'conformance', name);
  }
  assert.deepEqual([...CONFORMANCE_CHECK_NAMES].sort(), [...CONFORMANCE_7].sort());
});

test('the L1 code-vs-spec checks + L3 LLM semantic classify as drift', () => {
  for (const name of DRIFT) {
    assert.equal(kindForCheck(name), 'drift', name);
  }
  assert.deepEqual([...DRIFT_CHECK_NAMES].sort(), [...DRIFT].sort());
});

test('unknown / unclassified check name → null (honest, never a silent guess)', () => {
  assert.equal(kindForCheck('check_does_not_exist'), null);
  assert.equal(kindForCheck(''), null);
  assert.equal(kindForCheck(undefined), null);
  assert.equal(kindForCheck(null), null);
});

test('completeness: EVERY registered check has an explicit kind', () => {
  // The point of this test: a future check added to the registry but
  // not classified here fails loudly (no silent misclassification).
  for (const c of ALL_CHECKS) {
    const k = kindForCheck(c.name);
    assert.ok(
      k === 'conformance' || k === 'drift',
      `registered check "${c.name}" is not classified in checkKinds.js`,
    );
  }
});

test('conformance and drift name sets are disjoint and cover CHECK_KIND', () => {
  for (const n of CONFORMANCE_CHECK_NAMES) {
    assert.ok(!DRIFT_CHECK_NAMES.has(n), `${n} in both sets`);
  }
  const all = new Set([...CONFORMANCE_CHECK_NAMES, ...DRIFT_CHECK_NAMES]);
  assert.deepEqual([...all].sort(), Object.keys(CHECK_KIND).sort());
});
