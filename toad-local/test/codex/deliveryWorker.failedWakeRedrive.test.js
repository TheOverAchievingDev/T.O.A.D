/**
 * W2 — Critical 2 (whole-impl review): a failed session wake must not be
 * silently dropped (spec §5/§8 "a lost session = degraded continuity, never
 * a lost message").
 *
 * Before the fix: a session_turn `sendTurn` that fails while the agent is
 * live → DeliveryWorker catch → failDeliveryAttempt(failed_retryable,
 * 'delivery_failed'). listMessagesNeedingDelivery only re-surfaces committed
 * `queued_for_recipient` (or offline_queue) — a failed_retryable session
 * attempt is NEVER re-driven by the 500ms sweep → lost until restart. This is
 * the symmetric sibling of the parked defect 9c fixed.
 *
 * After the fix: a failed session wake is re-committed `queued_for_recipient`
 * (sweep re-drives it), BOUNDED by a retry cap carried in receipt_json so a
 * persistently-failing wake goes terminal (failed_terminal) instead of
 * storming forever.
 *
 * SqliteBroker only (InMemoryBroker has no listMessagesNeedingDelivery).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBroker } from '../../src/broker/sqliteBroker.js';
import { DeliveryWorker } from '../../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';

async function withRig(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-failed-wake-'));
  const broker = new SqliteBroker({ filePath: join(dir, 'toad.db') });
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });
  try {
    await testFn(broker, directory);
  } finally {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function appendMsg(broker) {
  const { message } = broker.appendMessage({
    teamId: 't1',
    from: { kind: 'user', id: 'lead' },
    to: { kind: 'agent', teamId: 't1', agentId: 'dev-1' },
    kind: 'instruction',
    text: 'work this',
    idempotencyKey: `k-${Math.random()}`,
  });
  return message;
}

test('a failed session wake is re-committed queued_for_recipient and stays re-drivable', async () => {
  await withRig(async (broker, directory) => {
    const failing = new Map([['r-codex-1', {
      async sendTurn() { return { accepted: false, responseState: 'turn_failed', reason: 'codex exec exited (code=1)' }; },
    }]]);
    const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: failing });

    const msg = appendMsg(broker);
    await worker.deliverMessage(msg.messageId);

    const needing = broker.listMessagesNeedingDelivery({});
    assert.ok(
      needing.some((m) => m.messageId === msg.messageId),
      'a failed session wake must still be surfaced by listMessagesNeedingDelivery (never lost)'
    );
  });
});

test('a persistently-failing session wake goes terminal (bounded — does not storm forever)', async () => {
  await withRig(async (broker, directory) => {
    const failing = new Map([['r-codex-1', {
      async sendTurn() { return { accepted: false, responseState: 'turn_failed', reason: 'always fails' }; },
    }]]);
    const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: failing });

    const msg = appendMsg(broker);
    // Drive the sweep many times — each deliverMessage is one re-drive.
    let surfacedCount = 0;
    for (let i = 0; i < 20; i += 1) {
      await worker.deliverMessage(msg.messageId);
      if (broker.listMessagesNeedingDelivery({}).some((m) => m.messageId === msg.messageId)) {
        surfacedCount += 1;
      } else {
        break; // dropped out → terminal
      }
    }
    assert.ok(surfacedCount >= 1, 'must be re-driven at least once before going terminal');
    assert.ok(surfacedCount < 20, 'must NOT re-drive unbounded — a permanently-failing wake must go terminal');
    assert.ok(
      !broker.listMessagesNeedingDelivery({}).some((m) => m.messageId === msg.messageId),
      'after the retry cap the message must be terminal and no longer surfaced'
    );
  });
});
