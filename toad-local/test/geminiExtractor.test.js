import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/geminiExtractor.js';

// Production shape (RuntimeEventIngestor stores payload:normalized):
// e.payload = { type:'turn_completed', usage:{input_tokens,output_tokens,duration_ms?},
//                raw:<original result JSON>, ...base }
function ev(createdAt, eventType, payloadExtra) {
  return { eventType, createdAt, payload: { type: eventType, ...payloadExtra } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('Gemini turn_completed: input_tokens + output_tokens (no cache fields)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 1500, output_tokens: 300, duration_ms: 50 } }),
  ]);
  assert.equal(r.used, 1800);
  assert.equal(r.lastUpdatedAt, T0);
  assert.equal(r.inFlight, false);
});

test('any present cache-like field is IGNORED (Gemini does not surface them)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9999 } }),
  ]);
  assert.equal(r.used, 150);
});

test('latest event wins', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 } }),
    ev(T1, 'turn_completed', { usage: { input_tokens: 200, output_tokens: 80 } }),
  ]).used, 280);
});

test('missing/non-numeric tokens → null', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
  ]) {
    assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { usage: bad })]), null);
  }
});

test('no usage / no events / array-typed usage → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', {})]), null);
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { usage: [1, 2] })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('model: returned null when normalizer does not surface it (production reality)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 } }),
  ]);
  assert.equal(r.model, null, 'Gemini normalizer does not currently carry model on the event');
});

test('inFlight: newer non-result event after last turn_completed', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 } }),
    ev(T1, 'assistant_text', {}),
  ]).inFlight, true);
});
