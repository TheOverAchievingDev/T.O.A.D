import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalReadModel } from '../src/read/LocalReadModel.js';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

const brokerStub = { listMessages: () => [] };

test('LocalReadModel.listSpanSummaries returns [] when no spanSummaryStore', () => {
  const rm = new LocalReadModel({ broker: brokerStub });
  assert.deepEqual(rm.listSpanSummaries({ teamId: 'team-a' }), []);
});

test('LocalReadModel.listSpanSummaries delegates to the store', () => {
  const calls = [];
  const spanSummaryStore = {
    listSummaries(arg) { calls.push(arg); return [{ spanId: 'span-n1', summaryText: 'x' }]; },
  };
  const rm = new LocalReadModel({ broker: brokerStub, spanSummaryStore });
  const out = rm.listSpanSummaries({ teamId: 'team-a', runtimeId: 'rt-1' });
  assert.deepEqual(out, [{ spanId: 'span-n1', summaryText: 'x' }]);
  assert.deepEqual(calls, [{ teamId: 'team-a', runtimeId: 'rt-1' }]);
});

test('listSpansAwaitingSummary composes listSpans + listSpanSummaries; teamId validated via delegation', () => {
  // One closed span via the narration store stub (tool row then a system row).
  const narrationStore = {
    listNarration: () => [
      { narrationId: 'n1', eventId: 'e1', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'tool_use', createdAt: '2026-05-16T00:00:00.000Z', line: 'Reading a.js', kind: 'tool', tokens: 3 },
      { narrationId: 'n2', eventId: 'e2', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'turn_completed', createdAt: '2026-05-16T00:00:05.000Z', line: 'Turn complete', kind: 'system', tokens: null },
    ],
  };
  let summaries = [];
  const spanSummaryStore = { listSummaries: () => summaries };
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore, spanSummaryStore });

  const awaiting = rm.listSpansAwaitingSummary({ teamId: 'team-a' });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0].closed, true);
  const spanId = awaiting[0].spanId;

  summaries = [{ spanId }];
  assert.deepEqual(rm.listSpansAwaitingSummary({ teamId: 'team-a' }), []);

  assert.throws(() => rm.listSpansAwaitingSummary({}), /teamId/);
});

test('LocalToadRuntime round-trips: persist closed-span narration -> awaiting -> appendSummary -> excluded', async () => {
  const rt = new LocalToadRuntime();
  // §8d-ratified P2b path: tool_use for an UNREGISTERED runtime persists
  // the narration (#persistNarration runs before the tool_use identity
  // check) then ingest throws; tolerate only the known identity error.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-p3a', teamId: 'team-p3a', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  // turn_completed (kind:system) closes the span; takes the early return
  // (no identity check) so this ingest does not throw.
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-p3a', teamId: 'team-p3a', agentId: 'lead',
    createdAt: '2026-05-16T00:00:05.000Z', raw: {},
  });

  const awaiting = rt.listSpansAwaitingSummary({ teamId: 'team-p3a' });
  assert.equal(awaiting.length, 1, 'one closed span awaiting summary');
  const span = awaiting[0];
  assert.equal(span.closed, true);

  rt.spanSummaryStore.appendSummary({
    spanId: span.spanId, teamId: span.teamId, runtimeId: span.runtimeId, agentId: span.agentId,
    sessionId: span.sessionId, summaryText: 'agent read a.js', model: 'haiku', cli: 'claude',
    spanStartedAt: span.startedAt, spanEndedAt: span.endedAt, rowCount: span.rowCount, tokens: span.tokens,
  });

  assert.deepEqual(rt.listSpansAwaitingSummary({ teamId: 'team-p3a' }), [], 'summarized span no longer awaiting');
  const summaries = rt.listSpanSummaries({ teamId: 'team-p3a' });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].spanId, span.spanId);
  assert.equal(summaries[0].summaryText, 'agent read a.js');
});
