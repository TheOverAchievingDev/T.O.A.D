# Drift Monitor Slice 2 — LLM-Semantic Tier Design

**Status:** approved (brainstorming session 2026-05-04)
**Author:** kaydenraquel + Claude
**Predecessor:** `2026-05-03-drift-monitor-design.md` (slice 1, deterministic)

---

## 1. Problem

Slice 1's deterministic checks catch mechanical drift — illegal lifecycle transitions, out-of-scope file changes, missing test artifacts, role-permission denials, rubber-stamped reviews, provider-logic leakage in core paths, done-without-merge. Those are necessary but not sufficient.

What slice 1 cannot catch:
- **Plan-vs-steering misalignment.** A task's plan technically uses allowed files but contradicts a "Never do X" rule in steering.md.
- **DoD adherence.** Tasks at `merge_ready` pass tests but skip a checklist item from `definition_of_done.md`.
- **ADR violations.** Current work contradicts a recorded `design_decisions.md` entry.
- **Subtle scope creep** that respects file-glob rules but expands feature surface beyond the task's spec.

These need a model that reads English. Slice 2 adds an **LLM-semantic check tier** on top of the deterministic engine, with a cost-aware two-tier escalation: cheap mid-tier model always-on, frontier model conditional.

## 2. Scope (slice 2)

**In scope:**
- Two-tier LLM cascade: tier-1 (Haiku/mini/flash) always runs after deterministic checks; tier-2 (Opus 4.7 / GPT-5 / Gemini 2.5 Pro) runs only when the combined deterministic+tier-1 score crosses the **Warning** threshold (41+).
- `llmJudge` infrastructure: spawn the team's CLI (`claude --print` / `codex exec` / `gemini -p`), send a structured prompt, parse JSON, validate findings, return.
- `escalationGate`: pure decision function honoring the time-based hard floor (5 min cooldown) AND the score-delta cooldown (≥10 points OR new finding-id).
- `providerResolver`: pick the right CLI + model based on the team's lead provider, with operator overrides via settings.
- `checkLlmSemantic`: an awaitable check that wraps `llmJudge` and emits `DriftFinding[]`.
- Engine refactor: `check.fn` becomes async-aware (existing deterministic checks stay synchronous; `await` is a no-op on sync return).
- New `result.llm` field on `DriftRunResult` so the UI can show "verified by Opus" badges + escalation-pending banners.
- Settings additions for threshold, cooldowns, and (future) model overrides — defaults boot the feature with no operator config.
- Surfaced fallback: if tier-2 spawn fails or times out, the UI shows a small "Opus escalation pending — quota/timeout" notice without blocking the rest of the run.

**Explicitly deferred:**
- Per-team model overrides UI (Settings → Workspace → Drift judge): captured in slice 3.
- Ollama / local-model support: future slice.
- DeepSeek API support: trivial via custom OpenAI-compatible base URL but not first-class in slice 2.
- Correction-task generation from LLM findings: slice 3.
- `fileContents` enrichment in `buildSnapshot` (would let `checkProviderLogicLeakage` fire in production): tracked separately.

## 3. Branding decision

**Tier 1 model:** Haiku 4.5 / GPT-4o-mini / Gemini 2.5 Flash (mid-tier, fast, cheap, runs on every drift evaluation).
**Tier 2 model:** Opus 4.7 / GPT-5 / Gemini 2.5 Pro (frontier, slower, expensive, runs only on escalation).

Both default to "match the team's lead provider"; operator can override via settings later (slice 3).

## 4. Architecture

```
runDrift({teamId, trigger})
   │
   ▼
 buildSnapshot(teamId, deps)
   │
   ▼
 Tier 1: deterministic checks (×7) + checkLlmSemantic@tier1   ◄── always
   │
   ▼
 scoreFindings(tier1Findings) ──► tier1Score
   │
   ▼
 escalationGate({tier1Score, lastT2RunAt, lastT2Score, now}, settings)
   │
   ├── escalate=false ──► tier2Findings = []; status = 'skipped:cooldown'
   │                       OR status = 'skipped:below_threshold'
   │
   └── escalate=true ───► checkLlmSemantic@tier2
                            │
                            ├── success ──► tier2Findings; status = 'completed'
                            │              update cooldown {lastRunAt, lastScore}
                            │
                            └── failure ──► tier2Findings = []
                                            status = { failed: <reason> }
   │
   ▼
 scoreFindings(tier1 + tier2) ──► final teamScore + categories + perTask
   │
   ▼
 driftStore.recordRun(...)
   │
   ▼
 return DriftRunResult with llm: { tier1, tier2 }
```

### 4.1 Module layout

```
src/drift/llm/
├── llmJudge.js              spawn CLI, send prompt, parse JSON, return DriftFinding[]
├── escalationGate.js        pure: decide if tier 2 should run
├── providerResolver.js      pure: team config → {cli, model, args}
└── prompts/
    ├── tier1.txt            Haiku/Mini/Flash system prompt
    └── tier2.txt            Opus/GPT-5/Gemini-Pro system prompt

src/drift/checks/
└── checkLlmSemantic.js      async check, calls llmJudge, returns findings

src/drift/driftEngine.js     gains tier orchestration + in-memory cooldown state
```

### 4.2 Async check signature

The check registry's `fn` becomes `async` everywhere. Slice-1 deterministic checks already match (await on a sync return is a no-op):

```js
// before
const out = check.fn({ snapshot }) || [];

// after
const out = await check.fn({ snapshot }) ?? [];
```

This was flagged as a slice-1 forward-compat suggestion ("Suggestion — `check.fn` is invoked synchronously; if a check ever returns a Promise it would be pushed as a finding"). Slice 2 cashes it in.

### 4.3 Cooldown state

In-memory Map on the engine:

```js
class DriftEngine {
  #tier2Cooldown = new Map(); // teamId -> { lastRunAt: number, lastScore: number }
}
```

Lost on sidecar restart. Acceptable — re-warms on the next drift run. SQLite persistence is over-engineering for a heuristic.

### 4.4 Wiring (no change to dev-api-server)

The engine constructor already accepts `deps` and `store`. We add `llmJudgeImpl` (default: `llmJudge` from `src/drift/llm/llmJudge.js`) and `settings` (default: read from `settingsStore`) as injectable params for tests:

```js
new DriftEngine({
  deps: {...},
  store: driftStore,
  llmJudgeImpl: optional,    // tests inject a fake
  settings: optional,         // tests inject a fixed settings snapshot
});
```

Production wiring is unchanged — defaults take over.

## 5. Schema

### 5.1 No new SQLite tables

All findings persist in the existing `drift_findings` table. Tier is encoded in `check_name`:

| `check_name` | Tier |
|---|---|
| `check_invalid_transitions`, ... (existing 7) | deterministic |
| `check_llm_semantic_t1` | LLM tier 1 |
| `check_llm_semantic_t2` | LLM tier 2 |

UI helper:

```ts
function findingTier(checkName: string): 'deterministic' | 'llm_t1' | 'llm_t2' {
  if (checkName === 'check_llm_semantic_t1') return 'llm_t1';
  if (checkName === 'check_llm_semantic_t2') return 'llm_t2';
  return 'deterministic';
}
```

### 5.2 `DriftRunResult` — one new field

```ts
type LlmTierStatus =
  | 'completed'
  | 'skipped:cooldown'
  | 'skipped:below_threshold'
  | { failed: string };

type DriftRunResult = {
  // ...all existing slice-1 fields unchanged...
  llm: {
    tier1: LlmTierStatus;
    tier2: LlmTierStatus;
  };
};
```

### 5.3 Settings (`<projectCwd>/.toad/settings.json`)

New `drift` section:

```json
{
  "drift": {
    "llmTierEnabled": true,
    "escalationThreshold": 41,
    "tier2CooldownMs": 300000,
    "tier2ScoreDelta": 10,
    "tier1ModelOverride": null,
    "tier2ModelOverride": null
  }
}
```

All defaults work without operator config. Overrides become useful in slice 3 with a Settings → Workspace → Drift judge UI.

## 6. The LLM judge

### 6.1 `llmJudge.js` API

```js
async function llmJudge({
  cli,            // 'claude' | 'codex' | 'gemini'
  model,          // 'haiku-4.5' | 'opus-4.7' | 'gpt-4o-mini' | etc
  systemPrompt,   // tier1.txt or tier2.txt content
  userPayload,    // structured snapshot summary as markdown
  timeoutMs,      // default 30000
  spawnImpl,      // injectable for tests
}) → {
  findings: DriftFinding[],
  rawText: string,
  tokensUsed: number | null,
}
```

Internal flow:

1. Resolve CLI command (Windows PATHEXT walk if needed — same helper used by `claudeUsageProbe.js`).
2. Spawn one-shot:
   - `claude --model <model> --print "<system>\n\n<user>"`
   - `codex exec --model <model> "<combined>"`
   - `gemini -m <model> -p "<combined>"`
3. Capture stdout with timeout. SIGKILL on timeout.
4. Strip markdown code fences if present (LLMs sometimes wrap JSON in ```` ```json `````).
5. `JSON.parse` the result.
6. Validate `findings[]` against the `DriftFinding` schema. Drop malformed rows, log a warning per drop.
7. Stamp every finding with `check_name = 'check_llm_semantic_t<n>'`, `category` validated against `ALL_CATEGORIES`, `severity` validated against the enum.
8. Throw on total parse failure (engine catches → emits a meta-finding).

### 6.2 System prompts

**`prompts/tier1.txt`** (used by Haiku / GPT-4o-mini / Gemini Flash):

```
You are a drift judge for a multi-agent coding team. Read the team's
current state and spec docs and report places where the team has
drifted from spec.

CRITICAL: Output JSON ONLY. No prose, no markdown fences, no
explanation. Just a JSON object matching the schema below.

Schema:
{ "findings": [
  { "category": "architecture|checklist|slice_scope|test_truth|risk",
    "severity": "info|low|medium|high|critical",
    "title": "<one short sentence>",
    "expected": "<what should be true per the spec>",
    "actual": "<what is currently true>",
    "evidence": ["<specific quote or task ref>", ...],
    "recommendedCorrection": "<concrete next step>",
    "taskId": "<optional: which task this is about>"
  }, ...
] }

Focus on three axes:
1. PLAN ALIGNMENT — do active task plans match steering.md's principles?
2. DoD ADHERENCE — tasks at review/merge_ready/done that don't meet
   the criteria in definition_of_done.md.
3. ADR VIOLATIONS — any current work violating decisions in
   design_decisions.md.

Be specific. Findings without quoted evidence are useless. Return
{"findings": []} if you see no drift — better than fabricating.
```

**`prompts/tier2.txt`** (Opus / GPT-5 / Gemini Pro — adds escalation context):

```
You are escalated to deep-judge mode. The cheaper tier-1 judge flagged
this team's drift score >= 41. Your job is to confirm or refute the
tier-1 findings AND identify any subtle drift that tier-1 missed.

For each tier-1 finding, you may:
- CONFIRM (re-emit it, optionally adjust severity)
- REFUTE (drop it — don't include in your output)
- AUGMENT (emit a sharper version with better evidence)

You may also add NEW findings the tier-1 judge missed — focus on
nuance: subtle ADR violations, cross-task scope creep, plans that
technically pass DoD but miss its spirit.

[+ same JSON schema as tier-1]

The tier-1 findings are appended below your normal context. Use them
as a baseline; your output replaces theirs.
```

### 6.3 User payload format

Markdown, sent as the prompt body:

```markdown
# Team: <teamId>

## Tasks (<count> shown of <total>)
- task-1 [in_progress, owner=dev-1] "Build OAuth flow"
  allowedFiles: src/auth/**
  changedFiles: src/auth/oauth.js, src/billing/invoice.js
  testCommands: npm test
  acceptanceCriteria: <list>
- task-2 ...
(20 most-recent tasks; older tasks summarized as count-by-status)

## Recent task events (last 50)
- 09:01 task-1 created
- 09:05 task-1 ready→planned (lead)
...

## Recent runtime events (last 50)
- 09:10 dev-1 tool_call_denied: task_delete (role=developer)
...

## Foundry docs
### architecture.md
<full content>

### steering.md
<full content>

### definition_of_done.md
<full content>

### design_decisions.md
<full content>

(Tier 2 only: ## Tier-1 findings)
<finding 1>
<finding 2>
...
```

### 6.4 Provider resolution

```js
function resolveProvider({ teamConfig, settings, tier }) {
  // Operator override wins.
  if (tier === 1 && settings.drift.tier1ModelOverride) {...}
  if (tier === 2 && settings.drift.tier2ModelOverride) {...}

  // Otherwise match the team's lead provider.
  const leadProviderId = teamConfig?.lead?.providerId ?? 'anthropic';

  const PROVIDER_MAP = {
    anthropic: { cli: 'claude', tier1: 'haiku-4.5', tier2: 'opus-4.7' },
    openai:    { cli: 'codex',  tier1: 'gpt-4o-mini', tier2: 'gpt-5' },
    gemini:    { cli: 'gemini', tier1: 'gemini-2.5-flash', tier2: 'gemini-2.5-pro' },
  };

  const provider = PROVIDER_MAP[leadProviderId] || PROVIDER_MAP.anthropic;
  return {
    cli: provider.cli,
    model: tier === 1 ? provider.tier1 : provider.tier2,
  };
}
```

### 6.5 Token budget

Bounded conservatively:
- Tasks: 20 most recent in full schema; older summarized as `{<status>: <count>}`
- Task events: last 50 transitions
- Runtime events: last 50 tool calls / denials
- Foundry docs: full content (these tend to be 1-3K each)

Estimate: 15-30K tokens per call, well within mid-tier and frontier limits. Log token counts via `tokensUsed` for observability; tighten if real-world usage exceeds.

## 7. Escalation gate

```js
function escalationGate({
  tier1Score,                    // current run's score
  threshold,                     // e.g. 41
  cooldownMs,                    // e.g. 300_000 (5 min)
  scoreDelta,                    // e.g. 10
  lastT2RunAt,                   // null | number (Date.now-ish)
  lastT2Score,                   // null | number
  now,                           // Date.now() — injectable for tests
}) {
  if (tier1Score < threshold) {
    return { escalate: false, reason: 'below_threshold' };
  }
  if (lastT2RunAt === null) {
    return { escalate: true, reason: 'first_time' };
  }
  if (now - lastT2RunAt < cooldownMs) {
    return { escalate: false, reason: 'cooldown' };
  }
  if (Math.abs(tier1Score - (lastT2Score ?? 0)) >= scoreDelta) {
    return { escalate: true, reason: 'score_delta' };
  }
  return { escalate: false, reason: 'no_material_change' };
}
```

Pure function. Easy to test exhaustively.

## 8. Failure handling

| Failure | Result.llm.tier2 | UI behavior |
|---|---|---|
| CLI not on PATH | `{ failed: 'cli_not_found' }` | Banner: "Drift judge CLI (claude) not found — install or override in settings" |
| Auth missing/expired | `{ failed: 'auth_required' }` | Banner: "Drift judge needs you signed into <provider>" |
| Spawn timeout | `{ failed: 'timeout' }` | Banner: "Opus escalation timed out — retry on next score change" |
| JSON parse failure (no findings recoverable) | `{ failed: 'invalid_response' }` | Banner: "Drift judge returned malformed output — see logs" |
| Plan/quota exhausted | `{ failed: 'quota' }` | Banner: "Provider quota hit — escalation paused" |

All failures are non-blocking. The deterministic + tier-1 findings are still shown. Tier-2 cooldown updates with `lastRunAt = now` so we don't hammer a failing CLI.

## 9. UI changes

1. **Tier badge on findings.** `DriftScreen.tsx`'s finding cards get a small badge based on `findingTier(checkName)`:
   - `deterministic` → no badge (default)
   - `llm_t1` → "AI" badge in a neutral color
   - `llm_t2` → "Verified by Opus" / "Verified by GPT-5" / "Verified by Gemini Pro" — orange-toned, prominent

2. **Tier-2 status banner.** When `result.llm.tier2.failed` is set, a small dismissible notice strip near the top of `DriftScreen.tsx`:
   ```
   ⚠️  Deep-scan unavailable — <reason>. Showing tier-1 findings.
   ```

3. **"Last verified by Opus at HH:MM" indicator** in the score header when tier 2 ran successfully.

No structural UI rework — these are additions to the existing `DriftScreen.tsx`. Per-task badges, sparkline, category bars, finding filter — all unchanged.

## 10. Testing strategy

| Piece | Approach | Test file |
|---|---|---|
| `escalationGate` | Pure function, table-driven (below threshold, above + cooldown, above + delta sufficient, above + delta too small, no prior run). | `test/drift/llm/escalationGate.test.js` |
| `providerResolver` | Pure function, table-driven (anthropic→haiku/opus, openai→mini/gpt5, gemini→flash/pro, override resolves, unknown→fallback). | `test/drift/llm/providerResolver.test.js` |
| `llmJudge` | Inject fake `spawnImpl` that returns canned stdout. Test fence-stripping, schema validation, malformed-row drops, timeout, total-parse-failure throw. | `test/drift/llm/llmJudge.test.js` |
| `checkLlmSemantic` | Inject fake `llmJudge` returning canned findings. Verify `check_name`, `runId: ''`, etc are stamped correctly. | `test/drift/checks/checkLlmSemantic.test.js` |
| `driftEngine` tier orchestration | Inject fake LLM checks. Tier 1 always, tier 2 conditional, cooldown suppresses, tier 2 failure surfaces in `result.llm.tier2`. | Extend `test/drift/driftEngine.test.js` |
| End-to-end | Real engine + real escalationGate + mocked llmJudge. Assert `result.llm` field shape. | `test/drift/driftEngineLlm.integration.test.js` |

TDD discipline preserved — every new module ships with a failing test before its implementation lands. The engine refactor (await on `check.fn`) is covered by the existing engine tests + new integration test.

## 11. Risk + non-goals

- **LLM judges can hallucinate.** Mitigations: strict JSON schema, drop malformed rows, require quoted evidence in the prompt, severity capped at `high` for tier-1 (only tier-2 can emit `critical`). Operators always have the evidence string to cross-check.
- **Cost surprises.** The cooldown + delta logic means a hosed team won't burn $$ in tier-2 calls. Settings let operators tighten cooldown if they're worried.
- **CLI version skew.** Different `claude` versions accept different `--model` strings. Slice 2 hardcodes the names current as of 2026-05-04; if Anthropic renames, operators get a clear "model not supported" error from the CLI and we update the resolver.
- **Not a replacement for human review.** LLM findings are heuristics. The `requiresHumanApproval` gate from §14 still owns "stop here, get a person involved."
- **Tier-2 latency on the dashboard.** Tier-2 runs synchronously inside `runDrift`. If Opus is slow (~3s), the dashboard's manual "Run check" button feels laggy. Acceptable tradeoff for slice 2; an async tier-2 with SSE notification is a slice-3 polish.

## 12. Open questions (slice 3+)

- Per-team model override UI in Settings → Workspace → Drift judge.
- Async tier-2 with progressive UI updates (SSE pushes new findings as Opus finishes).
- Ollama / local-model support (for operators who want self-hosted reasoning).
- DeepSeek as a first-class provider option.
- Cross-team drift score comparison (which teams drift fastest? which checks fire most?).

## 13. Decisions log (from brainstorming)

- **Q1 (architecture):** Spawn a separate "drift judge" agent rather than reusing the team's lead or hitting APIs directly. Isolation matters; the lead might be wedged at exactly the moment we want a drift report.
- **Q2 (model tier):** Mid-tier (Haiku/Mini/Flash) as default tier-1, frontier (Opus/GPT-5/Gemini-Pro) for tier-2 escalation. Open-weights / Ollama / DeepSeek deferred.
- **Q2a (escalation threshold):** Warning (41+). Watch is too eager; Critical is too late.
- **Q2b (cooldown):** Both time-based (5-min hard floor) AND score-delta (≥10 points or new finding-id) — time prevents accidental burn, delta keeps us responsive when state genuinely changes.
- **Q2c (failure mode):** Surfaced fallback. Show tier-1 findings + a non-blocking banner explaining tier-2 unavailability.
- **Q2d (multi-provider):** Match the team's lead provider for tier-2 by default. Configurable override is a slice-3 follow-up the operator explicitly wants.
