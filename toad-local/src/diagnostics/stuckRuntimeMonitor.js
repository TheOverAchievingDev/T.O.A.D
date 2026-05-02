import { detectStuckRuntimes, DEFAULT_THRESHOLD_MS } from './stuckRuntimeDetector.js';

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * §13 monitor. Periodically runs `detectStuckRuntimes` against the live
 * registry/event log and emits a `STUCK_RUNTIME_DETECTED` runtime_event for
 * each newly-stuck runtime. Debounces: emits at most once per runtime per
 * "stuck episode" — once a runtime ticks again and clears, a fresh stretch
 * of silence will alert again.
 *
 * Designed to be cheap. The detector is pure and the per-runtime
 * latest-event lookup is one SQL aggregation. Default cadence is 60s.
 */
export class StuckRuntimeMonitor {
  #runtimeRegistry;
  #eventLog;
  #eventBus;
  #intervalMs;
  #thresholdMs;
  #setTimer;
  #clearTimer;
  #now;

  #handle = null;
  #alerted = new Set(); // runtimeIds we've already announced as stuck this episode
  #running = false;

  constructor({
    runtimeRegistry,
    eventLog,
    eventBus,
    intervalMs = DEFAULT_INTERVAL_MS,
    thresholdMs = DEFAULT_THRESHOLD_MS,
    setTimer = setInterval,
    clearTimer = clearInterval,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!runtimeRegistry || typeof runtimeRegistry.listRuntimes !== 'function') {
      throw new TypeError('StuckRuntimeMonitor: runtimeRegistry is required');
    }
    if (!eventBus || typeof eventBus.emit !== 'function') {
      throw new TypeError('StuckRuntimeMonitor: eventBus is required');
    }
    this.#runtimeRegistry = runtimeRegistry;
    this.#eventLog = eventLog && typeof eventLog.latestEventByRuntime === 'function' ? eventLog : null;
    this.#eventBus = eventBus;
    this.#intervalMs = Math.max(1_000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.#thresholdMs = Math.max(1_000, Number(thresholdMs) || DEFAULT_THRESHOLD_MS);
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#now = typeof now === 'function' ? now : () => new Date().toISOString();
  }

  /**
   * Start the periodic check. Idempotent — calling twice is a no-op.
   */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#handle = this.#setTimer(() => {
      try {
        this.tick();
      } catch {
        // Never let a detector failure crash the runtime — drop the tick.
      }
    }, this.#intervalMs);
  }

  stop() {
    if (!this.#running) return;
    this.#running = false;
    if (this.#handle != null) {
      this.#clearTimer(this.#handle);
      this.#handle = null;
    }
    this.#alerted.clear();
  }

  /**
   * Run one detection pass. Exposed for tests so the cadence isn't required.
   * Returns the list of runtimes flagged this tick (some of which may have
   * been alerted on a prior tick — those are filtered before emit).
   */
  tick() {
    const runtimes = safeArray(this.#runtimeRegistry.listRuntimes({}));
    const latestEventByRuntime = this.#eventLog
      ? this.#eventLog.latestEventByRuntime({})
      : new Map();
    const stuck = detectStuckRuntimes({
      runtimes,
      latestEventByRuntime,
      now: this.#now(),
      thresholdMs: this.#thresholdMs,
    });

    // Recovery sweep: any runtime currently flagged but no longer stuck
    // exits the alerted set so its next stuck episode triggers a fresh
    // alert.
    const stillStuck = new Set(stuck.map((s) => s.runtimeId));
    for (const id of Array.from(this.#alerted)) {
      if (!stillStuck.has(id)) {
        this.#alerted.delete(id);
        this.#eventBus.emit('runtime_event', {
          type: 'STUCK_RUNTIME_RECOVERED',
          runtimeId: id,
          createdAt: this.#now(),
          payload: {},
        });
      }
    }

    // Announce new stuck runtimes only.
    for (const s of stuck) {
      if (this.#alerted.has(s.runtimeId)) continue;
      this.#alerted.add(s.runtimeId);
      this.#eventBus.emit('runtime_event', {
        type: 'STUCK_RUNTIME_DETECTED',
        runtimeId: s.runtimeId,
        teamId: s.teamId,
        createdAt: this.#now(),
        payload: {
          taskId: s.taskId,
          agentId: s.agentId,
          lastEventAt: s.lastEventAt,
          silentMs: s.silentMs,
          thresholdMs: s.thresholdMs,
        },
      });
    }

    return stuck;
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export const STUCK_RUNTIME_MONITOR_DEFAULTS = Object.freeze({
  INTERVAL_MS: DEFAULT_INTERVAL_MS,
  THRESHOLD_MS: DEFAULT_THRESHOLD_MS,
});
