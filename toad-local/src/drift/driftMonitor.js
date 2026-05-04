/**
 * Periodic + event-triggered driver for the drift engine.
 *
 *   start()  → begin a setInterval(tickOnce, intervalMs)
 *   stop()   → clear the interval
 *   tickOnce() → call engine.runDrift for every live team, in parallel
 *   notifyTaskEvent({teamId, eventType, payload})
 *            → fire an off-cycle runDrift({trigger:'task_event'}) when the
 *              transition is in TRIGGER_TRANSITIONS
 *
 * Errors from any one runDrift are swallowed (and logged) so a single
 * misbehaving team can't take the whole monitor down.
 */
const DEFAULT_INTERVAL_MS = 60_000;

const TRIGGER_TRANSITIONS = new Set([
  'review', 'testing', 'merge_ready', 'done',
]);

export class DriftMonitor {
  #timer = null;

  constructor({ engine, listLiveTeams, intervalMs = DEFAULT_INTERVAL_MS, logger = null } = {}) {
    if (!engine || typeof engine.runDrift !== 'function') {
      throw new TypeError('DriftMonitor: engine.runDrift required');
    }
    if (typeof listLiveTeams !== 'function') {
      throw new TypeError('DriftMonitor: listLiveTeams() required');
    }
    this.engine = engine;
    this.listLiveTeams = listLiveTeams;
    this.intervalMs = intervalMs;
    this.logger = logger || console;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.tickOnce().catch((err) => this.logger.warn('[drift] tick failed:', err));
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
    const teams = await Promise.resolve(this.listLiveTeams());
    if (!Array.isArray(teams) || teams.length === 0) return;
    await Promise.all(teams.map(async (teamId) => {
      try {
        await this.engine.runDrift({ teamId, trigger: 'periodic' });
      } catch (err) {
        this.logger.warn(`[drift] team=${teamId} runDrift failed:`, err);
      }
    }));
  }

  async notifyTaskEvent({ teamId, eventType, payload } = {}) {
    if (eventType !== 'task.status_changed') return;
    const to = payload?.to;
    if (typeof to !== 'string' || !TRIGGER_TRANSITIONS.has(to)) return;
    if (typeof teamId !== 'string' || teamId.length === 0) return;
    try {
      await this.engine.runDrift({ teamId, trigger: 'task_event' });
    } catch (err) {
      this.logger.warn(`[drift] team=${teamId} task_event runDrift failed:`, err);
    }
  }
}
