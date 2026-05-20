// Gemini context-usage extractor. The SP1b normalizer
// (src/runtime/gemini/normalizeGeminiStreamLine.js:67-78) emits
// turn_completed with usage at the TOP LEVEL of the event:
//   event.usage = parsed.stats  // pass-through of Gemini's native stats,
//                                // e.g. { input_tokens, output_tokens, duration_ms }
// (NOT event.raw.usage — verified against the SP1b grounded test fixture
// at test/gemini/normalizeGeminiStreamLine.test.js:55-72).
// RuntimeEventIngestor stores payload:normalized, so we read e.payload.usage.
//
// Gate: turn_completed with payload.usage object present. The Gemini
// normalizer only emits turn_completed for result/success, so we don't
// need a raw.type === 'result' discriminant — the eventType is
// authoritative (turn_failed gets a different eventType).
//
// Sum: input_tokens + output_tokens only. Gemini's result.stats does
// not surface cache fields.

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
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const used = input + output; // no cache fields for Gemini
  // Model is not currently surfaced by the Gemini normalizer on the
  // event itself; raw.model is also typically absent from Gemini result
  // frames. Returning null is honest — computeContextUsage will map
  // this to source:'unknown' until model sourcing is plumbed.
  const rawModel = resultEvt.payload.raw && typeof resultEvt.payload.raw === 'object' ? resultEvt.payload.raw.model : null;
  const model = typeof rawModel === 'string' && rawModel.length > 0 ? rawModel : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
