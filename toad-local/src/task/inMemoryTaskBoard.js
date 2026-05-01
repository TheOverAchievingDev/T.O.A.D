import { randomUUID } from 'node:crypto';
import { assertNonEmptyString, nowIso } from '../protocol/envelopes.js';

export const TASK_EVENT_TYPES = Object.freeze({
  CREATED: 'task.created',
  ASSIGNED: 'task.assigned',
  STATUS_CHANGED: 'task.status_changed',
  COMMENT_ADDED: 'task.comment_added',
  REVIEW_REQUESTED: 'task.review_requested',
  REVIEW_STARTED: 'task.review_started',
  REVIEW_DECIDED: 'task.review_decided',
});

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  DELETED: 'deleted',
});

export const REVIEW_STATE = Object.freeze({
  NONE: 'none',
  REVIEW: 'review',
  NEEDS_FIX: 'needs_fix',
  APPROVED: 'approved',
});

export class InMemoryTaskBoard {
  #events = [];
  #idempotency = new Map();

  appendEvent(input) {
    const event = createTaskEvent(input);
    if (event.idempotencyKey) {
      const existingId = this.#idempotency.get(event.idempotencyKey);
      if (existingId) {
        return {
          inserted: false,
          event: this.#events.find((entry) => entry.eventId === existingId),
        };
      }
      this.#idempotency.set(event.idempotencyKey, event.eventId);
    }
    this.#events.push(event);
    return { inserted: true, event };
  }

  listEvents({ teamId, taskId } = {}) {
    return this.#events.filter((event) => {
      if (teamId && event.teamId !== teamId) return false;
      if (taskId && event.taskId !== taskId) return false;
      return true;
    });
  }

  getTask({ teamId, taskId }) {
    const events = this.listEvents({ teamId, taskId });
    if (events.length === 0) return null;
    return projectTask(events);
  }

  listTasks({ teamId }) {
    const byTask = new Map();
    for (const event of this.listEvents({ teamId })) {
      const list = byTask.get(event.taskId) || [];
      list.push(event);
      byTask.set(event.taskId, list);
    }
    return [...byTask.values()].map(projectTask);
  }
}

export function createTaskEvent(input) {
  const eventType = assertNonEmptyString(input.eventType, 'eventType');
  if (!Object.values(TASK_EVENT_TYPES).includes(eventType)) {
    throw new TypeError(`unsupported task event type: ${eventType}`);
  }
  return Object.freeze({
    eventId: input.eventId || randomUUID(),
    idempotencyKey: input.idempotencyKey || null,
    teamId: assertNonEmptyString(input.teamId, 'teamId'),
    taskId: assertNonEmptyString(input.taskId, 'taskId'),
    eventType,
    actorId: assertNonEmptyString(input.actorId, 'actorId'),
    createdAt: input.createdAt || nowIso(),
    payload: input.payload && typeof input.payload === 'object' ? { ...input.payload } : {},
  });
}

export function projectTask(events) {
  const ordered = [...events].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const task = {
    teamId: ordered[0].teamId,
    taskId: ordered[0].taskId,
    subject: '',
    description: '',
    ownerId: null,
    status: TASK_STATUS.PENDING,
    reviewState: REVIEW_STATE.NONE,
    comments: [],
    history: [],
    createdAt: ordered[0].createdAt,
    updatedAt: ordered[0].createdAt,
  };

  for (const event of ordered) {
    task.updatedAt = event.createdAt;
    task.history.push(event);
    if (event.eventType === TASK_EVENT_TYPES.CREATED) {
      task.subject = assertNonEmptyString(event.payload.subject, 'payload.subject');
      task.description =
        typeof event.payload.description === 'string' ? event.payload.description : task.subject;
      task.ownerId = typeof event.payload.ownerId === 'string' ? event.payload.ownerId : null;
      task.status = event.payload.status || TASK_STATUS.PENDING;
    }
    if (event.eventType === TASK_EVENT_TYPES.ASSIGNED) {
      task.ownerId = event.payload.ownerId || null;
    }
    if (event.eventType === TASK_EVENT_TYPES.STATUS_CHANGED) {
      task.status = assertNonEmptyString(event.payload.status, 'payload.status');
      if (task.status === TASK_STATUS.IN_PROGRESS || task.status === TASK_STATUS.DELETED) {
        task.reviewState = REVIEW_STATE.NONE;
      }
    }
    if (event.eventType === TASK_EVENT_TYPES.COMMENT_ADDED) {
      task.comments.push({
        commentId: event.payload.commentId || event.eventId,
        authorId: event.actorId,
        text: assertNonEmptyString(event.payload.text, 'payload.text'),
        createdAt: event.createdAt,
      });
    }
    if (event.eventType === TASK_EVENT_TYPES.REVIEW_REQUESTED) {
      task.reviewState = REVIEW_STATE.REVIEW;
    }
    if (event.eventType === TASK_EVENT_TYPES.REVIEW_STARTED) {
      task.reviewState = REVIEW_STATE.REVIEW;
    }
    if (event.eventType === TASK_EVENT_TYPES.REVIEW_DECIDED) {
      task.reviewState =
        event.payload.decision === 'approved' ? REVIEW_STATE.APPROVED : REVIEW_STATE.NEEDS_FIX;
      if (event.payload.decision === 'changes_requested') {
        task.status = TASK_STATUS.PENDING;
      }
    }
  }

  return task;
}

