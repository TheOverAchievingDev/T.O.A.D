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

test('tool events become tool_use or runtime_event', () => {
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

  assert.equal(use[0].type, 'tool_use');
  assert.equal(use[0].toolName, 'bash');
  assert.equal(result[0].type, 'runtime_event');
});

test('step_finish aliases token usage and completes successful turns', () => {
  const events = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_123',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { input: 5, output: 2, total: 7, reasoning: 1 },
    },
  }), ctx);

  assert.equal(events[0].type, 'turn_completed');
  assert.deepEqual(events[0].raw.usage, { input_tokens: 5, output_tokens: 2 });
});

test('error-like finishes and malformed JSON are surfaced', () => {
  const failed = normalizeOpencodeStreamLine(JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'error', error: 'bad session' },
  }), ctx);
  const malformed = normalizeOpencodeStreamLine('{nope', ctx);

  assert.equal(failed[0].type, 'turn_failed');
  assert.match(failed[0].error, /bad session/);
  assert.equal(malformed[0].type, 'parse_error');
});

test('unknown events are preserved as runtime_event', () => {
  const events = normalizeOpencodeStreamLine(JSON.stringify({ type: 'custom', value: 1 }), ctx);

  assert.equal(events[0].type, 'runtime_event');
  assert.equal(events[0].raw.value, 1);
});
