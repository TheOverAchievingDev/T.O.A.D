/**
 * Decide whether the tier-2 LLM judge should run for this drift run.
 *
 * Pure function — no I/O, no side effects. Engine maintains the
 * cooldown state in memory and passes it in via lastT2RunAt /
 * lastT2Score.
 *
 * Logic (from spec §7):
 *   1. tier1Score < threshold      → skip (below_threshold)
 *   2. lastT2RunAt is null         → escalate (first_time)
 *   3. now - lastT2RunAt < cooldown → skip (cooldown)
 *   4. |tier1Score - lastT2Score| ≥ delta → escalate (score_delta)
 *   5. otherwise                   → skip (no_material_change)
 */
export function escalationGate({
  tier1Score,
  threshold,
  cooldownMs,
  scoreDelta,
  lastT2RunAt,
  lastT2Score,
  now,
} = {}) {
  if (typeof tier1Score !== 'number') {
    return { escalate: false, reason: 'invalid_score' };
  }
  if (tier1Score < threshold) {
    return { escalate: false, reason: 'below_threshold' };
  }
  if (lastT2RunAt === null || lastT2RunAt === undefined) {
    return { escalate: true, reason: 'first_time' };
  }
  if (now - lastT2RunAt < cooldownMs) {
    return { escalate: false, reason: 'cooldown' };
  }
  const prior = typeof lastT2Score === 'number' ? lastT2Score : 0;
  if (Math.abs(tier1Score - prior) >= scoreDelta) {
    return { escalate: true, reason: 'score_delta' };
  }
  return { escalate: false, reason: 'no_material_change' };
}
