import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CompactionHandler } from '../src/runtime/CompactionHandler.js';
import { InMemoryTaskBoard, TASK_EVENT_TYPES } from '../src/task/inMemoryTaskBoard.js';

function createMockAdapter() {
  const turns = [];
  return {
    turns,
    sendTurn(input) {
      turns.push(input);
      return Promise.resolve({
        accepted: true,
        responseState: 'accepted_by_runtime',
        receipt: { written: true },
      });
    },
  };
}

function createRejectingAdapter(error = new Error('adapter rejected')) {
  return {
    sendTurn() {
      return Promise.reject(error);
    },
  };
}

function createMockSideEffectLog() {
  const records = new Map();
  return {
    records,
    markPending({ idempotencyKey, kind, runtimeId, deliveryId }) {
      if (records.has(idempotencyKey)) return;
      records.set(idempotencyKey, {
        idempotencyKey,
        kind,
        runtimeId,
        deliveryId,
        status: 'pending',
        deliveredAt: null,
      });
    },
    markDelivered(idempotencyKey) {
      const record = records.get(idempotencyKey);
      if (record) {
        record.status = 'delivered';
        record.deliveredAt = new Date().toISOString();
      }
    },
    markFailed(idempotencyKey) {
      const record = records.get(idempotencyKey);
      if (record) record.status = 'failed';
    },
    get(idempotencyKey) {
      return records.get(idempotencyKey) ?? null;
    },
  };
}

describe('CompactionHandler', () => {
  const RUNTIME_ID = 'runtime-lead-1';
  const TEAM_ID = 'team-alpha';
  const AGENT_ID = 'lead';

  let adapters;
  let taskBoard;
  let handler;

  beforeEach(() => {
    adapters = new Map();
    taskBoard = new InMemoryTaskBoard();
    handler = new CompactionHandler({ adapters, taskBoard });
  });

  it('compact_boundary marks reinjection pending for the runtime', () => {
    handler.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
      trigger: 'auto',
      preTokens: 180000,
    });

    assert.ok(handler.isPending(RUNTIME_ID));
  });

  it('turn_completed after compact injects reinjection prompt via adapter', async () => {
    const adapter = createMockAdapter();
    adapters.set(RUNTIME_ID, adapter);

    handler.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
      trigger: 'auto',
      preTokens: 150000,
    });

    await handler.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    assert.equal(adapter.turns.length, 1);
    const text = adapter.turns[0].message.text;
    assert.ok(text.includes('context was compacted'), 'prompt should mention compaction');
    assert.ok(text.includes('Reply with'), 'prompt should instruct OK reply');
    assert.ok(!handler.isPending(RUNTIME_ID), 'should clear pending after injection');
  });

  it('turn_completed without pending compact does nothing', async () => {
    const adapter = createMockAdapter();
    adapters.set(RUNTIME_ID, adapter);

    await handler.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    assert.equal(adapter.turns.length, 0);
  });

  it('turn_failed clears pending state without injecting', async () => {
    const adapter = createMockAdapter();
    adapters.set(RUNTIME_ID, adapter);

    handler.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    handler.onTurnFailed({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    assert.ok(!handler.isPending(RUNTIME_ID));
    assert.equal(adapter.turns.length, 0);
  });

  it('reinjection prompt includes task board state when tasks exist', async () => {
    const adapter = createMockAdapter();
    adapters.set(RUNTIME_ID, adapter);

    taskBoard.appendEvent({
      teamId: TEAM_ID,
      taskId: 'task-1',
      idempotencyKey: 'create-task-1',
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: AGENT_ID,
      payload: { subject: 'Build the parser', status: 'in_progress' },
    });

    handler.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    await handler.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    const text = adapter.turns[0].message.text;
    assert.ok(text.includes('Build the parser'), 'should include task subject');
    assert.ok(text.includes('task-1'), 'should include task id');
  });

  it('reinjection is not triggered when adapter is unavailable', async () => {
    // No adapter registered for the runtime
    handler.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    await handler.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    // No crash, pending state cleared
    assert.ok(!handler.isPending(RUNTIME_ID));
  });

  it('multiple compactions before idle result in a single reinjection', async () => {
    const adapter = createMockAdapter();
    adapters.set(RUNTIME_ID, adapter);

    handler.onCompactBoundary({ runtimeId: RUNTIME_ID, teamId: TEAM_ID, agentId: AGENT_ID });
    handler.onCompactBoundary({ runtimeId: RUNTIME_ID, teamId: TEAM_ID, agentId: AGENT_ID });
    handler.onCompactBoundary({ runtimeId: RUNTIME_ID, teamId: TEAM_ID, agentId: AGENT_ID });

    await handler.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    assert.equal(adapter.turns.length, 1, 'should inject only once regardless of compact count');
  });

  it('reinjection for one runtime does not affect another', async () => {
    const adapter1 = createMockAdapter();
    const adapter2 = createMockAdapter();
    adapters.set('runtime-1', adapter1);
    adapters.set('runtime-2', adapter2);

    handler.onCompactBoundary({ runtimeId: 'runtime-1', teamId: TEAM_ID, agentId: 'lead' });

    await handler.onTurnCompleted({ runtimeId: 'runtime-2', teamId: TEAM_ID, agentId: 'worker' });
    await handler.onTurnCompleted({ runtimeId: 'runtime-1', teamId: TEAM_ID, agentId: 'lead' });

    assert.equal(adapter1.turns.length, 1, 'runtime-1 should get reinjection');
    assert.equal(adapter2.turns.length, 0, 'runtime-2 should not get reinjection');
  });

  it('compact_boundary writes a pending side-effect receipt when log is provided', () => {
    const sideEffectLog = createMockSideEffectLog();
    const handlerWithLog = new CompactionHandler({ adapters, taskBoard, sideEffectLog });

    handlerWithLog.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
      sessionId: 'session-7',
    });

    const records = [...sideEffectLog.records.values()];
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'compaction_reinjection');
    assert.equal(records[0].runtimeId, RUNTIME_ID);
    assert.equal(records[0].status, 'pending');
    assert.match(records[0].idempotencyKey, /^compaction-reinjection:runtime-lead-1:session-7$/);
  });

  it('turn_completed success marks the side-effect receipt delivered', async () => {
    const sideEffectLog = createMockSideEffectLog();
    const adapter = createMockAdapter();
    adapters.set(RUNTIME_ID, adapter);
    const handlerWithLog = new CompactionHandler({ adapters, taskBoard, sideEffectLog });

    handlerWithLog.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
      sessionId: 'session-7',
    });
    await handlerWithLog.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    const record = sideEffectLog.get('compaction-reinjection:runtime-lead-1:session-7');
    assert.equal(record.status, 'delivered');
    assert.ok(record.deliveredAt);
    assert.equal(adapter.turns.length, 1);
  });

  it('sendTurn rejection marks the side-effect receipt failed', async () => {
    const sideEffectLog = createMockSideEffectLog();
    const adapter = createRejectingAdapter();
    adapters.set(RUNTIME_ID, adapter);
    const handlerWithLog = new CompactionHandler({ adapters, taskBoard, sideEffectLog });

    handlerWithLog.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
      sessionId: 'session-7',
    });
    await handlerWithLog.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    const record = sideEffectLog.get('compaction-reinjection:runtime-lead-1:session-7');
    assert.equal(record.status, 'failed');
    assert.ok(!handlerWithLog.isPending(RUNTIME_ID), 'strict drop — does not re-arm after failure');
  });

  it('turn_failed marks the side-effect receipt failed', () => {
    const sideEffectLog = createMockSideEffectLog();
    const handlerWithLog = new CompactionHandler({ adapters, taskBoard, sideEffectLog });

    handlerWithLog.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
      sessionId: 'session-7',
    });
    handlerWithLog.onTurnFailed({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    const record = sideEffectLog.get('compaction-reinjection:runtime-lead-1:session-7');
    assert.equal(record.status, 'failed');
    assert.ok(!handlerWithLog.isPending(RUNTIME_ID));
  });

  it('reinjection prompt works when task board is unavailable', async () => {
    const adapter = createMockAdapter();
    adapters.set(RUNTIME_ID, adapter);

    // Handler without taskBoard
    const handlerNoTasks = new CompactionHandler({ adapters, taskBoard: null });

    handlerNoTasks.onCompactBoundary({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    await handlerNoTasks.onTurnCompleted({
      runtimeId: RUNTIME_ID,
      teamId: TEAM_ID,
      agentId: AGENT_ID,
    });

    assert.equal(adapter.turns.length, 1);
    const text = adapter.turns[0].message.text;
    assert.ok(text.includes('context was compacted'));
  });
});
