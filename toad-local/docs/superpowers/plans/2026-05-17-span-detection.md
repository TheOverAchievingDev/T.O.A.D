# Span Detection (Readability Layer-2 P2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, server-importable module that groups the persisted narrated stream into single-agent activity spans, exposed via a compute-on-read `listSpans`, so P3's summarizer has bounded self-contained units to summarize.

**Architecture:** New zero-import pure core `src/runtime/spanDetection/` (`detectSpans.js` + `index.js`, sealed `SPAN_BOUNDARY_REASONS`, frozen `DEFAULT_SPAN_CONFIG`) — same lineage as `eventNarration`/`timelineComposition`. A thin compute-on-read `LocalReadModel.listSpans` / `LocalToadRuntime.listSpans` derives spans from `listNarratedTimeline` each call. No table. Purely additive — no consumer yet (P3 is first).

**Tech Stack:** Node ≥20 ESM, `node:test`, the project's pure-core + sealed-enum + injected-config discipline. Greenfield → TDD + purity + fixture-coverage (NOT a preservation refactor — no capture-script/frozen-golden).

**Spec:** `docs/superpowers/specs/2026-05-16-span-detection-design.md` (committed `46725cd`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/spanDetection/detectSpans.js` (create) | Pure `detectSpans(rows, config)`; sealed `SPAN_BOUNDARY_REASONS`; frozen `DEFAULT_SPAN_CONFIG`. Zero imports, JSX-free, total. |
| `src/runtime/spanDetection/index.js` (create) | Re-export (the ESM-index pattern, mirrors `eventNarration/index.js`). |
| `test/spanDetection.detectSpans.test.js` (create) | TDD unit suite — every boundary reason, open/closed, caps, edges, determinism. |
| `test/spanDetection.purity.test.js` (create) | Purity guard (no node:/fs/path/os/child_process/react/JSX/process) + sealed/frozen runtime assertions. |
| `test/fixtures/spanDetection.input.json` (create) | Committed case fixture. |
| `test/spanDetection.fixtureCoverage.test.js` (create) | Asserts the fixture genuinely exercises every reason + open + empty + all-system + text-only + single-oversized. |
| `src/read/LocalReadModel.js` (modify) | Add `listSpans` adjacent to `listNarratedTimeline` (line 106) + the import. |
| `src/app/LocalToadRuntime.js` (modify) | Add `listSpans(input)` delegation adjacent to `listNarratedTimeline` (line 792-794). |
| `test/localToadRuntime.spanDetection.test.js` (create) | Compute-on-read wiring tests (absent-store → []; pass-through; e2e). |
| `package.json` (modify) | Wire the 4 new suites into `scripts.test` (3 in Commit 1, the 4th in Commit 2). |

**Commit decomposition (2 atomic commits):**
- **Commit 1 (Tasks 1–4):** the pure core + its 3 test suites + fixture, 3 suites wired, full root fail 0. Self-contained working software.
- **Commit 2 (Tasks 5–7):** the compute-on-read exposure + its wiring test, 4th suite wired, full root fail 0 + grep all 4 P2b titles in own npm output, whole-impl review, Commit 2 + post-commit verify.

Tasks within a commit accumulate **uncommitted**; only the commit-boundary task (Task 4, Task 7) commits.

---

## §8d Grounded pins (verified against shipped code; do not re-invent)

- `LocalReadModel.listNarratedTimeline` is at `src/read/LocalReadModel.js:103-106`:
  ```js
  listNarratedTimeline({ teamId, runtimeId = null }) {
    if (!this.narrationStore || typeof this.narrationStore.listNarration !== 'function') return [];
    return this.narrationStore.listNarration({ teamId: requireString(teamId, 'teamId'), runtimeId });
  }
  ```
  `listApprovals` follows at line 108. `requireString` is already in scope (used file-wide; no import needed). Insert `listSpans` between them.
- `LocalReadModel.js` imports siblings at one-`../` depth (`import { … } from '../protocol/crossTeam.js';` at lines 1-6). Therefore the spanDetection import is **`'../runtime/spanDetection/index.js'`** (`src/read/` → `src/` → `runtime/spanDetection/`). Grounded against the existing crossTeam import depth — not invented.
- `LocalToadRuntime.listNarratedTimeline` is at `src/app/LocalToadRuntime.js:792-794`:
  ```js
  listNarratedTimeline(input) {
    return this.readModel.listNarratedTimeline(input);
  }
  ```
  `listToolCalls` follows at 796. Insert `listSpans(input)` adjacent.
- `eventNarration/index.js` is exactly `export { narrate, NARRATION_KINDS } from './narrate.js';` — mirror this shape.
- The `NARRATION_KINDS` seal IIFE in `src/runtime/eventNarration/narrate.js:10-17` is the verbatim pattern to copy for `SPAN_BOUNDARY_REASONS` (`Object.freeze(new Set(...))` does NOT make `.add()` throw on Node v22; seal via own throwing `add`/`delete`/`clear`).
- `SqliteNarrationStore` (`src/runtime/sqliteNarrationStore.js`): constructor `{ filePath = ':memory:', db = null }`; `appendNarration(input)` requires non-empty `runtimeId,teamId,agentId,eventType,kind`, accepts `eventId,sessionId,createdAt,line,tokens,idempotencyKey`; `listNarration({ teamId, runtimeId = null })` returns rows shaped `{ narrationId, idempotencyKey, eventId, runtimeId, teamId, agentId, sessionId, eventType, createdAt, line, kind, tokens }` ordered `created_at ASC, narration_id ASC`. `created_at` is the ISO string `appendNarration` writes (`input.createdAt || new Date().toISOString()`).
- **§8d STOP rule:** if any pin above is wrong at implementation time (row shape, kind set, delegation pattern, import depth, seal behavior), STOP and surface for controller pre-emptive ratification (auth/compaction/narration/P2a precedent). Do not code around a wrong plan.

---

## Task 1: Pure `detectSpans` core + sealed reasons + frozen config

**Files:**
- Create: `src/runtime/spanDetection/detectSpans.js`
- Create: `src/runtime/spanDetection/index.js`
- Test: `test/spanDetection.detectSpans.test.js`

- [ ] **Step 1: Write the failing unit suite**

Create `test/spanDetection.detectSpans.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSpans, SPAN_BOUNDARY_REASONS, DEFAULT_SPAN_CONFIG } from '../src/runtime/spanDetection/index.js';

// Build a narrated-stream row with sensible defaults; override per test.
function row(o) {
  const kind = o.kind ?? 'tool';
  return {
    narrationId: o.narrationId,
    idempotencyKey: o.idempotencyKey ?? null,
    eventId: o.eventId ?? null,
    runtimeId: o.runtimeId ?? 'rt-1',
    teamId: o.teamId ?? 'team-1',
    agentId: o.agentId ?? 'a1',
    sessionId: o.sessionId ?? null,
    eventType: o.eventType ?? (kind === 'tool' ? 'tool_use' : kind === 'text' ? 'assistant_text' : 'turn_completed'),
    createdAt: o.createdAt ?? '2026-05-16T00:00:00.000Z',
    line: o.line ?? '',
    kind,
    tokens: o.tokens ?? null,
  };
}

test('empty input yields no spans', () => {
  assert.deepEqual(detectSpans([]), []);
  assert.deepEqual(detectSpans(undefined), []);
  assert.deepEqual(detectSpans(null), []);
});

test('all-system input yields no spans (system never forms a span)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'system', eventType: 'turn_completed' }),
    row({ narrationId: 'n2', kind: 'system', eventType: 'compact_boundary' }),
  ]);
  assert.deepEqual(out, []);
});

test('a single trailing activity row is one OPEN span', () => {
  const out = detectSpans([row({ narrationId: 'n1', kind: 'tool', line: 'Reading a.js' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].spanId, 'span-n1');
  assert.equal(out[0].closed, false);
  assert.equal(out[0].boundary, null);
  assert.equal(out[0].rowCount, 1);
  assert.deepEqual(out[0].rows.map((r) => r.narrationId), ['n1']);
});

test('a text-only run forms a valid thin span', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'text', line: 'thinking' }),
    row({ narrationId: 'n2', kind: 'text', line: 'more' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
  assert.equal(out[0].closed, false);
});

test('a system row closes an open span with reason:system + systemEventType; system row not in any span', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'tool' }),
    row({ narrationId: 'n2', kind: 'tool' }),
    row({ narrationId: 'n3', kind: 'system', eventType: 'compact_boundary' }),
    row({ narrationId: 'n4', kind: 'tool' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'system', systemEventType: 'compact_boundary' });
  assert.equal(out[0].closed, true);
  assert.deepEqual(out[0].rows.map((r) => r.narrationId), ['n1', 'n2']);
  assert.equal(out[1].closed, false); // trailing n4 span open
  assert.deepEqual(out[1].rows.map((r) => r.narrationId), ['n4']);
});

test('agent-change closes the span; the differing row starts a new span', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'a1', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'a2', kind: 'tool' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'agent-change' });
  assert.equal(out[0].agentId, 'a1');
  assert.equal(out[1].agentId, 'a2');
  assert.equal(out[1].closed, false);
});

test('runtime-change closes the span (agent equal)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'a1', runtimeId: 'rt-1', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'a1', runtimeId: 'rt-2', kind: 'tool' }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'runtime-change' });
  assert.equal(out[1].runtimeId, 'rt-2');
});

test('agent-change wins over a simultaneous time-gap (first trigger in order)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'a1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'a2', createdAt: '2026-05-16T01:00:00.000Z', kind: 'tool' }),
  ]);
  assert.deepEqual(out[0].boundary, { reason: 'agent-change' });
});

test('time-gap (> gapMs) splits a same-agent run', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', createdAt: '2026-05-16T00:06:00.000Z', kind: 'tool' }), // 6 min > 5 min
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].boundary, { reason: 'time-gap' });
  assert.equal(out[1].closed, false);
});

test('a gap at/under gapMs does NOT split', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', createdAt: '2026-05-16T00:05:00.000Z', kind: 'tool' }), // exactly 5 min, not > 5 min
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
});

test('unparseable createdAt is treated as no gap (never NaN-splits)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', createdAt: 'not-a-date', kind: 'tool' }),
    row({ narrationId: 'n2', createdAt: 'also-bad', kind: 'tool' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
});

test('size-cap on rowCount closes eagerly after the appending row', () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) rows.push(row({ narrationId: `n${i}`, kind: 'tool' }));
  const out = detectSpans(rows, { gapMs: 300000, maxRows: 3, maxTokens: 1e9 });
  assert.equal(out.length, 2);
  assert.equal(out[0].rowCount, 3);
  assert.deepEqual(out[0].boundary, { reason: 'size-cap' });
  assert.equal(out[1].rowCount, 2);
  assert.equal(out[1].closed, false);
});

test('size-cap on summed tokens; a single oversized row is its own 1-row closed span', () => {
  const out = detectSpans(
    [row({ narrationId: 'n1', kind: 'tool', tokens: 9999 }), row({ narrationId: 'n2', kind: 'tool', tokens: 1 })],
    { gapMs: 300000, maxRows: 40, maxTokens: 6000 },
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].rowCount, 1);
  assert.equal(out[0].tokens, 9999);
  assert.deepEqual(out[0].boundary, { reason: 'size-cap' });
  assert.equal(out[1].closed, false);
});

test('span.tokens sums row tokens with null treated as 0; embedded rows keep raw tokens', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'tool', tokens: 10 }),
    row({ narrationId: 'n2', kind: 'tool', tokens: null }),
    row({ narrationId: 'n3', kind: 'tool', tokens: 5 }),
  ]);
  assert.equal(out[0].tokens, 15);
  assert.deepEqual(out[0].rows.map((r) => r.tokens), [10, null, 5]);
});

test('embedded rows are the exact 7-field subset, in order, not re-narrated', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', eventId: 'e1', eventType: 'tool_use', kind: 'tool', line: 'Bash: ls', tokens: 3, createdAt: '2026-05-16T00:00:01.000Z' }),
  ]);
  assert.deepEqual(out[0].rows[0], {
    narrationId: 'n1', eventId: 'e1', eventType: 'tool_use', kind: 'tool', line: 'Bash: ls', tokens: 3, createdAt: '2026-05-16T00:00:01.000Z',
  });
});

test('span carries agentId/runtimeId/teamId/sessionId/startedAt/endedAt from its rows', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', agentId: 'dev', runtimeId: 'rt-9', teamId: 'tm', sessionId: 's1', createdAt: '2026-05-16T00:00:00.000Z', kind: 'tool' }),
    row({ narrationId: 'n2', agentId: 'dev', runtimeId: 'rt-9', teamId: 'tm', sessionId: 's1', createdAt: '2026-05-16T00:00:30.000Z', kind: 'tool' }),
  ]);
  assert.equal(out[0].agentId, 'dev');
  assert.equal(out[0].runtimeId, 'rt-9');
  assert.equal(out[0].teamId, 'tm');
  assert.equal(out[0].sessionId, 's1');
  assert.equal(out[0].startedAt, '2026-05-16T00:00:00.000Z');
  assert.equal(out[0].endedAt, '2026-05-16T00:00:30.000Z');
});

test('task_* tool lines stay in-span (only kind matters, not eventType payload)', () => {
  const out = detectSpans([
    row({ narrationId: 'n1', kind: 'tool', eventType: 'tool_use', line: 'Created task t_42 — x' }),
    row({ narrationId: 'n2', kind: 'tool', eventType: 'tool_use', line: 'Updated task t_42' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].rowCount, 2);
});

test('deterministic: identical input yields deep-equal output', () => {
  const mk = () => [
    row({ narrationId: 'n1', kind: 'tool' }),
    row({ narrationId: 'n2', kind: 'system', eventType: 'turn_completed' }),
    row({ narrationId: 'n3', kind: 'text' }),
  ];
  assert.deepEqual(detectSpans(mk()), detectSpans(mk()));
});

test('SPAN_BOUNDARY_REASONS is the sealed expected set; DEFAULT_SPAN_CONFIG frozen', () => {
  assert.deepEqual([...SPAN_BOUNDARY_REASONS].sort(), ['agent-change', 'runtime-change', 'size-cap', 'system', 'time-gap']);
  assert.throws(() => SPAN_BOUNDARY_REASONS.add('x'), /sealed/);
  assert.ok(Object.isFrozen(DEFAULT_SPAN_CONFIG));
  assert.deepEqual({ ...DEFAULT_SPAN_CONFIG }, { gapMs: 300000, maxRows: 40, maxTokens: 6000 });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanDetection.detectSpans.test.js`
Expected: FAIL — cannot resolve `../src/runtime/spanDetection/index.js` (module not created yet).

- [ ] **Step 3: Create the index re-export**

Create `src/runtime/spanDetection/index.js`:

```javascript
export { detectSpans, SPAN_BOUNDARY_REASONS, DEFAULT_SPAN_CONFIG } from './detectSpans.js';
```

- [ ] **Step 4: Create the pure core**

Create `src/runtime/spanDetection/detectSpans.js`:

```javascript
// Pure span detection (Readability Layer-2 P2b). Zero imports, JSX-free,
// server-importable — the eventNarration/timelineComposition pure-core
// discipline. Groups the persisted narrated stream into single-agent
// activity spans for P3's summarizer. Span is a GROUPING, not a
// transformation: narrated line text is reused verbatim (no re-narration).

// Sealed reason set. Object.freeze(new Set(...)) does NOT make .add()
// throw on Node v22 (freeze guards own props, not the Set internal
// slot) — seal via own throwing mutators, exactly as eventNarration's
// NARRATION_KINDS. .has()/iteration/spread keep working.
export const SPAN_BOUNDARY_REASONS = (() => {
  const s = new Set(['system', 'agent-change', 'runtime-change', 'time-gap', 'size-cap']);
  const seal = () => { throw new TypeError('SPAN_BOUNDARY_REASONS is sealed'); };
  s.add = seal;
  s.delete = seal;
  s.clear = seal;
  return Object.freeze(s);
})();

export const DEFAULT_SPAN_CONFIG = Object.freeze({ gapMs: 300000, maxRows: 40, maxTokens: 6000 });

function tokenSum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isActivity(kind) {
  return kind === 'tool' || kind === 'text';
}

// The exact 7-field narrated-row subset a span embeds (by reference, not
// re-narrated). The narration store already normalizes line→string and
// tokens→number|null; eventId may be null.
function pickRow(r) {
  return {
    narrationId: r.narrationId,
    eventId: r.eventId ?? null,
    eventType: r.eventType,
    kind: r.kind,
    line: r.line,
    tokens: r.tokens,
    createdAt: r.createdAt,
  };
}

/**
 * @param {Array<object>} rows narrated-stream rows ordered created_at ASC,
 *   narration_id ASC (as listNarration returns) — NOT re-sorted here.
 * @param {{gapMs:number,maxRows:number,maxTokens:number}} [config]
 * @returns {Array<object>} Span[]
 */
export function detectSpans(rows, config = DEFAULT_SPAN_CONFIG) {
  const cfg = config || DEFAULT_SPAN_CONFIG;
  const gapMs = typeof cfg.gapMs === 'number' ? cfg.gapMs : DEFAULT_SPAN_CONFIG.gapMs;
  const maxRows = typeof cfg.maxRows === 'number' ? cfg.maxRows : DEFAULT_SPAN_CONFIG.maxRows;
  const maxTokens = typeof cfg.maxTokens === 'number' ? cfg.maxTokens : DEFAULT_SPAN_CONFIG.maxTokens;
  const list = Array.isArray(rows) ? rows : [];

  const spans = [];
  let open = null;

  const finalize = (span, boundary) => {
    const last = span.rows[span.rows.length - 1];
    spans.push({
      spanId: `span-${span.rows[0].narrationId}`,
      agentId: span.agentId,
      runtimeId: span.runtimeId,
      teamId: span.teamId,
      sessionId: span.sessionId ?? null,
      startedAt: span.rows[0].createdAt,
      endedAt: last.createdAt,
      closed: boundary !== null,
      boundary,
      rowCount: span.rows.length,
      tokens: span.tokens,
      rows: span.rows,
    });
  };

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const agentId = typeof r.agentId === 'string' ? r.agentId : '';
    const runtimeId = typeof r.runtimeId === 'string' ? r.runtimeId : '';

    // 1. system row: closes any open span (consumed as boundary, never
    //    inside / never its own span). No open span => simply skipped.
    if (!isActivity(r.kind)) {
      if (open) {
        finalize(open, { reason: 'system', systemEventType: r.eventType });
        open = null;
      }
      continue;
    }

    // First matching trigger in order wins: agent-change > runtime-change
    // > time-gap. (system handled above.)
    if (open) {
      if (agentId !== open.agentId) {
        finalize(open, { reason: 'agent-change' });
        open = null;
      } else if (runtimeId !== open.runtimeId) {
        finalize(open, { reason: 'runtime-change' });
        open = null;
      } else {
        const prev = open.rows[open.rows.length - 1];
        const a = Date.parse(prev.createdAt);
        const b = Date.parse(r.createdAt);
        if (!Number.isNaN(a) && !Number.isNaN(b) && b - a > gapMs) {
          finalize(open, { reason: 'time-gap' });
          open = null;
        }
      }
    }

    if (!open) {
      open = {
        agentId,
        runtimeId,
        teamId: r.teamId,
        sessionId: r.sessionId ?? null,
        rows: [],
        tokens: 0,
      };
    }
    open.rows.push(pickRow(r));
    open.tokens += tokenSum(r.tokens);

    // 5. size-cap: eager close AFTER appending the row.
    if (open.rows.length >= maxRows || open.tokens >= maxTokens) {
      finalize(open, { reason: 'size-cap' });
      open = null;
    }
  }

  if (open) finalize(open, null); // trailing span: open, no boundary

  return spans;
}
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanDetection.detectSpans.test.js`
Expected: PASS — all tests green, output pristine.

- [ ] **Step 6: (no commit — Task 1 accumulates uncommitted toward Commit 1)**

---

## Task 2: Purity + sealed/frozen guard

**Files:**
- Create: `test/spanDetection.purity.test.js`

- [ ] **Step 1: Write the purity guard suite**

Create `test/spanDetection.purity.test.js` (models `test/eventNarration.purity.test.js`, extended with the react/JSX guard from the P2a purity ratification and the sealed/frozen runtime assertions):

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSpans, SPAN_BOUNDARY_REASONS, DEFAULT_SPAN_CONFIG } from '../src/runtime/spanDetection/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'spanDetection');

test('spanDetection module imports no node:/fs/path/os/child_process/react, no JSX, never touches process', () => {
  for (const f of ['detectSpans.js', 'index.js']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports a node: builtin`);
    assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), `${f} imports a node core module`);
    assert.ok(!/from\s+['"]react/.test(src), `${f} imports react`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
    // JSX element syntax guard (the P2a-ratified form: tolerates JSDoc generics like Array<object>)
    assert.ok(!/(return|=>)\s*<[A-Za-z]/.test(src) && !/<\/[A-Za-z]/.test(src), `${f} contains JSX`);
  }
});

test('SPAN_BOUNDARY_REASONS is sealed (mutators throw; has/iteration work)', () => {
  assert.throws(() => SPAN_BOUNDARY_REASONS.add('x'), /sealed/);
  assert.throws(() => SPAN_BOUNDARY_REASONS.delete('system'), /sealed/);
  assert.throws(() => SPAN_BOUNDARY_REASONS.clear(), /sealed/);
  assert.ok(SPAN_BOUNDARY_REASONS.has('system'));
  assert.equal([...SPAN_BOUNDARY_REASONS].length, 5);
});

test('every boundary.reason detectSpans can emit is a member of SPAN_BOUNDARY_REASONS', () => {
  // Drive each reason and assert the emitted reason is in the sealed set.
  const r = (o) => ({ narrationId: o.n, runtimeId: o.rt ?? 'rt-1', teamId: 't', agentId: o.a ?? 'a1',
    sessionId: null, eventId: null, eventType: o.kind === 'system' ? 'turn_completed' : 'tool_use',
    createdAt: o.at ?? '2026-05-16T00:00:00.000Z', line: '', kind: o.kind ?? 'tool', tokens: o.tok ?? null });
  const reasons = new Set();
  for (const span of detectSpans([r({ n: '1' }), r({ n: '2', kind: 'system' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', a: 'a1' }), r({ n: '2', a: 'a2' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', rt: 'rt-1' }), r({ n: '2', rt: 'rt-2' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', at: '2026-05-16T00:00:00.000Z' }), r({ n: '2', at: '2026-05-16T01:00:00.000Z' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', tok: 1e9 })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const reason of reasons) assert.ok(SPAN_BOUNDARY_REASONS.has(reason), `unknown reason: ${reason}`);
  assert.ok(reasons.has('size-cap') && reasons.has('system') && reasons.has('agent-change'));
});

test('DEFAULT_SPAN_CONFIG is frozen with the documented defaults', () => {
  assert.ok(Object.isFrozen(DEFAULT_SPAN_CONFIG));
  assert.deepEqual({ ...DEFAULT_SPAN_CONFIG }, { gapMs: 300000, maxRows: 40, maxTokens: 6000 });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanDetection.purity.test.js`
Expected: PASS. (This is an invariant guard over the Task-1 module — the `eventNarration.purity` precedent; it has no red phase of its own because the module already exists and is pure by construction.)

- [ ] **Step 3: (no commit — accumulates toward Commit 1)**

---

## Task 3: Committed fixture + fixture-coverage guard

**Files:**
- Create: `test/fixtures/spanDetection.input.json`
- Create: `test/spanDetection.fixtureCoverage.test.js`

- [ ] **Step 1: Write the fixture-coverage suite (fails — fixture missing)**

Create `test/spanDetection.fixtureCoverage.test.js` (models `test/eventNarration.fixtureCoverage.test.js` — a guard that the committed fixture genuinely exercises the space):

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSpans } from '../src/runtime/spanDetection/index.js';

const cases = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'spanDetection.input.json'), 'utf8'));

function caseByName(name) {
  const c = cases.find((x) => x.name === name);
  assert.ok(c, `fixture missing case: ${name}`);
  return c;
}

test('fixture cases collectively exercise every boundary reason + open + edges', () => {
  const reasons = new Set();
  let sawOpen = false;
  let sawTextOnly = false;
  let sawSingleOversized = false;
  for (const c of cases) {
    const spans = detectSpans(c.rows, c.config);
    for (const s of spans) {
      if (s.boundary) reasons.add(s.boundary.reason);
      if (s.closed === false) sawOpen = true;
      if (s.rowCount > 0 && s.rows.every((r) => r.kind === 'text')) sawTextOnly = true;
      if (s.rowCount === 1 && s.boundary && s.boundary.reason === 'size-cap') sawSingleOversized = true;
    }
  }
  for (const reason of ['system', 'agent-change', 'runtime-change', 'time-gap', 'size-cap']) {
    assert.ok(reasons.has(reason), `fixture never exercises boundary reason: ${reason}`);
  }
  assert.ok(sawOpen, 'fixture never produces a trailing OPEN span (closed:false)');
  assert.ok(sawTextOnly, 'fixture never produces a text-only span');
  assert.ok(sawSingleOversized, 'fixture never produces a single-oversized-row size-capped span');
});

test('empty case yields [] and all-system case yields []', () => {
  assert.deepEqual(detectSpans(caseByName('empty').rows), []);
  assert.deepEqual(detectSpans(caseByName('all-system').rows), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanDetection.fixtureCoverage.test.js`
Expected: FAIL — `ENOENT` reading `fixtures/spanDetection.input.json` (not created yet).

- [ ] **Step 3: Create the committed fixture**

Create `test/fixtures/spanDetection.input.json`:

```json
[
  {
    "name": "system-agentchange-gap-open",
    "rows": [
      { "narrationId": "m1", "eventId": "e1", "runtimeId": "rt-1", "teamId": "team-1", "agentId": "dev-1", "sessionId": "s1", "eventType": "tool_use", "createdAt": "2026-05-16T00:00:00.000Z", "line": "Reading a.js", "kind": "tool", "tokens": 10 },
      { "narrationId": "m2", "eventId": "e2", "runtimeId": "rt-1", "teamId": "team-1", "agentId": "dev-1", "sessionId": "s1", "eventType": "assistant_text", "createdAt": "2026-05-16T00:00:05.000Z", "line": "planning", "kind": "text", "tokens": null },
      { "narrationId": "m3", "eventId": "e3", "runtimeId": "rt-1", "teamId": "team-1", "agentId": "dev-1", "sessionId": "s1", "eventType": "turn_completed", "createdAt": "2026-05-16T00:00:10.000Z", "line": "Turn complete (1s)", "kind": "system", "tokens": null },
      { "narrationId": "m4", "eventId": "e4", "runtimeId": "rt-1", "teamId": "team-1", "agentId": "dev-1", "sessionId": "s1", "eventType": "tool_use", "createdAt": "2026-05-16T00:00:15.000Z", "line": "Edit b.tsx", "kind": "tool", "tokens": 4 },
      { "narrationId": "m5", "eventId": "e5", "runtimeId": "rt-1", "teamId": "team-1", "agentId": "dev-2", "sessionId": "s2", "eventType": "tool_use", "createdAt": "2026-05-16T00:00:20.000Z", "line": "Bash: npm test", "kind": "tool", "tokens": 6 },
      { "narrationId": "m6", "eventId": "e6", "runtimeId": "rt-1", "teamId": "team-1", "agentId": "dev-2", "sessionId": "s2", "eventType": "tool_use", "createdAt": "2026-05-16T00:11:00.000Z", "line": "Reading c.js", "kind": "tool", "tokens": 2 }
    ]
  },
  {
    "name": "runtime-change-open",
    "rows": [
      { "narrationId": "q1", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a9", "sessionId": null, "eventType": "tool_use", "createdAt": "2026-05-16T00:00:00.000Z", "line": "tool one", "kind": "tool", "tokens": 1 },
      { "narrationId": "q2", "eventId": null, "runtimeId": "rt-2", "teamId": "team-1", "agentId": "a9", "sessionId": null, "eventType": "tool_use", "createdAt": "2026-05-16T00:00:03.000Z", "line": "tool two", "kind": "tool", "tokens": 1 }
    ]
  },
  {
    "name": "size-cap-rows",
    "config": { "gapMs": 300000, "maxRows": 3, "maxTokens": 1000000000 },
    "rows": [
      { "narrationId": "s1", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "tool_use", "createdAt": "2026-05-16T00:00:00.000Z", "line": "1", "kind": "tool", "tokens": 1 },
      { "narrationId": "s2", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "tool_use", "createdAt": "2026-05-16T00:00:01.000Z", "line": "2", "kind": "tool", "tokens": 1 },
      { "narrationId": "s3", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "tool_use", "createdAt": "2026-05-16T00:00:02.000Z", "line": "3", "kind": "tool", "tokens": 1 },
      { "narrationId": "s4", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "tool_use", "createdAt": "2026-05-16T00:00:03.000Z", "line": "4", "kind": "tool", "tokens": 1 }
    ]
  },
  {
    "name": "single-oversized-row",
    "config": { "gapMs": 300000, "maxRows": 40, "maxTokens": 6000 },
    "rows": [
      { "narrationId": "o1", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "tool_use", "createdAt": "2026-05-16T00:00:00.000Z", "line": "huge", "kind": "tool", "tokens": 9999 }
    ]
  },
  {
    "name": "text-only-open",
    "rows": [
      { "narrationId": "t1", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "assistant_text", "createdAt": "2026-05-16T00:00:00.000Z", "line": "thinking", "kind": "text", "tokens": null },
      { "narrationId": "t2", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "assistant_text", "createdAt": "2026-05-16T00:00:05.000Z", "line": "more thinking", "kind": "text", "tokens": null }
    ]
  },
  { "name": "empty", "rows": [] },
  {
    "name": "all-system",
    "rows": [
      { "narrationId": "y1", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "turn_completed", "createdAt": "2026-05-16T00:00:00.000Z", "line": "Turn complete", "kind": "system", "tokens": null },
      { "narrationId": "y2", "eventId": null, "runtimeId": "rt-1", "teamId": "team-1", "agentId": "a1", "sessionId": null, "eventType": "compact_boundary", "createdAt": "2026-05-16T00:00:01.000Z", "line": "Context compacted", "kind": "system", "tokens": null }
    ]
  }
]
```

> Why this fixture exercises everything (traced against the §3 algorithm — deterministic, no conditional):
> - `system-agentchange-gap-open`: m1(tool)+m2(text) open span A → m3(system) closes A with **`system`** (`systemEventType:turn_completed`) → m4(dev-1 tool) opens B → m5(dev-2 tool) ≠ agent ⇒ closes B with **`agent-change`**, opens C(dev-2) → m6(dev-2, +10m40s > 5m) ⇒ closes C with **`time-gap`**, opens D → EOF ⇒ D is the trailing **OPEN** span (`closed:false`).
> - `runtime-change-open`: q1(a9,rt-1) opens → q2(a9,rt-2) same agent, ≠ runtime ⇒ closes with **`runtime-change`**, opens a trailing open span.
> - `size-cap-rows` (maxRows 3): s1,s2,s3 ⇒ **`size-cap`** (3-row span), s4 ⇒ trailing open span.
> - `single-oversized-row` (maxTokens 6000): o1 tokens 9999 ⇒ a **1-row `size-cap`** span (`rowCount:1`).
> - `text-only-open`: t1,t2 (both `text`) ⇒ a **text-only** trailing open span.
> - `empty` ⇒ `[]`; `all-system` ⇒ `[]` (system never forms a span).
>
> Union of `boundary.reason` across all cases = {`system`,`agent-change`,`runtime-change`,`time-gap`,`size-cap`}; OPEN, text-only, and single-oversized are all present; `empty`/`all-system` yield `[]`. The coverage test passes by construction. The fixture is the artifact under construction — if a future edit breaks coverage, fix the **fixture**, never the test; `spanDetection.detectSpans.test.js` independently pins each behavior.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanDetection.fixtureCoverage.test.js`
Expected: PASS (both tests green; output pristine). A failure here means the fixture (not the test, not `detectSpans`) is wrong — adjust the fixture rows until green.

- [ ] **Step 5: (no commit — accumulates toward Commit 1)**

---

## Task 4: Wire Commit-1 suites + full root fail-0 + **Commit 1**

**Files:**
- Modify: `package.json` (the `scripts.test` chain)

- [ ] **Step 1: Append the 3 core suites to `scripts.test`**

In `package.json`, the `scripts.test` value currently ends with:
`&& node --no-warnings --test test/timelineComposition.agreement.test.js"`

Append (note the leading space; keep it one line, before the closing `"`):

```
 && node --no-warnings --test test/spanDetection.detectSpans.test.js && node --no-warnings --test test/spanDetection.purity.test.js && node --no-warnings --test test/spanDetection.fixtureCoverage.test.js
```

Validate the wiring:

Run: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log(['spanDetection.detectSpans','spanDetection.purity','spanDetection.fixtureCoverage'].every(s=>t.includes(s)))"`
Expected: `true`

- [ ] **Step 2: Full root suite — fail 0, all 3 P2b core suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test > /tmp/p2b_c1.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`

Run: `grep -E "^# (pass|fail)" /tmp/p2b_c1.log | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0` (and `pass` count strictly greater than the pre-P2b baseline).

Run: `grep -cE "spanDetection module imports no node:|fixture cases collectively exercise every boundary reason|a single trailing activity row is one OPEN span" /tmp/p2b_c1.log`
Expected: `>= 3` (the 3 P2b core suites genuinely executed — the un-wired-test trap).

- [ ] **Step 3: Commit 1**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/spanDetection/detectSpans.js toad-local/src/runtime/spanDetection/index.js toad-local/test/spanDetection.detectSpans.test.js toad-local/test/spanDetection.purity.test.js toad-local/test/spanDetection.fixtureCoverage.test.js toad-local/test/fixtures/spanDetection.input.json toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(spans): pure detectSpans core over the persisted narrated stream (Readability Layer-2 P2b, Commit 1)

New zero-import server-importable src/runtime/spanDetection/
(detectSpans + index). Groups the narrated stream into single-agent
tool+text activity spans; sealed SPAN_BOUNDARY_REASONS (throwing-mutator
seal — Node-v22-safe), frozen DEFAULT_SPAN_CONFIG {gapMs:300000,
maxRows:40,maxTokens:6000}. Single forward pass: system row closes
(consumed as boundary, never in/forming a span; systemEventType carried)
> agent-change > runtime-change > time-gap (Number.isNaN-skip) > eager
size-cap (rowCount/tokens after append); trailing span open
(closed:false). Lean Span embeds the exact 7-field narrated rows by
reference (no re-narration); tokens null→0 in the sum. TDD unit +
purity + fixtureCoverage suites; suites wired; root fail 0. Greenfield,
not a preservation refactor. No consumer yet (P3 first).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -1
```

---

## Task 5: Compute-on-read `listSpans` (read model + runtime delegation)

> **§8d ratification (test 4 corrected — do not revert):** the original
> test 4 ingested `type:'tool_use'` with an unregistered `runtimeId`
> directly into `new LocalToadRuntime()`. Grounding `RuntimeEventIngestor`
> showed `tool_use`/`assistant_text`/`approval_request` all hit
> `RuntimeIdentityValidator.assertCanWrite` (throws for an unregistered
> runtime), while the only NARRATED types that bypass identity validation
> (`turn_completed` etc.) narrate to `kind:'system'` → **zero spans**. So
> NO non-empty span is reachable e2e through an unregistered runtime, and
> registering a runtime is out of scope / fragile. But `#persistNarration`
> runs (line 70) **before** the `tool_use` identity check (line 73), so
> the tool narration is durably written before the throw. The ratified
> test 4 therefore ingests `tool_use`, tolerates *only* the known
> `unknown runtime identity` rejection (`assert.match`), asserts the
> narration genuinely persisted (`listNarratedTimeline().length===1`,
> anti-vacuous), then asserts `rt.listSpans()` projects it to one open
> tool span — a faithful, in-scope, non-inert e2e. Same pre-emptive
> controller-ratification discipline as the auth/compaction/narration/P2a
> cycles.

**Files:**
- Modify: `src/read/LocalReadModel.js` (add import after line 6; add `listSpans` after line 106)
- Modify: `src/app/LocalToadRuntime.js` (add `listSpans(input)` adjacent to `listNarratedTimeline`, ~line 794)
- Test: `test/localToadRuntime.spanDetection.test.js`

- [ ] **Step 1: Write the failing wiring suite**

Create `test/localToadRuntime.spanDetection.test.js` (models `test/localToadRuntime.narration.test.js`):

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalReadModel } from '../src/read/LocalReadModel.js';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

const brokerStub = { listMessages: () => [] };

test('LocalReadModel.listSpans returns [] when no narrationStore', () => {
  const rm = new LocalReadModel({ broker: brokerStub });
  assert.deepEqual(rm.listSpans({ teamId: 'team-a' }), []);
});

test('LocalReadModel.listSpans groups the store narration into spans', () => {
  const narrationStore = {
    listNarration({ teamId, runtimeId }) {
      assert.equal(teamId, 'team-a');
      assert.equal(runtimeId, 'rt-1');
      return [
        { narrationId: 'n1', eventId: 'e1', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'tool_use', createdAt: '2026-05-16T00:00:00.000Z', line: 'Reading a.js', kind: 'tool', tokens: 3 },
        { narrationId: 'n2', eventId: 'e2', runtimeId: 'rt-1', teamId: 'team-a', agentId: 'a1', sessionId: null, eventType: 'turn_completed', createdAt: '2026-05-16T00:00:05.000Z', line: 'Turn complete', kind: 'system', tokens: null },
      ];
    },
  };
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore });
  const spans = rm.listSpans({ teamId: 'team-a', runtimeId: 'rt-1' });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].spanId, 'span-n1');
  assert.equal(spans[0].closed, true);
  assert.deepEqual(spans[0].boundary, { reason: 'system', systemEventType: 'turn_completed' });
  assert.deepEqual(spans[0].rows.map((r) => r.narrationId), ['n1']);
});

test('LocalReadModel.listSpans validates teamId (mirrors listNarratedTimeline)', () => {
  const rm = new LocalReadModel({ broker: brokerStub, narrationStore: { listNarration: () => [] } });
  assert.throws(() => rm.listSpans({}), /teamId/);
});

test('LocalToadRuntime.listSpans delegates to the read model end-to-end', async () => {
  const rt = new LocalToadRuntime();
  // §8d-ratified: a tool_use for an UNREGISTERED runtime is rejected by
  // RuntimeIdentityValidator.assertCanWrite — but RuntimeEventIngestor
  // runs #persistNarration (line 70) BEFORE the tool_use identity check
  // (line 73), so the narration row is durably written before the throw.
  // The identity rejection is expected and orthogonal to what we assert
  // (the rt -> readModel -> narrationStore -> detectSpans delegation).
  // assert.match keeps the catch honest: only the KNOWN identity error
  // is tolerated; any other ingest failure fails the test.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-s', teamId: 'team-s', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  assert.equal(
    rt.listNarratedTimeline({ teamId: 'team-s' }).length, 1,
    'tool narration durably persisted via the real runtime (anti-vacuous)',
  );
  const spans = rt.listSpans({ teamId: 'team-s' });
  assert.equal(spans.length, 1, 'one span over the single persisted tool narration (rt -> readModel -> store -> detectSpans)');
  assert.equal(spans[0].closed, false, 'trailing span open (no terminating boundary yet)');
  assert.equal(spans[0].rows[0].kind, 'tool');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.spanDetection.test.js`
Expected: FAIL — `rm.listSpans is not a function` / `rt.listSpans is not a function`.

- [ ] **Step 3: Add the import + `listSpans` to `LocalReadModel.js`**

In `src/read/LocalReadModel.js`, add this import immediately after the existing import block (after line 6, the closing `} from '../protocol/crossTeam.js';`):

```javascript
import { detectSpans, DEFAULT_SPAN_CONFIG } from '../runtime/spanDetection/index.js';
```

Then insert `listSpans` immediately after `listNarratedTimeline` (after line 106, before `listApprovals`). It delegates to `listNarratedTimeline` so the `requireString(teamId)` validation and the absent-store `[]` guard live in exactly one place (DRY — do not duplicate the guard here):

```javascript
  listSpans({ teamId, runtimeId = null }) {
    return detectSpans(
      this.listNarratedTimeline({ teamId, runtimeId }),
      DEFAULT_SPAN_CONFIG,
    );
  }
```

> Note: `listNarratedTimeline` already does `requireString(teamId, 'teamId')` and the `!this.narrationStore` → `[]` guard; `detectSpans([])` is `[]`. So `listSpans` needs no own guard — a reviewer must NOT "add" a redundant one (that would be the kind of over-reach the controller rejects).

- [ ] **Step 4: Add `listSpans(input)` delegation to `LocalToadRuntime.js`**

In `src/app/LocalToadRuntime.js`, immediately after the `listNarratedTimeline(input)` method (lines 792-794, before `listToolCalls`), add:

```javascript
  listSpans(input) {
    return this.readModel.listSpans(input);
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.spanDetection.test.js`
Expected: PASS — all 4 tests green, output pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 2)**

---

## Task 6: Wire the wiring suite + full gates + whole-impl review

**Files:**
- Modify: `package.json` (append the 4th P2b suite)

- [ ] **Step 1: Append the wiring suite to `scripts.test`**

In `package.json`, the `scripts.test` value now ends with:
`&& node --no-warnings --test test/spanDetection.fixtureCoverage.test.js"`

Append (leading space, before the closing `"`):

```
 && node --no-warnings --test test/localToadRuntime.spanDetection.test.js
```

Validate:

Run: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log(['spanDetection.detectSpans','spanDetection.purity','spanDetection.fixtureCoverage','localToadRuntime.spanDetection'].every(s=>t.includes(s)))"`
Expected: `true`

- [ ] **Step 2: Full root suite — fail 0, ALL 4 P2b suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test > /tmp/p2b_c2.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`

Run: `grep -E "^# (pass|fail)" /tmp/p2b_c2.log | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`

Run: `grep -cE "spanDetection module imports no node:|fixture cases collectively exercise every boundary reason|a single trailing activity row is one OPEN span|LocalToadRuntime.listSpans delegates to the read model end-to-end" /tmp/p2b_c2.log`
Expected: `>= 4` (all 4 P2b suite titles genuinely present in this run — the un-wired-test trap; never trust a pasted number, the controller re-runs and greps its own output).

- [ ] **Step 3: Whole-implementation review (pre-commit gate)**

Review the entire Commit-2 surface (and the Commit-1 core it builds on) as one unit: `detectSpans` matches spec §3 exactly (trigger order system→agent→runtime→time-gap; eager size-cap; system consumed not emitted; trailing open `closed:false/boundary:null`; `spanId=span-${rows[0].narrationId}`; lean 7-field rows by reference; `tokens` null→0 in the sum only); the sealed-set IIFE is the verbatim `NARRATION_KINDS` pattern; `DEFAULT_SPAN_CONFIG` frozen; `src/` stays react/JSX-free; `LocalReadModel.listSpans` delegates (no duplicated guard) and validates `teamId` via the sibling; `LocalToadRuntime.listSpans` is a one-line delegation mirroring `listNarratedTimeline`; **no out-of-scope change** (no `composeTimeline`/`CockpitForMe`/`FlowTimeline`/narration-persistence/spans-table/per-project-config); the 4 suites genuinely execute under `npm test` with substantive assertions. Resolve any finding before committing.

- [ ] **Step 4: (no commit — Task 6 accumulates; Task 7 commits)**

---

## Task 7: **Commit 2** + post-commit verify

- [ ] **Step 1: Commit 2 (exactly these files)**

```bash
git -C /c/Project-TOAD add toad-local/src/read/LocalReadModel.js toad-local/src/app/LocalToadRuntime.js toad-local/test/localToadRuntime.spanDetection.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(spans): compute-on-read listSpans over the persisted narrated stream (Readability Layer-2 P2b, Commit 2)

LocalReadModel.listSpans({teamId,runtimeId=null}) = detectSpans(
listNarratedTimeline(...), DEFAULT_SPAN_CONFIG) — delegates so the
requireString(teamId) validation + absent-store [] guard stay
single-site in listNarratedTimeline (no duplicated guard).
LocalToadRuntime.listSpans(input) → readModel.listSpans(input), a
one-for-one mirror of the listNarratedTimeline delegation. No table
(spans are a deterministic projection; recompute is bounded). Purely
additive — no consumer yet (P3 first), exactly as listNarratedTimeline
shipped dormant. Wiring suite added; root fail 0; all 4 P2b suites
executed; whole-impl reviewed. Out: P3 LLM, drift/task folding,
per-project config override, spans table, any composeTimeline/cockpit/
narration-persistence/rendered-timeline change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 2: Post-commit verify**

Run: `git -C /c/Project-TOAD show --stat HEAD`
Expected: exactly 4 files — `toad-local/src/read/LocalReadModel.js`, `toad-local/src/app/LocalToadRuntime.js`, `toad-local/test/localToadRuntime.spanDetection.test.js`, `toad-local/package.json`. No stray files.

Run: `git -C /c/Project-TOAD diff --stat 46725cd HEAD -- toad-local/ui toad-local/src/runtime/timelineComposition toad-local/src/runtime/eventNarration toad-local/src/runtime/sqliteNarrationStore.js`
Expected: EMPTY — P2b touched nothing in the UI, `composeTimeline`, `eventNarration`, or narration persistence (the out-of-scope guarantee).

Run: `git -C /c/Project-TOAD status --porcelain | grep -E 'spanDetection|spanDetection' || echo "(clean of P2b feature files)"`
Expected: `(clean of P2b feature files)` — every P2b artifact committed.

Run: `git -C /c/Project-TOAD log --oneline -2`
Expected: HEAD = Commit 2; HEAD~1 = Commit 1 (`feat(spans): pure detectSpans core …`). (No ratification commits are expected for P2b unless a §8d pin proved wrong at implementation time and was pre-emptively ratified — in which case HEAD~1 is that ratification doc and Commit 1 is one further back; the invariant that matters is both commits present and out-of-scope diff empty.)

---

## Notes for the executor (read before starting)

- **TDD is mandatory.** Every code task writes the test first, runs it to watch it FAIL for the expected reason, then writes the minimal implementation, then runs it to watch it PASS. The purity/fixtureCoverage suites are *invariant guards* (the `eventNarration` precedent) — they may be green on first run because they assert a property of code already written in the same commit; that is acceptable and explicitly noted in their tasks.
- **Greenfield, not a refactor.** There is NO pristine logic and NO frozen golden / capture script here (the deliberate, reasoned deviation from P2a — stated in spec §0.6/§6). Do not invent one.
- **Never trust a pasted test number.** The controller independently re-runs the full root suite and greps the P2b suite titles in its OWN output (the P2a un-wired-test trap). `EXIT=0` from the `&&`-chained `npm test` means every suite — including the last-appended P2b ones — ran and passed; the grep confirms they were actually present.
- **DRY guard placement.** `listSpans` delegates to `listNarratedTimeline`; the `requireString`/absent-store guard is single-site there. A reviewer adding a second guard in `listSpans` is over-reach — reject it.
- **§8d STOP rule.** If at implementation time any grounded pin is wrong (the `listNarration` row shape, the `kind` set `{tool,text,system}`, the delegation pattern, the `'../runtime/spanDetection/index.js'` import depth, the Node-v22 seal behavior, `created_at` being an ISO string), STOP and surface it for controller pre-emptive ratification (the auth/compaction/narration/P2a precedent) — do not code around a wrong plan.
- **The CRLF warning** (`LF will be replaced by CRLF`) on `git add` is a benign Windows autocrlf artifact; it does not affect content semantics. Do not "fix" it.
- **Commit hygiene.** Tasks within a commit accumulate uncommitted; ONLY Task 4 (Commit 1) and Task 7 (Commit 2) run `git commit`. Commit directly to `main` per session convention. If `git commit` would hang on GPG, prefix with `git -c commit.gpgsign=false` (the established session accommodation).
