import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildOpencodeConfig, writeOpencodeProjectConfig, writeOpencodeInstructions } from '../../src/mcp/opencodeMcpConfig.js';

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

test('buildOpencodeConfig mirrors buildToadMcpConfig under mcp.toad-local', () => {
  const cfg = buildOpencodeConfig(baseOpts);

  assert.equal(cfg.$schema, 'https://opencode.ai/config.json');
  assert.equal(cfg.compaction.auto, true);
  assert.equal(cfg.compaction.prune, true);
  assert.deepEqual(cfg.instructions, ['AGENTS.md']);
  assert.ok(cfg.mcp['toad-local']);
  assert.equal(cfg.mcp['toad-local'].type, 'local');
  assert.equal(cfg.mcp['toad-local'].enabled, true);
  assert.deepEqual(cfg.mcp['toad-local'].command, ['/usr/bin/node', '--no-warnings', '/srv/stdioServer.js']);
  assert.equal(cfg.mcp['toad-local'].environment.TOAD_DB_PATH, '/db/toad.sqlite');
});

test('writeOpencodeProjectConfig writes opencode.json and preserves unrelated config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opencodecfg-'));
  try {
    await writeFile(path.join(dir, 'opencode.json'), JSON.stringify({ theme: 'system', mcp: { other: { type: 'remote', url: 'https://example.test' } } }, null, 2));

    const p = writeOpencodeProjectConfig({ ...baseOpts, projectCwd: dir });

    assert.equal(p, path.join(dir, 'opencode.json'));
    const body = JSON.parse(await readFile(p, 'utf8'));
    assert.equal(body.theme, 'system');
    assert.ok(body.mcp.other);
    assert.ok(body.mcp['toad-local']);
    assert.equal(body.mcp['toad-local'].environment.TOAD_PROJECT_CWD, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeOpencodeInstructions writes AGENTS.md with newline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opencodeagents-'));
  try {
    const p = writeOpencodeInstructions({ projectCwd: dir, content: '# Team\nYou are tester.' });
    assert.equal(p, path.join(dir, 'AGENTS.md'));
    assert.equal(await readFile(p, 'utf8'), '# Team\nYou are tester.\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
