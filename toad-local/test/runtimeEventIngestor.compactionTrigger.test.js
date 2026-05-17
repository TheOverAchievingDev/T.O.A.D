import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventIngestor } from '../src/runtime/RuntimeEventIngestor.js';

function calls() {
  const c = { boundary: 0, completed: 0, failed: 0 };
  return {
    c,
    onCompactBoundary() { c.boundary += 1; },
    onTurnCompleted() { c.completed += 1; return Promise.resolve(); },
    onTurnFailed() { c.failed += 1; },
  };
}
const broker = { appendMessage: () => ({ message: { id: 'm' } }) };
const baseEvent = (type) => ({ type, runtimeId: 'rt-1', teamId: 't', agentId: 'a', createdAt: '2026-05-16T00:00:00.000Z' });

test('ingestor routes turn_completed/compact_boundary/turn_failed to compactionTrigger', async () => {
  const trig = calls();
  const ing = new RuntimeEventIngestor({ broker, compactionTrigger: trig });
  await ing.ingest(baseEvent('turn_completed'));
  await ing.ingest(baseEvent('compact_boundary'));
  await ing.ingest(baseEvent('turn_failed'));
  assert.deepEqual(trig.c, { boundary: 1, completed: 1, failed: 1 });
});

test('compactionTrigger is optional — absent does not break ingest', async () => {
  const ing = new RuntimeEventIngestor({ broker });
  await ing.ingest(baseEvent('turn_completed'));   // must not throw
  assert.ok(true);
});
