// Grounded test suite — asserts the EXACT TOAD event shapes that the
// RATIFIED §9/§10 mapping from 2026-05-18-gemini-cli.md requires.
// Inputs are taken verbatim from §8 of that document.
// Old tests in normalizeGeminiStreamLine.test.js encoded an UNVERIFIED
// guess; this suite supersedes them on every point that diverges.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGeminiStreamLine } from '../../src/runtime/gemini/normalizeGeminiStreamLine.js';

const ctx = { runtimeId: 'r1', teamId: 't1', agentId: 'dev-1' };

// ── §8 verbatim frames ────────────────────────────────────────────────────────

const LINE_WARN = 'Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.';
const LINE_RIPGREP = 'Ripgrep is not available. Falling back to GrepTool.';
const LINE_INIT = '{"type":"init","timestamp":"2026-05-18T21:48:31.116Z","session_id":"d7108a26-61db-4261-9865-549ab9d788e6","model":"auto-gemini-3"}';
const LINE_MSG_USER = '{"type":"message","timestamp":"2026-05-18T21:48:31.117Z","role":"user","content":"Reply with exactly: ok"}';
const LINE_MSG_ASST = '{"type":"message","timestamp":"2026-05-18T21:48:34.780Z","role":"assistant","content":"ok","delta":true}';
const LINE_RESULT_OK = '{"type":"result","timestamp":"2026-05-18T21:48:34.874Z","status":"success","stats":{"total_tokens":10400,"input_tokens":10284,"output_tokens":1,"cached":0,"input":10284,"duration_ms":3759,"tool_calls":0,"models":{"gemini-3.1-pro-preview":{"total_tokens":10400,"input_tokens":10284,"output_tokens":1,"cached":0,"input":10284}}}}';

// ── §9 row 1: non-JSON warning line → skip ([], NOT parse_error) ─────────────

test('non-JSON warning line (true-color notice) is skipped — emits []', () => {
  const events = normalizeGeminiStreamLine(LINE_WARN, ctx);
  assert.deepEqual(events, []);
});

test('non-JSON ripgrep notice line is skipped — emits []', () => {
  const events = normalizeGeminiStreamLine(LINE_RIPGREP, ctx);
  assert.deepEqual(events, []);
});

// ── §9 row: JSON-shaped-but-broken → parse_error ─────────────────────────────

test('truncated JSON (looks like JSON but fails to parse) → parse_error', () => {
  const events = normalizeGeminiStreamLine('{"type":"init"', ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'parse_error');
  assert.equal(events[0].raw, '{"type":"init"');
  assert.equal(events[0].runtimeId, 'r1');
});

// ── §9 row 2: init → session_started ─────────────────────────────────────────

test('init event → session_started with session_id UUID (verbatim §8 frame)', () => {
  const events = normalizeGeminiStreamLine(LINE_INIT, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session_started');
  assert.equal(events[0].sessionId, 'd7108a26-61db-4261-9865-549ab9d788e6');
  assert.equal(events[0].runtimeId, 'r1');
  assert.equal(events[0].teamId, 't1');
  assert.equal(events[0].agentId, 'dev-1');
});

// ── §9 row 3: message/user → skip ────────────────────────────────────────────

test('user-echo message → skipped — emits [] (verbatim §8 frame)', () => {
  const events = normalizeGeminiStreamLine(LINE_MSG_USER, ctx);
  assert.deepEqual(events, []);
});

// ── §9 row 4: message/assistant → assistant_text ─────────────────────────────

test('assistant message → assistant_text with text=content (verbatim §8 frame)', () => {
  const events = normalizeGeminiStreamLine(LINE_MSG_ASST, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant_text');
  assert.equal(events[0].text, 'ok');
  assert.equal(events[0].runtimeId, 'r1');
});

// ── §9 row 5: result/success → turn_completed with usage=stats ───────────────

test('result success → turn_completed carrying usage=parsed.stats (verbatim §8 frame)', () => {
  const events = normalizeGeminiStreamLine(LINE_RESULT_OK, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn_completed');
  // usage must be the stats object itself (grounding §9: "turn_completed { usage: parsed.stats }")
  assert.ok(events[0].usage, 'turn_completed must carry usage');
  assert.equal(events[0].usage.input_tokens, 10284);
  assert.equal(events[0].usage.output_tokens, 1);
  assert.equal(events[0].usage.total_tokens, 10400);
  assert.equal(events[0].usage.duration_ms, 3759);
  assert.equal(events[0].runtimeId, 'r1');
});

// ── §9 row 6: result/non-success → turn_failed with status + usage ───────────

test('result non-success → turn_failed with status and usage', () => {
  const line = JSON.stringify({
    type: 'result',
    status: 'error',
    stats: { total_tokens: 0, input_tokens: 5, output_tokens: 0, duration_ms: 100 },
  });
  const events = normalizeGeminiStreamLine(line, ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn_failed');
  assert.equal(events[0].status, 'error');
  assert.ok(events[0].usage, 'turn_failed must carry usage');
  assert.equal(events[0].usage.input_tokens, 5);
});

// ── §9 row 7: unknown type → runtime_event (degrade, do not throw) ───────────

test('unknown type → runtime_event (graceful degrade)', () => {
  const events = normalizeGeminiStreamLine(JSON.stringify({ type: 'something_new', data: 1 }), ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'runtime_event');
});

// ── §9: never throws on any input ────────────────────────────────────────────

test('null input → [] and does not throw', () => {
  assert.doesNotThrow(() => {
    const events = normalizeGeminiStreamLine(null, ctx);
    assert.deepEqual(events, []);
  });
});

test('number input → [] and does not throw', () => {
  assert.doesNotThrow(() => {
    const events = normalizeGeminiStreamLine(42, ctx);
    assert.deepEqual(events, []);
  });
});

test('string "x" input (non-JSON, no leading brace) → [] and does not throw', () => {
  assert.doesNotThrow(() => {
    const events = normalizeGeminiStreamLine('x', ctx);
    assert.deepEqual(events, []);
  });
});

test('empty string → [] and does not throw', () => {
  assert.doesNotThrow(() => {
    const events = normalizeGeminiStreamLine('', ctx);
    assert.deepEqual(events, []);
  });
});

test('whitespace-only string → [] and does not throw', () => {
  assert.doesNotThrow(() => {
    const events = normalizeGeminiStreamLine('   ', ctx);
    assert.deepEqual(events, []);
  });
});

// ── ctx propagation ───────────────────────────────────────────────────────────

test('ctx fields are propagated to all event types', () => {
  const customCtx = { runtimeId: 'runtime-x', teamId: 'team-y', agentId: 'agent-z' };
  const events = normalizeGeminiStreamLine(LINE_INIT, customCtx);
  assert.equal(events[0].runtimeId, 'runtime-x');
  assert.equal(events[0].teamId, 'team-y');
  assert.equal(events[0].agentId, 'agent-z');
});

test('null ctx does not throw and produces null-valued fields', () => {
  assert.doesNotThrow(() => {
    const events = normalizeGeminiStreamLine(LINE_INIT, null);
    assert.equal(events[0].type, 'session_started');
    assert.equal(events[0].runtimeId, null);
  });
});
