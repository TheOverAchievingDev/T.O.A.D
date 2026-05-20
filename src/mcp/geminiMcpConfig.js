import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildToadMcpConfig, TOAD_MCP_SERVER_NAME } from './toadMcpConfig.js';

export function buildGeminiSettings(opts = {}) {
  const cfg = buildToadMcpConfig(opts).mcpServers[TOAD_MCP_SERVER_NAME];
  return {
    mcpServers: {
      [TOAD_MCP_SERVER_NAME]: {
        command: cfg.command,
        args: [...cfg.args],
        env: { ...cfg.env },
        trust: true,
      },
    },
  };
}

export function writeGeminiProjectConfig({ projectCwd, ...opts } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const dir = join(cwd, '.gemini');
  const p = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });

  const existing = readExistingJsonObject(p);
  const next = mergeSettings(existing, buildGeminiSettings({ ...opts, projectCwd: cwd }));
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return p;
}

export function writeGeminiMd({ projectCwd, content } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const body = typeof content === 'string' ? content : '';
  const p = join(cwd, 'GEMINI.md');
  writeFileSync(p, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return p;
}

function mergeSettings(existing, generated) {
  return {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
        ? existing.mcpServers
        : {}),
      ...generated.mcpServers,
    },
  };
}

function readExistingJsonObject(p) {
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
