import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';

// Envelope shape matches the real broker API (createMessageEnvelope):
//   from requires { kind, id }, text (not body), kind must be a MESSAGE_KINDS value.
// Mirrored from test/deliveryWorker.test.js line 64-70.
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

test('session_turn recipient with a registered adapter is woken via sendTurn and committed accepted', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });
  const seen = [];
  const adapters = new Map([['r-codex-1', { async sendTurn(t) { seen.push(t); return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true } }; } }]]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });

  const msg = appended(broker, { kind: 'agent', teamId: 't1', agentId: 'dev-1' });
  const attempt = await worker.deliverMessage(msg.messageId);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].message.messageId, msg.messageId);
  assert.equal(attempt.status, 'committed');
  assert.equal(attempt.responseState, 'accepted_by_runtime');
});

test('session_turn recipient with NO registered adapter is durably queued (survives for reconciliation)', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: new Map() });

  const msg = appended(broker, { kind: 'agent', teamId: 't1', agentId: 'dev-1' });
  const attempt = await worker.deliverMessage(msg.messageId);

  assert.equal(attempt.status, 'committed');
  assert.equal(attempt.responseState, 'queued_for_recipient');
});
