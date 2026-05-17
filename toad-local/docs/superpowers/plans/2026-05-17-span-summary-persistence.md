# Span-Summary Persistence + Decide Core (Readability Layer-2 P3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable `span_summaries` store + a pure "which closed spans still need summarizing" decide core, exposed compute-on-read — the dormant-but-fully-tested foundation P3b's spawned-CLI summarizer will write into.

**Architecture:** New `SqliteSpanSummaryStore` mirroring `sqliteNarrationStore.js` (idempotent `appendSummary` keyed by `span_id`, `#ensureTeam` FK, `listSummaries`); a pure zero-import `decideSpansToSummarize` core; `LocalToadRuntime` constructs the store, `LocalReadModel` exposes `listSpanSummaries` + a composed compute-on-read `listSpansAwaitingSummary`. No LLM/spawn, no production writer (P3b is first) — purely additive, the shipped P1/P2b dormant-but-tested pattern.

**Tech Stack:** Node ≥20 ESM, `node:sqlite` (`DatabaseSync`), `node:test`. Greenfield → TDD + purity + store-unit + e2e-round-trip (NOT a preservation refactor — no capture-script/frozen-golden).

**Spec:** `docs/superpowers/specs/2026-05-17-span-summary-persistence-design.md` (committed `151cb53`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/spanSummary/decideSpansToSummarize.js` (create) | Pure `decideSpansToSummarize({spans,summarizedSpanIds})` — closed-only, dedupe, oldest-first. Zero imports, total. |
| `src/runtime/spanSummary/index.js` (create) | Re-export (the `spanDetection/index.js` shape). |
| `src/runtime/sqliteSpanSummaryStore.js` (create) | `SqliteSpanSummaryStore` — mirrors `sqliteNarrationStore.js`; idempotent `appendSummary` by `span_id`; `listSummaries`; `#ensureTeam`. |
| `src/storage/schema.sql` (modify) | Add `span_summaries` table (`CREATE TABLE IF NOT EXISTS`) + two indexes after the `narrated_lines` indexes. |
| `test/spanSummary.decide.test.js` (create) | TDD unit suite for the pure core. |
| `test/spanSummary.purity.test.js` (create) | Purity guard (no node:/fs/path/os/child_process/react/JSX/process). |
| `test/sqliteSpanSummaryStore.test.js` (create) | Store unit suite (idempotency, FK, ordering, validation). |
| `src/read/LocalReadModel.js` (modify) | Import `decideSpansToSummarize`; ctor accepts `spanSummaryStore`; `listSpanSummaries` (guarded delegate) + `listSpansAwaitingSummary` (composed, single-site guard). |
| `src/app/LocalToadRuntime.js` (modify) | Import store; ctor destructure + construct `this.spanSummaryStore`; pass to `LocalReadModel`; `closeIfSupported`; `listSpanSummaries`/`listSpansAwaitingSummary` delegations. |
| `test/localToadRuntime.spanSummary.test.js` (create) | Wiring + e2e round-trip suite. |
| `package.json` (modify) | Wire the 4 P3a suites into `scripts.test` (3 in Commit 1, the 4th in Commit 2). |

**Commit decomposition (2 atomic commits, the proven P2b cadence):**
- **Commit 1 (Tasks 1–4):** pure decide core + store + their 3 suites, wired, full root fail 0.
- **Commit 2 (Tasks 5–7):** the read-model/runtime exposure + e2e round-trip suite, 4th suite wired, full root fail 0 + grep all 4 P3a titles in own output, whole-impl review, Commit 2 + post-commit verify.

Tasks within a commit accumulate **uncommitted**; only Task 4 and Task 7 commit.

---

## §9 Grounded pins (verified against shipped code — do not re-invent)

- `openToadDatabase` (`src/storage/sqlite.js:9-29`) runs `db.exec(readFileSync(schemaPath))` (the WHOLE `schema.sql`) on **every** open, then `applyMigrations`. The `applyMigrations` comment (`sqlite.js:31-36`) states only new **columns** need an `ALTER`; a new **table** via `CREATE TABLE IF NOT EXISTS` in `schema.sql` is created on existing DBs at next open. ⟹ `span_summaries` goes in `schema.sql` only, **no `applyMigrations` entry**.
- `schema.sql` style: `PRAGMA foreign_keys = ON;` (line 1); tables are `CREATE TABLE IF NOT EXISTS name (\n  col TYPE …,\n  FOREIGN KEY (team_id) REFERENCES teams(team_id)\n);`; indexes `CREATE INDEX IF NOT EXISTS idx_<t>_<cols> ON <t>(<cols>);`. `teams(team_id)` is the FK parent (lines 3-7). `narrated_lines` + its 2 indexes end at line 142; `task_events` starts line 144.
- `sqliteNarrationStore.js` is the verbatim store precedent: `import { randomUUID } from 'node:crypto'; import { openToadDatabase } from '../storage/sqlite.js';`, a module-level `requireString(value,label)`, ctor `{ filePath=':memory:', db=null } = {}` → `this.db = db || openToadDatabase(filePath)`, `close(){ this.db.close(); }`, `#ensureTeam` = `INSERT INTO teams (team_id, display_name, created_at) VALUES (?, NULL, ?) ON CONFLICT(team_id) DO NOTHING`, idempotency check-before-insert returning `{inserted:false,row}` / `{inserted:true,row}`, `#rowTo*` snake→camel, list query `… WHERE team_id=? [AND runtime_id=?] ORDER BY created_at ASC, <pk> ASC`.
- `LocalToadRuntime.js`: `import { SqliteNarrationStore } from '../runtime/sqliteNarrationStore.js';` (line 13); ctor destructure `narrationStore = null,` (line 74); `this.narrationStore = narrationStore || new SqliteNarrationStore({ filePath: dbPath });` (line 132); `new LocalReadModel({ … narrationStore: this.narrationStore, approvalBroker: this.approvalBroker })` (lines 190-197); `closeIfSupported(this.narrationStore);` (line 821). **Line 317's `narrationStore: this.narrationStore` is the `RuntimeEventIngestor` — do NOT add `spanSummaryStore` there (P3a's store is not written by the ingestor; that is an out-of-scope/wrong-layer over-reach).**
- `LocalReadModel.js`: `import { detectSpans, DEFAULT_SPAN_CONFIG } from '../runtime/spanDetection/index.js';` (line 7); ctor destructures `{ broker, taskBoard=null, runtimeRegistry=null, eventLog=null, approvalBroker=null, narrationStore=null }` and assigns `this.narrationStore = narrationStore` (lines 8-26); `listNarratedTimeline` (104-107); `listSpans` (109-114); `listApprovals` (116). `requireString` is in-scope (file-local).
- `Span` shape from `listSpans`/`detectSpans`: `{ spanId, agentId, runtimeId, teamId, sessionId, startedAt, endedAt, closed, boundary, rowCount, tokens, rows }`. The decide core reads the **live `Span.startedAt`** — distinct from the persisted `span_started_at`/`spanStartedAt` snapshot column; do NOT rename to match.
- e2e closed-span recipe (the §8d-ratified P2b test-4 path): ingest `type:'tool_use'` for an UNREGISTERED runtime — `RuntimeEventIngestor.#persistNarration` (line 70) runs BEFORE the `tool_use` identity check (line 73), so the tool narration persists then `ingest` throws; tolerate ONLY `/unknown runtime identity/` via `assert.match`. Then ingest `type:'turn_completed'` (kind `system`; takes the line-84 early return — no identity throw) to CLOSE the span. `detectSpans` then yields exactly one CLOSED span.
- **§8d STOP rule:** if any pin is wrong at implementation time, STOP and surface for controller pre-emptive ratification (auth/compaction/narration/P2a/P2b precedent). Do not code around a wrong plan.

---

## Task 1: Pure `decideSpansToSummarize` core

**Files:** Create `src/runtime/spanSummary/decideSpansToSummarize.js`, `src/runtime/spanSummary/index.js`; Test `test/spanSummary.decide.test.js`.

- [ ] **Step 1: Write the failing unit suite**

Create `test/spanSummary.decide.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSpansToSummarize } from '../src/runtime/spanSummary/index.js';

// Minimal Span stub; only the fields the decide core reads.
function span(o) {
  return {
    spanId: o.spanId,
    closed: o.closed ?? true,
    startedAt: o.startedAt ?? '2026-05-16T00:00:00.000Z',
    // carried-but-unused-by-core fields, present for realism:
    agentId: 'a1', runtimeId: 'rt-1', teamId: 'team-1',
  };
}

test('empty / non-array spans yields []', () => {
  assert.deepEqual(decideSpansToSummarize({ spans: [], summarizedSpanIds: new Set() }), []);
  assert.deepEqual(decideSpansToSummarize({ spans: undefined }), []);
  assert.deepEqual(decideSpansToSummarize({}), []);
  assert.deepEqual(decideSpansToSummarize(), []);
});

test('open spans are always excluded', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 's1', closed: false }), span({ spanId: 's2', closed: true })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s2']);
});

test('already-summarized spanIds are excluded (Set)', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 's1' }), span({ spanId: 's2' }), span({ spanId: 's3' })],
    summarizedSpanIds: new Set(['s2']),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s1', 's3']);
});

test('summarizedSpanIds accepted as an array too', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 's1' }), span({ spanId: 's2' })],
    summarizedSpanIds: ['s1'],
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s2']);
});

test('oldest-first by startedAt ascending', () => {
  const out = decideSpansToSummarize({
    spans: [
      span({ spanId: 'late', startedAt: '2026-05-16T03:00:00.000Z' }),
      span({ spanId: 'early', startedAt: '2026-05-16T01:00:00.000Z' }),
      span({ spanId: 'mid', startedAt: '2026-05-16T02:00:00.000Z' }),
    ],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['early', 'mid', 'late']);
});

test('spanId ascending tiebreak when startedAt equal', () => {
  const t = '2026-05-16T01:00:00.000Z';
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 'zzz', startedAt: t }), span({ spanId: 'aaa', startedAt: t }), span({ spanId: 'mmm', startedAt: t })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['aaa', 'mmm', 'zzz']);
});

test('unparseable startedAt sorts as 0 and never throws', () => {
  const out = decideSpansToSummarize({
    spans: [span({ spanId: 'good', startedAt: '2026-05-16T01:00:00.000Z' }), span({ spanId: 'bad', startedAt: 'not-a-date' })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['bad', 'good']);
});

test('non-object / missing-spanId entries are skipped, no throw', () => {
  const out = decideSpansToSummarize({
    spans: [null, undefined, 42, 'x', { closed: true }, span({ spanId: 's1' })],
    summarizedSpanIds: new Set(),
  });
  assert.deepEqual(out.map((s) => s.spanId), ['s1']);
});

test('deterministic: identical input yields deep-equal output', () => {
  const mk = () => ({
    spans: [span({ spanId: 'b', startedAt: '2026-05-16T02:00:00.000Z' }), span({ spanId: 'a', startedAt: '2026-05-16T01:00:00.000Z' })],
    summarizedSpanIds: new Set(['x']),
  });
  assert.deepEqual(decideSpansToSummarize(mk()), decideSpansToSummarize(mk()));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.decide.test.js`
Expected: FAIL — cannot resolve `../src/runtime/spanSummary/index.js`.

- [ ] **Step 3: Create the index re-export**

Create `src/runtime/spanSummary/index.js`:

```javascript
export { decideSpansToSummarize } from './decideSpansToSummarize.js';
```

- [ ] **Step 4: Create the pure core**

Create `src/runtime/spanSummary/decideSpansToSummarize.js`:

```javascript
// Pure span-summary decision (Readability Layer-2 P3a). Zero imports,
// JSX-free, server-importable — the eventNarration/spanDetection
// pure-core discipline. Answers: given the current spans + the spanIds
// already summarized, which CLOSED spans still need a summary, oldest
// first? Reads the LIVE Span.startedAt (distinct from the persisted
// span_started_at snapshot column — do not conflate).

/**
 * @param {{ spans?: Array<object>, summarizedSpanIds?: Set<string>|Array<string> }} [input]
 * @returns {Array<object>} the closed, not-yet-summarized spans, oldest-first
 */
export function decideSpansToSummarize(input) {
  const arg = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(arg.spans) ? arg.spans : [];
  const sid = arg.summarizedSpanIds;
  const done = sid instanceof Set ? sid : new Set(Array.isArray(sid) ? sid : []);

  const eligible = list.filter(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof s.spanId === 'string' &&
      s.closed === true &&
      !done.has(s.spanId),
  );

  return eligible.slice().sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    if (na !== nb) return na - nb;
    if (a.spanId < b.spanId) return -1;
    if (a.spanId > b.spanId) return 1;
    return 0;
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.decide.test.js`
Expected: PASS — 9 tests, all green, output pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 1)**

---

## Task 2: Purity guard suite

**Files:** Create `test/spanSummary.purity.test.js`.

- [ ] **Step 1: Write the purity guard suite**

Create `test/spanSummary.purity.test.js` (models `test/spanDetection.purity.test.js`):

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideSpansToSummarize } from '../src/runtime/spanSummary/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'spanSummary');

test('spanSummary module imports no node:/fs/path/os/child_process/react, no JSX, never touches process', () => {
  for (const f of ['decideSpansToSummarize.js', 'index.js']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports a node: builtin`);
    assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), `${f} imports a node core module`);
    assert.ok(!/from\s+['"]react/.test(src), `${f} imports react`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
    assert.ok(!/(return|=>)\s*<[A-Za-z]/.test(src) && !/<\/[A-Za-z]/.test(src), `${f} contains JSX`);
  }
});

test('decideSpansToSummarize is callable and total on garbage input', () => {
  assert.deepEqual(decideSpansToSummarize(null), []);
  assert.deepEqual(decideSpansToSummarize({ spans: 'nope', summarizedSpanIds: 7 }), []);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.purity.test.js`
Expected: PASS (2 tests). Invariant guard over the Task-1 module (the `spanDetection.purity` precedent — no red phase of its own).

- [ ] **Step 3: (no commit — accumulates toward Commit 1)**

---

## Task 3: `SqliteSpanSummaryStore` + `span_summaries` schema

**Files:** Modify `src/storage/schema.sql`; Create `src/runtime/sqliteSpanSummaryStore.js`; Test `test/sqliteSpanSummaryStore.test.js`.

- [ ] **Step 1: Write the failing store suite**

Create `test/sqliteSpanSummaryStore.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteSpanSummaryStore } from '../src/runtime/sqliteSpanSummaryStore.js';

function baseInput(o = {}) {
  return {
    spanId: 'span-n1', teamId: 'team-a', runtimeId: 'rt-1', agentId: 'dev-1',
    sessionId: 's1', summaryText: 'agent read a.js then ran tests',
    model: 'haiku', cli: 'claude',
    spanStartedAt: '2026-05-16T00:00:00.000Z', spanEndedAt: '2026-05-16T00:00:30.000Z',
    rowCount: 3, tokens: 42, ...o,
  };
}

test('appendSummary inserts and listSummaries returns it', () => {
  const s = new SqliteSpanSummaryStore();
  const { inserted, row } = s.appendSummary(baseInput());
  assert.equal(inserted, true);
  assert.equal(row.spanId, 'span-n1');
  assert.equal(typeof row.summaryId, 'string');
  const list = s.listSummaries({ teamId: 'team-a' });
  assert.equal(list.length, 1);
  assert.equal(list[0].spanId, 'span-n1');
  assert.equal(list[0].summaryText, 'agent read a.js then ran tests');
  assert.equal(list[0].model, 'haiku');
  assert.equal(list[0].cli, 'claude');
  assert.equal(list[0].rowCount, 3);
  assert.equal(list[0].tokens, 42);
  s.close();
});

test('appendSummary is idempotent by spanId: first-write-wins, never overwrites', () => {
  const s = new SqliteSpanSummaryStore();
  const first = s.appendSummary(baseInput({ summaryText: 'ORIGINAL' }));
  assert.equal(first.inserted, true);
  const second = s.appendSummary(baseInput({ summaryText: 'DIFFERENT — must be ignored', model: 'sonnet' }));
  assert.equal(second.inserted, false);
  assert.equal(second.row.summaryText, 'ORIGINAL');
  assert.equal(second.row.model, 'haiku');
  const list = s.listSummaries({ teamId: 'team-a' });
  assert.equal(list.length, 1);
  assert.equal(list[0].summaryText, 'ORIGINAL');
  assert.equal(list[0].model, 'haiku');
  s.close();
});

test('#ensureTeam: append without pre-creating the team succeeds (FK satisfied)', () => {
  const s = new SqliteSpanSummaryStore();
  const { inserted } = s.appendSummary(baseInput({ teamId: 'brand-new-team' }));
  assert.equal(inserted, true);
  assert.equal(s.listSummaries({ teamId: 'brand-new-team' }).length, 1);
  s.close();
});

test('listSummaries scopes by runtimeId and orders created_at ASC, summary_id ASC', () => {
  const s = new SqliteSpanSummaryStore();
  s.appendSummary(baseInput({ spanId: 'span-a', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:01.000Z' }));
  s.appendSummary(baseInput({ spanId: 'span-b', runtimeId: 'rt-2', createdAt: '2026-05-16T00:00:02.000Z' }));
  s.appendSummary(baseInput({ spanId: 'span-c', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:03.000Z' }));
  assert.deepEqual(s.listSummaries({ teamId: 'team-a' }).map((r) => r.spanId), ['span-a', 'span-b', 'span-c']);
  assert.deepEqual(s.listSummaries({ teamId: 'team-a', runtimeId: 'rt-1' }).map((r) => r.spanId), ['span-a', 'span-c']);
  s.close();
});

test('required fields rejected with TypeError; optionals null-tolerant; createdAt defaults', () => {
  const s = new SqliteSpanSummaryStore();
  for (const bad of ['spanId', 'teamId', 'runtimeId', 'agentId', 'summaryText', 'spanStartedAt', 'spanEndedAt']) {
    assert.throws(() => s.appendSummary(baseInput({ [bad]: '' })), TypeError, `empty ${bad} must throw`);
  }
  assert.throws(() => s.appendSummary(baseInput({ rowCount: 'three' })), TypeError, 'non-number rowCount must throw');
  const { row } = s.appendSummary(baseInput({ spanId: 'span-opt', sessionId: null, model: null, cli: null, tokens: null }));
  assert.equal(row.sessionId, null);
  assert.equal(row.model, null);
  assert.equal(row.cli, null);
  assert.equal(row.tokens, null);
  assert.equal(typeof row.createdAt, 'string');
  assert.ok(row.createdAt.length > 0);
  s.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/sqliteSpanSummaryStore.test.js`
Expected: FAIL — cannot resolve `../src/runtime/sqliteSpanSummaryStore.js`.

- [ ] **Step 3: Add the `span_summaries` table to `schema.sql`**

In `src/storage/schema.sql`, immediately AFTER the line
`CREATE INDEX IF NOT EXISTS idx_narrated_lines_team ON narrated_lines(team_id, created_at);`
(the last narrated_lines index, before the blank line and `CREATE TABLE IF NOT EXISTS task_events`), insert:

```sql

CREATE TABLE IF NOT EXISTS span_summaries (
  summary_id      TEXT PRIMARY KEY,
  span_id         TEXT NOT NULL UNIQUE,
  team_id         TEXT NOT NULL,
  runtime_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  session_id      TEXT,
  summary_text    TEXT NOT NULL,
  model           TEXT,
  cli             TEXT,
  span_started_at TEXT NOT NULL,
  span_ended_at   TEXT NOT NULL,
  row_count       INTEGER NOT NULL,
  tokens          INTEGER,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_span_summaries_team ON span_summaries(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_span_summaries_runtime ON span_summaries(runtime_id, created_at);
```

Do NOT add anything to `applyMigrations` in `src/storage/sqlite.js` — `schema.sql` is `db.exec`'d on every `openToadDatabase`, so this new table is created on existing DBs at next open (a new *table* needs no migration; only new *columns* do — per the `sqlite.js:31-36` comment).

- [ ] **Step 4: Create the store**

Create `src/runtime/sqliteSpanSummaryStore.js` (mirrors `src/runtime/sqliteNarrationStore.js` structure verbatim, idempotency keyed by `span_id`):

```javascript
import { randomUUID } from 'node:crypto';
import { openToadDatabase } from '../storage/sqlite.js';

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

/**
 * Durable projection of P3b's per-span summaries — mirrors
 * SqliteNarrationStore (own connection, ensure-team FK, idempotent
 * append). One row per CLOSED span; idempotency key is span_id
 * (closed spans are content-stable, so first-write-wins is correct).
 */
export class SqliteSpanSummaryStore {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  #ensureTeam(teamId) {
    this.db.prepare(
      `
        INSERT INTO teams (team_id, display_name, created_at)
        VALUES (?, NULL, ?)
        ON CONFLICT(team_id) DO NOTHING
      `
    ).run(teamId, new Date().toISOString());
  }

  #getBySpanId(spanId) {
    const row = this.db
      .prepare('SELECT * FROM span_summaries WHERE span_id = ?')
      .get(spanId);
    return row ? this.#rowToSummary(row) : null;
  }

  #rowToSummary(row) {
    return {
      summaryId: row.summary_id,
      spanId: row.span_id,
      teamId: row.team_id,
      runtimeId: row.runtime_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      summaryText: row.summary_text,
      model: row.model,
      cli: row.cli,
      spanStartedAt: row.span_started_at,
      spanEndedAt: row.span_ended_at,
      rowCount: row.row_count,
      tokens: row.tokens,
      createdAt: row.created_at,
    };
  }

  appendSummary(input) {
    const spanId = requireString(input.spanId, 'spanId');
    const existing = this.#getBySpanId(spanId);
    if (existing) return { inserted: false, row: existing };

    const row = {
      summaryId: randomUUID(),
      spanId,
      teamId: requireString(input.teamId, 'teamId'),
      runtimeId: requireString(input.runtimeId, 'runtimeId'),
      agentId: requireString(input.agentId, 'agentId'),
      sessionId:
        typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      summaryText: requireString(input.summaryText, 'summaryText'),
      model: typeof input.model === 'string' && input.model ? input.model : null,
      cli: typeof input.cli === 'string' && input.cli ? input.cli : null,
      spanStartedAt: requireString(input.spanStartedAt, 'spanStartedAt'),
      spanEndedAt: requireString(input.spanEndedAt, 'spanEndedAt'),
      rowCount: requireFiniteNumber(input.rowCount, 'rowCount'),
      tokens:
        typeof input.tokens === 'number' && Number.isFinite(input.tokens) ? input.tokens : null,
      createdAt: input.createdAt || new Date().toISOString(),
    };
    this.#ensureTeam(row.teamId);
    this.db.prepare(
      `
        INSERT INTO span_summaries (
          summary_id, span_id, team_id, runtime_id, agent_id, session_id,
          summary_text, model, cli, span_started_at, span_ended_at,
          row_count, tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      row.summaryId, row.spanId, row.teamId, row.runtimeId, row.agentId, row.sessionId,
      row.summaryText, row.model, row.cli, row.spanStartedAt, row.spanEndedAt,
      row.rowCount, row.tokens, row.createdAt
    );
    return { inserted: true, row };
  }

  listSummaries({ teamId, runtimeId = null } = {}) {
    const team = requireString(teamId, 'teamId');
    if (runtimeId) {
      return this.db
        .prepare('SELECT * FROM span_summaries WHERE team_id = ? AND runtime_id = ? ORDER BY created_at ASC, summary_id ASC')
        .all(team, runtimeId)
        .map((r) => this.#rowToSummary(r));
    }
    return this.db
      .prepare('SELECT * FROM span_summaries WHERE team_id = ? ORDER BY created_at ASC, summary_id ASC')
      .all(team)
      .map((r) => this.#rowToSummary(r));
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/sqliteSpanSummaryStore.test.js`
Expected: PASS — 5 tests, all green, output pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 1)**

---

## Task 4: Wire Commit-1 suites + full root fail-0 + **Commit 1**

**Files:** Modify `package.json`.

- [ ] **Step 1: Append the 3 Commit-1 suites to `scripts.test`**

In `package.json`, `scripts.test` currently ends with:
`&& node --no-warnings --test test/localToadRuntime.spanDetection.test.js"`

Append (leading space; one line; before the closing `"`):

```
 && node --no-warnings --test test/spanSummary.decide.test.js && node --no-warnings --test test/spanSummary.purity.test.js && node --no-warnings --test test/sqliteSpanSummaryStore.test.js
```

Validate:

Run: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log(['spanSummary.decide','spanSummary.purity','sqliteSpanSummaryStore'].every(s=>t.includes(s)))"`
Expected: `true`

- [ ] **Step 2: Full root suite — fail 0, all 3 P3a-Commit-1 suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test > /tmp/p3a_c1.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`

Run: `grep -E "^# (pass|fail)" /tmp/p3a_c1.log | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0` (and `pass` strictly greater than the pre-P3a baseline of 1470).

Run: `grep -cE "spanSummary module imports no node:|already-summarized spanIds are excluded \\(Set\\)|appendSummary is idempotent by spanId: first-write-wins" /tmp/p3a_c1.log`
Expected: `>= 3` (the 3 P3a-Commit-1 suites genuinely ran — the un-wired-test trap).

- [ ] **Step 3: Commit 1**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/spanSummary/decideSpansToSummarize.js toad-local/src/runtime/spanSummary/index.js toad-local/src/runtime/sqliteSpanSummaryStore.js toad-local/src/storage/schema.sql toad-local/test/spanSummary.decide.test.js toad-local/test/spanSummary.purity.test.js toad-local/test/sqliteSpanSummaryStore.test.js toad-local/package.json
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(spans): durable span_summaries store + pure decideSpansToSummarize core (Readability Layer-2 P3a, Commit 1)

New SqliteSpanSummaryStore mirroring sqliteNarrationStore: idempotent
appendSummary keyed by span_id (first-write-wins, never overwrites —
closed spans are content-stable), #ensureTeam FK, listSummaries
(created_at ASC, summary_id ASC, runtimeId-scopable). span_summaries
table added to schema.sql (CREATE TABLE IF NOT EXISTS — new table needs
no applyMigrations entry; created on existing DBs via the schema re-run)
with UNIQUE span_id + FK team_id->teams + P3b-ready columns
(summary_text/model/cli + span snapshot). New pure zero-import
src/runtime/spanSummary/decideSpansToSummarize core: closed-only,
dedupe vs summarizedSpanIds (Set|array), oldest-first by live
Span.startedAt + spanId tiebreak, NaN-safe, total. TDD unit + purity +
store suites; wired; root fail 0. Greenfield, not a refactor. No
production writer yet (P3b first).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -1
```

---

## Task 5: Read-model + runtime exposure (compute-on-read; single-site guard)

**Files:** Modify `src/read/LocalReadModel.js`; Modify `src/app/LocalToadRuntime.js`; Test `test/localToadRuntime.spanSummary.test.js`.

- [ ] **Step 1: Write the failing wiring + e2e suite**

Create `test/localToadRuntime.spanSummary.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalReadModel } from '../src/read/LocalReadModel.js';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

const brokerStub = { listMessages: () => [] };

test('LocalReadModel.listSpanSummaries returns [] when no spanSummaryStore', () => {
  const rm = new LocalReadModel({ broker: brokerStub });
  assert.deepEqual(rm.listSpanSummaries({ teamId: 'team-a' }), []);
});

test('LocalReadModel.listSpanSummaries delegates to the store', () => {
  const calls = [];
  const spanSummaryStore = {
    listSummaries(arg) { calls.push(arg); return [{ spanId: 'span-n1', summaryText: 'x' }]; },
  };
  const rm = new LocalReadModel({ broker: brokerStub, spanSummaryStore });
  const out = rm.listSpanSummaries({ teamId: 'team-a', runtimeId: 'rt-1' });
  assert.deepEqual(out, [{ spanId: 'span-n1', summaryText: 'x' }]);
  assert.deepEqual(calls, [{ teamId: 'team-a', runtimeId: 'rt-1' }]);
});

test('listSpansAwaitingSummary composes listSpans + listSpanSummaries; teamId validated via delegation', () => {
  // One closed span via the narration store stub (tool row then a system row).
  const narrationStore = {
    listNarration: () => [
      { narrationId: 'n1', eventId: 'e1', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'tool_use', createdAt: '2026-05-16T00:00:00.000Z', line: 'Reading a.js', kind: 'tool', tokens: 3 },
      { narrationId: 'n2', eventId: 'e2', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'turn_completed', createdAt: '2026-05-16T00:00:05.000Z', line: 'Turn complete', kind: 'system', tokens: null },
    ],
  };
  let summaries = [];
  const spanSummaryStore = { listSummaries: () => summaries };
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore, spanSummaryStore });

  const awaiting = rm.listSpansAwaitingSummary({ teamId: 'team-a' });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0].closed, true);
  const spanId = awaiting[0].spanId;

  summaries = [{ spanId }];
  assert.deepEqual(rm.listSpansAwaitingSummary({ teamId: 'team-a' }), []);

  assert.throws(() => rm.listSpansAwaitingSummary({}), /teamId/);
});

test('LocalToadRuntime round-trips: persist closed-span narration -> awaiting -> appendSummary -> excluded', async () => {
  const rt = new LocalToadRuntime();
  // §8d-ratified P2b path: tool_use for an UNREGISTERED runtime persists
  // the narration (#persistNarration runs before the tool_use identity
  // check) then ingest throws; tolerate only the known identity error.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-p3a', teamId: 'team-p3a', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  // turn_completed (kind:system) closes the span; takes the early return
  // (no identity check) so this ingest does not throw.
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-p3a', teamId: 'team-p3a', agentId: 'lead',
    createdAt: '2026-05-16T00:00:05.000Z', raw: {},
  });

  const awaiting = rt.listSpansAwaitingSummary({ teamId: 'team-p3a' });
  assert.equal(awaiting.length, 1, 'one closed span awaiting summary');
  const span = awaiting[0];
  assert.equal(span.closed, true);

  rt.spanSummaryStore.appendSummary({
    spanId: span.spanId, teamId: span.teamId, runtimeId: span.runtimeId, agentId: span.agentId,
    sessionId: span.sessionId, summaryText: 'agent read a.js', model: 'haiku', cli: 'claude',
    spanStartedAt: span.startedAt, spanEndedAt: span.endedAt, rowCount: span.rowCount, tokens: span.tokens,
  });

  assert.deepEqual(rt.listSpansAwaitingSummary({ teamId: 'team-p3a' }), [], 'summarized span no longer awaiting');
  const summaries = rt.listSpanSummaries({ teamId: 'team-p3a' });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].spanId, span.spanId);
  assert.equal(summaries[0].summaryText, 'agent read a.js');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.spanSummary.test.js`
Expected: FAIL — `rm.listSpanSummaries is not a function` / `rt.listSpansAwaitingSummary is not a function`.

- [ ] **Step 3: Wire `LocalReadModel.js`**

(a) Add the import immediately AFTER the existing line 7 `import { detectSpans, DEFAULT_SPAN_CONFIG } from '../runtime/spanDetection/index.js';`:

```javascript
import { decideSpansToSummarize } from '../runtime/spanSummary/index.js';
```

(b) In the constructor: add `spanSummaryStore = null,` to the destructured options (immediately after the existing `narrationStore = null,`), and add the assignment `this.spanSummaryStore = spanSummaryStore;` immediately after the existing `this.narrationStore = narrationStore;`.

(c) Immediately AFTER the `listSpans({ teamId, runtimeId = null }) { … }` method (it ends at line 114, before `listApprovals`), insert these two methods. `listSpanSummaries` mirrors the `listNarratedTimeline` guard shape; `listSpansAwaitingSummary` DELEGATES to the already-guarded `listSpans`/`listSpanSummaries` — NO duplicated `requireString`/absent-store guard (a second guard here is the over-reach defect):

```javascript
  listSpanSummaries({ teamId, runtimeId = null }) {
    if (!this.spanSummaryStore || typeof this.spanSummaryStore.listSummaries !== 'function') return [];
    return this.spanSummaryStore.listSummaries({ teamId: requireString(teamId, 'teamId'), runtimeId });
  }

  listSpansAwaitingSummary({ teamId, runtimeId = null }) {
    return decideSpansToSummarize({
      spans: this.listSpans({ teamId, runtimeId }),
      summarizedSpanIds: new Set(this.listSpanSummaries({ teamId, runtimeId }).map((s) => s.spanId)),
    });
  }
```

> `listSpansAwaitingSummary` does NOT call `requireString` or guard the stores itself: `listSpans` already `requireString`s `teamId` (and `listSpanSummaries` guards the absent store + `requireString`s `teamId`). Duplicating either is wrong — a reviewer adding a second guard is over-reach; reject it.

- [ ] **Step 4: Wire `LocalToadRuntime.js`**

(a) Add the import immediately AFTER line 13 `import { SqliteNarrationStore } from '../runtime/sqliteNarrationStore.js';`:

```javascript
import { SqliteSpanSummaryStore } from '../runtime/sqliteSpanSummaryStore.js';
```

(b) In the constructor options destructure, add `spanSummaryStore = null,` immediately after the existing `narrationStore = null,` (line 74).

(c) Immediately AFTER line 132 `this.narrationStore = narrationStore || new SqliteNarrationStore({ filePath: dbPath });` add:

```javascript
    this.spanSummaryStore = spanSummaryStore || new SqliteSpanSummaryStore({ filePath: dbPath });
```

(d) In the `new LocalReadModel({ … })` call (lines 190-197), add `spanSummaryStore: this.spanSummaryStore,` immediately after the existing `narrationStore: this.narrationStore,` line. (Do NOT modify the `RuntimeEventIngestor` construction at line ~317 — that is a different consumer; P3a's store is not written by the ingestor.)

(e) In `close()`, add `closeIfSupported(this.spanSummaryStore);` immediately after line 821 `closeIfSupported(this.narrationStore);`.

(f) Immediately AFTER the `listSpans(input) { return this.readModel.listSpans(input); }` method, add the two delegations:

```javascript
  listSpanSummaries(input) {
    return this.readModel.listSpanSummaries(input);
  }

  listSpansAwaitingSummary(input) {
    return this.readModel.listSpansAwaitingSummary(input);
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.spanSummary.test.js`
Expected: PASS — 4 tests, all green, output pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 2)**

---

## Task 6: Wire the 4th suite + full gates + whole-impl review

**Files:** Modify `package.json`.

- [ ] **Step 1: Append the e2e suite to `scripts.test`**

In `package.json`, `scripts.test` now ends with:
`&& node --no-warnings --test test/sqliteSpanSummaryStore.test.js"`

Append (leading space; before the closing `"`):

```
 && node --no-warnings --test test/localToadRuntime.spanSummary.test.js
```

Validate:

Run: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log(['spanSummary.decide','spanSummary.purity','sqliteSpanSummaryStore','localToadRuntime.spanSummary'].every(s=>t.includes(s)))"`
Expected: `true`

- [ ] **Step 2: Full root suite — fail 0, ALL 4 P3a suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test > /tmp/p3a_c2.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`

Run: `grep -E "^# (pass|fail)" /tmp/p3a_c2.log | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`

Run: `grep -cE "spanSummary module imports no node:|already-summarized spanIds are excluded \\(Set\\)|appendSummary is idempotent by spanId: first-write-wins|LocalToadRuntime round-trips: persist closed-span narration" /tmp/p3a_c2.log`
Expected: `>= 4` (all 4 P3a suite titles genuinely present in this run — the un-wired-test trap; never trust a pasted number, the controller re-runs and greps its own output).

- [ ] **Step 3: Whole-implementation review (pre-commit gate)**

Review the entire P3a surface (Commit-1 core + Commit-2 exposure) as one unit: `decideSpansToSummarize` matches spec §3 (closed-only, dedupe via Set|array, oldest-first `Date.parse(startedAt)`+spanId NaN-safe, total, zero-import); `SqliteSpanSummaryStore` mirrors `sqliteNarrationStore` (the `#ensureTeam` SQL, idempotency check-before-insert returning `{inserted:false,row}`, `requireString`, `#rowToSummary` snake→camel) and idempotency is **first-write-wins by `span_id`, never overwrites even with different `summaryText`**; the `span_summaries` DDL is in `schema.sql` with `UNIQUE span_id` + `FOREIGN KEY (team_id) REFERENCES teams(team_id)` and there is NO `applyMigrations` entry; `LocalReadModel.listSpansAwaitingSummary` DELEGATES (no duplicated guard); `LocalToadRuntime` constructs/passes/closes the store and the runtime delegations are one-liners; the decide core reads the live `Span.startedAt` (not renamed to the persisted `spanStartedAt`); **no out-of-scope change** (no P1 narration / P2a composeTimeline / P2b detectSpans / drift / live-timeline change; no P3b spawn/LLM/routing; no P3c surfacing; the `RuntimeEventIngestor` at LocalToadRuntime:317 untouched); the 4 suites genuinely execute under `npm test` with substantive assertions; dormant-but-non-inert (no production writer yet AND the e2e round-trip genuinely persists→decides→excludes through the real `LocalToadRuntime`, not a stub — the accepted P1/P2b pattern). Resolve any finding before committing.

- [ ] **Step 4: (no commit — Task 6 accumulates; Task 7 commits)**

---

## Task 7: **Commit 2** + post-commit verify

- [ ] **Step 1: Commit 2 (exactly these 4 files)**

```bash
git -C /c/Project-TOAD add toad-local/src/read/LocalReadModel.js toad-local/src/app/LocalToadRuntime.js toad-local/test/localToadRuntime.spanSummary.test.js toad-local/package.json
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(spans): compute-on-read listSpanSummaries + listSpansAwaitingSummary (Readability Layer-2 P3a, Commit 2)

LocalToadRuntime constructs this.spanSummaryStore (mirrors the
narrationStore line, shared db) and passes it to LocalReadModel;
closeIfSupported on close. LocalReadModel.listSpanSummaries mirrors the
listNarratedTimeline guard+delegate; listSpansAwaitingSummary =
decideSpansToSummarize({ spans: listSpans(...), summarizedSpanIds:
Set(listSpanSummaries(...).spanId) }) — composes the already-guarded
reads, single-site guard, NO duplicated requireString/absent-store
guard. One-line runtime delegations adjacent to listSpans. e2e
round-trip suite proves persist closed-span narration -> awaiting ->
appendSummary -> excluded through the real LocalToadRuntime (the
§8d-ratified P2b unregistered-runtime ingestion path). Dormant — no
production writer yet (P3b first), exactly as listSpans shipped. Wiring
suite wired; root fail 0; all 4 P3a suites executed; whole-impl
reviewed. Out: P3b runner/routing/breaker/degradation, P3c surfacing,
any P1/P2a/P2b/timeline/drift change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 2: Post-commit verify**

Run: `git -C /c/Project-TOAD show --stat HEAD`
Expected: exactly 4 files — `toad-local/src/read/LocalReadModel.js`, `toad-local/src/app/LocalToadRuntime.js`, `toad-local/test/localToadRuntime.spanSummary.test.js`, `toad-local/package.json`. No stray files (esp. NOT the `RuntimeEventIngestor.js`, narration/composeTimeline/detectSpans, or any UI/drift file).

Run: `git -C /c/Project-TOAD diff --stat 151cb53 HEAD -- toad-local/src/runtime/sqliteNarrationStore.js toad-local/src/runtime/eventNarration toad-local/src/runtime/spanDetection toad-local/src/runtime/timelineComposition toad-local/src/runtime/RuntimeEventIngestor.js toad-local/ui toad-local/src/drift`
(`151cb53` is the committed P3a spec — the last repository state before any P3a code/plan; the intervening plan-doc + Commit 1/2 must not touch these out-of-scope paths.)
Expected: EMPTY — P3a touched nothing in narration persistence, eventNarration, detectSpans, composeTimeline, the ingestor, the UI, or drift (the out-of-scope guarantee).

Run: `git -C /c/Project-TOAD status --porcelain | grep -E 'spanSummary|sqliteSpanSummaryStore' || echo "(clean of P3a feature files)"`
Expected: `(clean of P3a feature files)` — every P3a artifact committed.

Run: `git -C /c/Project-TOAD log --oneline -2`
Expected: HEAD = Commit 2; HEAD~1 = Commit 1 (`feat(spans): durable span_summaries store + pure decideSpansToSummarize core …`). (No ratification commits expected for P3a unless a §8d pin proved wrong at implementation time and was pre-emptively ratified — in which case HEAD~1 is that ratification doc and Commit 1 is one further back; the invariant that matters is both feature commits present and the out-of-scope diff empty.)

---

## Notes for the executor (read before starting)

- **TDD is mandatory.** Every code task writes the test first, runs it to watch it FAIL for the expected reason, then minimal implementation, then runs it PASS. The purity suite is an *invariant guard* (the `spanDetection.purity` precedent) — it may be green on first run; that is acceptable and noted in its task.
- **Greenfield, not a refactor.** No pristine logic, no frozen golden / capture script. Do not invent one.
- **Mirror `sqliteNarrationStore.js` verbatim** where the structure applies (ctor, `#ensureTeam`, idempotency flow, `requireString`, `#rowTo*`, `close()`, list query). The store code is given in full in Task 3 — type it exactly.
- **Idempotency is first-write-wins by `span_id`.** A duplicate `appendSummary` (even with different `summaryText`/`model`) returns the STORED row unchanged and never overwrites. The Task-3 test pins this; do not weaken it.
- **`schema.sql` only — no `applyMigrations` entry** for the new table. If at implementation time `schema.sql` is NOT `db.exec`'d on every `openToadDatabase` (contradicting the grounded `sqlite.js:26` fact), STOP and surface for ratification (§8d).
- **DRY single-site guard.** `listSpansAwaitingSummary` delegates to the guarded `listSpans`/`listSpanSummaries`. A reviewer adding a second `requireString`/absent-store guard in it is over-reach — reject it (the P2b lesson).
- **`Span.startedAt` ≠ `spanStartedAt`.** The pure core sorts the live `Span.startedAt`; the store persists `span_started_at`/`spanStartedAt`. Distinct layers, distinct names — do not "rename to match".
- **Do NOT touch `RuntimeEventIngestor`** (`LocalToadRuntime.js:317`) or any P1/P2a/P2b/drift/UI file. P3a is purely additive.
- **Never trust a pasted test number.** The controller independently re-runs the full root suite and greps the P3a suite titles in its OWN output at both commit boundaries (the P2a/P2b un-wired-test trap), reconciling the pass-count delta.
- **Commit hygiene.** Tasks accumulate uncommitted; ONLY Task 4 (Commit 1) and Task 7 (Commit 2) `git commit`. Commit directly to `main`; `git -c commit.gpgsign=false` (the established session accommodation). The `LF will be replaced by CRLF` warning on `git add` is benign Windows autocrlf — do not "fix" it.
- **§8d STOP rule** applies throughout: a wrong grounded pin → STOP and surface for controller pre-emptive ratification, do not code around it.
