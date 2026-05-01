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

test('projectTask collects review.diff/files/summary into task.review on REVIEW_REQUESTED', () => {
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
    eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED,
    actorId: 'worker-1',
    payload: {
      reviewerId: 'lead',
      summary: 'Implements LL(1) parser',
      diff: '--- a/parser.js\n+++ b/parser.js\n@@ -0,0 +1 @@\n+export const parse = ()=>{};',
      files: ['parser.js', 'parser.test.js'],
    },
  });

  const task = board.getTask({ teamId: 'team-a', taskId: 'parser' });
  assert.ok(task.review, 'task.review should be populated by REVIEW_REQUESTED');
  assert.equal(task.review.state, 'requested');
  assert.equal(task.review.reviewerId, 'lead');
  assert.equal(task.review.summary, 'Implements LL(1) parser');
  assert.match(task.review.diff, /export const parse/);
  assert.deepEqual(task.review.files, ['parser.js', 'parser.test.js']);
  assert.equal(task.review.requestedBy, 'worker-1');
  assert.ok(task.review.requestedAt);
});

test('projectTask merges review feedback into task.review on REVIEW_DECIDED', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'Build parser' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED,
    actorId: 'worker-1',
    payload: { reviewerId: 'lead', diff: '--- a/x\n+++ b/x', files: ['x'] },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'parser',
    eventType: TASK_EVENT_TYPES.REVIEW_DECIDED,
    actorId: 'lead',
    payload: {
      decision: 'changes_requested',
      reason: 'Naming nits',
      feedback: [
        { file: 'parser.js', comment: 'Rename `parse` to `parseProgram`' },
        { file: 'parser.test.js', comment: 'Add an empty-input case' },
      ],
    },
  });

  const task = board.getTask({ teamId: 'team-a', taskId: 'parser' });
  assert.equal(task.review.state, 'decided');
  assert.equal(task.review.decision, 'changes_requested');
  assert.equal(task.review.reason, 'Naming nits');
  assert.equal(task.review.feedback.length, 2);
  assert.equal(task.review.feedback[0].file, 'parser.js');
  assert.match(task.review.feedback[0].comment, /parseProgram/);
  // Original requested fields persist
  assert.match(task.review.diff, /---/);
  assert.deepEqual(task.review.files, ['x']);
});

test('projectTask collects VALIDATION_RUN events into task.validations[] and task.latestValidation', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'val-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'Validate' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'val-1',
    eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
    actorId: 'tester',
    payload: {
      kind: 'test',
      command: 'npm test',
      exitCode: 1,
      durationMs: 1234,
      verdict: 'failed',
      stdout: 'tests run',
      stderr: 'one failed',
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'val-1',
    eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
    actorId: 'tester',
    payload: {
      kind: 'test',
      command: 'npm test',
      exitCode: 0,
      durationMs: 1100,
      verdict: 'passed',
      stdout: 'all green',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'val-1',
    eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
    actorId: 'tester',
    payload: {
      kind: 'lint',
      command: 'npm run lint',
      exitCode: 0,
      durationMs: 200,
      verdict: 'passed',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  });

  const task = board.getTask({ teamId: 'team-a', taskId: 'val-1' });
  assert.equal(task.validations.length, 3);
  // latestValidation indexes by kind, latest wins
  assert.equal(task.latestValidation.test.verdict, 'passed');
  assert.equal(task.latestValidation.lint.verdict, 'passed');
});

test('projectTask builds task.plan from PLAN_PROPOSED then merges APPROVED/REJECTED', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'p-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'plan' },
  });
  // Proposal #1
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'p-1',
    eventType: TASK_EVENT_TYPES.PLAN_PROPOSED,
    actorId: 'worker-1',
    payload: {
      summary: 'add the parser',
      filesExpectedToChange: ['parser.js'],
      approach: ['LL(1)', 'recursive descent'],
      risks: ['unicode'],
      validationPlan: ['npm test'],
      requiresApproval: true,
    },
  });
  let task = board.getTask({ teamId: 'team-a', taskId: 'p-1' });
  assert.equal(task.plan.state, 'proposed');
  assert.equal(task.plan.summary, 'add the parser');
  assert.deepEqual(task.plan.filesExpectedToChange, ['parser.js']);
  assert.equal(task.plan.proposedBy, 'worker-1');

  // Rejection (request changes)
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'p-1',
    eventType: TASK_EVENT_TYPES.PLAN_REJECTED,
    actorId: 'lead',
    payload: { reason: 'add edge cases' },
  });
  task = board.getTask({ teamId: 'team-a', taskId: 'p-1' });
  assert.equal(task.plan.state, 'rejected');
  assert.equal(task.plan.decidedBy, 'lead');
  assert.equal(task.plan.reason, 'add edge cases');
  // Original proposal fields preserved
  assert.deepEqual(task.plan.filesExpectedToChange, ['parser.js']);

  // Revised proposal — state resets to 'proposed'
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'p-1',
    eventType: TASK_EVENT_TYPES.PLAN_PROPOSED,
    actorId: 'worker-1',
    payload: {
      summary: 'parser v2',
      filesExpectedToChange: ['parser.js', 'parser.test.js'],
      approach: ['recursive descent'],
      risks: [],
      validationPlan: ['npm test'],
    },
  });
  task = board.getTask({ teamId: 'team-a', taskId: 'p-1' });
  assert.equal(task.plan.state, 'proposed');
  assert.equal(task.plan.summary, 'parser v2');
  assert.equal(task.plan.decidedBy, undefined, 'decidedBy resets on re-proposal');

  // Approval
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'p-1',
    eventType: TASK_EVENT_TYPES.PLAN_APPROVED,
    actorId: 'lead',
    payload: { reason: 'lgtm' },
  });
  task = board.getTask({ teamId: 'team-a', taskId: 'p-1' });
  assert.equal(task.plan.state, 'approved');
  assert.equal(task.plan.decidedBy, 'lead');
});

test('projectTask captures WORKTREE_CREATED into task.worktree (status: created)', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'wt-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'worktree task' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'wt-1',
    eventType: TASK_EVENT_TYPES.WORKTREE_CREATED,
    actorId: 'lead',
    payload: {
      status: 'created',
      path: '/tmp/.toad/worktrees/team-a/wt-1',
      branch: 'toad/team-a/wt-1',
      baseRef: 'abc123',
      createdAt: '2026-05-01T00:00:00.000Z',
    },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'wt-1' });
  assert.ok(task.worktree, 'task.worktree should be populated');
  assert.equal(task.worktree.status, 'created');
  assert.equal(task.worktree.path, '/tmp/.toad/worktrees/team-a/wt-1');
  assert.equal(task.worktree.branch, 'toad/team-a/wt-1');
  assert.equal(task.worktree.baseRef, 'abc123');
});

test('projectTask captures task.baseRef and task.baseBranch from CREATED payload (§8 slice 4)', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'br-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: {
      subject: 'baseref',
      baseRef: 'abc123def',
      baseBranch: 'main',
    },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'br-1' });
  assert.equal(task.baseRef, 'abc123def');
  assert.equal(task.baseBranch, 'main');
});

test('projectTask leaves task.baseRef and task.baseBranch null when not supplied', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'br-2',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'no baseref' },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'br-2' });
  assert.equal(task.baseRef, null);
  assert.equal(task.baseBranch, null);
});

test('projectTask counts consecutive failed test runs from VALIDATION_RUN events', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'tf-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'flaky' },
  });
  // Three consecutive test failures
  for (let i = 0; i < 3; i++) {
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'tf-1',
      eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
      actorId: 'tester',
      payload: { kind: 'test', command: 'npm test', exitCode: 1, durationMs: 1, verdict: 'failed' },
    });
  }
  const task = board.getTask({ teamId: 'team-a', taskId: 'tf-1' });
  assert.equal(task.consecutiveTestFailures, 3);
  assert.equal(task.repeatedTestFailures, true);
});

test('projectTask resets consecutiveTestFailures when latest test passes', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'tf-2',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'reset' },
  });
  // failed, failed, passed → count is 0
  for (const verdict of ['failed', 'failed', 'passed']) {
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'tf-2',
      eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
      actorId: 'tester',
      payload: { kind: 'test', command: 'npm test', exitCode: verdict === 'passed' ? 0 : 1, durationMs: 1, verdict },
    });
  }
  const task = board.getTask({ teamId: 'team-a', taskId: 'tf-2' });
  assert.equal(task.consecutiveTestFailures, 0);
  assert.equal(task.repeatedTestFailures, false);
});

test('projectTask only counts the trailing run streak (failed→failed→passed→failed → 1)', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'tf-3',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'streak' },
  });
  for (const verdict of ['failed', 'failed', 'passed', 'failed']) {
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'tf-3',
      eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
      actorId: 'tester',
      payload: { kind: 'test', command: 'npm test', exitCode: verdict === 'passed' ? 0 : 1, durationMs: 1, verdict },
    });
  }
  const task = board.getTask({ teamId: 'team-a', taskId: 'tf-3' });
  assert.equal(task.consecutiveTestFailures, 1);
  assert.equal(task.repeatedTestFailures, false);
});

test('projectTask ignores non-test validation runs when counting failures', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'tf-4',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'mixed' },
  });
  // lint failed, then test failed twice — should count only the test failures
  for (const [kind, verdict] of [['lint', 'failed'], ['test', 'failed'], ['test', 'failed']]) {
    board.appendEvent({
      teamId: 'team-a',
      taskId: 'tf-4',
      eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
      actorId: 'tester',
      payload: { kind, command: `npm ${kind}`, exitCode: 1, durationMs: 1, verdict },
    });
  }
  const task = board.getTask({ teamId: 'team-a', taskId: 'tf-4' });
  assert.equal(task.consecutiveTestFailures, 2);
});

test('projectTask captures WORKTREE_REMOVED and updates task.worktree.status to "removed"', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'wt-r',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'cleanup' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'wt-r',
    eventType: TASK_EVENT_TYPES.WORKTREE_CREATED,
    actorId: 'lead',
    payload: {
      status: 'created',
      path: '/tmp/wt-r',
      branch: 'toad/team-a/wt-r',
      baseRef: 'abc',
      createdAt: '2026-05-01T00:00:00.000Z',
    },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'wt-r',
    eventType: TASK_EVENT_TYPES.WORKTREE_REMOVED,
    actorId: 'lead',
    payload: {
      status: 'removed',
      path: '/tmp/wt-r',
      removedAt: '2026-05-01T01:00:00.000Z',
    },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'wt-r' });
  assert.equal(task.worktree.status, 'removed');
  assert.equal(task.worktree.path, '/tmp/wt-r');
  assert.equal(task.worktree.branch, 'toad/team-a/wt-r', 'branch preserved through removal');
  assert.equal(task.worktree.removedAt, '2026-05-01T01:00:00.000Z');
});

test('projectTask captures WORKTREE_CREATED skipped variant with reason', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'wt-2',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'no git' },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'wt-2',
    eventType: TASK_EVENT_TYPES.WORKTREE_CREATED,
    actorId: 'lead',
    payload: { status: 'skipped', reason: 'not_in_git_repo' },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'wt-2' });
  assert.equal(task.worktree.status, 'skipped');
  assert.equal(task.worktree.reason, 'not_in_git_repo');
  assert.equal(task.worktree.path, undefined);
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

