import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGeminiStreamLine } from '../../src/runtime/gemini/normalizeGeminiStreamLine.js';

const ctx = { runtimeId: 'r1', teamId: 't1', agentId: 'dev-1' };

test('init event becomes session_started with Gemini session id', () => {
  const events = normalizeGeminiStreamLine(JSON.stringify({
    type: 'init',
    session_id: 'gemini-session-1',
    model: 'gemini-2.5-flash',
  }), ctx);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session_started');
  assert.equal(events[0].sessionId, 'gemini-session-1');
  assert.equal(events[0].raw.model, 'gemini-2.5-flash');
});

test('assistant message chunks become assistant_text events', () => {
  const events = normalizeGeminiStreamLine(JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: 'hello from gemini',
    delta: true,
  }), ctx);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant_text');
  assert.equal(events[0].text, 'hello from gemini');
});

test('tool_use and tool_result become normalized tool events', () => {
  const useEvents = normalizeGeminiStreamLine(JSON.stringify({
    type: 'tool_use',
    name: 'run_shell_command',
    args: { command: 'npm test' },
  }), ctx);
  const resultEvents = normalizeGeminiStreamLine(JSON.stringify({
    type: 'tool_result',
    name: 'run_shell_command',
    result: { output: 'ok' },
  }), ctx);

  assert.equal(useEvents[0].type, 'tool_use');
  assert.equal(useEvents[0].toolName, 'run_shell_command');
  assert.deepEqual(useEvents[0].input.args, { command: 'npm test' });
  assert.equal(resultEvents[0].type, 'runtime_event');
});

test('successful result becomes turn_completed with usage=parsed.stats on the event (grounded 2026-05-18)', () => {
  // GROUNDED: §9 ratified usage lives directly on the event (not on raw),
  // keyed as `usage` and equal to `parsed.stats`. The prior assertion
  // checked `raw.usage` via the unverified `withUsageAlias` helper — that
  // was never grounded reality; corrected here.
  const events = normalizeGeminiStreamLine(JSON.stringify({
    type: 'result',
    status: 'success',
    stats: { input_tokens: 10, output_tokens: 3, duration_ms: 50 },
  }), ctx);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn_completed');
  assert.equal(events[0].usage.input_tokens, 10);
  assert.equal(events[0].usage.output_tokens, 3);
  assert.equal(events[0].usage.duration_ms, 50);
});

test('error result and error events become turn_failed', () => {
  const result = normalizeGeminiStreamLine(JSON.stringify({
    type: 'result',
    status: 'error',
    error: { message: 'quota exceeded' },
  }), ctx);
  const error = normalizeGeminiStreamLine(JSON.stringify({
    type: 'error',
    message: 'tool warning',
  }), ctx);

  assert.equal(result[0].type, 'turn_failed');
  assert.match(result[0].error, /quota exceeded/);
  assert.equal(error[0].type, 'turn_failed');
  assert.match(error[0].error, /tool warning/);
});

test('malformed and unknown lines are total and visible (grounded 2026-05-18)', () => {
  // GROUNDED: non-JSON lines that do NOT start with '{' are stdout noise
  // (warnings/notices) — they are SKIPPED, not parse_error. Only lines that
  // start with '{' and fail to parse become parse_error. The prior assertion
  // `'not json'[0].type === 'parse_error'` was ungrounded; corrected here.
  assert.deepEqual(normalizeGeminiStreamLine('', ctx), []);
  assert.deepEqual(normalizeGeminiStreamLine('not json', ctx), []); // non-'{' → skip
  assert.equal(normalizeGeminiStreamLine('{"broken"', ctx)[0].type, 'parse_error'); // '{'-prefixed bad JSON → parse_error
  assert.equal(normalizeGeminiStreamLine(JSON.stringify({ type: 'other' }), ctx)[0].type, 'runtime_event');
});
