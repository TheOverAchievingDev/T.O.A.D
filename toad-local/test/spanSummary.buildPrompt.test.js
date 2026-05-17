import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPrompt, SUMMARIZER_SYSTEM_PROMPT } from '../src/runtime/spanSummary/index.js';

function span(o = {}) {
  return {
    spanId: 'span-1', agentId: 'dev-1', runtimeId: 'rt-1', teamId: 'team-1',
    sessionId: null, startedAt: '2026-05-16T00:00:00.000Z', endedAt: '2026-05-16T00:00:30.000Z',
    closed: true, rowCount: 2, tokens: 5,
    rows: [
      { narrationId: 'n1', kind: 'tool', line: 'Reading a.js' },
      { narrationId: 'n2', kind: 'text', line: 'planning the change' },
    ],
    ...o,
  };
}

test('systemPrompt is the shared constant; userPayload renders header + the row lines', () => {
  const { systemPrompt, userPayload } = buildSummaryPrompt(span());
  assert.equal(systemPrompt, SUMMARIZER_SYSTEM_PROMPT);
  assert.ok(systemPrompt.length > 0);
  assert.ok(userPayload.includes('Agent dev-1 on runtime rt-1, 2026-05-16T00:00:00.000Z – 2026-05-16T00:00:30.000Z:'));
  assert.ok(userPayload.includes('- Reading a.js'));
  assert.ok(userPayload.includes('- planning the change'));
});

test('reuses span.rows[].line verbatim — never re-narrates', () => {
  const { userPayload } = buildSummaryPrompt(span({ rows: [{ narrationId: 'x', kind: 'tool', line: 'Bash: npm test' }] }));
  assert.ok(userPayload.includes('- Bash: npm test'));
});

test('total on missing / odd input (no throw): empty rows → header only; non-object → header with unknowns', () => {
  const a = buildSummaryPrompt(span({ rows: [] }));
  assert.ok(a.userPayload.startsWith('Agent dev-1 on runtime rt-1,'));
  assert.ok(!a.userPayload.includes('\n-'));
  const b = buildSummaryPrompt(undefined);
  assert.equal(b.systemPrompt, SUMMARIZER_SYSTEM_PROMPT);
  assert.ok(b.userPayload.includes('Agent unknown on runtime unknown,'));
  const c = buildSummaryPrompt(span({ rows: [{ narrationId: 'z' }, null, { line: 42 }] }));
  assert.ok(c.userPayload.includes('- \n')); // missing line → empty
  assert.ok(c.userPayload.includes('- 42'));
});
