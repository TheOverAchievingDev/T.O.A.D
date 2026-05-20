import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CompactionTrigger } from '../src/runtime/compactionTrigger/CompactionTrigger.js';
import { resolveThresholdFromSettings } from '../src/runtime/compactionTrigger/CompactionTrigger.js';

const RUNTIME_ID = 'rt-1', TEAM_ID = 'team-a', AGENT_ID = 'lead';

function mockAdapter() {
  const turns = [];
  return { turns, sendTurn(i) { turns.push(i); return Promise.resolve({ accepted: true }); } };
}
function mockSideEffectLog() {
  const records = new Map();
  return {
    records,
    markPending({ idempotencyKey, kind, runtimeId, deliveryId }) {
      if (!records.has(idempotencyKey)) records.set(idempotencyKey, { idempotencyKey, kind, runtimeId, deliveryId, status: 'pending' });
    },
    markDelivered(k) { const r = records.get(k); if (r) r.status = 'delivered'; },
    markFailed(k) { const r = records.get(k); if (r) r.status = 'failed'; },
  };
}
function mockBus() {
  const events = [];
  return { events, emit(channel, payload) { events.push({ channel, payload }); } };
}
const evt = (type, over = {}) => ({ type, runtimeId: RUNTIME_ID, teamId: TEAM_ID, agentId: AGENT_ID, createdAt: '2026-05-16T00:00:00.000Z', ...over });

describe('CompactionTrigger — threshold-cross fire', () => {
  let adapters, adapter, sideEffectLog, eventBus, getContextUsage, getThreshold, trig;
  beforeEach(() => {
    adapter = mockAdapter();
    adapters = new Map([[RUNTIME_ID, adapter]]);
    sideEffectLog = mockSideEffectLog();
    eventBus = mockBus();
    getContextUsage = () => ({ percentage: 0.82, stale: false, source: 'claude', provider: 'claude' });
    getThreshold = async () => 0.70;
    trig = new CompactionTrigger({
      adapters, sideEffectLog, eventBus,
      getContextUsage, getThreshold,
      now: () => 1_000_000,
    });
  });

  it('sends exactly one /compact at idle when over threshold, logs side-effect, emits observable', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 1, 'one /compact');
    assert.equal(adapter.turns[0].message.text, '/compact');
    assert.equal(adapter.turns[0].message.metadata.source, 'compaction_trigger');
    const recs = [...sideEffectLog.records.values()];
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'compaction_trigger');
    assert.equal(recs[0].status, 'delivered');
    const fired = eventBus.events.filter((e) => e.channel === 'runtime_event' && e.payload.type === 'compaction_triggered');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].payload.runtimeId, RUNTIME_ID);
  });

  it('does not fire a second /compact while gated (in-flight)', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 1, 'still one — gated');
  });

  it('does not fire when below threshold', async () => {
    getContextUsage = () => ({ percentage: 0.40, stale: false, source: 'claude' });
    trig = new CompactionTrigger({ adapters, sideEffectLog, eventBus, getContextUsage, getThreshold, now: () => 1_000_000 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 0);
  });
});

describe('CompactionTrigger — gate / retry / give-up', () => {
  let adapters, adapter, sideEffectLog, eventBus, clock, trig;
  beforeEach(() => {
    adapter = mockAdapter();
    adapters = new Map([[RUNTIME_ID, adapter]]);
    sideEffectLog = mockSideEffectLog();
    eventBus = mockBus();
    clock = { t: 1_000_000 };
    trig = new CompactionTrigger({
      adapters, sideEffectLog, eventBus,
      getContextUsage: () => ({ percentage: 0.95, stale: false, source: 'claude' }),
      getThreshold: async () => 0.70,
      cooldownMs: 100, retryBudget: 2,
      now: () => clock.t,
    });
  });

  it('compact_boundary clears the gate so a later cross can fire again', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));      // fire #1
    assert.equal(adapter.turns.length, 1);
    assert.equal(trig.isGated(RUNTIME_ID), true);
    trig.onCompactBoundary(evt('compact_boundary'));
    assert.equal(trig.isGated(RUNTIME_ID), false);
    clock.t += 1;
    await trig.onTurnCompleted(evt('turn_completed'));      // fresh cross fires again
    assert.equal(adapter.turns.length, 2);
  });

  it('bounded retry then exactly one surfaced give-up then silence', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));      // initial fire (budget=2)
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // retry 1 (budget→1)
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // retry 2 (budget→0)
    assert.equal(adapter.turns.length, 3, '1 initial + 2 retries = 3');
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // give-up: no send, one surface
    assert.equal(adapter.turns.length, 3, 'no 4th send');
    const giveUps = eventBus.events.filter((e) => e.payload.type === 'compaction_not_taking');
    assert.equal(giveUps.length, 1);
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // still silent, no duplicate surface
    assert.equal(eventBus.events.filter((e) => e.payload.type === 'compaction_not_taking').length, 1);
  });
});

describe('CompactionTrigger — cleanup + honest-degradation', () => {
  let adapters, adapter, trig;
  beforeEach(() => {
    adapter = mockAdapter();
    adapters = new Map([[RUNTIME_ID, adapter]]);
  });

  it('stale signal never sends', async () => {
    trig = new CompactionTrigger({ adapters, getContextUsage: () => ({ percentage: 0.99, stale: true, source: 'claude' }), getThreshold: async () => 0.7, now: () => 1 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 0);
  });

  it('non-Claude (B degraded source:unknown) never sends', async () => {
    trig = new CompactionTrigger({ adapters, getContextUsage: () => ({ percentage: 0.99, stale: false, source: 'unknown', provider: 'codex' }), getThreshold: async () => 0.7, now: () => 1 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 0);
  });

  it('onTurnFailed drops per-runtime state (no leak / re-arm)', async () => {
    trig = new CompactionTrigger({ adapters, getContextUsage: () => ({ percentage: 0.99, stale: false, source: 'claude' }), getThreshold: async () => 0.7, cooldownMs: 100, now: () => 1 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(trig.isGated(RUNTIME_ID), true);
    trig.onTurnFailed(evt('turn_failed'));
    assert.equal(trig.isGated(RUNTIME_ID), false, 'state dropped');
  });
});

describe('resolveThresholdFromSettings', () => {
  it('returns project compaction.claude.threshold when set', async () => {
    const store = { readEffective: async () => ({ compaction: { claude: { threshold: 0.6 } } }) };
    assert.equal(await resolveThresholdFromSettings(store, 'claude'), 0.6);
  });
  it('falls back to DEFAULT_THRESHOLD (0.70) when providerId absent, section missing, non-finite value, or store error', async () => {
    assert.equal(await resolveThresholdFromSettings({ readEffective: async () => ({}) }), 0.70);
    assert.equal(await resolveThresholdFromSettings({ readEffective: async () => ({ compaction: { claude: { threshold: 'x' } } }) }), 0.70);
    assert.equal(await resolveThresholdFromSettings(null), 0.70);
    assert.equal(await resolveThresholdFromSettings({ readEffective: async () => { throw new Error('io'); } }), 0.70);
  });
});
