export type FindingTier = 'deterministic' | 'llm';

/**
 * Map a finding's check_name to its tier. The L3 reform collapsed the
 * old two-tier LLM checks (check_llm_semantic_t1/_t2) into a single
 * `check_llm_semantic` (kind 'drift'). The UI uses this to render an
 * "AI" badge on L3 semantic-drift finding cards so operators can tell
 * them apart from deterministic L1 findings (which get no badge).
 */
export function findingTier(checkName: string): FindingTier {
  if (checkName === 'check_llm_semantic') return 'llm';
  return 'deterministic';
}
