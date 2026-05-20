/**
 * W1 — Critical 1 (whole-impl review): parked-message re-entry storm.
 *
 * Production trigger: a session_turn message is parked `queued_for_recipient`
 * (no live adapter at first delivery). The 500ms retry sweep
 * (LocalToadRuntime `setInterval(tick,500)`, no re-entrancy guard) calls
 * `deliverMessage` again once an adapter is live. A real Codex turn takes
 * minutes, so the attempt stays `queued_for_recipient` (commit only happens
 * AFTER `await adapter.sendTurn` resolves) and the NEXT sweep tick re-enters
 * and calls `adapter.sendTurn` again — pushing the SAME message into the
 * adapter repeatedly, defeating spec §5 coalescing.
 *
 * Fix: DeliveryWorker must claim the attempt in-flight (`delivering`)
 * synchronously BEFORE `await adapter.sendTurn`, so a concurrent re-entry is
 * short-circuited by the existing idempotency gate and never calls sendTurn
 * a second time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';

function appended(broker, to) {
  const { message } = broker.appendMessage({
    teamId: 't1',
    from: { kind: 'user', id: 'lead' },
    to,
    kind: 'instruction',
    text: 'ping',
    idempotencyKey: `k-${Math.random()}`,
  });
  return message;
}

test('parked session_turn message: a concurrent re-delivery while a turn is in flight does NOT call sendTurn twice', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });

  // 1. First delivery with NO adapter → parks the message queued_for_recipient.
  const noAdapterWorker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: new Map() });
  const msg = appended(broker, { kind: 'agent', teamId: 't1', agentId: 'dev-1' });
  const parked = await noAdapterWorker.deliverMessage(msg.messageId);
  assert.equal(parked.status, 'committed');
  assert.equal(parked.responseState, 'queued_for_recipient');

  // 2. Adapter is now live but its turn is SLOW (a real Codex turn = minutes).
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const adapters = new Map([['r-codex-1', {
    async sendTurn() {
      calls += 1;
      await gate; // simulate a long in-flight turn
      return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: 'r-codex-1' } };
    },
  }]]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });

  // 3. Two overlapping sweep ticks re-drive the SAME parked message before the
  //    first turn completes (the attempt is still queued_for_recipient).
  const d1 = worker.deliverMessage(msg.messageId);
  const d2 = worker.deliverMessage(msg.messageId);

  // Let both run up to their first await.
  await new Promise((r) => setTimeout(r, 10));

  // The in-flight claim must have blocked the second entry.
  assert.equal(calls, 1, `expected sendTurn called exactly once, got ${calls}`);

  release();
  await Promise.all([d1, d2]);
  assert.equal(calls, 1, `still exactly one sendTurn after both resolve, got ${calls}`);
});
