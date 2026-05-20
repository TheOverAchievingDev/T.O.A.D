import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/geminiExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('Gemini turn_completed/result: input + output (no cache fields)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 1500, output_tokens: 300 }, model: 'gemini-2.5-pro' }),
  ]);
  assert.equal(r.used, 1800);
  assert.equal(r.model, 'gemini-2.5-pro');
  assert.equal(r.lastUpdatedAt, T0);
  assert.equal(r.inFlight, false);
});

test('any present cache-like field is IGNORED (Gemini does not surface them)', () => {
  // Defensive: even if a future Gemini version emits cache_*, this
  // extractor's contract is input+output only (silent 0 for cache).
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9999 }, model: 'gemini-2.5-pro' }),
  ]);
  assert.equal(r.used, 150);
});

test('latest event wins', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 100, output_tokens: 50 }, model: 'gemini-2.5-pro' }),
    ev(T1, 'turn_completed', { type: 'result', usage: { input_tokens: 200, output_tokens: 80 }, model: 'gemini-2.5-pro' }),
  ]).used, 280);
});

test('missing/non-numeric tokens → null', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
  ]) {
    assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { type: 'result', usage: bad })]), null);
  }
});

test('no usage / no events → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { type: 'result' })]), null);
  // Array typeof is 'object' → gate admits; tokens undefined → null.
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { type: 'result', usage: [1, 2] })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('turn_completed with non-result raw.type → null (Gemini requires result type, like Claude)', () => {
  assert.equal(
    extractLatestUsage([ev(T0, 'turn_completed', { type: 'error', usage: { input_tokens: 100, output_tokens: 50 } })]),
    null,
    'non-result type must not qualify even if usage is present',
  );
});

test('inFlight: newer non-result event after last result', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 100, output_tokens: 50 } }),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ]).inFlight, true);
});
