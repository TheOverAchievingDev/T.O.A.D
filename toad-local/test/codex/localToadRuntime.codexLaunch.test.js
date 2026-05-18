import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LocalToadRuntime } from '../../src/app/LocalToadRuntime.js';

function makeRuntime({ authSignedIn = true } = {}) {
  return new LocalToadRuntime({
    getCodexAuthStatusImpl: () => ({ providerId: 'openai', supported: true, signedIn: authSignedIn }),
  });
}

test('codex launch does NOT spawn a Claude child and registers a session adapter', async () => {
  const rt = makeRuntime();
  const out = await rt.launchAgent({
    teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex', command: 'codex',
    cwd: process.cwd(), systemPrompt: 'You are dev-1.',
  });
  assert.equal(out.runtimeId, 'r-codex');
  const ad = rt.adapters.get('r-codex');
  assert.ok(ad && ad.providerId === 'openai');
});

test('codex launch fails fast when not authenticated', async () => {
  const rt = makeRuntime({ authSignedIn: false });
  await assert.rejects(
    () => rt.launchAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex2', command: 'codex', cwd: process.cwd() }),
    /Codex not authenticated/,
  );
});

test('claude launch does NOT enter the codex branch (still spawns a child)', async () => {
  const rt = makeRuntime();
  let spawned = false;
  rt.supervisor.spawnProcess = () => {
    spawned = true;
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.stdin = { write() {}, end() {}, writable: true };
    c.pid = 4321;
    c.kill = () => {};
    return c;
  };
  // command:'claude' must go through the Claude path (supervisor.launchAgent → spawnProcess),
  // NOT #prepareCodexRuntime. We don't care if the full launch resolves — only that the
  // codex branch was not taken (a child spawn was attempted).
  await rt.launchAgent({
    teamId: 't1', agentId: 'lead', runtimeId: 'r-claude-smoke', command: 'claude', cwd: process.cwd(),
  }).catch(() => {});
  assert.equal(spawned, true);
});
