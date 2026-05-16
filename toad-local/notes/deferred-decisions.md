# Deferred decisions

Decisions made during brainstorming that are **banked, not yet built** —
captured so a later cycle starts from the agreed answer instead of
re-litigating it. Each entry: the decision, why, known properties, and
when it unblocks.

---

## Summarizer (Layer 2 of the readability layer) — runtime architecture

**Status:** Deferred to a post-Sub-project-C cycle. The readability
layer's Layer 1 (templated event view) + LoC counter are being
designed/shipped first (observation-window-safe); Layer 2 (activity-span
summarization) waits because it needs an LLM and that infra does not
exist yet (grounded 2026-05-16: zero `ollama`/`llama`/`qwen`/local-model
code anywhere in `src/`; the only LLM path is `src/drift/llm/*` which
spawns the **provider CLI** `--model`, not a local model).

**Decision (the starting point when the summarizer brainstorm opens):**
The summarizer is **a spawned CLI session under plan auth, routed to an
underutilized provider plan** — NOT a local Qwen process and NOT a
cloud API key.

Rationale (why this beats both local-Qwen and cloud-API):
- **Zero new infrastructure.** Reuses `RuntimeSupervisor.launchAgent`,
  the stream-json adapters, broker plumbing, HOME-isolated spawn, and
  `--append-system-prompt`. Architecturally it is just another spawned
  CLI, the same pattern as workers.
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

**Recipe to design against later:**
1. **Spawn pattern:** identical to workers (`RuntimeSupervisor.launchAgent`)
   + a tight summarizer-only `--append-system-prompt`.
2. **CLI routing:** to the least-worker-loaded plan; per-project config.
3. **Lifecycle:** **stateless per call** — each span summary is
   independent (no reason to remember span #47 when doing #48). Spawn at
   team-launch, but treat each summarization as an isolated request
   (fresh context / compaction reset) so the summarizer's own context
   never rots. Stop with the team.
4. **UI:** the summarizer is a **system service, not a team agent** —
   it takes no tasks, sends no messages, is not a broker participant.
   Surface it in a system/cockpit panel, visually distinct from team
   agents, with its own status (`summarizing` / `idle` /
   `rate-limited`). Do NOT put it in the team rail.
5. **Cost discipline (same as L3):** fire ONLY at span boundaries, never
   per-event; circuit breaker bounding the pathological case (same
   pattern as L3's rate cap). **Plan-auth ≠ unbounded** — bank this.
6. **System prompt is the whole personality:** explicitly constrain —
   "your only job is summarization; do not invoke tools, do not propose
   code changes, do not reason at length, produce only the requested
   summary." A frontier CLI told to do a narrow job will otherwise try
   to be helpfully wrong (suggestions, questions, tangents).
7. **Graceful degradation (same honest-degradation discipline as
   Sub-project B's `source:'unknown'` / stale meter):** on rate-limit or
   chosen-CLI unavailability → fall back to **Layer-1-only** display
   (templated events, no LLM summary); optionally fail over to another
   CLI's plan; **surface the degraded state explicitly** to the operator
   ("summarizer rate-limited — raw events shown"). Never paper over it.
8. **Historical view:** **persist span summaries with the events** so
   scrolling back is just rendered text; the summarizer only generates
   for *new* live spans, never re-summarizes history.

**Known property (state it in the design so a future contributor does
not "fix" it):** this makes summarization **dependent on CLI/plan
availability**. If all routed plans are exhausted simultaneously (rare,
heavy day), summarization stops and the UI degrades to Layer-1-only.
The local-Qwen option's one advantage was plan-budget independence; we
are deliberately trading that for frontier quality + zero new infra/auth.
**Do NOT add a local fallback** — that would mean shipping Ollama + Qwen
as a dependency just for the rare degraded case. Honest degradation to
Layer-1-only is the accepted, correct fallback.

**Unblocks:** after Sub-project C. When the summarizer brainstorm opens,
this entry is the starting point (replaces the earlier local-Qwen and
cloud-Gemini-Flash sketches). Origin: operator caught a meaningfully
better architecture than the advisor proposed (the "operator catches the
reviewer" pattern).
