import { checkInvalidTransitions } from './checkInvalidTransitions.js';
import { checkOutOfScopeFiles } from './checkOutOfScopeFiles.js';
import { checkMissingTestArtifacts } from './checkMissingTestArtifacts.js';
import { checkRolePermissionViolations } from './checkRolePermissionViolations.js';
import { checkReviewWithoutFindings } from './checkReviewWithoutFindings.js';
import { checkProviderLogicLeakage } from './checkProviderLogicLeakage.js';
import { checkDoneWithoutMergeEvidence } from './checkDoneWithoutMergeEvidence.js';
import { checkLlmSemantic } from './checkLlmSemantic.js';

/**
 * Check registry. The engine runs all `tier: 1` checks first, scores
 * the result, and decides whether to run any `tier: 2` checks via
 * escalationGate.
 */
export const ALL_CHECKS = Object.freeze([
  // Deterministic — all tier 1 (always run)
  { name: 'check_invalid_transitions', tier: 1, fn: checkInvalidTransitions },
  { name: 'check_out_of_scope_files', tier: 1, fn: checkOutOfScopeFiles },
  { name: 'check_missing_test_artifacts', tier: 1, fn: checkMissingTestArtifacts },
  { name: 'check_role_permission_violations', tier: 1, fn: checkRolePermissionViolations },
  { name: 'check_review_without_findings', tier: 1, fn: checkReviewWithoutFindings },
  { name: 'check_provider_logic_leakage', tier: 1, fn: checkProviderLogicLeakage },
  { name: 'check_done_without_merge_evidence', tier: 1, fn: checkDoneWithoutMergeEvidence },
  // LLM tier 1 — Haiku/Mini/Flash, always runs
  { name: 'check_llm_semantic_t1', tier: 1, fn: (args) => checkLlmSemantic({ ...args, tier: 1 }) },
  // LLM tier 2 — Opus/GPT-5/Gemini-Pro, escalation only
  { name: 'check_llm_semantic_t2', tier: 2, fn: (args) => checkLlmSemantic({ ...args, tier: 2 }) },
]);

/** Back-compat: existing engine code reads DETERMINISTIC_CHECKS. */
export const DETERMINISTIC_CHECKS = Object.freeze(
  ALL_CHECKS.filter((c) => c.tier === 1 && !c.name.startsWith('check_llm_'))
);
