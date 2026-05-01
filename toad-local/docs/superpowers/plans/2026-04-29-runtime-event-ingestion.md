# Runtime Event Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist normalized runtime events and promote assistant text events into broker messages.

**Architecture:** Add a focused `SqliteRuntimeEventLog` for immutable runtime-event audit rows, and a `RuntimeEventIngestor` that accepts normalized adapter events. The ingestor records every event in the log when one is configured, appends `assistant_text` as a broker `reply` message, and leaves `turn_completed`, `turn_failed`, `parse_error`, and unknown runtime events as audit-only records.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, `node:sqlite`, existing broker APIs, existing `openToadDatabase()`.

---

## File Structure

- Modify `C:\Project-TOAD\toad-local\src\storage\schema.sql`
  - Add `runtime_events` table.
- Create `C:\Project-TOAD\toad-local\src\runtime\sqliteRuntimeEventLog.js`
  - Owns durable runtime event append/list APIs.
- Create `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
  - Converts normalized runtime events into audit rows and broker messages.
- Create `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`
  - Tests assistant text promotion, audit-only events, and async iterable consumption.
- Create `C:\Project-TOAD\toad-local\test\sqliteRuntimeEventLog.test.js`
  - Tests runtime event persistence and idempotency.
- Modify `C:\Project-TOAD\toad-local\package.json`
  - Adds the new tests to `npm test`.
- Modify `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
  - Records the event ingestion scaffold and verification coverage.

---

### Task 1: Durable Runtime Event Log

**Files:**
- Modify: `C:\Project-TOAD\toad-local\src\storage\schema.sql`
- Create: `C:\Project-TOAD\toad-local\src\runtime\sqliteRuntimeEventLog.js`
- Create: `C:\Project-TOAD\toad-local\test\sqliteRuntimeEventLog.test.js`

- [x] **Step 1: Write failing event-log tests**

Create `C:\Project-TOAD\toad-local\test\sqliteRuntimeEventLog.test.js` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRuntimeEventLog } from '../src/runtime/sqliteRuntimeEventLog.js';

function withLog(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-runtime-events-'));
  const log = new SqliteRuntimeEventLog({ filePath: join(dir, 'toad.db') });
  try {
    testFn(log);
  } finally {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteRuntimeEventLog persists runtime events idempotently', () => {
  withLog((log) => {
    const first = log.appendEvent({
      idempotencyKey: 'event-once',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'assistant_text',
      sessionId: 'session-1',
      payload: { text: 'Working on it.' },
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    const second = log.appendEvent({
      idempotencyKey: 'event-once',
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      eventType: 'assistant_text',
      sessionId: 'session-1',
      payload: { text: 'Duplicate should not insert.' },
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.event.eventId, first.event.eventId);
    assert.equal(second.event.payload.text, 'Working on it.');
    assert.equal(log.listEvents({ runtimeId: 'runtime-lead-1' }).length, 1);
  });
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node --no-warnings test/sqliteRuntimeEventLog.test.js
```

Expected: failure because `sqliteRuntimeEventLog.js` does not exist.

- [x] **Step 3: Add runtime event schema**

Add to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS runtime_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  runtime_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_runtime
  ON runtime_events(runtime_id, created_at);
```

- [x] **Step 4: Implement event log**

Create `SqliteRuntimeEventLog` with `appendEvent()`, `listEvents()`, and `close()`. Insert teams with the same local `#ensureTeam()` pattern used by `SqliteBroker`.

- [x] **Step 5: Run event-log tests**

Run:

```powershell
node --no-warnings test/sqliteRuntimeEventLog.test.js
```

Expected: event-log tests pass.

---

### Task 2: Runtime Event Ingestor

**Files:**
- Create: `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
- Create: `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`

- [x] **Step 1: Write failing ingestor tests**

Create `runtimeEventIngestor.test.js` covering:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
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
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: failure because `RuntimeEventIngestor.js` does not exist.

- [x] **Step 3: Implement ingestor**

Create `RuntimeEventIngestor` with `ingest(event)` that:
- validates `runtimeId`, `teamId`, `agentId`, and `type`
- computes an idempotency key from a stable hash of the event
- calls `eventLog.appendEvent()` when `eventLog` exists
- appends `assistant_text` to the broker as a `reply` message to `{ kind: 'user' }`
- uses the same idempotency key for the message as `runtime-message:${eventHash}`
- returns `{ event, message }`

- [x] **Step 4: Run ingestor tests**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: ingestor tests pass.

---

### Task 3: Consume Runtime Event Streams

**Files:**
- Modify: `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
- Modify: `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`

- [x] **Step 1: Add failing async iterable test**

Append a test proving `ingestFrom(adapter.events())` consumes two events and returns counts:

```js
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
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: failure because `ingestFrom()` does not exist.

- [x] **Step 3: Implement `ingestFrom()`**

Add `ingestFrom(asyncIterable)` with `for await`, returning `{ events, messages }`.

- [x] **Step 4: Run ingestor tests**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: all ingestor tests pass.

---

### Task 4: Package And Staged Plan Checkpoint

**Files:**
- Modify: `C:\Project-TOAD\toad-local\package.json`
- Modify: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

- [x] **Step 1: Add tests to package script**

Modify `package.json` test script so it includes:

```json
"... && node --no-warnings test/sqliteRuntimeEventLog.test.js && node test/runtimeEventIngestor.test.js ..."
```

- [x] **Step 2: Update staged plan scaffold**

Under `Local scaffold:` add:

```markdown
- `toad-local/src/runtime/RuntimeEventIngestor.js`
- `toad-local/src/runtime/sqliteRuntimeEventLog.js`
- `toad-local/test/runtimeEventIngestor.test.js`
- `toad-local/test/sqliteRuntimeEventLog.test.js`
```

Under `Current verification:`, append:

```markdown
Runtime event ingestion tests cover durable runtime event logging, idempotent event append, assistant text promotion to broker replies, audit-only runtime events, and async runtime event stream consumption.
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

- This slice intentionally does not parse tool-use payloads into task events yet; that is a later command/tool-call ingestion slice.
- `assistant_text` is the only runtime event promoted into chat because other event types are lifecycle/audit facts, not user-visible messages.
- Idempotency is based on stable event hashing until adapters emit explicit runtime event IDs.
