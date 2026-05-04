import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMcpHandler } from '../src/mcp/localMcpServer.js';

test('local MCP handler returns initialize metadata', async () => {
  const handler = createLocalMcpHandler({
    actor: { teamId: 'team-a', agentId: 'operator' },
  });

  const response = await handler({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'toad-local');
  assert.deepEqual(response.result.capabilities, { tools: {} });
});

test('local MCP handler lists local tools', async () => {
  const handler = createLocalMcpHandler({
    actor: { teamId: 'team-a', agentId: 'operator' },
  });

  const response = await handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  assert.equal(response.result.tools.some((tool) => tool.name === 'task_create'), true);
  assert.equal(response.result.tools.some((tool) => tool.name === 'message_send'), true);
});

test('local MCP handler calls tools through LocalToadRuntime', async () => {
  const handler = createLocalMcpHandler({
    actor: { teamId: 'team-a', agentId: 'operator' },
  });

  const createResponse = await handler({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'task_create',
      arguments: {
        idempotencyKey: 'idem-task-1',
        taskId: 'task-1',
        subject: 'Wire local MCP handler',
      },
    },
  });

  assert.equal(createResponse.error, undefined);
  assert.equal(createResponse.result.structuredContent.taskId, 'task-1');
  assert.equal(createResponse.result.structuredContent.subject, 'Wire local MCP handler');

  const listResponse = await handler({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'task_list',
      arguments: {},
    },
  });

  // task_list now returns { tasks: [...] } so MCP clients accept the
  // structuredContent as an object (Claude Code's MCP client treats raw
  // arrays as schema mismatches).
  assert.equal(listResponse.result.structuredContent.tasks.length, 1);
  assert.equal(listResponse.result.structuredContent.tasks[0].taskId, 'task-1');
});

test('local MCP handler returns JSON-RPC errors for unknown methods', async () => {
  const handler = createLocalMcpHandler();

  const response = await handler({
    jsonrpc: '2.0',
    id: 5,
    method: 'resources/list',
    params: {},
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 5);
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /method not found/);
});
