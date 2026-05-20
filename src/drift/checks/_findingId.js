import { createHash } from 'node:crypto';

/**
 * Stable hash for a finding. The same offending state on two runs of the
 * SAME team must produce the same id so the UI can diff "fixed since
 * last run". Different teams with identical-looking findings (e.g.
 * judge_failed meta-findings with the same salient text) MUST produce
 * different ids — otherwise drift_findings's table-wide PK constraint
 * crashes the second team's recordRun.
 *
 * teamId is intentionally REQUIRED. Passing it is the only way to
 * guarantee cross-team isolation. Older signatures that omitted it
 * silently broke whenever two teams produced similarly-shaped findings.
 */
export function stableFindingId({ teamId, checkName, category, taskId, salient }) {
  const h = createHash('sha1');
  h.update(typeof teamId === 'string' && teamId.length > 0 ? teamId : 'no-team');
  h.update('|');
  h.update(checkName);
  h.update('|');
  h.update(category);
  h.update('|');
  h.update(taskId ?? 'team');
  h.update('|');
  h.update(typeof salient === 'string' ? salient : JSON.stringify(salient ?? {}));
  return `f_${h.digest('hex').slice(0, 16)}`;
}
