import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard, TASK_EVENT_TYPES } from '../src/task/inMemoryTaskBoard.js';
import { LocalReadModel } from '../src/read/LocalReadModel.js';
import { formatCrossTeamText, CROSS_TEAM_SOURCE, CROSS_TEAM_SENT_SOURCE } from '../src/protocol/crossTeam.js';

class MemoryRuntimeRegistry {
  constructor(runtimes = []) {
    this.runtimes = runtimes;
  }

  listRuntimes({ teamId } = {}) {
    return this.runtimes.filter((runtime) => !teamId || runtime.teamId === teamId);
  }
}

class MemoryEventLog {
  constructor(events = []) {
    this.events = events;
  }

  listEvents({ teamId, runtimeId } = {}) {
    return this.events.filter((event) => {
      if (teamId && event.teamId !== teamId) return false;
      if (runtimeId && event.runtimeId !== runtimeId) return false;
      return true;
    });
  }
}

class MemoryApprovalBroker {
  constructor(approvals = []) {
    this.approvals = approvals;
  }

  listApprovals({ teamId } = {}) {
    return this.approvals.filter((approval) => !teamId || approval.teamId === teamId);
  }
}

function createReadModel() {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Coordinate the work.',
    createdAt: '2026-04-29T00:00:00.000Z',
  });
  broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'agent', id: 'lead' },
    to: { kind: 'user' },
    kind: 'reply',
    text: 'Working on it.',
    createdAt: '2026-04-29T00:01:00.000Z',
  });
  taskBoard.appendEvent({
    teamId: 'team-a',
    taskId: 'storage',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'lead',
    payload: { subject: 'Build storage' },
  });
  const runtimeRegistry = new MemoryRuntimeRegistry([
    {
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      status: 'running',
      providerId: 'claude',
      pid: 1234,
    },
  ]);
  const eventLog = new MemoryEventLog([
    {
      eventId: 'event-1',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'assistant_text',
      createdAt: '2026-04-29T00:01:00.000Z',
      payload: { text: 'Working on it.' },
    },
    {
      eventId: 'event-2',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'tool_use',
      createdAt: '2026-04-29T00:02:00.000Z',
      payload: {
        toolName: 'message_send',
        toolUseId: 'tool-1',
        input: { to: { kind: 'agent', agentId: 'worker-1' }, text: 'Start.' },
      },
    },
    {
      eventId: 'event-3',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'tool_use',
      createdAt: '2026-04-29T00:03:00.000Z',
      payload: {
        toolName: 'task_create',
        toolUseId: 'tool-2',
        input: { taskId: 'task-1', subject: 'Build parser' },
      },
    },
    {
      eventId: 'event-4',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'turn_completed',
      createdAt: '2026-04-29T00:04:00.000Z',
      payload: {},
    },
    {
      eventId: 'event-5',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'approval_request',
      createdAt: '2026-04-29T00:05:00.000Z',
      payload: { toolName: 'Write', approvalId: 'approval-1' },
    },
  ]);
  const approvalBroker = new MemoryApprovalBroker([
    {
      approvalId: 'approval-1',
      teamId: 'team-a',
      agentId: 'lead',
      status: 'pending',
      prompt: 'Allow file edit?',
    },
    {
      approvalId: 'approval-2',
      teamId: 'team-a',
      agentId: 'lead',
      status: 'approved',
      prompt: 'Allow command?',
    },
  ]);
  return new LocalReadModel({ broker, taskBoard, runtimeRegistry, eventLog, approvalBroker });
}

test('LocalReadModel projects team chat rows from broker messages', () => {
  const readModel = createReadModel();

  const chat = readModel.listTeamChat({ teamId: 'team-a' });

  assert.equal(chat.length, 2);
  assert.equal(chat[0].type, 'message');
  assert.equal(chat[0].text, 'Coordinate the work.');
  assert.equal(chat[0].direction, 'inbound');
  assert.equal(chat[1].direction, 'outbound');
});

test('LocalReadModel projects task board, runtimes, and audit rows', () => {
  const readModel = createReadModel();

  const tasks = readModel.listTaskBoard({ teamId: 'team-a' });
  const processes = readModel.listRuntimeProcesses({ teamId: 'team-a' });
  const audit = readModel.listRuntimeAudit({ teamId: 'team-a' });
  const approvals = readModel.listApprovals({ teamId: 'team-a' });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].subject, 'Build storage');
  assert.equal(processes.length, 1);
  assert.equal(processes[0].status, 'running');
  assert.equal(audit.length, 5);
  assert.equal(audit[0].eventType, 'assistant_text');
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].approvalId, 'approval-1');
});

test('LocalReadModel returns compact team overview counts', () => {
  const readModel = createReadModel();

  const overview = readModel.getTeamOverview({ teamId: 'team-a' });

  assert.deepEqual(overview.counts, {
    messages: 2,
    tasks: 1,
    runtimes: 1,
    runtimeEvents: 5,
    approvals: 2,
    pendingApprovals: 1,
    toolCalls: 2,
    apiRetries: 0,
  });
  assert.equal(overview.recentMessages.length, 2);
  assert.equal(overview.activeRuntimes.length, 1);
  assert.equal(overview.pendingApprovals.length, 1);
});

test('LocalReadModel.listToolCalls returns only tool_use events', () => {
  const readModel = createReadModel();

  const toolCalls = readModel.listToolCalls({ teamId: 'team-a' });

  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].type, 'tool_call');
  assert.equal(toolCalls[0].toolName, 'message_send');
  assert.equal(toolCalls[0].toolUseId, 'tool-1');
  assert.equal(toolCalls[0].agentId, 'lead');
  assert.deepStrictEqual(toolCalls[0].input, {
    to: { kind: 'agent', agentId: 'worker-1' },
    text: 'Start.',
  });
  assert.equal(toolCalls[1].toolName, 'task_create');
  assert.equal(toolCalls[1].toolUseId, 'tool-2');
});

test('LocalReadModel.listToolCalls filters by runtimeId', () => {
  const readModel = createReadModel();

  const toolCalls = readModel.listToolCalls({ teamId: 'team-a', runtimeId: 'runtime-lead-1' });
  assert.equal(toolCalls.length, 2);

  const noTools = readModel.listToolCalls({ teamId: 'team-a', runtimeId: 'runtime-other' });
  assert.equal(noTools.length, 0);
});

test('LocalReadModel.listToolCalls returns empty array when event log is unavailable', () => {
  const broker = new InMemoryBroker();
  const readModel = new LocalReadModel({ broker });

  const toolCalls = readModel.listToolCalls({ teamId: 'team-a' });

  assert.deepStrictEqual(toolCalls, []);
});

test('LocalReadModel.listToolCalls includes runtimeId and createdAt', () => {
  const readModel = createReadModel();

  const toolCalls = readModel.listToolCalls({ teamId: 'team-a' });

  assert.equal(toolCalls[0].runtimeId, 'runtime-lead-1');
  assert.equal(toolCalls[0].createdAt, '2026-04-29T00:02:00.000Z');
  assert.equal(toolCalls[1].createdAt, '2026-04-29T00:03:00.000Z');
});

// --- Runtime Health Monitoring (api_retry projection) ---

function createReadModelWithRetries() {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog([
    {
      eventId: 'event-1',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'assistant_text',
      createdAt: '2026-04-29T00:01:00.000Z',
      payload: { text: 'Working.' },
    },
    {
      eventId: 'event-r1',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'api_retry',
      createdAt: '2026-04-29T00:02:00.000Z',
      payload: {
        attempt: 1,
        maxRetries: 5,
        errorStatus: 429,
        error: 'rate_limit',
        errorMessage: 'Rate limit exceeded',
        retryDelayMs: 5000,
      },
    },
    {
      eventId: 'event-r2',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'api_retry',
      createdAt: '2026-04-29T00:02:05.000Z',
      payload: {
        attempt: 2,
        maxRetries: 5,
        errorStatus: 429,
        error: 'rate_limit',
        errorMessage: 'Rate limit exceeded',
        retryDelayMs: 10000,
      },
    },
    {
      eventId: 'event-r3',
      runtimeId: 'runtime-worker-1',
      teamId: 'team-a',
      agentId: 'worker',
      eventType: 'api_retry',
      createdAt: '2026-04-29T00:03:00.000Z',
      payload: {
        attempt: 1,
        maxRetries: 3,
        errorStatus: 500,
        error: 'internal_error',
        errorMessage: 'Internal server error',
        retryDelayMs: 2000,
      },
    },
    {
      eventId: 'event-t1',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'tool_use',
      createdAt: '2026-04-29T00:04:00.000Z',
      payload: { toolName: 'message_send', toolUseId: 'tool-1', input: {} },
    },
  ]);
  return new LocalReadModel({ broker, eventLog });
}

test('LocalReadModel.listApiRetries returns only api_retry events', () => {
  const readModel = createReadModelWithRetries();

  const retries = readModel.listApiRetries({ teamId: 'team-a' });

  assert.equal(retries.length, 3);
  assert.equal(retries[0].type, 'api_retry');
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].maxRetries, 5);
  assert.equal(retries[0].errorStatus, 429);
  assert.equal(retries[0].error, 'rate_limit');
  assert.equal(retries[0].errorMessage, 'Rate limit exceeded');
  assert.equal(retries[0].retryDelayMs, 5000);
  assert.equal(retries[0].agentId, 'lead');
  assert.equal(retries[1].attempt, 2);
  assert.equal(retries[2].error, 'internal_error');
});

test('LocalReadModel.listApiRetries filters by runtimeId', () => {
  const readModel = createReadModelWithRetries();

  const leadRetries = readModel.listApiRetries({ teamId: 'team-a', runtimeId: 'runtime-lead-1' });
  assert.equal(leadRetries.length, 2);

  const workerRetries = readModel.listApiRetries({ teamId: 'team-a', runtimeId: 'runtime-worker-1' });
  assert.equal(workerRetries.length, 1);
  assert.equal(workerRetries[0].agentId, 'worker');
});

test('LocalReadModel.listApiRetries returns empty when event log unavailable', () => {
  const broker = new InMemoryBroker();
  const readModel = new LocalReadModel({ broker });

  const retries = readModel.listApiRetries({ teamId: 'team-a' });
  assert.deepStrictEqual(retries, []);
});

test('LocalReadModel.listApiRetries includes runtimeId and createdAt', () => {
  const readModel = createReadModelWithRetries();

  const retries = readModel.listApiRetries({ teamId: 'team-a' });
  assert.equal(retries[0].runtimeId, 'runtime-lead-1');
  assert.equal(retries[0].createdAt, '2026-04-29T00:02:00.000Z');
  assert.equal(retries[2].runtimeId, 'runtime-worker-1');
});

test('LocalReadModel.getTeamOverview includes apiRetries count', () => {
  const readModel = createReadModelWithRetries();

  const overview = readModel.getTeamOverview({ teamId: 'team-a' });

  assert.equal(overview.counts.apiRetries, 3);
  assert.equal(overview.counts.toolCalls, 1);
  assert.equal(overview.counts.runtimeEvents, 5);
});

test('LocalReadModel.listCrossTeamMessages projects only cross-team rows', () => {
  const broker = new InMemoryBroker();
  broker.appendMessage({
    messageId: 'msg-normal',
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Normal local message.',
    createdAt: '2026-04-29T00:00:00.000Z',
  });
  broker.appendMessage({
    messageId: 'msg-inbound',
    teamId: 'team-a',
    from: { kind: 'agent', id: 'lead', teamId: 'team-b' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: formatCrossTeamText('team-b.lead', 1, 'Inbound from team B.', {
      conversationId: 'conv-1',
      replyToConversationId: 'conv-root',
    }),
    metadata: { source: CROSS_TEAM_SOURCE, chainDepth: 1 },
    createdAt: '2026-04-29T00:01:00.000Z',
  });
  broker.appendMessage({
    messageId: 'msg-outbound',
    teamId: 'team-a',
    from: { kind: 'agent', id: 'lead', teamId: 'team-a' },
    to: { kind: 'agent', teamId: 'team-c', agentId: 'lead' },
    text: formatCrossTeamText('team-a.lead', 0, 'Outbound to team C.', {
      conversationId: 'conv-2',
    }),
    metadata: { source: CROSS_TEAM_SENT_SOURCE, chainDepth: 0, conversationId: 'conv-2' },
    createdAt: '2026-04-29T00:02:00.000Z',
  });

  const readModel = new LocalReadModel({ broker });
  const rows = readModel.listCrossTeamMessages({ teamId: 'team-a' });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.id), ['msg-inbound', 'msg-outbound']);
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].sourceTeamId, 'team-b');
  assert.equal(rows[0].targetTeamId, 'team-a');
  assert.equal(rows[0].conversationId, 'conv-1');
  assert.equal(rows[0].replyToConversationId, 'conv-root');
  assert.equal(rows[0].text, 'Inbound from team B.');
  assert.equal(rows[1].direction, 'outbound');
  assert.equal(rows[1].sourceTeamId, 'team-a');
  assert.equal(rows[1].targetTeamId, 'team-c');
  assert.equal(rows[1].targetAgentId, 'lead');
  assert.equal(rows[1].text, 'Outbound to team C.');
});

