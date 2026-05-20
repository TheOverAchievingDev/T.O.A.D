import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';

test('RuntimeDirectory resolves an agent destination', () => {
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });

  const destination = directory.resolve({
    kind: 'agent',
    teamId: 'team-a',
    agentId: 'lead',
  });

  assert.equal(destination.runtimeId, 'claude-lead-1');
  assert.equal(destination.deliveryMode, 'runtime_stdin');
});

test('RuntimeDirectory falls back to offline queue for unknown agents', () => {
  const directory = new RuntimeDirectory();
  const destination = directory.resolve({
    kind: 'agent',
    teamId: 'team-a',
    agentId: 'worker-1',
  });

  assert.equal(destination.runtimeId, 'offline:team-a:worker-1');
  assert.equal(destination.deliveryMode, 'offline_queue');
});

test('DeliveryWorker sends runtime_stdin messages through an adapter', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });
  const sentTurns = [];
  const adapters = new Map([
    [
      'claude-lead-1',
      {
        async sendTurn(turn) {
          sentTurns.push(turn);
          return {
            accepted: true,
            responseState: 'accepted_by_runtime',
            receipt: { written: true },
          };
        },
      },
    ],
  ]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    idempotencyKey: 'msg-user-lead',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Coordinate the team.',
  });

  const result = await worker.deliverMessage(message.messageId);

  assert.equal(result.status, 'committed');
  assert.equal(sentTurns.length, 1);
  assert.equal(sentTurns[0].message.messageId, message.messageId);
  assert.equal(sentTurns[0].message.text, 'Coordinate the team.');
});

test('DeliveryWorker commits pollable inbox delivery without an adapter call', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'worker-1',
    runtimeId: 'worker-queue-1',
    deliveryMode: 'pollable_inbox',
  });
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: new Map() });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'agent', id: 'lead' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
    text: 'Read from your broker inbox.',
  });

  const result = await worker.deliverMessage(message.messageId);

  assert.equal(result.status, 'committed');
  assert.equal(result.receipt.queued, true);
  assert.equal(result.receipt.deliveryMode, 'pollable_inbox');
});

test('DeliveryWorker records retryable failure when adapter is missing', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: new Map() });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'This needs a runtime adapter.',
  });

  const result = await worker.deliverMessage(message.messageId);

  assert.equal(result.status, 'failed_retryable');
  assert.match(result.error, /runtime adapter not registered/);
  assert.equal(result.responseState, 'delivery_failed');
});

test('DeliveryWorker does not resend already committed attempts', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });
  let calls = 0;
  const adapters = new Map([
    [
      'claude-lead-1',
      {
        async sendTurn() {
          calls += 1;
          return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true } };
        },
      },
    ],
  ]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Deliver once.',
  });

  const first = await worker.deliverMessage(message.messageId);
  const second = await worker.deliverMessage(message.messageId);

  assert.equal(first.status, 'committed');
  assert.equal(second.status, 'committed');
  assert.equal(calls, 1);
});
