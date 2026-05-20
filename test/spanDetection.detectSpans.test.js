import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSpans, SPAN_BOUNDARY_REASONS, DEFAULT_SPAN_CONFIG } from '../src/runtime/spanDetection/index.js';

// Build a narrated-stream row with sensible defaults; override per test.
function row(o) {
  const kind = o.kind ?? 'tool';
  return {
    narrationId: o.narrationId,
    idempotencyKey: o.idempotencyKey ?? null,
    eventId: o.eventId ?? null,
    runtimeId: o.runtimeId ?? 'rt-1',
    teamId: o.teamId ?? 'team-1',
    agentId: o.agentId ?? 'a1',
    sessionId: o.sessionId ?? null,
    eventType: o.eventType ?? (kind === 'tool' ? 'tool_use' : kind === 'text' ? 'assistant_text' : 'turn_completed'),
    createdAt: o.createdAt ?? '2026-05-16T00:00:00.000Z',
    line: o.line ?? '',
    kind,
    tokens: o.tokens ?? null,
  };
}

test('empty input yields no spans', () => {
  assert.deepEqual(detectSpans([]), []);
  assert.deepEqual(detectSpans(undefined), []);
  assert.deepEqual(detectSpans(null), []);
});

test('all-system input yields no spans (system never forms a span)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'system', eventType: 'turn_completed' }),
    row({ narrationId: 'n2', kind: 'system', eventType: 'compact_boundary' }),
  ]);
  assert.deepEqual(out, []);
});

test('non-object rows are skipped without throwing', () => {
  const out = detectSpans([null, undefined, 42, row({ narrationId: 'n1', kind: 'tool' }), 'bad']);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 1);
  assert.equal(out[0].rows[0].narrationId, 'n1');
});

test('a single trailing activity row is one OPEN span', () => {
  const out = detectSpans([row({ narrationId: 'n1', kind: 'tool', line: 'Reading a.js' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].spanId, 'span-n1');
  assert.equal(out[0].closed, false);
  assert.equal(out[0].boundary, null);
  assert.equal(out[0].rowCount, 1);
  assert.deepEqual(out[0].rows.map((r) => r.narrationId), ['n1']);
});

test('a text-only run forms a valid thin span', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'text', line: 'thinking' }),
    row({ narrationId: 'n2', kind: 'text', line: 'more' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
  assert.equal(out[0].closed, false);
});

test('a system row closes an open span with reason:system + systemEventType; system row not in any span', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'tool' }),
    row({ narrationId: 'n2', kind: 'tool' }),
    row({ narrationId: 'n3', kind: 'system', eventType: 'compact_boundary' }),
    row({ narrationId: 'n4', kind: 'tool' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'system', systemEventType: 'compact_boundary' });
  assert.equal(out[0].closed, true);
  assert.deepEqual(out[0].rows.map((r) => r.narrationId), ['n1', 'n2']);
  assert.equal(out[1].closed, false); // trailing n4 span open
  assert.deepEqual(out[1].rows.map((r) => r.narrationId), ['n4']);
});

test('agent-change closes the span; the differing row starts a new span', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'a1', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'a2', kind: 'tool' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'agent-change' });
  assert.equal(out[0].agentId, 'a1');
  assert.equal(out[1].agentId, 'a2');
  assert.equal(out[1].closed, false);
});

test('runtime-change closes the span (agent equal)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'a1', runtimeId: 'rt-1', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'a1', runtimeId: 'rt-2', kind: 'tool' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'runtime-change' });
  assert.equal(out[1].runtimeId, 'rt-2');
});

test('agent-change wins over a simultaneous time-gap (first trigger in order)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'a1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'a2', createdAt: '2026-05-16T01:00:00.000Z', kind: 'tool' }),
  ]);
  assert.deepEqual(out[0].boundary, { reason: 'agent-change' });
});

test('time-gap (> gapMs) splits a same-agent run', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', createdAt: '2026-05-16T00:06:00.000Z', kind: 'tool' }), // 6 min > 5 min
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'time-gap' });
  assert.equal(out[1].closed, false);
});

test('a gap at/under gapMs does NOT split', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', createdAt: '2026-05-16T00:05:00.000Z', kind: 'tool' }), // exactly 5 min, not > 5 min
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
});

test('unparseable createdAt is treated as no gap (never NaN-splits)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', createdAt: 'not-a-date', kind: 'tool' }),
    row({ narrationId: 'n2', createdAt: 'also-bad', kind: 'tool' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
});

test('size-cap on rowCount closes eagerly after the appending row', () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(row({ narrationId: `n${i}`, kind: 'tool' }));
  const out = detectSpans(rows, { gapMs: 300000, maxRows: 3, maxTokens: 1e9 });
  assert.equal(out.length, 2);
  assert.equal(out[0].rowCount, 3);
  assert.deepEqual(out[0].boundary, { reason: 'size-cap' });
  assert.equal(out[1].rowCount, 2);
  assert.equal(out[1].closed, false);
});

test('size-cap on summed tokens; a single oversized row is its own 1-row closed span', () => {
  const out = detectSpans(
    [row({ narrationId: 'n1', kind: 'tool', tokens: 9999 }), row({ narrationId: 'n2', kind: 'tool', tokens: 1 })],
    { gapMs: 300000, maxRows: 40, maxTokens: 6000 },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].rowCount, 1);
  assert.equal(out[0].tokens, 9999);
  assert.deepEqual(out[0].boundary, { reason: 'size-cap' });
  assert.equal(out[1].closed, false);
});

test('span.tokens sums row tokens with null treated as 0; embedded rows keep raw tokens', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'tool', tokens: 10 }),
    row({ narrationId: 'n2', kind: 'tool', tokens: null }),
    row({ narrationId: 'n3', kind: 'tool', tokens: 5 }),
  ]);
  assert.equal(out[0].tokens, 15);
  assert.deepEqual(out[0].rows.map((r) => r.tokens), [10, null, 5]);
});

test('embedded rows are the exact 7-field subset, in order, not re-narrated', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', eventId: 'e1', eventType: 'tool_use', kind: 'tool', line: 'Bash: ls', tokens: 3, createdAt: '2026-05-16T00:00:01.000Z' }),
  ]);
  assert.deepEqual(out[0].rows[0], {
    narrationId: 'n1', eventId: 'e1', eventType: 'tool_use', kind: 'tool', line: 'Bash: ls', tokens: 3, createdAt: '2026-05-16T00:00:01.000Z',
  });
});

test('span carries agentId/runtimeId/teamId/sessionId/startedAt/endedAt from its rows', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'dev', runtimeId: 'rt-9', teamId: 'tm', sessionId: 's1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'dev', runtimeId: 'rt-9', teamId: 'tm', sessionId: 's1', createdAt: '2026-05-16T00:00:30.000Z', kind: 'tool' }),
  ]);
  assert.equal(out[0].agentId, 'dev');
  assert.equal(out[0].runtimeId, 'rt-9');
  assert.equal(out[0].teamId, 'tm');
  assert.equal(out[0].sessionId, 's1');
  assert.equal(out[0].startedAt, '2026-05-16T00:00:00.000Z');
  assert.equal(out[0].endedAt, '2026-05-16T00:00:30.000Z');
});

test('task_* tool lines stay in-span (only kind matters, not eventType payload)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'tool', eventType: 'tool_use', line: 'Created task t_42 — x' }),
    row({ narrationId: 'n2', kind: 'tool', eventType: 'tool_use', line: 'Updated task t_42' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
});

test('deterministic: identical input yields deep-equal output', () => {
  const mk = () => [
    row({ narrationId: 'n1', kind: 'tool' }),
    row({ narrationId: 'n2', kind: 'system', eventType: 'turn_completed' }),
    row({ narrationId: 'n3', kind: 'text' }),
  ];
  assert.deepEqual(detectSpans(mk()), detectSpans(mk()));
});

test('SPAN_BOUNDARY_REASONS is the sealed expected set; DEFAULT_SPAN_CONFIG frozen', () => {
  assert.deepEqual([...SPAN_BOUNDARY_REASONS].sort(), ['agent-change', 'runtime-change', 'size-cap', 'system', 'time-gap']);
  assert.throws(() => SPAN_BOUNDARY_REASONS.add('x'), /sealed/);
  assert.ok(Object.isFrozen(DEFAULT_SPAN_CONFIG));
  assert.deepEqual({ ...DEFAULT_SPAN_CONFIG }, { gapMs: 300000, maxRows: 40, maxTokens: 6000 });
});
