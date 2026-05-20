# Span-Summarizer Engine (Readability Layer-2 P3b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dormant-but-fully-tested summarizer **engine** in `src/runtime/spanSummary/` — pure prompt-builder + summary-extractor + route resolver + in-memory circuit breaker + an `llmJudge`-mirrored injected-spawn one-shot runner + an injected-deps orchestrator — that turns P3a's pending closed spans into persisted plain-English summaries, degrading honestly when the routed CLI plan is unavailable.

**Architecture:** Maximal pure surface + one thin injected-IO spawn seam (`runSpanSummary`, mirroring drift `llmJudge`'s discipline for PLAIN TEXT — NOT importing it; drift byte-untouched) + an orchestrator taking all IO injected. No production trigger/wiring (P3b-2 owns that) — verified by injected-`spawnImpl` unit tests + an anti-inert e2e over a real `LocalToadRuntime`.

**Tech Stack:** Node ≥20 ESM, `node:test`, the project's pure-core + injected-IO + sealed-config discipline.

**Spec:** `docs/superpowers/specs/2026-05-17-span-summarizer-engine-design.md` (committed `cad217d`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/spanSummary/summarizerSystemPrompt.js` (create) | `SUMMARIZER_SYSTEM_PROMPT` frozen string (the whole personality). |
| `src/runtime/spanSummary/buildSummaryPrompt.js` (create) | Pure `buildSummaryPrompt(span) → {systemPrompt,userPayload}`. |
| `src/runtime/spanSummary/extractSummaryText.js` (create) | Pure `extractSummaryText(stdout) → string|null`. |
| `src/runtime/spanSummary/resolveSummaryRoute.js` (create) | Pure `resolveSummaryRoute({leadProviderId,settings}) → {providerId,cli,model}` + frozen `SUMMARY_PROVIDER_MAP`. |
| `src/runtime/spanSummary/summaryRateLimiter.js` (create) | `class SummaryRateLimiter` — in-memory rolling-hour, L3 pattern. |
| `src/runtime/spanSummary/runSpanSummary.js` (create) | The ONLY IO seam: `llmJudge`-mirrored one-shot, injected spawn, never throws. |
| `src/runtime/spanSummary/summarizePendingSpans.js` (create) | The orchestrator: all IO injected; honest-degradation report; never throws. |
| `src/runtime/spanSummary/index.js` (**modify** — P3a's barrel) | Append re-exports of the new modules (P3a's `decideSpansToSummarize` export unchanged). |
| `test/spanSummary.buildPrompt.test.js` (create) | TDD unit. |
| `test/spanSummary.extract.test.js` (create) | TDD unit. |
| `test/spanSummary.route.test.js` (create) | TDD unit. |
| `test/spanSummary.rateLimiter.test.js` (create) | TDD unit. |
| `test/spanSummary.enginePurity.test.js` (create) | Purity guard for the 5 pure engine files. |
| `test/spanSummary.runSpanSummary.test.js` (create) | Injected-`spawnImpl` unit. |
| `test/spanSummary.orchestrator.test.js` (create) | Injected-deps unit. |
| `test/spanSummary.summarizer.e2e.test.js` (create) | Anti-inert e2e over a real `LocalToadRuntime` + a fake `runImpl`. |
| `scripts/test-suites.txt` (**modify** — the ratified chain) | Append the 8 new suites (NOT `package.json`). |

**Commit decomposition (2 atomic commits, the proven P2b/P3a cadence):**
- **Commit 1 (Tasks 1–6):** the 5 pure/breaker modules + index append + their 5 suites, wired, full root fail 0.
- **Commit 2 (Tasks 7–10):** `runSpanSummary` + `summarizePendingSpans` + index append + their 2 unit suites + the anti-inert e2e, wired, full root fail 0 + grep all P3b-1 titles in own output, whole-impl review, Commit 2 + post-commit out-of-scope-empty verify.

Tasks within a commit accumulate **uncommitted**; only Task 6 and Task 10 commit. `index.js` grows in both commits (C1 appends the 5 pure re-exports; C2 appends `runSpanSummary`/`summarizePendingSpans`) — each commit's `index.js` is consistent with that commit's modules.

---

## §8d Grounded pins (verified against shipped code 2026-05-17 — do not re-invent)

- **`llmJudge` mirror precedent** (`src/drift/llm/llmJudge.js`): inline mode (P3b-1 has no `briefPath` — always inline) builds `combined = ${systemPrompt}\n\n${userPayload}`; **claude** `args=['--model',model,'--print','--setting-sources','project,local','--tools','']` stdin=`combined`; **codex** `args=['exec','--model',model,'-']` stdin=`combined`; **gemini** `args=['-m',model,'-p',combined]` stdin=`null`. `defaultNeedsShell(resolved)= process.platform==='win32' && /\.(cmd|bat)$/i.test(resolved)`. `stdio = stdin!==null ? ['pipe','pipe','pipe'] : ['ignore','pipe','pipe']`. `spawnOpts={stdio,shell}`; `cwd` non-empty string ⇒ `spawnOpts.cwd=cwd`; `isolateHome&&cwd` ⇒ `env={...process.env,HOME:cwd,USERPROFILE:cwd}` then delete every `CLAUDE_*` except `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX` ⇒ `spawnOpts.env=env`. `setTimeout(timeoutMs)`→`proc.kill('SIGKILL')`. Defaults: `spawnImpl=spawn` from `node:child_process`, `resolveCliImpl=resolveCli` from `../../foundry/providers/resolveCli.js`, `needsShellImpl=defaultNeedsShell`. **`runSpanSummary` MIRRORS this for PLAIN TEXT — does NOT import `llmJudge`, NEVER throws (returns `{ok:false,reason}`), drift `src/drift/llm/*` byte-untouched.**
- **`resolveCli(name,{platform,pathEnv,existsSyncImpl})`** (`src/foundry/providers/resolveCli.js`): throws `TypeError` only if `name` is not a non-empty string; non-win32 ⇒ returns `name`; win32 ⇒ PATH×[.cmd,.exe,.bat] walk, first hit, else returns `name` (never null/empty for a valid name). ⟹ a not-installed CLI ⇒ `spawn` ENOENT ⇒ proc `'error'` ⇒ `reason:'spawn_failed'`; `reason:'cli_unresolved'` only for an unsupported `cli`/non-string model/`resolveCliImpl` throwing-or-returning-junk.
- **L3 rate-window** (`src/drift/driftEngine.js:260-268`): `windowMs=60*60*1000`; `win=(map.get(teamId)||[]).filter(t=>nowTs-t<windowMs)`; `win.length>=cap` ⇒ `map.set(teamId,win)` + skip (**does NOT record the rejected attempt**); else record `[...win,nowTs]`. `SummaryRateLimiter` mirrors this exactly.
- **P3a `Span`** (`src/runtime/spanDetection/detectSpans.js`): `{spanId,agentId,runtimeId,teamId,sessionId,startedAt,endedAt,closed,boundary,rowCount,tokens,rows:[{narrationId,eventId,eventType,kind,line,tokens,createdAt}]}`. **P3a `appendSummary`** (`src/runtime/sqliteSpanSummaryStore.js`): input `{spanId,teamId,runtimeId,agentId,sessionId?,summaryText,model?,cli?,spanStartedAt,spanEndedAt,rowCount,tokens?,createdAt?}` → idempotent first-write-wins by `spanId`. `LocalToadRuntime.listSpansAwaitingSummary({teamId,runtimeId?})` / `.listSpanSummaries(...)` / `.spanSummaryStore.appendSummary(...)` are the P3a-shipped reads/write the e2e composes.
- **Ratified wiring** (`21454c2`): `package.json` `scripts.test` is `node scripts/run-test-suites.mjs`; the canonical chain is `scripts/test-suites.txt` (currently 142 suites, tail `… && node --no-warnings --test test/localToadRuntime.spanSummary.test.js`). New suites append ` && node --no-warnings --test test/…` to **`scripts/test-suites.txt`** — NOT `package.json`. Post-P3a baseline = **1491 pass**.
- **§8d STOP rule:** if any pin is wrong at impl time, STOP and surface for controller pre-emptive ratification (auth/compaction/narration/P2a/P2b/P3a/`21454c2` precedent). Do not code around a wrong plan.

---

## Task 1: `SUMMARIZER_SYSTEM_PROMPT` + `buildSummaryPrompt` + index

**Files:** Create `src/runtime/spanSummary/summarizerSystemPrompt.js`, `src/runtime/spanSummary/buildSummaryPrompt.js`; Modify `src/runtime/spanSummary/index.js`; Test `test/spanSummary.buildPrompt.test.js`.

- [ ] **Step 1: Write the failing unit suite**

Create `test/spanSummary.buildPrompt.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPrompt, SUMMARIZER_SYSTEM_PROMPT } from '../src/runtime/spanSummary/index.js';

function span(o = {}) {
  return {
    spanId: 'span-1', agentId: 'dev-1', runtimeId: 'rt-1', teamId: 'team-1',
    sessionId: null, startedAt: '2026-05-16T00:00:00.000Z', endedAt: '2026-05-16T00:00:30.000Z',
    closed: true, rowCount: 2, tokens: 5,
    rows: [
      { narrationId: 'n1', kind: 'tool', line: 'Reading a.js' },
      { narrationId: 'n2', kind: 'text', line: 'planning the change' },
    ],
    ...o,
  };
}

test('systemPrompt is the shared constant; userPayload renders header + the row lines', () => {
  const { systemPrompt, userPayload } = buildSummaryPrompt(span());
  assert.equal(systemPrompt, SUMMARIZER_SYSTEM_PROMPT);
  assert.ok(systemPrompt.length > 0);
  assert.ok(userPayload.includes('Agent dev-1 on runtime rt-1, 2026-05-16T00:00:00.000Z – 2026-05-16T00:00:30.000Z:'));
  assert.ok(userPayload.includes('- Reading a.js'));
  assert.ok(userPayload.includes('- planning the change'));
});

test('reuses span.rows[].line verbatim — never re-narrates', () => {
  const { userPayload } = buildSummaryPrompt(span({ rows: [{ narrationId: 'x', kind: 'tool', line: 'Bash: npm test' }] }));
  assert.ok(userPayload.includes('- Bash: npm test'));
});

test('total on missing / odd input (no throw): empty rows → header only; non-object → header with unknowns', () => {
  const a = buildSummaryPrompt(span({ rows: [] }));
  assert.ok(a.userPayload.startsWith('Agent dev-1 on runtime rt-1,'));
  assert.ok(!a.userPayload.includes('\n-'));
  const b = buildSummaryPrompt(undefined);
  assert.equal(b.systemPrompt, SUMMARIZER_SYSTEM_PROMPT);
  assert.ok(b.userPayload.includes('Agent unknown on runtime unknown,'));
  const c = buildSummaryPrompt(span({ rows: [{ narrationId: 'z' }, null, { line: 42 }] }));
  assert.ok(c.userPayload.includes('- \n')); // missing line → empty
  assert.ok(c.userPayload.includes('- 42'));
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.buildPrompt.test.js`
Expected: FAIL — `buildSummaryPrompt`/`SUMMARIZER_SYSTEM_PROMPT` not exported from `index.js` yet.

- [ ] **Step 3: Create `summarizerSystemPrompt.js`**

```javascript
// The whole personality (Readability Layer-2 P3b-1). A frontier CLI told
// a narrow job will otherwise be helpfully wrong (suggestions/questions
// /tangents) — this prompt is the entire constraint surface.
export const SUMMARIZER_SYSTEM_PROMPT =
  'You are a span summarizer for an engineering activity log. Your ONLY job: ' +
  'read the activity below and produce ONE plain-English sentence (at most two ' +
  'short sentences) that tells a non-coder what the agent did during this span. ' +
  'Output ONLY the summary text — no preamble, no markdown, no bullet points, no ' +
  'questions, no suggestions, no code, no tool use. If the activity is trivial or ' +
  'idle, say that in one short clause.';
```

- [ ] **Step 4: Create `buildSummaryPrompt.js`**

```javascript
// Pure (Readability Layer-2 P3b-1). span -> {systemPrompt,userPayload}.
// Reuses P1's already-narrated row `line` verbatim — NEVER re-narrates.
// Total: missing/odd input degrades, never throws.
import { SUMMARIZER_SYSTEM_PROMPT } from './summarizerSystemPrompt.js';

export function buildSummaryPrompt(span) {
  const s = span && typeof span === 'object' ? span : {};
  const agentId = typeof s.agentId === 'string' ? s.agentId : 'unknown';
  const runtimeId = typeof s.runtimeId === 'string' ? s.runtimeId : 'unknown';
  const startedAt = typeof s.startedAt === 'string' ? s.startedAt : '';
  const endedAt = typeof s.endedAt === 'string' ? s.endedAt : '';
  const rows = Array.isArray(s.rows) ? s.rows : [];
  const lines = rows
    .map((r) => `- ${r && r.line != null ? String(r.line) : ''}`)
    .join('\n');
  const header = `Agent ${agentId} on runtime ${runtimeId}, ${startedAt} – ${endedAt}:`;
  return {
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    userPayload: lines ? `${header}\n${lines}` : header,
  };
}
```

- [ ] **Step 5: Modify `index.js` — append the re-exports**

`src/runtime/spanSummary/index.js` currently is exactly:
```javascript
export { decideSpansToSummarize } from './decideSpansToSummarize.js';
```
Append these two lines (leave the existing line unchanged):
```javascript
export { SUMMARIZER_SYSTEM_PROMPT } from './summarizerSystemPrompt.js';
export { buildSummaryPrompt } from './buildSummaryPrompt.js';
```

- [ ] **Step 6: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.buildPrompt.test.js`
Expected: PASS — 3 tests, output pristine.

- [ ] **Step 7: (no commit — accumulates toward Commit 1)**

---

## Task 2: `extractSummaryText` + index

**Files:** Create `src/runtime/spanSummary/extractSummaryText.js`; Modify `src/runtime/spanSummary/index.js`; Test `test/spanSummary.extract.test.js`.

- [ ] **Step 1: Write the failing unit suite**

Create `test/spanSummary.extract.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSummaryText } from '../src/runtime/spanSummary/index.js';

test('plain text passes through trimmed', () => {
  assert.equal(extractSummaryText('  The agent read a.js and ran tests.  '), 'The agent read a.js and ran tests.');
});

test('strips a single wrapping code fence (```lang and bare ```)', () => {
  assert.equal(extractSummaryText('```\nThe agent edited config.\n```'), 'The agent edited config.');
  assert.equal(extractSummaryText('```text\nDid a thing.\n```'), 'Did a thing.');
});

test('strips a single leading Summary: label (case-insensitive)', () => {
  assert.equal(extractSummaryText('Summary: agent fixed the bug.'), 'agent fixed the bug.');
  assert.equal(extractSummaryText('summary:   trimmed too'), 'trimmed too');
});

test('collapses 3+ newlines to one blank line', () => {
  assert.equal(extractSummaryText('line one\n\n\n\nline two'), 'line one\n\nline two');
});

test('empty / whitespace / non-string → null (never persist junk)', () => {
  assert.equal(extractSummaryText('   '), null);
  assert.equal(extractSummaryText(''), null);
  assert.equal(extractSummaryText('```\n\n```'), null);
  assert.equal(extractSummaryText(null), null);
  assert.equal(extractSummaryText(42), null);
  assert.equal(extractSummaryText(undefined), null);
});

test('hard-caps at 600 chars', () => {
  const out = extractSummaryText('x'.repeat(5000));
  assert.equal(out.length, 600);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.extract.test.js`
Expected: FAIL — `extractSummaryText` not exported yet.

- [ ] **Step 3: Create `extractSummaryText.js`**

```javascript
// Pure (Readability Layer-2 P3b-1). CLI stdout -> clean summary string,
// or null when there is nothing usable (-> degrade; NEVER persist junk).
// Total: non-string -> null; never throws.
export function extractSummaryText(stdout) {
  if (typeof stdout !== 'string') return null;
  let t = stdout.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  t = t.replace(/^\s*summary\s*:\s*/i, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  if (t.length === 0) return null;
  if (t.length > 600) t = t.slice(0, 600);
  return t;
}
```

- [ ] **Step 4: Modify `index.js`**

Append (after the Task-1 lines, existing lines unchanged):
```javascript
export { extractSummaryText } from './extractSummaryText.js';
```

- [ ] **Step 5: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.extract.test.js`
Expected: PASS — 6 tests, pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 1)**

---

## Task 3: `resolveSummaryRoute` + `SUMMARY_PROVIDER_MAP` + index

**Files:** Create `src/runtime/spanSummary/resolveSummaryRoute.js`; Modify `src/runtime/spanSummary/index.js`; Test `test/spanSummary.route.test.js`.

- [ ] **Step 1: Write the failing unit suite**

Create `test/spanSummary.route.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSummaryRoute, SUMMARY_PROVIDER_MAP } from '../src/runtime/spanSummary/index.js';

test('banked heuristic: pref [gemini,openai,anthropic] minus lead', () => {
  assert.deepEqual(resolveSummaryRoute({ leadProviderId: 'anthropic' }), { providerId: 'gemini', cli: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual(resolveSummaryRoute({ leadProviderId: 'openai' }), { providerId: 'gemini', cli: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual(resolveSummaryRoute({ leadProviderId: 'gemini' }), { providerId: 'openai', cli: 'codex', model: 'gpt-5-codex' });
});

test('unknown / absent lead is treated as anthropic → gemini', () => {
  assert.equal(resolveSummaryRoute({ leadProviderId: 'mystery' }).providerId, 'gemini');
  assert.equal(resolveSummaryRoute({ leadProviderId: null }).providerId, 'gemini');
  assert.equal(resolveSummaryRoute({}).providerId, 'gemini');
  assert.equal(resolveSummaryRoute().providerId, 'gemini');
});

test('settings.summarizer.providerId overrides the provider entirely', () => {
  const r = resolveSummaryRoute({ leadProviderId: 'anthropic', settings: { summarizer: { providerId: 'openai' } } });
  assert.deepEqual(r, { providerId: 'openai', cli: 'codex', model: 'gpt-5-codex' });
});

test('an unknown settings.summarizer.providerId is ignored (falls back to heuristic)', () => {
  const r = resolveSummaryRoute({ leadProviderId: 'gemini', settings: { summarizer: { providerId: 'nope' } } });
  assert.equal(r.providerId, 'openai');
});

test('settings.summarizer.model overrides only the model', () => {
  const r = resolveSummaryRoute({ leadProviderId: 'anthropic', settings: { summarizer: { model: 'gemini-2.5-pro' } } });
  assert.deepEqual(r, { providerId: 'gemini', cli: 'gemini', model: 'gemini-2.5-pro' });
});

test('SUMMARY_PROVIDER_MAP is the frozen tier1 map', () => {
  assert.deepEqual({ ...SUMMARY_PROVIDER_MAP }, {
    anthropic: { cli: 'claude', model: 'haiku' },
    openai: { cli: 'codex', model: 'gpt-5-codex' },
    gemini: { cli: 'gemini', model: 'gemini-2.5-flash' },
  });
  assert.ok(Object.isFrozen(SUMMARY_PROVIDER_MAP));
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.route.test.js`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Create `resolveSummaryRoute.js`**

```javascript
// Pure (Readability Layer-2 P3b-1). Route the summarizer to a CLI the
// workers are NOT on (compete with itself, not them). Only grounded
// "what plan are workers on" signal is teamConfig.lead.providerId.
// Availability/failover is the orchestrator's concern, not this fn.
export const SUMMARY_PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({ cli: 'claude', model: 'haiku' }),
  openai: Object.freeze({ cli: 'codex', model: 'gpt-5-codex' }),
  gemini: Object.freeze({ cli: 'gemini', model: 'gemini-2.5-flash' }),
});

const PREFERENCE = Object.freeze(['gemini', 'openai', 'anthropic']);

export function resolveSummaryRoute({ leadProviderId, settings } = {}) {
  const lead =
    typeof leadProviderId === 'string' && SUMMARY_PROVIDER_MAP[leadProviderId]
      ? leadProviderId
      : 'anthropic';
  let providerId = PREFERENCE.find((p) => p !== lead) || 'gemini';
  const sm = settings && typeof settings === 'object' ? settings.summarizer : null;
  if (sm && typeof sm === 'object'
      && typeof sm.providerId === 'string' && SUMMARY_PROVIDER_MAP[sm.providerId]) {
    providerId = sm.providerId;
  }
  const base = SUMMARY_PROVIDER_MAP[providerId];
  let model = base.model;
  if (sm && typeof sm === 'object' && typeof sm.model === 'string' && sm.model.length > 0) {
    model = sm.model;
  }
  return { providerId, cli: base.cli, model };
}
```

- [ ] **Step 4: Modify `index.js`**

Append:
```javascript
export { resolveSummaryRoute, SUMMARY_PROVIDER_MAP } from './resolveSummaryRoute.js';
```

- [ ] **Step 5: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.route.test.js`
Expected: PASS — 6 tests, pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 1)**

---

## Task 4: `SummaryRateLimiter` + index

**Files:** Create `src/runtime/spanSummary/summaryRateLimiter.js`; Modify `src/runtime/spanSummary/index.js`; Test `test/spanSummary.rateLimiter.test.js`.

- [ ] **Step 1: Write the failing unit suite**

Create `test/spanSummary.rateLimiter.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';

test('allows up to maxPerHour within the rolling hour, then blocks', () => {
  let t = 1_000_000;
  const rl = new SummaryRateLimiter({ maxPerHour: 3, now: () => t });
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-a'), false); // 4th in the window
});

test('a blocked (false) attempt does NOT consume a slot — eviction frees it', () => {
  let t = 0;
  const rl = new SummaryRateLimiter({ maxPerHour: 1, now: () => t });
  assert.equal(rl.tryAcquire('team-a'), true);   // t=0 recorded
  t = 1000;
  assert.equal(rl.tryAcquire('team-a'), false);  // within hour, blocked, NOT recorded
  t = 3_600_001;                                  // first slot now older than 1h
  assert.equal(rl.tryAcquire('team-a'), true);    // evicted → free again (proves false didn't record)
});

test('per-team isolation', () => {
  let t = 0;
  const rl = new SummaryRateLimiter({ maxPerHour: 1, now: () => t });
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-b'), true);   // separate window
  assert.equal(rl.tryAcquire('team-a'), false);
});

test('defaults: maxPerHour=20, now=Date.now (smoke)', () => {
  const rl = new SummaryRateLimiter();
  for (let i = 0; i < 20; i++) assert.equal(rl.tryAcquire('t'), true);
  assert.equal(rl.tryAcquire('t'), false);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.rateLimiter.test.js`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Create `summaryRateLimiter.js`**

```javascript
// In-memory rolling-hour circuit breaker (Readability Layer-2 P3b-1).
// Verbatim the drift L3 #l3RateWindow discipline (driftEngine.js:260-268):
// evict entries older than 1h; if kept >= cap, store kept and return
// false WITHOUT recording the rejected attempt; else record + true.
// KNOWN-PROPERTY: in-memory, resets on process restart (accepted L3
// precedent; do not "fix").
const WINDOW_MS = 60 * 60 * 1000;

export class SummaryRateLimiter {
  #windows = new Map();
  #maxPerHour;
  #now;

  constructor({ maxPerHour = 20, now = Date.now } = {}) {
    this.#maxPerHour =
      typeof maxPerHour === 'number' && Number.isFinite(maxPerHour) ? maxPerHour : 20;
    this.#now = typeof now === 'function' ? now : Date.now;
  }

  tryAcquire(teamId) {
    const ts = this.#now();
    const kept = (this.#windows.get(teamId) || []).filter((t) => ts - t < WINDOW_MS);
    if (kept.length >= this.#maxPerHour) {
      this.#windows.set(teamId, kept);
      return false;
    }
    this.#windows.set(teamId, [...kept, ts]);
    return true;
  }
}
```

- [ ] **Step 4: Modify `index.js`**

Append:
```javascript
export { SummaryRateLimiter } from './summaryRateLimiter.js';
```

- [ ] **Step 5: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.rateLimiter.test.js`
Expected: PASS — 4 tests, pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 1)**

---

## Task 5: Engine purity guard

**Files:** Create `test/spanSummary.enginePurity.test.js`.

> Scope note: P3a's existing `test/spanSummary.purity.test.js` scans `decideSpansToSummarize.js`/`index.js` and stays valid (P3b-1 only appends `export … from` lines to `index.js` — no `node:`/`fs` literal is introduced into `index.js` itself, so that suite still passes; do NOT modify it). This new suite guards the 5 pure-by-construction P3b-1 files. `runSpanSummary.js` is DELIBERATELY excluded (it is the IO seam — it MUST import `node:child_process`); `summarizePendingSpans.js` is excluded (orchestrator — covered by its behavior suite).

- [ ] **Step 1: Write the purity guard suite**

Create `test/spanSummary.enginePurity.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'spanSummary');
const PURE = [
  'summarizerSystemPrompt.js',
  'buildSummaryPrompt.js',
  'extractSummaryText.js',
  'resolveSummaryRoute.js',
  'summaryRateLimiter.js',
];

test('P3b-1 pure engine modules import no node:/fs/path/os/child_process/react, no JSX, no process', () => {
  for (const f of PURE) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports a node: builtin`);
    assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), `${f} imports a node core module`);
    assert.ok(!/from\s+['"]react/.test(src), `${f} imports react`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
    assert.ok(!/(return|=>)\s*<[A-Za-z]/.test(src) && !/<\/[A-Za-z]/.test(src), `${f} contains JSX`);
  }
});
```

- [ ] **Step 2: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.enginePurity.test.js`
Expected: PASS (1 test). Invariant guard over the Tasks 1–4 modules (the `spanDetection.purity` precedent — no red phase of its own).

- [ ] **Step 3: (no commit — accumulates toward Commit 1)**

---

## Task 6: Wire Commit-1 suites + full root fail-0 + **Commit 1**

**Files:** Modify `scripts/test-suites.txt`.

- [ ] **Step 1: Append the 5 Commit-1 suites to the ratified chain**

Per the `21454c2` ratification the canonical chain is `scripts/test-suites.txt` (NOT `package.json`). It currently ends with:
`&& node --no-warnings --test test/localToadRuntime.spanSummary.test.js`

Append to the END of `scripts/test-suites.txt` (single line continuation, leading space; plain text — no command-line ceiling):

```
 && node --no-warnings --test test/spanSummary.buildPrompt.test.js && node --no-warnings --test test/spanSummary.extract.test.js && node --no-warnings --test test/spanSummary.route.test.js && node --no-warnings --test test/spanSummary.rateLimiter.test.js && node --no-warnings --test test/spanSummary.enginePurity.test.js
```

Validate:

Run: `cd /c/Project-TOAD/toad-local && node -e "const t=require('node:fs').readFileSync('./scripts/test-suites.txt','utf8'); console.log(['spanSummary.buildPrompt','spanSummary.extract','spanSummary.route','spanSummary.rateLimiter','spanSummary.enginePurity'].every(s=>t.includes(s)) && require('./package.json').scripts.test==='node scripts/run-test-suites.mjs')"`
Expected: `true`

- [ ] **Step 2: Full root suite — fail 0, all 5 P3b-1-C1 suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test > /tmp/p3b1_c1.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`

Run: `grep -E "^# (pass|fail)" /tmp/p3b1_c1.log | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`, and `pass` strictly greater than the post-P3a baseline of 1491.

Run: `grep -cE "systemPrompt is the shared constant; userPayload renders header|strips a single wrapping code fence|banked heuristic: pref|a blocked \\(false\\) attempt does NOT consume a slot|P3b-1 pure engine modules import no node:" /tmp/p3b1_c1.log`
Expected: `>= 5` (the 5 P3b-1-C1 suites genuinely ran — the un-wired-test trap).

- [ ] **Step 3: Commit 1**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/spanSummary/summarizerSystemPrompt.js toad-local/src/runtime/spanSummary/buildSummaryPrompt.js toad-local/src/runtime/spanSummary/extractSummaryText.js toad-local/src/runtime/spanSummary/resolveSummaryRoute.js toad-local/src/runtime/spanSummary/summaryRateLimiter.js toad-local/src/runtime/spanSummary/index.js toad-local/test/spanSummary.buildPrompt.test.js toad-local/test/spanSummary.extract.test.js toad-local/test/spanSummary.route.test.js toad-local/test/spanSummary.rateLimiter.test.js toad-local/test/spanSummary.enginePurity.test.js toad-local/scripts/test-suites.txt
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(spans): pure summarizer engine units + rate limiter (Readability Layer-2 P3b-1, Commit 1)

New src/runtime/spanSummary/ pure units: SUMMARIZER_SYSTEM_PROMPT
(the whole personality), buildSummaryPrompt (span.rows[].line verbatim,
never re-narrates, total), extractSummaryText (fence/label strip, 600
cap, empty→null — never persist junk), resolveSummaryRoute (frozen
tier1 SUMMARY_PROVIDER_MAP; pref ['gemini','openai','anthropic']-minus-
lead reproducing the banked heuristic; settings.summarizer.* override),
SummaryRateLimiter (in-memory rolling-hour, verbatim the drift L3
#l3RateWindow discipline incl. false-does-not-record; resets on
restart — accepted). index.js barrel extended (P3a decideSpansToSummarize
export unchanged). TDD unit + enginePurity suites; wired into the
ratified scripts/test-suites.txt (21454c2). Root fail 0. Greenfield,
dormant — no production caller yet (P3b-2 the trigger).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -1
```

---

## Task 7: `runSpanSummary` (the `llmJudge`-mirrored one-shot — the only IO seam)

**Files:** Create `src/runtime/spanSummary/runSpanSummary.js`; Modify `src/runtime/spanSummary/index.js`; Test `test/spanSummary.runSpanSummary.test.js`.

- [ ] **Step 1: Write the failing injected-spawn unit suite**

Create `test/spanSummary.runSpanSummary.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runSpanSummary, SUMMARY_FAIL_REASONS } from '../src/runtime/spanSummary/index.js';

// A minimal fake child process: emits stdout then exits with `code`.
function fakeProc({ stdoutChunks = [], code = 0, emitError = null } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  proc.kill = () => {};
  setImmediate(() => {
    if (emitError) { proc.emit('error', emitError); return; }
    for (const c of stdoutChunks) proc.stdout.emit('data', Buffer.from(c));
    proc.emit('exit', code);
  });
  return proc;
}
const resolveOk = (cli) => `/usr/bin/${cli}`;
const noShell = () => false;

test('claude success → {ok:true,summaryText}, argv + stdin match the llmJudge inline shape', async () => {
  let seen;
  const spawnImpl = (cmd, args, opts) => { seen = { cmd, args, opts }; return fakeProc({ stdoutChunks: ['agent read a.js\n'] }); };
  const r = await runSpanSummary({
    systemPrompt: 'SYS', userPayload: 'PAY', cli: 'claude', model: 'haiku',
    spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell,
  });
  assert.deepEqual(r, { ok: true, summaryText: 'agent read a.js' });
  assert.equal(seen.cmd, '/usr/bin/claude');
  assert.deepEqual(seen.args, ['--model', 'haiku', '--print', '--setting-sources', 'project,local', '--tools', '']);
  assert.deepEqual(seen.opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('codex argv shape', async () => {
  let seen;
  const spawnImpl = (cmd, args) => { seen = args; return fakeProc({ stdoutChunks: ['done'] }); };
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'codex', model: 'gpt-5-codex', spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['exec', '--model', 'gpt-5-codex', '-']);
});

test('gemini argv shape (combined positional, stdin ignored)', async () => {
  let seen;
  const spawnImpl = (cmd, args, opts) => { seen = { args, opts }; return fakeProc({ stdoutChunks: ['g'] }); };
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'gemini', model: 'gemini-2.5-flash', spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.args, ['-m', 'gemini-2.5-flash', '-p', 'S\n\nP']);
  assert.deepEqual(seen.opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('non-zero exit → {ok:false,reason:spawn_failed}', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc({ code: 1, stdoutChunks: ['err'] }), resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'spawn_failed' });
});

test('proc error event → spawn_failed', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc({ emitError: new Error('ENOENT') }), resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'spawn_failed' });
});

test('spawn throws synchronously → spawn_failed (never throws)', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => { throw new Error('boom'); }, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'spawn_failed' });
});

test('timeout → {ok:false,reason:timeout} and SIGKILL fired', async () => {
  let killed = false;
  const spawnImpl = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = { write() {}, end() {} }; p.kill = () => { killed = true; }; return p; /* never exits */ };
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', timeoutMs: 10, spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.equal(killed, true);
});

test('empty stdout → {ok:false,reason:empty_output}', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc({ stdoutChunks: ['   \n'] }), resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'empty_output' });
});

test('unsupported cli / bad model / resolveCli throws → cli_unresolved (never throws)', async () => {
  assert.deepEqual(await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'opencode', model: 'x', spawnImpl: () => fakeProc(), resolveCliImpl: resolveOk, needsShellImpl: noShell }), { ok: false, reason: 'cli_unresolved' });
  assert.deepEqual(await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: '', spawnImpl: () => fakeProc(), resolveCliImpl: resolveOk, needsShellImpl: noShell }), { ok: false, reason: 'cli_unresolved' });
  assert.deepEqual(await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc(), resolveCliImpl: () => { throw new Error('x'); }, needsShellImpl: noShell }), { ok: false, reason: 'cli_unresolved' });
});

test('isolateHome+cwd scrubs CLAUDE_* (except BEDROCK/VERTEX) and sets HOME/USERPROFILE', async () => {
  process.env.CLAUDE_SCRATCH = 'leak';
  process.env.CLAUDE_CODE_USE_BEDROCK = 'keep';
  let opts;
  const spawnImpl = (c, a, o) => { opts = o; return fakeProc({ stdoutChunks: ['ok'] }); };
  await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', cwd: '/tmp/iso', isolateHome: true, spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.equal(opts.cwd, '/tmp/iso');
  assert.equal(opts.env.HOME, '/tmp/iso');
  assert.equal(opts.env.USERPROFILE, '/tmp/iso');
  assert.equal(opts.env.CLAUDE_SCRATCH, undefined);
  assert.equal(opts.env.CLAUDE_CODE_USE_BEDROCK, 'keep');
  delete process.env.CLAUDE_SCRATCH; delete process.env.CLAUDE_CODE_USE_BEDROCK;
});

test('SUMMARY_FAIL_REASONS is the sealed set', () => {
  assert.deepEqual([...SUMMARY_FAIL_REASONS].sort(), ['cli_unresolved', 'empty_output', 'spawn_failed', 'timeout']);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.runSpanSummary.test.js`
Expected: FAIL — `runSpanSummary`/`SUMMARY_FAIL_REASONS` not exported yet.

- [ ] **Step 3: Create `runSpanSummary.js`**

```javascript
// The ONLY IO seam (Readability Layer-2 P3b-1). A one-shot provider-CLI
// spawn that MIRRORS drift's llmJudge spawn discipline
// (src/drift/llm/llmJudge.js, inline mode) for PLAIN-TEXT output.
// It does NOT import llmJudge (drift byte-untouched) and NEVER throws —
// every failure mode returns { ok:false, reason } where reason is a
// member of the sealed SUMMARY_FAIL_REASONS.
import { spawn as defaultSpawn } from 'node:child_process';
import { resolveCli as defaultResolveCli } from '../../foundry/providers/resolveCli.js';
import { extractSummaryText } from './extractSummaryText.js';

export const SUMMARY_FAIL_REASONS = Object.freeze(
  new Set(['spawn_failed', 'timeout', 'empty_output', 'cli_unresolved'])
);

function defaultNeedsShell(resolved) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
}

function buildInvocation(cli, model, systemPrompt, userPayload) {
  const combined = `${systemPrompt}\n\n${userPayload}`;
  if (cli === 'claude') {
    return {
      args: ['--model', model, '--print', '--setting-sources', 'project,local', '--tools', ''],
      stdin: combined,
    };
  }
  if (cli === 'codex') {
    return { args: ['exec', '--model', model, '-'], stdin: combined };
  }
  if (cli === 'gemini') {
    return { args: ['-m', model, '-p', combined], stdin: null };
  }
  return null;
}

export async function runSpanSummary({
  systemPrompt,
  userPayload,
  cli,
  model,
  cwd = null,
  isolateHome = false,
  timeoutMs = 30_000,
  spawnImpl,
  resolveCliImpl,
  needsShellImpl,
} = {}) {
  if (typeof cli !== 'string' || cli.length === 0) return { ok: false, reason: 'cli_unresolved' };
  if (typeof model !== 'string' || model.length === 0) return { ok: false, reason: 'cli_unresolved' };

  const inv = buildInvocation(cli, model, String(systemPrompt ?? ''), String(userPayload ?? ''));
  if (!inv) return { ok: false, reason: 'cli_unresolved' };

  const spawnFn = spawnImpl || defaultSpawn;
  const resolveCliFn = resolveCliImpl || defaultResolveCli;
  const needsShellFn = needsShellImpl || defaultNeedsShell;

  let resolved;
  try {
    resolved = resolveCliFn(cli);
  } catch {
    return { ok: false, reason: 'cli_unresolved' };
  }
  if (typeof resolved !== 'string' || resolved.length === 0) {
    return { ok: false, reason: 'cli_unresolved' };
  }
  let shell;
  try {
    shell = needsShellFn(resolved);
  } catch {
    shell = false;
  }

  const { args, stdin: stdinPayload } = inv;

  return await new Promise((resolveOuter) => {
    const stdio = stdinPayload !== null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const spawnOpts = { stdio, shell };
    if (typeof cwd === 'string' && cwd.length > 0) {
      spawnOpts.cwd = cwd;
    }
    if (isolateHome && typeof cwd === 'string' && cwd.length > 0) {
      const env = { ...process.env };
      env.HOME = cwd;
      env.USERPROFILE = cwd;
      for (const key of Object.keys(env)) {
        if (
          key.startsWith('CLAUDE_') &&
          key !== 'CLAUDE_CODE_USE_BEDROCK' &&
          key !== 'CLAUDE_CODE_USE_VERTEX'
        ) {
          delete env[key];
        }
      }
      spawnOpts.env = env;
    }

    let settled = false;
    const done = (r) => { if (settled) return; settled = true; resolveOuter(r); };

    let proc;
    try {
      proc = spawnFn(resolved, args, spawnOpts);
    } catch {
      done({ ok: false, reason: 'spawn_failed' });
      return;
    }

    if (stdinPayload !== null && proc.stdin) {
      try {
        proc.stdin.write(stdinPayload);
        proc.stdin.end();
      } catch {
        /* the exit/error handler below surfaces the real failure */
      }
    }

    let stdoutBuf = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      done({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    if (proc.stdout) proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) { done({ ok: false, reason: 'spawn_failed' }); return; }
      const t = extractSummaryText(stdoutBuf);
      done(typeof t === 'string' && t.length > 0
        ? { ok: true, summaryText: t }
        : { ok: false, reason: 'empty_output' });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      done({ ok: false, reason: 'spawn_failed' });
    });
  });
}
```

- [ ] **Step 4: Modify `index.js`**

Append:
```javascript
export { runSpanSummary, SUMMARY_FAIL_REASONS } from './runSpanSummary.js';
```

- [ ] **Step 5: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.runSpanSummary.test.js`
Expected: PASS — all tests, pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 2)**

---

## Task 8: `summarizePendingSpans` orchestrator

**Files:** Create `src/runtime/spanSummary/summarizePendingSpans.js`; Modify `src/runtime/spanSummary/index.js`; Test `test/spanSummary.orchestrator.test.js`.

- [ ] **Step 1: Write the failing injected-deps unit suite**

Create `test/spanSummary.orchestrator.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePendingSpans, SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';

function span(o = {}) {
  return {
    spanId: 'span-1', agentId: 'a1', runtimeId: 'rt-1', teamId: 'team-1', sessionId: 's1',
    startedAt: '2026-05-16T00:00:00.000Z', endedAt: '2026-05-16T00:00:09.000Z',
    closed: true, rowCount: 2, tokens: 4, rows: [{ narrationId: 'n1', kind: 'tool', line: 'Reading a.js' }],
    ...o,
  };
}
const bigLimiter = () => new SummaryRateLimiter({ maxPerHour: 1000, now: () => 0 });

test('success → appendSummary called with the exact mapped fields; report.summarized', async () => {
  const appended = [];
  const report = await summarizePendingSpans({
    teamId: 'team-1',
    listAwaiting: () => [span()],
    appendSummary: (x) => { appended.push(x); return { inserted: true }; },
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'agent read a.js' }),
  });
  assert.deepEqual(report.summarized, [{ spanId: 'span-1', model: 'gemini-2.5-flash', cli: 'gemini' }]);
  assert.deepEqual(report.degraded, []);
  assert.equal(report.skippedRateLimited, 0);
  assert.deepEqual(appended, [{
    spanId: 'span-1', teamId: 'team-1', runtimeId: 'rt-1', agentId: 'a1', sessionId: 's1',
    summaryText: 'agent read a.js', model: 'gemini-2.5-flash', cli: 'gemini',
    spanStartedAt: '2026-05-16T00:00:00.000Z', spanEndedAt: '2026-05-16T00:00:09.000Z',
    rowCount: 2, tokens: 4,
  }]);
});

test('runImpl failure → degraded with the reason; NEVER appendSummary', async () => {
  let appendCalls = 0;
  const report = await summarizePendingSpans({
    teamId: 'team-1', listAwaiting: () => [span()],
    appendSummary: () => { appendCalls++; }, leadProviderId: 'gemini', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: false, reason: 'timeout' }),
  });
  assert.equal(appendCalls, 0);
  assert.deepEqual(report.degraded, [{ spanId: 'span-1', reason: 'timeout' }]);
  assert.deepEqual(report.summarized, []);
});

test('rate-limit → skippedRateLimited counts the current span onward; stops', async () => {
  const limiter = new SummaryRateLimiter({ maxPerHour: 1, now: () => 0 });
  const report = await summarizePendingSpans({
    teamId: 'team-1',
    listAwaiting: () => [span({ spanId: 's-a' }), span({ spanId: 's-b' }), span({ spanId: 's-c' })],
    appendSummary: () => ({ inserted: true }), leadProviderId: 'anthropic', settings: {}, limiter,
    runImpl: async () => ({ ok: true, summaryText: 'x' }),
  });
  assert.equal(report.summarized.length, 1);  // s-a acquired
  assert.equal(report.skippedRateLimited, 2); // s-b, s-c (current onward, inclusive)
});

test('maxPerRun caps the batch (settings.summarizer.maxPerRun)', async () => {
  const spans = Array.from({ length: 5 }, (_, i) => span({ spanId: `s${i}` }));
  let runs = 0;
  const report = await summarizePendingSpans({
    teamId: 'team-1', listAwaiting: () => spans, appendSummary: () => ({ inserted: true }),
    leadProviderId: 'anthropic', settings: { summarizer: { maxPerRun: 2 } }, limiter: bigLimiter(),
    runImpl: async () => { runs++; return { ok: true, summaryText: 'x' }; },
  });
  assert.equal(runs, 2);
  assert.equal(report.summarized.length, 2);
});

test('oldest-first order is preserved from listAwaiting (P3a already sorts)', async () => {
  const seen = [];
  await summarizePendingSpans({
    teamId: 'team-1',
    listAwaiting: () => [span({ spanId: 'old' }), span({ spanId: 'new' })],
    appendSummary: (x) => { seen.push(x.spanId); return { inserted: true }; },
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'x' }),
  });
  assert.deepEqual(seen, ['old', 'new']);
});

test('idempotent re-run is harmless (first-write-wins handled by appendSummary)', async () => {
  const store = new Map();
  const appendSummary = (x) => {
    if (store.has(x.spanId)) return { inserted: false, row: store.get(x.spanId) };
    store.set(x.spanId, x); return { inserted: true, row: x };
  };
  const args = {
    teamId: 'team-1', listAwaiting: () => [span()], appendSummary,
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'first' }),
  };
  await summarizePendingSpans(args);
  await summarizePendingSpans({ ...args, runImpl: async () => ({ ok: true, summaryText: 'SECOND' }) });
  assert.equal(store.size, 1);
  assert.equal(store.get('span-1').summaryText, 'first');
});

test('total: missing deps / non-array listAwaiting / listAwaiting throws → empty report, never throws', async () => {
  assert.deepEqual(await summarizePendingSpans({}), { summarized: [], degraded: [], skippedRateLimited: 0 });
  assert.deepEqual(await summarizePendingSpans({ listAwaiting: () => 'nope', appendSummary: () => {}, runImpl: async () => ({}) }), { summarized: [], degraded: [], skippedRateLimited: 0 });
  assert.deepEqual(await summarizePendingSpans({ listAwaiting: () => { throw new Error('x'); }, appendSummary: () => {}, runImpl: async () => ({}) }), { summarized: [], degraded: [], skippedRateLimited: 0 });
});

test('appendSummary throwing on a malformed span → degraded:persist_failed, never throws', async () => {
  const report = await summarizePendingSpans({
    teamId: 'team-1', listAwaiting: () => [span()],
    appendSummary: () => { throw new TypeError('spanId must be a non-empty string'); },
    leadProviderId: 'anthropic', settings: {}, limiter: bigLimiter(),
    runImpl: async () => ({ ok: true, summaryText: 'x' }),
  });
  assert.deepEqual(report.degraded, [{ spanId: 'span-1', reason: 'persist_failed' }]);
  assert.deepEqual(report.summarized, []);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.orchestrator.test.js`
Expected: FAIL — `summarizePendingSpans` not exported yet.

- [ ] **Step 3: Create `summarizePendingSpans.js`**

```javascript
// The orchestrator (Readability Layer-2 P3b-1). All IO injected (the
// P3a reads/write, the runner, the limiter). Honest degradation: never
// persists a junk/empty summary; a failed span stays pending (the next
// run retries; P3a appendSummary first-write-wins makes that idempotent).
// NEVER throws — per-span failure is isolated into the report.
import { buildSummaryPrompt } from './buildSummaryPrompt.js';
import { resolveSummaryRoute } from './resolveSummaryRoute.js';

export async function summarizePendingSpans({
  teamId,
  listAwaiting,
  appendSummary,
  leadProviderId,
  settings,
  limiter,
  runImpl,
  cwd = undefined,
  isolateHome = false,
} = {}) {
  const report = { summarized: [], degraded: [], skippedRateLimited: 0 };
  if (typeof listAwaiting !== 'function' || typeof appendSummary !== 'function' || typeof runImpl !== 'function') {
    return report;
  }
  let spans;
  try {
    spans = listAwaiting({ teamId });
  } catch {
    return report;
  }
  if (!Array.isArray(spans)) return report;

  const sm = settings && typeof settings === 'object' ? settings.summarizer : null;
  const maxPerRun =
    sm && typeof sm === 'object' && typeof sm.maxPerRun === 'number' && Number.isFinite(sm.maxPerRun)
      ? sm.maxPerRun
      : 10;
  const timeoutMs =
    sm && typeof sm === 'object' && typeof sm.timeoutMs === 'number' && Number.isFinite(sm.timeoutMs)
      ? sm.timeoutMs
      : undefined;
  const capped = spans.slice(0, maxPerRun);

  for (let i = 0; i < capped.length; i++) {
    const span = capped[i];
    if (!span || typeof span !== 'object') continue;
    if (!limiter || typeof limiter.tryAcquire !== 'function' || !limiter.tryAcquire(teamId)) {
      report.skippedRateLimited = capped.length - i;
      break;
    }
    const route = resolveSummaryRoute({ leadProviderId, settings });
    const { systemPrompt, userPayload } = buildSummaryPrompt(span);
    let r;
    try {
      r = await runImpl({
        systemPrompt, userPayload, cli: route.cli, model: route.model,
        cwd, isolateHome, timeoutMs,
      });
    } catch {
      r = { ok: false, reason: 'spawn_failed' };
    }
    if (r && r.ok === true && typeof r.summaryText === 'string' && r.summaryText.length > 0) {
      try {
        appendSummary({
          spanId: span.spanId,
          teamId: span.teamId,
          runtimeId: span.runtimeId,
          agentId: span.agentId,
          sessionId: span.sessionId,
          summaryText: r.summaryText,
          model: route.model,
          cli: route.cli,
          spanStartedAt: span.startedAt,
          spanEndedAt: span.endedAt,
          rowCount: span.rowCount,
          tokens: span.tokens,
        });
        report.summarized.push({ spanId: span.spanId, model: route.model, cli: route.cli });
      } catch {
        report.degraded.push({ spanId: span.spanId, reason: 'persist_failed' });
      }
    } else {
      report.degraded.push({ spanId: span.spanId, reason: (r && r.reason) || 'spawn_failed' });
    }
  }
  return report;
}
```

> Note: `'persist_failed'` is an **orchestrator-level** degraded reason (a defensive catch around `appendSummary` so the orchestrator NEVER throws even if a malformed span somehow reached it — §spec §8 says P3a's `requireString`/`requireNonNegativeInteger` throws "never fire in practice" since only validated `Span` fields are passed; this catch makes that guarantee total). It is intentionally NOT a member of `SUMMARY_FAIL_REASONS` (that sealed set is `runSpanSummary`'s run-failure vocabulary). Do not "unify" them.

- [ ] **Step 4: Modify `index.js`**

Append:
```javascript
export { summarizePendingSpans } from './summarizePendingSpans.js';
```

- [ ] **Step 5: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.orchestrator.test.js`
Expected: PASS — all tests, pristine.

- [ ] **Step 6: (no commit — accumulates toward Commit 2)**

---

## Task 9: Anti-inert e2e (real `LocalToadRuntime` + fake `runImpl`)

**Files:** Create `test/spanSummary.summarizer.e2e.test.js`.

- [ ] **Step 1: Write the e2e suite**

Create `test/spanSummary.summarizer.e2e.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';
import { summarizePendingSpans, SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';

test('engine composes with a REAL LocalToadRuntime + P3a: persist→awaiting→summarize→excluded→idempotent (no real CLI)', async () => {
  const rt = new LocalToadRuntime();
  // §8d-ratified P2b path: tool_use for an UNREGISTERED runtime persists
  // the narration before the identity check throws; tolerate only that.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-p3b1', teamId: 'team-p3b1', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  // turn_completed (kind:system) closes the span; no identity check, no throw.
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-p3b1', teamId: 'team-p3b1', agentId: 'lead',
    createdAt: '2026-05-16T00:00:05.000Z', raw: {},
  });

  assert.equal(rt.listSpansAwaitingSummary({ teamId: 'team-p3b1' }).length, 1, 'one closed span awaiting');

  let runCalls = 0;
  const report = await summarizePendingSpans({
    teamId: 'team-p3b1',
    listAwaiting: (a) => rt.listSpansAwaitingSummary(a),
    appendSummary: (s) => rt.spanSummaryStore.appendSummary(s),
    leadProviderId: 'anthropic',
    settings: {},
    limiter: new SummaryRateLimiter({ maxPerHour: 20, now: Date.now }),
    runImpl: async () => { runCalls++; return { ok: true, summaryText: 'the agent read a.js' }; },
  });

  assert.equal(runCalls, 1, 'the (fake) runner was invoked for the one span');
  assert.equal(report.summarized.length, 1);
  assert.equal(report.degraded.length, 0);

  const sums = rt.listSpanSummaries({ teamId: 'team-p3b1' });
  assert.equal(sums.length, 1);
  assert.equal(sums[0].summaryText, 'the agent read a.js');
  assert.equal(sums[0].cli, 'gemini');
  assert.equal(sums[0].model, 'gemini-2.5-flash');
  assert.deepEqual(rt.listSpansAwaitingSummary({ teamId: 'team-p3b1' }), [], 'span no longer awaiting');

  // Idempotent second run: nothing new, no duplicate, no throw.
  const report2 = await summarizePendingSpans({
    teamId: 'team-p3b1',
    listAwaiting: (a) => rt.listSpansAwaitingSummary(a),
    appendSummary: (s) => rt.spanSummaryStore.appendSummary(s),
    leadProviderId: 'anthropic', settings: {},
    limiter: new SummaryRateLimiter({ maxPerHour: 20, now: Date.now }),
    runImpl: async () => { throw new Error('must not be called — nothing awaiting'); },
  });
  assert.deepEqual(report2, { summarized: [], degraded: [], skippedRateLimited: 0 });
  assert.equal(rt.listSpanSummaries({ teamId: 'team-p3b1' }).length, 1);
});
```

- [ ] **Step 2: Run — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summarizer.e2e.test.js`
Expected: PASS — 1 test, pristine. (No red phase: this composes already-built engine + already-shipped P3a; it is the anti-inert proof, not new behavior.)

- [ ] **Step 3: (no commit — accumulates toward Commit 2)**

---

## Task 10: Wire Commit-2 suites + full gates + whole-impl review + **Commit 2**

**Files:** Modify `scripts/test-suites.txt`.

- [ ] **Step 1: Append the 3 Commit-2 suites to the ratified chain**

`scripts/test-suites.txt` now ends with `… && node --no-warnings --test test/spanSummary.enginePurity.test.js`. Append (single line, leading space):

```
 && node --no-warnings --test test/spanSummary.runSpanSummary.test.js && node --no-warnings --test test/spanSummary.orchestrator.test.js && node --no-warnings --test test/spanSummary.summarizer.e2e.test.js
```

Validate:

Run: `cd /c/Project-TOAD/toad-local && node -e "const t=require('node:fs').readFileSync('./scripts/test-suites.txt','utf8'); console.log(['spanSummary.buildPrompt','spanSummary.extract','spanSummary.route','spanSummary.rateLimiter','spanSummary.enginePurity','spanSummary.runSpanSummary','spanSummary.orchestrator','spanSummary.summarizer.e2e'].every(s=>t.includes(s)) && require('./package.json').scripts.test==='node scripts/run-test-suites.mjs')"`
Expected: `true`

- [ ] **Step 2: Full root suite — fail 0, ALL 8 P3b-1 suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test > /tmp/p3b1_c2.log 2>&1; echo "EXIT=$?"`
Expected: `EXIT=0`

Run: `grep -E "^# (pass|fail)" /tmp/p3b1_c2.log | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`

Run: `grep -cE "systemPrompt is the shared constant; userPayload renders header|strips a single wrapping code fence|banked heuristic: pref|a blocked \\(false\\) attempt does NOT consume a slot|P3b-1 pure engine modules import no node:|claude success → \\{ok:true,summaryText\\}, argv|success → appendSummary called with the exact mapped fields|engine composes with a REAL LocalToadRuntime" /tmp/p3b1_c2.log`
Expected: `>= 8` (all 8 P3b-1 suite titles genuinely present in this run — the un-wired-test trap; never trust a pasted number, the controller re-runs and greps its OWN output and reconciles the pass-count delta vs the post-P3a 1491 baseline).

- [ ] **Step 3: Whole-implementation review (pre-commit gate)**

Review the entire P3b-1 surface as one unit: `runSpanSummary` is a faithful `llmJudge` spawn MIRROR (per-cli argv/stdin, `isolateHome` scrub, SIGKILL timeout, defaults) for PLAIN TEXT, **never throws**, `reason` ∈ the sealed `SUMMARY_FAIL_REASONS`, and **does NOT import `llmJudge`** (`src/drift/llm/*` byte-untouched); `resolveSummaryRoute` reproduces the banked `['gemini','openai','anthropic']`-minus-lead heuristic exactly + the `settings.summarizer.*` overrides + the frozen tier1 map; `SummaryRateLimiter` mirrors the L3 rolling-hour discipline incl. false-does-NOT-record; `summarizePendingSpans` never persists a junk/empty summary, maps the exact `appendSummary` fields, is idempotent across re-runs, never throws (`persist_failed` is the deliberate orchestrator-totality reason, distinct from the sealed run set); the pure units are import-free; the e2e genuinely composes the orchestrator over a real `LocalToadRuntime` + real P3a `listSpansAwaitingSummary`/`appendSummary` + a FAKE `runImpl` (no real CLI); **no out-of-scope change** (drift / P1 / P2a / P2b / P3a behavior / `LocalToadRuntime` / `LocalReadModel` / `dev-api-server` untouched; NO new runtime method; NO real-CLI/local-model path; `index.js` change is only appended re-exports, P3a's `decideSpansToSummarize` export unchanged); the 8 suites genuinely execute under the runner with substantive assertions; dormant-but-non-inert (no production caller of `summarizePendingSpans`/`runSpanSummary`). Resolve any finding before committing.

- [ ] **Step 4: Commit 2**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/spanSummary/runSpanSummary.js toad-local/src/runtime/spanSummary/summarizePendingSpans.js toad-local/src/runtime/spanSummary/index.js toad-local/test/spanSummary.runSpanSummary.test.js toad-local/test/spanSummary.orchestrator.test.js toad-local/test/spanSummary.summarizer.e2e.test.js toad-local/scripts/test-suites.txt
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(spans): summarizer one-shot runner + orchestrator (Readability Layer-2 P3b-1, Commit 2)

runSpanSummary: the ONLY IO seam — mirrors drift llmJudge's one-shot
spawn discipline (per-cli argv/stdin, isolateHome HOME/USERPROFILE/
CLAUDE_* scrub, setTimeout→SIGKILL, resolveCli/needsShell defaults) for
PLAIN TEXT; NEVER throws (sealed SUMMARY_FAIL_REASONS
spawn_failed|timeout|empty_output|cli_unresolved); does NOT import
llmJudge — drift src/drift/llm/* byte-untouched. summarizePendingSpans:
injected-deps orchestrator (listSpansAwaitingSummary/appendSummary/
runImpl/limiter); honest degradation — never persists a junk/empty
summary, failed spans stay pending (P3a first-write-wins ⇒ idempotent
re-run); maxPerRun cap; never throws (persist_failed = deliberate
orchestrator-totality reason). Anti-inert e2e composes the orchestrator
over a REAL LocalToadRuntime + real P3a + a FAKE runImpl (no real CLI).
index.js barrel extended. Suites wired to the ratified
scripts/test-suites.txt; root fail 0; all 8 P3b-1 suites executed;
whole-impl reviewed. Dormant — no production trigger (P3b-2 owns the
dev-api-server poller/lifecycle; P3c the surfacing). Out: P3b-2/P3c,
drift, P1/P2a/P2b/P3a behavior, LocalToadRuntime/LocalReadModel/
dev-api-server, in-run failover, local-model fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 5: Post-commit verify**

Run: `git -C /c/Project-TOAD show --stat HEAD`
Expected: exactly 7 files — `runSpanSummary.js`, `summarizePendingSpans.js`, `index.js`, the 3 C2 test files, `scripts/test-suites.txt`. No stray.

Run: `git -C /c/Project-TOAD diff --stat cad217d HEAD -- toad-local/src/drift toad-local/src/runtime/sqliteNarrationStore.js toad-local/src/runtime/eventNarration toad-local/src/runtime/spanDetection toad-local/src/runtime/timelineComposition toad-local/src/runtime/RuntimeEventIngestor.js toad-local/src/runtime/sqliteSpanSummaryStore.js toad-local/src/runtime/spanSummary/decideSpansToSummarize.js toad-local/src/app/LocalToadRuntime.js toad-local/src/read/LocalReadModel.js toad-local/scripts/dev-api-server.mjs toad-local/ui`
(`cad217d` is the committed P3b-1 spec — the last state before any P3b-1 code; the intervening plan-doc + Commit 1/2 must not touch these out-of-scope paths.)
Expected: EMPTY — drift, P1 narration, P2a composeTimeline, P2b detectSpans, P3a store/decide-core/runtime/read-model, dev-api-server, UI all untouched (the out-of-scope guarantee; `decideSpansToSummarize.js` specifically unchanged — only `index.js` grew).

Run: `git -C /c/Project-TOAD status --porcelain | grep -E 'spanSummary|test-suites' || echo "(clean of P3b-1 feature files)"`
Expected: `(clean of P3b-1 feature files)`.

Run: `git -C /c/Project-TOAD log --oneline -2`
Expected: HEAD = Commit 2; HEAD~1 = Commit 1 (`feat(spans): pure summarizer engine units …`). (Ratification commits, if any §8d pin proved wrong, sit before Commit 1; the invariant is both feature commits present + the out-of-scope diff empty.)

---

## Notes for the executor (read before starting)

- **TDD is mandatory.** Each code task: write the test, run it to watch it FAIL for the stated reason, minimal implementation, run it PASS. The `enginePurity` and `e2e` suites are invariant/composition guards (the `spanDetection.purity` / P1-P2b-P3a anti-inert precedents) — green on first run is acceptable and noted in their tasks.
- **Mirror, do NOT import `llmJudge`.** `runSpanSummary` replicates the discipline; `import …/drift/llm/llmJudge.js` anywhere is the out-of-scope/coupling defect. Re-read `src/drift/llm/llmJudge.js` + `src/foundry/providers/resolveCli.js` at implementation to confirm the §8d argv/stdin/scrub/defaults still match; if they differ, STOP and surface for controller pre-emptive ratification.
- **`runSpanSummary` NEVER throws** — every failure returns `{ok:false,reason}` with `reason` ∈ `SUMMARY_FAIL_REASONS`. **`summarizePendingSpans` NEVER throws** — per-span isolation; never persists a junk/empty summary; `persist_failed` is the deliberate orchestrator-totality reason (NOT in the sealed run set — do not unify).
- **`index.js` is P3a's barrel.** Only APPEND `export … from` lines; P3a's `export { decideSpansToSummarize } …` line stays byte-unchanged. P3a's `test/spanSummary.purity.test.js` keeps passing (it scans `index.js`'s own text, which has no `node:`/`fs` literal even after the appends) — do NOT modify that P3a test.
- **Wiring goes in `scripts/test-suites.txt`, NOT `package.json`** (the `21454c2` §8d ratification). `package.json` `scripts.test` stays `node scripts/run-test-suites.mjs`. The controller independently re-runs the full root suite via the runner, greps the P3b-1 titles in its OWN output, and reconciles the pass-count delta vs the post-P3a 1491 baseline (exact reconciliation proves the runner ran the full chain — no silent skip/truncation).
- **Commit hygiene.** Tasks accumulate uncommitted; ONLY Task 6 (Commit 1) and Task 10 (Commit 2) `git commit`. Commit directly to `main`; `git -c commit.gpgsign=false`. The `LF will be replaced by CRLF` `git add` warning is benign Windows autocrlf — do not "fix" it.
- **§8d STOP rule** applies throughout: a wrong grounded pin → STOP and surface for controller pre-emptive ratification, do not code around it.
