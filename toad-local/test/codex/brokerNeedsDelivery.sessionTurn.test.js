/**
 * Task 9c — RED/GREEN test for listMessagesNeedingDelivery picking up
 * parked session_turn messages (committed, responseState='queued_for_recipient').
 *
 * Context: the 500ms retry sweep calls listMessagesNeedingDelivery to find
 * messages that still need to be delivered. Before this fix, only messages
 * with an offline_queue attempt were surfaced. A session_turn message parked
 * as queued_for_recipient (no adapter present at time of first delivery) had
 * NO offline_queue attempt → never re-driven → lost in production.
 *
 * After the fix, a committed session_turn attempt with
 * responseState='queued_for_recipient' ALSO surfaces the message. Once the
 * adapter wakes up and delivers it (responseState becomes 'accepted_by_runtime'),
 * the message DROPS OUT of the needing-delivery set (self-terminating).
 *
 * Only SqliteBroker is tested because InMemoryBroker does not implement
 * listMessagesNeedingDelivery (confirmed by reading inMemoryBroker.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBroker } from '../../src/broker/sqliteBroker.js';

function withBroker(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-needs-delivery-'));
  const broker = new SqliteBroker({ filePath: join(dir, 'toad.db') });
  try {
    testFn(broker);
  } finally {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('listMessagesNeedingDelivery: parked session_turn (queued_for_recipient) is surfaced', () => {
  withBroker((broker) => {
    // 1. Append an agent-addressed message (mirrors sqliteBroker.test.js envelope shape)
    const { message } = broker.appendMessage({
      teamId: 't',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 't', agentId: 'dev-1' },
      kind: 'instruction',
      text: 'You own task-9c.',
    });
    const messageId = message.messageId;

    // 2. Begin + commit a session_turn attempt with responseState='queued_for_recipient'
    //    (simulates: adapter was not present when DeliveryWorker first ran)
    const { attemptId } = broker.beginDeliveryAttempt({
      messageId,
      runtimeId: 'r-codex-1',
      destination: { kind: 'session_turn', agentId: 'dev-1' },
      idempotencyKey: 'k1',
      payloadHash: 'h1',
      deliveryKind: 'session_turn',
    });
    broker.commitDeliveryAttempt({
      attemptId,
      receipt: {},
      responseState: 'queued_for_recipient',
    });

    // 3. Assert the message IS surfaced by listMessagesNeedingDelivery (RED before fix)
    const needingDelivery = broker.listMessagesNeedingDelivery({});
    assert.ok(
      needingDelivery.some((m) => m.messageId === messageId),
      `expected parked session_turn message ${messageId} to be in listMessagesNeedingDelivery`
    );

    // 4. Simulate the adapter waking up and delivering the message:
    //    commit the same attempt with responseState='accepted_by_runtime'
    broker.commitDeliveryAttempt({
      attemptId,
      receipt: { written: true },
      responseState: 'accepted_by_runtime',
    });

    // 5. Assert the message is NO LONGER surfaced (self-terminating — must not loop forever)
    const afterDelivery = broker.listMessagesNeedingDelivery({});
    assert.ok(
      !afterDelivery.some((m) => m.messageId === messageId),
      `expected delivered message ${messageId} to be gone from listMessagesNeedingDelivery`
    );
  });
});

test('listMessagesNeedingDelivery: offline_queue messages still surfaced (regression)', () => {
  withBroker((broker) => {
    // Ensure the existing offline_queue path still works after the query change
    const { message } = broker.appendMessage({
      teamId: 't',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 't', agentId: 'architect' },
      kind: 'task_notification',
      text: 'Offline queued message.',
    });
    const messageId = message.messageId;

    const { attemptId } = broker.beginDeliveryAttempt({
      messageId,
      runtimeId: 'offline:t:architect',
      destination: { kind: 'offline_queue', agentId: 'architect' },
      idempotencyKey: 'oq1',
      payloadHash: 'sha256:oq',
      deliveryKind: 'offline_queue',
    });
    broker.commitDeliveryAttempt({
      attemptId,
      receipt: {},
      responseState: 'queued_offline',
    });

    const needingDelivery = broker.listMessagesNeedingDelivery({});
    assert.ok(
      needingDelivery.some((m) => m.messageId === messageId),
      'offline_queue message must still be surfaced'
    );
  });
});

test('listMessagesNeedingDelivery: accepted_by_runtime session_turn is NOT surfaced', () => {
  withBroker((broker) => {
    // A message already accepted by the runtime should NOT appear
    const { message } = broker.appendMessage({
      teamId: 't',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 't', agentId: 'dev-2' },
      kind: 'instruction',
      text: 'Already delivered.',
    });
    const messageId = message.messageId;

    const { attemptId } = broker.beginDeliveryAttempt({
      messageId,
      runtimeId: 'r-codex-2',
      destination: { kind: 'session_turn', agentId: 'dev-2' },
      idempotencyKey: 'k2',
      payloadHash: 'h2',
      deliveryKind: 'session_turn',
    });
    broker.commitDeliveryAttempt({
      attemptId,
      receipt: { written: true },
      responseState: 'accepted_by_runtime',
    });

    const needingDelivery = broker.listMessagesNeedingDelivery({});
    assert.ok(
      !needingDelivery.some((m) => m.messageId === messageId),
      'accepted_by_runtime session_turn must NOT be surfaced'
    );
  });
});
