import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { COMMANDS } from '../src/commands/command-contract.js';
import { InMemoryTaskBoard, TASK_STATUS } from '../src/task/inMemoryTaskBoard.js';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';

function createFacade() {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const runtimeRegistry = {
    getRuntime(runtimeId) {
      if (runtimeId !== 'runtime-lead-1') return null;
      return {
        runtimeId,
        teamId: 'team-a',
        agentId: 'lead',
        status: 'running',
      };
    },
    listRuntimes({ teamId }) {
      return [
        {
          runtimeId: 'runtime-lead-1',
          teamId,
          agentId: 'lead',
          status: 'running',
        },
        {
          runtimeId: 'runtime-worker-1',
          teamId,
          agentId: 'worker-1',
          status: 'exited',
        },
      ];
    },
  };
  const approvalBroker = {
    responses: [],
    respondApproval(input) {
      this.responses.push(input);
      return {
        approvalId: input.approvalId,
        status: input.decision,
        decision: input.decision,
        reason: input.reason || '',
      };
    },
  };
  const readModel = {
    listRuntimeAudit({ teamId, runtimeId }) {
      return [
        {
          eventId: 'event-1',
          teamId,
          runtimeId,
          agentId: 'lead',
          eventType: 'tool_use',
        },
      ];
    },
    listApprovals({ teamId }) {
      return [
        {
          approvalId: 'approval-1',
          teamId,
          agentId: 'lead',
          runtimeId: 'runtime-lead-1',
          prompt: 'Approve Write',
          status: 'pending',
        },
      ];
    },
    listCrossTeamMessages({ teamId, limit }) {
      return [
        {
          id: 'msg-cross-1',
          teamId,
          direction: 'outbound',
          targetTeamId: 'team-b',
          conversationId: 'conv-1',
          text: `Limit ${limit}`,
        },
      ];
    },
  };
  return {
    broker,
    taskBoard,
    runtimeRegistry,
    approvalBroker,
    readModel,
    facade: new LocalToolFacade({ broker, taskBoard, runtimeRegistry, approvalBroker, readModel }),
  };
}

test('LocalToolFacade sends messages through broker', () => {
  const { broker, facade } = createFacade();
  facade.execute({
    commandName: COMMANDS.MESSAGE_SEND,
    idempotencyKey: 'msg-1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      to: { kind: 'agent', agentId: 'worker-1' },
      text: 'Start on storage.',
    },
  });

  const inbox = broker.listInbox({
    teamId: 'team-a',
    recipient: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
  });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from.id, 'lead');
});

test('LocalToolFacade creates, updates, and comments on tasks', () => {
  const { facade } = createFacade();
  const actor = { teamId: 'team-a', agentId: 'lead' };

  const created = facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'task-create-storage',
    actor,
    args: {
      taskId: 'storage',
      subject: 'Build SQLite storage',
      ownerId: 'worker-1',
    },
  });
  assert.equal(created.ownerId, 'worker-1');

  const updated = facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'task-update-storage-start',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: {
      taskId: 'storage',
      status: TASK_STATUS.IN_PROGRESS,
    },
  });
  assert.equal(updated.status, TASK_STATUS.IN_PROGRESS);

  const commented = facade.execute({
    commandName: COMMANDS.TASK_COMMENT,
    idempotencyKey: 'task-comment-storage',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: {
      taskId: 'storage',
      text: 'SQLite broker is implemented.',
    },
  });
  assert.equal(commented.comments.length, 1);
});

test('LocalToolFacade requests and decides task reviews', () => {
  const { facade } = createFacade();
  const actor = { teamId: 'team-a', agentId: 'lead' };
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'task-create-review',
    actor,
    args: {
      taskId: 'review-me',
      subject: 'Review lifecycle',
    },
  });

  const requested = facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'review-request-1',
    actor,
    args: {
      taskId: 'review-me',
      reviewerId: 'reviewer-1',
    },
  });

  assert.equal(requested.reviewState, 'review');

  const approved = facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'review-decide-1',
    actor: { teamId: 'team-a', agentId: 'reviewer-1' },
    args: {
      taskId: 'review-me',
      decision: 'approved',
    },
  });

  assert.equal(approved.reviewState, 'approved');

  const changesRequested = facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'review-decide-2',
    actor: { teamId: 'team-a', agentId: 'reviewer-1' },
    args: {
      taskId: 'review-me',
      decision: 'changes_requested',
    },
  });

  assert.equal(changesRequested.reviewState, 'needs_fix');
  assert.equal(changesRequested.status, TASK_STATUS.PENDING);
});

test('LocalToolFacade requires idempotency keys for mutating commands', () => {
  const { facade } = createFacade();
  assert.throws(
    () =>
      facade.execute({
        commandName: COMMANDS.TASK_CREATE,
        actor: { teamId: 'team-a', agentId: 'lead' },
        args: { taskId: 'x', subject: 'Missing idempotency' },
      }),
    /idempotencyKey/
  );
});

test('LocalToolFacade lists agent runtime status for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.AGENT_STATUS,
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {},
  });

  assert.deepEqual(result, [
    {
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      status: 'running',
    },
    {
      runtimeId: 'runtime-worker-1',
      teamId: 'team-a',
      agentId: 'worker-1',
      status: 'exited',
    },
  ]);
});

test('LocalToolFacade returns a specific runtime status by runtimeId', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.AGENT_STATUS,
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { runtimeId: 'runtime-lead-1' },
  });

  assert.deepEqual(result, {
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    status: 'running',
  });
});

test('LocalToolFacade lists approvals for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.APPROVAL_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {},
  });

  assert.deepEqual(result, [
    {
      approvalId: 'approval-1',
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      prompt: 'Approve Write',
      status: 'pending',
    },
  ]);
});

test('LocalToolFacade lists runtime audit events for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.RUNTIME_EVENTS,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { runtimeId: 'runtime-lead-1' },
  });

  assert.deepEqual(result, [
    {
      eventId: 'event-1',
      teamId: 'team-a',
      runtimeId: 'runtime-lead-1',
      agentId: 'lead',
      eventType: 'tool_use',
    },
  ]);
});

test('LocalToolFacade lists cross-team messages for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.CROSS_TEAM_MESSAGES,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { limit: 25 },
  });

  assert.deepEqual(result, [
    {
      id: 'msg-cross-1',
      teamId: 'team-a',
      direction: 'outbound',
      targetTeamId: 'team-b',
      conversationId: 'conv-1',
      text: 'Limit 25',
    },
  ]);
});

test('LocalToolFacade responds to approval requests through the approval broker', () => {
  const { approvalBroker, facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.APPROVAL_RESPOND,
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  });

  assert.deepEqual(approvalBroker.responses, [
    {
      approvalId: 'approval-1',
      idempotencyKey: 'approval-response-1',
      actor: { teamId: 'team-a', agentId: 'operator' },
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  ]);
  assert.equal(result.status, 'approved');
});

test('LocalToolFacade forwards approval responses to the requesting runtime adapter', () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const sentApprovals = [];
  const approvalBroker = {
    getApproval(approvalId) {
      assert.equal(approvalId, 'approval-1');
      return {
        approvalId,
        teamId: 'team-a',
        agentId: 'lead',
        runtimeId: 'runtime-lead-1',
        status: 'pending',
      };
    },
    respondApproval(input) {
      return {
        approvalId: input.approvalId,
        teamId: 'team-a',
        agentId: 'lead',
        runtimeId: 'runtime-lead-1',
        status: input.decision,
        decision: input.decision,
        reason: input.reason,
      };
    },
  };
  const adapters = new Map([
    [
      'runtime-lead-1',
      {
        approve(input) {
          sentApprovals.push(input);
          return { accepted: true, responseState: 'approval_response_returned' };
        },
      },
    ],
  ]);
  const facade = new LocalToolFacade({ broker, taskBoard, approvalBroker, adapters });

  const result = facade.execute({
    commandName: COMMANDS.APPROVAL_RESPOND,
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  });

  assert.deepEqual(sentApprovals, [
    {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  ]);
  assert.equal(result.runtimeResponse.accepted, true);
});

test('LocalToolFacade sends cross-team messages with prefix and dual-write', () => {
  const { broker, facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.CROSS_TEAM_SEND,
    idempotencyKey: 'cross-team-1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      targetTeamId: 'team-b',
      text: 'Need status update.',
      conversationId: 'conv-1',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetTeamId, 'team-b');
  assert.equal(result.targetAgentId, 'lead');

  // Incoming message in target team's inbox
  const targetMessages = broker.listMessages({ teamId: 'team-b' });
  assert.equal(targetMessages.length, 1);
  assert.ok(targetMessages[0].text.includes('<cross-team'));
  assert.ok(targetMessages[0].text.includes('from="team-a.lead"'));
  assert.ok(targetMessages[0].text.includes('Need status update.'));
  assert.equal(targetMessages[0].metadata.source, 'cross_team');

  // Sent copy in sender team's inbox
  const senderMessages = broker.listMessages({ teamId: 'team-a' });
  assert.equal(senderMessages.length, 1);
  assert.equal(senderMessages[0].metadata.source, 'cross_team_sent');
  assert.equal(senderMessages[0].metadata.conversationId, 'conv-1');
});

test('LocalToolFacade routes agent_launch to the launchAgent callback', async () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const calls = [];
  const facade = new LocalToolFacade({
    broker,
    taskBoard,
    launchAgent(input) {
      calls.push(input);
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'starting', pid: 1234 });
    },
  });

  const result = await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'launch-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      command: 'claude',
      args: ['--print'],
      cwd: 'C:\\Project-TOAD',
      env: { CLAUDE_VAR: 'on' },
      providerId: 'claude',
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
    args: ['--print'],
    cwd: 'C:\\Project-TOAD',
    env: { CLAUDE_VAR: 'on' },
    providerId: 'claude',
  });
  assert.deepEqual(result, { runtimeId: 'runtime-lead-1', status: 'starting', pid: 1234 });
});

test('LocalToolFacade rejects agent_launch when no launchAgent callback is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'launch-fail',
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /agent_launch is not configured/,
  );
});

test('LocalToolFacade task_plan_propose → task_plan_approve roundtrip populates task.plan', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'plan-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'plan-1', subject: 'planned' },
  });

  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'plan-prop',
    actor: { teamId: 'team-a', agentId: 'worker-1', role: 'developer' },
    args: {
      taskId: 'plan-1',
      summary: 'do the thing',
      filesExpectedToChange: ['x.js'],
      approach: ['step a', 'step b'],
      risks: ['none'],
      validationPlan: ['npm test'],
    },
  });

  let task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'plan-1' });
  assert.equal(task.plan.state, 'proposed');
  assert.equal(task.plan.summary, 'do the thing');
  assert.equal(task.plan.proposedBy, 'worker-1');

  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'plan-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'plan-1', reason: 'lgtm' },
  });

  task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'plan-1' });
  assert.equal(task.plan.state, 'approved');
  assert.equal(task.plan.decidedBy, 'lead');
  assert.equal(task.plan.reason, 'lgtm');
});

test('LocalToolFacade task_plan_approve refuses when the proposer is the approver', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sa-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sa-1', subject: 'self-approve' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sa-prop',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'sa-1', summary: 'do it' },
  });
  // Same agent tries to approve own plan — should be rejected regardless of role
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_PLAN_APPROVE,
      idempotencyKey: 'sa-app',
      actor: { teamId: 'team-a', agentId: 'worker-1', role: 'lead' },
      args: { taskId: 'sa-1' },
    }),
    /same agent cannot approve own plan/,
  );
});

test('LocalToolFacade ready → planned is blocked without an approved plan', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'gate-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-1', subject: 'gate', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u-ready',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-1', status: 'ready' },
  });

  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'gate-u-planned',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'gate-plan-1', status: 'planned' },
    }),
    /requires an approved plan/,
  );
});

test('LocalToolFacade ready → planned is allowed once a plan is approved', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'gate2-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-2', subject: 'gate2', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate2-u-ready',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-2', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'gate2-prop',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'gate-plan-2', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'gate2-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'gate-plan-2' },
  });
  // Now ready → planned should be allowed
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate2-u-planned',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-2', status: 'planned' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'gate-plan-2' });
  assert.equal(task.status, 'planned');
});

test('LocalToolFacade blocks testing → merge_ready when no passing test verdict exists', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  // Walk task into testing
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'gate-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', subject: 'gate', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', status: 'in_progress' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u2',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', status: 'review' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u3',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', status: 'testing' },
  });

  // No validation_run for kind=test → merge_ready must be blocked
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'gate-u4',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'gate-1', status: 'merge_ready' },
    }),
    /requires a passing test verdict/,
  );
});

test('LocalToolFacade allows testing → merge_ready after a passing test verdict is recorded', async () => {
  const spawnFn = fakeSpawn({ exitCode: 0, stdout: 'all green', stderr: '' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'pass-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'pass-1', subject: 'pass', status: 'pending' },
  });
  for (const [id, status] of [
    ['p1', 'in_progress'],
    ['p2', 'review'],
    ['p3', 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: `pass-${id}`,
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'pass-1', status },
    });
  }
  // Run the test command — verdict 'passed'
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'pass-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'pass-1', kind: 'test' },
  });
  // Now merge_ready should be allowed
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'pass-u4',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'pass-1', status: 'merge_ready' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'pass-1' });
  assert.equal(task.status, 'merge_ready');
});

test('LocalToolFacade blocks testing → merge_ready when the latest test verdict is "failed"', async () => {
  const spawnFn = fakeSpawn({ exitCode: 1, stdout: '', stderr: 'fail' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'fail-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'fail-1', subject: 'fail', status: 'pending' },
  });
  for (const [id, status] of [['f1', 'in_progress'], ['f2', 'review'], ['f3', 'testing']]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: `fail-${id}`,
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'fail-1', status },
    });
  }
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'fail-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'fail-1', kind: 'test' },
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'fail-u4',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'fail-1', status: 'merge_ready' },
    }),
    /failed/,
  );
});

function fakeSpawn({ exitCode = 0, stdout = '', stderr = '', durationMs = 1 } = {}) {
  const calls = [];
  const fn = (command, opts) => {
    calls.push({ command, opts });
    return { exitCode, stdout, stderr, durationMs };
  };
  fn.calls = calls;
  return fn;
}

test('LocalToolFacade validation_run records the run as a TASK_VALIDATION_RUN event', async () => {
  const spawnFn = fakeSpawn({ exitCode: 0, stdout: 'tests run', stderr: '' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  // Seed team config with a test command
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  // Seed a task
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'val-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'val-1', subject: 'validate' },
  });

  const result = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'val-run-1',
    actor: { teamId: 'team-a', agentId: 'tester-1' },
    args: { taskId: 'val-1', kind: 'test' },
  });

  assert.equal(spawnFn.calls.length, 1);
  assert.equal(spawnFn.calls[0].command, 'npm test');
  assert.equal(result.verdict, 'passed');
  assert.equal(result.exitCode, 0);

  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'val-1' });
  assert.equal(task.validations.length, 1);
  assert.equal(task.validations[0].kind, 'test');
  assert.equal(task.validations[0].verdict, 'passed');
  assert.equal(task.latestValidation.test.verdict, 'passed');
});

test('LocalToolFacade validation_run records "not_run" when no command is configured and no override is supplied', async () => {
  const spawnFn = fakeSpawn();
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    // No validation field — testCommand not configured
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'nr-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'nr-1', subject: 'not run' },
  });

  const result = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'nr-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'nr-1', kind: 'test' },
  });

  assert.equal(spawnFn.calls.length, 0, 'spawn should not be called when no command is configured');
  assert.equal(result.verdict, 'not_run');
});

test('LocalToolFacade validation_run records "failed" when the command exits non-zero', async () => {
  const spawnFn = fakeSpawn({ exitCode: 2, stdout: '', stderr: 'boom' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'f-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'f-1', subject: 'fail' },
  });

  const result = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'f-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'f-1', kind: 'test' },
  });

  assert.equal(result.verdict, 'failed');
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /boom/);
});

test('LocalToolFacade enforces role authority on dispatch (developer cannot agent_launch)', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    launchAgent: () => ({ runtimeId: 'r', status: 'starting' }),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'role-test-1',
      actor: { teamId: 'team-a', agentId: 'worker-1', role: 'developer' },
      args: { teamId: 'team-a', agentId: 'worker-1', runtimeId: 'r', command: 'claude' },
    }),
    /role authority: developer cannot call agent_launch/,
  );
});

test('LocalToolFacade allows developer to call task_update (in their allowlist)', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'role-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'role-1', subject: 'role test', status: 'pending' },
  });

  // developer with task_update permission
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'role-update',
    actor: { teamId: 'team-a', agentId: 'worker-1', role: 'developer' },
    args: { taskId: 'role-1', status: 'in_progress' },
  });
  // (no throw means success)
});

test('LocalToolFacade rejects review_decide when the actor is the same agent that requested the review', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sr-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sr-1', subject: 'self-review' },
  });
  // worker-1 requests review on its own work
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sr-req',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'sr-1', diff: 'd', files: ['x'] },
  });

  // worker-1 (a reviewer in this hypothetical) tries to approve own work
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.REVIEW_DECIDE,
      idempotencyKey: 'sr-dec',
      actor: { teamId: 'team-a', agentId: 'worker-1', role: 'reviewer' },
      args: { taskId: 'sr-1', decision: 'approved' },
    }),
    /same agent cannot review own work/,
  );
});

test('LocalToolFacade allows review_decide when the actor differs from the requester', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rev-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'rev-1', subject: 'rev' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rev-req',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'rev-1' },
  });
  // Different agent decides — should succeed
  facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'rev-dec',
    actor: { teamId: 'team-a', agentId: 'reviewer-1', role: 'reviewer' },
    args: { taskId: 'rev-1', decision: 'approved' },
  });
});

test('LocalToolFacade task_update records "from" and "reason" in the STATUS_CHANGED event payload', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-sm',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sm-1', subject: 'state-machine', status: 'pending' },
  });

  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'update-sm',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sm-1', status: 'in_progress', reason: 'work started' },
  });

  const task = facade.execute({
    commandName: COMMANDS.TASK_LIST,
    actor: { teamId: 'team-a', agentId: 'lead' },
  }).find((t) => t.taskId === 'sm-1');
  const statusEvent = task.history.find((e) => e.eventType === 'task.status_changed');
  assert.ok(statusEvent, 'STATUS_CHANGED event should exist');
  assert.equal(statusEvent.payload.from, 'pending');
  assert.equal(statusEvent.payload.status, 'in_progress');
  assert.equal(statusEvent.payload.reason, 'work started');
});

test('LocalToolFacade task_update rejects illegal status transitions', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  // Get task into a terminal state
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-illegal',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'illegal-1', subject: 'bad transition', status: 'completed' },
  });

  // completed is terminal — must not move forward
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'update-illegal',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'illegal-1', status: 'review' },
    }),
    /not an allowed transition|completed.*review/,
  );
});

test('LocalToolFacade task_update preserves backward-compatible pending → in_progress → completed', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'c-bc',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'bc-1', subject: 'bc', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'u1-bc',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'bc-1', status: 'in_progress' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'u2-bc',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'bc-1', status: 'completed' },
  });
  const task = facade.execute({
    commandName: COMMANDS.TASK_LIST,
    actor: { teamId: 'team-a', agentId: 'lead' },
  }).find((t) => t.taskId === 'bc-1');
  assert.equal(task.status, 'completed');
});

test('LocalToolFacade review_request stores diff, summary, files in the task event payload', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });

  // Seed a task first
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-x',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'task-x', subject: 'X' },
  });

  const task = facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rev-req-1',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: {
      taskId: 'task-x',
      reviewerId: 'lead',
      summary: 'Did the thing',
      diff: '--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+1',
      files: ['x.js'],
    },
  });

  assert.equal(task.review.state, 'requested');
  assert.equal(task.review.reviewerId, 'lead');
  assert.equal(task.review.summary, 'Did the thing');
  assert.match(task.review.diff, /\+1/);
  assert.deepEqual(task.review.files, ['x.js']);
});

test('LocalToolFacade review_decide stores per-file feedback', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-y',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'task-y', subject: 'Y' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rev-req-y',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'task-y', diff: '--- a\n+++ b', files: ['y.js'] },
  });

  const task = facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'rev-dec-y',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      taskId: 'task-y',
      decision: 'changes_requested',
      reason: 'Naming',
      feedback: [{ file: 'y.js', comment: 'rename to z.js' }],
    },
  });

  assert.equal(task.review.state, 'decided');
  assert.equal(task.review.decision, 'changes_requested');
  assert.equal(task.review.feedback.length, 1);
  assert.equal(task.review.feedback[0].file, 'y.js');
  assert.match(task.review.feedback[0].comment, /rename/);
});

test('LocalToolFacade review_list returns tasks with active reviews including the diff', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  // Two tasks: one with an open review, one without
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'c1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'open-rev', subject: 'open' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'r1',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'open-rev', diff: 'd', files: ['a.js'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'c2',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'no-rev', subject: 'no review' },
  });

  const list = facade.execute({
    commandName: COMMANDS.REVIEW_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
  });

  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, 'open-rev');
  assert.equal(list[0].review.state, 'requested');
  assert.equal(list[0].review.diff, 'd');
});

test('LocalToolFacade routes runtime_send_input to the adapter\'s sendTurn', async () => {
  const turns = [];
  const adapter = {
    async sendTurn(input) {
      turns.push(input);
      return { accepted: true, responseState: 'queued' };
    },
  };
  const adapters = new Map([['runtime-lead-1', adapter]]);
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    adapters,
  });

  const result = await facade.execute({
    commandName: COMMANDS.RUNTIME_SEND_INPUT,
    idempotencyKey: 'send-input-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { runtimeId: 'runtime-lead-1', text: '/usage' },
  });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].message.text, '/usage');
  assert.deepEqual(result, { accepted: true, responseState: 'queued' });
});

test('LocalToolFacade rejects runtime_send_input when no adapter is registered for the runtimeId', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    adapters: new Map(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.RUNTIME_SEND_INPUT,
      idempotencyKey: 'send-input-fail',
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-ghost', text: 'hello' },
    }),
    /no adapter for runtime/,
  );
});

test('LocalToolFacade requires idempotencyKey for runtime_send_input', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    adapters: new Map([['runtime-lead-1', { sendTurn: () => ({}) }]]),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.RUNTIME_SEND_INPUT,
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-lead-1', text: 'hello' },
    }),
    /idempotencyKey/,
  );
});

test('LocalToolFacade routes team_create / team_list / team_delete through the team config registry', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(config) { this.teams.set(config.teamId, config); }
      getTeam(teamId) { return this.teams.get(teamId) || null; }
      listTeams() { return [...this.teams.values()]; }
      deleteTeam(teamId) { return this.teams.delete(teamId); }
    })(),
  });

  // Create
  const created = facade.execute({
    commandName: COMMANDS.TEAM_CREATE,
    idempotencyKey: 'team-create-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      teamId: 'team-alpha',
      lead: { agentId: 'lead', command: 'claude', prompt: 'be brief' },
      teammates: [{ agentId: 'worker-1' }],
    },
  });
  assert.equal(created.teamId, 'team-alpha');
  assert.equal(created.lead.command, 'claude');
  assert.equal(created.teammates[0].agentId, 'worker-1');

  // List
  const list = facade.execute({
    commandName: COMMANDS.TEAM_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].teamId, 'team-alpha');

  // Delete
  const deleteResult = facade.execute({
    commandName: COMMANDS.TEAM_DELETE,
    idempotencyKey: 'team-delete-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });
  assert.equal(deleteResult.deleted, true);
  assert.equal(facade.execute({
    commandName: COMMANDS.TEAM_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
  }).length, 0);
});

test('LocalToolFacade rejects team_* commands when no teamConfigRegistry is configured', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TEAM_LIST,
      actor: { teamId: 'team-a', agentId: 'operator' },
    }),
    /teamConfigRegistry is not configured/,
  );
});

function createTeamLifecycleFacade({ teamRuntimes = [] } = {}) {
  const launches = [];
  const stops = [];
  const registry = new (class {
    teams = new Map();
    registerTeam(config) { this.teams.set(config.teamId, config); }
    getTeam(teamId) { return this.teams.get(teamId) || null; }
    listTeams() { return [...this.teams.values()]; }
    deleteTeam(teamId) { return this.teams.delete(teamId); }
  })();
  const runtimeRegistry = {
    runtimes: new Map(teamRuntimes.map((r) => [r.runtimeId, r])),
    listRuntimes({ teamId } = {}) {
      const all = [...this.runtimes.values()];
      return teamId ? all.filter((r) => r.teamId === teamId) : all;
    },
    getRuntime(runtimeId) { return this.runtimes.get(runtimeId) || null; },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    runtimeRegistry,
    launchAgent(input) {
      launches.push(input);
      runtimeRegistry.runtimes.set(input.runtimeId, {
        runtimeId: input.runtimeId,
        teamId: input.teamId,
        agentId: input.agentId,
        status: 'starting',
      });
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'starting' });
    },
    stopAgent(input) {
      stops.push(input);
      const r = runtimeRegistry.runtimes.get(input.runtimeId);
      if (r) r.status = 'stopped';
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'stopped' });
    },
  });
  return { facade, registry, runtimeRegistry, launches, stops };
}

test('LocalToolFacade team_launch launches every member with derived runtime IDs', async () => {
  const { facade, registry, launches } = createTeamLifecycleFacade();
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'team-alpha',
    lead: { agentId: 'lead', command: 'claude', args: ['--print'] },
    teammates: [
      { agentId: 'worker-1', command: 'claude' },
      { agentId: 'worker-2', command: 'claude' },
    ],
  }));

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-1',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(launches.length, 3);
  assert.equal(launches[0].runtimeId, 'runtime-team-alpha-lead');
  assert.equal(launches[1].runtimeId, 'runtime-team-alpha-worker-1');
  assert.equal(launches[2].runtimeId, 'runtime-team-alpha-worker-2');
  assert.equal(result.teamId, 'team-alpha');
  assert.equal(result.members.length, 3);
  assert.deepEqual(result.members.map((m) => m.status), ['starting', 'starting', 'starting']);
});

test('LocalToolFacade team_launch throws when the team config is missing', async () => {
  const { facade } = createTeamLifecycleFacade();
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.TEAM_LAUNCH,
      idempotencyKey: 'team-launch-missing',
      actor: { teamId: 'team-alpha', agentId: 'operator' },
      args: { teamId: 'team-alpha' },
    }),
    /no config for teamId/,
  );
});

test('LocalToolFacade team_launch skips members that are already running', async () => {
  const { facade, registry, launches } = createTeamLifecycleFacade({
    teamRuntimes: [
      { runtimeId: 'runtime-team-alpha-lead', teamId: 'team-alpha', agentId: 'lead', status: 'running' },
    ],
  });
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'team-alpha',
    lead: { agentId: 'lead' },
    teammates: [{ agentId: 'worker-1' }],
  }));

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-resume',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(launches.length, 1, 'only the missing member should be launched');
  assert.equal(launches[0].agentId, 'worker-1');
  assert.equal(result.members[0].status, 'already_running');
  assert.equal(result.members[1].status, 'starting');
});

test('LocalToolFacade team_launch records per-member failures without aborting the rest', async () => {
  const launches = [];
  const registry = new (class {
    teams = new Map();
    registerTeam(c) { this.teams.set(c.teamId, c); }
    getTeam(id) { return this.teams.get(id) || null; }
  })();
  const runtimeRegistry = { listRuntimes: () => [], getRuntime: () => null };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    runtimeRegistry,
    launchAgent(input) {
      launches.push(input);
      if (input.agentId === 'worker-1') return Promise.reject(new Error('boom'));
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'starting' });
    },
  });
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'team-alpha',
    lead: { agentId: 'lead' },
    teammates: [{ agentId: 'worker-1' }, { agentId: 'worker-2' }],
  }));

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-partial',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(launches.length, 3);
  assert.equal(result.members[0].status, 'starting');
  assert.equal(result.members[1].status, 'failed');
  assert.match(result.members[1].error, /boom/);
  assert.equal(result.members[2].status, 'starting');
});

test('LocalToolFacade team_stop stops every running runtime in the team', async () => {
  const { facade, stops } = createTeamLifecycleFacade({
    teamRuntimes: [
      { runtimeId: 'runtime-team-alpha-lead', teamId: 'team-alpha', agentId: 'lead', status: 'running' },
      { runtimeId: 'runtime-team-alpha-worker-1', teamId: 'team-alpha', agentId: 'worker-1', status: 'running' },
      { runtimeId: 'runtime-other-lead', teamId: 'team-other', agentId: 'lead', status: 'running' },
    ],
  });

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_STOP,
    idempotencyKey: 'team-stop-1',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha', signal: 'SIGTERM' },
  });

  assert.equal(stops.length, 2);
  assert.deepEqual(stops.map((s) => s.runtimeId).sort(), ['runtime-team-alpha-lead', 'runtime-team-alpha-worker-1']);
  assert.equal(stops[0].signal, 'SIGTERM');
  assert.equal(result.teamId, 'team-alpha');
  assert.equal(result.members.length, 2);
});

test('LocalToolFacade team_stop is a no-op idempotent return when no runtimes match', async () => {
  const { facade, stops } = createTeamLifecycleFacade();

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_STOP,
    idempotencyKey: 'team-stop-empty',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(stops.length, 0);
  assert.deepEqual(result, { teamId: 'team-alpha', members: [] });
});

test('LocalToolFacade routes agent_stop to the stopAgent callback', async () => {
  const calls = [];
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    stopAgent(input) {
      calls.push(input);
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'stopped', signal: input.signal });
    },
  });

  const result = await facade.execute({
    commandName: COMMANDS.AGENT_STOP,
    idempotencyKey: 'stop-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { runtimeId: 'runtime-lead-1', signal: 'SIGTERM' },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { runtimeId: 'runtime-lead-1', signal: 'SIGTERM' });
  assert.deepEqual(result, { runtimeId: 'runtime-lead-1', status: 'stopped', signal: 'SIGTERM' });
});

test('LocalToolFacade rejects agent_stop when no stopAgent callback is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.AGENT_STOP,
      idempotencyKey: 'stop-fail',
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-lead-1' },
    }),
    /agent_stop is not configured/,
  );
});

test('LocalToolFacade requires idempotencyKey for agent_stop', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    stopAgent: () => ({ runtimeId: 'r', status: 'stopped' }),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_STOP,
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-lead-1' },
    }),
    /idempotencyKey/,
  );
});

test('LocalToolFacade requires idempotencyKey for agent_launch', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    launchAgent: () => ({ runtimeId: 'r', status: 'starting' }),
  });
  // execute()'s mutating-command check is synchronous — throws before reaching the async handler
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /idempotencyKey/,
  );
});

test('LocalToolFacade dispatches diagnostics_run and returns a structured report', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const spawnFn = (command) => {
    if (command.includes('--version')) return { exitCode: 0, stdout: '1.2.3', stderr: '', durationMs: 1 };
    if (command.includes('auth status')) return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '', durationMs: 1 };
    return { exitCode: 127, stdout: '', stderr: 'unknown', durationMs: 0 };
  };
  const registry = new (class {
    teams = new Map();
    registerTeam(c) { this.teams.set(c.teamId, c); }
    getTeam(id) { return this.teams.get(id) || null; }
    listTeams() { return Array.from(this.teams.values()); }
  })();
  registry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    spawnValidation: spawnFn,
    dbPath: 'C:/Project-TOAD/.toad/toad.db',
  });
  const report = facade.execute({
    commandName: COMMANDS.DIAGNOSTICS_RUN,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: {},
  });
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.summary);
  // Should include all the enforcement checks
  const ids = report.checks.map((c) => c.id);
  assert.ok(ids.includes('state_machine_invalid_transitions_rejected'));
  assert.ok(ids.includes('role_authority_denies_developer_agent_launch'));
  assert.ok(ids.includes('validation_commands_configured'));
  assert.ok(ids.includes('provider_claude_detected'));
  assert.ok(ids.includes('provider_claude_authenticated'));
  assert.ok(ids.includes('dbpath_persistent'));
});

test('LocalToolFacade.diagnostics_run is callable by every role (read-only)', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: '1.0', stderr: '', durationMs: 1 }),
    dbPath: '/tmp/x.db',
  });
  for (const role of ['developer', 'reviewer', 'tester', 'architect', 'lead', 'human']) {
    const report = facade.execute({
      commandName: COMMANDS.DIAGNOSTICS_RUN,
      actor: { teamId: 'team-a', agentId: `${role}-1`, role },
      args: {},
    });
    assert.ok(Array.isArray(report.checks), `role ${role} did not get checks`);
  }
});

test('LocalToolFacade blocks merge_ready → done for non-lead roles', async () => {
  const spawnFn = (cmd) => cmd.includes('claude') ? { exitCode: 0, stdout: '1.0', stderr: '', durationMs: 1 } : { exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 };
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const registry = new (class {
    teams = new Map();
    registerTeam(c) { this.teams.set(c.teamId, c); }
    getTeam(id) { return this.teams.get(id) || null; }
    listTeams() { return Array.from(this.teams.values()); }
  })();
  registry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    spawnValidation: spawnFn,
  });
  // Walk a task to merge_ready as lead (privileged setup)
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rg-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rg-1', subject: 'role-guard', status: 'pending' },
  });
  for (const [id, status] of [
    ['rg-2', 'in_progress'],
    ['rg-3', 'review'],
    ['rg-4', 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'rg-1', status },
    });
  }
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'rg-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'rg-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rg-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rg-1', status: 'merge_ready' },
  });
  // Developer cannot complete the merge
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'rg-deny',
      actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
      args: { taskId: 'rg-1', status: 'done' },
    }),
    /role developer cannot perform merge_ready . done/,
  );
  // Lead can
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rg-allow',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rg-1', status: 'done' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rg-1' });
  assert.equal(task.status, 'done');
});

test('LocalToolFacade triggers worktree creation when a task transitions ready → planned', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const calls = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      calls.push({ teamId, taskId });
      return {
        status: 'created',
        path: `/tmp/.toad/worktrees/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'abc123',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'wt-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1', subject: 'wt', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1', status: 'ready' },
  });
  // Approve a plan so the ready→planned gate passes
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'wt-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'wt-1', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'wt-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1' },
  });
  // The transition that triggers worktree creation
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1', status: 'planned' },
  });
  // Manager called once for this task
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { teamId: 'team-a', taskId: 'wt-1' });
  // Projection picks up the worktree
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'wt-1' });
  assert.equal(task.worktree.status, 'created');
  assert.equal(task.worktree.branch, 'toad/team-a/wt-1');
  assert.equal(task.worktree.baseRef, 'abc123');
});

test('LocalToolFacade tolerates worktreeManager throwing (best-effort, transition still completes)', async () => {
  const fakeWorktreeManager = {
    createForTask() { throw new Error('git is busted'); },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'wt2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2', subject: 'wt2', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt2-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'wt2-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'wt-2', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'wt2-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2' },
  });
  // Should not throw — transition still completes
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt2-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2', status: 'planned' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'wt-2' });
  assert.equal(task.status, 'planned');
});

test('LocalToolFacade does not trigger worktree creation when no manager is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    // no worktreeManager
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'wt3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3', subject: 'wt3', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt3-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'wt3-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'wt-3', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'wt3-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt3-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3', status: 'planned' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'wt-3' });
  assert.equal(task.status, 'planned');
  assert.equal(task.worktree, null);
});

// --- §19 slice 1: merge_ready → done blocked when worktree branch would conflict with baseRef ---

function setupMergeReadyTask(facade, { taskId = 'mr-1' } = {}) {
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: `${taskId}-create`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, subject: 'merge', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: `${taskId}-ready`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: `${taskId}-plan`,
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId, summary: 'm' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: `${taskId}-app`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId },
  });
  for (const [id, status] of [
    [`${taskId}-planned`, 'planned'],
    [`${taskId}-ip`, 'in_progress'],
    [`${taskId}-rev`, 'review'],
    [`${taskId}-test`, 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId, status },
    });
  }
}

function buildMergeFacade({ checkForConflicts, removeForTask = () => ({ status: 'removed', path: '/x', removedAt: 'now' }) } = {}) {
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return { status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: `toad/${teamId}/${taskId}`, baseRef: 'base-sha', createdAt: 'now' };
    },
    removeForTask,
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    worktreeManager: fakeWorktreeManager,
    mergeChecker: { checkForConflicts },
  });
  return facade;
}

test('merge_ready → done is allowed when mergeChecker reports clean', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({ checkForConflicts: () => ({ status: 'clean' }) });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-clean' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-clean-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-clean', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-clean-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-clean', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-clean-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-clean', status: 'done' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-clean' });
  assert.equal(task.status, 'done');
});

test('merge_ready → done is BLOCKED when mergeChecker reports conflict, with file list in error', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({
    checkForConflicts: () => ({ status: 'conflict', files: ['src/foo.js', 'src/bar.js'] }),
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-conf' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-conf-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-conf', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-conf-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-conf', status: 'merge_ready' },
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'mc-conf-done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'mc-conf', status: 'done' },
    }),
    /merge_ready . done blocked.*conflict.*src\/foo\.js/,
  );
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-conf' });
  assert.equal(task.status, 'merge_ready', 'task should still be merge_ready after blocked transition');
});

test('merge_ready → done is BLOCKED when mergeChecker reports error (operator must investigate)', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({
    checkForConflicts: () => ({ status: 'error', error: 'worktree has uncommitted changes' }),
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-err' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-err-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-err', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-err-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-err', status: 'merge_ready' },
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'mc-err-done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'mc-err', status: 'done' },
    }),
    /merge_ready . done blocked.*uncommitted changes/,
  );
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-err' });
  assert.equal(task.status, 'merge_ready');
});

test('merge_ready → done has no merge gate when no worktree exists (back-compat)', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  let checkerCalled = false;
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    // no worktreeManager → no worktree gets attached
    mergeChecker: { checkForConflicts: () => { checkerCalled = true; return { status: 'clean' }; } },
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-nowt' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-nowt-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-nowt', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-nowt-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-nowt', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-nowt-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-nowt', status: 'done' },
  });
  assert.equal(checkerCalled, false, 'mergeChecker should not run without a worktree');
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-nowt' });
  assert.equal(task.status, 'done');
});

// --- §20: task_history_export ---

test('task_history_export returns the projection, taskEvents in order, and runtimeEvents (when eventLog provided)', () => {
  const events = [];
  const fakeEventLog = {
    appendEvent(input) { events.push(input); return { inserted: true, event: input }; },
    listEventsByTask({ teamId, taskId }) {
      assert.equal(teamId, 'team-a');
      assert.equal(taskId, 'th-1');
      return [
        { eventId: 're-1', runtimeId: 'rt-1', teamId, agentId: 'dev', eventType: 'assistant_text', payload: { text: 'hi' }, createdAt: '2026-05-01T00:10:00.000Z' },
      ];
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog: fakeEventLog,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'th-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-1', subject: 'history' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_COMMENT,
    idempotencyKey: 'th-c1',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-1', text: 'first comment' },
  });
  const exp = facade.execute({
    commandName: COMMANDS.TASK_HISTORY_EXPORT,
    actor: { teamId: 'team-a', agentId: 'reviewer-1', role: 'reviewer' },
    args: { taskId: 'th-1' },
  });
  assert.equal(exp.task.taskId, 'th-1');
  assert.equal(exp.task.subject, 'history');
  assert.ok(Array.isArray(exp.taskEvents));
  // CREATED + COMMENT_ADDED, in order
  assert.equal(exp.taskEvents.length, 2);
  assert.equal(exp.taskEvents[0].eventType, 'task.created');
  assert.equal(exp.taskEvents[1].eventType, 'task.comment_added');
  assert.ok(Array.isArray(exp.runtimeEvents));
  assert.equal(exp.runtimeEvents.length, 1);
  assert.equal(exp.runtimeEvents[0].eventType, 'assistant_text');
});

test('task_history_export returns empty runtimeEvents when no eventLog is configured', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'th2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-2', subject: 'no event log' },
  });
  const exp = facade.execute({
    commandName: COMMANDS.TASK_HISTORY_EXPORT,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-2' },
  });
  assert.equal(exp.task.taskId, 'th-2');
  assert.deepEqual(exp.runtimeEvents, []);
});

test('task_history_export throws when taskId is not provided', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_HISTORY_EXPORT,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: {},
    }),
    /taskId/,
  );
});

test('task_history_export is callable by every role (read-only)', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'th3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-3', subject: 's' },
  });
  for (const role of ['developer', 'reviewer', 'tester', 'architect', 'lead', 'human']) {
    const exp = facade.execute({
      commandName: COMMANDS.TASK_HISTORY_EXPORT,
      actor: { teamId: 'team-a', agentId: `${role}-x`, role },
      args: { taskId: 'th-3' },
    });
    assert.equal(exp.task.taskId, 'th-3', `role ${role} couldn't export`);
  }
});

// --- §13 partial: no-op diff detector ---

test('review_request flags review.noOpDiff = true when computed diff has no files', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: '', files: [] }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'no-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-1', subject: 'noop', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'no-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-1', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'no-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-1' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'no-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-1', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'no-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-1', summary: 'I did the thing' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-1' });
  assert.equal(task.review.noOpDiff, true);
});

test('review_request leaves noOpDiff false when files have actual changes', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'real diff', files: ['x.js'] }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'no2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-2', subject: 's' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'no2-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-2', summary: 's', diff: 'caller', files: ['caller.js'] },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-2' });
  assert.equal(task.review.noOpDiff, false);
});

test('review_request leaves noOpDiff false when no diff computer was able to run (no worktree, caller silent)', () => {
  // Caller didn't supply diff; no worktree → no diff computed → not the "I did work but no files changed" case
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'no3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-3', subject: 's' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'no3-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-3', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-3' });
  // No diff computed → don't claim no-op (we don't actually know)
  assert.equal(task.review.noOpDiff, false);
});

// --- §13 partial: scope-drift detection in review_request ---

test('review_request flags scope drift: files outside plan.filesExpectedToChange land in review.scopeDrift', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['src/parser.js', 'src/scope-creep.js', 'README.md'] }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-1', subject: 'scope', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-1', summary: 's', filesExpectedToChange: ['src/parser.js'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-1' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-1', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-1', summary: 'please review' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-1' });
  // Plan only allowed src/parser.js — the other two are out of scope
  assert.deepEqual(task.review.scopeDrift, ['src/scope-creep.js', 'README.md']);
  assert.deepEqual(task.review.files, ['src/parser.js', 'src/scope-creep.js', 'README.md']);
});

test('review_request does not flag anything when all changed files are in the plan', () => {
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['src/parser.js', 'src/parser.test.js'] }),
  };
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-2', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd2-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-2', summary: 's', filesExpectedToChange: ['src/parser.js', 'src/parser.test.js'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd2-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-2' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd2-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-2', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd2-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-2', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-2' });
  assert.deepEqual(task.review.scopeDrift, []);
});

test('review_request supports directory wildcard "src/parser/**" in plan.filesExpectedToChange', () => {
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['src/parser/lex.js', 'src/parser/sub/parse.js', 'src/main.js'] }),
  };
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-3', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd3-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-3', summary: 's', filesExpectedToChange: ['src/parser/**'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd3-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-3' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd3-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-3', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd3-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-3', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-3' });
  // Both src/parser/* files match; src/main.js is drift
  assert.deepEqual(task.review.scopeDrift, ['src/main.js']);
});

test('review_request leaves scopeDrift empty when plan has no filesExpectedToChange', () => {
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['anywhere.js'] }),
  };
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd4-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-4', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd4-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-4', summary: 's' /* no filesExpectedToChange */ },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd4-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-4' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd4-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-4', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd4-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-4', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-4' });
  // No expectation set → no drift flagged
  assert.deepEqual(task.review.scopeDrift, []);
});

// --- §7 finished: review_request auto-computes diff against task worktree ---

test('review_request auto-computes diff and files when task has worktree and caller omits both', async () => {
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return {
        status: 'created',
        path: `/tmp/wt/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'base-sha',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
  };
  const fakeDiffComputer = {
    computeDiff({ worktreePath, baseRef }) {
      assert.equal(worktreePath, '/tmp/wt/team-a/dx-1');
      assert.equal(baseRef, 'base-sha');
      return { diff: 'diff --git a/x.js ...', files: ['x.js', 'y.js'] };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  // Walk task to a state where review_request makes sense
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', subject: 'diff', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'dx-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-1', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'dx-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx-ip',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', status: 'in_progress' },
  });
  // No diff or files supplied — orchestrator computes them
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-1', summary: 'please review' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-1' });
  assert.equal(task.review.diff, 'diff --git a/x.js ...');
  assert.deepEqual(task.review.files, ['x.js', 'y.js']);
});

test('review_request preserves caller-supplied diff/files (operator override wins)', () => {
  const fakeDiffComputer = {
    computeDiff() {
      // Should not be called when caller supplies diff
      throw new Error('diff computer should not run when caller provides diff');
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-2', subject: 'diff2' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx2-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-2', diff: 'caller diff', files: ['caller.js'] },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-2' });
  assert.equal(task.review.diff, 'caller diff');
  assert.deepEqual(task.review.files, ['caller.js']);
});

test('review_request without worktree leaves diff/files unset (no auto-compute)', () => {
  const fakeDiffComputer = {
    computeDiff() {
      throw new Error('should not be called when no worktree');
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-3', subject: 'no wt' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx3-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-3', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-3' });
  assert.equal(task.review.diff, null);
  assert.deepEqual(task.review.files, []);
});

test('review_request tolerates diffComputer errors (best-effort, no diff/files attached)', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({
      status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now',
    }),
  };
  const fakeDiffComputer = {
    computeDiff() {
      return { diff: null, files: [], error: 'git is busted' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  // Quick path to a task with worktree
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx4-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-4', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'dx4-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-4', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'dx4-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-4' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx4-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-4', status: 'planned' },
  });
  // Should not throw despite diff error
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx4-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-4', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-4' });
  assert.equal(task.review.diff, null);
  assert.deepEqual(task.review.files, []);
});

// --- §8 slice 3: worktree removal on done ---

test('LocalToolFacade calls worktreeManager.removeForTask when a task transitions merge_ready → done', async () => {
  const removeCalls = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return {
        status: 'created',
        path: `/tmp/wt/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'abc',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
    removeForTask({ teamId, taskId }) {
      removeCalls.push({ teamId, taskId });
      return { status: 'removed', path: `/tmp/wt/${teamId}/${taskId}`, removedAt: '2026-05-01T01:00:00.000Z' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    worktreeManager: fakeWorktreeManager,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  // Walk the task all the way through the lifecycle
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rm-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1', subject: 'cleanup', status: 'pending' },
  });
  for (const [id, status] of [
    ['rm-ready', 'ready'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'rm-1', status },
    });
  }
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'rm-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'rm-1', summary: 'cleanup' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'rm-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1' },
  });
  for (const [id, status] of [
    ['rm-planned', 'planned'],
    ['rm-ip', 'in_progress'],
    ['rm-rev', 'review'],
    ['rm-test', 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'rm-1', status },
    });
  }
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'rm-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'rm-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rm-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1', status: 'merge_ready' },
  });
  // No removal yet
  assert.equal(removeCalls.length, 0);
  // Move to done — should trigger removal
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rm-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1', status: 'done' },
  });
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0], { teamId: 'team-a', taskId: 'rm-1' });
  // Projection picks up removal
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rm-1' });
  assert.equal(task.worktree.status, 'removed');
  assert.equal(task.worktree.removedAt, '2026-05-01T01:00:00.000Z');
});

test('LocalToolFacade does NOT remove worktree on rejected (operator triages manually)', () => {
  const removeCalls = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return { status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' };
    },
    removeForTask(input) { removeCalls.push(input); return { status: 'removed', path: '', removedAt: 'now' }; },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rj-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rj-1', subject: 'reject', status: 'review' },
  });
  // review → rejected
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rj-rej',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rj-1', status: 'rejected' },
  });
  assert.equal(removeCalls.length, 0, 'rejected should not auto-remove worktree');
});

test('LocalToolFacade tolerates worktreeManager.removeForTask throwing (best-effort)', async () => {
  const fakeWorktreeManager = {
    createForTask: () => ({ status: 'created', path: '/tmp/x', branch: 'b', baseRef: 'r', createdAt: 'now' }),
    removeForTask() { throw new Error('git is busted'); },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    worktreeManager: fakeWorktreeManager,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  // Walk to merge_ready quickly
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rt-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rt-1', subject: 't', status: 'testing' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'rt-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'rt-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rt-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rt-1', status: 'merge_ready' },
  });
  // Done should not throw even though removeForTask blows up
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rt-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rt-1', status: 'done' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rt-1' });
  assert.equal(task.status, 'done');
});

// --- §8 slice 4: explicit baseRef from task_create flows into worktree creation ---

test('task_create accepts baseRef + baseBranch and surfaces them on the projection', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'br-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-1', subject: 'baseref task', baseRef: 'feature-anchor', baseBranch: 'develop' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'br-1' });
  assert.equal(task.baseRef, 'feature-anchor');
  assert.equal(task.baseBranch, 'develop');
});

test('worktreeManager.createForTask receives task.baseRef from facade hook on ready→planned', () => {
  const seen = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId, baseRef }) {
      seen.push({ teamId, taskId, baseRef });
      return { status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: baseRef || 'fallback', createdAt: 'now' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'br2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-2', subject: 's', baseRef: 'pinned-sha', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'br2-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'br-2', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'br2-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-2' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'br2-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-2', status: 'planned' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].baseRef, 'pinned-sha');
});

test('worktreeManager.createForTask receives undefined baseRef when task did not capture one (HEAD fallback)', () => {
  const seen = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId, baseRef }) {
      seen.push({ baseRef });
      return { status: 'created', path: '/tmp/x', branch: 'b', baseRef: 'fb', createdAt: 'now' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'br3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-3', subject: 's', status: 'ready' /* no baseRef */ },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'br3-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'br-3', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'br3-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-3' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'br3-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-3', status: 'planned' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].baseRef, undefined);
});

// --- §8 slice 2: agent_launch cwd enforcement against task worktree ---

function setupTaskWithWorktree(facade, taskId = 'cwd-1') {
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: `${taskId}-create`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, subject: 'cwd', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: `${taskId}-ready`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: `${taskId}-plan`,
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId, summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: `${taskId}-approve`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: `${taskId}-planned`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, status: 'planned' },
  });
}

function makeWorktreeFacade({ workingPath = '/tmp/wt-cwd' } = {}) {
  const launches = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return {
        status: 'created',
        path: `${workingPath}/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'abc123',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    launchAgent: async (input) => {
      launches.push(input);
      return { runtimeId: input.runtimeId, status: 'running' };
    },
  });
  return { facade, launches };
}

test('agent_launch auto-sets cwd to worktree path when caller omits cwd', async () => {
  const { facade, launches } = makeWorktreeFacade();
  setupTaskWithWorktree(facade, 'cwd-1');
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-1', command: 'claude', taskId: 'cwd-1' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/tmp/wt-cwd/team-a/cwd-1');
});

test('agent_launch accepts a cwd that matches the task worktree path', async () => {
  const { facade, launches } = makeWorktreeFacade();
  setupTaskWithWorktree(facade, 'cwd-2');
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-2',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-2', command: 'claude', taskId: 'cwd-2', cwd: '/tmp/wt-cwd/team-a/cwd-2' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/tmp/wt-cwd/team-a/cwd-2');
});

test('agent_launch rejects a cwd that conflicts with the task worktree path', async () => {
  const { facade, launches } = makeWorktreeFacade();
  setupTaskWithWorktree(facade, 'cwd-3');
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'al-3',
      actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-3', command: 'claude', taskId: 'cwd-3', cwd: '/elsewhere' },
    }),
    /agent_launch: cwd .* must match task worktree/,
  );
  assert.equal(launches.length, 0);
});

test('agent_launch with no taskId is unconstrained (back-compat)', async () => {
  const { facade, launches } = makeWorktreeFacade();
  // No task / no worktree on the call
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-4',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-4', command: 'claude', cwd: '/anywhere' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/anywhere');
});

test('agent_launch with taskId for a task that has no created worktree leaves cwd unchanged', async () => {
  const { facade, launches } = makeWorktreeFacade();
  // Task that never reached planned — no worktree
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'cwd-5-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cwd-5', subject: 'no wt' },
  });
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-5',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-5', command: 'claude', taskId: 'cwd-5', cwd: '/anywhere' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/anywhere');
});

test('LocalToolFacade emits tool_call_denied event when role authority rejects a call', () => {
  const events = [];
  const eventLog = {
    appendEvent(input) {
      events.push(input);
      return { inserted: true, event: input };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog,
  });
  // Developer cannot call agent_launch
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'dn-1',
      actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /role authority: developer cannot call agent_launch/,
  );
  // Exactly one tool_call_denied event recorded
  const denied = events.filter((e) => e.eventType === 'tool_call_denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].teamId, 'team-a');
  assert.equal(denied[0].agentId, 'dev-1');
  assert.equal(denied[0].payload.commandName, 'agent_launch');
  assert.equal(denied[0].payload.role, 'developer');
  assert.match(denied[0].payload.reason, /developer cannot call agent_launch/);
});

test('LocalToolFacade does not emit tool_call_denied for allowed calls', () => {
  const events = [];
  const eventLog = {
    appendEvent(input) { events.push(input); return { inserted: true, event: input }; },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog,
  });
  // Lead can call agent_status (no idempotency key required for read-only)
  facade.execute({
    commandName: COMMANDS.TASK_LIST,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {},
  });
  const denied = events.filter((e) => e.eventType === 'tool_call_denied');
  assert.equal(denied.length, 0);
});

test('LocalToolFacade tool_call_denied event emission is best-effort (does not mask original error)', () => {
  const eventLog = {
    appendEvent() { throw new Error('event log is broken'); },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog,
  });
  // Original role-authority error should bubble even if event log throws
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'dn-2',
      actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /role authority: developer cannot call agent_launch/,
  );
});

test('LocalToolFacade blocks blocked → in_progress for developer/reviewer/tester', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'b-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'b-1', subject: 'block-guard', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'b-ip',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'b-1', status: 'in_progress' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'b-block',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'b-1', status: 'blocked' },
  });
  // Developer + tester both have task_update access via role-authority but should be
  // blocked by the per-transition guard. (Reviewer can't call task_update at all —
  // role-authority denies them at a higher layer; they're not part of this test.)
  for (const role of ['developer', 'tester']) {
    assert.throws(
      () => facade.execute({
        commandName: COMMANDS.TASK_UPDATE,
        idempotencyKey: `b-deny-${role}`,
        actor: { teamId: 'team-a', agentId: `${role}-1`, role },
        args: { taskId: 'b-1', status: 'in_progress' },
      }),
      /role .* cannot perform blocked . in_progress/,
    );
  }
  // Architect can unblock
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'b-arch',
    actor: { teamId: 'team-a', agentId: 'arch-1', role: 'architect' },
    args: { taskId: 'b-1', status: 'in_progress' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'b-1' });
  assert.equal(task.status, 'in_progress');
});
