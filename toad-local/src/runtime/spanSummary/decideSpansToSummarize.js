// Pure span-summary decision (Readability Layer-2 P3a). Zero imports,
// JSX-free, server-importable — the eventNarration/spanDetection
// pure-core discipline. Answers: given the current spans + the spanIds
// already summarized, which CLOSED spans still need a summary, oldest
// first? Reads the LIVE Span.startedAt (distinct from the persisted
// span_started_at snapshot column — do not conflate).

/**
 * @param {{ spans?: Array<object>, summarizedSpanIds?: Set<string>|Array<string> }} [input]
 * @returns {Array<object>} the closed, not-yet-summarized spans, oldest-first
 */
export function decideSpansToSummarize(input) {
  const arg = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(arg.spans) ? arg.spans : [];
  const sid = arg.summarizedSpanIds;
  const done = sid instanceof Set ? sid : new Set(Array.isArray(sid) ? sid : []);

  const eligible = list.filter(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof s.spanId === 'string' &&
      s.closed === true &&
      !done.has(s.spanId),
  );

  return eligible.slice().sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    if (na !== nb) return na - nb;
    if (a.spanId < b.spanId) return -1;
    if (a.spanId > b.spanId) return 1;
    return 0;
  });
}
