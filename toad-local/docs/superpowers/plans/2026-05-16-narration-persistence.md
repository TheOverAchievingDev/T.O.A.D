# Narration Persistence (Readability Layer-2 P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durably persist the shared pure `narrate()` `{line,kind,tokens}` projection of every in-scope runtime event, idempotently, alongside the raw event, readable back chronologically per team/runtime.

**Architecture:** A new `narrated_lines` SQLite table + `SqliteNarrationStore` (mirrors `SqliteRuntimeEventLog`); a purely-additive, non-fatal, idempotent synchronous `#persistNarration` consumer in `RuntimeEventIngestor.ingest` (runs the shared pure `narrate()` over `NARRATED_TYPES`, idempotency-keyed by the event hash ingest already computes); a `LocalReadModel.listNarratedTimeline` accessor exposed via the established `LocalToadRuntime` passthrough pattern. No UI, no LLM.

**Tech Stack:** Node ESM, `better-sqlite3` via `src/storage/sqlite.js` (`openToadDatabase`/`jsonStringify`), `node:crypto` `randomUUID`, `node:test`+`node:assert/strict`. No new dependencies.

---

## Grounded facts (verified in code 2026-05-16 — the plan is built on these; §8d)

- **`RuntimeEventIngestor.ingest(event)` body** (`src/runtime/RuntimeEventIngestor.js` L44-79): `const normalized = normalizeRuntimeEvent(event);` → `const eventHash = hashStableJson(normalized);` (L46) → `const eventResult = this.eventLog ? this.eventLog.appendEvent({ idempotencyKey:\`runtime-event:${eventHash}\`, … }) : null;` (L47-58) → `this.#publishEvent(normalized);` (L61) → THEN type branches: `tool_use` returns at L66, `approval_request` returns at L72, every other non-`assistant_text` (incl. `turn_completed`) hits `#dispatchCompactionLifecycle` + returns at L78, `assistant_text` falls through. **Consequence:** the ONLY single point every in-scope type passes is **immediately after `#publishEvent(normalized)` (L61), before `if (normalized.type === 'tool_use')` (L63)**. `eventHash` and `eventResult` are both in scope there. `#persistNarration` is the symmetric sibling of `#publishEvent` (one projects to the live bus, one to durable storage).
- **`SqliteRuntimeEventLog`** (`src/runtime/sqliteRuntimeEventLog.js`) — the store to mirror exactly: `import { randomUUID } from 'node:crypto';` + `import { jsonStringify, openToadDatabase } from '../storage/sqlite.js';`; `constructor({ filePath=':memory:', db=null }) { this.db = db || openToadDatabase(filePath); }`; `appendEvent` idempotency = `if (idempotencyKey) { const existing = this.#getEventByIdempotencyKey(idempotencyKey); if (existing) return { inserted:false, event:existing }; }`; calls `this.#ensureTeam(event.teamId)` BEFORE the INSERT; returns `{ inserted:true, event:this.getEvent(event.eventId) }`. `#ensureTeam(teamId)` = ``INSERT INTO teams (team_id, display_name, created_at) VALUES (?, NULL, ?) ON CONFLICT(team_id) DO NOTHING`` `.run(teamId, new Date().toISOString())`. `listEvents` orders `created_at ASC, event_id ASC`. `#rowToEvent` maps snake→camel.
- **`appendEvent` return**: `{ inserted:boolean, event:{ eventId, idempotencyKey, … } }`. So in `ingest`, the event id is `eventResult?.event?.eventId ?? null` (§7 #1 resolved).
- **`schema.sql`** (`src/storage/sqlite.js` does `db.exec(readFileSync(schemaPath))` on every open): starts `PRAGMA foreign_keys = ON;`; every table uses `CREATE TABLE IF NOT EXISTS` (idempotent — existing DBs get a new table automatically on next open; NO version-migration runner). `runtime_events` (L109-123) has `FOREIGN KEY (team_id) REFERENCES teams(team_id)`. **Consequence (§7 #4 resolved): `narrated_lines` MUST have the team FK AND `appendNarration` MUST call `#ensureTeam(teamId)` before insert** — else the FK throws, and because `#persistNarration` swallows errors it would *silently never persist* (an inert bug). The store calls its own `#ensureTeam` so it is correct standalone (Commit-1 unit tests have no eventLog).
- **`LocalReadModel`** (`src/read/LocalReadModel.js`): `constructor({ broker, taskBoard=null, runtimeRegistry=null, eventLog=null, approvalBroker=null })`. `listRuntimeAudit({ teamId, runtimeId=null }) { if (!this.eventLog || typeof this.eventLog.listEvents !== 'function') return []; return this.eventLog.listEvents({ teamId: requireString(teamId,'teamId'), runtimeId }); }` — the exact shape `listNarratedTimeline` mirrors.
- **Real read exposure (§7 #3 resolved — NOT apiServer)**: `LocalReadModel` reads reach callers via thin `LocalToadRuntime` passthrough methods (`src/app/LocalToadRuntime.js` L768-792, e.g. `listRuntimeAudit(input) { return this.readModel.listRuntimeAudit(input); }`) and a `localToolFacade` MCP tool wrapping that (`src/tools/localToolFacade.js` L1236-1240). `grep` confirms `apiServer.js` does **not** reference `readModel`. **P1 mirrors the `LocalToadRuntime.listRuntimeAudit` passthrough** (the in-process data accessor). The `localToolFacade` MCP tool + UI are the spec-deferred historical-view follow-on, OUT of P1 scope.
- **`LocalToadRuntime` construction order** (`src/app/LocalToadRuntime.js`): `this.eventLog = eventLog || new SqliteRuntimeEventLog({ filePath: dbPath });` (L129); `this.readModel = readModel || new LocalReadModel({ broker, taskBoard, runtimeRegistry, eventLog: this.eventLog, approvalBroker })` (L185-191); `this.eventIngestor = eventIngestor || new RuntimeEventIngestor({ …, eventLog: this.eventLog, compactionTrigger: this.compactionTrigger, … })` (L310-318). The per-store pattern is `new X({ filePath: dbPath })` (own connection — taskBoard/approvalBroker/registry/eventLog all do this); `SideEffectLog` uses the shared handle for its own reasons. **`narrationStore` is built right after L129 with `{ filePath: dbPath }`** — the same pattern, before BOTH `readModel` (L185) and the ingestor (L310), so no construction-ordering hazard (unlike the Sub-project-C eventBus case).
- **`eventNarration`** (`src/runtime/eventNarration/index.js`): `export { narrate, NARRATION_KINDS } from './narrate.js';` — pure, zero imports, server-importable. `narrate(normalized) → { line:string, kind:string, tokens:number|null }`, total (degraded `{line:'',kind:'system',tokens:null}`, never throws).
- **Store unit-test harness** (`test/sqliteRuntimeEventLog.test.js`): `mkdtempSync(join(tmpdir(),'…'))` + `new SqliteRuntimeEventLog({ filePath: join(dir,'toad.db') })` + `try { … } finally { log.close(); rmSync(dir,{recursive:true,force:true}); }`. Mirror this exactly.
- **`NARRATED_TYPES`**: `{ tool_use, assistant_text, turn_completed, approval_request }` — the eventNarration agreement test's scoped set. It is **test-local, not an exported module symbol**; P1 defines its own frozen `Set` constant at the ingestor (keep in sync with §4.4 by rationale, not a code dep).

## File Structure

| File | Responsibility |
|---|---|
| `src/storage/schema.sql` *(modify, Commit 1)* | Add `narrated_lines` table + 2 indexes (idempotent `CREATE TABLE IF NOT EXISTS`, after the `runtime_events` block). |
| `src/runtime/sqliteNarrationStore.js` *(create, Commit 1)* | `SqliteNarrationStore` — mirrors `SqliteRuntimeEventLog`: ctor, `#ensureTeam`, idempotent `appendNarration`, `listNarration`, `#rowToNarration`, `close`. |
| `test/sqliteNarrationStore.test.js` *(create, Commit 1)* | Store unit suite (insert, idempotency dedup, ordering, team/runtime scope, tokens null/number, ensure-team FK). |
| `src/runtime/RuntimeEventIngestor.js` *(modify, Commit 2)* | Add optional `narrationStore=null` ctor param; `NARRATED_TYPES` const; `#persistNarration`; one call site after `#publishEvent`. Additive — existing behavior byte-unchanged. |
| `src/read/LocalReadModel.js` *(modify, Commit 2)* | Add optional `narrationStore=null` ctor param; `listNarratedTimeline` (mirrors `listRuntimeAudit`). |
| `src/app/LocalToadRuntime.js` *(modify, Commit 2)* | Construct `this.narrationStore` after `this.eventLog`; thread into `LocalReadModel` + `RuntimeEventIngestor`; add `listNarratedTimeline(input)` passthrough. |
| `test/runtimeEventIngestor.narration.test.js` *(create, Commit 2)* | Consumer integration (exact narrate() persisted; non-NARRATED no row; store-absent ok; appendNarration-throws → ingest ok AND raw event still present). |
| `test/localToadRuntime.narration.test.js` *(create, Commit 2)* | End-to-end anti-inert (real `LocalToadRuntime` ingest `turn_completed` → `listNarratedTimeline` returns the line) + `LocalReadModel.listNarratedTimeline` unit (absent store → []). |
| `package.json` *(modify, Commit 1 & 2)* | Append new suites to `scripts.test` (un-wired-test trap). |

**Commit policy:** **Commit 1 = Tasks 1–3** (storage layer). **Commit 2 = Tasks 4–7** (consumer + read + wiring + gates). Tasks within a commit accumulate **uncommitted**; only Task 3 (Commit 1) and Task 7 (Commit 2) commit. Commit to `main` per session convention: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 1: `narrated_lines` schema + `SqliteNarrationStore` skeleton

**Files:**
- Modify: `src/storage/schema.sql`
- Create: `src/runtime/sqliteNarrationStore.js`
- Create: `test/sqliteNarrationStore.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/sqliteNarrationStore.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteNarrationStore } from '../src/runtime/sqliteNarrationStore.js';

function withStore(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-narration-'));
  const store = new SqliteNarrationStore({ filePath: join(dir, 'toad.db') });
  try {
    testFn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteNarrationStore creates the narrated_lines table on open', () => {
  withStore((store) => {
    const cols = store.db.prepare("PRAGMA table_info(narrated_lines)").all().map((c) => c.name);
    assert.deepEqual(
      cols.sort(),
      ['agent_id', 'created_at', 'event_id', 'event_type', 'idempotency_key', 'kind', 'line', 'narration_id', 'runtime_id', 'session_id', 'team_id', 'tokens'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/sqliteNarrationStore.test.js`
Expected: FAIL — `Cannot find module '.../sqliteNarrationStore.js'`.

- [ ] **Step 3: Add the schema table**

In `src/storage/schema.sql`, immediately after the `runtime_events` table block and its `idx_runtime_events_runtime` index (the block ending around the `FOREIGN KEY (team_id) REFERENCES teams(team_id)` of `runtime_events` and its index), add:

```sql

CREATE TABLE IF NOT EXISTS narrated_lines (
  narration_id    TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  event_id        TEXT,
  runtime_id      TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  session_id      TEXT,
  event_type      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  line            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  tokens          INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_narrated_lines_runtime ON narrated_lines(runtime_id, created_at);
CREATE INDEX IF NOT EXISTS idx_narrated_lines_team ON narrated_lines(team_id, created_at);
```

- [ ] **Step 4: Implement the store skeleton**

Create `src/runtime/sqliteNarrationStore.js`:

```javascript
import { randomUUID } from 'node:crypto';
import { openToadDatabase } from '../storage/sqlite.js';

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Durable projection of eventNarration.narrate() — mirrors
 * SqliteRuntimeEventLog (own connection, idempotent append, ensure-team
 * FK discipline). One row per narrated runtime event.
 */
export class SqliteNarrationStore {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  // appendNarration / listNarration — Task 2.
}
```

- [ ] **Step 5: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/sqliteNarrationStore.test.js`
Expected: PASS (1/1 — `openToadDatabase` applies `schema.sql` which now creates `narrated_lines`).

---

## Task 2: `appendNarration` (idempotent, ensure-team) + `listNarration`

**Files:**
- Modify: `src/runtime/sqliteNarrationStore.js`
- Modify: `test/sqliteNarrationStore.test.js`

- [ ] **Step 1: Write the failing tests** — append to `test/sqliteNarrationStore.test.js`:

```javascript
const base = (over = {}) => ({
  idempotencyKey: 'narration:h1',
  eventId: 'ev-1',
  runtimeId: 'rt-1',
  teamId: 'team-a',
  agentId: 'lead',
  sessionId: 's-1',
  eventType: 'tool_use',
  createdAt: '2026-05-16T00:00:00.000Z',
  line: 'lead ran Read — foo.js',
  kind: 'tool',
  tokens: null,
  ...over,
});

test('appendNarration inserts a row and ensures the team (FK satisfied)', () => {
  withStore((store) => {
    const r = store.appendNarration(base());
    assert.equal(r.inserted, true);
    assert.equal(r.row.line, 'lead ran Read — foo.js');
    assert.equal(r.row.kind, 'tool');
    assert.equal(r.row.tokens, null);
    assert.equal(r.row.teamId, 'team-a');
    const teamRow = store.db.prepare('SELECT team_id FROM teams WHERE team_id = ?').get('team-a');
    assert.equal(teamRow.team_id, 'team-a'); // #ensureTeam ran (no FK throw)
  });
});

test('appendNarration is idempotent by idempotency_key', () => {
  withStore((store) => {
    const a = store.appendNarration(base());
    const b = store.appendNarration(base({ line: 'DIFFERENT' }));
    assert.equal(a.inserted, true);
    assert.equal(b.inserted, false);
    const rows = store.listNarration({ teamId: 'team-a' });
    assert.equal(rows.length, 1, 'no duplicate row');
    assert.equal(rows[0].line, 'lead ran Read — foo.js', 'first write wins');
  });
});

test('appendNarration persists a numeric tokens value', () => {
  withStore((store) => {
    store.appendNarration(base({ idempotencyKey: 'narration:h2', eventType: 'turn_completed', kind: 'system', line: 'Turn complete', tokens: 1234 }));
    const rows = store.listNarration({ teamId: 'team-a' });
    assert.equal(rows[0].tokens, 1234);
  });
});

test('listNarration orders chronologically and scopes by team then runtime', () => {
  withStore((store) => {
    store.appendNarration(base({ idempotencyKey: 'k1', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:02.000Z', line: 'second' }));
    store.appendNarration(base({ idempotencyKey: 'k2', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:01.000Z', line: 'first' }));
    store.appendNarration(base({ idempotencyKey: 'k3', runtimeId: 'rt-2', teamId: 'team-a', createdAt: '2026-05-16T00:00:03.000Z', line: 'other-rt' }));
    store.appendNarration(base({ idempotencyKey: 'k4', teamId: 'team-b', runtimeId: 'rt-9', createdAt: '2026-05-16T00:00:00.000Z', line: 'other-team' }));
    const team = store.listNarration({ teamId: 'team-a' }).map((r) => r.line);
    assert.deepEqual(team, ['first', 'second', 'other-rt']);
    const rt1 = store.listNarration({ teamId: 'team-a', runtimeId: 'rt-1' }).map((r) => r.line);
    assert.deepEqual(rt1, ['first', 'second']);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/sqliteNarrationStore.test.js`
Expected: FAIL — `store.appendNarration is not a function`.

- [ ] **Step 3: Implement append + list**

Replace the `// appendNarration / listNarration — Task 2.` comment in `src/runtime/sqliteNarrationStore.js` with:

```javascript
  #ensureTeam(teamId) {
    this.db.prepare(
      `
        INSERT INTO teams (team_id, display_name, created_at)
        VALUES (?, NULL, ?)
        ON CONFLICT(team_id) DO NOTHING
      `
    ).run(teamId, new Date().toISOString());
  }

  #getByIdempotencyKey(idempotencyKey) {
    const row = this.db
      .prepare('SELECT * FROM narrated_lines WHERE idempotency_key = ?')
      .get(idempotencyKey);
    return row ? this.#rowToNarration(row) : null;
  }

  #rowToNarration(row) {
    return {
      narrationId: row.narration_id,
      idempotencyKey: row.idempotency_key,
      eventId: row.event_id,
      runtimeId: row.runtime_id,
      teamId: row.team_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      createdAt: row.created_at,
      line: row.line,
      kind: row.kind,
      tokens: row.tokens,
    };
  }

  appendNarration(input) {
    const idempotencyKey = input.idempotencyKey || null;
    if (idempotencyKey) {
      const existing = this.#getByIdempotencyKey(idempotencyKey);
      if (existing) return { inserted: false, row: existing };
    }
    const row = {
      narrationId: randomUUID(),
      idempotencyKey,
      eventId: typeof input.eventId === 'string' && input.eventId ? input.eventId : null,
      runtimeId: requireString(input.runtimeId, 'runtimeId'),
      teamId: requireString(input.teamId, 'teamId'),
      agentId: requireString(input.agentId, 'agentId'),
      sessionId:
        typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      eventType: requireString(input.eventType, 'eventType'),
      createdAt: input.createdAt || new Date().toISOString(),
      line: typeof input.line === 'string' ? input.line : '',
      kind: requireString(input.kind, 'kind'),
      tokens: typeof input.tokens === 'number' && Number.isFinite(input.tokens) ? input.tokens : null,
    };
    this.#ensureTeam(row.teamId);
    this.db.prepare(
      `
        INSERT INTO narrated_lines (
          narration_id, idempotency_key, event_id, runtime_id, team_id,
          agent_id, session_id, event_type, created_at, line, kind, tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      row.narrationId, row.idempotencyKey, row.eventId, row.runtimeId, row.teamId,
      row.agentId, row.sessionId, row.eventType, row.createdAt, row.line, row.kind, row.tokens
    );
    return { inserted: true, row };
  }

  listNarration({ teamId, runtimeId = null } = {}) {
    const team = requireString(teamId, 'teamId');
    if (runtimeId) {
      return this.db
        .prepare('SELECT * FROM narrated_lines WHERE team_id = ? AND runtime_id = ? ORDER BY created_at ASC, narration_id ASC')
        .all(team, runtimeId)
        .map((r) => this.#rowToNarration(r));
    }
    return this.db
      .prepare('SELECT * FROM narrated_lines WHERE team_id = ? ORDER BY created_at ASC, narration_id ASC')
      .all(team)
      .map((r) => this.#rowToNarration(r));
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/sqliteNarrationStore.test.js`
Expected: PASS (all 5 tests). If the FK/ensure-team test fails with a SQLITE FK error, `#ensureTeam` must run before the INSERT — fix code, never the test.

---

## Task 3: Wire Commit-1 suite + **Commit 1**

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Wire the store suite into `scripts.test`**

In `package.json`, append to the end of the `scripts.test` string (immediately before its closing `"`), exactly (note leading space):

```
 && node --no-warnings --test test/sqliteNarrationStore.test.js
```

Validate: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log('JSON OK', t.includes('test/sqliteNarrationStore.test.js'))"`
Expected: `JSON OK true`.

- [ ] **Step 2: Full root suite — fail 0, new suite executed**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (pass|fail)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`.
Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -cE "creates the narrated_lines table|idempotent by idempotency_key"`
Expected: ≥ `2` (un-wired-test trap — the suite genuinely ran).

- [ ] **Step 3: Commit 1**

```bash
git -C /c/Project-TOAD add toad-local/src/storage/schema.sql toad-local/src/runtime/sqliteNarrationStore.js toad-local/test/sqliteNarrationStore.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(narration): durable SqliteNarrationStore + narrated_lines table (Readability Layer-2 P1, Commit 1)

New idempotent narrated_lines table (schema.sql CREATE TABLE IF NOT
EXISTS + team FK + 2 indexes) and SqliteNarrationStore mirroring
SqliteRuntimeEventLog (own connection, randomUUID id, #ensureTeam
before insert so the team FK is satisfied, idempotency dedup by
idempotency_key, listNarration ordered created_at/narration_id, team
then optional runtime scope, strict numeric tokens). Store unit suite
wired into the npm chain. Root fail 0. Pure storage; no consumer yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `LocalReadModel.listNarratedTimeline`

**Files:**
- Modify: `src/read/LocalReadModel.js`
- Create: `test/localToadRuntime.narration.test.js`

- [ ] **Step 1: Write the failing unit test**

Create `test/localToadRuntime.narration.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalReadModel } from '../src/read/LocalReadModel.js';

const brokerStub = { listMessages: () => [] };

test('LocalReadModel.listNarratedTimeline returns [] when no narrationStore', () => {
  const rm = new LocalReadModel({ broker: brokerStub });
  assert.deepEqual(rm.listNarratedTimeline({ teamId: 'team-a' }), []);
});

test('LocalReadModel.listNarratedTimeline passes through to the store', () => {
  const calls = [];
  const narrationStore = {
    listNarration(arg) { calls.push(arg); return [{ line: 'x', kind: 'tool', tokens: null }]; },
  };
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore });
  const out = rm.listNarratedTimeline({ teamId: 'team-a', runtimeId: 'rt-1' });
  assert.deepEqual(out, [{ line: 'x', kind: 'tool', tokens: null }]);
  assert.deepEqual(calls, [{ teamId: 'team-a', runtimeId: 'rt-1' }]);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.narration.test.js`
Expected: FAIL — `rm.listNarratedTimeline is not a function`.

- [ ] **Step 3: Implement**

In `src/read/LocalReadModel.js` constructor destructuring, add `narrationStore = null,` after `approvalBroker = null,`; and in the body add `this.narrationStore = narrationStore;` after `this.approvalBroker = approvalBroker;`.

Add the method directly after `listRuntimeAudit` (mirror its exact shape):

```javascript
  listNarratedTimeline({ teamId, runtimeId = null }) {
    if (!this.narrationStore || typeof this.narrationStore.listNarration !== 'function') return [];
    return this.narrationStore.listNarration({ teamId: requireString(teamId, 'teamId'), runtimeId });
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.narration.test.js`
Expected: PASS (2/2).

---

## Task 5: `#persistNarration` consumer in `RuntimeEventIngestor`

**Files:**
- Modify: `src/runtime/RuntimeEventIngestor.js`
- Create: `test/runtimeEventIngestor.narration.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/runtimeEventIngestor.narration.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventIngestor } from '../src/runtime/RuntimeEventIngestor.js';

function mkEventLog() {
  const appended = [];
  return {
    appended,
    appendEvent(input) {
      const event = { eventId: `ev-${appended.length + 1}`, ...input };
      appended.push(event);
      return { inserted: true, event };
    },
    listEvents() { return appended; },
  };
}
function mkNarrationStore() {
  const rows = [];
  return {
    rows,
    appendNarration(input) { rows.push(input); return { inserted: true, row: input }; },
    listNarration() { return rows; },
  };
}
const broker = { appendMessage: () => ({ message: { id: 'm' } }) };
const ev = (type, over = {}) => ({ type, runtimeId: 'rt-1', teamId: 'team-a', agentId: 'lead', createdAt: '2026-05-16T00:00:00.000Z', ...over });

test('persists exact narrate() output for an in-scope event (turn_completed)', async () => {
  const narrationStore = mkNarrationStore();
  const ing = new RuntimeEventIngestor({ broker, eventLog: mkEventLog(), narrationStore });
  await ing.ingest(ev('turn_completed'));
  assert.equal(narrationStore.rows.length, 1);
  const r = narrationStore.rows[0];
  assert.equal(r.eventType, 'turn_completed');
  assert.equal(typeof r.line, 'string');
  assert.equal(r.kind, 'system');           // narrate() maps turn_completed → kind 'system'
  assert.equal(r.runtimeId, 'rt-1');
  assert.equal(r.teamId, 'team-a');
  assert.ok(String(r.idempotencyKey).startsWith('narration:'));
  assert.equal(r.eventId, 'ev-1');           // from eventResult.event.eventId
});

test('does NOT persist a non-NARRATED event type', async () => {
  const narrationStore = mkNarrationStore();
  const ing = new RuntimeEventIngestor({ broker, eventLog: mkEventLog(), narrationStore });
  await ing.ingest(ev('compact_boundary'));
  assert.equal(narrationStore.rows.length, 0);
});

test('narrationStore absent → ingest still succeeds', async () => {
  const ing = new RuntimeEventIngestor({ broker, eventLog: mkEventLog() });
  await ing.ingest(ev('turn_completed'));   // must not throw
  assert.ok(true);
});

test('appendNarration throwing → ingest still succeeds AND the raw event is still appended (non-fatal)', async () => {
  const eventLog = mkEventLog();
  const narrationStore = { appendNarration() { throw new Error('db down'); }, listNarration() { return []; } };
  const ing = new RuntimeEventIngestor({ broker, eventLog, narrationStore });
  await ing.ingest(ev('turn_completed'));   // must not throw
  assert.equal(eventLog.appended.length, 1, 'raw runtime_events row still persisted');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/runtimeEventIngestor.narration.test.js`
Expected: FAIL — narration rows not persisted (`narrationStore` neither a ctor param nor consumed).

- [ ] **Step 3: Implement**

In `src/runtime/RuntimeEventIngestor.js`:

(a) Add the import near the top with the other imports:

```javascript
import { narrate } from './eventNarration/index.js';
```

(b) Add a module-scope constant near the top (after imports, before the class):

```javascript
// The wired-consumer-sourced event types (readability Slice-1 §4.4
// scope). Test-local in the agreement test, redefined here by the same
// §4.4 rationale (not a code dependency on a test internal).
const NARRATED_TYPES = Object.freeze(new Set(['tool_use', 'assistant_text', 'turn_completed', 'approval_request']));
```

(c) In the constructor destructuring, add `narrationStore = null,` directly below `compactionTrigger = null,`; in the constructor body add `this.narrationStore = narrationStore;` directly below `this.compactionTrigger = compactionTrigger;`.

(d) In `ingest()`, immediately after `this.#publishEvent(normalized);` and before `if (normalized.type === 'tool_use') {`, insert exactly one line:

```javascript
    this.#persistNarration(normalized, eventHash, eventResult);
```

(e) Add the private method (place it next to `#publishEvent`):

```javascript
  #persistNarration(normalized, eventHash, eventResult) {
    if (!this.narrationStore) return;
    if (!NARRATED_TYPES.has(normalized.type)) return;
    try {
      const n = narrate(normalized);
      this.narrationStore.appendNarration({
        idempotencyKey: `narration:${eventHash}`,
        eventId: eventResult && eventResult.event ? eventResult.event.eventId : null,
        runtimeId: normalized.runtimeId,
        teamId: normalized.teamId,
        agentId: normalized.agentId,
        sessionId: normalized.sessionId,
        eventType: normalized.type,
        createdAt: normalized.createdAt,
        line: n.line,
        kind: n.kind,
        tokens: n.tokens,
      });
    } catch {
      // Non-fatal: narration is a durable projection; a write failure
      // must never lose or block the raw event / ingest. (Spec §4.)
    }
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/runtimeEventIngestor.narration.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Existing ingestor suite stays green (additive proof)**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/runtimeEventIngestor.test.js test/runtimeEventIngestor.compactionTrigger.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`. The change is purely additive; a regression is a real bug — fix code, never the test.

---

## Task 6: `LocalToadRuntime` construction + threading + passthrough

**Files:**
- Modify: `src/app/LocalToadRuntime.js`
- Modify: `test/localToadRuntime.narration.test.js`

- [ ] **Step 1: Write the failing end-to-end test** — append to `test/localToadRuntime.narration.test.js`:

```javascript
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

test('LocalToadRuntime persists narration end-to-end and reads it back (anti-inert)', async () => {
  const rt = new LocalToadRuntime();
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-e2e', teamId: 'team-e2e', agentId: 'lead',
    createdAt: '2026-05-16T00:00:00.000Z', raw: {},
  });
  const rows = rt.listNarratedTimeline({ teamId: 'team-e2e' });
  assert.equal(rows.length, 1, 'one narrated line persisted via the real runtime');
  assert.equal(rows[0].eventType, 'turn_completed');
  assert.equal(typeof rows[0].line, 'string');
  assert.ok(rt.narrationStore, 'narrationStore constructed on the runtime');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.narration.test.js`
Expected: FAIL — `rt.listNarratedTimeline is not a function` / `rt.narrationStore` undefined.

- [ ] **Step 3: Implement**

In `src/app/LocalToadRuntime.js`:

(a) Add the import near the other store imports (next to `import { SqliteRuntimeEventLog } …`):

```javascript
import { SqliteNarrationStore } from '../runtime/sqliteNarrationStore.js';
```

(b) In the constructor destructuring, add `narrationStore = null,` next to the existing `eventLog = null,` param.

(c) Immediately AFTER the line `this.eventLog = eventLog || new SqliteRuntimeEventLog({ filePath: dbPath });` insert:

```javascript
    this.narrationStore = narrationStore || new SqliteNarrationStore({ filePath: dbPath });
```

(d) In the `new LocalReadModel({ … })` argument object, add `narrationStore: this.narrationStore,` after `eventLog: this.eventLog,`.

(e) In the `new RuntimeEventIngestor({ … })` argument object, add `narrationStore: this.narrationStore,` after `eventLog: this.eventLog,`.

(f) Add a passthrough method next to the existing `listRuntimeAudit(input)` passthrough (the block of `this.readModel.*` passthroughs):

```javascript
  listNarratedTimeline(input) {
    return this.readModel.listNarratedTimeline(input);
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.narration.test.js`
Expected: PASS (3/3 — the 2 LocalReadModel unit tests + the e2e).

- [ ] **Step 5: Existing LocalToadRuntime suites stay green**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.test.js test/localToadRuntime.compactionTrigger.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`. Additive (one new collaborator + two ctor args + one passthrough); a regression is a real wiring bug — fix code, not the test.

---

## Task 7: Wire Commit-2 suites + full gates + **Commit 2**

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Wire the two Commit-2 suites into `scripts.test`**

In `package.json`, append to the end of the `scripts.test` string (before its closing `"`), exactly (leading space):

```
 && node --no-warnings --test test/runtimeEventIngestor.narration.test.js && node --no-warnings --test test/localToadRuntime.narration.test.js
```

Validate: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log(['runtimeEventIngestor.narration','localToadRuntime.narration'].every(s=>t.includes(s)))"`
Expected: `true`.

- [ ] **Step 2: Full root suite — fail 0, all 3 new suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (pass|fail)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`.
Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -cE "creates the narrated_lines table|persists exact narrate\\(\\) output|persists narration end-to-end"`
Expected: ≥ `3` (un-wired-test trap — all three new suites genuinely ran).

- [ ] **Step 3: UI gate**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN` → `CLEAN`
Run: `cd /c/Project-TOAD/toad-local/ui && npm run build 2>&1 | tail -2` → ends with a successful build.
(UI is not modified by P1 — proves the data-contract addition broke nothing downstream.)

- [ ] **Step 4: Whole-implementation review (pre-commit gate)**

Review the entire Commit-2 surface as one unit (the gate that caught the auth Critical): seam coherence (`narrate()` shape ↔ `appendNarration` input ↔ store row); the `#persistNarration` insertion point genuinely catches all 4 `NARRATED_TYPES` (tool_use/approval_request/turn_completed all return early — confirm the call site is BEFORE the `tool_use` branch); non-fatal proof is a real assertion (raw event still appended when `appendNarration` throws); construction order (narrationStore built after eventLog, before readModel + ingestor — all receive the same instance); additive-only (existing `appendEvent`/`#publishEvent`/compaction/ingestor/LocalToadRuntime suites green); no inert wiring (the e2e proves a real `LocalToadRuntime` ingest reaches `listNarratedTimeline`); the new suites genuinely execute under `npm test`. Resolve any finding before committing.

- [ ] **Step 5: Commit 2**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/RuntimeEventIngestor.js toad-local/src/read/LocalReadModel.js toad-local/src/app/LocalToadRuntime.js toad-local/test/runtimeEventIngestor.narration.test.js toad-local/test/localToadRuntime.narration.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(narration): persist narrate() in the ingestor + listNarratedTimeline (Readability Layer-2 P1, Commit 2)

Purely-additive non-fatal idempotent #persistNarration consumer in
RuntimeEventIngestor.ingest — runs the shared pure narrate() over
NARRATED_TYPES at the single point all four pass (right after
#publishEvent, before the type branch), idempotency-keyed
narration:${eventHash} reusing the hash ingest already computes,
event_id from the eventResult ingest already holds. LocalReadModel.
listNarratedTimeline mirrors listRuntimeAudit; LocalToadRuntime builds
SqliteNarrationStore after eventLog and threads it into the read model
+ ingestor + a listNarratedTimeline passthrough. §4.4-faithful (the
ingestor persists what narrate() returns). appendEvent/#publishEvent/
compaction/drift byte-unchanged; narration write failure never affects
ingest or the raw event (proven). Root fail 0; UI tsc/build green;
whole-impl reviewed. No UI / no LLM (P2/P3 + historical-view UI follow).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 6: Post-commit verify**

`git -C /c/Project-TOAD show --stat HEAD` — exactly the 6 listed files, no stray. `git -C /c/Project-TOAD status --porcelain` — clean of all plan/feature files. HEAD~1 = Commit 1.

---

## Notes for the executor (grounded pins — confirm against code, do not pre-invent)

- **`#persistNarration` call site is load-bearing.** It MUST be after `this.#publishEvent(normalized);` and BEFORE `if (normalized.type === 'tool_use')` — `tool_use`/`approval_request`/`turn_completed` all `return` inside their branches, so any later placement misses them (an inert subset bug). Confirm the exact lines in the real `ingest()` at implementation time.
- **`#ensureTeam` is mandatory, not optional.** `PRAGMA foreign_keys = ON` + `narrated_lines.team_id` FK → without `#ensureTeam` before insert the append throws, and `#persistNarration` swallows it → silent non-persistence. The store's own `#ensureTeam` keeps it correct standalone (Commit-1 tests have no eventLog).
- **Construction order has no hazard here** (unlike Sub-project C): `narrationStore` is built right after `this.eventLog` (L129), strictly before `readModel` (L185) and the ingestor (L310), with `{ filePath: dbPath }` (the per-store-own-connection pattern every other store uses). Confirm the eventLog line + the two consumer constructors at impl time and thread the SAME `this.narrationStore` instance into both.
- **Read exposure is the `LocalToadRuntime` passthrough, NOT apiServer** (grep-confirmed: `apiServer.js` doesn't reference `readModel`). Mirror the `listRuntimeAudit(input) { return this.readModel.listRuntimeAudit(input); }` passthrough exactly. The `localToolFacade` MCP tool + UI are the spec-deferred historical-view follow-on — OUT of P1.
- **§8d:** if any grounded fact above is wrong at implementation time, STOP and surface it (controller pre-emptive ratification), exactly as in the auth/compaction/readability cycles — do not code around a wrong plan.
