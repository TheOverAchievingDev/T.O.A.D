import test from 'node:test';
import assert from 'node:assert/strict';
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
