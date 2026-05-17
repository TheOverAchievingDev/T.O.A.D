import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventIngestor } from '../src/runtime/RuntimeEventIngestor.js';

function mkEventLog() {
  const appended = [];
  return {
    appended,
    appendEvent(input) {
      const event = { eventId: `ev-${appended.length + 1}`, ...input };
      appended.push(event);
      return { inserted: true, event };
    },
    listEvents() { return appended; },
  };
}
function mkNarrationStore() {
  const rows = [];
  return {
    rows,
    appendNarration(input) { rows.push(input); return { inserted: true, row: input }; },
    listNarration() { return rows; },
  };
}
const broker = { appendMessage: () => ({ message: { id: 'm' } }) };
const ev = (type, over = {}) => ({ type, runtimeId: 'rt-1', teamId: 'team-a', agentId: 'lead', createdAt: '2026-05-16T00:00:00.000Z', ...over });

test('persists exact narrate() output for an in-scope event (turn_completed)', async () => {
  const narrationStore = mkNarrationStore();
  const ing = new RuntimeEventIngestor({ broker, eventLog: mkEventLog(), narrationStore });
  await ing.ingest(ev('turn_completed'));
  assert.equal(narrationStore.rows.length, 1);
  const r = narrationStore.rows[0];
  assert.equal(r.eventType, 'turn_completed');
  assert.equal(typeof r.line, 'string');
  assert.equal(r.kind, 'system');
  assert.equal(r.runtimeId, 'rt-1');
  assert.equal(r.teamId, 'team-a');
  assert.ok(String(r.idempotencyKey).startsWith('narration:'));
  assert.equal(r.eventId, 'ev-1');
});

test('does NOT persist a non-NARRATED event type', async () => {
  const narrationStore = mkNarrationStore();
  const ing = new RuntimeEventIngestor({ broker, eventLog: mkEventLog(), narrationStore });
  await ing.ingest(ev('compact_boundary'));
  assert.equal(narrationStore.rows.length, 0);
});

test('narrationStore absent → ingest still succeeds', async () => {
  const ing = new RuntimeEventIngestor({ broker, eventLog: mkEventLog() });
  await ing.ingest(ev('turn_completed'));
  assert.ok(true);
});

test('appendNarration throwing → ingest still succeeds AND the raw event is still appended (non-fatal)', async () => {
  const eventLog = mkEventLog();
  const narrationStore = { appendNarration() { throw new Error('db down'); }, listNarration() { return []; } };
  const ing = new RuntimeEventIngestor({ broker, eventLog, narrationStore });
  await ing.ingest(ev('turn_completed'));
  assert.equal(eventLog.appended.length, 1, 'raw runtime_events row still persisted');
});
