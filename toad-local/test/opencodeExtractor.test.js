import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/opencodeExtractor.js';

// Production shape (RuntimeEventIngestor stores payload:normalized):
// e.payload = { type:'turn_completed', usage:{inputTokens,outputTokens,
//                totalTokens,cacheRead,cacheWrite}, costUsd, stopReason,
//                raw:<original step_finish JSON>, ...base }
function ev(createdAt, eventType, payloadExtra) {
  return { eventType, createdAt, payload: { type: eventType, ...payloadExtra } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('OpenCode turn_completed: inputTokens + outputTokens + cacheRead (when present)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cacheRead: 3, cacheWrite: 0 } }),
  ]);
  assert.equal(r.used, 5 + 2 + 3);
  assert.equal(r.lastUpdatedAt, T0);
  assert.equal(r.inFlight, false);
});

test('missing cacheRead → silently 0', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }),
  ]).used, 150);
});

test('cacheWrite is IGNORED (not part of context-window occupancy)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 9999 } }),
  ]);
  assert.equal(r.used, 150);
});

test('latest event wins', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { inputTokens: 100, outputTokens: 50 } }),
    ev(T1, 'turn_completed', { usage: { inputTokens: 200, outputTokens: 80 } }),
  ]).used, 280);
});

test('missing/non-numeric tokens → null', () => {
  for (const bad of [
    { outputTokens: 50 },
    { inputTokens: 100 },
    { inputTokens: 'x', outputTokens: 50 },
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
    ev(T0, 'turn_completed', { usage: { inputTokens: 5, outputTokens: 2 } }),
  ]);
  assert.equal(r.model, null, 'OpenCode normalizer does not currently carry model on the event');
});

test('inFlight detection', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { inputTokens: 5, outputTokens: 2 } }),
    ev(T1, 'assistant_text', {}),
  ]).inFlight, true);
});
