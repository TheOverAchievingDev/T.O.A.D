import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callLocalMcpTool,
  getLocalMcpTool,
  listLocalMcpTools,
} from '../src/mcp/localToolDefinitions.js';

test('listLocalMcpTools exposes MCP-shaped local command tools', () => {
  const tools = listLocalMcpTools();
  const names = tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    'agent_launch',
    'agent_status',
    'agent_stop',
    'approval_list',
    'approval_respond',
    'cross_team_messages',
    'cross_team_send',
    'health_status',
    'message_send',
    'review_decide',
    'review_request',
    'runtime_events',
    'task_comment',
    'task_create',
    'task_list',
    'task_update',
    'tool_activity',
  ]);
  for (const tool of tools) {
    assert.equal(typeof tool.title, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('mutating MCP tools require idempotencyKey in their schemas', () => {
  for (const name of [
    'message_send',
    'task_create',
    'task_update',
    'task_comment',
    'review_request',
    'review_decide',
  ]) {
    const tool = getLocalMcpTool(name);
    assert.ok(tool.inputSchema.required.includes('idempotencyKey'), name);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.ok(getLocalMcpTool('approval_respond').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('approval_respond').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('cross_team_send').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('cross_team_send').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('agent_launch').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('agent_launch').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('agent_stop').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('agent_stop').annotations.destructiveHint, false);

  // Read-only tools
  for (const name of ['task_list', 'agent_status', 'approval_list', 'runtime_events', 'cross_team_messages', 'tool_activity', 'health_status']) {
    assert.ok(!getLocalMcpTool(name).inputSchema.required.includes('idempotencyKey'), name);
    assert.equal(getLocalMcpTool(name).annotations.readOnlyHint, true, `${name} should be readOnly`);
  }
});

test('callLocalMcpTool executes a local facade command and returns MCP content', async () => {
  const calls = [];
  const toolFacade = {
    execute(command) {
      calls.push(command);
      return { ok: true, messageId: 'message-1' };
    },
  };

  const result = await callLocalMcpTool({
    toolFacade,
    actor: { teamId: 'team-a', agentId: 'lead' },
    name: 'message_send',
    arguments: {
      idempotencyKey: 'idem-1',
      to: { kind: 'user' },
      text: 'Hello from MCP.',
    },
  });

  assert.deepEqual(calls, [
    {
      commandName: 'message_send',
      idempotencyKey: 'idem-1',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: {
        to: { kind: 'user' },
        text: 'Hello from MCP.',
      },
    },
  ]);
  assert.deepEqual(result.structuredContent, { ok: true, messageId: 'message-1' });
  assert.deepEqual(result.content, [
    { type: 'text', text: JSON.stringify({ ok: true, messageId: 'message-1' }) },
  ]);
});

test('callLocalMcpTool rejects missing idempotencyKey for mutating tools', async () => {
  await assert.rejects(
    () =>
      callLocalMcpTool({
        toolFacade: { execute() {} },
        actor: { teamId: 'team-a', agentId: 'lead' },
        name: 'task_create',
        arguments: { taskId: 'task-1', subject: 'Missing idempotency.' },
      }),
    /idempotencyKey must be a non-empty string/
  );
});

test('callLocalMcpTool executes read-only task_list without idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return [{ taskId: 'task-1' }];
      },
    },
    actor: { teamId: 'team-a', agentId: 'lead' },
    name: 'task_list',
    arguments: {},
  });

  assert.equal(calls[0].commandName, 'task_list');
  assert.equal(calls[0].idempotencyKey, null);
  assert.deepEqual(result.structuredContent, [{ taskId: 'task-1' }]);
});

test('callLocalMcpTool executes read-only agent_status without idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return [{ runtimeId: 'runtime-lead-1', status: 'running' }];
      },
    },
    actor: { teamId: 'team-a', agentId: 'lead' },
    name: 'agent_status',
    arguments: { runtimeId: 'runtime-lead-1' },
  });

  assert.deepEqual(calls[0], {
    commandName: 'agent_status',
    idempotencyKey: null,
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { runtimeId: 'runtime-lead-1' },
  });
  assert.deepEqual(result.structuredContent, [{ runtimeId: 'runtime-lead-1', status: 'running' }]);
});

test('callLocalMcpTool executes read-only approval_list without idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return [{ approvalId: 'approval-1', status: 'pending' }];
      },
    },
    actor: { teamId: 'team-a', agentId: 'operator' },
    name: 'approval_list',
    arguments: {},
  });

  assert.deepEqual(calls[0], {
    commandName: 'approval_list',
    idempotencyKey: null,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {},
  });
  assert.deepEqual(result.structuredContent, [{ approvalId: 'approval-1', status: 'pending' }]);
});

test('callLocalMcpTool executes read-only runtime_events without idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return [{ eventId: 'event-1', runtimeId: 'runtime-lead-1', eventType: 'tool_use' }];
      },
    },
    actor: { teamId: 'team-a', agentId: 'operator' },
    name: 'runtime_events',
    arguments: { runtimeId: 'runtime-lead-1' },
  });

  assert.deepEqual(calls[0], {
    commandName: 'runtime_events',
    idempotencyKey: null,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { runtimeId: 'runtime-lead-1' },
  });
  assert.deepEqual(result.structuredContent, [
    { eventId: 'event-1', runtimeId: 'runtime-lead-1', eventType: 'tool_use' },
  ]);
});

test('callLocalMcpTool executes read-only cross_team_messages without idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return [{ id: 'msg-cross-1', direction: 'outbound' }];
      },
    },
    actor: { teamId: 'team-a', agentId: 'operator' },
    name: 'cross_team_messages',
    arguments: { limit: 25 },
  });

  assert.deepEqual(calls[0], {
    commandName: 'cross_team_messages',
    idempotencyKey: null,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { limit: 25 },
  });
  assert.deepEqual(result.structuredContent, [{ id: 'msg-cross-1', direction: 'outbound' }]);
});

test('callLocalMcpTool executes mutating approval_respond with idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return { approvalId: 'approval-1', status: 'approved' };
      },
    },
    actor: { teamId: 'team-a', agentId: 'operator' },
    name: 'approval_respond',
    arguments: {
      idempotencyKey: 'approval-response-1',
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'Allowed.',
    },
  });

  assert.deepEqual(calls[0], {
    commandName: 'approval_respond',
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'Allowed.',
    },
  });
  assert.deepEqual(result.structuredContent, { approvalId: 'approval-1', status: 'approved' });
});
