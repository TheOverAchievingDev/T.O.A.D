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
  VALIDATION_RUN: 'task.validation_run',
  PLAN_PROPOSED: 'task.plan_proposed',
  PLAN_APPROVED: 'task.plan_approved',
  PLAN_REJECTED: 'task.plan_rejected',
  WORKTREE_CREATED: 'task.worktree_created',
  WORKTREE_REMOVED: 'task.worktree_removed',
  RISK_CLASSIFIED: 'task.risk_classified',
  HUMAN_APPROVED: 'task.human_approved',
  INTEGRATION_MERGED: 'task.integration_merged',
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

export const TASK_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

// M.1b: task type discriminator. 'feature' (default) tasks go through the
// plan-propose-approve cycle; 'bug' tasks skip planning and go straight to
// reproduce → root-cause → fix → verify. Drives ROLE_GUIDANCE branches in
// teamSystemPrompts.js — see the spec at
// docs/specs/2026-05-10-maintenance-mode-m1b-bug-fix-task-type-design.md.
export const TASK_TYPES = Object.freeze(['feature', 'bug']);

export class InMemoryTaskBoard {
  #events = [];
  #idempotency = new Map();
  #subscribers = new Set();

  /**
   * Register a subscriber that fires AFTER each successfully-inserted event.
   * Returns an unsubscribe function. Subscribers do NOT fire on idempotent
   * dedup hits — only on actually-new events. Subscriber exceptions are
   * caught and logged so a misbehaving subscriber can't break event
   * persistence (the orchestrator must always succeed regardless).
   *
   * Used by DriftMonitor to fire off-cycle drift runs on lifecycle
   * transitions; future slices may add audit / SSE / webhook subscribers.
   */
  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('InMemoryTaskBoard.subscribe: fn must be a function');
    }
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

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
    this.#fireSubscribers(event);
    return { inserted: true, event };
  }

  #fireSubscribers(event) {
    for (const fn of this.#subscribers) {
      try {
        fn(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[taskBoard] subscriber threw:', err && err.message ? err.message : err);
      }
    }
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
    review: null,
    plan: null,
    worktree: null,
    baseRef: null,
    baseBranch: null,
    allowedFiles: [],
    forbiddenFiles: [],
    acceptanceCriteria: [],
    riskLevel: null,
    type: 'feature',
    requiresHumanApproval: false,
    humanApproval: { approved: false },
    integration: null,
    priority: null,
    assignedRole: null,
    testCommands: [],
    expectedDeliverables: [],
    dependencyTaskIds: [],
    validations: [],
    latestValidation: {},
    consecutiveTestFailures: 0,
    repeatedTestFailures: false,
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
      // §8 slice 4: explicit baseRef + baseBranch capture at task creation.
      // Operator-supplied; replaces the HEAD-at-planning fallback when set.
      if (typeof event.payload.baseRef === 'string' && event.payload.baseRef.length > 0) {
        task.baseRef = event.payload.baseRef;
      }
      if (typeof event.payload.baseBranch === 'string' && event.payload.baseBranch.length > 0) {
        task.baseBranch = event.payload.baseBranch;
      }
      task.allowedFiles = normalizeStringList(event.payload.allowedFiles);
      task.forbiddenFiles = normalizeStringList(event.payload.forbiddenFiles);
      task.acceptanceCriteria = normalizeStringList(event.payload.acceptanceCriteria);
      task.riskLevel = normalizeRiskLevel(event.payload.riskLevel);
      // M.1b: task type. Invalid / missing values fall back to 'feature'
      // (defensive default — legacy events created before this slice all
      // project as 'feature' so back-compat is automatic).
      const rawType = event.payload?.type;
      task.type = TASK_TYPES.includes(rawType) ? rawType : 'feature';
      task.requiresHumanApproval = event.payload.requiresHumanApproval === true;
      // §1 follow-up: priority / assignedRole / testCommands /
      // expectedDeliverables / dependencyTaskIds — all optional.
      task.priority = typeof event.payload.priority === 'string' ? event.payload.priority : null;
      task.assignedRole = typeof event.payload.assignedRole === 'string' ? event.payload.assignedRole : null;
      task.testCommands = normalizeStringList(event.payload.testCommands);
      task.expectedDeliverables = normalizeStringList(event.payload.expectedDeliverables);
      task.dependencyTaskIds = normalizeStringList(event.payload.dependencyTaskIds);
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
      task.review = {
        state: 'requested',
        reviewerId: typeof event.payload.reviewerId === 'string' ? event.payload.reviewerId : null,
        summary: typeof event.payload.summary === 'string' ? event.payload.summary : null,
        diff: typeof event.payload.diff === 'string' ? event.payload.diff : null,
        files: Array.isArray(event.payload.files)
          ? event.payload.files.filter((f) => typeof f === 'string')
          : [],
        scopeDrift: Array.isArray(event.payload.scopeDrift)
          ? event.payload.scopeDrift.filter((f) => typeof f === 'string')
          : [],
        noOpDiff: event.payload.noOpDiff === true,
        requestedBy: event.actorId,
        requestedAt: event.createdAt,
      };
    }
    if (event.eventType === TASK_EVENT_TYPES.REVIEW_STARTED) {
      task.reviewState = REVIEW_STATE.REVIEW;
    }
    if (event.eventType === TASK_EVENT_TYPES.PLAN_PROPOSED) {
      const p = event.payload || {};
      task.plan = {
        state: 'proposed',
        summary: typeof p.summary === 'string' ? p.summary : null,
        filesExpectedToChange: Array.isArray(p.filesExpectedToChange)
          ? p.filesExpectedToChange.filter((f) => typeof f === 'string')
          : [],
        approach: Array.isArray(p.approach) ? p.approach.filter((s) => typeof s === 'string') : [],
        risks: Array.isArray(p.risks) ? p.risks.filter((s) => typeof s === 'string') : [],
        validationPlan: Array.isArray(p.validationPlan) ? p.validationPlan.filter((s) => typeof s === 'string') : [],
        requiresApproval: typeof p.requiresApproval === 'boolean' ? p.requiresApproval : true,
        proposedBy: event.actorId,
        proposedAt: event.createdAt,
      };
    }
    if (event.eventType === TASK_EVENT_TYPES.PLAN_APPROVED) {
      if (task.plan) {
        task.plan = {
          ...task.plan,
          state: 'approved',
          decidedBy: event.actorId,
          decidedAt: event.createdAt,
          reason: typeof event.payload?.reason === 'string' ? event.payload.reason : null,
        };
      }
    }
    if (event.eventType === TASK_EVENT_TYPES.PLAN_REJECTED) {
      if (task.plan) {
        task.plan = {
          ...task.plan,
          state: 'rejected',
          decidedBy: event.actorId,
          decidedAt: event.createdAt,
          reason: typeof event.payload?.reason === 'string' ? event.payload.reason : null,
        };
      }
    }
    if (event.eventType === TASK_EVENT_TYPES.WORKTREE_CREATED) {
      const p = event.payload || {};
      const status = p.status === 'created' ? 'created' : 'skipped';
      task.worktree = status === 'created'
        ? {
            status: 'created',
            path: typeof p.path === 'string' ? p.path : null,
            branch: typeof p.branch === 'string' ? p.branch : null,
            baseRef: typeof p.baseRef === 'string' ? p.baseRef : null,
            createdAt: typeof p.createdAt === 'string' ? p.createdAt : event.createdAt,
          }
        : {
            status: 'skipped',
            reason: typeof p.reason === 'string' ? p.reason : 'unknown',
          };
    }
    if (event.eventType === TASK_EVENT_TYPES.WORKTREE_REMOVED) {
      const p = event.payload || {};
      // Preserve branch/baseRef from the prior 'created' projection so the audit
      // trail still answers "what branch did this task work on?" after removal.
      task.worktree = {
        ...(task.worktree || {}),
        status: 'removed',
        path: typeof p.path === 'string' ? p.path : (task.worktree?.path ?? null),
        removedAt: typeof p.removedAt === 'string' ? p.removedAt : event.createdAt,
        ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
      };
    }
    if (event.eventType === TASK_EVENT_TYPES.RISK_CLASSIFIED) {
      // §14: classifier may only ELEVATE riskLevel and FLIP requiresHumanApproval
      // to true. Demotion via this event is ignored (the classifier is monotonic
      // upward; an event that proposes a lower level is treated as a no-op).
      const p = event.payload || {};
      const proposedLevel = typeof p.riskLevel === 'string' ? p.riskLevel : null;
      const currentRank = TASK_RISK_LEVELS.indexOf(task.riskLevel);
      const proposedRank = TASK_RISK_LEVELS.indexOf(proposedLevel);
      if (proposedRank > currentRank) {
        task.riskLevel = proposedLevel;
      }
      if (p.requiresHumanApproval === true) {
        task.requiresHumanApproval = true;
      }
    }
    if (event.eventType === TASK_EVENT_TYPES.HUMAN_APPROVED) {
      const p = event.payload || {};
      task.humanApproval = {
        approved: true,
        approvedBy: event.actorId,
        approvedAt: event.createdAt,
        ...(typeof p.reason === 'string' && p.reason.length > 0 ? { reason: p.reason } : {}),
      };
    }
    if (event.eventType === TASK_EVENT_TYPES.INTEGRATION_MERGED) {
      const p = event.payload || {};
      task.integration = {
        status: typeof p.status === 'string' ? p.status : 'merged',
        baseBranch: typeof p.baseBranch === 'string' ? p.baseBranch : null,
        mergeCommit: typeof p.mergeCommit === 'string' ? p.mergeCommit : null,
        parents: Array.isArray(p.parents) ? [...p.parents] : null,
        mergedAt: typeof p.mergedAt === 'string' ? p.mergedAt : event.createdAt,
        reason: typeof p.reason === 'string' ? p.reason : null,
        remotePolicy:
          p.remotePolicy && typeof p.remotePolicy === 'object'
            ? { reason: typeof p.remotePolicy.reason === 'string' ? p.remotePolicy.reason : null }
            : null,
      };
    }
    if (event.eventType === TASK_EVENT_TYPES.VALIDATION_RUN) {
      const payload = event.payload || {};
      const kind = typeof payload.kind === 'string' ? payload.kind : null;
      if (kind) {
        const record = {
          kind,
          command: typeof payload.command === 'string' ? payload.command : null,
          exitCode: Number.isFinite(payload.exitCode) ? payload.exitCode : null,
          durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
          verdict: typeof payload.verdict === 'string' ? payload.verdict : 'not_run',
          stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
          stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
          stdoutTruncated: Boolean(payload.stdoutTruncated),
          stderrTruncated: Boolean(payload.stderrTruncated),
          actorId: event.actorId,
          createdAt: event.createdAt,
        };
        task.validations.push(record);
        task.latestValidation[kind] = record;
      }
    }
    if (event.eventType === TASK_EVENT_TYPES.REVIEW_DECIDED) {
      task.reviewState =
        event.payload.decision === 'approved' ? REVIEW_STATE.APPROVED : REVIEW_STATE.NEEDS_FIX;
      if (event.payload.decision === 'changes_requested') {
        task.status = TASK_STATUS.PENDING;
      }
      task.review = {
        ...(task.review || {}),
        state: 'decided',
        decision: typeof event.payload.decision === 'string' ? event.payload.decision : null,
        reason: typeof event.payload.reason === 'string' ? event.payload.reason : null,
        feedback: Array.isArray(event.payload.feedback)
          ? event.payload.feedback.filter(
              (f) => f && typeof f.file === 'string' && typeof f.comment === 'string',
            ).map((f) => {
              const out = { file: f.file, comment: f.comment };
              // §17: severity is optional; only persist known values.
              if (typeof f.severity === 'string' && ['nit', 'minor', 'major', 'blocking'].includes(f.severity)) {
                out.severity = f.severity;
              }
              return out;
            })
          : [],
        decidedBy: event.actorId,
        decidedAt: event.createdAt,
      };
    }
  }

  // §13 partial: repeated-test-failure detector. Counts the trailing streak
  // of test runs whose verdict is 'failed'. A passing run resets the count
  // to 0. Non-test validation runs (lint/typecheck/etc.) are skipped — only
  // test verdicts matter for this signal. `repeatedTestFailures` flips true
  // at three or more consecutive failures.
  const testRuns = task.validations.filter((v) => v && v.kind === 'test');
  let streak = 0;
  for (let i = testRuns.length - 1; i >= 0; i--) {
    if (testRuns[i].verdict === 'failed') {
      streak++;
    } else {
      break;
    }
  }
  task.consecutiveTestFailures = streak;
  task.repeatedTestFailures = streak >= 3;

  return task;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function normalizeRiskLevel(value) {
  if (typeof value !== 'string') return null;
  return TASK_RISK_LEVELS.includes(value) ? value : null;
}
