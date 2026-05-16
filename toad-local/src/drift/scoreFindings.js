/**
 * Pure-function scoring for drift findings. No I/O, no state.
 *
 * Severity weights and thresholds come from the spec
 * (docs/superpowers/specs/2026-05-03-drift-monitor-design.md §4.5).
 *
 * Score semantics:
 *   teamScore = sum of weights, capped at TEAM_SCORE_CAP — higher = worse
 *   perTaskScores = same, grouped by taskId (team-level findings excluded)
 *   categoryScores = inverted: 100 - sum(weights in category), so HIGHER = HEALTHIER
 *     This matches the spec's "Architecture: 94%" reading (94% healthy).
 */

export const SEVERITY_WEIGHT = Object.freeze({
  observer: 0, info: 1, low: 3, medium: 8, high: 15, critical: 25,
});

export const STATUS_THRESHOLDS = Object.freeze([
  { max: 20, status: 'healthy' },
  { max: 40, status: 'watch' },
  { max: 65, status: 'warning' },
  { max: 100, status: 'critical' },
]);

export const TEAM_SCORE_CAP = 100;
export const PER_TASK_SCORE_CAP = 100;

export const ALL_CATEGORIES = Object.freeze([
  'architecture', 'checklist', 'slice_scope', 'test_truth', 'risk',
]);

export function statusForScore(score) {
  for (const t of STATUS_THRESHOLDS) {
    if (score <= t.max) return t.status;
  }
  return 'critical';
}

function weightOf(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_WEIGHT, severity)
    ? SEVERITY_WEIGHT[severity]
    : 0;
}

export function scoreFindings(findings) {
  const list = Array.isArray(findings) ? findings : [];
  let teamRaw = 0;
  const perTaskRaw = {};
  const perCategoryRaw = {};
  for (const c of ALL_CATEGORIES) perCategoryRaw[c] = 0;

  for (const f of list) {
    const w = weightOf(f.severity);
    teamRaw += w;
    if (f.taskId) {
      perTaskRaw[f.taskId] = (perTaskRaw[f.taskId] ?? 0) + w;
    }
    if (Object.prototype.hasOwnProperty.call(perCategoryRaw, f.category)) {
      perCategoryRaw[f.category] += w;
    }
  }

  const teamScore = Math.min(TEAM_SCORE_CAP, teamRaw);
  const perTaskScores = {};
  for (const [tid, raw] of Object.entries(perTaskRaw)) {
    perTaskScores[tid] = Math.min(PER_TASK_SCORE_CAP, raw);
  }
  // Filled-bar style: 100 = healthy.
  const categoryScores = {};
  for (const c of ALL_CATEGORIES) {
    categoryScores[c] = Math.max(0, 100 - Math.min(100, perCategoryRaw[c]));
  }

  return {
    teamScore,
    status: statusForScore(teamScore),
    perTaskScores,
    categoryScores,
  };
}
