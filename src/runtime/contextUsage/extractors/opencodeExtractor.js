// OpenCode context-usage extractor. The SP1c normalizer
// (src/runtime/opencode/normalizeOpencodeStreamLine.js) emits
// turn_completed with usage at the TOP LEVEL of the event in
// camelCase:
//   event.usage = { inputTokens, outputTokens, totalTokens, cacheRead, cacheWrite }
// (NOT event.raw.usage, NOT snake_case — verified against the SP1c
// grounded test fixture at test/opencode/normalizeOpencodeStreamLine.test.js:67-74).
// RuntimeEventIngestor stores payload:normalized, so we read e.payload.usage.
//
// Gate: turn_completed with payload.usage object present (no raw.type
// === 'result' check — OpenCode emits a single turn_completed per turn
// carrying usage directly, just like Codex).
//
// Sum: inputTokens + outputTokens + cacheRead(??0). cacheWrite is NOT
// part of context-window occupancy and is intentionally excluded.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function extractLatestUsage(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let resultEvt = null;
  let lastEventAt = null;
  for (const e of events) {
    if (e && typeof e.createdAt === 'string') {
      if (lastEventAt === null || e.createdAt > lastEventAt) lastEventAt = e.createdAt;
    }
    const payload = e && e.payload;
    if (e && e.eventType === 'turn_completed' && payload && payload.usage && typeof payload.usage === 'object'
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) resultEvt = e;
    }
  }
  if (!resultEvt) return null;

  const u = resultEvt.payload.usage;
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  if (input === null || output === null) return null;
  const cached = num(u.cacheRead) ?? 0;
  const used = input + output + cached;
  // OpenCode's normalizer does not currently surface a model field on
  // the event; raw.model is also absent (step_finish JSON has no model
  // at top level). Returning null is honest — computeContextUsage will
  // map this to source:'unknown' until model sourcing is plumbed.
  const rawModel = resultEvt.payload.raw && typeof resultEvt.payload.raw === 'object' ? resultEvt.payload.raw.model : null;
  const model = typeof rawModel === 'string' && rawModel.length > 0 ? rawModel : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
