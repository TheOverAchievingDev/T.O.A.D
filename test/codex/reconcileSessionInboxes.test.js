import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUndeliveredSessionMessages } from '../../src/runtime/codex/reconcileSessionInboxes.js';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';

test('returns inbox messages for session_turn agents that have no committed delivery attempt', () => {
  const sessionRuntimes = [
    { runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running' },
    { runtimeId: 'r-claude-1', teamId: 't1', agentId: 'lead', deliveryMode: 'runtime_stdin', status: 'running' },
  ];
  const inbox = {
    'dev-1': [{ messageId: 'm1' }, { messageId: 'm2' }, { messageId: 'm3' }],
    'lead': [{ messageId: 'm9' }],
  };
  const committed = new Set(['m2']);
  const out = computeUndeliveredSessionMessages({
    runtimes: sessionRuntimes,
    listInbox: ({ agentId }) => inbox[agentId] || [],
    isCommitted: (messageId) => committed.has(messageId),
  });
  assert.deepEqual(out.map((x) => x.messageId), ['m1', 'm3']);
  assert.equal(out[0].runtimeId, 'r-codex-1');
});

test('skips non-running session agents and is empty when nothing pending', () => {
  const out = computeUndeliveredSessionMessages({
    runtimes: [{ runtimeId: 'r1', teamId: 't1', agentId: 'd', deliveryMode: 'session_turn', status: 'stopped' }],
    listInbox: () => [{ messageId: 'mX' }],
    isCommitted: () => false,
  });
  assert.deepEqual(out, []);
});

test('END-TO-END: a message to a not-yet-adapter-registered session agent is delivered exactly once after the adapter registers (spec §5/§8 — no loss, no dup)', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });
  const adapters = new Map(); // agent not yet (re)launched — no adapter
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });

  const { message } = broker.appendMessage({
    teamId: 't1', from: { kind: 'user', id: 'lead' }, to: { kind: 'agent', teamId: 't1', agentId: 'dev-1' },
    kind: 'instruction', text: 'must survive restart', idempotencyKey: 'k-recover-1',
  });

  const a1 = await worker.deliverMessage(message.messageId);
  assert.equal(a1.status, 'committed');
  assert.equal(a1.responseState, 'queued_for_recipient');

  const seen = [];
  adapters.set('r-codex-1', { async sendTurn(t) { seen.push(t.message.messageId); return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: 'r-codex-1' } }; } });
  const a2 = await worker.deliverMessage(message.messageId);

  assert.equal(seen.length, 1, 'delivered to the adapter exactly once after it registered');
  assert.equal(seen[0], message.messageId);
  assert.equal(a2.status, 'committed');
  assert.equal(a2.responseState, 'accepted_by_runtime');
});
