import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRuntimeEventLog } from '../src/runtime/sqliteRuntimeEventLog.js';

function withLog(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-runtime-events-'));
  const log = new SqliteRuntimeEventLog({ filePath: join(dir, 'toad.db') });
  try {
    testFn(log);
  } finally {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteRuntimeEventLog persists runtime events idempotently', () => {
  withLog((log) => {
    const first = log.appendEvent({
      idempotencyKey: 'event-once',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'assistant_text',
      sessionId: 'session-1',
      payload: { text: 'Working on it.' },
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    const second = log.appendEvent({
      idempotencyKey: 'event-once',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'assistant_text',
      sessionId: 'session-1',
      payload: { text: 'Duplicate should not insert.' },
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.event.eventId, first.event.eventId);
    assert.equal(second.event.payload.text, 'Working on it.');
    assert.equal(log.listEvents({ runtimeId: 'runtime-lead-1' }).length, 1);
  });
});
