import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/claudeExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
function frame(usage, model = 'claude-sonnet-4-20250514') {
  return { type: 'result', subtype: 'success', model, usage };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('extracts latest result frame; sums input/output + cache_read + cache_creation', () => {
  const events = [
    ev(T0, 'turn_completed', frame({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 })),
    ev(T1, 'turn_completed', frame({ input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 })),
  ];
  const r = extractLatestUsage(events);
  assert.equal(r.used, 120 + 60 + 3000 + 0); // 3180
  assert.equal(r.model, 'claude-sonnet-4-20250514');
  assert.equal(r.lastUpdatedAt, T1);
  assert.equal(r.inFlight, false);
});

test('missing cache fields → silently 0', () => {
  const r = extractLatestUsage([ev(T0, 'turn_completed', frame({ input_tokens: 100, output_tokens: 50 }))]);
  assert.equal(r.used, 150);
});

test('non-numeric input or output → null (degraded)', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
  ]) {
    const r = extractLatestUsage([ev(T0, 'turn_completed', frame(bad))]);
    assert.equal(r, null, `bad usage=${JSON.stringify(bad)}`);
  }
});

test('no qualifying event (no turn_completed with type:result) → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'assistant_text', { type: 'assistant' })]), null);
  assert.equal(extractLatestUsage([]), null);
  assert.equal(
    extractLatestUsage([ev(T0, 'turn_completed', { type: 'error', subtype: 'max_turns' })]),
    null,
    'turn_completed with non-result raw.type must not qualify',
  );
});

test('inFlight: a newer non-result event exists after the latest result frame', () => {
  const events = [
    ev(T0, 'turn_completed', frame({ input_tokens: 100, output_tokens: 50 })),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ];
  const r = extractLatestUsage(events);
  assert.equal(r.inFlight, true);
  assert.equal(r.lastUpdatedAt, T0);
});
