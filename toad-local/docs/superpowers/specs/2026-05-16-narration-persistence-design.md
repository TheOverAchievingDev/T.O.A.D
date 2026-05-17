# Narration Persistence (Readability Layer-2, Sub-project P1) — design

> **Lineage / decomposition.** The post-Sub-project-C readability
> **Layer-2 summarizer** (banked in `notes/deferred-decisions.md`) was
> decomposed during brainstorming into three independent sub-projects,
> each its own spec → plan → implementation cycle:
> **P1** server-side narration persistence (this doc) ·
> **P2** composition extraction + span detection ·
> **P3** the spawned-CLI summarizer service (the banked runtime
> architecture — stays intact, unblocked by P1+P2).
> Agreed order **P1 → P2 → P3**. This spec is **P1 only**. The banked
> P3 decision is untouched.
>
> **Grounding-first discipline (§8d).** Derived by reading the current
> shipped code (the `RuntimeEventIngestor.ingest` seam, the
> `SqliteRuntimeEventLog` store + `schema.sql` mechanism, the pure
> server-importable `eventNarration.narrate()`, `LocalReadModel`), NOT
> from prose. Surfaced facts: there is **zero** server-side
> narrated-line/summary persistence today (the only durable substrate
> is `SqliteRuntimeEventLog` raw events); `narrate()` is already pure +
> server-importable (zero imports); `schema.sql` is applied via
> idempotent `CREATE TABLE IF NOT EXISTS` on every DB open; the
> ingestor already persists each event synchronously via
> `eventLog.appendEvent(...)`. Readability Slice-1 §4.4 explicitly
> specifies the post-C path: *the ingestor persists what `narrate()`
> returns* as `{ line, kind, tokens }`.

**Out of scope (non-goals):** the historical-view **UI** (an explicit
immediate follow-on, not P1 — P1 is the data contract only, matching the
data-contract-only discipline of the auth / Sub-project-C / eventNarration
slices); composition / span detection (P2); the LLM summarizer service
(P3); any change to `appendEvent` / `#publishEvent` / the compaction or
drift paths; any retention/prune of persisted narration; Codex/Gemini
narration branching (narration is whatever the provider-agnostic pure
`narrate()` already emits).

---

## 1. Goal & success criterion

Today every legible projection is client-side and ephemeral (SSE →
browser → discarded); a historical narrative view is impossible because
nothing durably records the operator-readable line for each event. P1
makes the `eventNarration` projection **durable**: as each runtime event
is ingested, the shared pure `narrate()` runs server-side and its
`{ line, kind, tokens }` is persisted, idempotently, alongside the raw
event — readable back, chronologically, per team/runtime.

P1 ships **no UI** and **no LLM**; its deliverable is the durable data
contract + read accessor that (a) is independently correct/testable and
(b) is the prerequisite substrate P2 (spans) and P3 (summaries) build on.

**Success criterion:** for every in-scope event the ingestor processes,
exactly one `narrated_lines` row is persisted carrying the exact
`narrate()` output, idempotent under event re-ingest, scoped/ordered by
team→runtime→time, readable via a `LocalReadModel` accessor exposed on
the existing API read surface; a narration write failure never affects
ingest or the raw `runtime_events` record; existing reactive paths are
byte-unchanged; root `npm test` `fail 0` with new suites wired into the
canonical chain; UI `tsc -b`/`vite build` stay green (proves the
data-contract addition broke nothing downstream).

---

## 2. Why this is a thin durable projection (not a re-derivation)

`eventNarration.narrate(normalized) → { line, kind, tokens }` is shipped,
pure, zero-import, and already server-importable
(`src/runtime/eventNarration/index.js`). P1 does **not** re-derive
narration or fork the module — it runs the *same* `narrate()` on the
server and persists the result. Readability Slice-1 §4.4 pins this
contract: *"the post-C ingestor persists what `narrate()` returns"*, the
persisted record is exactly `{ line, kind, tokens }` (with `kind`
persisted so P2 can group spans by it). P1 is the §4.4 server consumer,
nothing more.

---

## 3. Architecture (Option A1 — synchronous consumer in `RuntimeEventIngestor.ingest`)

Chosen over **A2** (async off `RuntimeEventBus` — the bus is for live SSE
streaming, not durable projection; adds ordering / at-least-once /
loss-on-crash complexity for no P1 benefit) and **A3** (lazy on-read
re-narration, no table — defeats §4.4: P2/P3 build on and attach rows to
the *persisted* stream; re-narrating at read is O(events)/view and
cannot carry future span/summary records). A1 is the symmetric sibling
of the `eventLog.appendEvent(...)` seam that already exists and is
§4.4-exact.

### 3.1 Data flow

```
RuntimeEventIngestor.ingest(normalized)
  ├─ const eventHash = hashStableJson(normalized)          (existing — already computed)
  ├─ eventLog.appendEvent({ idempotencyKey:`runtime-event:${eventHash}`, … })   (existing — UNCHANGED)
  ├─ #publishEvent(normalized)                              (existing live SSE — UNCHANGED)
  ├─ [NEW] #persistNarration(normalized, eventHash):
  │     if (!this.narrationStore) return;
  │     if (!NARRATED_TYPES.has(normalized.type)) return;
  │     try {
  │       const n = narrate(normalized);                    ← shared pure module, zero new dep
  │       this.narrationStore.appendNarration({
  │         idempotencyKey: `narration:${eventHash}`,        ← reuses the hash ingest already has
  │         eventId: <id from the eventResult ingest already holds from appendEvent>,
  │         runtimeId, teamId, agentId, sessionId, createdAt: normalized.createdAt,
  │         eventType: normalized.type,
  │         line: n.line, kind: n.kind, tokens: n.tokens,
  │       });
  │     } catch (err) { /* log + swallow — NEVER breaks ingest */ }
  └─ (rest of ingest UNCHANGED)
```

`NARRATED_TYPES = { tool_use, assistant_text, turn_completed,
approval_request }` — the exact set the eventNarration agreement test
scoped (the wired consumers' sourced types; `runtime_event` etc. are
deliberately excluded, §4.4). It is a small constant **defined at the
consumer** (a frozen `Set`); the agreement test's set is test-local and
not an exported module symbol, so P1 redefines it rather than importing
a test internal — keep the two in sync by the shared §4.4 rationale, not
a code dependency. The consumer is **purely additive**: it
runs after the existing `appendEvent`, never alters it, and its failure
is swallowed so the raw event (already durably in `runtime_events`) and
ingest are never compromised.

### 3.2 Store & schema

New `narrated_lines` table in `src/storage/schema.sql` (idempotent
`CREATE TABLE IF NOT EXISTS` — the established mechanism; existing DBs
get it automatically on next `openToadDatabase`, no version-migration
runner needed):

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
  tokens          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_narrated_lines_runtime ON narrated_lines(runtime_id, created_at);
CREATE INDEX IF NOT EXISTS idx_narrated_lines_team    ON narrated_lines(team_id, created_at);
```

`SqliteNarrationStore` (`src/runtime/sqliteNarrationStore.js`) mirrors
`SqliteRuntimeEventLog` exactly:

- `constructor({ filePath = ':memory:', db = null })` via
  `openToadDatabase` (shared db in production).
- `appendNarration(input)` — same idempotency discipline as
  `appendEvent`: if `idempotency_key` already present →
  `{ inserted:false, row:existing }`, no duplicate insert; else insert
  with a generated `narration_id` (uuid) and return
  `{ inserted:true, row }`. Same `#ensureTeam(teamId)` FK discipline
  `SqliteRuntimeEventLog` uses.
- `listNarration({ teamId, runtimeId = null })` — rows ordered
  `created_at ASC, narration_id ASC`, team-scoped, optionally
  runtime-scoped.

`tokens` persists `narrate()`'s `number | null` as-is (null for
`tool_use`/`assistant_text`/`approval_request`, a real
`output_tokens` for `turn_completed`, §4.1).

### 3.3 Read contract & wiring

`LocalReadModel.listNarratedTimeline({ teamId, runtimeId = null })` →
`{ line, kind, tokens, runtimeId, agentId, createdAt, eventId }[]`
chronological (the shape P2/P3 and the historical-view UI will consume).
Mirrors `listRuntimeAudit`: absent store → `[]` (never throws). Exposed
through the existing `apiServer` read surface the same way the other
`LocalReadModel` read methods are.

Construction (`LocalToadRuntime`): `this.narrationStore = new
SqliteNarrationStore({ db: <the shared runtime db> })`, threaded into
`RuntimeEventIngestor` via a new optional `narrationStore = null`
constructor param (exactly the optional-collaborator pattern of
`compactionHandler`/`compactionTrigger`) and into `LocalReadModel` via a
new optional `narrationStore`. Absent store everywhere = clean no-op
(unit-test ergonomics + back-compat), so the historical capability is
**opt-in by construction** but **always on in the real runtime**
(non-inert: the real `LocalToadRuntime` always builds it — proven by an
end-to-end test, §5).

---

## 4. Error handling

- `#persistNarration` is wrapped end-to-end in `try/catch`; any
  failure (DB, unexpected `narrate()` shape) is logged and swallowed.
  Ingest and the raw `runtime_events` append are **never** affected — a
  narration projection failure must not lose or block a raw event.
- `narrate()` is pure/total (degraded `{ line:'', kind:'system',
  tokens:null }`, never throws); the `try/catch` primarily guards the
  DB write.
- Idempotency: event re-ingest recomputes the same `eventHash`, so
  `narration:${eventHash}` collides and `appendNarration` no-ops
  (`inserted:false`) — exactly the `appendEvent` idempotency contract.
- Retention: **none**. `narrated_lines` is a durable projection of the
  `runtime_events` substrate (which itself is not pruned); it shares the
  events' lifetime. It is *not* operational bookkeeping, so it does
  **not** use the side-effect-log retention/prune mechanism — "durable
  scrollback" is the entire point.

---

## 5. Testing

- **TDD throughout.**
- **`SqliteNarrationStore` unit** (`:memory:`): `appendNarration`
  inserts a correct row; idempotency dedup (same key →
  `inserted:false`, exactly one row); `listNarration` ordering +
  team-scope + optional runtime-scope; `tokens` `null` vs `number`
  round-trip. Mirror `test/sqliteRuntimeEventLog.test.js` (do not invent
  a different harness).
- **Ingestor integration:** ingesting each in-scope type
  (`tool_use`/`assistant_text`/`turn_completed`/`approval_request`)
  persists exactly the `narrate()` `{line,kind,tokens}`; a
  non-`NARRATED_TYPES` event persists **no** row; **`narrationStore`
  absent → ingest still succeeds**; **`appendNarration` throws → ingest
  still succeeds AND the raw event is still in `runtime_events`** (a
  real non-fatal assertion, not a tautology — the lying-test guard).
- **`LocalReadModel.listNarratedTimeline`:** returns persisted rows in
  chronological order; absent store → `[]`.
- **End-to-end anti-inert:** a real `new LocalToadRuntime()` ingest of a
  `turn_completed` then `listNarratedTimeline` returns the narrated line
  — proving the real runtime wires the store live (the same
  decisive-probe discipline used for Sub-project C).
- **Gates:** new test files wired into the canonical `npm test` chain
  (grep the new suites' titles in the actual full-run output — the
  un-wired-test false-green trap); root `npm test` `fail 0`; UI
  `tsc -b`/`vite build` green; a **whole-implementation review before
  each commit** (the gate that caught the auth no-creds Critical and the
  readability lying-behaviorTable).

---

## 6. Surfacing

P1 surfaces nothing to the operator directly (no UI by scope). Its
observable contract is the `listNarratedTimeline` accessor on the
existing API read surface — the historical-view UI follow-on, P2, and P3
are its consumers. This is the same "ship the honest data contract;
rendering is downstream" discipline as the eventNarration Slice-1,
Sub-project B, and the auth/compaction work.

---

## 7. Pinned / open (resolved at plan-time by grounding, not pre-invented)

- **The appended event's `event_id`** linked into `narrated_lines`:
  `RuntimeEventIngestor.ingest` already calls `eventLog.appendEvent(...)`
  whose return carries the event id — the exact field/return shape is
  grounded from `SqliteRuntimeEventLog.appendEvent`'s real return at
  plan-time and threaded into `appendNarration({ eventId })` (best-effort
  link; `narrated_lines` does not hard-FK `runtime_events` to stay
  decoupled and crash-tolerant).
- **`hashStableJson` reuse:** the ingestor already computes
  `eventHash`; `#persistNarration` reuses that exact value (no second
  hash) — confirmed against the real `ingest()` body at plan-time.
- **`apiServer` exposure point:** the precise existing read
  endpoint/tool through which `LocalReadModel` read methods are surfaced
  is grounded from the real `apiServer`/read wiring at plan-time and
  mirrored (no new bespoke endpoint shape invented).
- **`#ensureTeam` discipline:** whether `narrated_lines` mirrors
  `SqliteRuntimeEventLog`'s `#ensureTeam(teamId)` FK call is confirmed
  against the real store + `schema.sql` FK constraints at plan-time
  (mirror it exactly — same teams-table discipline).

---

## 8. Scope summary

**In:** `narrated_lines` table (schema.sql) + `SqliteNarrationStore`
(append/list, idempotent, mirrors `SqliteRuntimeEventLog`); a purely
additive synchronous `#persistNarration` consumer in
`RuntimeEventIngestor.ingest` (non-fatal, idempotent, in-scope types
only); `LocalReadModel.listNarratedTimeline` + existing-API exposure;
`LocalToadRuntime` construction/threading; full TDD + gates.

**Out (explicit / banked):** historical-view UI (immediate follow-on);
P2 composition/spans; P3 summarizer/LLM; any change to
`appendEvent`/`#publishEvent`/compaction/drift; narration retention/prune;
provider-specific narration branching.

**Likely commit decomposition (plan finalizes):** **Commit 1** =
`SqliteNarrationStore` + `schema.sql` table + store unit suite (wired) —
a self-contained durable-storage unit. **Commit 2** = ingestor
`#persistNarration` + `LocalReadModel.listNarratedTimeline` + API
exposure + `LocalToadRuntime` wiring + integration/e2e suites + gates +
whole-impl review. Two atomic commits, mirroring the B/C Layer-A/Layer-B
shape.
