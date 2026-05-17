import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalReadModel } from '../src/read/LocalReadModel.js';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

const brokerStub = { listMessages: () => [] };

test('LocalReadModel.listNarratedTimeline returns [] when no narrationStore', () => {
  const rm = new LocalReadModel({ broker: brokerStub });
  assert.deepEqual(rm.listNarratedTimeline({ teamId: 'team-a' }), []);
});

test('LocalReadModel.listNarratedTimeline passes through to the store', () => {
  const calls = [];
  const narrationStore = {
    listNarration(arg) { calls.push(arg); return [{ line: 'x', kind: 'tool', tokens: null }]; },
  };
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore });
  const out = rm.listNarratedTimeline({ teamId: 'team-a', runtimeId: 'rt-1' });
  assert.deepEqual(out, [{ line: 'x', kind: 'tool', tokens: null }]);
  assert.deepEqual(calls, [{ teamId: 'team-a', runtimeId: 'rt-1' }]);
});

test('LocalToadRuntime persists narration end-to-end and reads it back (anti-inert)', async () => {
  const rt = new LocalToadRuntime();
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-e2e', teamId: 'team-e2e', agentId: 'lead',
    createdAt: '2026-05-16T00:00:00.000Z', raw: {},
  });
  const rows = rt.listNarratedTimeline({ teamId: 'team-e2e' });
  assert.equal(rows.length, 1, 'one narrated line persisted via the real runtime');
  assert.equal(rows[0].eventType, 'turn_completed');
  assert.equal(typeof rows[0].line, 'string');
  assert.ok(rt.narrationStore, 'narrationStore constructed on the runtime');
});
