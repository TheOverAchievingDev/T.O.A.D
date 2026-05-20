// Codex context-usage extractor. Codex's normalizer emits
// turn_completed with payload.raw.usage =
// { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }.
// `reasoning_output_tokens` is Codex's reasoning-tier accounting and
// IS part of context occupancy — sum it.

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
  const reasoning = num(u.reasoning_output_tokens) ?? 0;
  const used = input + output + cached + reasoning;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
