import { computeContextUsage } from './computeContextUsage.js';

const DEFAULT_STALENESS_MS = 60_000;
// Providers with a real B implementation. Codex/Gemini are NAMED-
// DEFERRED slots (design §4): the interface stays agnostic and
// empty-slot-safe (degraded shape, never throws) until a parser lands.
const IMPLEMENTED = new Set(['claude', 'anthropic']);

function degraded(provider, model = null) {
  return { used: null, total: null, percentage: null, model, provider: provider || 'unknown', lastUpdatedAt: null, stale: true, source: 'unknown' };
}

/**
 * Provider-agnostic context-usage accessor. Resolves the agent's
 * current runtime via the registry, pulls its events, and computes
 * the latest-snapshot occupancy. ALWAYS returns the correctly-shaped
 * object — never throws, never an invalid shape — regardless of
 * provider or missing deps (design §4 empty-slot safety).
 */
export function getContextUsage(agentId, { teamId, runtimeRegistry, eventLog, settings, now } = {}) {
  try {
    if (typeof agentId !== 'string' || agentId.length === 0) return degraded();
    if (typeof teamId !== 'string' || teamId.length === 0) return degraded();
    if (!runtimeRegistry || typeof runtimeRegistry.listRuntimes !== 'function') return degraded();
    const rows = runtimeRegistry.listRuntimes({ teamId }) || [];
    const mine = rows.filter((r) => r && r.agentId === agentId);
    if (mine.length === 0) return degraded();
    // Current runtime: prefer a non-stopped one, else the latest started.
    // Plain string compare on ISO-8601 (Fix I1 — not locale-sensitive
    // localeCompare; ISO timestamps order correctly by code point).
    mine.sort((a, b) => {
      const sb = String(b.startedAt || '');
      const sa = String(a.startedAt || '');
      return sb < sa ? -1 : sb > sa ? 1 : 0;
    });
    const current = mine.find((r) => r.status && r.status !== 'stopped') || mine[0];
    const providerId = current.providerId || 'unknown';
    if (!IMPLEMENTED.has(providerId)) return degraded(providerId);
    if (!eventLog || typeof eventLog.listEvents !== 'function') return degraded(providerId);
    const events = eventLog.listEvents({ runtimeId: current.runtimeId }) || [];
    const stalenessMs = Number.isFinite(settings?.runtime?.contextStaleness)
      ? settings.runtime.contextStaleness
      : DEFAULT_STALENESS_MS;
    return computeContextUsage({ events, now: typeof now === 'number' ? now : Date.now(), stalenessMs, providerId });
  } catch {
    return degraded();
  }
}
