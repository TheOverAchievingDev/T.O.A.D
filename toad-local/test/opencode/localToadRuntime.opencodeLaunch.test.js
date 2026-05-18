import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalToadRuntime } from '../../src/app/LocalToadRuntime.js';

test('opencode launch registers a session adapter and writes OpenCode project rails without spawning a persistent child', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opencodelaunch-'));
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
      runtimeId: 'r-opencode',
      providerId: 'opencode',
      command: 'opencode',
      args: ['--model', 'deepseek/deepseek-v4'],
      cwd: dir,
      systemPrompt: 'You are tester.',
    });

    assert.equal(out.runtimeId, 'r-opencode');
    assert.equal(spawned, false);
    assert.deepEqual(authCalls, [{ providerId: 'opencode' }]);
    const adapter = rt.adapters.get('r-opencode');
    assert.ok(adapter);
    assert.equal(adapter.providerId, 'opencode');
    assert.ok(existsSync(path.join(dir, 'opencode.json')), 'OpenCode config written under workspace');
    assert.ok(existsSync(path.join(dir, 'AGENTS.md')), 'AGENTS.md written under workspace');
  } finally {
    await rt.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('opencode launch fails fast when OpenCode credentials are absent', async () => {
  const rt = new LocalToadRuntime({
    getProviderAuthStatusImpl: () => ({ providerId: 'opencode', supported: true, signedIn: false, reason: 'missing creds' }),
  });

  await assert.rejects(
    () => rt.launchAgent({ teamId: 't1', agentId: 'tester', runtimeId: 'r-opencode-auth', providerId: 'opencode', command: 'opencode', cwd: process.cwd() }),
    /OpenCode not authenticated.*missing creds/,
  );
});
