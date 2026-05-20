import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGeminiSettings, writeGeminiProjectConfig, writeGeminiMd } from '../../src/mcp/geminiMcpConfig.js';

const baseOpts = {
  dbPath: '/db/toad.sqlite',
  projectCwd: '/work',
  teamId: 't1',
  agentId: 'tester',
  role: 'tester',
  taskId: 'B-1',
  nodePath: '/usr/bin/node',
  serverPath: '/srv/stdioServer.js',
};

test('buildGeminiSettings mirrors buildToadMcpConfig under mcpServers.toad-local with trust', () => {
  const settings = buildGeminiSettings(baseOpts);

  assert.ok(settings.mcpServers['toad-local']);
  assert.equal(settings.mcpServers['toad-local'].command, '/usr/bin/node');
  assert.deepEqual(settings.mcpServers['toad-local'].args, ['--no-warnings', '/srv/stdioServer.js']);
  assert.equal(settings.mcpServers['toad-local'].trust, true);
  assert.equal(settings.mcpServers['toad-local'].env.TOAD_DB_PATH, '/db/toad.sqlite');
  assert.equal(settings.mcpServers['toad-local'].env.TOAD_TEAM_ID, 't1');
  assert.equal(settings.mcpServers['toad-local'].env.TOAD_AGENT_ID, 'tester');
  assert.equal(settings.mcpServers['toad-local'].env.TOAD_AGENT_ROLE, 'tester');
});

test('writeGeminiProjectConfig writes and preserves unrelated existing settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'geminicfg-'));
  try {
    await mkdir(path.join(dir, '.gemini'), { recursive: true });
    await writeFile(path.join(dir, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2));

    const p = writeGeminiProjectConfig({ ...baseOpts, projectCwd: dir });

    assert.equal(p, path.join(dir, '.gemini', 'settings.json'));
    const body = JSON.parse(await readFile(p, 'utf8'));
    assert.equal(body.theme, 'dark');
    assert.ok(body.mcpServers.other);
    assert.ok(body.mcpServers['toad-local']);
    assert.equal(body.mcpServers['toad-local'].env.TOAD_PROJECT_CWD, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeGeminiMd writes workspace GEMINI.md with newline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'geminimd-'));
  try {
    const p = writeGeminiMd({ projectCwd: dir, content: '# Team\nYou are tester.' });
    assert.equal(p, path.join(dir, 'GEMINI.md'));
    assert.equal(await readFile(p, 'utf8'), '# Team\nYou are tester.\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
