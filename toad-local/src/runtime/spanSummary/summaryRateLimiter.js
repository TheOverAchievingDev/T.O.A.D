// In-memory rolling-hour circuit breaker (Readability Layer-2 P3b-1).
// Verbatim the drift L3 #l3RateWindow discipline (driftEngine.js:260-268):
// evict entries older than 1h; if kept >= cap, store kept and return
// false WITHOUT recording the rejected attempt; else record + true.
// KNOWN-PROPERTY: in-memory, resets on process restart (accepted L3
// precedent; do not "fix").
const WINDOW_MS = 60 * 60 * 1000;

export class SummaryRateLimiter {
  #windows = new Map();
  #maxPerHour;
  #now;

  constructor({ maxPerHour = 20, now = Date.now } = {}) {
    this.#maxPerHour =
      typeof maxPerHour === 'number' && Number.isFinite(maxPerHour) ? maxPerHour : 20;
    this.#now = typeof now === 'function' ? now : Date.now;
  }

  tryAcquire(teamId) {
    const ts = this.#now();
    const kept = (this.#windows.get(teamId) || []).filter((t) => ts - t < WINDOW_MS);
    if (kept.length >= this.#maxPerHour) {
      this.#windows.set(teamId, kept);
      return false;
    }
    this.#windows.set(teamId, [...kept, ts]);
    return true;
  }
}
