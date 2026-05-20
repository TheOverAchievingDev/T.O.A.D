import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexMcpConfigToml, writeCodexProjectConfig, writeAgentsMd, markCodexProjectTrusted } from '../../src/mcp/codexMcpConfig.js';

const baseOpts = { dbPath: '/db/toad.sqlite', projectCwd: '/work', teamId: 't1', agentId: 'dev-1', role: 'developer', taskId: 'B-1', nodePath: '/usr/bin/node', serverPath: '/srv/stdioServer.js' };

test('buildCodexMcpConfigToml mirrors buildToadMcpConfig, server key "toad", NO required key (0.130 — ratified d1e58e1)', () => {
  const toml = buildCodexMcpConfigToml(baseOpts);
  assert.match(toml, /\[mcp_servers\.toad\]/);
  assert.match(toml, /command = "\/usr\/bin\/node"/);
  assert.match(toml, /args = \["--no-warnings", "\/srv\/stdioServer\.js"\]/);
  assert.doesNotMatch(toml, /required\s*=/); // codex 0.130 has no `required` MCP key
  assert.match(toml, /\[mcp_servers\.toad\.env\]/);
  assert.match(toml, /TOAD_DB_PATH = "\/db\/toad\.sqlite"/);
  assert.match(toml, /TOAD_TEAM_ID = "t1"/);
  assert.match(toml, /TOAD_AGENT_ID = "dev-1"/);
  assert.match(toml, /TOAD_AGENT_ROLE = "developer"/);
  assert.match(toml, /TOAD_TASK_ID = "B-1"/);
});

test('writeCodexProjectConfig writes <cwd>/.codex/config.toml', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codexcfg-'));
  try {
    const codexCfg = path.join(dir, 'fake-global-codex.toml');
    const p = writeCodexProjectConfig({ ...baseOpts, projectCwd: dir, codexConfigPath: codexCfg });
    assert.equal(p, path.join(dir, '.codex', 'config.toml'));
    const body = await readFile(p, 'utf8');
    assert.match(body, /\[mcp_servers\.toad\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writeAgentsMd writes <cwd>/AGENTS.md with the system prompt content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsmd-'));
  try {
    const p = writeAgentsMd({ projectCwd: dir, content: '# Team\nYou are dev-1.' });
    assert.equal(p, path.join(dir, 'AGENTS.md'));
    assert.equal(await readFile(p, 'utf8'), '# Team\nYou are dev-1.\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('markCodexProjectTrusted idempotently writes [projects."<cwd>"] trust_level="trusted" into the codex global config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codexhome-'));
  try {
    const cfg = path.join(home, 'config.toml');
    markCodexProjectTrusted('/work/proj', { codexConfigPath: cfg });
    let body = await readFile(cfg, 'utf8');
    assert.match(body, /\[projects\.'\/work\/proj'\]/);
    assert.match(body, /trust_level = "trusted"/);
    markCodexProjectTrusted('/work/proj', { codexConfigPath: cfg });
    body = await readFile(cfg, 'utf8');
    assert.equal((body.match(/\[projects\.'\/work\/proj'\]/g) || []).length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
