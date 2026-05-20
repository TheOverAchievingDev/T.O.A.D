// Claude / Anthropic context-usage extractor. Codifies the original
// inline logic from computeContextUsage.js. Returns
// { used, model, lastUpdatedAt, inFlight } or null when no result
// frame exists or token counts are unusable.

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
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) resultEvt = e;
    }
  }
  if (!resultEvt) return null;

  const raw = resultEvt.payload.raw;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const cacheCreate = num(u.cache_creation_input_tokens) ?? 0;
  const used = input + output + cacheRead + cacheCreate;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
