import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';
import { ClaudeStreamJsonAdapter } from '../src/runtime/ClaudeStreamJsonAdapter.js';

class CaptureWritable extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk).toString('utf8'));
    callback();
  }
}

function createFakeChild({ writable = true } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = writable ? new CaptureWritable() : new PassThrough();
  if (!writable) {
    child.stdin.destroy();
  }
  return child;
}

test('ClaudeStreamJsonAdapter writes stream-json user turns to stdin', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });

  const result = await adapter.sendTurn({
    message: {
      messageId: 'msg-1',
      text: 'Coordinate the team.',
      metadata: {},
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.responseState, 'accepted_by_runtime');
  assert.equal(child.stdin.chunks.length, 1);
  const payload = JSON.parse(child.stdin.chunks[0]);
  assert.equal(payload.type, 'user');
  assert.equal(payload.message.role, 'user');
  assert.deepEqual(payload.message.content, [{ type: 'text', text: 'Coordinate the team.' }]);
});

test('ClaudeStreamJsonAdapter rejects sendTurn when stdin is not writable', async () => {
  const child = createFakeChild({ writable: false });
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });

  await assert.rejects(
    () =>
      adapter.sendTurn({
        message: { messageId: 'msg-1', text: 'Coordinate the team.', metadata: {} },
      }),
    /stdin is not writable/
  );
});

test('ClaudeStreamJsonAdapter writes stream-json tool results to stdin', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });

  const result = await adapter.sendToolResult({
    toolUseId: 'tool-1',
    result: { ok: true, messageId: 'msg-1' },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.responseState, 'tool_result_returned');
  const payload = JSON.parse(child.stdin.chunks[0]);
  assert.equal(payload.type, 'user');
  assert.equal(payload.message.role, 'user');
  assert.equal(payload.message.content[0].type, 'tool_result');
  assert.equal(payload.message.content[0].tool_use_id, 'tool-1');
  assert.deepEqual(JSON.parse(payload.message.content[0].content), { ok: true, messageId: 'msg-1' });
});

test('ClaudeStreamJsonAdapter writes approved control responses to stdin', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });

  const result = await adapter.approve({
    approvalId: 'approval-1',
    decision: 'approved',
  });

  assert.equal(result.accepted, true);
  assert.equal(result.responseState, 'approval_response_returned');
  const payload = JSON.parse(child.stdin.chunks[0]);
  assert.deepEqual(payload, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'approval-1',
      response: { behavior: 'allow', updatedInput: {} },
    },
  });
});

test('ClaudeStreamJsonAdapter writes denied control responses to stdin', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });

  await adapter.approve({
    approvalId: 'approval-1',
    decision: 'denied',
    reason: 'No writes.',
  });

  const payload = JSON.parse(child.stdin.chunks[0]);
  assert.deepEqual(payload, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'approval-1',
      response: { behavior: 'deny', message: 'No writes.' },
    },
  });
});

test('ClaudeStreamJsonAdapter rejects sendToolResult when stdin is not writable', async () => {
  const child = createFakeChild({ writable: false });
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });

  await assert.rejects(
    () => adapter.sendToolResult({ toolUseId: 'tool-1', result: { ok: true } }),
    /stdin is not writable/
  );
});

async function readNext(asyncIterator) {
  const result = await asyncIterator.next();
  assert.equal(result.done, false);
  return result.value;
}

test('ClaudeStreamJsonAdapter normalizes assistant and result stdout events', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });
  const iterator = adapter.events()[Symbol.asyncIterator]();

  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Working on it.' },
          { type: 'tool_use', name: 'message_send', id: 'tool-1' },
        ],
      },
      session_id: 'session-1',
    }) + '\n'
  );
  child.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
    }) + '\n'
  );

  const assistant = await readNext(iterator);
  const toolUse = await readNext(iterator);
  const result = await readNext(iterator);

  assert.equal(assistant.type, 'assistant_text');
  assert.equal(assistant.text, 'Working on it.');
  assert.equal(assistant.sessionId, 'session-1');
  assert.equal(toolUse.type, 'tool_use');
  assert.equal(toolUse.toolName, 'message_send');
  assert.equal(result.type, 'turn_completed');
  assert.equal(result.sessionId, 'session-1');
});

test('ClaudeStreamJsonAdapter emits parse_error events for malformed stdout lines', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });
  const iterator = adapter.events()[Symbol.asyncIterator]();

  child.stdout.write('{bad json}\n');

  const event = await readNext(iterator);
  assert.equal(event.type, 'parse_error');
  assert.match(event.error, /JSON/);
});

test('ClaudeStreamJsonAdapter normalizes assistant tool_use events', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });
  const iterator = adapter.events()[Symbol.asyncIterator]();

  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'message_send',
            input: {
              to: { kind: 'agent', agentId: 'worker-1' },
              text: 'Start storage.',
            },
          },
        ],
      },
      session_id: 'session-1',
    }) + '\n'
  );

  const event = await readNext(iterator);

  assert.equal(event.type, 'tool_use');
  assert.equal(event.toolUseId, 'tool-1');
  assert.equal(event.toolName, 'message_send');
  assert.deepEqual(event.input.to, { kind: 'agent', agentId: 'worker-1' });
  assert.equal(event.sessionId, 'session-1');
});

test('ClaudeStreamJsonAdapter normalizes can_use_tool control_request events as approval requests', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });
  const iterator = adapter.events()[Symbol.asyncIterator]();

  child.stdout.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'approval-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        input: {
          file_path: 'README.md',
        },
      },
      session_id: 'session-1',
    }) + '\n'
  );

  const event = await readNext(iterator);

  assert.equal(event.type, 'approval_request');
  assert.equal(event.approvalId, 'approval-1');
  assert.equal(event.toolName, 'Write');
  assert.deepEqual(event.input, { file_path: 'README.md' });
  assert.equal(event.prompt, 'Approve Write');
  assert.equal(event.runtimeId, 'claude-lead-1');
  assert.equal(event.teamId, 'team-a');
  assert.equal(event.agentId, 'lead');
  assert.equal(event.sessionId, 'session-1');
});

test('DeliveryWorker can deliver through ClaudeStreamJsonAdapter', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });
  const worker = new DeliveryWorker({
    broker,
    runtimeDirectory: directory,
    adapters: new Map([['claude-lead-1', adapter]]),
  });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Ship the adapter.',
  });

  const result = await worker.deliverMessage(message.messageId);

  assert.equal(result.status, 'committed');
  assert.equal(result.responseState, 'accepted_by_runtime');
  assert.equal(JSON.parse(child.stdin.chunks[0]).message.content[0].text, 'Ship the adapter.');
});

test('ClaudeStreamJsonAdapter normalizes compact_boundary events with metadata', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });
  const iterator = adapter.events()[Symbol.asyncIterator]();

  child.stdout.write(
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 180000,
      },
      session_id: 'session-1',
    }) + '\n'
  );

  const event = await readNext(iterator);

  assert.equal(event.type, 'compact_boundary');
  assert.equal(event.runtimeId, 'claude-lead-1');
  assert.equal(event.teamId, 'team-a');
  assert.equal(event.sessionId, 'session-1');
  assert.equal(event.trigger, 'auto');
  assert.equal(event.preTokens, 180000);
});

test('ClaudeStreamJsonAdapter normalizes api_retry events with fields', async () => {
  const child = createFakeChild();
  const adapter = new ClaudeStreamJsonAdapter({
    runtimeId: 'claude-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    child,
  });
  const iterator = adapter.events()[Symbol.asyncIterator]();

  child.stdout.write(
    JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      error_status: 429,
      error: 'rate_limit',
      error_message: 'Rate limit exceeded',
      retry_delay_ms: 5000,
      session_id: 'session-1',
    }) + '\n'
  );

  const event = await readNext(iterator);

  assert.equal(event.type, 'api_retry');
  assert.equal(event.attempt, 2);
  assert.equal(event.maxRetries, 5);
  assert.equal(event.errorStatus, 429);
  assert.equal(event.error, 'rate_limit');
  assert.equal(event.errorMessage, 'Rate limit exceeded');
  assert.equal(event.retryDelayMs, 5000);
  assert.equal(event.runtimeId, 'claude-lead-1');
});

