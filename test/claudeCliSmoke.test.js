import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ClaudeStreamJsonAdapter } from '../src/runtime/ClaudeStreamJsonAdapter.js';

const runSmoke = process.env.TOAD_CLAUDE_SMOKE === '1';

test('Claude CLI accepts a stream-json turn through the adapter', { skip: !runSmoke }, async (t) => {
  // Note: --bare puts the CLI into a stripped-down headless mode whose auth path
  // only accepts an Anthropic API key (not the Claude Code subscription OAuth).
  // None of TOAD's production code uses --bare, so the smoke runs without it.
  const child = spawn(
    process.env.CLAUDE_BIN || 'claude',
    [
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '--tools',
      '',
    ],
    {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'runtime-smoke-1',
    teamId: 'team-smoke',
    agentId: 'claude',
    child,
  });
  const events = adapter.events();

  await adapter.sendTurn({
    message: {
      text: 'Reply with the exact text TOAD-SMOKE and no other words.',
    },
  });
  child.stdin.end();

  const seen = [];
  for await (const event of events) {
    seen.push(event);
    if (event.type === 'assistant_text' || event.type === 'turn_failed') break;
  }

  if (
    seen.some(
      (event) =>
        event.raw?.error === 'authentication_failed' ||
        (event.type === 'assistant_text' && event.text.includes('Not logged in'))
    )
  ) {
    t.skip('Claude CLI is not authenticated locally; run claude /login before the real smoke.');
    return;
  }

  assert.equal(
    seen.some((event) => event.type === 'assistant_text' && event.text.includes('TOAD-SMOKE')),
    true,
    JSON.stringify(seen)
  );
});
