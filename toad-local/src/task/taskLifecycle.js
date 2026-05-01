/**
 * Deterministic task state machine for TOAD.
 *
 * Implements §3 of `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`. The
 * orchestrator (not agents) owns task transitions. Every status change goes
 * through `validateTaskStatusTransition` and only succeeds when the move is
 * in `ALLOWED_TRANSITIONS`.
 *
 * The 10 lifecycle values come straight from the checklist. The legacy
 * 4-value enum (`pending` / `in_progress` / `completed` / `deleted`) lives
 * alongside as transition aliases so existing call sites — particularly
 * `taskBoard.test.js`'s pending→in_progress→completed happy path — keep
 * working without a coordinated rewrite. New work should prefer the
 * 10-state names.
 */

export const TASK_LIFECYCLE = Object.freeze({
  BACKLOG: 'backlog',
  READY: 'ready',
  PLANNED: 'planned',
  IN_PROGRESS: 'in_progress',
  REVIEW: 'review',
  TESTING: 'testing',
  MERGE_READY: 'merge_ready',
  BLOCKED: 'blocked',
  DONE: 'done',
  REJECTED: 'rejected',
});

export const ALLOWED_TRANSITIONS = Object.freeze({
  // 10-state checklist lifecycle
  backlog:     ['ready', 'rejected'],
  ready:       ['planned', 'blocked'],
  planned:     ['in_progress', 'blocked'],
  in_progress: ['review', 'blocked', 'completed'],
  review:      ['testing', 'in_progress', 'rejected'],
  testing:     ['merge_ready', 'in_progress', 'blocked'],
  merge_ready: ['done', 'in_progress'],
  blocked:     ['ready', 'planned', 'in_progress'],
  done:        [],
  rejected:    ['backlog'],
  // Legacy aliases — preserve existing call sites
  pending:     ['ready', 'in_progress', 'rejected', 'blocked', 'completed'],
  completed:   [],
  deleted:     ['backlog'],
});

/**
 * Validate a status transition. Returns `{ ok: true }` for legal moves,
 * `{ ok: false, reason }` otherwise. Same-state moves are idempotent and
 * always allowed. `from === null/undefined` is treated as the initial-state
 * case — any known status is acceptable.
 */
export function validateTaskStatusTransition({ from, to } = {}) {
  if (typeof to !== 'string' || to.length === 0) {
    return { ok: false, reason: 'target status must be a non-empty string' };
  }
  if (from === null || from === undefined) {
    if (Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, to)) {
      return { ok: true };
    }
    return { ok: false, reason: `unknown initial status "${to}"` };
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, from)) {
    return { ok: false, reason: `unknown source status "${from}"` };
  }
  if (from === to) return { ok: true };
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `${from} → ${to} is not an allowed transition` };
  }
  return { ok: true };
}
