# Claude Stream-Json Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude-style stream-json runtime adapter that can send broker messages to a live child process stdin and expose normalized stdout events.

**Architecture:** The adapter wraps an already-launched child-like object with `stdin`, `stdout`, and optional `stderr`; launch/provisioning remains out of scope. `sendTurn()` converts a TOAD message envelope into Claude Code stream-json user input, and `events()` yields normalized runtime events from newline-delimited stdout JSON. The delivery worker can use this adapter because it only requires an object with `sendTurn()`.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, `node:stream`, existing `RuntimeAdapter` base class.

---

## File Structure

- Create `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`
  - Owns stream-json stdin turn writing and stdout event normalization.
- Create `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
  - Tests send-turn payloads, non-writable stdin failures, event parsing, and delivery-worker integration.
- Modify `C:\Project-TOAD\toad-local\package.json`
  - Adds the adapter test to the local test script.
- Modify `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
  - Records the new adapter scaffold and verification coverage.

---

### Task 1: Adapter Send-Turn Contract

**Files:**
- Create: `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
- Create: `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`

- [x] **Step 1: Write failing send-turn tests**

Create `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js` with:

```js
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
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: failure because `ClaudeStreamJsonAdapter.js` does not exist.

- [x] **Step 3: Implement sendTurn**

Create `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`:

```js
import { RuntimeAdapter, RuntimeAdapterError } from './RuntimeAdapter.js';

export class ClaudeStreamJsonAdapter extends RuntimeAdapter {
  constructor({ runtimeId, teamId, agentId, child }) {
    super('claude');
    this.runtimeId = requireString(runtimeId, 'runtimeId');
    this.teamId = requireString(teamId, 'teamId');
    this.agentId = requireString(agentId, 'agentId');
    if (!child || typeof child !== 'object') {
      throw new TypeError('child is required');
    }
    this.child = child;
  }

  async sendTurn(input) {
    const text = requireString(input?.message?.text, 'message.text');
    const stdin = this.child.stdin;
    if (!stdin || stdin.writable === false || stdin.destroyed === true) {
      throw new RuntimeAdapterError('Claude stream-json stdin is not writable', {
        runtimeId: this.runtimeId,
      });
    }

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    });

    await new Promise((resolve, reject) => {
      stdin.write(`${payload}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    return {
      accepted: true,
      responseState: 'accepted_by_runtime',
      receipt: {
        written: true,
        runtimeId: this.runtimeId,
      },
    };
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
```

- [x] **Step 4: Run send-turn tests**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: the two send-turn tests pass.

---

### Task 2: Normalized Stream Events

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`

- [x] **Step 1: Add failing event parser tests**

Append:

```js
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
  const result = await readNext(iterator);

  assert.equal(assistant.type, 'assistant_text');
  assert.equal(assistant.text, 'Working on it.');
  assert.equal(assistant.sessionId, 'session-1');
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
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: failure because `events()` is not implemented or does not emit normalized events.

- [x] **Step 3: Implement stdout event normalization**

Add to `ClaudeStreamJsonAdapter`:

```js
  events() {
    const stdout = this.child.stdout;
    if (!stdout || typeof stdout.on !== 'function') {
      throw new RuntimeAdapterError('Claude stream-json stdout is not readable', {
        runtimeId: this.runtimeId,
      });
    }
    return createRuntimeEventIterable({
      stream: stdout,
      runtimeId: this.runtimeId,
      teamId: this.teamId,
      agentId: this.agentId,
    });
  }
```

Add helpers in the same file:

```js
function createRuntimeEventIterable({ stream, runtimeId, teamId, agentId }) {
  const queue = [];
  const waiters = [];
  let buffer = '';
  let ended = false;

  const push = (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  };

  stream.on('data', (chunk) => {
    buffer += Buffer.from(chunk).toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      push(normalizeStreamJsonLine(line, { runtimeId, teamId, agentId }));
    }
  });
  stream.on('end', () => {
    ended = true;
    while (waiters.length) {
      waiters.shift()({ value: undefined, done: true });
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function normalizeStreamJsonLine(line, context) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      type: 'parse_error',
      runtimeId: context.runtimeId,
      teamId: context.teamId,
      agentId: context.agentId,
      error: error instanceof Error ? error.message : String(error),
      raw: line,
    };
  }
  return normalizeStreamJsonEvent(parsed, context);
}

function normalizeStreamJsonEvent(parsed, context) {
  const base = {
    runtimeId: context.runtimeId,
    teamId: context.teamId,
    agentId: context.agentId,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    raw: parsed,
  };
  if (parsed.type === 'assistant') {
    const text = extractAssistantText(parsed);
    if (text) return { ...base, type: 'assistant_text', text };
    return { ...base, type: 'assistant_event' };
  }
  if (parsed.type === 'result' && parsed.subtype === 'success') {
    return { ...base, type: 'turn_completed' };
  }
  if (parsed.type === 'result' && parsed.subtype === 'error') {
    return {
      ...base,
      type: 'turn_failed',
      error: typeof parsed.error === 'string' ? parsed.error : 'Claude stream-json turn failed',
    };
  }
  if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
    return { ...base, type: 'compact_boundary' };
  }
  return { ...base, type: 'runtime_event' };
}

function extractAssistantText(parsed) {
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('');
}
```

- [x] **Step 4: Run adapter tests**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: all adapter tests pass.

---

### Task 3: Delivery Worker Integration

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`

- [x] **Step 1: Add delivery-worker integration test**

Append:

```js
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
```

- [x] **Step 2: Run integration test**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: all adapter tests pass.

---

### Task 4: Package Script And Research Plan Checkpoint

**Files:**
- Modify: `C:\Project-TOAD\toad-local\package.json`
- Modify: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

- [x] **Step 1: Add adapter test to package script**

Modify `package.json` test script so it ends with:

```json
"... && node test/deliveryWorker.test.js && node test/claudeStreamJsonAdapter.test.js"
```

- [x] **Step 2: Update staged plan scaffold**

Under `Local scaffold:` add:

```markdown
- `toad-local/src/runtime/ClaudeStreamJsonAdapter.js`
- `toad-local/test/claudeStreamJsonAdapter.test.js`
```

Under `Current verification:`, append:

```markdown
Claude stream-json adapter tests cover stdin turn serialization, non-writable stdin failures, assistant/result event normalization, malformed stdout handling, and delivery-worker integration.
```

- [x] **Step 3: Run final verification**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

Because this workspace has no `.git` metadata and the user asked to keep work local, skip commits and report changed files.

---

## Self-Review Notes

- This plan implements the next work-queue item without launching a real Claude process.
- The adapter's `launch()`, `stop()`, `approve()`, and `health()` methods remain inherited abstract errors; they should be implemented in a later process-supervisor slice.
- The event parser intentionally normalizes only the stream-json events needed for delivery/progress proof: assistant text, result success/error, compact boundary, unknown runtime events, and parse errors.
