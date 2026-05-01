import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_EVENT_TYPES } from '../src/task/inMemoryTaskBoard.js';
import { createMcpActorFromEnv, createMcpRuntimeFromEnv } from '../src/mcp/stdioRuntime.js';

test('createMcpActorFromEnv includes explicit role for MCP authorization', () => {
  assert.deepEqual(
    createMcpActorFromEnv({
      TOAD_TEAM_ID: 'team-a',
      TOAD_AGENT_ID: 'dev-1',
      TOAD_AGENT_ROLE: 'developer',
    }),
    { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
  );
});

test('createMcpRuntimeFromEnv opens the shared DB and project cwd', async () => {
  const projectCwd = mkdtempSync(join(tmpdir(), 'toad-stdio-runtime-'));
  const dbPath = join(projectCwd, '.toad', 'toad.db');
  try {
    const writer = createMcpRuntimeFromEnv({ TOAD_DB_PATH: dbPath, TOAD_PROJECT_CWD: projectCwd });
    writer.taskBoard.appendEvent({
      teamId: 'team-a',
      taskId: 'task-1',
      idempotencyKey: 'create-task-1',
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: 'lead',
      payload: { subject: 'Shared task' },
    });
    await writer.close();

    const reader = createMcpRuntimeFromEnv({ TOAD_DB_PATH: dbPath, TOAD_PROJECT_CWD: projectCwd });
    assert.equal(reader.projectCwd, projectCwd);
    assert.equal(reader.dbPath, dbPath);
    assert.equal(reader.taskBoard.getTask({ teamId: 'team-a', taskId: 'task-1' }).subject, 'Shared task');
    await reader.close();
  } finally {
    safeRm(projectCwd);
  }
});

function safeRm(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}
