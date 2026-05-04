import { createHash } from 'node:crypto';

/**
 * Stable hash for a finding. The same offending state on two runs must
 * produce the same id so the UI (slice 2) can diff "fixed since last run".
 */
export function stableFindingId({ checkName, category, taskId, salient }) {
  const h = createHash('sha1');
  h.update(checkName);
  h.update('|');
  h.update(category);
  h.update('|');
  h.update(taskId ?? 'team');
  h.update('|');
  h.update(typeof salient === 'string' ? salient : JSON.stringify(salient ?? {}));
  return `f_${h.digest('hex').slice(0, 16)}`;
}
