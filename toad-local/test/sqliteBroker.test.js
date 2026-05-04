import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBroker } from '../src/broker/sqliteBroker.js';

function withBroker(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-sqlite-broker-'));
  const broker = new SqliteBroker({ filePath: join(dir, 'toad.db') });
  try {
    testFn(broker);
  } finally {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteBroker stores messages and lists inboxes', () => {
  withBroker((broker) => {
    const result = broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
      text: 'Build storage.',
      taskRefs: [{ taskId: 'storage' }],
      metadata: { priority: 'high' },
    });

    assert.equal(result.inserted, true);
    const inbox = broker.listInbox({
      teamId: 'team-a',
      recipient: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
    });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].text, 'Build storage.');
    assert.deepEqual(inbox[0].taskRefs, [{ taskId: 'storage' }]);
    assert.equal(inbox[0].metadata.priority, 'high');
  });
});

test('SqliteBroker lists messages by team in chronological order', () => {
  withBroker((broker) => {
    broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
      text: 'Second.',
      createdAt: '2026-04-29T00:02:00.000Z',
    });
    broker.appendMessage({
      teamId: 'team-b',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-b', agentId: 'lead' },
      text: 'Other team.',
      createdAt: '2026-04-29T00:01:00.000Z',
    });
    broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
      text: 'First.',
      createdAt: '2026-04-29T00:00:00.000Z',
    });

    const messages = broker.listMessages({ teamId: 'team-a', limit: 1 });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'First.');
  });
});

test('SqliteBroker append is idempotent', () => {
  withBroker((broker) => {
    const first = broker.appendMessage({
      teamId: 'team-a',
      idempotencyKey: 'storage-once',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
      text: 'Build storage.',
    });
    const second = broker.appendMessage({
      teamId: 'team-a',
      idempotencyKey: 'storage-once',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
      text: 'Build something else.',
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.message.messageId, first.message.messageId);
    assert.equal(second.message.text, 'Build storage.');
  });
});

test('SqliteBroker persists delivery attempts', () => {
  withBroker((broker) => {
    const { message } = broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
      text: 'Coordinate the team.',
    });
    const attempt = broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: 'claude-lead-1',
      destination: { kind: 'stdin' },
    });
    const committed = broker.commitDeliveryAttempt({
      attemptId: attempt.attemptId,
      receipt: { written: true },
    });

    assert.equal(committed.status, 'committed');
    assert.equal(committed.receipt.written, true);
  });
});

test('SqliteBroker delivery attempts are idempotent by key and payload hash', () => {
  withBroker((broker) => {
    const { message } = broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
      text: 'Coordinate delivery.',
    });

    const first = broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: 'claude-lead-1',
      destination: { kind: 'runtime_stdin', agentId: 'lead' },
      idempotencyKey: 'deliver-lead-once',
      payloadHash: 'sha256:abc',
      deliveryKind: 'runtime_stdin',
    });
    const second = broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: 'claude-lead-1',
      destination: { kind: 'runtime_stdin', agentId: 'lead' },
      idempotencyKey: 'deliver-lead-once',
      payloadHash: 'sha256:abc',
      deliveryKind: 'runtime_stdin',
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.attempt.attemptId, first.attempt.attemptId);
  });
});

test('SqliteBroker delivery attempt idempotency rejects payload conflicts', () => {
  withBroker((broker) => {
    const { message } = broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
      text: 'Coordinate delivery.',
    });

    broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: 'claude-lead-1',
      destination: { kind: 'runtime_stdin', agentId: 'lead' },
      idempotencyKey: 'deliver-lead-once',
      payloadHash: 'sha256:abc',
      deliveryKind: 'runtime_stdin',
    });

    assert.throws(
      () =>
        broker.beginDeliveryAttempt({
          messageId: message.messageId,
          runtimeId: 'claude-lead-1',
          destination: { kind: 'runtime_stdin', agentId: 'lead' },
          idempotencyKey: 'deliver-lead-once',
          payloadHash: 'sha256:different',
          deliveryKind: 'runtime_stdin',
        }),
      /delivery idempotency conflict/
    );
  });
});

test('SqliteBroker.listMessagesNeedingDelivery surfaces messages stuck in offline_queue without a real delivery', () => {
  // Each agent's MCP child runs its own LocalToadRuntime with empty
  // adapters/directory, so message_send from agent A → agent B falls
  // through to offline_queue inside the MCP child. The main sidecar's
  // delivery retry sweep (LocalToadRuntime.start()) needs a query that
  // surfaces only those still-undelivered messages — not user/system
  // messages, not messages already delivered via runtime_stdin.
  withBroker((broker) => {
    // 1. Lead → architect, queued offline by some other process
    const queued = broker.appendMessage({
      teamId: 't',
      idempotencyKey: 'msg-queued',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 't', agentId: 'architect' },
      kind: 'task_notification',
      text: 'You own task-1.',
    });
    {
      const a = broker.beginDeliveryAttempt({
        messageId: queued.message.messageId,
        runtimeId: 'offline:t:architect',
        destination: { kind: 'offline_queue', agentId: 'architect' },
        idempotencyKey: 'q1',
        payloadHash: 'sha256:queued',
        deliveryKind: 'offline_queue',
        responseState: 'queued_offline',
      });
      broker.commitDeliveryAttempt({ attemptId: a.attempt.attemptId, responseState: 'queued_offline' });
    }

    // 2. Lead → developer, already delivered for real via runtime_stdin
    const delivered = broker.appendMessage({
      teamId: 't',
      idempotencyKey: 'msg-delivered',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'agent', teamId: 't', agentId: 'developer' },
      kind: 'task_notification',
      text: 'You own task-2.',
    });
    {
      const a = broker.beginDeliveryAttempt({
        messageId: delivered.message.messageId,
        runtimeId: 'runtime-t-developer',
        destination: { kind: 'runtime_stdin', agentId: 'developer' },
        idempotencyKey: 'd1',
        payloadHash: 'sha256:delivered',
        deliveryKind: 'runtime_stdin',
        responseState: 'accepted_by_runtime',
      });
      broker.commitDeliveryAttempt({ attemptId: a.attempt.attemptId, responseState: 'accepted_by_runtime' });
    }

    // 3. Lead → user (not an agent target — must NOT show up)
    broker.appendMessage({
      teamId: 't',
      idempotencyKey: 'msg-to-user',
      from: { kind: 'agent', id: 'lead' },
      to: { kind: 'user' },
      kind: 'reply',
      text: 'Status update.',
    });

    const pending = broker.listMessagesNeedingDelivery();
    assert.equal(pending.length, 1, 'only the offline-queued agent message is pending');
    assert.equal(pending[0].messageId, queued.message.messageId);
    assert.equal(pending[0].to.agentId, 'architect');
  });
});
