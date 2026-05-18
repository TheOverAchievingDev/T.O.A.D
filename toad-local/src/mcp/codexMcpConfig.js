import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildToadMcpConfig, TOAD_MCP_SERVER_NAME } from './toadMcpConfig.js';

/**
 * SP1a: emit the TOAD MCP stdio server as a Codex project-scoped
 * `.codex/config.toml [mcp_servers.toad]` entry. Reuses
 * buildToadMcpConfig so the Codex agent points at the EXACT same
 * server (command/args/env) a Claude agent gets — DRY, no drift.
 *
 * RATIFIED (codex-cli 0.130.0, grounding d1e58e1): codex 0.130 has
 * NO `required` MCP key — the loud-fail guarantee is the first-turn
 * MCP-tool visibility probe (Task 3/6), not config. `env` is a
 * subtable of static literals (TOAD's values are literals → correct).
 */
export function buildCodexMcpConfigToml(opts = {}) {
  const cfg = buildToadMcpConfig(opts).mcpServers[TOAD_MCP_SERVER_NAME];
  const lines = [];
  lines.push('[mcp_servers.toad]');
  lines.push(`command = ${tomlStr(cfg.command)}`);
  lines.push(`args = [${cfg.args.map(tomlStr).join(', ')}]`);
  lines.push('');
  lines.push('[mcp_servers.toad.env]');
  for (const [k, v] of Object.entries(cfg.env)) lines.push(`${k} = ${tomlStr(v)}`);
  return `${lines.join('\n')}\n`;
}

export function writeCodexProjectConfig({ projectCwd, codexConfigPath, ...opts } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const dir = join(cwd, '.codex');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'config.toml');
  writeFileSync(p, buildCodexMcpConfigToml({ ...opts, projectCwd: cwd }), 'utf8');
  // RATIFIED: project-scoped .codex/config.toml only loads for TRUSTED
  // projects. Mark this cwd trusted non-interactively (grounding d1e58e1
  // §5). C:\Project-TOAD is already trusted; this is idempotent.
  markCodexProjectTrusted(cwd, codexConfigPath ? { codexConfigPath } : undefined);
  return p;
}

export function writeAgentsMd({ projectCwd, content } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const body = typeof content === 'string' ? content : '';
  const p = join(cwd, 'AGENTS.md');
  writeFileSync(p, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return p;
}

/**
 * Idempotently grant Codex project-trust by appending
 * `[projects.'<cwd>']\ntrust_level = "trusted"` to the codex GLOBAL
 * config (`~/.codex/config.toml`). Append-only (never rewrites the
 * user's file); a no-op if a trust entry for this path already exists.
 * `codexConfigPath` is injectable for tests.
 */
export function markCodexProjectTrusted(projectCwd, { codexConfigPath } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const cfgPath = codexConfigPath || join(homedir(), '.codex', 'config.toml');
  const header = `[projects.'${cwd}']`;
  let current = '';
  if (existsSync(cfgPath)) current = readFileSync(cfgPath, 'utf8');
  if (current.includes(header)) return cfgPath; // already trusted — idempotent
  mkdirSync(join(cfgPath, '..'), { recursive: true });
  const block = `${current && !current.endsWith('\n') ? '\n' : ''}\n${header}\ntrust_level = "trusted"\n`;
  writeFileSync(cfgPath, current + block, 'utf8');
  return cfgPath;
}

function tomlStr(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function requireNonEmpty(v, label) {
  if (typeof v !== 'string' || v.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return v.trim();
}
