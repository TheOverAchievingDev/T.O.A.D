import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexExecLine } from '../../src/runtime/codex/normalizeCodexExecLine.js';

const ctx = { runtimeId: 'r1', teamId: 't1', agentId: 'a1' };

test('thread.started → session_started carrying the session id', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' }), ctx);
  assert.deepEqual(ev, [{ ...ctx, type: 'session_started', sessionId: 'sess-1', raw: { type: 'thread.started', thread_id: 'sess-1' } }]);
});

test('item.completed agent_message → assistant_text', () => {
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done it' } });
  const ev = normalizeCodexExecLine(line, ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'assistant_text');
  assert.equal(ev[0].text, 'done it');
  assert.equal(ev[0].runtimeId, 'r1');
});

test('item.completed command_execution / file_change / mcp_tool_call → tool_use-shaped', () => {
  for (const itemType of ['command_execution', 'file_change', 'mcp_tool_call']) {
    const ev = normalizeCodexExecLine(JSON.stringify({ type: 'item.completed', item: { type: itemType, foo: 1 } }), ctx);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'tool_use');
    assert.equal(ev[0].toolName, itemType);
    assert.deepEqual(ev[0].input, { type: itemType, foo: 1 });
  }
});

test('turn.completed → turn_completed', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'turn.completed' }), ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'turn_completed');
});

test('error (standalone string message) → turn_failed', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'error', message: 'boom' }), ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'turn_failed');
  assert.equal(ev[0].error, 'boom');
});

test('turn.failed (NESTED error:{message}) → turn_failed extracts the nested message (0.130 shape)', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }), ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'turn_failed');
  assert.equal(ev[0].error, 'usage limit reached');
});

test('turn.started (NEW in 0.130) → runtime_event, never throws', () => {
  let ev;
  assert.doesNotThrow(() => { ev = normalizeCodexExecLine(JSON.stringify({ type: 'turn.started' }), ctx); });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'runtime_event');
});

test('non-JSON line → parse_error (never throws)', () => {
  let ev;
  assert.doesNotThrow(() => { ev = normalizeCodexExecLine('codex: warming up...', ctx); });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'parse_error');
  assert.equal(ev[0].raw, 'codex: warming up...');
});

test('unknown/empty/malformed → [] or runtime_event, never throws', () => {
  assert.doesNotThrow(() => normalizeCodexExecLine('', ctx));
  assert.deepEqual(normalizeCodexExecLine('', ctx), []);
  assert.deepEqual(normalizeCodexExecLine('   ', ctx), []);
  const unknown = normalizeCodexExecLine(JSON.stringify({ type: 'something.else' }), ctx);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].type, 'runtime_event');
  assert.doesNotThrow(() => normalizeCodexExecLine(JSON.stringify({ type: 'item.completed' }), ctx));
  assert.doesNotThrow(() => normalizeCodexExecLine(JSON.stringify(null), ctx));
});
