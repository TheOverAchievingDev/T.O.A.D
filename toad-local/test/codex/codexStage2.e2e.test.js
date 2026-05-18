import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

test('STAGE-2 PROOF: first turn captures session id; second message resumes the SAME session with continuity', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'codex-stage2-'));
  const fake = path.resolve('test/fixtures/fake-codex-stage2.mjs');
  const children = [];
  const m = new Map();
  const sessionStore = { get: (id) => (m.has(id) ? m.get(id) : null), set: (id, v) => m.set(id, v), clear: (id) => m.set(id, null) };
  const adapter = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'dev-1', cwd: work, systemPrompt: 'You are dev-1.',
    spawnImpl: (_cmd, args, opts) => { const c = spawn(process.execPath, [fake, ...args], opts); children.push(c); return c; },
    resolveCliImpl: (n) => n, sessionStore,
  });
  try {
    const r1 = await adapter.sendTurn({ message: { text: 'create the file' } });
    assert.equal(r1.accepted, true);
    assert.equal(sessionStore.get('r1'), 'stage2-sess-1');
    assert.equal((await readFile(path.join(work, 'turn1.txt'), 'utf8')).trim(), 'ALPHA');

    const r2 = await adapter.sendTurn({ message: { text: 'now append' } });
    assert.equal(r2.accepted, true);
    const a2 = children[1].spawnargs.join(' ');
    assert.ok(/exec resume/.test(a2) && /stage2-sess-1/.test(a2));
    assert.equal((await readFile(path.join(work, 'turn1.txt'), 'utf8')).trim(), 'ALPHA\nBETA');
    await adapter.stop();
  } finally {
    for (const c of children) { try { if (c.exitCode === null && !c.killed) c.kill('SIGTERM'); } catch {} }
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
