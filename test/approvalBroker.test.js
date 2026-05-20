import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryApprovalBroker } from '../src/approval/inMemoryApprovalBroker.js';

test('InMemoryApprovalBroker records and responds to approval requests', () => {
  const broker = new InMemoryApprovalBroker();
  const request = broker.requestApproval({
    approvalId: 'approval-1',
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    prompt: 'Allow file write?',
    metadata: { path: 'README.md' },
  });

  assert.equal(request.status, 'pending');
  assert.equal(request.prompt, 'Allow file write?');

  const response = broker.respondApproval({
    approvalId: 'approval-1',
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    decision: 'approved',
    reason: 'Expected local edit.',
  });

  assert.equal(response.status, 'approved');
  assert.equal(response.decision, 'approved');
  assert.equal(response.respondedBy.agentId, 'operator');
  assert.equal(response.reason, 'Expected local edit.');
});

test('InMemoryApprovalBroker responses are idempotent by key', () => {
  const broker = new InMemoryApprovalBroker();
  broker.requestApproval({
    approvalId: 'approval-1',
    teamId: 'team-a',
    agentId: 'lead',
    prompt: 'Allow command?',
  });

  const first = broker.respondApproval({
    approvalId: 'approval-1',
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    decision: 'denied',
  });
  const second = broker.respondApproval({
    approvalId: 'approval-1',
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    decision: 'approved',
  });

  assert.equal(second.decision, 'denied');
  assert.deepEqual(second, first);
});
