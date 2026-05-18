/**
 * BR1 — Critical A1 (bundle whole-impl review): GeminiExecAdapter and
 * OpencodeExecAdapter must not lose a coalesced batch on a synchronous spawn
 * failure. Same defect/fix as CodexExecAdapter W5: sendTurn clears
 * `_pendingTexts` before the spawn is confirmed, so a sync spawnImpl throw
 * discards the batch while later coalesced slots return a false
 * `{accepted:true, responseState:'coalesced'}` for never-delivered messages.
 *
 * Fix: the CodexExecAdapter.js:73-83 try/catch batch-restore guard, ported
 * verbatim to both adapters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GeminiExecAdapter } from '../../src/runtime/GeminiExecAdapter.js';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';

function fakeChild(scriptLines) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  child.stdin = {
    write: (s) => { writes.push(String(s)); },
    end: () => {
      setImmediate(() => {
        for (const l of scriptLines) child.stdout.emit('data', Buffer.from(`${l}\n`));
        child.emit('close', 0);
      });
    },
    writable: true,
    destroyed: false,
  };
  child.writes = writes;
  child.kill = () => { child.killed = true; };
  return child;
}

const GEMINI_OK = [
  JSON.stringify({ type: 'init', session_id: 'g1', model: 'gemini-2.5-flash' }),
  JSON.stringify({ type: 'message', role: 'assistant', content: 'ok', delta: true }),
  JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 5, output_tokens: 2 } }),
];
const OPENCODE_OK = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } }),
  JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'ok' } }),
  JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 2 } } }),
];

async function assertNoBatchLossOnSpawnThrow(AdapterClass, okLines) {
  let spawnCalls = 0;
  const children = [];
  const adapter = new AdapterClass({
    runtimeId: 'r1', teamId: 't1', agentId: 'dev-1', cwd: '/work', systemPrompt: 'sys',
    spawnImpl: () => {
      spawnCalls += 1;
      if (spawnCalls === 1) throw new Error('EAGAIN'); // sync pre-spawn failure
      const c = fakeChild(okLines);
      children.push(c);
      return c;
    },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
  });

  const pA = adapter.sendTurn({ message: { text: 'alpha' } });
  const pB = adapter.sendTurn({ message: { text: 'beta' } });
  pA.catch(() => {}); // first caller's turn rejects on the pre-spawn throw

  const [sA, sB] = await Promise.allSettled([pA, pB]);

  assert.ok(spawnCalls >= 2, `coalesced batch must be re-spawned after a pre-spawn throw, got spawnCalls=${spawnCalls}`);
  for (const s of [sA, sB]) {
    if (s.status === 'fulfilled') {
      assert.notEqual(s.value.responseState, 'coalesced',
        'a message in the discarded batch must NOT be reported as a coalesced success');
    }
  }
  assert.ok(children.length >= 1, 'a real turn must have run after the throw');
  assert.match(children[0].writes.join(''), /alpha[\s\S]*beta/,
    'the recovered turn must carry the full coalesced batch');
}

test('GeminiExecAdapter does not lose the coalesced batch on a synchronous spawn throw', async () => {
  await assertNoBatchLossOnSpawnThrow(GeminiExecAdapter, GEMINI_OK);
});

test('OpencodeExecAdapter does not lose the coalesced batch on a synchronous spawn throw', async () => {
  await assertNoBatchLossOnSpawnThrow(OpencodeExecAdapter, OPENCODE_OK);
});
