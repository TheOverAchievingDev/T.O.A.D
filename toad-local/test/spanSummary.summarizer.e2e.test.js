import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';
import { summarizePendingSpans, SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';

test('engine composes with a REAL LocalToadRuntime + P3a: persist→awaiting→summarize→excluded→idempotent (no real CLI)', async () => {
  const rt = new LocalToadRuntime();
  // §8d-ratified P2b path: tool_use for an UNREGISTERED runtime persists
  // the narration before the identity check throws; tolerate only that.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-p3b1', teamId: 'team-p3b1', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  // turn_completed (kind:system) closes the span; no identity check, no throw.
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-p3b1', teamId: 'team-p3b1', agentId: 'lead',
    createdAt: '2026-05-16T00:00:05.000Z', raw: {},
  });

  assert.equal(rt.listSpansAwaitingSummary({ teamId: 'team-p3b1' }).length, 1, 'one closed span awaiting');

  let runCalls = 0;
  const report = await summarizePendingSpans({
    teamId: 'team-p3b1',
    listAwaiting: (a) => rt.listSpansAwaitingSummary(a),
    appendSummary: (s) => rt.spanSummaryStore.appendSummary(s),
    leadProviderId: 'anthropic',
    settings: {},
    limiter: new SummaryRateLimiter({ maxPerHour: 20, now: Date.now }),
    runImpl: async () => { runCalls++; return { ok: true, summaryText: 'the agent read a.js' }; },
  });

  assert.equal(runCalls, 1, 'the (fake) runner was invoked for the one span');
  assert.equal(report.summarized.length, 1);
  assert.equal(report.degraded.length, 0);

  const sums = rt.listSpanSummaries({ teamId: 'team-p3b1' });
  assert.equal(sums.length, 1);
  assert.equal(sums[0].summaryText, 'the agent read a.js');
  assert.equal(sums[0].cli, 'gemini');
  assert.equal(sums[0].model, 'gemini-2.5-flash');
  assert.deepEqual(rt.listSpansAwaitingSummary({ teamId: 'team-p3b1' }), [], 'span no longer awaiting');

  // Idempotent second run: nothing new, no duplicate, no throw.
  const report2 = await summarizePendingSpans({
    teamId: 'team-p3b1',
    listAwaiting: (a) => rt.listSpansAwaitingSummary(a),
    appendSummary: (s) => rt.spanSummaryStore.appendSummary(s),
    leadProviderId: 'anthropic', settings: {},
    limiter: new SummaryRateLimiter({ maxPerHour: 20, now: Date.now }),
    runImpl: async () => { throw new Error('must not be called — nothing awaiting'); },
  });
  assert.deepEqual(report2, { summarized: [], degraded: [], skippedRateLimited: 0 });
  assert.equal(rt.listSpanSummaries({ teamId: 'team-p3b1' }).length, 1);
});
