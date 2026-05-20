import { shouldCompact, REASONS } from './shouldCompact.js';
import { getProviderThreshold } from './providerThresholds.js';

const DEFAULT_COOLDOWN_MS = 120_000;   // grounded default; injectable — run-and-tighten per executor Notes
const DEFAULT_RETRY_BUDGET = 2;        // 1 initial + ≤2 retries = ≤3 attempts

/**
 * Resolve the per-provider compaction threshold from SettingsStore.
 * `compaction` section: { compaction: { <providerId>: { threshold: <0..1> } } }.
 * Falls back to providerThresholds.js per-provider default, then to
 * DEFAULT_THRESHOLD. Always returns a finite fraction; never throws.
 */
export async function resolveThresholdFromSettings(settingsStore, providerId) {
  try {
    if (settingsStore && typeof settingsStore.readEffective === 'function') {
      const eff = await settingsStore.readEffective();
      const t = eff && eff.compaction && eff.compaction[providerId]
        ? eff.compaction[providerId].threshold : undefined;
      if (typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= 1) return t;
    }
  } catch { /* swallow */ }
  return getProviderThreshold(providerId).trigger;
}

/**
 * Proactive compaction trigger — the wiring sibling of CompactionHandler
 * (which is untouched and owns POST-compaction reinjection). All IO is
 * injected for hermetic tests. Reads B's getContextUsage, asks the pure
 * shouldCompact() core, and on `trigger` sends `/compact` over the same
 * adapter.sendTurn rail CompactionHandler uses, surfacing via
 * sideEffectLog + the existing runtime_event bus.
 */
export class CompactionTrigger {
  /** @type {Map<string,{gateArmed:boolean,lastFireAt:number,retriesRemaining:number,cooldownMs:number,surfacedGiveUp:boolean}>} */
  #perRuntime = new Map();

  constructor({
    adapters,
    sideEffectLog = null,
    eventBus = null,
    getContextUsage,
    getThreshold = null,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    retryBudget = DEFAULT_RETRY_BUDGET,
    now = () => Date.now(),
  }) {
    this.adapters = adapters;
    this.sideEffectLog = sideEffectLog;
    this.eventBus = eventBus;
    this.getContextUsage = getContextUsage;
    this.getThreshold = getThreshold;
    this.cooldownMs = cooldownMs;
    this.retryBudget = retryBudget;
    this.now = now;
  }

  #state(runtimeId) {
    let s = this.#perRuntime.get(runtimeId);
    if (!s) {
      s = { gateArmed: false, lastFireAt: 0, retriesRemaining: 0, cooldownMs: this.cooldownMs, surfacedGiveUp: false };
      this.#perRuntime.set(runtimeId, s);
    }
    return s;
  }

  isGated(runtimeId) {
    return this.#perRuntime.get(runtimeId)?.gateArmed === true;
  }

  async onTurnCompleted(event) {
    if (!event || !event.runtimeId) return;
    const state = this.#state(event.runtimeId);
    const usage = this.getContextUsage(event.agentId, { teamId: event.teamId });
    const threshold = this.getThreshold ? await this.getThreshold(usage.provider) : getProviderThreshold(usage.provider).trigger;
    const verdict = shouldCompact({ usage, threshold, state, now: this.now() });

    if (verdict.reason === REASONS.GIVING_UP_SURFACED && !state.surfacedGiveUp) {
      state.surfacedGiveUp = true;
      this.#emit('compaction_not_taking', event, { threshold });
      return;
    }
    if (!verdict.trigger) return;

    const isRetry = verdict.reason === REASONS.RETRY;
    await this.#fireCompact(event, usage, threshold, isRetry);
  }

  async #fireCompact(event, usage, threshold, isRetry) {
    const adapter = this.adapters?.get?.(event.runtimeId);
    if (!adapter || typeof adapter.sendTurn !== 'function') return;
    const state = this.#state(event.runtimeId);
    const idempotencyKey = `compaction-trigger:${event.runtimeId}:${this.now()}`;

    if (this.sideEffectLog) {
      this.sideEffectLog.markPending({ deliveryId: idempotencyKey, idempotencyKey, kind: 'compaction_trigger', runtimeId: event.runtimeId });
    }
    try {
      await adapter.sendTurn({
        message: {
          messageId: `compact-trigger-${event.runtimeId}-${this.now()}`,
          text: '/compact',
          metadata: { source: 'compaction_trigger', type: 'proactive_compaction' },
        },
      });
      if (this.sideEffectLog) this.sideEffectLog.markDelivered(idempotencyKey);
      // Arm / re-arm the gate.
      state.gateArmed = true;
      state.lastFireAt = this.now();
      if (isRetry) state.retriesRemaining = Math.max(0, state.retriesRemaining - 1);
      else state.retriesRemaining = this.retryBudget;
      this.#emit('compaction_triggered', event, {
        percentage: usage.percentage, threshold, retry: isRetry,
      });
    } catch {
      if (this.sideEffectLog) this.sideEffectLog.markFailed(idempotencyKey);
      // Still arm the gate: a failed send must not hot-loop next turn.
      state.gateArmed = true;
      state.lastFireAt = this.now();
      if (isRetry) state.retriesRemaining = Math.max(0, state.retriesRemaining - 1);
      else state.retriesRemaining = this.retryBudget;
    }
  }

  #emit(type, event, extra) {
    if (!this.eventBus || typeof this.eventBus.emit !== 'function') return;
    this.eventBus.emit('runtime_event', {
      type,
      runtimeId: event.runtimeId,
      teamId: event.teamId,
      agentId: event.agentId,
      ...extra,
      createdAt: new Date().toISOString(),
    });
  }

  // onCompactBoundary / onTurnFailed — Task 5 / Task 6.
  onCompactBoundary(event) {
    if (!event || !event.runtimeId) return;
    const s = this.#perRuntime.get(event.runtimeId);
    if (!s) return;
    // Confirmed: the /compact took. Disarm + reset the episode.
    s.gateArmed = false;
    s.lastFireAt = 0;
    s.retriesRemaining = 0;
    s.surfacedGiveUp = false;
  }
  onTurnFailed(event) {
    if (!event || !event.runtimeId) return;
    this.#perRuntime.delete(event.runtimeId);
  }

  forget(runtimeId) {
    this.#perRuntime.delete(runtimeId);
  }
}
