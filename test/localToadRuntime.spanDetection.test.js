import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalReadModel } from '../src/read/LocalReadModel.js';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

const brokerStub = { listMessages: () => [] };

test('LocalReadModel.listSpans returns [] when no narrationStore', () => {
  const rm = new LocalReadModel({ broker: brokerStub });
  assert.deepEqual(rm.listSpans({ teamId: 'team-a' }), []);
});

test('LocalReadModel.listSpans groups the store narration into spans', () => {
  const narrationStore = {
    listNarration({ teamId, runtimeId }) {
      assert.equal(teamId, 'team-a');
      assert.equal(runtimeId, 'rt-1');
      return [
        { narrationId: 'n1', eventId: 'e1', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'tool_use', createdAt: '2026-05-16T00:00:00.000Z', line: 'Reading a.js', kind: 'tool', tokens: 3 },
        { narrationId: 'n2', eventId: 'e2', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'turn_completed', createdAt: '2026-05-16T00:00:05.000Z', line: 'Turn complete', kind: 'system', tokens: null },
      ];
    },
  };
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore });
  const spans = rm.listSpans({ teamId: 'team-a', runtimeId: 'rt-1' });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].spanId, 'span-n1');
  assert.equal(spans[0].closed, true);
  assert.deepEqual(spans[0].boundary, { reason: 'system', systemEventType: 'turn_completed' });
  assert.deepEqual(spans[0].rows.map((r) => r.narrationId), ['n1']);
});

test('LocalReadModel.listSpans validates teamId (mirrors listNarratedTimeline)', () => {
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore: { listNarration: () => [] } });
  assert.throws(() => rm.listSpans({}), /teamId/);
});

test('LocalToadRuntime.listSpans delegates to the read model end-to-end', async () => {
  const rt = new LocalToadRuntime();
  // §8d-ratified: a tool_use for an UNREGISTERED runtime is rejected by
  // RuntimeIdentityValidator.assertCanWrite — but RuntimeEventIngestor
  // runs #persistNarration (line 70) BEFORE the tool_use identity check
  // (line 73), so the narration row is durably written before the throw.
  // The identity rejection is expected and orthogonal to what we assert
  // (the rt -> readModel -> narrationStore -> detectSpans delegation).
  // assert.match keeps the catch honest: only the KNOWN identity error
  // is tolerated; any other ingest failure fails the test.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-s', teamId: 'team-s', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  assert.equal(
    rt.listNarratedTimeline({ teamId: 'team-s' }).length, 1,
    'tool narration durably persisted via the real runtime (anti-vacuous)',
  );
  const spans = rt.listSpans({ teamId: 'team-s' });
  assert.equal(spans.length, 1, 'one span over the single persisted tool narration (rt -> readModel -> store -> detectSpans)');
  assert.equal(spans[0].closed, false, 'trailing span open (no terminating boundary yet)');
  assert.equal(spans[0].rows[0].kind, 'tool');
});
