import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REVIEW_STATE,
  TASK_EVENT_TYPES,
  TASK_STATUS,
} from '../src/task/inMemoryTaskBoard.js';
import { SqliteTaskBoard } from '../src/task/sqliteTaskBoard.js';

function withBoard(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-sqlite-task-board-'));
  const board = new SqliteTaskBoard({ filePath: join(dir, 'toad.db') });
  try {
    testFn(board);
  } finally {
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteTaskBoard persists task events and projections', () => {
  withBoard((board) => {
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: 'lead',
      payload: { subject: 'Build runtime adapter', ownerId: 'worker-1' },
    });
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
      actorId: 'worker-1',
      payload: { status: TASK_STATUS.IN_PROGRESS },
    });

    const task = board.getTask({ teamId: 'team-a', taskId: 'runtime' });
    assert.equal(task.subject, 'Build runtime adapter');
    assert.equal(task.ownerId, 'worker-1');
    assert.equal(task.status, TASK_STATUS.IN_PROGRESS);
  });
});

test('SqliteTaskBoard derives review state from durable events', () => {
  withBoard((board) => {
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: 'lead',
      payload: { subject: 'Build runtime adapter', ownerId: 'worker-1' },
    });
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
      actorId: 'worker-1',
      payload: { status: TASK_STATUS.COMPLETED },
    });
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED,
      actorId: 'worker-1',
      payload: { reviewerId: 'lead' },
    });
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      eventType: TASK_EVENT_TYPES.REVIEW_DECIDED,
      actorId: 'lead',
      payload: { decision: 'changes_requested' },
    });

    const task = board.getTask({ teamId: 'team-a', taskId: 'runtime' });
    assert.equal(task.reviewState, REVIEW_STATE.NEEDS_FIX);
    assert.equal(task.status, TASK_STATUS.PENDING);
  });
});

test('SqliteTaskBoard task events are idempotent', () => {
  withBoard((board) => {
    const first = board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      idempotencyKey: 'create-runtime',
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: 'lead',
      payload: { subject: 'Build runtime adapter' },
    });
    const second = board.appendEvent({
      teamId: 'team-a',
      taskId: 'runtime',
      idempotencyKey: 'create-runtime',
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: 'lead',
      payload: { subject: 'Build another runtime adapter' },
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.event.eventId, first.event.eventId);
  });
});

