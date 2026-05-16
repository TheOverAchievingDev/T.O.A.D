import { resolveContextWindow } from './modelContextWindow.js';

const TERMINAL = new Set(['turn_completed', 'turn_failed']);

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Pure: a single runtime's event-log rows → the context-usage snapshot.
 * "used" is the LATEST result-frame occupancy, never a Σ over turns
 * (design §2 Bug 1). `stale` is idle-not-in-flight (design §3): a turn
 * is "in flight" when any event is newer than the last result frame
 * (there is no turn_started event — this is the real signal).
 *
 * @param {object} a
 * @param {Array}  a.events       runtime-event-log rows ({eventType,createdAt,payload:{raw}})
 * @param {number} a.now          Date.now()-style ms
 * @param {number} a.stalenessMs  idle window before stale (default 60000)
 * @param {string} a.providerId   the runtime's provider ('claude' here)
 */
export function computeContextUsage({ events, now, stalenessMs = 60_000, providerId = 'unknown' } = {}) {
  const degraded = (model = null) => ({
    used: null, total: null, percentage: null,
    model, provider: providerId,
    lastUpdatedAt: null, stale: true, source: 'unknown',
  });
  if (!Array.isArray(events) || events.length === 0) return degraded();

  // Latest result frame (events arrive created_at ASC; scan from end).
  let resultEvt = null;
  let lastEventAt = null;
  for (const e of events) {
    if (e && typeof e.createdAt === 'string') {
      if (lastEventAt === null || e.createdAt > lastEventAt) lastEventAt = e.createdAt;
    }
    const raw = e && e.payload && e.payload.raw;
    if (e && e.eventType === 'turn_completed' && raw && raw.type === 'result'
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) {
        resultEvt = e;
      }
    }
  }
  if (!resultEvt) return degraded();

  const raw = resultEvt.payload.raw;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  // Cache fields are optional (non-cached requests have none) → silent 0.
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const cacheCreate = num(u.cache_creation_input_tokens) ?? 0;

  const lastUpdatedAt = resultEvt.createdAt;
  // In flight iff any event is newer than the last result frame.
  const inFlight = lastEventAt !== null && lastEventAt > lastUpdatedAt;
  const idleMs = now - Date.parse(lastUpdatedAt);
  const stale = !inFlight && Number.isFinite(idleMs) && idleMs > stalenessMs;

  // input/output mandatory; missing/non-numeric → untrustworthy snapshot.
  if (input === null || output === null) {
    return { used: null, total: null, percentage: null, model, provider: providerId, lastUpdatedAt, stale, source: 'unknown' };
  }
  const used = input + cacheRead + cacheCreate + output;
  const total = resolveContextWindow(model);
  if (total === null) {
    return { used, total: null, percentage: null, model, provider: providerId, lastUpdatedAt, stale, source: 'unknown' };
  }
  const percentage = Math.round((used / total) * 1000) / 10;
  return { used, total, percentage, model, provider: providerId, lastUpdatedAt, stale, source: 'precise' };
}
