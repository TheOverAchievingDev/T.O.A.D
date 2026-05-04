import { checkInvalidTransitions } from './checkInvalidTransitions.js';
import { checkOutOfScopeFiles } from './checkOutOfScopeFiles.js';
import { checkMissingTestArtifacts } from './checkMissingTestArtifacts.js';
import { checkRolePermissionViolations } from './checkRolePermissionViolations.js';
import { checkReviewWithoutFindings } from './checkReviewWithoutFindings.js';
import { checkProviderLogicLeakage } from './checkProviderLogicLeakage.js';
import { checkDoneWithoutMergeEvidence } from './checkDoneWithoutMergeEvidence.js';

/**
 * The full registry of slice-1 deterministic checks. Each entry is
 * `{ name, fn }` where `fn({snapshot}) => DriftFinding[]`. New checks
 * (and the slice-2 LLM tier) get added here without touching the engine.
 */
export const DETERMINISTIC_CHECKS = Object.freeze([
  { name: 'check_invalid_transitions', fn: checkInvalidTransitions },
  { name: 'check_out_of_scope_files', fn: checkOutOfScopeFiles },
  { name: 'check_missing_test_artifacts', fn: checkMissingTestArtifacts },
  { name: 'check_role_permission_violations', fn: checkRolePermissionViolations },
  { name: 'check_review_without_findings', fn: checkReviewWithoutFindings },
  { name: 'check_provider_logic_leakage', fn: checkProviderLogicLeakage },
  { name: 'check_done_without_merge_evidence', fn: checkDoneWithoutMergeEvidence },
]);
