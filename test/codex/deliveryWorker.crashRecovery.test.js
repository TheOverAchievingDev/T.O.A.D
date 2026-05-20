/**
 * W3 — crash recovery for W1's in-flight (`delivering`) claim.
 *
 * W1 made DeliveryWorker mark a session attempt `delivering` before the
 * (multi-minute) turn so a concurrent sweep can't re-enter. But if the
 * process dies mid-turn the attempt is stuck `delivering` forever: the
 * running sweep won't re-surface it (listMessagesNeedingDelivery only matches
 * `queued_for_recipient`) and a boot-time deliverMessage early-returns on the
 * idempotency gate (`delivering` !== `queued_for_recipient`) → the message is
 * LOST on crash, violating spec §5/§8.
 *
 * Fix: at boot, before computing undelivered inboxes, reset stale session
 * `delivering` attempts back to `queued_for_recipient` (a `delivering`
 * attempt means the process died mid-turn — on restart it is undelivered
 * again). `accepted_by_runtime` / offline / Claude attempts are untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBroker } from '../../src/broker/sqliteBroker.js';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';

test('SqliteBroker.resetStaleSessionInFlight: delivering→queued_for_recipient (session only), terminal states untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toad-crash-rec-'));
  const broker = new SqliteBroker({ filePath: join(dir, 'toad.db') });
  try {
    const mk = (agentId, text) => broker.appendMessage({
      teamId: 't1', from: { kind: 'user', id: 'lead' },
      to: { kind: 'agent', teamId: 't1', agentId },
      kind: 'instruction', text, idempotencyKey: `k-${agentId}-${Math.random()}`,
    }).message;

    // (a) a session attempt stuck `delivering` (crashed mid-turn)
    const m1 = mk('dev-1', 'crashed mid-turn');
    const a1 = broker.beginDeliveryAttempt({
      messageId: m1.messageId, runtimeId: 'r-1', destination: { kind: 'session_turn', agentId: 'dev-1' },
      idempotencyKey: 'i1', payloadHash: 'h1', deliveryKind: 'session_turn',
    });
    broker.markDeliveryInFlight({ attemptId: a1.attemptId });

    // (b) a session attempt already delivered — must NOT be reset
    const m2 = mk('dev-2', 'already done');
    const a2 = broker.beginDeliveryAttempt({
      messageId: m2.messageId, runtimeId: 'r-2', destination: { kind: 'session_turn', agentId: 'dev-2' },
      idempotencyKey: 'i2', payloadHash: 'h2', deliveryKind: 'session_turn',
    });
    broker.commitDeliveryAttempt({ attemptId: a2.attemptId, receipt: { written: true }, responseState: 'accepted_by_runtime' });

    // Before reset: the crashed one is NOT surfaced (delivering ≠ queued_for_recipient)
    assert.ok(!broker.listMessagesNeedingDelivery({}).some((m) => m.messageId === m1.messageId),
      'a delivering attempt is not surfaced before reset');

    const resetCount = broker.resetStaleSessionInFlight();
    assert.equal(resetCount, 1, 'exactly the one stale delivering attempt was reset');

    // After reset: the crashed one IS surfaced; the delivered one still is NOT
    const needing = broker.listMessagesNeedingDelivery({});
    assert.ok(needing.some((m) => m.messageId === m1.messageId),
      'crashed (delivering) message must be re-surfaced after reset');
    assert.ok(!needing.some((m) => m.messageId === m2.messageId),
      'an accepted_by_runtime message must NOT be resurrected by reset');
  } finally {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('END-TO-END: a session message whose turn crashed mid-flight is recovered exactly once after restart+reset', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });

  const { message } = broker.appendMessage({
    teamId: 't1', from: { kind: 'user', id: 'lead' }, to: { kind: 'agent', teamId: 't1', agentId: 'dev-1' },
    kind: 'instruction', text: 'survive a crash', idempotencyKey: 'k-crash-1',
  });

  // 1. A turn starts but the process "crashes" mid-turn: sendTurn never resolves.
  const crashedAdapter = new Map([['r-codex-1', { sendTurn() { return new Promise(() => {}); } }]]);
  const preCrashWorker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: crashedAdapter });
  preCrashWorker.deliverMessage(message.messageId); // intentionally not awaited (it never resolves)
  await new Promise((r) => setTimeout(r, 10)); // let it claim `delivering`

  // 2. "Restart": fresh worker, a healthy adapter.
  const seen = [];
  const adapters = new Map([['r-codex-1', {
    async sendTurn(t) { seen.push(t.message.messageId); return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: 'r-codex-1' } }; },
  }]]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });

  // Without the boot reset, the stale `delivering` attempt is early-returned (LOST).
  const lost = await worker.deliverMessage(message.messageId);
  assert.equal(seen.length, 0, 'documents the crash-loss defect: stale delivering is not re-driven without reset');
  assert.equal(lost.responseState, 'delivering');

  // Boot reconciliation resets stale in-flight, then re-drives.
  broker.resetStaleSessionInFlight();
  const recovered = await worker.deliverMessage(message.messageId);
  assert.equal(seen.length, 1, 'recovered and delivered exactly once after reset');
  assert.equal(seen[0], message.messageId);
  assert.equal(recovered.responseState, 'accepted_by_runtime');
});
