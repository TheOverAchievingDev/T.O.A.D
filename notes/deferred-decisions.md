# Deferred decisions

Decisions made during brainstorming that are **banked, not yet built** —
captured so a later cycle starts from the agreed answer instead of
re-litigating it. Each entry: the decision, why, known properties, and
when it unblocks.

---

## Summarizer (Layer 2 of the readability layer) — runtime architecture

**Status: SHIPPED (May 16–17, 2026).** The entire Layer-2 pipeline was
built across 7 slices (P1–P3c-2, ~18 commits), following this recipe
closely. The file is preserved for historical context — the decisions
below drove the implementation shape.

**Decision (the starting point when the summarizer brainstorm opened):**
The summarizer is **a spawned CLI session under plan auth, routed to an
underutilized provider plan** — NOT a local Qwen process and NOT a
cloud API key.

Rationale (why this beats both local-Qwen and cloud-API):
- **Zero new infrastructure.** Reuses the existing stream-json adapters,
  broker plumbing, HOME-isolated spawn, and `--append-system-prompt`.
  Architecturally it is just another spawned CLI, the same pattern as
  workers.
- **Zero new auth surface.** No API key to manage, no console setup, no
  new credential leak surface. Plan auth that already works keeps
  working.
- **Zero new model setup.** No Ollama install / model pulls / iGPU-vs-NPU
  routing. The "model" is whatever the CLI runs — production-grade.
- **Frontier-grade quality.** Haiku/Sonnet/Opus (or Codex/Gemini)
  vastly outperforms Qwen 2.5 3B at "make this legible to a non-coder."
- **On-brand.** "Symphony orchestrates the CLIs you already have." The
  summarizer being one more orchestrated CLI is on-brand, not a SaaS
  wrapper bolted on.

**The clever core insight — provider routing:** Do NOT put the
summarizer on the same CLI plan as the workers. Route it to the CLI
whose plan is **least loaded by team work**, so it competes with itself
rather than with workers. Default heuristic: workers on Claude/Codex →
summarizer on Gemini; workers on Gemini → summarizer on Codex; etc.
Make it **configurable per-project**. (Plan auth has rate limits, not
infinite capacity — ~50 spans/day ≈ ~100K in / ~7.5K out tokens/day;
small but non-zero, and it competes inside a 5-hour rate window.)

**Recipe vs implementation:**

1. **Spawn pattern** — Designed as `RuntimeSupervisor.launchAgent`; shipped
   as direct `child_process.spawn` with CLI-specific `--print`/`exec -`/`-p`
   modes in `src/runtime/spanSummary/runSpanSummary.js`. Simpler, same
   routing effect.
2. **CLI routing** — Shipped as `resolveSummaryRoute.js` (Gemini→Codex→
   Anthropic preference order, per-project override). ✓
3. **Lifecycle** — Shipped as stateless per-span calls via `summaryMonitor`
   polling + `summarizePendingSpans.js`. ✓
4. **UI** — Shipped as system service in cockpit panel (`spanSummaryProjection.ts`,
   `useSpanSummaries.ts`), distinct from team agents, with `idle`/`summarizing`/
   `degraded`/`rate-limited` status. ✓
5. **Cost discipline** — Shipped as `summaryRateLimiter.js` (rolling-hour
   window, max 20/hr default). ✓
6. **System prompt** — Shipped as `summarizerSystemPrompt.js` ("do not invoke
   tools, do not propose code changes, produce ONLY the requested summary"). ✓
7. **Graceful degradation** — Shipped: rate-limit/CLI unavailable → fall back
   to Layer-1-only; `SPAN_SUMMARY_UNAVAILABLE` frozen object for no-monitor
   state, `degraded` span tracking. ✓
8. **Historical view** — Shipped: `span_summaries` table persists summaries;
   `decideSpansToSummarize` cross-references `summarizedSpanIds` Set. ✓

**Files:** `src/runtime/spanSummary/` (11 files), `src/runtime/spanDetection/`,
`src/runtime/timelineComposition/`, `src/runtime/eventNarration/`,
`src/runtime/sqliteNarrationStore.js`, `src/runtime/sqliteSpanSummaryStore.js`,
`ui/src/hooks/useSpanSummaries.ts`, `ui/src/components/cockpit/spanSummaryProjection.ts`,
20 test suites (~1,597 lines). All wired into `scripts/test-suites.txt`.

---

## Composition extraction (narration↔composition boundary half-life)

**Status: SHIPPED (May 17, 2026 — P2a slice).**

The composition was extracted into the shared pure module
`src/runtime/timelineComposition/composeTimeline.js` (117 lines).
`timelineProjection` now calls it. A golden baseline test
(`test/timelineComposition.agreement.test.js`, 109 lines) proves
byte-identical output to the pre-refactor client. The half-life
described below has been fully discharged.
