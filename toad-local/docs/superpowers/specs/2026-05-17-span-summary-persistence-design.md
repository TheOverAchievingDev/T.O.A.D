# Span-Summary Persistence + Decide Core (Readability Layer-2 P3a) — Design

**Status:** Approved design (brainstorm complete). Next: implementation plan via `superpowers:writing-plans`.

**Goal:** A durable `span_summaries` store plus a pure "which closed spans still need summarizing" decide core, exposed compute-on-read — the dormant-but-tested foundation P3b's spawned-CLI summarizer writes into.

**Architecture:** New `SqliteSpanSummaryStore` mirroring `sqliteNarrationStore.js`; a pure zero-import `decideSpansToSummarize` core (the `eventNarration`/`detectSpans` lineage); `LocalToadRuntime` constructs the store, `LocalReadModel` exposes `listSpanSummaries` + a composed compute-on-read `listSpansAwaitingSummary`. No LLM, no spawn, no production writer yet (P3b is the first) — purely additive, exactly the shipped P1/P2b dormant-but-fully-tested pattern.

**Tech stack:** Node ≥20 ESM, `node:test`, the project's pure-core + sqlite-store + read-model-delegation discipline.

**P3 decomposition:** P3a (this) = persistence + decide core. P3b = the drift-L3-style one-shot `--print` spawned-CLI summarizer runner + provider routing + circuit breaker + honest degradation. P3c = cockpit/read-model surfacing of summaries + summarizer status.

---

## §0 — Context and §8d grounded facts (verified against shipped code 2026-05-17)

Predecessors shipped this session:

- **P1 narration persistence** (`71f9c4c` + `47d1369`): `narrated_lines` durably records one row per in-scope narrated runtime event; `SqliteNarrationStore` is the store precedent.
- **P2a composeTimeline extraction** (`52b49e4`).
- **P2b span detection** (`99494bb` + `d8630ef`, §8d ratification `bc7b966`): pure `src/runtime/spanDetection/detectSpans.js`; compute-on-read `LocalReadModel.listSpans` / `LocalToadRuntime.listSpans({teamId,runtimeId?})`.

Grounded facts that constrain P3a (surfaced, not smoothed — §8d; from the P3 code-explorer map):

1. **`Span` (P3a's input)** from `LocalReadModel.listSpans` (`src/read/LocalReadModel.js:109`) / `detectSpans` (`src/runtime/spanDetection/detectSpans.js`):
   ```
   { spanId, agentId, runtimeId, teamId, sessionId|null, startedAt, endedAt,
     closed, boundary:{reason,systemEventType?}|null, rowCount, tokens, rows[] }
   ```
   `closed:false` ⟺ the trailing open span (no terminating boundary yet). `listSpans` has **no production consumer** — P3a is the first.
2. **Store precedent** `src/runtime/sqliteNarrationStore.js`: ctor `{ filePath=':memory:', db=null }` → `openToadDatabase(filePath)` (`src/storage/sqlite.js:9`); `#ensureTeam` does `INSERT INTO teams … ON CONFLICT(team_id) DO NOTHING`; `appendNarration` is idempotent (returns `{inserted:false,row}` on an idempotency-key hit, never overwrites); `listNarration({teamId,runtimeId=null})` → `SELECT … WHERE team_id=? [AND runtime_id=?] ORDER BY created_at ASC, narration_id ASC`; `#rowToNarration` maps snake→camel.
3. **Schema mechanism** (`src/storage/sqlite.js:9-51`): `openToadDatabase` executes `src/storage/schema.sql` (whole file) on **every** open, then `applyMigrations` (guarded `ALTER TABLE … ADD COLUMN` try/catch blocks). ⟹ a **new table** declared `CREATE TABLE IF NOT EXISTS` in `schema.sql` is created on existing DBs at next open; `applyMigrations` is only for adding columns to *pre-existing* tables. A new `span_summaries` table needs **only** a `schema.sql` entry, no `applyMigrations` entry. (§8 pin — confirm `schema.sql` is re-executed every open and existing tables there use `IF NOT EXISTS`.)
4. **Read-model wiring precedent**: `LocalToadRuntime` constructs `this.narrationStore = narrationStore || new SqliteNarrationStore({ filePath: dbPath })` (`src/app/LocalToadRuntime.js:132`, shared db file), passes it to `LocalReadModel` (ctor arg, `LocalReadModel.js:25`), `close()` does `closeIfSupported(this.narrationStore)`. `LocalReadModel.listNarratedTimeline`/`listSpans` are the delegation/guard shape to mirror; `LocalToadRuntime.listNarratedTimeline`/`listSpans` are the one-line runtime delegations.
5. **P3b/P3c are out** (§8). The friction map flagged for P3b: the banked "spawn like workers via `RuntimeSupervisor.launchAgent`" is wrong — `LocalToadRuntime.launchAgent`→`#withToadMcpConfig` force-injects `--input-format stream-json --output-format stream-json --mcp-config` (conflicts with one-shot `--print`) and every `launchAgent` runtime is a broker/team participant by NOT-NULL `teamId`+`agentId` + `RuntimeIdentityValidator`; the correct precedent is the drift **L3 `llmJudge` one-shot `--print`** path (`src/drift/llm/llmJudge.js`). These do not affect P3a (no spawn here) but are banked in §8 so P3b starts from the corrected mechanism.
6. **§8d STOP rule:** if any grounded fact above is wrong at implementation time (the `Span` shape, the store/`#ensureTeam`/idempotency precedent, the schema-every-open behavior, the read-model delegation sites), STOP and surface for controller pre-emptive ratification (auth/compaction/narration/P2a/P2b precedent). Do not code around a wrong spec.

---

## §1 — Architecture and module boundaries

Three units:

- `src/runtime/sqliteSpanSummaryStore.js` — `SqliteSpanSummaryStore`, a durable per-span-summary projection mirroring `sqliteNarrationStore.js` (own connection or injected db, `#ensureTeam` FK, idempotent append by `span_id`, list query).
- `src/runtime/spanSummary/decideSpansToSummarize.js` + `src/runtime/spanSummary/index.js` — the pure, zero-import, JSX-free decide core (re-export index, the `eventNarration`/`spanDetection` shape).
- Wiring: `LocalToadRuntime` constructs `this.spanSummaryStore`; `LocalReadModel` exposes `listSpanSummaries` + a composed compute-on-read `listSpansAwaitingSummary`; one-line runtime delegations.

Purely additive; **dormant** (no production writer until P3b) but fully tested + read-model-exposed + exercised end-to-end in tests — the accepted P1/P2b pattern, not a stub/fake.

---

## §2 — The `span_summaries` store

### Schema (`src/storage/schema.sql`, `CREATE TABLE IF NOT EXISTS`; FK → teams)

| column | type | notes |
|---|---|---|
| `summary_id` | TEXT PRIMARY KEY | uuid (`randomUUID()`) |
| `span_id` | TEXT NOT NULL UNIQUE | idempotency key |
| `team_id` | TEXT NOT NULL | FK → `teams(team_id)` |
| `runtime_id` | TEXT NOT NULL | |
| `agent_id` | TEXT NOT NULL | |
| `session_id` | TEXT | nullable |
| `summary_text` | TEXT NOT NULL | P3b writes the real summary |
| `model` | TEXT | nullable (P3b provenance; tolerant of a degraded summary lacking a label) |
| `cli` | TEXT | nullable (P3b provenance) |
| `span_started_at` | TEXT NOT NULL | span snapshot |
| `span_ended_at` | TEXT NOT NULL | span snapshot |
| `row_count` | INTEGER NOT NULL | span snapshot |
| `tokens` | INTEGER | nullable (span snapshot) |
| `created_at` | TEXT NOT NULL | ISO; store defaults to `new Date().toISOString()` if omitted |

A unique index/constraint on `span_id` enforces one summary per span.

### `SqliteSpanSummaryStore` API

- `constructor({ filePath = ':memory:', db = null } = {})` → `this.db = db || openToadDatabase(filePath)`.
- `close()` → `this.db.close()`.
- `appendSummary(input)`:
  - `requireString` on `spanId, teamId, runtimeId, agentId, summaryText, spanStartedAt, spanEndedAt` (non-empty); `rowCount` coerced to a finite integer (else `TypeError`); `sessionId, model, cli` optional strings or null; `tokens` finite number or null; `createdAt = input.createdAt || new Date().toISOString()`.
  - Idempotent: if a row with this `span_id` exists, return `{ inserted: false, row: <existing #rowToSummary> }` — **never overwrite**.
  - Else `#ensureTeam(teamId)` then `INSERT`; return `{ inserted: true, row }`.
- `listSummaries({ teamId, runtimeId = null })` → `requireString(teamId)`; `SELECT * FROM span_summaries WHERE team_id=? [AND runtime_id=?] ORDER BY created_at ASC, summary_id ASC` mapped through `#rowToSummary`.
- `#ensureTeam(teamId)` — `INSERT INTO teams (team_id, display_name, created_at) VALUES (?, NULL, ?) ON CONFLICT(team_id) DO NOTHING` (verbatim the `sqliteNarrationStore` shape).
- `#rowToSummary(row)` → `{ summaryId, spanId, teamId, runtimeId, agentId, sessionId, summaryText, model, cli, spanStartedAt, spanEndedAt, rowCount, tokens, createdAt }`.

---

## §3 — The pure `decideSpansToSummarize` core

```javascript
decideSpansToSummarize({ spans, summarizedSpanIds }) -> Span[]
```

Returns the subset of `spans` where `span.closed === true` **and** `span.spanId` is not present in `summarizedSpanIds`, ordered **oldest-first**: by `Date.parse(span.startedAt)` ascending, `span.spanId` ascending as a deterministic tiebreak; unparseable `startedAt` sorts as if `0` (the `detectSpans` `Number.isNaN`-skip discipline — never throw, never reorder nondeterministically).

> Naming note: the decide core consumes the **live `Span` object** from `listSpans`, whose field is **`startedAt`** (per §0.1). The persisted store column/field is **`spanStartedAt`** (§2) — a *snapshot* of that value written by P3b. These are deliberately distinct names for distinct layers; the core sorts on `Span.startedAt`, the store persists it as `spanStartedAt`. Do not conflate or "rename to match".

- `summarizedSpanIds` accepted as a `Set` or array (normalized to a `Set` internally).
- Open spans (`closed !== true`) are always excluded — picked up on a later call once closed.
- Total/pure: `Array.isArray(spans)` guard (else `[]`); non-object / missing-`spanId` entries skipped; zero imports; no `node:`/`fs`/`path`/`os`/`child_process`/`react`/JSX/`process`; never throws.
- `index.js`: `export { decideSpansToSummarize } from './decideSpansToSummarize.js';`

---

## §4 — Exposure (compute-on-read; single-site guard)

- `LocalToadRuntime` constructor: `this.spanSummaryStore = spanSummaryStore || new SqliteSpanSummaryStore({ filePath: dbPath })` (mirrors the `narrationStore` construction line, shared db file); pass `spanSummaryStore` into the `LocalReadModel` ctor; `close()` adds `closeIfSupported(this.spanSummaryStore)`.
- `LocalReadModel` ctor accepts `spanSummaryStore = null`.
- `LocalReadModel.listSpanSummaries({ teamId, runtimeId = null })` — `if (!this.spanSummaryStore || typeof this.spanSummaryStore.listSummaries !== 'function') return [];` then `return this.spanSummaryStore.listSummaries({ teamId: requireString(teamId,'teamId'), runtimeId });` (the `listNarratedTimeline` guard shape).
- `LocalReadModel.listSpansAwaitingSummary({ teamId, runtimeId = null })` =
  ```javascript
  decideSpansToSummarize({
    spans: this.listSpans({ teamId, runtimeId }),
    summarizedSpanIds: new Set(this.listSpanSummaries({ teamId, runtimeId }).map((s) => s.spanId)),
  })
  ```
  It composes the already-guarded `listSpans` + `listSpanSummaries`, so `requireString`/absent-store guards stay **single-site** — NO duplicated guard (the P2b lesson; a second guard here is the over-reach defect).
- `LocalToadRuntime.listSpanSummaries(input)` → `this.readModel.listSpanSummaries(input)`; `LocalToadRuntime.listSpansAwaitingSummary(input)` → `this.readModel.listSpansAwaitingSummary(input)` — one-line delegations adjacent to `listSpans`, mirroring it exactly.

---

## §5 — Invariants (state so a future contributor does not "fix" them)

1. **Closed-span stability.** `detectSpans` is deterministic over the append-only ordered narrated stream; once a boundary closes a span, later narration forms *new* spans, so a closed span's `spanId` (= `span-${firstNarrationId}`) and content never change. `spanId` is therefore a sound **permanent** idempotency key — but only for closed spans; P3 never summarizes open ones (`decideSpansToSummarize` excludes `closed !== true`).
2. **First-write-wins idempotency.** A duplicate `appendSummary` for an existing `span_id` returns the stored row and never overwrites (`sqliteNarrationStore` discipline). Because closed spans are stable, a repeat is a retry, not new data.

---

## §6 — Error handling / totality

- Pure core never throws — degrades per §3 (bad input → `[]` / skipped entries).
- Store `requireString` rejects empty required fields with a `TypeError` (the `sqliteNarrationStore` precedent — a real misuse surfaced, not silently swallowed).
- `listSpanSummaries` / `listSpansAwaitingSummary` return `[]` when the store is absent (same guard shape as `listNarratedTimeline`/`listSpans`); no partial throws across the read path.

---

## §7 — Testing & anti-inert discipline

TDD. All suites wired into the canonical `package.json` `scripts.test` chain; controller independently re-runs the full root suite (fail 0) and greps the new suite titles in its own output (the P2a/P2b un-wired-test trap), reconciling the pass-count delta.

- `test/sqliteSpanSummaryStore.test.js` — idempotent append by `spanId` (`{inserted:false}` + unchanged row on duplicate, no overwrite even with different `summaryText`), `#ensureTeam` FK (insert without pre-creating the team succeeds), list ordering + `runtimeId` scoping, required-field `TypeError`, optional `model`/`cli`/`sessionId`/`tokens` null-tolerant, `createdAt` default.
- `test/spanSummary.decide.test.js` — closed-only; dedupe via `summarizedSpanIds` as a **Set and as an array**; oldest-first with `spanId` tiebreak; open spans excluded; empty input → `[]`; unparseable `startedAt` no-throw; non-object/missing-`spanId` entries skipped; determinism (same input → deep-equal output).
- `test/spanSummary.purity.test.js` — `decideSpansToSummarize.js`/`index.js` have no `node:`/`fs`/`path`/`os`/`child_process`/`react` import, no JSX, no `process` use (the `spanDetection.purity` precedent incl. the P2a-ratified JSX regex).
- `test/localToadRuntime.spanSummary.test.js` — e2e: absent-store → `[]`; **round-trip** on a real `LocalToadRuntime`: persist a closed span's narration (a `tool_use` then a `turn_completed` to close it — the §8d-ratified P2b test-4 ingestion shape, tolerating the unregistered-runtime identity rejection) → `listSpansAwaitingSummary` returns that closed span → `spanSummaryStore.appendSummary({...})` → `listSpansAwaitingSummary` now excludes it and `listSpanSummaries` returns it. This round-trip is the anti-inert proof: dormant in production (P3b is the first real writer, exactly as `listNarratedTimeline`/`listSpans` shipped) yet genuinely wired and exercised — not faked.

---

## §8 — Scope and explicitly deferred to P3b/P3c (banked, not lost)

**In P3a:** the `span_summaries` store, the pure `decideSpansToSummarize` core, the `LocalToadRuntime`/`LocalReadModel` exposure (`listSpanSummaries` + `listSpansAwaitingSummary`), the four suites + npm wiring.

**Banked for the P3b brainstorm (recorded so they are not re-litigated or lost):**
- **Local-fallback contradiction (unresolved):** the operator's "local Qwen + VM fallback" intent vs the operator-ratified `notes/deferred-decisions.md` "**Do NOT add a local fallback** … honest degradation to Layer-1-only is the accepted, correct fallback." Must be reconciled at the start of the P3b brainstorm.
- **Spawn-mechanism correction:** P3b uses the drift **L3 `llmJudge` one-shot `--print`** pattern (`src/drift/llm/llmJudge.js`) — stdin payload, stdout, stateless, no runtime registration, no broker participation — **not** `RuntimeSupervisor.launchAgent` (friction F2/F3/F5: the worker path force-injects stream-json/MCP and makes the spawn a broker/team participant by construction).
- **Routing:** off `teamConfig.lead.providerId` (the drift `providerResolver` precedent — pick a CLI ≠ the lead's provider), per-project configurable (F4: plan/subscription tier is stored nowhere; the lead provider is the only grounded "what are workers on" signal).
- **Circuit breaker:** in-memory rolling-window rate cap like drift L3's `l3RateCapPerHour` (F6: L3's cap/cache are in-memory, team-scoped, lost on restart — accepted precedent).
- **P3c:** cockpit/read-model surfacing of summaries + summarizer status (`summarizing`/`idle`/`rate-limited`/`degraded`); the system-service-vs-team-agent representation (F5 — there is no non-broker runtime precedent; an L3-style ephemeral spawn is not a runtime at all, which P3c leverages).

**Out entirely:** any change to P1 narration persistence / P2a `composeTimeline` / P2b `detectSpans` behavior, the live cockpit timeline rendering, drift, and any non-summarizer feature.

---

## §9 — Pinned items to confirm at implementation (§8d — ground, do not pre-invent)

- **Schema mechanism:** confirm `openToadDatabase` (`src/storage/sqlite.js`) executes the whole `schema.sql` on every open and that existing table DDL there uses `CREATE TABLE IF NOT EXISTS`; place the new `span_summaries` table in `schema.sql` (no `applyMigrations` entry needed for a new table). If `schema.sql` is NOT re-run on existing DBs, STOP and surface (the table would need a different creation path).
- **Store precedent:** copy the `sqliteNarrationStore.js` structure verbatim where applicable — `#ensureTeam` SQL, the idempotency-check-before-insert flow, `requireString`, `#rowTo*` mapping, ctor `{filePath,db}`, `close()`.
- **Read-model/runtime insertion sites:** mirror the exact `LocalReadModel.listSpans`/`listNarratedTimeline` guard+delegation and the `LocalToadRuntime.listSpans(input)→readModel` one-liner; place the new methods adjacent to `listSpans`. `listSpansAwaitingSummary` MUST delegate to the guarded `listSpans`/`listSpanSummaries` (no duplicated guard).
- **`Span` field names:** confirm against the real `detectSpans` output (`startedAt`, `spanId`, `closed`, `rowCount`, `tokens`) before the decide-core sorts/filters on them.
- **The e2e ingestion shape:** reuse the §8d-ratified P2b test-4 pattern (`tool_use` for an unregistered runtime persists narration before the identity throw; tolerate only `/unknown runtime identity/`) to get a real closed span end-to-end.
