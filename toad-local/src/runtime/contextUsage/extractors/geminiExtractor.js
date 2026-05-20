// Gemini context-usage extractor. Gemini's SP1b normalizer emits
// turn_completed with payload.raw = { type:'result', usage:{input_tokens,output_tokens}, ... }.
// No cache fields surface through Gemini's result.stats — input+output only.
//
// Gate matches claudeExtractor (raw.type === 'result') because Gemini's
// normalizer, like Claude's, uses 'result' as the authoritative-frame
// discriminant. Codex's normalizer is the exception (no type field) —
// see codexExtractor.js for that gate divergence.

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
    const raw = e && e.payload && e.payload.raw;
    if (e && e.eventType === 'turn_completed' && raw && raw.type === 'result'
        && raw.usage && typeof raw.usage === 'object'
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) resultEvt = e;
    }
  }
  if (!resultEvt) return null;

  const raw = resultEvt.payload.raw;
  const u = raw.usage;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const used = input + output; // no cache fields for Gemini
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
