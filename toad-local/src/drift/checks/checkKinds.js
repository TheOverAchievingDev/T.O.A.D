/**
 * The conformance-vs-drift taxonomy — single source of truth.
 *
 * PROJECT.md §8 deliberately separates two historically-conflated
 * terms:
 *
 *   - **conformance** / process invariants: the 7 pre-L1 deterministic
 *     checks. "Did the AGENTS follow the right PROCESS?" — lifecycle
 *     transitions valid, review had findings, done has merge evidence,
 *     role permissions respected, test artifacts present, scope
 *     contract honored, no provider-logic leakage. Behavioral audits
 *     of agent conduct.
 *   - **drift**: the L1/L2/L3 layered system. "Does the ARTIFACT match
 *     the SPEC?" — code-vs-spec alignment (dependency / structural /
 *     constitution / contract) plus the LLM semantic tiers.
 *
 * This module is intentionally free of check-fn imports so the store's
 * read path (driftStore.rowToFinding) and the engine can derive a
 * finding's `kind` from its stable `checkName` with no schema column
 * and no heavy dependency graph. checks/index.js attaches `kind` to
 * each registry entry from this map and asserts completeness at load,
 * so a future check that is registered but left unclassified fails
 * loudly instead of being silently misfiled.
 *
 * `kind` is additive metadata — it never affects scoring, status, or
 * stableFindingId (renaming checkName would orphan every persisted
 * finding + correction link; the split lives here, not in the names).
 */

export const CHECK_KIND = Object.freeze({
  // ── conformance / process invariants (the 7 pre-L1 checks) ─────────
  check_invalid_transitions: 'conformance',
  check_out_of_scope_files: 'conformance',
  check_missing_test_artifacts: 'conformance',
  check_role_permission_violations: 'conformance',
  check_review_without_findings: 'conformance',
  check_provider_logic_leakage: 'conformance',
  check_done_without_merge_evidence: 'conformance',
  // ── drift / code-vs-spec (L1 deterministic + L3 LLM semantic) ──────
  check_dependency_drift: 'drift',
  check_structural_declared_absent: 'drift',
  check_structural_undeclared_present: 'drift',
  check_constitution: 'drift',
  check_contract_drift: 'drift',
  check_llm_semantic: 'drift',
});

export const CONFORMANCE_CHECK_NAMES = Object.freeze(
  new Set(Object.keys(CHECK_KIND).filter((n) => CHECK_KIND[n] === 'conformance')),
);

export const DRIFT_CHECK_NAMES = Object.freeze(
  new Set(Object.keys(CHECK_KIND).filter((n) => CHECK_KIND[n] === 'drift')),
);

/**
 * @param {string} checkName
 * @returns {'conformance'|'drift'|null} null = unknown/unclassified
 *   (honest — callers must not guess a kind for an unmapped check).
 */
export function kindForCheck(checkName) {
  if (typeof checkName !== 'string' || checkName.length === 0) return null;
  return Object.prototype.hasOwnProperty.call(CHECK_KIND, checkName)
    ? CHECK_KIND[checkName]
    : null;
}
