import { resolveContextWindow } from './modelContextWindow.js';
import { getExtractor } from './extractorRegistry.js';

/**
 * Pure: a single runtime's event-log rows → the context-usage snapshot.
 * "used" is the LATEST result-frame occupancy, never a Σ over turns
 * (design §2 Bug 1). `stale` is idle-not-in-flight (design §3): a turn
 * is "in flight" when any event is newer than the last result frame.
 * Per-provider extraction is delegated to the extractor registry.
 *
 * @param {object} a
 * @param {Array}  a.events       runtime-event-log rows ({eventType,createdAt,payload:{raw}})
 * @param {number} a.now          Date.now()-style ms
 * @param {number} a.stalenessMs  idle window before stale (default 60000)
 * @param {string} a.providerId   the runtime's provider
 */
export function computeContextUsage({ events, now, stalenessMs = 60_000, providerId = 'unknown' } = {}) {
  const degraded = (model = null) => ({
    used: null, total: null, percentage: null,
    model, provider: providerId,
    lastUpdatedAt: null, stale: true, source: 'unknown',
  });

  const extractor = getExtractor(providerId);
  if (!extractor) return degraded();
  if (!Array.isArray(events) || events.length === 0) return degraded();

  const x = extractor.extractLatestUsage(events);
  if (!x) return degraded();

  const { used, model, lastUpdatedAt, inFlight } = x;
  const idleMs = now - Date.parse(lastUpdatedAt);
  const stale = !inFlight && Number.isFinite(idleMs) && idleMs > stalenessMs;
  const total = resolveContextWindow(model);
  if (total === null) {
    return { used, total: null, percentage: null, model, provider: providerId, lastUpdatedAt, stale, source: 'unknown' };
  }
  const percentage = Math.round((used / total) * 1000) / 10;
  return { used, total, percentage, model, provider: providerId, lastUpdatedAt, stale, source: 'precise' };
}
