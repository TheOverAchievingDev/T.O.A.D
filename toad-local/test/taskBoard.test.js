import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryTaskBoard,
  REVIEW_STATE,
  TASK_EVENT_TYPES,
  TASK_STATUS,
} from '../src/task/inMemoryTaskBoard.js';

test('task events project into current task state', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'Build parser', ownerId: 'worker-1' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
    actorId: 'worker-1',
    payload: { status: TASK_STATUS.IN_PROGRESS },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.COMMENT_ADDED,
    actorId: 'worker-1',
    payload: { text: 'Parser implemented.' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
    actorId: 'worker-1',
    payload: { status: TASK_STATUS.COMPLETED },
  });

  const task = board.getTask({ teamId: 'team-a', taskId: 'parser' });
  assert.equal(task.subject, 'Build parser');
  assert.equal(task.ownerId, 'worker-1');
  assert.equal(task.status, TASK_STATUS.COMPLETED);
  assert.equal(task.comments.length, 1);
});

test('review decision is derived from events', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'Build parser', ownerId: 'worker-1' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
    actorId: 'worker-1',
    payload: { status: TASK_STATUS.COMPLETED },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED,
    actorId: 'worker-1',
    payload: { reviewerId: 'lead' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.REVIEW_DECIDED,
    actorId: 'lead',
    payload: { decision: 'approved' },
  });

  const task = board.getTask({ teamId: 'team-a', taskId: 'parser' });
  assert.equal(task.reviewState, REVIEW_STATE.APPROVED);
  assert.equal(task.status, TASK_STATUS.COMPLETED);
});

test('task events are idempotent by idempotencyKey', () => {
  const board = new InMemoryTaskBoard();
  const first = board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    idempotencyKey: 'create-parser',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'Build parser' },
  });
  const second = board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    idempotencyKey: 'create-parser',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'Build parser again' },
  });

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.event.eventId, first.event.eventId);
});

