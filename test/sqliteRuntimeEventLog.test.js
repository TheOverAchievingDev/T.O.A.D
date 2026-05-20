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

test('SqliteRuntimeEventLog.listEventsByTask joins via runtime_instances.task_id', () => {
  withLog((log) => {
    // Two runtimes, one pinned to task-42, one to task-99
    log.db.prepare(`
      INSERT INTO teams (team_id, display_name, created_at) VALUES (?, NULL, ?)
      ON CONFLICT(team_id) DO NOTHING
    `).run('team-a', '2026-05-01T00:00:00.000Z');
    log.db.prepare(`
      INSERT INTO runtime_instances (runtime_id, team_id, agent_id, provider_id, command,
        args_json, env_json, delivery_mode, status, started_at, updated_at, task_id)
      VALUES (?, 'team-a', 'dev', 'claude', 'claude', '[]', '{}', 'runtime_stdin', 'running', ?, ?, ?)
    `).run('rt-pin-1', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'task-42');
    log.db.prepare(`
      INSERT INTO runtime_instances (runtime_id, team_id, agent_id, provider_id, command,
        args_json, env_json, delivery_mode, status, started_at, updated_at, task_id)
      VALUES (?, 'team-a', 'dev', 'claude', 'claude', '[]', '{}', 'runtime_stdin', 'running', ?, ?, ?)
    `).run('rt-pin-2', '2026-05-01T00:01:00.000Z', '2026-05-01T00:01:00.000Z', 'task-99');

    log.appendEvent({
      runtimeId: 'rt-pin-1', teamId: 'team-a', agentId: 'dev',
      eventType: 'assistant_text', payload: { text: 'on task 42' },
      createdAt: '2026-05-01T00:02:00.000Z',
    });
    log.appendEvent({
      runtimeId: 'rt-pin-1', teamId: 'team-a', agentId: 'dev',
      eventType: 'tool_use', payload: { name: 'edit' },
      createdAt: '2026-05-01T00:03:00.000Z',
    });
    log.appendEvent({
      runtimeId: 'rt-pin-2', teamId: 'team-a', agentId: 'dev',
      eventType: 'assistant_text', payload: { text: 'on task 99' },
      createdAt: '2026-05-01T00:04:00.000Z',
    });

    const t42 = log.listEventsByTask({ teamId: 'team-a', taskId: 'task-42' });
    assert.equal(t42.length, 2);
    assert.equal(t42[0].payload.text, 'on task 42');
    assert.equal(t42[1].payload.name, 'edit');
    const t99 = log.listEventsByTask({ teamId: 'team-a', taskId: 'task-99' });
    assert.equal(t99.length, 1);
    assert.equal(t99[0].payload.text, 'on task 99');
  });
});

test('SqliteRuntimeEventLog.listEventsByTask returns empty list for unknown task', () => {
  withLog((log) => {
    const result = log.listEventsByTask({ teamId: 'team-a', taskId: 'nonexistent' });
    assert.deepEqual(result, []);
  });
});

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
