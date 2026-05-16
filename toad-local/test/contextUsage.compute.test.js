import test from 'node:test';
import assert from 'node:assert/strict';
import { computeContextUsage } from '../src/runtime/contextUsage/computeContextUsage.js';

// Helper: a normalized runtime-event-log row (matches #rowToEvent shape).
function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
function resultFrame(usage, model = 'claude-sonnet-4-20250514') {
  return { type: 'result', subtype: 'success', model, usage };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';
const T2 = '2026-05-16T00:10:00.000Z';
const NOW = Date.parse('2026-05-16T00:00:40.000Z'); // 10s after T1

test('used = latest result snapshot incl. cache fields + output (NOT Σ over turns)', () => {
  const events = [
    ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 })),
    ev(T1, 'turn_completed', resultFrame({ input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 })),
  ];
  const r = computeContextUsage({ events, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  // ONLY the latest turn: 120 + 3000 + 0 + 60 = 3180  (NOT 100+50+1000+200+120+60+3000)
  assert.equal(r.used, 3180);
  assert.equal(r.total, 200_000);
  assert.equal(r.percentage, Math.round((3180 / 200_000) * 1000) / 10);
  assert.equal(r.model, 'claude-sonnet-4-20250514');
  assert.equal(r.provider, 'claude');
  assert.equal(r.source, 'precise');
  assert.equal(r.lastUpdatedAt, T1);
  assert.equal(r.stale, false);
});

// Bug 1 regression guard: legacy tokensIn/tokensOut cumulative sum grew
// monotonically with session length regardless of real occupancy.
// Assert the occupancy formula does NOT exhibit that pattern.
test('Bug 1 regression guard: occupancy does NOT grow with turn count', () => {
  const small = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }))];
  const manyTurns = [];
  for (let i = 0; i < 50; i += 1) {
    manyTurns.push(ev(`2026-05-16T00:${String(i).padStart(2, '0')}:00.000Z`, 'turn_completed',
      resultFrame({ input_tokens: 100, output_tokens: 50 })));
  }
  const a = computeContextUsage({ events: small, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  const b = computeContextUsage({ events: manyTurns, now: Date.parse('2026-05-16T01:00:00.000Z'), stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(a.used, 150);
  assert.equal(b.used, 150, '50 identical turns must NOT inflate occupancy — that was Bug 1');
});

test('missing cache fields → silently 0 (legitimate for non-cached requests)', () => {
  const events = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }))];
  const r = computeContextUsage({ events, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.used, 150);
  assert.equal(r.source, 'precise');
});
test('missing/non-numeric input_tokens OR output_tokens → source:unknown, used/percentage null', () => {
  for (const bad of [
    { output_tokens: 50, cache_read_input_tokens: 10 },                 // input missing
    { input_tokens: 100, cache_read_input_tokens: 10 },                 // output missing
    { input_tokens: 'x', output_tokens: 50 },                           // input non-numeric
  ]) {
    const r = computeContextUsage({ events: [ev(T0, 'turn_completed', resultFrame(bad))], now: NOW, stalenessMs: 60_000, providerId: 'claude' });
    assert.equal(r.used, null);
    assert.equal(r.percentage, null);
    assert.equal(r.source, 'unknown');
  }
});
test('no result frame yet → degraded (used/total/percentage null, source unknown)', () => {
  const r = computeContextUsage({ events: [ev(T0, 'assistant_text', { type: 'assistant' })], now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.used, null);
  assert.equal(r.total, null);
  assert.equal(r.percentage, null);
  assert.equal(r.source, 'unknown');
});
test('unknown model → total/percentage null, source unknown (never guess denominator)', () => {
  const events = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }, 'gpt-future-x'))];
  const r = computeContextUsage({ events, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.used, 150);          // occupancy still known
  assert.equal(r.total, null);
  assert.equal(r.percentage, null);
  assert.equal(r.source, 'unknown');  // can't express % honestly
});
test('result frame with a non-string createdAt → degraded, never confidently-fresh (honest degradation)', () => {
  // A turn_completed/result row whose createdAt is missing must NOT be
  // selected as the snapshot anchor (Date.parse(undefined)=NaN would
  // otherwise pin stale:false forever). It degrades honestly instead.
  const bad = { eventType: 'turn_completed', createdAt: undefined,
    payload: { raw: resultFrame({ input_tokens: 100, output_tokens: 50 }) } };
  const r = computeContextUsage({ events: [bad], now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.used, null);
  assert.equal(r.percentage, null);
  assert.equal(r.source, 'unknown');
  assert.equal(r.stale, true, 'must NOT read confidently-fresh off a malformed-timestamp result');
});
test('stale = true only when idle beyond window with NO newer activity', () => {
  const events = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }))];
  // now is 10 min after the only (T0) result, > 60s window, no newer events
  const r = computeContextUsage({ events, now: Date.parse(T2), stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.stale, true);
  assert.equal(r.used, 150, 'value still the last known snapshot even when stale');
});

// §3 in-flight pin, locked in code. No turn_started event exists;
// "in flight" = activity newer than the last result frame.
test('in-flight turn (events newer than last result frame) → stale:false even past window', () => {
  const events = [
    ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 })),
    ev(T2, 'tool_use', { type: 'assistant' }), // activity AFTER the last result, no newer result yet
  ];
  // now is just after T2, far past the 60s window relative to T0
  const r = computeContextUsage({ events, now: Date.parse(T2) + 1000, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.stale, false, 'a turn is in flight (newer activity than last result) — not stale');
  assert.equal(r.used, 150, 'value is the previous completed snapshot until the in-flight turn completes');
  assert.equal(r.lastUpdatedAt, T0);
});
test('non-array / empty events → degraded, never throws', () => {
  for (const e of [null, undefined, [], 'x', 5]) {
    const r = computeContextUsage({ events: e, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
    assert.equal(r.source, 'unknown');
    assert.equal(r.used, null);
  }
});
