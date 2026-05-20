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
 * Per-transition role guards (§3 + §5 intersection).
 *
 * Most transitions are open to any role — developers move tasks through the
 * normal flow on their own. A handful of transitions are orchestrator-level
 * decisions that should only be made by trusted roles:
 *
 *   - `merge_ready → done`: final integration sign-off. Lead / human only.
 *   - `rejected → backlog`: recovery. Architect / lead / human only.
 *   - `blocked → *`:        unblock decision. Architect / lead / human only.
 *
 * Map keys are `"from→to"`. A missing entry means "no role guard". When the
 * caller passes no `role`, the guard is bypassed — preserves backward compat
 * with legacy call sites that don't tag `actor.role` (matches the permissive
 * default in `roleAuthority.js`).
 */
export const TRANSITION_ROLES = Object.freeze({
  'merge_ready->done':       Object.freeze(['lead', 'human']),
  'rejected->backlog':       Object.freeze(['architect', 'lead', 'human']),
  'blocked->ready':          Object.freeze(['architect', 'lead', 'human']),
  'blocked->planned':        Object.freeze(['architect', 'lead', 'human']),
  'blocked->in_progress':    Object.freeze(['architect', 'lead', 'human']),
});

/**
 * Validate a status transition. Returns `{ ok: true }` for legal moves,
 * `{ ok: false, reason }` otherwise. Same-state moves are idempotent and
 * always allowed. `from === null/undefined` is treated as the initial-state
 * case — any known status is acceptable.
 *
 * If `role` is provided and the transition has a role guard, the role must be
 * in the allowlist. Missing role bypasses the guard (back-compat).
 */
export function validateTaskStatusTransition({ from, to, role } = {}) {
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
  // Role guard (only when role is provided and a guard exists for this transition)
  if (typeof role === 'string' && role.length > 0) {
    const guard = TRANSITION_ROLES[`${from}->${to}`];
    if (Array.isArray(guard) && !guard.includes(role)) {
      return {
        ok: false,
        reason: `role ${role} cannot perform ${from} → ${to} (allowed: ${guard.join(', ')})`,
      };
    }
  }
  return { ok: true };
}
