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
