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
    'audit_log_query',
    'cross_team_messages',
    'cross_team_send',
    'diagnostics_run',
    'drift_correction_create',
    'drift_run',
    'eas_build',
    'eas_project_info',
    'eas_update',
    'foundry_artifact_export',
    'foundry_artifact_generate',
    'foundry_artifact_upsert',
    'foundry_chat_turn',
    'foundry_message_add',
    'foundry_project_materialize',
    'foundry_project_seed_tasks',
    'foundry_session_create',
    'foundry_session_get',
    'foundry_session_list',
    'git_init_local',
    'git_set_remote',
    'github_create_pull_request',
    'github_create_repository',
    'github_device_poll',
    'github_device_start',
    'github_disconnect',
    'github_get_branch_protection',
    'github_get_repository',
    'github_origin_remote',
    'github_pat_verify',
    'github_status',
    'health_status',
    'ide_apply_patch',
    'ide_checkpoint_task',
    'ide_get_diff',
    'ide_get_status',
    'ide_read_file',
    'ide_search_files',
    'ide_tree_list',
    'ide_write_file',
    'message_send',
    'plugin_job_get',
    'plugin_job_list',
    'provider_auth_login',
    'provider_auth_logout',
    'provider_auth_status',
    'review_decide',
    'review_list',
    'review_request',
    'risk_policy_get',
    'risk_policy_preview',
    'risk_policy_set',
    'runtime_events',
    'runtime_send_input',
    'settings_get',
    'settings_set',
    'stuck_runtime_list',
    'task_comment',
    'task_create',
    'task_history_export',
    'task_human_approve',
    'task_list',
    'task_plan_approve',
    'task_plan_propose',
    'task_plan_reject',
    'task_update',
    'team_create',
    'team_delete',
    'team_launch',
    'team_list',
    'team_stop',
    'tool_activity',
    'validation_run',
    'vercel_deploy',
    'vercel_env_pull',
    'vercel_link',
    'vercel_ls',
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
    'ide_write_file',
    'ide_checkpoint_task',
    'ide_apply_patch',
    'eas_build',
    'eas_update',
    'vercel_link',
    'vercel_env_pull',
    'vercel_deploy',
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
  assert.ok(getLocalMcpTool('team_create').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('team_create').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('team_delete').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('team_delete').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('team_launch').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('team_launch').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('team_stop').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('team_stop').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('runtime_send_input').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('runtime_send_input').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('validation_run').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('validation_run').annotations.destructiveHint, false);
  for (const t of ['task_plan_propose', 'task_plan_approve', 'task_plan_reject']) {
    assert.ok(getLocalMcpTool(t).inputSchema.required.includes('idempotencyKey'), t);
    assert.equal(getLocalMcpTool(t).annotations.destructiveHint, false, t);
  }
  assert.ok(getLocalMcpTool('task_human_approve').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('task_human_approve').annotations.destructiveHint, false);
  assert.ok(getLocalMcpTool('github_create_pull_request').inputSchema.required.includes('idempotencyKey'));
  assert.equal(getLocalMcpTool('github_create_pull_request').annotations.destructiveHint, false);
  for (const t of ['github_create_repository', 'git_init_local', 'git_set_remote']) {
    assert.ok(getLocalMcpTool(t).inputSchema.required.includes('idempotencyKey'), t);
    assert.equal(getLocalMcpTool(t).annotations.destructiveHint, false, t);
  }
  for (const t of ['foundry_session_create', 'foundry_message_add', 'foundry_chat_turn', 'foundry_artifact_upsert', 'foundry_artifact_generate', 'foundry_artifact_export', 'foundry_project_materialize', 'foundry_project_seed_tasks']) {
    assert.ok(getLocalMcpTool(t).inputSchema.required.includes('idempotencyKey'), t);
    assert.equal(getLocalMcpTool(t).annotations.destructiveHint, false, t);
  }

  // Read-only tools
  for (const name of ['task_list', 'agent_status', 'approval_list', 'runtime_events', 'cross_team_messages', 'tool_activity', 'health_status', 'team_list', 'review_list', 'stuck_runtime_list', 'foundry_session_list', 'foundry_session_get', 'ide_tree_list', 'ide_read_file', 'ide_get_status', 'ide_get_diff']) {
    assert.ok(!getLocalMcpTool(name).inputSchema.required.includes('idempotencyKey'), name);
    assert.equal(getLocalMcpTool(name).annotations.readOnlyHint, true, `${name} should be readOnly`);
  }
});

test('ide MCP tools expose read-only file browser schemas', () => {
  const tree = getLocalMcpTool('ide_tree_list');
  assert.equal(tree.annotations.readOnlyHint, true);
  assert.deepEqual(tree.inputSchema.required, []);
  assert.equal(tree.inputSchema.properties.source.properties.kind.enum.includes('task_worktree'), true);
  assert.deepEqual(tree.inputSchema.properties.maxEntries, {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
  });

  const read = getLocalMcpTool('ide_read_file');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.deepEqual(read.inputSchema.required, ['relativePath']);
  assert.equal(read.inputSchema.properties.relativePath.minLength, 1);
  assert.equal(read.inputSchema.properties.source.properties.kind.enum.includes('project'), true);
  assert.equal(read.inputSchema.required.includes('idempotencyKey'), false);
});

test('ide_write_file MCP tool exposes mutating save schema', () => {
  const write = getLocalMcpTool('ide_write_file');
  assert.equal(write.annotations.readOnlyHint, false);
  assert.equal(write.annotations.destructiveHint, false);
  assert.deepEqual(write.inputSchema.required, ['idempotencyKey', 'relativePath', 'content']);
  assert.equal(write.inputSchema.properties.source.properties.kind.enum.includes('task_worktree'), true);
  assert.equal(write.inputSchema.properties.relativePath.minLength, 1);
  assert.equal(write.inputSchema.properties.content.type, 'string');
  assert.equal(write.inputSchema.properties.expectedSha256.minLength, 1);
});

test('task_create MCP schema exposes task risk contract fields', () => {
  const properties = getLocalMcpTool('task_create').inputSchema.properties;
  assert.deepEqual(properties.allowedFiles, {
    type: 'array',
    items: { type: 'string', minLength: 1 },
  });
  assert.deepEqual(properties.forbiddenFiles, {
    type: 'array',
    items: { type: 'string', minLength: 1 },
  });
  assert.deepEqual(properties.acceptanceCriteria, {
    type: 'array',
    items: { type: 'string', minLength: 1 },
  });
  assert.deepEqual(properties.riskLevel, {
    type: 'string',
    enum: ['low', 'medium', 'high', 'critical'],
  });
  assert.deepEqual(properties.requiresHumanApproval, { type: 'boolean' });
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

test('callLocalMcpTool executes read-only ide_read_file without idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return { relativePath: 'README.md', content: '# Project\n' };
      },
    },
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    name: 'ide_read_file',
    arguments: { source: { kind: 'project' }, relativePath: 'README.md' },
  });

  assert.deepEqual(calls[0], {
    commandName: 'ide_read_file',
    idempotencyKey: null,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' }, relativePath: 'README.md' },
  });
  assert.equal(result.structuredContent.content, '# Project\n');
});

test('callLocalMcpTool executes mutating ide_write_file with idempotencyKey', async () => {
  const calls = [];
  const result = await callLocalMcpTool({
    toolFacade: {
      execute(command) {
        calls.push(command);
        return { relativePath: 'README.md', content: '# Saved\n' };
      },
    },
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    name: 'ide_write_file',
    arguments: {
      idempotencyKey: 'ide-write-mcp-1',
      source: { kind: 'project' },
      relativePath: 'README.md',
      content: '# Saved\n',
      expectedSha256: 'a'.repeat(64),
    },
  });

  assert.deepEqual(calls[0], {
    commandName: 'ide_write_file',
    idempotencyKey: 'ide-write-mcp-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: {
      source: { kind: 'project' },
      relativePath: 'README.md',
      content: '# Saved\n',
      expectedSha256: 'a'.repeat(64),
    },
  });
  assert.equal(result.structuredContent.content, '# Saved\n');
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
