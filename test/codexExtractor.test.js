import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/codexExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('Codex turn_completed: input + output + cached + reasoning', () => {
  const events = [
    ev(T0, 'turn_completed', { usage: { input_tokens: 57114, cached_input_tokens: 30848, output_tokens: 568, reasoning_output_tokens: 377 }, model: 'gpt-5-codex' }),
  ];
  const r = extractLatestUsage(events);
  assert.equal(r.used, 57114 + 568 + 30848 + 377); // 88907
  assert.equal(r.model, 'gpt-5-codex');
  assert.equal(r.lastUpdatedAt, T0);
  assert.equal(r.inFlight, false);
});

test('missing cached/reasoning → silently 0', () => {
  const r = extractLatestUsage([ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'gpt-5-codex' })]);
  assert.equal(r.used, 150);
});

test('latest turn_completed wins', () => {
  const events = [
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'gpt-5-codex' }),
    ev(T1, 'turn_completed', { usage: { input_tokens: 200, output_tokens: 80 }, model: 'gpt-5-codex' }),
  ];
  assert.equal(extractLatestUsage(events).used, 280);
});

test('missing or non-numeric input/output → null', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
    {}, // no usage fields
  ]) {
    assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { usage: bad })]), null, `bad=${JSON.stringify(bad)}`);
  }
});

test('no usage object at all → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { model: 'gpt-5-codex' })]), null);
  // Array typeof is 'object' so the gate admits it, but u.input_tokens
  // is undefined → num() → null → extractor returns null. Lock that edge.
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { usage: [1, 2] })]), null);
});

test('no qualifying event → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'assistant_text', { type: 'assistant' })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('inFlight: newer non-result event after the last turn_completed', () => {
  const events = [
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'gpt-5-codex' }),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ];
  assert.equal(extractLatestUsage(events).inFlight, true);
});
