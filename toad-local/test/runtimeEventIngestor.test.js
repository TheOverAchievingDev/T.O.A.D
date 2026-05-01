import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryApprovalBroker } from '../src/approval/inMemoryApprovalBroker.js';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { RuntimeEventIngestor } from '../src/runtime/RuntimeEventIngestor.js';

class MemoryEventLog {
  constructor() {
    this.events = [];
  }

  appendEvent(input) {
    const existing = this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (existing) return { inserted: false, event: existing };
    const event = { eventId: `event-${this.events.length + 1}`, ...input };
    this.events.push(event);
    return { inserted: true, event };
  }
}

function createMockSideEffectLog(seed = []) {
  const records = new Map();
  for (const record of seed) records.set(record.idempotencyKey, { ...record });
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

test('RuntimeEventIngestor appends assistant text as a broker reply', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog();
  const ingestor = new RuntimeEventIngestor({ broker, eventLog });

  const result = await ingestor.ingest({
    type: 'assistant_text',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    sessionId: 'session-1',
    text: 'Working on it.',
  });

  assert.equal(result.message.inserted, true);
  assert.equal(eventLog.events.length, 1);
  const inbox = broker.listInbox({ teamId: 'team-a', recipient: { kind: 'user' } });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, 'reply');
  assert.equal(inbox[0].from.id, 'lead');
  assert.equal(inbox[0].text, 'Working on it.');
  assert.equal(inbox[0].metadata.runtimeId, 'runtime-lead-1');
});

test('RuntimeEventIngestor records non-message events as audit only', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog();
  const ingestor = new RuntimeEventIngestor({ broker, eventLog });

  const result = await ingestor.ingest({
    type: 'turn_completed',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    sessionId: 'session-1',
  });

  assert.equal(result.message, null);
  assert.equal(eventLog.events[0].eventType, 'turn_completed');
  assert.equal(broker.listInbox({ teamId: 'team-a', recipient: { kind: 'user' } }).length, 0);
});

test('RuntimeEventIngestor persists approval_request events through approval broker', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog();
  const approvalBroker = new InMemoryApprovalBroker();
  const ingestor = new RuntimeEventIngestor({ broker, eventLog, approvalBroker });

  const result = await ingestor.ingest({
    type: 'approval_request',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    sessionId: 'session-1',
    approvalId: 'approval-1',
    prompt: 'Approve Write',
    toolName: 'Write',
    input: {
      file_path: 'README.md',
    },
    createdAt: '2026-04-30T00:00:00.000Z',
  });

  assert.equal(result.message, null);
  assert.equal(result.tool, null);
  assert.equal(result.approval.approvalId, 'approval-1');
  assert.equal(result.approval.status, 'pending');
  assert.equal(eventLog.events[0].eventType, 'approval_request');

  const approvals = approvalBroker.listApprovals({ teamId: 'team-a' });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].teamId, 'team-a');
  assert.equal(approvals[0].agentId, 'lead');
  assert.equal(approvals[0].runtimeId, 'runtime-lead-1');
  assert.equal(approvals[0].prompt, 'Approve Write');
  assert.equal(approvals[0].requestedAt, '2026-04-30T00:00:00.000Z');
  assert.deepEqual(approvals[0].metadata, {
    sessionId: 'session-1',
    runtimeEventType: 'approval_request',
    toolName: 'Write',
    input: { file_path: 'README.md' },
  });
});

async function* events() {
  yield {
    type: 'assistant_text',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    text: 'First reply.',
  };
  yield {
    type: 'parse_error',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    error: 'Unexpected token',
  };
}

test('RuntimeEventIngestor consumes async runtime event streams', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog();
  const ingestor = new RuntimeEventIngestor({ broker, eventLog });

  const result = await ingestor.ingestFrom(events());

  assert.equal(result.events, 2);
  assert.equal(result.messages, 1);
  assert.equal(eventLog.events.length, 2);
});

test('RuntimeEventIngestor dispatches allowlisted tool_use events through tool facade', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog();
  const calls = [];
  const toolFacade = {
    execute(command) {
      calls.push(command);
      return { ok: true, commandName: command.commandName };
    },
  };
  const ingestor = new RuntimeEventIngestor({ broker, eventLog, toolFacade });

  const result = await ingestor.ingest({
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    sessionId: 'session-1',
    toolUseId: 'tool-1',
    toolName: 'message_send',
    input: {
      to: { kind: 'agent', agentId: 'worker-1' },
      text: 'Start storage.',
    },
  });

  assert.equal(eventLog.events[0].eventType, 'tool_use');
  assert.equal(result.tool.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].commandName, 'message_send');
  assert.equal(calls[0].actor.teamId, 'team-a');
  assert.equal(calls[0].actor.agentId, 'lead');
  assert.equal(calls[0].args.text, 'Start storage.');
  assert.match(calls[0].idempotencyKey, /^runtime-tool:sha256:/);
});

test('RuntimeEventIngestor reuses tool idempotency keys for duplicate tool_use events', async () => {
  const broker = new InMemoryBroker();
  const calls = [];
  const ingestor = new RuntimeEventIngestor({
    broker,
    toolFacade: {
      execute(command) {
        calls.push(command);
        return { ok: true };
      },
    },
  });
  const event = {
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    toolUseId: 'tool-1',
    toolName: 'message_send',
    input: { to: { kind: 'user' }, text: 'Same event.' },
    createdAt: '2026-04-29T00:00:00.000Z',
  };

  await ingestor.ingest(event);
  await ingestor.ingest(event);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
});

test('RuntimeEventIngestor leaves unsupported tool_use events as audit only', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog();
  let calls = 0;
  const ingestor = new RuntimeEventIngestor({
    broker,
    eventLog,
    toolFacade: {
      execute() {
        calls += 1;
      },
    },
  });

  const result = await ingestor.ingest({
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    toolUseId: 'tool-2',
    toolName: 'shell_exec',
    input: { command: 'whoami' },
  });

  assert.equal(result.tool, null);
  assert.equal(calls, 0);
  assert.equal(eventLog.events.length, 1);
});

test('RuntimeEventIngestor returns successful tool results to runtime adapters', async () => {
  const broker = new InMemoryBroker();
  const sentToolResults = [];
  const adapters = new Map([
    [
      'runtime-lead-1',
      {
        async sendToolResult(input) {
          sentToolResults.push(input);
          return { accepted: true, responseState: 'tool_result_returned' };
        },
      },
    ],
  ]);
  const ingestor = new RuntimeEventIngestor({
    broker,
    adapters,
    toolFacade: {
      execute() {
        return { ok: true, messageId: 'msg-1' };
      },
    },
  });

  const result = await ingestor.ingest({
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    toolUseId: 'tool-1',
    toolName: 'message_send',
    input: { to: { kind: 'user' }, text: 'Tool reply.' },
  });

  assert.deepEqual(result.tool, { ok: true, messageId: 'msg-1' });
  assert.equal(result.toolResult.accepted, true);
  assert.equal(sentToolResults.length, 1);
  assert.equal(sentToolResults[0].toolUseId, 'tool-1');
  assert.deepEqual(sentToolResults[0].result, { ok: true, messageId: 'msg-1' });
  assert.equal(sentToolResults[0].error, null);
});

test('RuntimeEventIngestor returns tool execution errors to runtime adapters', async () => {
  const broker = new InMemoryBroker();
  const sentToolResults = [];
  const adapters = new Map([
    [
      'runtime-lead-1',
      {
        async sendToolResult(input) {
          sentToolResults.push(input);
          return { accepted: true, responseState: 'tool_result_returned' };
        },
      },
    ],
  ]);
  const ingestor = new RuntimeEventIngestor({
    broker,
    adapters,
    toolFacade: {
      execute() {
        throw new Error('tool exploded');
      },
    },
  });

  const result = await ingestor.ingest({
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    toolUseId: 'tool-1',
    toolName: 'message_send',
    input: { to: { kind: 'user' }, text: 'Tool reply.' },
  });

  assert.equal(result.tool, null);
  assert.equal(result.toolError, 'tool exploded');
  assert.equal(result.toolResult.accepted, true);
  assert.equal(sentToolResults.length, 1);
  assert.equal(sentToolResults[0].toolUseId, 'tool-1');
  assert.equal(sentToolResults[0].result, null);
  assert.equal(sentToolResults[0].error, 'tool exploded');
});

test('RuntimeEventIngestor rejects assistant messages from mismatched runtime identity', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new MemoryEventLog();
  const runtimeRegistry = {
    getRuntime(runtimeId) {
      assert.equal(runtimeId, 'runtime-lead-1');
      return {
        runtimeId,
        teamId: 'team-a',
        agentId: 'lead',
        status: 'running',
      };
    },
  };
  const ingestor = new RuntimeEventIngestor({ broker, eventLog, runtimeRegistry });

  await assert.rejects(
    () =>
      ingestor.ingest({
        type: 'assistant_text',
        runtimeId: 'runtime-lead-1',
        teamId: 'team-a',
        agentId: 'impostor',
        text: 'spoofed',
      }),
    /runtime identity mismatch/
  );
  assert.equal(broker.listMessages({ teamId: 'team-a' }).length, 0);
  assert.equal(eventLog.events.length, 1);
});

test('RuntimeEventIngestor records a delivered side-effect receipt for tool_use results', async () => {
  const broker = new InMemoryBroker();
  const sideEffectLog = createMockSideEffectLog();
  const adapters = new Map([
    [
      'runtime-lead-1',
      {
        async sendToolResult() {
          return { accepted: true, responseState: 'tool_result_returned' };
        },
      },
    ],
  ]);
  const ingestor = new RuntimeEventIngestor({
    broker,
    adapters,
    sideEffectLog,
    toolFacade: {
      execute() {
        return { ok: true };
      },
    },
  });

  await ingestor.ingest({
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    toolUseId: 'tool-1',
    toolName: 'message_send',
    input: { to: { kind: 'user' }, text: 'Tool reply.' },
  });

  const records = [...sideEffectLog.records.values()];
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'tool_result');
  assert.equal(records[0].runtimeId, 'runtime-lead-1');
  assert.equal(records[0].status, 'delivered');
  assert.match(records[0].idempotencyKey, /^tool-result:sha256:/);
});

test('RuntimeEventIngestor skips adapter delivery when receipt already shows delivered', async () => {
  const broker = new InMemoryBroker();
  const sentToolResults = [];
  const adapters = new Map([
    [
      'runtime-lead-1',
      {
        async sendToolResult(input) {
          sentToolResults.push(input);
          return { accepted: true, responseState: 'tool_result_returned' };
        },
      },
    ],
  ]);
  // Run once normally to populate the receipt
  const sideEffectLog = createMockSideEffectLog();
  const ingestor = new RuntimeEventIngestor({
    broker,
    adapters,
    sideEffectLog,
    toolFacade: {
      execute() {
        return { ok: true };
      },
    },
  });
  const event = {
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    toolUseId: 'tool-1',
    toolName: 'message_send',
    input: { to: { kind: 'user' }, text: 'Same payload.' },
    createdAt: '2026-04-30T00:00:00.000Z',
  };

  const first = await ingestor.ingest(event);
  const second = await ingestor.ingest(event);

  assert.equal(sentToolResults.length, 1, 'second ingest must not call adapter again');
  assert.ok(first.toolResult);
  assert.equal(second.toolResult, null, 'duplicate delivery returns null receipt');
});

test('RuntimeEventIngestor marks receipt failed and rethrows when adapter rejects', async () => {
  const broker = new InMemoryBroker();
  const sideEffectLog = createMockSideEffectLog();
  const adapters = new Map([
    [
      'runtime-lead-1',
      {
        async sendToolResult() {
          throw new Error('adapter rejected');
        },
      },
    ],
  ]);
  const ingestor = new RuntimeEventIngestor({
    broker,
    adapters,
    sideEffectLog,
    toolFacade: {
      execute() {
        return { ok: true };
      },
    },
  });

  await assert.rejects(
    () =>
      ingestor.ingest({
        type: 'tool_use',
        runtimeId: 'runtime-lead-1',
        teamId: 'team-a',
        agentId: 'lead',
        toolUseId: 'tool-1',
        toolName: 'message_send',
        input: { to: { kind: 'user' }, text: 'Tool reply.' },
      }),
    /adapter rejected/
  );

  const records = [...sideEffectLog.records.values()];
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'failed');
});

test('RuntimeEventIngestor rejects tool dispatch from stopped runtimes', async () => {
  const broker = new InMemoryBroker();
  const calls = [];
  const runtimeRegistry = {
    getRuntime(runtimeId) {
      assert.equal(runtimeId, 'runtime-lead-1');
      return {
        runtimeId,
        teamId: 'team-a',
        agentId: 'lead',
        status: 'stopped',
      };
    },
  };
  const ingestor = new RuntimeEventIngestor({
    broker,
    runtimeRegistry,
    toolFacade: {
      execute(command) {
        calls.push(command);
        return { ok: true };
      },
    },
  });

  await assert.rejects(
    () =>
      ingestor.ingest({
        type: 'tool_use',
        runtimeId: 'runtime-lead-1',
        teamId: 'team-a',
        agentId: 'lead',
        toolUseId: 'tool-1',
        toolName: 'task_create',
        input: { taskId: 'task-1', subject: 'Do not create' },
      }),
    /runtime is not running/
  );
  assert.equal(calls.length, 0);
});
