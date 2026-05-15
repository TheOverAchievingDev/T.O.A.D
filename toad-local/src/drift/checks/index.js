import { checkInvalidTransitions } from './checkInvalidTransitions.js';
import { checkOutOfScopeFiles } from './checkOutOfScopeFiles.js';
import { checkMissingTestArtifacts } from './checkMissingTestArtifacts.js';
import { checkRolePermissionViolations } from './checkRolePermissionViolations.js';
import { checkReviewWithoutFindings } from './checkReviewWithoutFindings.js';
import { checkProviderLogicLeakage } from './checkProviderLogicLeakage.js';
import { checkDoneWithoutMergeEvidence } from './checkDoneWithoutMergeEvidence.js';
import { checkDependencyDrift } from './checkDependencyDrift.js';
import { checkStructuralDeclaredAbsent } from './checkStructuralDeclaredAbsent.js';
import { checkStructuralUndeclaredPresent } from './checkStructuralUndeclaredPresent.js';
import { checkConstitution } from './checkConstitution.js';
import { checkContractDrift } from './checkContractDrift.js';
import { checkLlmSemantic } from './checkLlmSemantic.js';
import { kindForCheck } from './checkKinds.js';

/**
 * Check registry. The engine runs all `tier: 1` checks first, scores
 * the result, and decides whether to run any `tier: 2` checks via
 * escalationGate.
 *
 * Every entry carries `kind: 'conformance' | 'drift'` (PROJECT.md §8),
 * attached from checkKinds.js — the single source of truth for the
 * split. `withKind` asserts at module load that no registered check is
 * left unclassified, so a future check fails loudly here rather than
 * being silently misfiled (the project's honest-never-silent doctrine).
 */
function withKind(entry) {
  const kind = kindForCheck(entry.name);
  if (kind === null) {
    throw new Error(
      `drift check registry: "${entry.name}" has no conformance/drift `
      + 'classification — add it to src/drift/checks/checkKinds.js',
    );
  }
  return Object.freeze({ ...entry, kind });
}

export const ALL_CHECKS = Object.freeze([
  // Deterministic — all tier 1 (always run)
  { name: 'check_invalid_transitions', tier: 1, fn: checkInvalidTransitions },
  { name: 'check_out_of_scope_files', tier: 1, fn: checkOutOfScopeFiles },
  { name: 'check_missing_test_artifacts', tier: 1, fn: checkMissingTestArtifacts },
  { name: 'check_role_permission_violations', tier: 1, fn: checkRolePermissionViolations },
  { name: 'check_review_without_findings', tier: 1, fn: checkReviewWithoutFindings },
  { name: 'check_provider_logic_leakage', tier: 1, fn: checkProviderLogicLeakage },
  { name: 'check_done_without_merge_evidence', tier: 1, fn: checkDoneWithoutMergeEvidence },
  // ── Layer-1 code-vs-spec drift (NOT process conformance) ──────────
  // Reads docs/foundry/spec.json (pre-loaded onto the snapshot by
  // buildSnapshot). Deterministic, tier 1, runs even with the LLM
  // judge paused. mode:'observe' — flags, never blocks delivery
  // (the gate path is constitution-rules-only and needs the broker
  // observer seam, a separate slice). First real code-vs-spec drift
  // Symphony ships. See PROJECT.md §8a + the schema design doc.
  { name: 'check_dependency_drift', tier: 1, mode: 'observe', fn: checkDependencyDrift },
  // L1.2a — declared-but-absent structural drift, roadmap-aware.
  // Reads spec.structure + snapshot.structurePresence + task.delivers.
  // Honest-dormant (one info meta) until the `delivers` field is
  // adopted, so it never wolf-cries on early-stage projects. L1.2b
  // (undeclared-present, scope-only) is a separate follow-up entry.
  { name: 'check_structural_declared_absent', tier: 1, mode: 'observe', fn: checkStructuralDeclaredAbsent },
  // L1.2b — undeclared-but-present structural drift, SCOPE question,
  // no roadmap awareness. The higher-severity drift class (scope
  // creep / undocumented surface / a stray telemetry module). Reads
  // spec.structure + snapshot.sourceModules. Honest info-meta when
  // structure isn't enumerated (empty declared set ≠ "nothing
  // sanctioned") so it never flags every file on an under-specced
  // project.
  { name: 'check_structural_undeclared_present', tier: 1, mode: 'observe', fn: checkStructuralUndeclaredPresent },
  // L1.3 — constitution drift. Generalizes the hardcoded
  // check_provider_logic_leakage prototype into spec-driven rules
  // (spec.constitution.rules[]). Whole-tree scan in buildSnapshot;
  // per-rule severity + mode. Registry mode stays 'observe' — even
  // gate-mode RULES only flag until the broker append→deliver seam
  // lands (the finding carries constitutionMode so that slice is
  // zero-change here). check_provider_logic_leakage stays as-is for
  // now; folding it into a constitution rule is a later cleanup.
  { name: 'check_constitution', tier: 1, mode: 'observe', fn: checkConstitution },
  // L1.4a — contract drift, PRESENCE only (last L1 deterministic
  // stage; reviewer order: dependency → structural → constitution →
  // contract). Reads spec.contracts + snapshot.contractScan (pre-run
  // by buildSnapshot). §4a fence: presence now, arity is L1.4b, type
  // correctness NEVER (the compiler/validation_run owns types).
  // mode:'observe' — flags, never blocks delivery.
  { name: 'check_contract_drift', tier: 1, mode: 'observe', fn: checkContractDrift },
  // LLM tier 1 — Haiku/Mini/Flash, always runs
  { name: 'check_llm_semantic_t1', tier: 1, fn: (args) => checkLlmSemantic({ ...args, tier: 1 }) },
  // LLM tier 2 — Opus/GPT-5/Gemini-Pro, escalation only
  { name: 'check_llm_semantic_t2', tier: 2, fn: (args) => checkLlmSemantic({ ...args, tier: 2 }) },
].map(withKind));

/** Back-compat: existing engine code reads DETERMINISTIC_CHECKS. */
export const DETERMINISTIC_CHECKS = Object.freeze(
  ALL_CHECKS.filter((c) => c.tier === 1 && !c.name.startsWith('check_llm_'))
);

// Conformance-vs-drift taxonomy (PROJECT.md §8). Re-exported from the
// registry so consumers have one import site; the source of truth is
// checkKinds.js.
export {
  kindForCheck, CHECK_KIND, CONFORMANCE_CHECK_NAMES, DRIFT_CHECK_NAMES,
} from './checkKinds.js';

/** Registry entries split by kind (frozen views over ALL_CHECKS). */
export const CONFORMANCE_CHECKS = Object.freeze(
  ALL_CHECKS.filter((c) => c.kind === 'conformance'),
);
export const DRIFT_CHECKS = Object.freeze(
  ALL_CHECKS.filter((c) => c.kind === 'drift'),
);
