/**
 * W4 — Important 4 (whole-impl review): `hasCommittedRuntimeDelivery` was
 * referenced by LocalToadRuntime.#reconcileSessionInboxes but defined on
 * NEITHER broker → `isCommitted` was unconditionally false → boot
 * reconciliation re-drove the ENTIRE inbox (incl. already-delivered messages),
 * relying solely on deliverMessage idempotency and amplifying the W1 storm.
 *
 * A message counts as committed-delivered iff it has a committed
 * runtime_stdin/runtime_bridge attempt (Claude) OR a session_turn attempt
 * terminally delivered (accepted_by_runtime / coalesced). Parked
 * (queued_for_recipient), in-flight (delivering), failed, and offline_queue
 * attempts are NOT committed-delivered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBroker } from '../../src/broker/sqliteBroker.js';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';

function appendTo(broker, agentId) {
  const { message } = broker.appendMessage({
    teamId: 't1', from: { kind: 'user', id: 'lead' },
    to: { kind: 'agent', teamId: 't1', agentId },
    kind: 'instruction', text: 'x', idempotencyKey: `k-${agentId}-${Math.random()}`,
  });
  return message.messageId;
}

function runScenarios(broker) {
  // 1. no attempts → false
  const mNone = appendTo(broker, 'a0');
  assert.equal(broker.hasCommittedRuntimeDelivery(mNone), false, 'no attempt → not committed');

  // 2. committed runtime_stdin (Claude) → true
  const mClaude = appendTo(broker, 'a1');
  const c = broker.beginDeliveryAttempt({ messageId: mClaude, runtimeId: 'r-c', destination: { kind: 'runtime_stdin' }, idempotencyKey: `ik-${mClaude}`, payloadHash: 'h', deliveryKind: 'runtime_stdin' });
  broker.commitDeliveryAttempt({ attemptId: c.attemptId, receipt: { written: true }, responseState: 'accepted_by_runtime' });
  assert.equal(broker.hasCommittedRuntimeDelivery(mClaude), true, 'committed runtime_stdin → committed');

  // 3. session_turn accepted_by_runtime → true ; 4. coalesced → true
  for (const rs of ['accepted_by_runtime', 'coalesced']) {
    const m = appendTo(broker, `a-${rs}`);
    const a = broker.beginDeliveryAttempt({ messageId: m, runtimeId: 'r-s', destination: { kind: 'session_turn' }, idempotencyKey: `ik-${m}`, payloadHash: 'h', deliveryKind: 'session_turn' });
    broker.commitDeliveryAttempt({ attemptId: a.attemptId, receipt: { written: true }, responseState: rs });
    assert.equal(broker.hasCommittedRuntimeDelivery(m), true, `session_turn ${rs} → committed`);
  }

  // 5. session_turn queued_for_recipient (parked) → false
  const mParked = appendTo(broker, 'a4');
  const p = broker.beginDeliveryAttempt({ messageId: mParked, runtimeId: 'r-s', destination: { kind: 'session_turn' }, idempotencyKey: `ik-${mParked}`, payloadHash: 'h', deliveryKind: 'session_turn' });
  broker.commitDeliveryAttempt({ attemptId: p.attemptId, receipt: {}, responseState: 'queued_for_recipient' });
  assert.equal(broker.hasCommittedRuntimeDelivery(mParked), false, 'parked queued_for_recipient → NOT committed');

  // 6. session_turn delivering (in-flight / crashed) → false
  const mInflight = appendTo(broker, 'a5');
  const f = broker.beginDeliveryAttempt({ messageId: mInflight, runtimeId: 'r-s', destination: { kind: 'session_turn' }, idempotencyKey: `ik-${mInflight}`, payloadHash: 'h', deliveryKind: 'session_turn' });
  broker.markDeliveryInFlight({ attemptId: f.attemptId });
  assert.equal(broker.hasCommittedRuntimeDelivery(mInflight), false, 'delivering → NOT committed');
}

test('SqliteBroker.hasCommittedRuntimeDelivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toad-hcrd-'));
  const broker = new SqliteBroker({ filePath: join(dir, 'toad.db') });
  try { runScenarios(broker); } finally { broker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('InMemoryBroker.hasCommittedRuntimeDelivery', () => {
  runScenarios(new InMemoryBroker());
});
