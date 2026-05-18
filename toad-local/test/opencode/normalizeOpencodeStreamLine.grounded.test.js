// GROUNDED suite — locks normalizeOpencodeStreamLine to the REAL opencode
// 1.15.4 `opencode run --format json` vocabulary captured verbatim in
// docs/superpowers/grounding/2026-05-18-opencode-cli.md §8/§9/§10.
//
// Inputs are the EXACT §8 NDJSON lines (CRLF-real output): one carries a
// literal trailing `\r` to prove CRLF tolerance. §9 RATIFIED row-per-test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpencodeStreamLine } from '../../src/runtime/opencode/normalizeOpencodeStreamLine.js';

const ctx = { runtimeId: 'r1', teamId: 't1', agentId: 'dev-1' };

// Verbatim §8 lines (copied byte-for-byte from the grounding doc).
const STEP_START =
  '{"type":"step_start","timestamp":1779145027317,"sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","part":{"id":"prt_e3d4eaeee001NYz21Z2zReMg4L","messageID":"msg_e3d4ea990001B5s6x35rDX65dV","sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","snapshot":"41ef9149af1a23d082407235a255f95d2ce5055f","type":"step-start"}}';
const TEXT =
  '{"type":"text","timestamp":1779145028055,"sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","part":{"id":"prt_e3d4eb12e001rt368WFpUuD0F6","messageID":"msg_e3d4ea990001B5s6x35rDX65dV","sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","type":"text","text":"ok","time":{"start":1779145027886,"end":1779145028048}}}';
const STEP_FINISH =
  '{"type":"step_finish","timestamp":1779145028963,"sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","part":{"id":"prt_e3d4eb54e001H0z1go82mXiheA","reason":"stop","snapshot":"41ef9149af1a23d082407235a255f95d2ce5055f","messageID":"msg_e3d4ea990001B5s6x35rDX65dV","sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","type":"step-finish","tokens":{"total":7505,"input":7504,"output":1,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.00105084}}';

const TOP_LEVEL_SESSION_ID = 'ses_1c2b157c3ffesws2xivZl0UA5M';

test('§9: step_start → session_started with the TOP-LEVEL sessionID (CRLF-tolerant)', () => {
  // Append a literal trailing \r to prove CRLF tolerance on a real frame.
  const events = normalizeOpencodeStreamLine(STEP_START + '\r', ctx);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session_started');
  assert.equal(events[0].sessionId, TOP_LEVEL_SESSION_ID);
  assert.equal(events[0].runtimeId, 'r1');
  assert.equal(events[0].teamId, 't1');
  assert.equal(events[0].agentId, 'dev-1');
  assert.equal(events[0].raw.type, 'step_start');
});

test('§9: session_started.sessionId comes from top-level sessionID, NOT part', () => {
  // Construct a frame where part.sessionID differs from the top-level one.
  const line = JSON.stringify({
    type: 'step_start',
    timestamp: 1,
    sessionID: 'ses_TOP_LEVEL_WINS',
    part: { type: 'step-start', sessionID: 'ses_PART_LOSES', sessionId: 'ses_NOPE' },
  });
  const events = normalizeOpencodeStreamLine(line, ctx);

  assert.equal(events[0].type, 'session_started');
  assert.equal(events[0].sessionId, 'ses_TOP_LEVEL_WINS');
});

test('§9: text → assistant_text with part.text', () => {
  const events = normalizeOpencodeStreamLine(TEXT, ctx);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant_text');
  assert.equal(events[0].text, 'ok');
  assert.equal(events[0].raw.type, 'text');
});

test('§9: step_finish → turn_completed with grounded usage/costUsd/stopReason', () => {
  const events = normalizeOpencodeStreamLine(STEP_FINISH, ctx);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn_completed');
  assert.deepEqual(events[0].usage, {
    inputTokens: 7504,
    outputTokens: 1,
    totalTokens: 7505,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(events[0].costUsd, 0.00105084);
  assert.equal(events[0].stopReason, 'stop');
  assert.equal(events[0].raw.type, 'step_finish');
});

test('§9: unknown top-level type → runtime_event (degrade, never throw)', () => {
  const events = normalizeOpencodeStreamLine(
    JSON.stringify({ type: 'tool', timestamp: 1, sessionID: 'ses_x', part: { type: 'tool' } }),
    ctx,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'runtime_event');

  const errEvents = normalizeOpencodeStreamLine(
    JSON.stringify({ type: 'error', message: 'boom' }),
    ctx,
  );
  assert.equal(errEvents[0].type, 'runtime_event');
});

test('§9: non-{ line and blank → skip []', () => {
  assert.deepEqual(normalizeOpencodeStreamLine('some stdout warning', ctx), []);
  assert.deepEqual(normalizeOpencodeStreamLine('', ctx), []);
  assert.deepEqual(normalizeOpencodeStreamLine('   \r\n  ', ctx), []);
  assert.deepEqual(normalizeOpencodeStreamLine('[1,2,3]', ctx), []);
});

test('§9: {-prefixed broken JSON → parse_error', () => {
  const events = normalizeOpencodeStreamLine('{nope', ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'parse_error');
  assert.equal(events[0].raw, '{nope');
});

test('§9: {-prefixed broken JSON with trailing \\r still → parse_error', () => {
  const events = normalizeOpencodeStreamLine('{"type":"text"\r', ctx);
  assert.equal(events[0].type, 'parse_error');
});

test('never throws on hostile/degenerate inputs → []/no-throw', () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  assert.doesNotThrow(() => normalizeOpencodeStreamLine(null, ctx));
  assert.doesNotThrow(() => normalizeOpencodeStreamLine(undefined, ctx));
  assert.doesNotThrow(() => normalizeOpencodeStreamLine(42, ctx));
  assert.doesNotThrow(() => normalizeOpencodeStreamLine([], ctx));
  assert.doesNotThrow(() => normalizeOpencodeStreamLine(true, ctx));
  assert.doesNotThrow(() => normalizeOpencodeStreamLine(big, ctx));
  assert.doesNotThrow(() => normalizeOpencodeStreamLine({}, ctx));
  assert.doesNotThrow(() => normalizeOpencodeStreamLine(STEP_START)); // no ctx

  assert.deepEqual(normalizeOpencodeStreamLine(null, ctx), []);
  assert.deepEqual(normalizeOpencodeStreamLine(42, ctx), []);
  assert.deepEqual(normalizeOpencodeStreamLine([], ctx), []);
  assert.deepEqual(normalizeOpencodeStreamLine(true, ctx), []);
  assert.deepEqual(normalizeOpencodeStreamLine(big, ctx), []);

  // __proto__-laden JSON must not pollute or throw.
  assert.doesNotThrow(() =>
    normalizeOpencodeStreamLine('{"__proto__":{"polluted":true},"type":"text","part":{"text":"x"}}', ctx),
  );
  assert.equal({}.polluted, undefined);
});
