// OpenCode context-usage extractor. The SP1c normalizer aliases
// native step_finish.part.tokens.{input,output,cache.read} into
// payload.raw.usage.{input_tokens, output_tokens, cached_input_tokens?}
// on turn_completed.
//
// Gate matches codexExtractor (no raw.type === 'result' check) because
// OpenCode's normalizer emits a SINGLE turn_completed per turn carrying
// usage directly, just like Codex. claudeExtractor / geminiExtractor
// require the 'result' discriminant; OpenCode does not.

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
    if (e && e.eventType === 'turn_completed' && raw && raw.usage && typeof raw.usage === 'object'
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
  const cached = num(u.cached_input_tokens) ?? 0;
  const used = input + output + cached;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
