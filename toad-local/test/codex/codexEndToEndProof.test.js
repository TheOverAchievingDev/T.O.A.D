import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

test('END-TO-END PROOF: Codex session agent boots, changes a file, reports an MCP tool call, ingestor-visible events', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'codex-proof-'));
  try {
    const fake = path.resolve('test/fixtures/fake-codex.mjs');
    let child;
    const adapter = new CodexExecAdapter({
      runtimeId: 'r', teamId: 't', agentId: 'dev-1', cwd: work,
      systemPrompt: 'You are dev-1.',
      // Drive the stand-in via the real spawn, exactly as production
      // spawns `codex`, but pointing node at the fixture script. Keep a
      // handle on the child so we can await its exit before cleanup —
      // on Windows the SIGTERM'd child holds a handle on the temp dir,
      // racing rm() into intermittent EBUSY.
      spawnImpl: (_cmd, args, opts) => {
        child = spawn(process.execPath, [fake, ...args], opts);
        return child;
      },
      resolveCliImpl: (n) => n,
    });
    const seen = [];
    const it = adapter.events()[Symbol.asyncIterator]();
    const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; seen.push(n.value); } })();
    const res = await adapter.sendTurn({ message: { text: 'do the task' } });
    await adapter.stop();
    await pump;
    // Wait for the spawned child to actually exit before cleanup so its
    // Windows file handle on `work` is released (avoids EBUSY rmdir).
    if (child && child.exitCode === null && !child.killed) {
      await new Promise((r) => { child.once('exit', r); child.once('close', r); setTimeout(r, 2000); });
    }

    assert.equal(res.accepted, true);
    assert.equal((await readFile(path.join(work, 'proof.txt'), 'utf8')).startsWith('prompt:'), true);
    assert.ok(seen.some((e) => e.type === 'tool_use' && e.toolName === 'file_change'));
    assert.ok(seen.some((e) => e.type === 'tool_use' && e.toolName === 'mcp_tool_call'));
    assert.ok(seen.some((e) => e.type === 'assistant_text' && e.text === 'task done'));
    assert.ok(seen.some((e) => e.type === 'turn_completed'));
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
