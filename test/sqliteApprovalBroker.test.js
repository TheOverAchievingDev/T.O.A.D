import test from 'node:test';
import assert from 'node:assert/strict';
import { openToadDatabase } from '../src/storage/sqlite.js';
import { SqliteApprovalBroker } from '../src/approval/sqliteApprovalBroker.js';

test('SqliteApprovalBroker persists approval requests and responses', () => {
  const db = openToadDatabase(':memory:');
  const broker = new SqliteApprovalBroker({ db });

  const request = broker.requestApproval({
    approvalId: 'approval-1',
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    prompt: 'Allow file write?',
    metadata: { path: 'README.md' },
    requestedAt: '2026-04-30T00:00:00.000Z',
  });

  assert.equal(request.status, 'pending');
  assert.equal(request.prompt, 'Allow file write?');
  assert.deepEqual(request.metadata, { path: 'README.md' });

  const response = broker.respondApproval({
    approvalId: 'approval-1',
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    decision: 'approved',
    reason: 'Expected local edit.',
    respondedAt: '2026-04-30T00:00:01.000Z',
  });

  assert.equal(response.status, 'approved');
  assert.equal(response.decision, 'approved');
  assert.equal(response.respondedBy.agentId, 'operator');
  assert.equal(response.reason, 'Expected local edit.');
  assert.equal(response.respondedAt, '2026-04-30T00:00:01.000Z');
  assert.deepEqual(broker.getApproval('approval-1'), response);

  broker.close();
});

test('SqliteApprovalBroker responses are idempotent by key', () => {
  const db = openToadDatabase(':memory:');
  const broker = new SqliteApprovalBroker({ db });
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

  broker.close();
});

test('SqliteApprovalBroker lists approvals by team', () => {
  const db = openToadDatabase(':memory:');
  const broker = new SqliteApprovalBroker({ db });
  broker.requestApproval({
    approvalId: 'approval-a',
    teamId: 'team-a',
    agentId: 'lead',
    prompt: 'Team A?',
  });
  broker.requestApproval({
    approvalId: 'approval-b',
    teamId: 'team-b',
    agentId: 'lead',
    prompt: 'Team B?',
  });

  assert.deepEqual(
    broker.listApprovals({ teamId: 'team-a' }).map((approval) => approval.approvalId),
    ['approval-a']
  );

  broker.close();
});

test('SqliteApprovalBroker tracks approval delivery', () => {
  const db = openToadDatabase(':memory:');
  const broker = new SqliteApprovalBroker({ db });
  broker.requestApproval({
    approvalId: 'approval-d',
    teamId: 'team-d',
    agentId: 'lead',
    prompt: 'Deliver me?',
  });

  let approval = broker.getApproval('approval-d');
  assert.equal(approval.delivery, null);

  approval = broker.markApprovalDelivered({
    approvalId: 'approval-d',
    runtimeId: 'runtime-adapter-1',
    deliveredAt: '2026-04-30T00:00:02.000Z',
  });

  assert.equal(approval.delivery.runtimeId, 'runtime-adapter-1');
  assert.equal(approval.delivery.deliveredAt, '2026-04-30T00:00:02.000Z');

  // Idempotent delivery tracking
  const duplicate = broker.markApprovalDelivered({
    approvalId: 'approval-d',
    runtimeId: 'runtime-adapter-2', // should not overwrite
    deliveredAt: '2026-04-30T00:00:03.000Z',
  });

  assert.equal(duplicate.delivery.runtimeId, 'runtime-adapter-1');
  assert.equal(duplicate.delivery.deliveredAt, '2026-04-30T00:00:02.000Z');

  broker.close();
});
