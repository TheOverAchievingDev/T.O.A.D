import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePendingSpans, SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';

function span(o = {}) {
  return {
    spanId: 'span-1', agentId: 'a1', runtimeId: 'rt-1', teamId: 'team-1', sessionId: 's1',
    startedAt: '2026-05-16T00:00:00.000Z', endedAt: '2026-05-16T00:00:09.000Z',
    closed: true, rowCount: 2, tokens: 4, rows: [{ narrationId: 'n1', kind: 'tool', line: 'Reading a.js' }],
    ...o,
  };
}
const bigLimiter = () => new SummaryRateLimiter({ maxPerHour: 1000, now: () => 0 });

test('success → appendSummary called with the exact mapped fields; report.summarized', async () => {
  const appended = [];
  const report = await summarizePendingSpans({
    teamId: 'team-1',
    listAwaiting: () => [span()],
    appendSummary: (x) => { appended.push(x); return { inserted: true }; },
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'agent read a.js' }),
  });
  assert.deepEqual(report.summarized, [{ spanId: 'span-1', model: 'gemini-2.5-flash', cli: 'gemini' }]);
  assert.deepEqual(report.degraded, []);
  assert.equal(report.skippedRateLimited, 0);
  assert.deepEqual(appended, [{
    spanId: 'span-1', teamId: 'team-1', runtimeId: 'rt-1', agentId: 'a1', sessionId: 's1',
    summaryText: 'agent read a.js', model: 'gemini-2.5-flash', cli: 'gemini',
    spanStartedAt: '2026-05-16T00:00:00.000Z', spanEndedAt: '2026-05-16T00:00:09.000Z',
    rowCount: 2, tokens: 4,
  }]);
});

test('runImpl failure → degraded with the reason; NEVER appendSummary', async () => {
  let appendCalls = 0;
  const report = await summarizePendingSpans({
    teamId: 'team-1', listAwaiting: () => [span()],
    appendSummary: () => { appendCalls++; }, leadProviderId: 'gemini', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: false, reason: 'timeout' }),
  });
  assert.equal(appendCalls, 0);
  assert.deepEqual(report.degraded, [{ spanId: 'span-1', reason: 'timeout' }]);
  assert.deepEqual(report.summarized, []);
});

test('runImpl ok:true with empty summaryText → degraded reason empty_output, NEVER appendSummary', async () => {
  let appendCalls = 0;
  const report = await summarizePendingSpans({
    teamId: 'team-1', listAwaiting: () => [span()],
    appendSummary: () => { appendCalls++; },
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: '' }),
  });
  assert.equal(appendCalls, 0);
  assert.deepEqual(report.degraded, [{ spanId: 'span-1', reason: 'empty_output' }]);
  assert.deepEqual(report.summarized, []);
});

test('rate-limit → skippedRateLimited counts the current span onward; stops', async () => {
  const limiter = new SummaryRateLimiter({ maxPerHour: 1, now: () => 0 });
  const report = await summarizePendingSpans({
    teamId: 'team-1',
    listAwaiting: () => [span({ spanId: 's-a' }), span({ spanId: 's-b' }), span({ spanId: 's-c' })],
    appendSummary: () => ({ inserted: true }), leadProviderId: 'anthropic', settings: {}, limiter,
    runImpl: async () => ({ ok: true, summaryText: 'x' }),
  });
  assert.equal(report.summarized.length, 1);  // s-a acquired
  assert.equal(report.skippedRateLimited, 2); // s-b, s-c (current onward, inclusive)
});

test('maxPerRun caps the batch (settings.summarizer.maxPerRun)', async () => {
  const spans = Array.from({ length: 5 }, (_, i) => span({ spanId: `s${i}` }));
  let runs = 0;
  const report = await summarizePendingSpans({
    teamId: 'team-1', listAwaiting: () => spans, appendSummary: () => ({ inserted: true }),
    leadProviderId: 'anthropic', settings: { summarizer: { maxPerRun: 2 } }, limiter: bigLimiter(),
    runImpl: async () => { runs++; return { ok: true, summaryText: 'x' }; },
  });
  assert.equal(runs, 2);
  assert.equal(report.summarized.length, 2);
});

test('oldest-first order is preserved from listAwaiting (P3a already sorts)', async () => {
  const seen = [];
  await summarizePendingSpans({
    teamId: 'team-1',
    listAwaiting: () => [span({ spanId: 'old' }), span({ spanId: 'new' })],
    appendSummary: (x) => { seen.push(x.spanId); return { inserted: true }; },
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'x' }),
  });
  assert.deepEqual(seen, ['old', 'new']);
});

test('idempotent re-run is harmless (first-write-wins handled by appendSummary)', async () => {
  const store = new Map();
  const appendSummary = (x) => {
    if (store.has(x.spanId)) return { inserted: false, row: store.get(x.spanId) };
    store.set(x.spanId, x); return { inserted: true, row: x };
  };
  const args = {
    teamId: 'team-1', listAwaiting: () => [span()], appendSummary,
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'first' }),
  };
  await summarizePendingSpans(args);
  await summarizePendingSpans({ ...args, runImpl: async () => ({ ok: true, summaryText: 'SECOND' }) });
  assert.equal(store.size, 1);
  assert.equal(store.get('span-1').summaryText, 'first');
});

test('total: missing deps / non-array listAwaiting / listAwaiting throws → empty report, never throws', async () => {
  assert.deepEqual(await summarizePendingSpans({}), { summarized: [], degraded: [], skippedRateLimited: 0 });
  assert.deepEqual(await summarizePendingSpans({ listAwaiting: () => 'nope', appendSummary: () => {}, runImpl: async () => ({}) }), { summarized: [], degraded: [], skippedRateLimited: 0 });
  assert.deepEqual(await summarizePendingSpans({ listAwaiting: () => { throw new Error('x'); }, appendSummary: () => {}, runImpl: async () => ({}) }), { summarized: [], degraded: [], skippedRateLimited: 0 });
});

test('appendSummary throwing on a malformed span → degraded:persist_failed, never throws', async () => {
  const report = await summarizePendingSpans({
    teamId: 'team-1', listAwaiting: () => [span()],
    appendSummary: () => { throw new TypeError('spanId must be a non-empty string'); },
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'x' }),
  });
  assert.deepEqual(report.degraded, [{ spanId: 'span-1', reason: 'persist_failed' }]);
  assert.deepEqual(report.summarized, []);
});
