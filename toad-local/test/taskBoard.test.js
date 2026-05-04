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

test('projectTask captures task risk contract fields from CREATED payload', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'risk-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: {
      subject: 'risk contract',
      allowedFiles: [' src/app.js ', '', 42, 'docs/spec.md'],
      forbiddenFiles: ['.env', null, 'secrets/**'],
      acceptanceCriteria: ['tests pass', ' docs updated '],
      riskLevel: 'high',
      requiresHumanApproval: true,
    },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'risk-1' });
  assert.deepEqual(task.allowedFiles, ['src/app.js', 'docs/spec.md']);
  assert.deepEqual(task.forbiddenFiles, ['.env', 'secrets/**']);
  assert.deepEqual(task.acceptanceCriteria, ['tests pass', 'docs updated']);
  assert.equal(task.riskLevel, 'high');
  assert.equal(task.requiresHumanApproval, true);
});

test('projectTask defaults task risk contract fields when not supplied', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'risk-2',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'default risk contract' },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'risk-2' });
  assert.deepEqual(task.allowedFiles, []);
  assert.deepEqual(task.forbiddenFiles, []);
  assert.deepEqual(task.acceptanceCriteria, []);
  assert.equal(task.riskLevel, null);
  assert.equal(task.requiresHumanApproval, false);
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

test('§1 follow-up: task_create accepts priority/assignedRole/testCommands/expectedDeliverables/dependencyTaskIds and projects them', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't', taskId: 's-1', eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
    payload: {
      subject: 'rich task',
      priority: 'high',
      assignedRole: 'developer',
      testCommands: ['npm test', 'npm run lint'],
      expectedDeliverables: ['src/foo.js', 'src/foo.test.js'],
      dependencyTaskIds: ['t-1', 't-2'],
    },
  });
  const t = board.getTask({ teamId: 't', taskId: 's-1' });
  assert.equal(t.priority, 'high');
  assert.equal(t.assignedRole, 'developer');
  assert.deepEqual(t.testCommands, ['npm test', 'npm run lint']);
  assert.deepEqual(t.expectedDeliverables, ['src/foo.js', 'src/foo.test.js']);
  assert.deepEqual(t.dependencyTaskIds, ['t-1', 't-2']);
});

test('§1 follow-up: defaults are sensible when fields are omitted', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't', taskId: 's-2', eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
    payload: { subject: 'minimal' },
  });
  const t = board.getTask({ teamId: 't', taskId: 's-2' });
  assert.equal(t.priority, null);
  assert.equal(t.assignedRole, null);
  assert.deepEqual(t.testCommands, []);
  assert.deepEqual(t.expectedDeliverables, []);
  assert.deepEqual(t.dependencyTaskIds, []);
});

test('REVIEW_DECIDED feedback items preserve severity (§17)', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't', taskId: 'sev-1', eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
    payload: { subject: 'severity test' },
  });
  board.appendEvent({
    teamId: 't', taskId: 'sev-1', eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED, actorId: 'dev',
    payload: { reviewerId: 'lead', diff: '...', files: ['a.js'] },
  });
  board.appendEvent({
    teamId: 't', taskId: 'sev-1', eventType: TASK_EVENT_TYPES.REVIEW_DECIDED, actorId: 'lead',
    payload: {
      decision: 'changes_requested',
      feedback: [
        { file: 'a.js', comment: 'rename for clarity', severity: 'nit' },
        { file: 'a.js', comment: 'this guard is wrong', severity: 'major' },
        { file: 'a.js', comment: 'consider...', severity: 'banana' }, // unknown — dropped
        { file: 'a.js', comment: 'no severity is fine' },
      ],
    },
  });
  const t = board.getTask({ teamId: 't', taskId: 'sev-1' });
  assert.equal(t.review.feedback.length, 4);
  assert.equal(t.review.feedback[0].severity, 'nit');
  assert.equal(t.review.feedback[1].severity, 'major');
  assert.equal(t.review.feedback[2].severity, undefined, 'unknown severity should be dropped');
  assert.equal(t.review.feedback[3].severity, undefined, 'no severity stays absent');
});

test('task.integration defaults to null and INTEGRATION_MERGED populates it', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't', taskId: 'i-1', eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
    payload: { subject: 'x' },
  });
  let task = board.getTask({ teamId: 't', taskId: 'i-1' });
  assert.equal(task.integration, null);
  board.appendEvent({
    teamId: 't', taskId: 'i-1', eventType: TASK_EVENT_TYPES.INTEGRATION_MERGED, actorId: 'lead',
    payload: {
      status: 'merged',
      baseBranch: 'main',
      mergeCommit: 'abc123',
      parents: ['BASE', 'TASK'],
      mergedAt: '2026-05-01T22:00:00.000Z',
    },
  });
  task = board.getTask({ teamId: 't', taskId: 'i-1' });
  assert.equal(task.integration.status, 'merged');
  assert.equal(task.integration.baseBranch, 'main');
  assert.equal(task.integration.mergeCommit, 'abc123');
  assert.deepEqual(task.integration.parents, ['BASE', 'TASK']);
});

test('task.humanApproval defaults to { approved: false }', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'h-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'x' },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'h-1' });
  assert.deepEqual(task.humanApproval, { approved: false });
});

test('HUMAN_APPROVED event populates task.humanApproval with approver + reason + time', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'h-2',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'x', riskLevel: 'high', requiresHumanApproval: true },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'h-2',
    eventType: TASK_EVENT_TYPES.HUMAN_APPROVED,
    actorId: 'lead',
    createdAt: '2026-05-01T20:30:00.000Z',
    payload: { reason: 'reviewed offline' },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'h-2' });
  assert.equal(task.humanApproval.approved, true);
  assert.equal(task.humanApproval.approvedBy, 'lead');
  assert.equal(task.humanApproval.approvedAt, '2026-05-01T20:30:00.000Z');
  assert.equal(task.humanApproval.reason, 'reviewed offline');
});

test('RISK_CLASSIFIED event elevates riskLevel and flips requiresHumanApproval', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'r-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'x', riskLevel: 'low', requiresHumanApproval: false },
  });
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'r-1',
    eventType: TASK_EVENT_TYPES.RISK_CLASSIFIED,
    actorId: 'lead',
    payload: {
      riskLevel: 'critical',
      requiresHumanApproval: true,
      matchedRules: [{ pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true }],
      source: 'risk_policy',
    },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'r-1' });
  assert.equal(task.riskLevel, 'critical');
  assert.equal(task.requiresHumanApproval, true);
});

test('RISK_CLASSIFIED never demotes baseline riskLevel', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'r-2',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'x', riskLevel: 'critical', requiresHumanApproval: true },
  });
  // Bogus elevation event proposes 'low' — must be ignored
  board.appendEvent({
    teamId: 'team-a',
    taskId: 'r-2',
    eventType: TASK_EVENT_TYPES.RISK_CLASSIFIED,
    actorId: 'lead',
    payload: { riskLevel: 'low', requiresHumanApproval: false, matchedRules: [], source: 'risk_policy' },
  });
  const task = board.getTask({ teamId: 'team-a', taskId: 'r-2' });
  assert.equal(task.riskLevel, 'critical');
  assert.equal(task.requiresHumanApproval, true);
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

// ─── Subscriber API (drift-monitor fan-out + future hooks) ───────────────

test('InMemoryTaskBoard.subscribe fires subscriber after appendEvent', () => {
  const board = new InMemoryTaskBoard();
  const calls = [];
  board.subscribe((event) => calls.push(event));

  board.appendEvent({
    teamId: 'team-a',
    taskId: 'task-1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'X' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].teamId, 'team-a');
  assert.equal(calls[0].taskId, 'task-1');
  assert.equal(calls[0].eventType, TASK_EVENT_TYPES.CREATED);
});

test('InMemoryTaskBoard.subscribe supports multiple subscribers', () => {
  const board = new InMemoryTaskBoard();
  const a = []; const b = [];
  board.subscribe((e) => a.push(e));
  board.subscribe((e) => b.push(e));
  board.appendEvent({
    teamId: 't', taskId: 'x', eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead', payload: { subject: 'X' },
  });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test('InMemoryTaskBoard.subscribe returns an unsubscribe fn', () => {
  const board = new InMemoryTaskBoard();
  const calls = [];
  const off = board.subscribe((e) => calls.push(e));

  board.appendEvent({
    teamId: 't', taskId: 'a', eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead', payload: { subject: 'A' },
  });
  off();
  board.appendEvent({
    teamId: 't', taskId: 'b', eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead', payload: { subject: 'B' },
  });
  assert.equal(calls.length, 1, 'second event should not fire post-unsubscribe');
});

test('InMemoryTaskBoard does NOT fire subscribers on idempotent dedup hit', () => {
  const board = new InMemoryTaskBoard();
  const calls = [];
  board.subscribe((e) => calls.push(e));

  const args = {
    teamId: 't', taskId: 'x', eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead', idempotencyKey: 'k1', payload: { subject: 'X' },
  };
  board.appendEvent(args);
  board.appendEvent(args); // dedup

  assert.equal(calls.length, 1, 'subscriber should fire once, not twice');
});

test('InMemoryTaskBoard subscriber errors do NOT break appendEvent', () => {
  const board = new InMemoryTaskBoard();
  // Capture console.warn so the test output stays clean.
  const origWarn = console.warn;
  let warnCount = 0;
  console.warn = () => { warnCount += 1; };
  try {
    board.subscribe(() => { throw new Error('subscriber blew up'); });
    // Append must still succeed and return inserted=true.
    const result = board.appendEvent({
      teamId: 't', taskId: 'x', eventType: TASK_EVENT_TYPES.CREATED,
      actorId: 'lead', payload: { subject: 'X' },
    });
    assert.equal(result.inserted, true);
    assert.equal(warnCount, 1, 'subscriber error should be logged via console.warn');
  } finally {
    console.warn = origWarn;
  }
});
