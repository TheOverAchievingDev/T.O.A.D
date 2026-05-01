import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';

test('appendMessage stores a message and exposes it through the target inbox', () => {
  const broker = new InMemoryBroker();
  const result = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'agent', id: 'lead' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
    text: 'Implement the parser.',
  });

  assert.equal(result.inserted, true);
  const inbox = broker.listInbox({
    teamId: 'team-a',
    recipient: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
  });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].text, 'Implement the parser.');
});

test('listMessages filters by team and applies chronological limit', () => {
  const broker = new InMemoryBroker();
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

test('appendMessage is idempotent by idempotencyKey', () => {
  const broker = new InMemoryBroker();
  const first = broker.appendMessage({
    teamId: 'team-a',
    idempotencyKey: 'assign-parser-once',
    from: { kind: 'agent', id: 'lead' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
    text: 'Implement the parser.',
  });
  const second = broker.appendMessage({
    teamId: 'team-a',
    idempotencyKey: 'assign-parser-once',
    from: { kind: 'agent', id: 'lead' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
    text: 'Implement the parser again.',
  });

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.message.messageId, first.message.messageId);
  assert.equal(second.message.text, 'Implement the parser.');
});

test('delivery attempts can be committed', () => {
  const broker = new InMemoryBroker();
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Ship the MVP.',
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

test('delivery attempts are idempotent by idempotency key and payload hash', () => {
  const broker = new InMemoryBroker();
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

test('delivery attempt idempotency rejects payload conflicts', () => {
  const broker = new InMemoryBroker();
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
