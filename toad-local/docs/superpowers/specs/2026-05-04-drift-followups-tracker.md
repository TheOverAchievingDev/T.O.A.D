# Drift Monitor — Follow-up Tracker

**Status:** living document. Captures every slice-3-and-beyond item flagged across slice-1 and slice-2 reviews. Each entry is a concrete action so we don't lose track when context shifts.

Tick items off as they ship. New items get appended in the relevant section.

---

## A. The original slice 3 — Correction-Task Generation

The drift engine surfaces findings; slice 3 makes them actionable. From the slice-1 spec §2 ("Future Actions"):

- [x] ~~**Add a "Create correction task" button on each finding card.**~~ Shipped — multi-select checkboxes + action bar + editable modal pre-filled from selected findings.
- [x] ~~**`drift_correction_create` command in `LocalToolFacade`.**~~ Shipped — registered as MCP tool + role-gated to architect/lead/human.
- [x] ~~**Track which findings spawned correction tasks.**~~ Shipped — `correction_task_id` column on `drift_findings` + `correctionTaskId` field on `DriftFinding` type.
- [x] ~~**Auto-resolve findings when their correction task hits `done`.**~~ Shipped — `reapResolvedCorrections` clears linkage on done/rejected; engine re-runs from scratch (deterministic re-emit if drift truly persists, silence if it doesn't).
- [x] ~~**Slice-3 brainstorming round.**~~ Shipped — see `2026-05-04-drift-slice-3-correction-tasks-design.md`. Decisions: manual creation primary (auto deferred to 3.5); editable modal (not task_plan_propose); multi-select checkboxes for storm prevention; visually distinguished + filtered from score + skip-re-emit.

Spec is at `2026-05-04-drift-slice-3-correction-tasks-design.md`.

**Slice 3 shipped 2026-05-04.** Slice 3.5 candidates: auto-creation of corrections (with default policy keyed on `severity:high`), correction templates per check type, root-cause clustering heuristics ("these 3 findings share a `taskId` — collapse into one suggested task"), bulk-resolve UI, correction-task analytics.

---

## B. Drift Monitor — Engine + Backend Polish

Caught during slice-1 + slice-2 final reviews.

- [ ] **Engine meta-finding stable-id parity with `checkLlmSemantic`.** `driftEngine.js` `#metaFinding` uses `f_check_error_${teamId}_${checkName}`; `checkLlmSemantic.js` uses `stableFindingId(...)`. Make the engine's match for cross-run dedup.
- [ ] **Persist tier-2 cooldown across sidecar restarts.** Currently in-memory `Map<teamId, {lastRunAt, lastScore}>` — heuristic re-warms in <60s after a restart, but if you bounce the sidecar repeatedly (during dev) you'll over-call Opus. Light SQLite table or stash in `drift_score_history` metadata.
- [ ] **Wire CLI usage probes for `tokensUsed`.** `llmJudge.js` returns `tokensUsed: null`. Each CLI exposes usage differently (claude has `/usage`, codex has `--show-cost`); plumb where available.
- [ ] **Drain stderr on `llmJudge` spawns.** Long stderr output from a chatty CLI could backpressure stdout. Listen-and-discard pattern.
- [ ] **Settings-driven `tier2TimeoutMs`.** `checkLlmSemantic.js` hard-codes 30s. Surface as `settings.drift.tier2TimeoutMs`.
- [ ] **Test for `llmTierEnabled=true but no LLM checks in registry`.** Edge case where deterministic-only callers don't accidentally trip the LLM path.
- [ ] **Enrich `buildSnapshot` with `fileContents`** so `checkProviderLogicLeakage` actually fires in production. Today the check is wired and tested but dormant because no one feeds it real diffs. Read `wt.path/<file>` for each entry in `diff.changedFiles`, cap at ~64KB per file.
- [ ] **Surface `buildSnapshot` diff errors.** Currently swallowed silently in the per-worktree try/catch. Add `snapshot.diffErrors: [{taskId, error}]` so checks can emit meta-findings instead of treating bad diffs as empty.
- [ ] **Register `drift_run` in `localToolDefinitions.js`** for MCP-mode agents. UI works via in-process facade today; non-UI callers (e.g. another team's lead asking "is the drift engine healthy?") can't reach it.

---

## C. Drift Monitor — UI Polish

- [ ] **`DriftBadge` color thresholds collapse.** `score >= 41` and `score >= 21` both render yellow today. Either collapse to one branch or split into yellow + orange to give the operator more visual signal.
- [ ] **"Last verified by Opus at HH:MM" indicator** in the score header when tier 2 ran successfully (slice-2 spec §9 noted this; we shipped the badges + banner but not the timestamp).
- [ ] **Async tier-2 with SSE updates.** Today tier-2 runs synchronously inside `runDrift` — Opus latency (~3s) makes the manual "Run check" feel laggy. Push tier-2 findings via SSE as Opus finishes; UI updates the badge from "AI" to "Verified" live.
- [ ] **Drift score sparkline tooltip.** Hover a point in the history sparkline to see `{teamScore, status, when, llm.tier2}`. Today the sparkline is decorative.
- [ ] **Per-finding "fixed since last run" diff.** Slice 1's stable finding IDs make this trivial — UI compares the previous run's finding set against the current. Show a green tick on findings that disappeared.

---

## D. Drift Monitor — Settings UI

Slice-2 wired all the knobs in `DEFAULT_SETTINGS.drift`; operators can edit `<projectCwd>/.toad/settings.json` by hand. Surface them in the existing **Settings → Workspace** panel:

- [ ] `llmTierEnabled` toggle — kill switch for the entire LLM tier.
- [ ] `escalationThreshold` slider (0-100, default 41).
- [ ] `tier2CooldownMs` input (seconds, default 300).
- [ ] `tier2ScoreDelta` input (default 10).
- [ ] **`tier1ModelOverride` / `tier2ModelOverride` model picker.** Per the original Q2d follow-up — "after we get option B working." Operators on a Sonnet plan might want tier-2 to use Sonnet 4.7 instead of Opus 4.7 for cost reasons; OpenAI teams might want o-series instead of GPT-5.

---

## E. Drift Monitor — Provider Expansion

- [ ] **Ollama / local-model support.** Operators with a GPU who want fully-local drift judging (no LLM data leaving the machine) can point at an Ollama endpoint. New CLI shim `ollama` plus a `local` provider entry in `PROVIDER_MAP`.
- [ ] **DeepSeek API as a first-class provider.** OpenAI-compatible endpoint with custom base URL — could plug in via the existing OpenAI provider with a config override, but worth its own first-class entry given the cost-per-quality story.

---

## F. Cross-Cutting Items (Non-Drift)

These came up in drift reviews but are independent features. Tracked here for visibility; pursue as standalone work.

- [ ] **Infrastructure plugin system** — Railway / Vercel / Render / EAS / Supabase plugins so agents can provision DBs + deploy previews. Captured at `2026-05-04-infrastructure-plugin-system-idea.md`. Pursue after drift slice 3.
- [ ] **GUI launcher** — explicitly scrapped earlier this session. Re-evaluate if dev-onboarding friction becomes a real pain point.

---

## How to use this list

When picking up the project cold, start here. Each section's items are self-contained — pick whichever has the highest value for your current goal.

For drift work specifically, **A is the natural next slice** (correction-task generation closes the loop from "engine reports drift" to "team fixes drift"). B + C + D are polish that can ship in any order alongside A. E is operator-feature work that doesn't gate anything else.

When an item ships, tick the box and move it to the bottom of its section as a `~~struck-through~~` line for traceability — easier to re-find than git-spelunking.
