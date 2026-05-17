# Span-Summarizer Engine (Readability Layer-2 P3b-1) — Design

**Status:** Approved design (brainstorm complete). Next: implementation plan via `superpowers:writing-plans`.

**Goal:** A dormant-but-fully-tested summarizer **engine** — pure prompt-builder + summary-extractor + route resolver + in-memory circuit breaker + an `llmJudge`-mirrored injected-spawn one-shot CLI runner + an injected-deps orchestrator — that turns P3a's pending closed spans into persisted plain-English summaries via a provider-CLI competing on a non-worker plan, degrading honestly when unavailable.

**Architecture:** New `src/runtime/spanSummary/` units (alongside P3a's `decideSpansToSummarize.js`): maximal pure surface + one thin injected-IO spawn seam + an orchestrator taking all IO as injected deps. Drift's `src/drift/llm/*` is byte-untouched — the spawn discipline is *mirrored*, not imported. No production trigger/wiring (P3b-2 owns that) — the engine is a callable verified by injected-`spawnImpl` unit tests + an anti-inert e2e over a real `LocalToadRuntime`.

**Tech stack:** Node ≥20 ESM, `node:test`, the project's pure-core + injected-IO + sealed-config discipline (eventNarration / detectSpans / decideSpansToSummarize / llmJudge lineage).

**P3 decomposition:** P3a (persistence + decide core, DONE) → **P3b-1 (this: the engine)** → P3b-2 (the `dev-api-server.mjs` DriftMonitor-style poller + start/stop lifecycle + degraded-signal surfacing) → P3c (cockpit/status surfacing).

---

## §0 — Context and §8d grounded facts (verified against shipped code 2026-05-17)

Predecessors shipped this session: P1 narration persistence; P2a `composeTimeline`; P2b `detectSpans`; **P3a** (Commits `e0c0edd` + `0033507`, wiring ratification `21454c2`) — `SqliteSpanSummaryStore` (idempotent `appendSummary` first-write-wins by `span_id`), pure `decideSpansToSummarize`, compute-on-read `LocalReadModel.listSpanSummaries` / `listSpansAwaitingSummary` + `LocalToadRuntime` delegations. **No production writer of `appendSummary` exists yet — P3b-1's orchestrator is the first.**

Grounded facts that constrain P3b-1 (surfaced, not smoothed — §8d; from the P3b code-explorer map):

1. **The spawn precedent is drift's `src/drift/llm/llmJudge.js`** (NOT `RuntimeSupervisor.launchAgent`). `llmJudge({cli,model,systemPrompt,userPayload,briefPath,cwd,isolateHome,timeoutMs,spawnImpl,resolveCliImpl,needsShellImpl})`: a direct `node:child_process.spawn` one-shot. Per-cli argv (`buildInvocation`): **claude inline** `['--model',model,'--print','--setting-sources','project,local','--tools','']` with stdin = `systemPrompt + "\n\n" + userPayload`; **codex** `['exec','--model',model,'-']` stdin = payload; **gemini** `['-m',model,'-p',combined]` stdin = `null`. `spawnImpl` default `node:child_process.spawn`; `resolveCliImpl` default `resolveCli` (`src/foundry/providers/resolveCli.js` — PATH/PATHEXT `.cmd/.exe/.bat` walk on win32); `needsShellImpl` default = `shell:true` only on win32 when the resolved path ends `.cmd`/`.bat`. `isolateHome && cwd` ⇒ `env={...process.env, HOME:cwd, USERPROFILE:cwd}` minus every `CLAUDE_*` except `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`. Timeout: `setTimeout(timeoutMs)` → `proc.kill('SIGKILL')` → reject `llmJudge: timeout after Nms`. Throw strings: `llmJudge: spawn_failed: …` / `llmJudge: timeout after …` / `llmJudge: invalid_response: …`. `llmJudge` returns JSON-`findings` — **P3b-1's runner must NOT reuse it (drift JSON contract + out-of-scope) — it MIRRORS the spawn discipline for PLAIN-TEXT output.**
2. **Routing** (`src/drift/llm/providerResolver.js`): `resolveProvider({teamConfig,settings,tier})` routes solely off `teamConfig?.lead?.providerId` (FALLBACK `'anthropic'`); `PROVIDER_MAP` = `anthropic:{cli:'claude',tier1:'haiku',tier2:'sonnet'}`, `openai:{cli:'codex',tier1:'gpt-5-codex',tier2:'gpt-5'}`, `gemini:{cli:'gemini',tier1:'gemini-2.5-flash',tier2:'gemini-2.5-pro'}`; `settings.drift.tier{1,2}ModelOverride` wins. No load-awareness exists. ⟹ the summarizer routes off the same `teamConfig.lead.providerId` signal; per-project override mirrors `settings.drift.*` as `settings.summarizer.*`.
3. **Circuit-breaker precedent** (`src/drift/driftEngine.js`): `#l3RateWindow = Map(teamId → number[])`, rolling `60*60*1000` ms window, `settings.drift.l3RateCapPerHour` default `30`; trip ⇒ skip (not throw); **in-memory, lost on sidecar restart** (instance field).
4. **No span-boundary event** (friction F5/F6): there is NO `span_closed`/`turn_completed` event on `RuntimeEventBus`/`RuntimeEventIngestor`. `DriftEngine`/`DriftMonitor` are NOT owned by `LocalToadRuntime` — they are wired in `scripts/dev-api-server.mjs` and fire via a periodic tick + task-event. ⟹ the summarizer's trigger is a DriftMonitor-style **poller of `listSpansAwaitingSummary`**, owned in `dev-api-server.mjs` — **that is P3b-2, NOT P3b-1**. P3b-1's orchestrator is a callable with injected deps; no trigger.
5. **P3a contract** (the orchestrator's injected deps): `LocalToadRuntime.listSpansAwaitingSummary({teamId,runtimeId?})` → `Span[]` (closed, not-yet-summarized, oldest-first), `Span = {spanId,agentId,runtimeId,teamId,sessionId,startedAt,endedAt,closed,boundary,rowCount,tokens,rows:[{narrationId,eventId,eventType,kind,line,tokens,createdAt}]}`. `spanSummaryStore.appendSummary({spanId,teamId,runtimeId,agentId,sessionId?,summaryText,model?,cli?,spanStartedAt,spanEndedAt,rowCount,tokens?,createdAt?})` → idempotent first-write-wins by `spanId`, returns `{inserted,row}`.
6. **§8d STOP rule:** if any pin (the `llmJudge` argv/stdin/`isolateHome`/timeout/error specifics + defaults, the `Span`/`appendSummary` field names, the `SettingsStore` surface for `settings.summarizer.*`) is wrong at implementation time, STOP and surface for controller pre-emptive ratification (auth/compaction/narration/P2a/P2b/P3a precedent). Do not code around a wrong spec.

**The local-fallback contradiction — RESOLVED (operator decision this brainstorm):** the operator's earlier "local Qwen + VM fallback" remark is **superseded by their own ratified `notes/deferred-decisions.md` decision**: NO local fallback. On rate-limit/CLI-unavailability ⇒ honest degradation to Layer-1-only; optional failover only to another **plan-CLI** provider, never a local model; zero new infra/auth. P3b-1 does **no in-run failover** (deferred; honest degradation is the accepted fallback — YAGNI).

---

## §1 — Architecture and module boundaries

All new, in `src/runtime/spanSummary/` (joining P3a's `decideSpansToSummarize.js`):

- `buildSummaryPrompt.js` — pure.
- `extractSummaryText.js` — pure.
- `resolveSummaryRoute.js` — pure.
- `summaryRateLimiter.js` — `SummaryRateLimiter` class (in-memory; injected clock).
- `runSpanSummary.js` — the only IO seam: an `llmJudge`-mirrored one-shot (injected `spawnImpl`/`resolveCliImpl`/`needsShellImpl`).
- `summarizePendingSpans.js` — the orchestrator (all IO injected).
- `summarizerSystemPrompt.js` — the fixed personality constant.
- `index.js` — re-export.

Dormant: no production trigger, no `LocalToadRuntime`/`LocalReadModel`/`dev-api-server`/drift change. Drift `src/drift/llm/*` byte-untouched (mirror, not import).

---

## §2 — The pure units

### `buildSummaryPrompt(span) → { systemPrompt, userPayload }`
Pure, total. `systemPrompt` = `SUMMARIZER_SYSTEM_PROMPT` (§6). `userPayload` = a compact rendering:
```
Agent <span.agentId> on runtime <span.runtimeId>, <span.startedAt> – <span.endedAt>:
- <rows[0].line>
- <rows[1].line>
…
```
Built from `span.rows.map(r => "- " + String(r && r.line != null ? r.line : "")).join("\n")` — **reuses P1's already-narrated `line`, never re-narrates**. Missing/odd `span`/`rows` tolerated (no throw; empty rows ⇒ a header-only payload).

### `extractSummaryText(stdout) → string | null`
Pure, total. Strip leading/trailing ```` ``` ```` code fences (and ```` ```lang ````), strip a single leading label like `Summary:` / `summary:` (case-insensitive, optional), trim, collapse blank-line runs to one, hard-cap at **600** chars (slice, no throw). If the result is empty/whitespace-only ⇒ `null` (⇒ degrade; **never persist a junk summary**). Non-string input ⇒ `null`.

### `resolveSummaryRoute({ leadProviderId, settings }) → { providerId, cli, model }`
Pure, total. `SUMMARY_PROVIDER_MAP` (frozen) = `{ anthropic:{cli:'claude',model:'haiku'}, openai:{cli:'codex',model:'gpt-5-codex'}, gemini:{cli:'gemini',model:'gemini-2.5-flash'} }` (tier1/cheapest, mirroring drift's PROVIDER_MAP tier1). Default preference order `['gemini','openai','anthropic']`; let `lead = (typeof leadProviderId==='string' && SUMMARY_PROVIDER_MAP[leadProviderId]) ? leadProviderId : 'anthropic'`; `providerId` = the first entry in the preference order `!== lead`. Overrides: if `settings?.summarizer?.providerId` is a known key, it replaces `providerId` entirely; then `cli/model` from `SUMMARY_PROVIDER_MAP[providerId]`; if `settings?.summarizer?.model` is a non-empty string it replaces `model`. (Provider *availability/failover* is the orchestrator's concern, not this pure fn.)

---

## §3 — `SummaryRateLimiter` (in-memory, the L3 pattern)

`class SummaryRateLimiter { constructor({ maxPerHour, now }); tryAcquire(teamId) → boolean }`. In-memory `Map(teamId → number[])`; `WINDOW_MS = 3_600_000`. `tryAcquire(teamId)`: `ts = this.now()`; evict entries `< ts - WINDOW_MS`; if `kept.length >= maxPerHour` ⇒ store kept, return `false` (do **not** record — exactly the drift `#l3RateWindow` discipline); else store `[...kept, ts]`, return `true`. `maxPerHour` from `settings.summarizer.maxPerHour` (default **20**); `now` injected (default `Date.now`). **Known-property:** in-memory, **resets on process restart** — accepted L3 precedent; stated so no contributor "fixes" it.

---

## §4 — `runSpanSummary` (the only IO seam — `llmJudge`-mirrored, plain-text)

```
async runSpanSummary({ systemPrompt, userPayload, cli, model, cwd, isolateHome,
  timeoutMs, spawnImpl, resolveCliImpl, needsShellImpl })
  → { ok:true, summaryText } | { ok:false, reason }
```
Mirrors `llmJudge`'s spawn discipline **exactly** (re-grounded at implementation against `src/drift/llm/llmJudge.js`): per-cli argv (claude `['--model',model,'--print','--setting-sources','project,local','--tools','']`; codex `['exec','--model',model,'-']`; gemini `['-m',model,'-p',combined]`), stdin = `systemPrompt+"\n\n"+userPayload` for claude/codex / positional `-p` (`combined = systemPrompt+"\n\n"+userPayload`) for gemini; `isolateHome` HOME/USERPROFILE/CLAUDE_* scrub; `timeoutMs`→SIGKILL; defaults `spawnImpl=node:child_process.spawn`, `resolveCliImpl=resolveCli`, `needsShellImpl`=win32-`.cmd/.bat`-shell rule (`timeoutMs` default 30000). Output is **plain text** (NOT JSON): on exit 0 → `t = extractSummaryText(stdout)`; if `t` is a non-empty string ⇒ `{ok:true,summaryText:t}`; otherwise (`t` is `null` or empty) ⇒ `{ok:false,reason:'empty_output'}`. **Never throws — total:** spawn/exec failure ⇒ `{ok:false,reason:'spawn_failed'}`; nonzero exit ⇒ `{ok:false,reason:'spawn_failed'}`; timeout ⇒ `{ok:false,reason:'timeout'}`; `resolveCliImpl` returns nothing ⇒ `{ok:false,reason:'cli_unresolved'}`. (`reason` is a sealed set: `'spawn_failed'|'timeout'|'empty_output'|'cli_unresolved'`.) **Mirror, not import** — drift untouched.

---

## §5 — `summarizePendingSpans` orchestrator + honest-degradation report

```
async summarizePendingSpans({ teamId, listAwaiting, appendSummary, leadProviderId,
  settings, now, limiter, runImpl, max })
  → { summarized:[{spanId,model,cli}], degraded:[{spanId,reason}], skippedRateLimited:number }
```
All IO injected (no direct store/spawn access). Steps:
1. `spans = listAwaiting({ teamId })` (P3a returns closed + oldest-first); cap to the first `max` (`settings?.summarizer?.maxPerRun`, default **10** — bounds a startup-backlog burst, complements the hourly breaker).
2. For each span in order: if `!limiter.tryAcquire(teamId)` ⇒ set `skippedRateLimited` = the count of spans from the current one onward (inclusive — the current span plus every still-unprocessed span in the capped list) and **stop** (those spans stay pending — the next run retries them).
3. `route = resolveSummaryRoute({ leadProviderId, settings })`; `{systemPrompt,userPayload} = buildSummaryPrompt(span)`; `r = await runImpl({ systemPrompt, userPayload, cli:route.cli, model:route.model, cwd: input.cwd ?? undefined, isolateHome: input.isolateHome ?? false, timeoutMs: settings?.summarizer?.timeoutMs })` (the orchestrator passes `cwd`/`isolateHome` straight through from its own injected `input`; `runSpanSummary` defaults `timeoutMs` to 30000 when `undefined`).
4. `r.ok` ⇒ `appendSummary({ spanId:span.spanId, teamId:span.teamId, runtimeId:span.runtimeId, agentId:span.agentId, sessionId:span.sessionId, summaryText:r.summaryText, model:route.model, cli:route.cli, spanStartedAt:span.startedAt, spanEndedAt:span.endedAt, rowCount:span.rowCount, tokens:span.tokens })`; `summarized.push({spanId,model:route.model,cli:route.cli})`.
5. else ⇒ `degraded.push({ spanId:span.spanId, reason:r.reason })` and **do NOT `appendSummary`** (honest degradation; span stays pending; P3a first-write-wins makes the eventual retry idempotent).
6. Return the report (the P3c-facing signal; P3b-1 only returns it — no surfacing). **Never throws** (a per-span failure is isolated into `degraded`, loop continues).

> `cwd`/`isolateHome` for the spawn: P3b-1 passes them through from injected options (the orchestrator's caller decides; P3b-2 supplies the project cwd). Default: `cwd=undefined`, `isolateHome=false` (a one-shot read-only `--print` summarizer needs no HOME isolation; if a project later wants it, P3b-2 sets it). Stated as a pin, not pre-invented.

---

## §6 — `SUMMARIZER_SYSTEM_PROMPT` (the whole personality)

A single exported frozen string:
```
You are a span summarizer for an engineering activity log. Your ONLY job: read the
activity below and produce ONE plain-English sentence (at most two short sentences)
that tells a non-coder what the agent did during this span. Output ONLY the summary
text — no preamble, no markdown, no bullet points, no questions, no suggestions, no
code, no tool use. If the activity is trivial or idle, say that in one short clause.
```
The recipe's "system-prompt-is-the-whole-personality" — a frontier CLI told a narrow job will otherwise be helpfully wrong (suggestions/questions/tangents).

---

## §7 — Invariants & known-properties (state so a future contributor does not "fix" them)

1. **No local fallback.** Failure/unavailability ⇒ honest Layer-1-only (span stays unsummarized; report carries the reason). Deliberate, ratified.
2. **Idempotent re-runs.** Failed/skipped spans stay pending and are retried next invocation; P3a `appendSummary` first-write-wins makes a duplicate harmless.
3. **In-memory breaker resets on restart.** Accepted L3 precedent.
4. **CLI/plan-availability-dependent.** If the routed plan is exhausted, summaries simply don't generate; P3c degrades the UI to Layer-1-only.
5. **Dormant in P3b-1.** No production trigger/wiring (P3b-2 owns it); the engine is verified by injected-IO tests + the anti-inert e2e.
6. **Mirror, not import.** `runSpanSummary` replicates `llmJudge`'s spawn discipline; `src/drift/llm/*` stays byte-untouched.
7. **Single route, no in-run failover** in P3b-1 (deferred; consistent with honest-degradation + YAGNI).

---

## §8 — Error handling / totality

Pure units never throw (degrade per §2). `runSpanSummary` never throws (`{ok:false,reason}` for every failure mode). `summarizePendingSpans` never throws (per-span failure → `degraded`, continue). No fake/empty summary is ever persisted. The only intentional throws are P3a `appendSummary`'s `requireString`/`requireNonNegativeInteger` — and the orchestrator only calls it with the validated `Span` fields, so they never fire in practice.

---

## §9 — Testing & anti-inert discipline

TDD. Suites wired into the ratified `scripts/test-suites.txt` (the `run-test-suites.mjs` runner; controller independently re-runs full root fail-0, greps the new titles in its own output, reconciles the pass-count delta — the established un-wired-test trap closure). **No real CLI ever** — `spawnImpl` is injected:

- `test/spanSummary.buildPrompt.test.js` — span → `{systemPrompt,userPayload}`; rows rendered from `r.line`; totality on missing/odd spans.
- `test/spanSummary.extract.test.js` — fences, leading label, blank-collapse, 600-cap, empty/whitespace→`null`, non-string→`null`.
- `test/spanSummary.route.test.js` — pref-minus-lead for every `leadProviderId` (anthropic/openai/gemini/unknown/absent); `settings.summarizer.providerId`/`model` overrides; the tier1 `SUMMARY_PROVIDER_MAP`.
- `test/spanSummary.rateLimiter.test.js` — rolling-hour window, cap boundary, evict-old, per-team isolation, injected `now`, false-does-not-record.
- `test/spanSummary.runSpanSummary.test.js` — injected `spawnImpl`: success→`{ok,summaryText}`, nonzero→`spawn_failed`, timeout→`timeout`, empty stdout→`empty_output`, unresolved cli→`cli_unresolved`, per-cli argv shape (claude/codex/gemini), `isolateHome` env scrub, **never throws**.
- `test/spanSummary.orchestrator.test.js` — injected `listAwaiting`/`appendSummary`/`runImpl`/`now`/`limiter`: success persists with the exact `appendSummary` fields, failure→`degraded` (no persist), rate-limit→`skippedRateLimited`+stop, oldest-first, `maxPerRun` cap, idempotent re-run, never throws.
- `test/spanSummary.purity.test.js` — the pure units + `index.js`: no `node:`/`fs`/`path`/`os`/`child_process`/`react` import, no JSX, no `process` (the `spanSummary`/`spanDetection` purity precedent).
- **`test/spanSummary.summarizer.e2e.test.js` (anti-inert)** — a real `new LocalToadRuntime()`; the §8d-ratified P2b ingestion (`tool_use` for an unregistered runtime tolerating `/unknown runtime identity/`, then `turn_completed`) ⇒ one closed span; call `summarizePendingSpans({ teamId, listAwaiting: a=>rt.listSpansAwaitingSummary(a), appendSummary: s=>rt.spanSummaryStore.appendSummary(s), leadProviderId:'anthropic', settings:{}, now:Date.now, limiter:new SummaryRateLimiter({maxPerHour:20,now:Date.now}), runImpl: async()=>({ok:true,summaryText:'agent read a.js'}) })` ⇒ assert `rt.listSpanSummaries({teamId})` shows it (`summaryText`/`model`/`cli` set), `rt.listSpansAwaitingSummary({teamId})` now excludes it; a second call ⇒ idempotent (no dup, `inserted:false`). Genuinely composes with P3a through a real runtime, **no real spawn** — the proven P1/P2b/P3a dormant-but-non-inert pattern.

---

## §10 — Scope & §8d pins

**In P3b-1:** the 8 `src/runtime/spanSummary/` engine modules + the system-prompt constant + the 8 suites + npm wiring (append to `scripts/test-suites.txt`). Purely additive in `src/runtime/spanSummary/` + `test/`.

**Deferred:** P3b-2 = the `scripts/dev-api-server.mjs` DriftMonitor-style poller of `listSpansAwaitingSummary` + start/stop lifecycle + plumbing the degradation report to where P3c reads it. P3c = cockpit/status (`summarizing`/`idle`/`rate-limited`/`degraded`). **Out entirely:** `src/drift/llm/*` (byte-untouched — mirror only), P1/P2a/P2b/P3a behavior, `LocalToadRuntime`/`LocalReadModel` (no new method — the orchestrator is a function with injected deps), the live cockpit timeline, narration/composeTimeline/detectSpans, any non-summarizer feature.

**§8d pins (ground at implementation, do not pre-invent):**
- The exact `llmJudge` per-cli argv, stdin assembly, `isolateHome` env transform, timeout/SIGKILL, and the default `spawnImpl`/`resolveCliImpl`/`needsShellImpl` (re-read `src/drift/llm/llmJudge.js` + `src/foundry/providers/resolveCli.js`) — `runSpanSummary` mirrors them; if they differ from §0.1, STOP and ratify.
- The P3a `Span` field names (`startedAt`/`endedAt`/`rowCount`/`tokens`/`agentId`/`runtimeId`/`sessionId`/`spanId`/`rows[].line`) and `appendSummary` input contract (re-read `src/runtime/spanDetection/detectSpans.js` + `src/runtime/sqliteSpanSummaryStore.js`).
- The `settings.summarizer.*` surface — confirm how drift reads `settings.drift.*` via `SettingsStore` and mirror that read shape (the orchestrator/route receive `settings` injected; P3b-1 does NOT wire `SettingsStore` — P3b-2 supplies `settings`).
- `scripts/test-suites.txt` is the ratified canonical chain (per `21454c2`); append the new suites there, not to `package.json`.
