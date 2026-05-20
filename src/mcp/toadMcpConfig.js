import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOAD_MCP_SERVER_NAME = 'toad-local';

const currentDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOAD_MCP_STDIO_SERVER_PATH = join(currentDir, 'stdioServer.js');

export function buildToadMcpConfig({
  dbPath,
  projectCwd,
  teamId,
  agentId,
  role,
  taskId,
  nodePath = process.execPath,
  serverPath = DEFAULT_TOAD_MCP_STDIO_SERVER_PATH,
} = {}) {
  const env = {
    TOAD_DB_PATH: requireNonEmptyString(dbPath, 'dbPath'),
    TOAD_PROJECT_CWD: requireNonEmptyString(projectCwd, 'projectCwd'),
    TOAD_TEAM_ID: requireNonEmptyString(teamId, 'teamId'),
    TOAD_AGENT_ID: requireNonEmptyString(agentId, 'agentId'),
  };
  if (typeof role === 'string' && role.trim().length > 0) {
    env.TOAD_AGENT_ROLE = role.trim();
  }
  if (typeof taskId === 'string' && taskId.trim().length > 0) {
    env.TOAD_TASK_ID = taskId.trim();
  }

  return {
    mcpServers: {
      [TOAD_MCP_SERVER_NAME]: {
        command: requireNonEmptyString(nodePath, 'nodePath'),
        args: ['--no-warnings', requireNonEmptyString(serverPath, 'serverPath')],
        env,
      },
    },
  };
}

export function writeToadMcpConfig({ projectCwd, runtimeId, ...rest } = {}) {
  const cwd = requireNonEmptyString(projectCwd, 'projectCwd');
  const configDir = join(cwd, '.toad', 'mcp-configs');
  mkdirSync(configDir, { recursive: true });
  const safeRuntimeId = sanitizeFilePart(runtimeId || 'runtime');
  const configPath = join(configDir, `toad-mcp-${safeRuntimeId}-${Date.now()}-${randomUUID()}.json`);
  const config = buildToadMcpConfig({ ...rest, projectCwd: cwd });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

export function hasMcpConfigArg(args = []) {
  return Array.isArray(args) && args.map((entry) => String(entry)).includes('--mcp-config');
}

export function isClaudeCommand(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  const normalized = command.trim().replaceAll('\\', '/').toLowerCase();
  const base = normalized.split('/').pop();
  return base === 'claude' || base === 'claude.exe' || base === 'claude.cmd' || base === 'claude.ps1';
}

export function shouldInjectToadMcpConfig({ command, args = [], dbPath, projectCwd } = {}) {
  return (
    isClaudeCommand(command)
    && !hasMcpConfigArg(args)
    && typeof dbPath === 'string'
    && dbPath.trim().length > 0
    && dbPath !== ':memory:'
    && typeof projectCwd === 'string'
    && projectCwd.trim().length > 0
  );
}

export function withClaudeMcpPermissions(args = [], { skipPermissions = true } = {}) {
  const normalized = Array.isArray(args) ? args.map((entry) => String(entry)) : [];
  if (skipPermissions === false) return normalized;

  const withoutPermissionMode = [];
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] === '--permission-mode') {
      i += 1;
      continue;
    }
    withoutPermissionMode.push(normalized[i]);
  }

  if (!withoutPermissionMode.includes('--dangerously-skip-permissions')) {
    withoutPermissionMode.push('--dangerously-skip-permissions');
  }
  withoutPermissionMode.push('--permission-mode', 'bypassPermissions');
  return withoutPermissionMode;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function sanitizeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}
