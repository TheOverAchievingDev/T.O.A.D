// The span-summary trigger/lifecycle (Readability Layer-2 P3b-2). The
// FIRST production caller of the P3b-1 engine. A 1:1 mirror of
// src/drift/driftMonitor.js (a periodic setInterval driver over live
// teams with per-team error isolation) PLUS an inFlight skip-guard and
// a getStatus() in-memory honest-degraded accessor. All IO is
// constructor-injected; tickOnce NEVER throws out of the timer.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class SummaryMonitor {
  #timer = null;
  #inFlight = false;
  #status = {
    state: 'idle',
    lastRunAt: null,
    lastDurationMs: 0,
    teamsPolled: 0,
    summarizedCount: 0,
    degradedCount: 0,
    skippedRateLimited: 0,
    lastReasons: [],
  };

  constructor({
    summarize,
    listLiveTeams,
    resolveLeadProviderId,
    intervalMs = DEFAULT_INTERVAL_MS,
    logger = console,
  } = {}) {
    if (typeof summarize !== 'function') {
      throw new TypeError('SummaryMonitor: summarize() required');
    }
    if (typeof listLiveTeams !== 'function') {
      throw new TypeError('SummaryMonitor: listLiveTeams() required');
    }
    if (typeof resolveLeadProviderId !== 'function') {
      throw new TypeError('SummaryMonitor: resolveLeadProviderId() required');
    }
    this.summarize = summarize;
    this.listLiveTeams = listLiveTeams;
    this.resolveLeadProviderId = resolveLeadProviderId;
    this.intervalMs = intervalMs;
    this.logger = logger || console;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.tickOnce().catch((err) => this.logger.warn('[summary] tick failed:', err));
    }, this.intervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async tickOnce() {
    if (this.#inFlight) {
      this.logger.warn('[summary] tick skipped: previous in flight');
      return;
    }
    this.#inFlight = true;
    const startedAt = Date.now();
    let teamsPolled = 0;
    let summarizedCount = 0;
    let degradedCount = 0;
    let skippedRateLimited = 0;
    const reasons = new Set();
    try {
      const teams = await Promise.resolve(this.listLiveTeams());
      if (Array.isArray(teams) && teams.length > 0) {
        teamsPolled = teams.length;
        await Promise.all(teams.map(async (teamId) => {
          try {
            const leadProviderId = this.resolveLeadProviderId(teamId);
            const r = await this.summarize({ teamId, leadProviderId });
            if (r && typeof r === 'object') {
              if (Array.isArray(r.summarized)) summarizedCount += r.summarized.length;
              if (Array.isArray(r.degraded)) {
                degradedCount += r.degraded.length;
                for (const d of r.degraded) {
                  if (d && typeof d.reason === 'string') reasons.add(d.reason);
                }
              }
              if (Number.isFinite(r.skippedRateLimited)) {
                skippedRateLimited += r.skippedRateLimited;
              }
            }
          } catch (err) {
            this.logger.warn(`[summary] team=${teamId} failed:`, err);
          }
        }));
      }
    } catch (err) {
      this.logger.warn('[summary] tick error:', err);
    } finally {
      let state;
      if (degradedCount > 0) state = 'degraded';
      else if (skippedRateLimited > 0 && summarizedCount === 0) state = 'rate-limited';
      else state = 'idle';
      this.#status = {
        state,
        lastRunAt: startedAt,
        lastDurationMs: Date.now() - startedAt,
        teamsPolled,
        summarizedCount,
        degradedCount,
        skippedRateLimited,
        lastReasons: Array.from(reasons),
      };
      this.#inFlight = false;
    }
  }

  getStatus() {
    const s = this.#status;
    return {
      state: this.#inFlight ? 'summarizing' : s.state,
      lastRunAt: s.lastRunAt,
      lastDurationMs: s.lastDurationMs,
      teamsPolled: s.teamsPolled,
      summarizedCount: s.summarizedCount,
      degradedCount: s.degradedCount,
      skippedRateLimited: s.skippedRateLimited,
      lastReasons: [...s.lastReasons],
    };
  }
}
