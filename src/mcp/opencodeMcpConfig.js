import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildToadMcpConfig, TOAD_MCP_SERVER_NAME } from './toadMcpConfig.js';

export function buildOpencodeConfig(opts = {}) {
  const cfg = buildToadMcpConfig(opts).mcpServers[TOAD_MCP_SERVER_NAME];
  return {
    $schema: 'https://opencode.ai/config.json',
    instructions: ['AGENTS.md'],
    compaction: { auto: true, prune: true },
    mcp: {
      [TOAD_MCP_SERVER_NAME]: {
        type: 'local',
        enabled: true,
        command: [cfg.command, ...cfg.args],
        environment: { ...cfg.env },
      },
    },
  };
}

export function writeOpencodeProjectConfig({ projectCwd, ...opts } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const p = join(cwd, 'opencode.json');
  const existing = readExistingJsonObject(p);
  const next = mergeConfig(existing, buildOpencodeConfig({ ...opts, projectCwd: cwd }));
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return p;
}

export function writeOpencodeInstructions({ projectCwd, content } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const body = typeof content === 'string' ? content : '';
  const p = join(cwd, 'AGENTS.md');
  writeFileSync(p, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return p;
}

function mergeConfig(existing, generated) {
  return {
    ...existing,
    $schema: existing.$schema || generated.$schema,
    instructions: mergeStringArray(existing.instructions, generated.instructions),
    compaction: {
      ...(existing.compaction && typeof existing.compaction === 'object' && !Array.isArray(existing.compaction)
        ? existing.compaction
        : {}),
      ...generated.compaction,
    },
    mcp: {
      ...(existing.mcp && typeof existing.mcp === 'object' && !Array.isArray(existing.mcp)
        ? existing.mcp
        : {}),
      ...generated.mcp,
    },
  };
}

function mergeStringArray(existing, generated) {
  const out = [];
  for (const entry of [...(Array.isArray(existing) ? existing : []), ...generated]) {
    if (typeof entry === 'string' && entry.length > 0 && !out.includes(entry)) out.push(entry);
  }
  return out;
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
