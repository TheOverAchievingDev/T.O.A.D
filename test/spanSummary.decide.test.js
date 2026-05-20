import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSpansToSummarize } from '../src/runtime/spanSummary/index.js';

// Minimal Span stub; only the fields the decide core reads.
function span(o) {
  return {
    spanId: o.spanId,
    closed: o.closed ?? true,
    startedAt: o.startedAt ?? '2026-05-16T00:00:00.000Z',
    // carried-but-unused-by-core fields, present for realism:
    agentId: 'a1', runtimeId: 'rt-1', teamId: 'team-1',
  };
}

test('empty / non-array spans yields []', () => {
  assert.deepEqual(decideSpansToSummarize({ spans: [], summarizedSpanIds: new Set() }), []);
  assert.deepEqual(decideSpansToSummarize({ spans: undefined }), []);
  assert.deepEqual(decideSpansToSummarize({}), []);
  assert.deepEqual(decideSpansToSummarize(), []);
});

test('open spans are always excluded', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 's1', closed: false }), span({ spanId: 's2', closed: true })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s2']);
});

test('already-summarized spanIds are excluded (Set)', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 's1' }), span({ spanId: 's2' }), span({ spanId: 's3' })],
    summarizedSpanIds: new Set(['s2']),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s1', 's3']);
});

test('summarizedSpanIds accepted as an array too', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 's1' }), span({ spanId: 's2' })],
    summarizedSpanIds: ['s1'],
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s2']);
});

test('oldest-first by startedAt ascending', () => {
  const out = decideSpansToSummarize({
    spans: [
      span({ spanId: 'late', startedAt: '2026-05-16T03:00:00.000Z' }),
      span({ spanId: 'early', startedAt: '2026-05-16T01:00:00.000Z' }),
      span({ spanId: 'mid', startedAt: '2026-05-16T02:00:00.000Z' }),
    ],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['early', 'mid', 'late']);
});

test('spanId ascending tiebreak when startedAt equal', () => {
  const t = '2026-05-16T01:00:00.000Z';
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 'zzz', startedAt: t }), span({ spanId: 'aaa', startedAt: t }), span({ spanId: 'mmm', startedAt: t })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['aaa', 'mmm', 'zzz']);
});

test('unparseable startedAt sorts as 0 and never throws', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 'good', startedAt: '2026-05-16T01:00:00.000Z' }), span({ spanId: 'bad', startedAt: 'not-a-date' })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['bad', 'good']);
});

test('non-object / missing-spanId entries are skipped, no throw', () => {
  const out = decideSpansToSummarize({
    spans: [null, undefined, 42, 'x', { closed: true }, span({ spanId: 's1' })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s1']);
});

test('deterministic: identical input yields deep-equal output', () => {
  const mk = () => ({
    spans: [span({ spanId: 'b', startedAt: '2026-05-16T02:00:00.000Z' }), span({ spanId: 'a', startedAt: '2026-05-16T01:00:00.000Z' })],
    summarizedSpanIds: new Set(['x']),
  });
  assert.deepEqual(decideSpansToSummarize(mk()), decideSpansToSummarize(mk()));
});
