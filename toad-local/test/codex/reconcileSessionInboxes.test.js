import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUndeliveredSessionMessages } from '../../src/runtime/codex/reconcileSessionInboxes.js';

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
