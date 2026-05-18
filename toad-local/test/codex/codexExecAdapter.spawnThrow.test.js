/**
 * W5 — Important 3 (whole-impl review): a synchronous spawnImpl throw must
 * not discard the coalesced batch as a false `coalesced` success.
 *
 * Before the fix: sendTurn clears `_pendingTexts` BEFORE the spawn is
 * confirmed. If spawnImpl throws synchronously, #runTurn rejects (the first
 * caller sees it) but later coalesced callers' chain slots find an empty
 * `_pendingTexts` and resolve `{accepted:true, responseState:'coalesced'}` —
 * even though their message was in the discarded batch and was never
 * delivered. Net: silent message loss reported as success.
 *
 * After the fix: a pre-spawn throw restores the batch so the next chained
 * slot re-drains and delivers it; nothing is silently dropped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function gatedChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.release = () => {
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 's1' }) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
      child.emit('close', 0);
    });
  };
  child.stdin = { write: (s) => child.writes.push(String(s)), end: () => {}, writable: true };
  child.kill = () => { child.killed = true; };
  return child;
}

test('a synchronous spawn throw does not lose the coalesced batch or report false coalesced success', async () => {
  let spawnCalls = 0;
  const children = [];
  const adapter = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: '',
    spawnImpl: () => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        const e = new Error('EAGAIN'); // sync spawn failure (resource exhaustion)
        throw e;
      }
      const c = gatedChild();
      children.push(c);
      return c;
    },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
  });

  // Two synchronously-coalesced messages → one batch [alpha, beta].
  const pA = adapter.sendTurn({ message: { text: 'alpha' } });
  const pB = adapter.sendTurn({ message: { text: 'beta' } });
  pA.catch(() => {}); // first caller's turn rejects (pre-spawn throw) — handled below

  // Wait until the recovered slot has re-spawned the batch (bounded poll).
  for (let i = 0; i < 50 && spawnCalls < 2; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  // The batch must have been retried (not silently dropped on the throw).
  assert.ok(spawnCalls >= 2, `coalesced batch must be re-spawned after a pre-spawn throw, got spawnCalls=${spawnCalls}`);
  assert.ok(children.length >= 1, 'a real turn must have run after the throw');

  // Let the recovered turn complete, THEN settle both callers.
  children[0].release();
  const [sA, sB] = await Promise.allSettled([pA, pB]);

  // No caller may report a false `coalesced` success for an undelivered message.
  for (const s of [sA, sB]) {
    if (s.status === 'fulfilled') {
      assert.notEqual(s.value.responseState, 'coalesced',
        'a message in the discarded batch must NOT be reported as a coalesced success');
    }
  }

  // The recovered turn actually carried BOTH coalesced messages.
  assert.match(children[0].writes.join(''), /alpha[\s\S]*beta/,
    'the recovered turn must carry the full coalesced batch');
});
