import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalToadRuntime } from '../../src/app/LocalToadRuntime.js';

test('gemini launch registers a session adapter and writes Gemini project rails without spawning a persistent child', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'geminilaunch-'));
  const authCalls = [];
  let spawned = false;
  const rt = new LocalToadRuntime({
    getProviderAuthStatusImpl: (opts) => {
      authCalls.push(opts);
      return { providerId: opts.providerId, supported: true, signedIn: true };
    },
    spawnProcess: () => {
      spawned = true;
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.stdin = { write() {}, end() {}, writable: true };
      c.pid = 1234;
      c.kill = () => {};
      return c;
    },
  });

  try {
    const out = await rt.launchAgent({
      teamId: 't1',
      agentId: 'tester',
      runtimeId: 'r-gemini',
      providerId: 'gemini',
      command: 'gemini',
      cwd: dir,
      systemPrompt: 'You are tester.',
    });

    assert.equal(out.runtimeId, 'r-gemini');
    assert.equal(spawned, false);
    assert.deepEqual(authCalls, [{ providerId: 'gemini' }]);
    const adapter = rt.adapters.get('r-gemini');
    assert.ok(adapter);
    assert.equal(adapter.providerId, 'gemini');
    assert.ok(existsSync(path.join(dir, '.gemini', 'settings.json')), 'Gemini settings written under workspace');
    assert.ok(existsSync(path.join(dir, 'GEMINI.md')), 'GEMINI.md written under workspace');
  } finally {
    await rt.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('gemini launch fails fast when Gemini auth is absent', async () => {
  const rt = new LocalToadRuntime({
    getProviderAuthStatusImpl: () => ({ providerId: 'gemini', supported: true, signedIn: false, reason: 'missing creds' }),
  });

  await assert.rejects(
    () => rt.launchAgent({ teamId: 't1', agentId: 'tester', runtimeId: 'r-gemini-auth', providerId: 'gemini', command: 'gemini', cwd: process.cwd() }),
    /Gemini not authenticated.*missing creds/,
  );
});
