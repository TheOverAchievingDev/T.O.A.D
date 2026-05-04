export type FindingTier = 'deterministic' | 'llm_t1' | 'llm_t2';

/**
 * Map a finding's check_name to its tier. UI uses this to render
 * tier-1 ("AI") and tier-2 ("Verified") badges on finding cards.
 */
export function findingTier(checkName: string): FindingTier {
  if (checkName === 'check_llm_semantic_t1') return 'llm_t1';
  if (checkName === 'check_llm_semantic_t2') return 'llm_t2';
  return 'deterministic';
}
