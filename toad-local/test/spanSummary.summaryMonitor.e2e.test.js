import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';
import { summarizePendingSpans, SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';
import { SummaryMonitor } from '../src/runtime/spanSummary/summaryMonitor.js';

test('SummaryMonitor composes a REAL LocalToadRuntime + real P3a + a FAKE runImpl: persist→excluded→idempotent (no real CLI)', async () => {
  const rt = new LocalToadRuntime();

  // §8d-ratified P2b path: tool_use for an UNREGISTERED runtime persists
  // the narration before the identity check throws; tolerate only that.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-p3b2', teamId: 'team-p3b2', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  // turn_completed (kind:system) closes the span; no identity check, no throw.
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-p3b2', teamId: 'team-p3b2', agentId: 'lead',
    createdAt: '2026-05-16T00:00:05.000Z', raw: {},
  });

  assert.equal(rt.listSpansAwaitingSummary({ teamId: 'team-p3b2' }).length, 1, 'one closed span awaiting');

  let runCalls = 0;
  const limiter = new SummaryRateLimiter({ maxPerHour: 20, now: Date.now });
  const monitor = new SummaryMonitor({
    listLiveTeams: () => ['team-p3b2'],
    resolveLeadProviderId: () => 'anthropic',
    summarize: ({ teamId, leadProviderId }) => summarizePendingSpans({
      teamId,
      leadProviderId,
      listAwaiting: (a) => rt.listSpansAwaitingSummary(a),
      appendSummary: (s) => rt.spanSummaryStore.appendSummary(s),
      runImpl: async () => { runCalls++; return { ok: true, summaryText: 'the agent read a.js' }; },
      limiter,
      settings: {},
    }),
  });

  await monitor.tickOnce();

  assert.equal(runCalls, 1, 'the (fake) runner was invoked for the one span');
  const sums = rt.listSpanSummaries({ teamId: 'team-p3b2' });
  assert.equal(sums.length, 1);
  assert.equal(sums[0].summaryText, 'the agent read a.js');
  assert.equal(sums[0].cli, 'gemini');                 // anthropic lead → gemini route
  assert.equal(sums[0].model, 'gemini-2.5-flash');
  assert.deepEqual(rt.listSpansAwaitingSummary({ teamId: 'team-p3b2' }), [], 'span no longer awaiting');

  let st = monitor.getStatus();
  assert.equal(st.summarizedCount, 1);
  assert.equal(st.degradedCount, 0);
  assert.equal(st.state, 'idle');
  assert.equal(st.teamsPolled, 1);

  // Idempotent second tick: nothing awaiting, no duplicate, fake runImpl must not fire.
  await monitor.tickOnce();
  assert.equal(rt.listSpanSummaries({ teamId: 'team-p3b2' }).length, 1, 'no duplicate summary');
  st = monitor.getStatus();
  assert.equal(st.summarizedCount, 0, 'second tick summarized nothing new');
  assert.equal(st.state, 'idle');
});
