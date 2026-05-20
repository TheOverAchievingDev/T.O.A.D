/**
 * BR2 — Critical B1 (bundle whole-impl review): the drift Step-E gate-mode
 * notification built `to: { kind: 'team' }` with NO teamId. The real
 * createMessageEnvelope → normalizeRecipient REQUIRES teamId for the 'team'
 * kind (src/protocol/envelopes.js:52-55), so broker.appendMessage threw on
 * every gate finding — and driftEngine.js swallows it in a bare catch, so
 * every gate-mode violation alert was silently lost (Step E non-functional).
 *
 * This locks the broker-recipient contract Step E must satisfy: the exact
 * payload shape driftEngine.js builds must construct a valid envelope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageEnvelope } from '../../src/protocol/envelopes.js';

// The exact appendMessage payload shape from driftEngine.js Step E.
function stepEPayload(to) {
  return {
    teamId: 'team-a',
    idempotencyKey: 'drift-gate-notify-run_x',
    from: { kind: 'system', id: 'drift-engine' },
    to,
    kind: 'system',
    text: '[drift] 1 gate-mode constitution violation detected',
    taskRefs: [],
    metadata: { source: 'drift_gate_violation', runId: 'run_x', findingCount: 1 },
  };
}

test('the OLD Step-E recipient {kind:"team"} (no teamId) is rejected by the real envelope (documents the swallowed bug)', () => {
  assert.throws(
    () => createMessageEnvelope(stepEPayload({ kind: 'team' })),
    /teamId/,
    'a team recipient without teamId must be rejected — this is what driftEngine.js swallowed',
  );
});

test('the FIXED Step-E recipient {kind:"team", teamId} builds a valid envelope addressed to the team', () => {
  const env = createMessageEnvelope(stepEPayload({ kind: 'team', teamId: 'team-a' }));
  assert.equal(env.to.kind, 'team');
  assert.equal(env.to.teamId, 'team-a');
});
