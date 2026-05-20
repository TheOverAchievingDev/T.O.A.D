import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/opencodeExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('OpenCode turn_completed: input + output + cached (when present)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 3 }, model: 'qwen-coder' }),
  ]);
  assert.equal(r.used, 5 + 2 + 3);
  assert.equal(r.model, 'qwen-coder');
});

test('missing cached → silently 0', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'qwen-coder' }),
  ]).used, 150);
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
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { model: 'qwen-coder' })]), null);
  // Array typeof is 'object' so the gate admits it; tokens are undefined → null.
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { usage: [1, 2] })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('inFlight detection', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 5, output_tokens: 2 } }),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ]).inFlight, true);
});
