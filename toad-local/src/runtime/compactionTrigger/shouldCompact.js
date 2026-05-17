// Pure decision core (design §3.2). NO imports, NO IO — the wiring
// layer (CompactionTrigger) supplies usage/threshold/state and owns the
// adapter rail, side-effect log, observable bus, and the per-runtime
// boundary-gate. Mirrors the claudeAuthPreflight / eventNarration
// pure-core discipline (decision-table + purity + frozen-throw tested).

export const REASONS = (() => {
  const o = {
    SIGNAL_UNTRUSTWORTHY: 'signal-untrustworthy',
    NO_SIGNAL: 'no-signal',
    GATED_IN_FLIGHT: 'gated-in-flight',
    RETRY: 'retry',
    GIVING_UP_SURFACED: 'giving-up-surfaced',
    THRESHOLD_CROSSED: 'threshold-crossed',
    BELOW_THRESHOLD: 'below-threshold',
  };
  return Object.freeze(o);
})();

// Strict numeric guard — same discipline as B's computeContextUsage:
// never coerces ("0.7" → null, NaN → null).
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {object} a
 * @param {{percentage:?number, stale?:boolean, source?:string}} a.usage  B's getContextUsage result
 * @param {number} a.threshold  fraction in (0,1], e.g. 0.70
 * @param {{gateArmed:boolean, lastFireAt:number, retriesRemaining:number, cooldownMs:number}} a.state  per-runtime trigger state
 * @param {number} a.now  epoch ms
 * @returns {{trigger:boolean, reason:string}}  reason ∈ REASONS
 */
export function shouldCompact({ usage, threshold, state, now } = {}) {
  const u = usage || {};
  // #1 — never act on a signal we cannot substantiate. `source:'unknown'`
  // is ALSO how B reports a non-Claude/degraded runtime, so this single
  // branch subsumes the spec's "non-Claude → no fire" (grounding note).
  if (u.stale === true || u.source === 'unknown') {
    return { trigger: false, reason: REASONS.SIGNAL_UNTRUSTWORTHY };
  }
  // #2 — strict: a missing/non-finite percentage is no signal, not 0.
  const pct = num(u.percentage);
  if (pct === null) {
    return { trigger: false, reason: REASONS.NO_SIGNAL };
  }
  const st = state || {};
  if (st.gateArmed === true) {
    const cooledFor = now - st.lastFireAt;
    // #3 — a /compact is in flight and the cooldown has not elapsed.
    if (cooledFor < st.cooldownMs) {
      return { trigger: false, reason: REASONS.GATED_IN_FLIGHT };
    }
    // #4 — cooldown elapsed with no compact_boundary, budget remains.
    if (st.retriesRemaining > 0) {
      return { trigger: true, reason: REASONS.RETRY };
    }
    // #5 — budget exhausted: give up (wiring surfaces this once).
    return { trigger: false, reason: REASONS.GIVING_UP_SURFACED };
  }
  // #6 — fresh cross.
  if (pct >= threshold) {
    return { trigger: true, reason: REASONS.THRESHOLD_CROSSED };
  }
  // #7
  return { trigger: false, reason: REASONS.BELOW_THRESHOLD };
}
