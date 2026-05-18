import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpencodeStreamLine } from '../../src/runtime/opencode/normalizeOpencodeStreamLine.js';

const ctx = { runtimeId: 'r1', teamId: 't1', agentId: 'dev-1' };

test('step_start records the OpenCode session id', () => {
  const events = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'step_start',
    sessionID: 'ses_123',
    part: { type: 'step-start' },
  }), ctx);

  assert.equal(events[0].type, 'session_started');
  assert.equal(events[0].sessionId, 'ses_123');
});

test('text events become assistant_text', () => {
  const events = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'text',
    sessionID: 'ses_123',
    part: { type: 'text', text: 'OK' },
  }), ctx);

  assert.deepEqual(events.map((e) => e.type), ['assistant_text']);
  assert.equal(events[0].text, 'OK');
});

// GROUNDED CORRECTION (SP1c Task 3): the original `type:"tool"` →
// `tool_use{toolName}` assertion encoded an UNVERIFIED guess. The real
// 1.15.4 1-turn capture (grounding doc §8/§9/§10) never produced a `tool`
// event; §10 RATIFIES unknown/unseen top-level types degrading to
// `runtime_event`. This was never real — corrected to grounded reality.
test('tool events degrade to runtime_event (shape UNVERIFIED in §10)', () => {
  const use = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'tool',
    sessionID: 'ses_123',
    part: { type: 'tool', tool: 'bash', input: { command: 'npm test' } },
  }), ctx);
  const result = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'tool',
    sessionID: 'ses_123',
    part: { type: 'tool', state: { status: 'completed', output: 'ok' } },
  }), ctx);

  assert.equal(use[0].type, 'runtime_event');
  assert.equal(result[0].type, 'runtime_event');
});

// GROUNDED CORRECTION (SP1c Task 3): the original assertion expected usage
// aliased into `raw.usage` as `{input_tokens,output_tokens}` — an
// ungrounded guess. §9 RATIFIES `turn_completed` carrying
// `usage:{inputTokens,outputTokens,totalTokens,cacheRead,cacheWrite}`,
// `costUsd`, `stopReason` on the event itself. Corrected to grounded shape.
test('step_finish completes successful turns with grounded usage', () => {
  const events = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_123',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { input: 5, output: 2, total: 7, reasoning: 1, cache: { write: 0, read: 3 } },
      cost: 0.0042,
    },
  }), ctx);

  assert.equal(events[0].type, 'turn_completed');
  assert.deepEqual(events[0].usage, {
    inputTokens: 5,
    outputTokens: 2,
    totalTokens: 7,
    cacheRead: 3,
    cacheWrite: 0,
  });
  assert.equal(events[0].costUsd, 0.0042);
  assert.equal(events[0].stopReason, 'stop');
});

// GROUNDED CORRECTION (SP1c Task 3): the original expected an `error`-reason
// `step_finish` → `turn_failed{error}`. §9/§10 only RATIFY `step_finish` →
// `turn_completed` (the error path is UNVERIFIED — §10 lists it unseen), so
// any `step_finish` is `turn_completed` and the `reason` is surfaced via
// `stopReason`. The `{nope` → parse_error assertion stays (still real).
test('error-reason step_finish still completes; malformed {-JSON → parse_error', () => {
  const finished = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'error' },
  }), ctx);
  const malformed = normalizeOpencodeStreamLine('{nope', ctx);

  assert.equal(finished[0].type, 'turn_completed');
  assert.equal(finished[0].stopReason, 'error');
  assert.equal(malformed[0].type, 'parse_error');
});

test('unknown events are preserved as runtime_event', () => {
  const events = normalizeOpencodeStreamLine(JSON.stringify({ type: 'custom', value: 1 }), ctx);

  assert.equal(events[0].type, 'runtime_event');
  assert.equal(events[0].raw.value, 1);
});
