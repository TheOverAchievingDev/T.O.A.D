import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildToadMcpConfig,
  hasMcpConfigArg,
  isClaudeCommand,
  shouldInjectToadMcpConfig,
  withClaudeMcpPermissions,
  writeToadMcpConfig,
} from '../src/mcp/toadMcpConfig.js';

test('buildToadMcpConfig includes shared runtime env and stdio server command', () => {
  const config = buildToadMcpConfig({
    dbPath: 'C:\\Project-TOAD\\toad-local\\.toad\\toad.db',
    projectCwd: 'C:\\Project-TOAD\\toad-local',
    teamId: 'team-a',
    agentId: 'dev-1',
    role: 'developer',
    taskId: 'task-1',
    nodePath: 'node',
    serverPath: 'src/mcp/stdioServer.js',
  });

  const server = config.mcpServers['toad-local'];
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['--no-warnings', 'src/mcp/stdioServer.js']);
  assert.equal(server.env.TOAD_DB_PATH, 'C:\\Project-TOAD\\toad-local\\.toad\\toad.db');
  assert.equal(server.env.TOAD_PROJECT_CWD, 'C:\\Project-TOAD\\toad-local');
  assert.equal(server.env.TOAD_TEAM_ID, 'team-a');
  assert.equal(server.env.TOAD_AGENT_ID, 'dev-1');
  assert.equal(server.env.TOAD_AGENT_ROLE, 'developer');
  assert.equal(server.env.TOAD_TASK_ID, 'task-1');
});

test('writeToadMcpConfig writes config under project .toad/mcp-configs', () => {
  const projectCwd = mkdtempSync(join(tmpdir(), 'toad-mcp-config-'));
  try {
    const configPath = writeToadMcpConfig({
      projectCwd,
      runtimeId: 'runtime/dev:1',
      dbPath: join(projectCwd, '.toad', 'toad.db'),
      teamId: 'team-a',
      agentId: 'dev-1',
      role: 'developer',
    });

    assert.equal(configPath.startsWith(join(projectCwd, '.toad', 'mcp-configs')), true);
    assert.equal(existsSync(configPath), true);
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(parsed.mcpServers['toad-local'].env.TOAD_AGENT_ID, 'dev-1');
  } finally {
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Claude MCP config injection helpers avoid double-injection', () => {
  assert.equal(isClaudeCommand('claude'), true);
  assert.equal(isClaudeCommand('C:\\Users\\Nova\\bin\\claude.cmd'), true);
  assert.equal(isClaudeCommand('node'), false);

  assert.equal(hasMcpConfigArg(['--mcp-config', 'existing.json']), true);
  assert.equal(hasMcpConfigArg(['--output-format', 'stream-json']), false);

  assert.equal(
    shouldInjectToadMcpConfig({
      command: 'claude',
      args: ['--output-format', 'stream-json'],
      dbPath: 'C:\\db.sqlite',
      projectCwd: 'C:\\Project-TOAD\\toad-local',
    }),
    true,
  );
  assert.equal(
    shouldInjectToadMcpConfig({
      command: 'claude',
      args: ['--mcp-config', 'existing.json'],
      dbPath: 'C:\\db.sqlite',
      projectCwd: 'C:\\Project-TOAD\\toad-local',
    }),
    false,
  );
  assert.equal(
    shouldInjectToadMcpConfig({
      command: 'claude',
      args: [],
      dbPath: ':memory:',
      projectCwd: 'C:\\Project-TOAD\\toad-local',
    }),
    false,
  );
});

test('withClaudeMcpPermissions enables MCP tools by default and replaces acceptEdits', () => {
  assert.deepEqual(
    withClaudeMcpPermissions(['--output-format', 'stream-json']),
    [
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypassPermissions',
    ],
  );

  assert.deepEqual(
    withClaudeMcpPermissions(['--permission-mode', 'acceptEdits']),
    ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'],
  );
});

test('withClaudeMcpPermissions can be explicitly disabled', () => {
  assert.deepEqual(
    withClaudeMcpPermissions(['--permission-mode', 'acceptEdits'], { skipPermissions: false }),
    ['--permission-mode', 'acceptEdits'],
  );
});
