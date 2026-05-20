import test from 'node:test';
import assert from 'node:assert/strict';
import { narrate, NARRATION_KINDS } from '../src/runtime/eventNarration/index.js';

test('NARRATION_KINDS is the frozen sealed set', () => {
  assert.deepEqual([...NARRATION_KINDS].sort(), ['system', 'text', 'tool']);
  assert.throws(() => { NARRATION_KINDS.add('x'); });
});

test('unknown / malformed event → degraded, never throws', () => {
  for (const e of [null, undefined, {}, { type: 'who' }, 5, 'x']) {
    const r = narrate(e);
    assert.equal(typeof r.line, 'string');
    assert.ok(NARRATION_KINDS.has(r.kind));
    assert.equal(r.tokens, null);
  }
});

const ev = (type, extra) => ({ type, createdAt: '2026-05-16T00:00:00.000Z', ...extra });
const tool = (toolName, input) => ev('tool_use', { toolName, input, raw: { message: { content: [{ name: toolName, input }] } } });

test('tool_use wording + kind', () => {
  assert.deepEqual(
    { line: narrate(tool('Read', { file_path: '/a/b/recorder.ts' })).line, kind: narrate(tool('Read', {})).kind },
    { line: 'Reading recorder.ts', kind: 'tool' });
  assert.equal(narrate(tool('Bash', { command: 'cargo test --all' })).line, 'Bash: cargo test --all');
  assert.equal(narrate(tool('Edit', { file_path: '/x/foo.rs' })).line, 'Edit foo.rs');
  assert.equal(narrate(tool('Write', { file_path: '/x/bar.rs' })).line, 'Write bar.rs');
  assert.equal(narrate(tool('Grep', { pattern: 'auth' })).line, 'Grep: auth');
  assert.equal(narrate(tool('Glob', { pattern: '**/*.ts' })).line, 'Glob: **/*.ts');
  assert.equal(narrate(tool('task_create', { taskId: 'T-1', subject: 'do it' })).line, 'Created task T-1 — do it');
  assert.equal(narrate(tool('message_send', { to: { agentId: 'qa' } })).line, 'Sent message → qa');
  assert.equal(narrate(tool('TodoWrite', {})).line, 'Updated todos');
  assert.equal(narrate(tool('mcp__server__do_thing', {})).line, 'Tool: do_thing');
  assert.equal(narrate(tool('mcp__server__do_thing', {})).kind, 'tool');
});

test('assistant_text → one-line truncated, kind text', () => {
  const r = narrate(ev('assistant_text', { text: 'hello\n  world  ' }));
  assert.equal(r.line, 'hello world');
  assert.equal(r.kind, 'text');
  assert.equal(narrate(ev('assistant_text', { text: '' })).line, '');
});

test('system-family events → kind system', () => {
  for (const t of ['turn_completed', 'turn_failed', 'compact_boundary', 'api_retry', 'approval_request']) {
    assert.equal(narrate(ev(t, { toolName: 'Bash', raw: {} })).kind, 'system');
  }
  assert.equal(narrate(ev('turn_completed', { raw: { result: 'ok', duration_ms: 6000 } })).line, 'Turn complete (6s)');
  assert.equal(narrate(ev('approval_request', { toolName: 'Bash' })).line, 'Awaiting approval: Bash');
});

test('tokens: num(raw.usage.output_tokens) ?? null, strict, per-type', () => {
  assert.equal(narrate({ type: 'turn_completed', raw: { usage: { output_tokens: 222 } } }).tokens, 222);
  assert.equal(narrate({ type: 'turn_failed', raw: { usage: { output_tokens: 5 } } }).tokens, 5);
  assert.equal(narrate({ type: 'turn_failed', raw: {} }).tokens, null);
  assert.equal(narrate(tool('Read', { file_path: 'a' })).tokens, null);
  assert.equal(narrate(ev('assistant_text', { text: 'hi' })).tokens, null);
  assert.equal(narrate({ type: 'turn_completed', raw: { usage: { output_tokens: '222' } } }).tokens, null); // strict
});
