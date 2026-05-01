# Broker Runtime Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first broker-backed delivery worker so TOAD can route durable messages to runtime adapters while journaling delivery attempts.

**Architecture:** The broker remains the source of truth for messages and delivery attempts. A small delivery worker resolves each recipient to a delivery mode, calls the relevant runtime adapter or queue projection, and commits or fails a delivery attempt with response-state metadata. This slice uses fake adapters in tests; no real Claude/OpenCode process launch is included.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, `node:sqlite`, existing `toad-local` broker/task modules.

---

## File Structure

- Modify `C:\Project-TOAD\toad-local\src\storage\schema.sql`
  - Add delivery idempotency, payload hash, delivery kind, and response-state columns.
- Modify `C:\Project-TOAD\toad-local\src\broker\inMemoryBroker.js`
  - Add idempotent `beginDeliveryAttempt()` behavior and attempt listing.
- Modify `C:\Project-TOAD\toad-local\src\broker\sqliteBroker.js`
  - Mirror in-memory delivery semantics in SQLite.
- Create `C:\Project-TOAD\toad-local\src\delivery\runtimeDirectory.js`
  - Resolve recipient addresses into delivery destinations.
- Create `C:\Project-TOAD\toad-local\src\delivery\deliveryWorker.js`
  - Deliver one message through `runtime_stdin`, `runtime_bridge`, `pollable_inbox`, or `offline_queue`.
- Create `C:\Project-TOAD\toad-local\test\deliveryWorker.test.js`
  - Cover successful runtime delivery, queue-only delivery, idempotency, and failure.
- Modify `C:\Project-TOAD\toad-local\test\broker.test.js`
  - Add in-memory delivery idempotency/conflict coverage.
- Modify `C:\Project-TOAD\toad-local\test\sqliteBroker.test.js`
  - Add SQLite delivery idempotency/conflict coverage.
- Modify `C:\Project-TOAD\toad-local\package.json`
  - Add `test/deliveryWorker.test.js` to the test script.

---

### Task 1: Broker Delivery Attempt Semantics

**Files:**
- Modify: `C:\Project-TOAD\toad-local\src\broker\inMemoryBroker.js`
- Modify: `C:\Project-TOAD\toad-local\src\broker\sqliteBroker.js`
- Modify: `C:\Project-TOAD\toad-local\src\storage\schema.sql`
- Modify: `C:\Project-TOAD\toad-local\test\broker.test.js`
- Modify: `C:\Project-TOAD\toad-local\test\sqliteBroker.test.js`

- [ ] **Step 1: Write failing in-memory broker tests**

Append to `C:\Project-TOAD\toad-local\test\broker.test.js`:

```js
test('delivery attempts are idempotent by idempotency key and payload hash', () => {
  const broker = new InMemoryBroker();
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Coordinate delivery.',
  });

  const first = broker.beginDeliveryAttempt({
    messageId: message.messageId,
    runtimeId: 'claude-lead-1',
    destination: { kind: 'runtime_stdin', agentId: 'lead' },
    idempotencyKey: 'deliver-lead-once',
    payloadHash: 'sha256:abc',
    deliveryKind: 'runtime_stdin',
  });
  const second = broker.beginDeliveryAttempt({
    messageId: message.messageId,
    runtimeId: 'claude-lead-1',
    destination: { kind: 'runtime_stdin', agentId: 'lead' },
    idempotencyKey: 'deliver-lead-once',
    payloadHash: 'sha256:abc',
    deliveryKind: 'runtime_stdin',
  });

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.attempt.attemptId, first.attempt.attemptId);
});

test('delivery attempt idempotency rejects payload conflicts', () => {
  const broker = new InMemoryBroker();
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Coordinate delivery.',
  });

  broker.beginDeliveryAttempt({
    messageId: message.messageId,
    runtimeId: 'claude-lead-1',
    destination: { kind: 'runtime_stdin', agentId: 'lead' },
    idempotencyKey: 'deliver-lead-once',
    payloadHash: 'sha256:abc',
    deliveryKind: 'runtime_stdin',
  });

  assert.throws(
    () =>
      broker.beginDeliveryAttempt({
        messageId: message.messageId,
        runtimeId: 'claude-lead-1',
        destination: { kind: 'runtime_stdin', agentId: 'lead' },
        idempotencyKey: 'deliver-lead-once',
        payloadHash: 'sha256:different',
        deliveryKind: 'runtime_stdin',
      }),
    /delivery idempotency conflict/
  );
});
```

- [ ] **Step 2: Write failing SQLite broker tests**

Append equivalent tests to `C:\Project-TOAD\toad-local\test\sqliteBroker.test.js` inside `withBroker()` wrappers:

```js
test('SqliteBroker delivery attempts are idempotent by key and payload hash', () => {
  withBroker((broker) => {
    const { message } = broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
      text: 'Coordinate delivery.',
    });

    const first = broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: 'claude-lead-1',
      destination: { kind: 'runtime_stdin', agentId: 'lead' },
      idempotencyKey: 'deliver-lead-once',
      payloadHash: 'sha256:abc',
      deliveryKind: 'runtime_stdin',
    });
    const second = broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: 'claude-lead-1',
      destination: { kind: 'runtime_stdin', agentId: 'lead' },
      idempotencyKey: 'deliver-lead-once',
      payloadHash: 'sha256:abc',
      deliveryKind: 'runtime_stdin',
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.attempt.attemptId, first.attempt.attemptId);
  });
});

test('SqliteBroker delivery attempt idempotency rejects payload conflicts', () => {
  withBroker((broker) => {
    const { message } = broker.appendMessage({
      teamId: 'team-a',
      from: { kind: 'user', id: 'user' },
      to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
      text: 'Coordinate delivery.',
    });

    broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: 'claude-lead-1',
      destination: { kind: 'runtime_stdin', agentId: 'lead' },
      idempotencyKey: 'deliver-lead-once',
      payloadHash: 'sha256:abc',
      deliveryKind: 'runtime_stdin',
    });

    assert.throws(
      () =>
        broker.beginDeliveryAttempt({
          messageId: message.messageId,
          runtimeId: 'claude-lead-1',
          destination: { kind: 'runtime_stdin', agentId: 'lead' },
          idempotencyKey: 'deliver-lead-once',
          payloadHash: 'sha256:different',
          deliveryKind: 'runtime_stdin',
        }),
      /delivery idempotency conflict/
    );
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```powershell
npm.cmd test
```

Expected: failure because `beginDeliveryAttempt()` currently returns an attempt directly and does not support `idempotencyKey`, `payloadHash`, `deliveryKind`, or `inserted`.

- [ ] **Step 4: Extend schema**

Modify `delivery_attempts` in `C:\Project-TOAD\toad-local\src\storage\schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS delivery_attempts (
  attempt_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  payload_hash TEXT,
  message_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  delivery_kind TEXT NOT NULL DEFAULT 'unknown',
  destination_json TEXT NOT NULL,
  status TEXT NOT NULL,
  response_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  receipt_json TEXT,
  error TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);
```

- [ ] **Step 5: Implement in-memory broker support**

Update `beginDeliveryAttempt()` in `C:\Project-TOAD\toad-local\src\broker\inMemoryBroker.js` so it returns `{ inserted, attempt }`, checks existing delivery idempotency keys, and rejects payload hash conflicts.

```js
  beginDeliveryAttempt({
    messageId,
    runtimeId,
    destination,
    idempotencyKey = null,
    payloadHash = null,
    deliveryKind = 'unknown',
    responseState = null,
  }) {
    if (!this.#messages.has(messageId)) {
      throw new Error(`unknown message: ${messageId}`);
    }
    if (idempotencyKey) {
      const existing = [...this.#deliveryAttempts.values()].find(
        (attempt) => attempt.idempotencyKey === idempotencyKey
      );
      if (existing) {
        if (existing.payloadHash && payloadHash && existing.payloadHash !== payloadHash) {
          throw new Error(`delivery idempotency conflict: ${idempotencyKey}`);
        }
        return { inserted: false, attempt: existing };
      }
    }
    const attempt = {
      attemptId: randomUUID(),
      idempotencyKey,
      payloadHash,
      messageId,
      runtimeId,
      deliveryKind,
      destination,
      status: 'pending',
      responseState,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      receipt: null,
      error: null,
    };
    this.#deliveryAttempts.set(attempt.attemptId, attempt);
    return { inserted: true, attempt };
  }
```

Update `commitDeliveryAttempt()` and `failDeliveryAttempt()` to accept either the new return shape from callers or the raw attempt ID. Keep the public call signature `{ attemptId, ... }`.

- [ ] **Step 6: Implement SQLite broker support**

Update `C:\Project-TOAD\toad-local\src\broker\sqliteBroker.js`:

```js
  beginDeliveryAttempt({
    messageId,
    runtimeId,
    destination,
    idempotencyKey = null,
    payloadHash = null,
    deliveryKind = 'unknown',
    responseState = null,
  }) {
    if (!this.getMessage(messageId)) {
      throw new Error(`unknown message: ${messageId}`);
    }
    if (idempotencyKey) {
      const existing = this.#getDeliveryAttemptByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.payloadHash && payloadHash && existing.payloadHash !== payloadHash) {
          throw new Error(`delivery idempotency conflict: ${idempotencyKey}`);
        }
        return { inserted: false, attempt: existing };
      }
    }

    const now = new Date().toISOString();
    const attempt = {
      attemptId: randomUUID(),
      idempotencyKey,
      payloadHash,
      messageId,
      runtimeId,
      deliveryKind,
      destination,
      status: 'pending',
      responseState,
      createdAt: now,
      updatedAt: now,
      receipt: null,
      error: null,
    };
    this.db.prepare(
      `
        INSERT INTO delivery_attempts (
          attempt_id,
          idempotency_key,
          payload_hash,
          message_id,
          runtime_id,
          delivery_kind,
          destination_json,
          status,
          response_state,
          created_at,
          updated_at,
          receipt_json,
          error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      attempt.attemptId,
      attempt.idempotencyKey,
      attempt.payloadHash,
      attempt.messageId,
      attempt.runtimeId,
      attempt.deliveryKind,
      jsonStringify(attempt.destination),
      attempt.status,
      attempt.responseState,
      attempt.createdAt,
      attempt.updatedAt,
      null,
      null
    );
    return { inserted: true, attempt };
  }
```

Add private helper:

```js
  #getDeliveryAttemptByIdempotencyKey(idempotencyKey) {
    const row = this.db
      .prepare('SELECT * FROM delivery_attempts WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? this.#rowToDeliveryAttempt(row) : null;
  }
```

Update the row mapper to include `idempotencyKey`, `payloadHash`, `deliveryKind`, and `responseState`.

- [ ] **Step 7: Run broker tests**

Run:

```powershell
npm.cmd test
```

Expected: all existing and new broker tests pass.

Because this workspace has no `.git` metadata, skip the commit step and note the changed files in the final checkpoint.

---

### Task 2: Runtime Directory

**Files:**
- Create: `C:\Project-TOAD\toad-local\src\delivery\runtimeDirectory.js`
- Create: `C:\Project-TOAD\toad-local\test\deliveryWorker.test.js`

- [ ] **Step 1: Write failing runtime directory tests**

Create `C:\Project-TOAD\toad-local\test\deliveryWorker.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';

test('RuntimeDirectory resolves an agent destination', () => {
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });

  const destination = directory.resolve({
    kind: 'agent',
    teamId: 'team-a',
    agentId: 'lead',
  });

  assert.equal(destination.runtimeId, 'claude-lead-1');
  assert.equal(destination.deliveryMode, 'runtime_stdin');
});

test('RuntimeDirectory falls back to offline queue for unknown agents', () => {
  const directory = new RuntimeDirectory();
  const destination = directory.resolve({
    kind: 'agent',
    teamId: 'team-a',
    agentId: 'worker-1',
  });

  assert.equal(destination.runtimeId, 'offline:team-a:worker-1');
  assert.equal(destination.deliveryMode, 'offline_queue');
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
node test/deliveryWorker.test.js
```

Expected: failure because `runtimeDirectory.js` does not exist.

- [ ] **Step 3: Implement RuntimeDirectory**

Create `C:\Project-TOAD\toad-local\src\delivery\runtimeDirectory.js`:

```js
const DELIVERY_MODES = new Set([
  'runtime_stdin',
  'runtime_bridge',
  'pollable_inbox',
  'offline_queue',
]);

export class RuntimeDirectory {
  #agents = new Map();

  registerAgent(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const deliveryMode = requireString(input.deliveryMode, 'deliveryMode');
    if (!DELIVERY_MODES.has(deliveryMode)) {
      throw new Error(`unsupported delivery mode: ${deliveryMode}`);
    }
    const key = buildAgentKey(teamId, agentId);
    this.#agents.set(key, {
      teamId,
      agentId,
      runtimeId,
      deliveryMode,
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
    });
  }

  resolve(recipient) {
    if (!recipient || typeof recipient !== 'object') {
      throw new TypeError('recipient is required');
    }
    if (recipient.kind === 'user' || recipient.kind === 'system') {
      return {
        runtimeId: `${recipient.kind}:local`,
        deliveryMode: 'pollable_inbox',
        destination: { kind: recipient.kind },
      };
    }
    if (recipient.kind === 'team') {
      const teamId = requireString(recipient.teamId, 'recipient.teamId');
      return {
        runtimeId: `team:${teamId}`,
        deliveryMode: 'pollable_inbox',
        destination: { kind: 'team', teamId },
      };
    }
    if (recipient.kind !== 'agent') {
      throw new Error(`unsupported recipient kind: ${recipient.kind}`);
    }
    const teamId = requireString(recipient.teamId, 'recipient.teamId');
    const agentId = requireString(recipient.agentId, 'recipient.agentId');
    const registered = this.#agents.get(buildAgentKey(teamId, agentId));
    if (registered) {
      return {
        runtimeId: registered.runtimeId,
        deliveryMode: registered.deliveryMode,
        destination: { kind: registered.deliveryMode, teamId, agentId },
        metadata: registered.metadata,
      };
    }
    return {
      runtimeId: `offline:${teamId}:${agentId}`,
      deliveryMode: 'offline_queue',
      destination: { kind: 'offline_queue', teamId, agentId },
    };
  }
}

function buildAgentKey(teamId, agentId) {
  return `${teamId}:${agentId}`;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
```

- [ ] **Step 4: Run runtime directory tests**

Run:

```powershell
node test/deliveryWorker.test.js
```

Expected: two tests pass.

---

### Task 3: Delivery Worker Runtime Success And Queue Delivery

**Files:**
- Create: `C:\Project-TOAD\toad-local\src\delivery\deliveryWorker.js`
- Modify: `C:\Project-TOAD\toad-local\test\deliveryWorker.test.js`

- [ ] **Step 1: Add failing delivery worker tests**

Append to `C:\Project-TOAD\toad-local\test\deliveryWorker.test.js`:

```js
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../src/delivery/deliveryWorker.js';

test('DeliveryWorker sends runtime_stdin messages through an adapter', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });
  const sentTurns = [];
  const adapters = new Map([
    [
      'claude-lead-1',
      {
        async sendTurn(turn) {
          sentTurns.push(turn);
          return {
            accepted: true,
            responseState: 'accepted_by_runtime',
            receipt: { written: true },
          };
        },
      },
    ],
  ]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    idempotencyKey: 'msg-user-lead',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Coordinate the team.',
  });

  const result = await worker.deliverMessage(message.messageId);

  assert.equal(result.status, 'committed');
  assert.equal(sentTurns.length, 1);
  assert.equal(sentTurns[0].message.messageId, message.messageId);
  assert.equal(sentTurns[0].message.text, 'Coordinate the team.');
});

test('DeliveryWorker commits pollable inbox delivery without an adapter call', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'worker-1',
    runtimeId: 'worker-queue-1',
    deliveryMode: 'pollable_inbox',
  });
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: new Map() });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'agent', id: 'lead' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
    text: 'Read from your broker inbox.',
  });

  const result = await worker.deliverMessage(message.messageId);

  assert.equal(result.status, 'committed');
  assert.equal(result.receipt.queued, true);
  assert.equal(result.receipt.deliveryMode, 'pollable_inbox');
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
node test/deliveryWorker.test.js
```

Expected: failure because `deliveryWorker.js` does not exist.

- [ ] **Step 3: Implement DeliveryWorker**

Create `C:\Project-TOAD\toad-local\src\delivery\deliveryWorker.js`:

```js
import { createHash } from 'node:crypto';

const RUNTIME_DELIVERY_MODES = new Set(['runtime_stdin', 'runtime_bridge']);

export class DeliveryWorker {
  constructor({ broker, runtimeDirectory, adapters }) {
    if (!broker) throw new TypeError('broker is required');
    if (!runtimeDirectory) throw new TypeError('runtimeDirectory is required');
    this.broker = broker;
    this.runtimeDirectory = runtimeDirectory;
    this.adapters = adapters || new Map();
  }

  async deliverMessage(messageId) {
    const message = this.broker.getMessage(messageId);
    if (!message) {
      throw new Error(`unknown message: ${messageId}`);
    }
    const resolved = this.runtimeDirectory.resolve(message.to);
    const payloadHash = hashDeliveryPayload({ message, resolved });
    const begin = this.broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: resolved.runtimeId,
      destination: resolved.destination,
      idempotencyKey: buildDeliveryIdempotencyKey(message, resolved),
      payloadHash,
      deliveryKind: resolved.deliveryMode,
    });
    if (!begin.inserted && begin.attempt.status === 'committed') {
      return begin.attempt;
    }

    try {
      if (RUNTIME_DELIVERY_MODES.has(resolved.deliveryMode)) {
        const adapter = this.adapters.get(resolved.runtimeId);
        if (!adapter || typeof adapter.sendTurn !== 'function') {
          throw new Error(`runtime adapter not registered: ${resolved.runtimeId}`);
        }
        const receipt = await adapter.sendTurn({
          runtimeId: resolved.runtimeId,
          deliveryMode: resolved.deliveryMode,
          destination: resolved.destination,
          message,
        });
        if (!receipt || receipt.accepted !== true) {
          throw new Error(receipt?.reason || 'runtime did not accept message');
        }
        return this.broker.commitDeliveryAttempt({
          attemptId: begin.attempt.attemptId,
          receipt: {
            deliveryMode: resolved.deliveryMode,
            responseState: receipt.responseState || 'accepted_by_runtime',
            ...(receipt.receipt && typeof receipt.receipt === 'object' ? receipt.receipt : {}),
          },
          responseState: receipt.responseState || 'accepted_by_runtime',
        });
      }

      return this.broker.commitDeliveryAttempt({
        attemptId: begin.attempt.attemptId,
        receipt: {
          queued: true,
          deliveryMode: resolved.deliveryMode,
          destination: resolved.destination,
        },
        responseState:
          resolved.deliveryMode === 'offline_queue' ? 'queued_offline' : 'queued_for_recipient',
      });
    } catch (error) {
      return this.broker.failDeliveryAttempt({
        attemptId: begin.attempt.attemptId,
        error,
        retryable: true,
        responseState: 'delivery_failed',
      });
    }
  }
}

export function buildDeliveryIdempotencyKey(message, resolved) {
  return [
    'delivery',
    message.messageId,
    resolved.runtimeId,
    resolved.deliveryMode,
  ].join(':');
}

export function hashDeliveryPayload(value) {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}

function stableJsonStringify(value) {
  return JSON.stringify(normalizeStableJson(value));
}

function normalizeStableJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeStableJson);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = normalizeStableJson(value[key]);
  }
  return output;
}
```

- [ ] **Step 4: Update broker commit/fail signatures for response state**

Update both brokers so these calls are accepted:

```js
commitDeliveryAttempt({ attemptId, receipt, responseState = null })
failDeliveryAttempt({ attemptId, error, retryable = true, responseState = null })
```

For commit, persist `responseState` on the attempt and include it in the returned attempt. For fail, persist `responseState` if provided.

- [ ] **Step 5: Run delivery worker tests**

Run:

```powershell
node test/deliveryWorker.test.js
```

Expected: all delivery worker tests pass.

---

### Task 4: Delivery Failure And Idempotent Replays

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\deliveryWorker.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\delivery\deliveryWorker.js`

- [ ] **Step 1: Add failing failure/replay tests**

Append:

```js
test('DeliveryWorker records retryable failure when adapter is missing', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: new Map() });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'This needs a runtime adapter.',
  });

  const result = await worker.deliverMessage(message.messageId);

  assert.equal(result.status, 'failed_retryable');
  assert.match(result.error, /runtime adapter not registered/);
  assert.equal(result.responseState, 'delivery_failed');
});

test('DeliveryWorker does not resend already committed attempts', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'claude-lead-1',
    deliveryMode: 'runtime_stdin',
  });
  let calls = 0;
  const adapters = new Map([
    [
      'claude-lead-1',
      {
        async sendTurn() {
          calls += 1;
          return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true } };
        },
      },
    ],
  ]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });
  const { message } = broker.appendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'user' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Deliver once.',
  });

  const first = await worker.deliverMessage(message.messageId);
  const second = await worker.deliverMessage(message.messageId);

  assert.equal(first.status, 'committed');
  assert.equal(second.status, 'committed');
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run test to verify behavior**

Run:

```powershell
node test/deliveryWorker.test.js
```

Expected: tests pass if Task 3 already handles committed replay; otherwise the replay test fails and guides the fix.

- [ ] **Step 3: Implement replay guard if needed**

Ensure this block exists near the start of `deliverMessage()` after `beginDeliveryAttempt()`:

```js
if (!begin.inserted && begin.attempt.status === 'committed') {
  return begin.attempt;
}
```

For non-committed existing attempts, the first slice may retry immediately by reusing the same attempt ID. Do not add backoff yet.

- [ ] **Step 4: Run all local tests**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

---

### Task 5: Test Script And Documentation Checkpoint

**Files:**
- Modify: `C:\Project-TOAD\toad-local\package.json`
- Modify: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

- [ ] **Step 1: Add delivery tests to package script**

Modify `C:\Project-TOAD\toad-local\package.json`:

```json
"test": "node test/broker.test.js && node test/taskBoard.test.js && node --no-warnings test/sqliteBroker.test.js && node --no-warnings test/sqliteTaskBoard.test.js && node test/localToolFacade.test.js && node test/deliveryWorker.test.js"
```

- [ ] **Step 2: Add implementation checkpoint to the staged plan**

Under `Local scaffold:` in `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`, add:

```markdown
- `toad-local/src/delivery/runtimeDirectory.js`
- `toad-local/src/delivery/deliveryWorker.js`
- `toad-local/test/deliveryWorker.test.js`
```

Under `Current verification:`, add:

```markdown
Broker runtime delivery worker tests cover runtime adapter delivery, pollable inbox queue commits, retryable adapter failures, and committed replay idempotency.
```

- [ ] **Step 3: Run final verification**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

Because this workspace has no `.git` metadata and the user asked to keep work local, skip commits and report the changed files directly.

---

## Self-Review Notes

- Stage 5 research maps directly to this plan: broker attempts, payload hashes, runtime delivery modes, response-state distinctions, and queue/runtime separation are covered.
- Real CLI process launch is intentionally out of scope for this slice. The next plan should implement a Claude-style stream-json adapter once this broker delivery worker exists.
- No subagent dispatch is required unless the user explicitly requests it; inline execution is compatible with the local-only workspace.
