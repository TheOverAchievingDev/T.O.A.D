# L3 Reform — Scoped, Task-Boundary LLM Drift Judge (Design)

> Status: approved through brainstorming (4 sections, ruled
> incrementally). Realizes PROJECT.md §8a **Layer 3**. Supersedes the
> paused 2-tier-LLM model (`check_llm_semantic_t1`/`_t2`,
> whole-team-brief payload, deterministic `escalationGate`,
> every-drift-tick firing).

## 0. Summary

The LLM drift judge was paused 2026-05-15 (`dev-api-server.mjs`:
`DETERMINISTIC_CHECKS` instead of `ALL_CHECKS`) because the old model
ran `check_llm_semantic_t1` on **every** 60s periodic tick + every
manual Run-Drift, fed it the **whole** team-state brief (24 KB
trimmed), and escalated to a stronger model on a deterministic
**score** threshold. That produced the bulk of drift noise + failures
and blew model prompt caps on rich operator setups.

This reform rebuilds L3 to the §8a doctrine: **fires only at task
boundaries AND only when L1 (later L2) surfaced ambiguity; sees a
scoped payload (relevant `spec.json` + the specific diff + the L1
flag), never the whole brief; Haiku for the common case, escalate to
Sonnet only when Haiku itself flags ambiguity.** Then un-pause.

**Strategy (ruled): Approach 1.** Keep the battle-tested
`src/drift/llm/llmJudge.js` spawn core verbatim (HOME isolation +
temp-brief file transport + JSON parse/validate — the hardest-won fix
of the whole drift arc). Rewrite payload, prompt, trigger/escalation;
rework the registry; **delete** the dead whole-brief path so the
paused every-tick behavior cannot leak back.

## 1. Why / doctrine

§8a Layer 3: "LLM judgment, sparingly. Fires only at task boundaries
AND only when L1/L2 surfaced ambiguity. Sees a *scoped* payload
(relevant spec section + the specific diff + the L1/L2 flag), never
the whole brief. Haiku for the common case; escalate to Sonnet only
when Haiku itself flags ambiguity."

The paused model contradicted every clause: it ran on periodic ticks
(not task boundaries), unconditionally (not L1-ambiguity-gated), on
the whole brief (not scoped), escalating on a deterministic score
(not Haiku's self-reported ambiguity). The reform aligns each clause.

## 2. Scope & decomposition — two slices

The *mechanism* is clean; the two *trigger inputs* are the fuzzy,
coupling-heavy parts. Sliced (sequenced, not dropping either branch —
the trigger is "Both", ruled below):

- **Slice A — L3 mechanism + the flagged-finding branch + un-pause.**
  The whole pipeline (control plane §3, execution plane §4),
  driven by branch 1: an L1 finding carrying `needsSemanticReview`.
  Adds the flag to the two highest-value L1 classes (§5). Dogfood on
  real Reaper. **Un-pause is the final atomic commit of Slice A.**
  Independently valuable + shippable.
- **Slice B — the silent-but-significant detector.** Branch 2 (diff
  touches spec-relevant surface, L1 silent) plugged into the gate's
  already-wired `OR` slot. Its own dogfood + commit. The fuzzy
  heuristic gets isolated attention with the mechanism already proven.
  **Concretely (clarified in spec review):** Slice A ships a literal
  stub — `silentButSignificant(...) { return false; }` in `l3Gate.js`,
  *called* by step-4 of the predicate so the gate structure is fully
  wired. Slice B replaces only that function's **body** (+ its unit
  tests + dogfood). It is the former (stub present + invoked), NOT the
  latter (call absent, added in B) — so Slice B's blast radius is
  exactly that one function body and its tests, nothing else in the
  gate or engine moves.

This document specifies **Slice A** in full; Slice B is scoped here
(§3 predicate slot) and gets its own design pass when A ships.

## 3. Control plane — trigger plumbing, `l3Gate`, verdict cache

L1 deterministic checks keep running on **every** drift run exactly as
today (periodic, task_event, manual) — unchanged. The reform adds,
*after* L1 findings are scored, one decision: invoke L3 or not.

### 3.1 Trigger plumbing

`driftMonitor.notifyTaskEvent` already fires
`runDrift({teamId, trigger:'task_event'})` on `task.status_changed`.
Two minimal threads added: it passes the boundary-crossing `taskId` +
`to` status through → `runDrift({ teamId, trigger, boundaryTaskId,
boundaryTo })` → onto the snapshot. Manual Run-Drift passes
`trigger:'manual'` (already does). Periodic passes neither.

No signature break — the new fields are **optional**; existing
callers/tests are unaffected. A `runDrift` doc-comment states:
`boundaryTaskId`/`boundaryTo` are populated **iff** the run is
task-event-or-manual-scoped; their absence is itself the structural
signal "this is not a transition event."

### 3.2 `l3Gate(input)` — pure predicate + in-memory verdict cache

New `src/drift/llm/l3Gate.js`. Decides per boundary-task. **The
5-step ordering is deliberate and non-negotiable — cheapest field
compares first, the expensive 3-hash key computation last, so the
common case (periodic tick, no L3) rejects in nanoseconds and hashing
only runs for the small subset that survives the cheap gates. A code
comment states this explicitly: do NOT reorder hashes-first to
"fail-fast on cache hits" — that defeats the cost discipline.**

1. `trigger==='periodic'` → **never** (the §8a cost core).
2. `trigger==='task_event'` and `boundaryTo ∉ {review, merge_ready,
   done}` → never (drops `testing` and every other non-submission
   status — see §9).
3. `trigger==='manual'` → eligible (operator intent).
4. **Ambiguity gate — holds regardless of which transition fired,
   INCLUDING manual.** Any L1 finding *for the boundary task* carries
   `needsSemanticReview` **OR** silent-but-significant (Slice B slot —
   returns `false` in Slice A). **Not ambiguous → skip, even on
   manual.** Manual's "eligible" in step 3 means only "passed the
   periodic/status gates" — it does NOT bypass ambiguity. The operator
   clicking Run-Drift is saying "judge it if there's something to
   judge," not "judge regardless": with no ambiguity there is
   literally nothing for L3 to adjudicate, and running it would burn
   capacity producing a clean verdict on no signal. (A bare `review`
   transition with confident L1 either-direction does **not** invoke
   L3.)
5. **Cache gate**: compute `key = sha1(diffHash + spec.provenanceHash
   + l1FindingSetHash + l3PromptHash)`. If `trigger!=='manual'` and
   the per-team cache holds a verdict for `key` → return the **cached
   verdict** (no L3 call). Manual bypasses. Else → **invoke L3**, then
   store the resulting verdict under `key`.

The verdict cache is per-team in-memory, same lifetime/pattern as the
engine's existing `#tier2Cooldown`/`#lastRunAt` maps (lost on restart
— acceptable; first boundary after restart recomputes). Only
**successful** verdicts are cached; a failed/timed-out judge call is
never cached so the next boundary retries.

### 3.3 Cache-key hash component definitions (pinned — cache
correctness is the kind of thing that goes quietly wrong)

- **`diffHash`** = sha1 over the **sorted list of changed files, each
  paired with the sha1 of its post-image content** — NOT the full
  diff text. Rationale: the judge reasons about *what the code says*,
  not how the diff is formatted; content-hash is stable to
  whitespace/formatting churn → more cache hits on no-real-change
  transitions, while still changing whenever real content changes.
- **`spec.provenanceHash`** = sha1 over the exact fields
  `{ version, provenance.reviewed, provenance.extracted_at,
  provenance.extracted_by }`. A ratification flip
  (`reviewed:false→true`) OR any spec version/extraction change
  invalidates the cache.
- **`l1FindingSetHash`** = **order-independent**: the boundary task's
  L1 findings are sorted by `(checkName, ruleId, file, line)`, then
  sha1 over the sequence of `{ checkName, severity, file, line,
  ruleId, needsSemanticReview }` per finding. Finding-id / timestamp /
  runId are **excluded** (they vary across runs that produce the same
  findings → would make the hash spuriously unstable).
- **`l3PromptHash`** = sha1 of the §4.2 scoped-adjudicator prompt
  template string (the exported constant, pre-interpolation). A cached
  verdict answers "would re-running L3 produce the same answer?"; if
  the prompt itself changes, every prior verdict is stale and may not
  reflect what the new prompt would produce — exactly the same
  invalidation rationale as `spec.provenanceHash` (a contract change
  must invalidate). Including it means a prompt edit auto-invalidates
  the cache without relying on a process restart (a hot-reload or a
  deploy-without-restart would otherwise serve stale verdicts). Cheap
  — one extra hash component; correct — closes a real staleness hole
  the "lost on restart" property does not fully cover.

### 3.4 Circuit breaker (belt-and-suspenders)

The structural gating (boundary + ambiguity + cache + Haiku-first)
*is* the primary cost control. The circuit breaker protects against a
**system bug going haywire** — not legitimate high-volume teams.
Genuine pathological cases: trigger plumbing flip-flopping
`task_event` on one task; a cache-hash bug making every call miss; an
ambiguity predicate that flags everything.

- Per-team rolling cap, **config-tunable**:
  `settings.drift.l3RateCapPerHour`, **default 30** (well above the
  ~25–35/day busy-team projection — never fires in normal operation).
  In-memory, same map pattern as the cooldowns. `settings.drift.*` is
  an **existing** namespace (driftEngine `DEFAULT_SETTINGS.drift`
  already holds `escalationThreshold`, `periodicCooldownMs`,
  `tier{1,2}ModelOverride`, etc.) — `l3RateCapPerHour` is a new key
  added to that existing tree with a default in `DEFAULT_SETTINGS`,
  not a new namespace.
- When exceeded, L3 is skipped and a **observer-severity** finding is
  emitted ("L3 rate cap hit — investigate the drift system"). Observer
  (not info) because the cap firing in normal operation **indicates a
  bug worth investigating**, not routine throttling — the lead/operator
  must see it.
- A circuit-breaker skip does **not** populate the verdict cache for
  that key. When the window clears, the next boundary on that key
  computes fresh.
- Safety argument: L3 is observe-only, so temporarily suppressing it
  can never cause a bad merge (the merge gate is independent and
  deterministic). The breaker only bounds a failure mode.

## 4. Execution plane — packet, prompt, Haiku→Sonnet judge, engine

**Slice membership:** the execution plane is **part of Slice A**, not
a separate slice. Slice A must ship a *whole working mechanism*
before un-pause — control plane (§3) AND execution plane (§4)
together, driven by the flagged-finding branch. Two slices total.

### 4.1 `buildL3Packet(snapshot, boundaryTaskId, l1Signal)`

New `src/drift/llm/buildL3Packet.js`. Replaces `buildUserPayload`'s
24 KB whole-team brief with a scoped per-task packet:
- The boundary task's diff **only** —
  `snapshot.diffsByTask[boundaryTaskId]` (changed files + diff body).
  The existing diff cap is **per-task-diff-body, not per-file**:
  `checkLlmSemantic.js`'s `buildUserPayload` caps a task's *entire*
  diff body at `1500` chars (`const cap = 1500`). For a single-task
  packet that is inherently small (the 50-files-×-1500 per-file
  reading the spec review worried about does not apply — it is 1500
  chars *total* for the task's diff). Worst-case packet math:
  `1500` (diff) + whole `spec.json` (a few KB; Reaper's is ~4 KB) +
  the L1 signal (sub-KB) ≈ **well under 8 KB** → "kilobyte-scale" is
  provable, not asserted.
- The **whole `spec.json`** — deliberately. It is the compact
  canonical machine contract (dependencies / structure / contracts /
  constitution / provenance — typically a few KB). Including it whole
  lets the judge cross-reference any rule/contract/constitution entry
  with no pre-selection logic that could mis-filter and silently
  starve the judge of context. **Compactness comes from the spec
  *format* (structured JSON projection), not from runtime
  pre-filtering.**
- **No foundry prose docs.** This exclusion is **doctrinal, not a v1
  limitation**: prose docs at scale are precisely what overflowed the
  prompt cap; encoding the same content as `spec.json` was the
  structural fix. There is no future state where L3 reads prose at
  runtime — if something in the prose is judgment-relevant, the
  correct move is to promote it into `spec.json`'s structured form,
  never to let L3 read prose.
- The L1 signal being adjudicated: the `needsSemanticReview`-flagged
  finding(s) for that task (Slice A), or the silent-gap note
  (Slice B).

Result is kilobyte-scale. Still written to the temp brief file and
read via the **unchanged** HOME-isolated `llmJudge` spawn — the
prompt-cap problem is now solved *at the source* (tiny payload), with
HOME isolation retained as defense-in-depth.

**Enforced packet budget (recommended-change adopted — enforced beats
asserted).** `buildL3Packet` enforces a hard budget
`L3_PACKET_BUDGET_BYTES` (config-tunable `settings.drift.*`, default
**32 KB** — generous vs the ~8 KB worst case, so it only trips on a
genuinely pathological task). If the assembled packet exceeds the
budget, `buildL3Packet` does **not** truncate-and-send (truncation is
exactly what recreated the original prompt-cap failure mode).
Instead it returns an **over-budget signal**; `l3Gate`/engine skips
the L3 spawn and emits one honest non-blocking `info` meta-finding
("L3 packet over budget for task `<id>` (`<N>` KB, `<F>` files
changed) — semantic adjudication skipped; deterministic L1 findings
still apply"). This forces a conscious future decision (raise the
budget? relevance-truncate? split the task?) rather than silently
producing a payload that re-incurs the cascade. A `buildL3Packet`
unit test asserts: a normal task → under budget; a synthetic
many-files/huge-diff task → over-budget signal (never a truncated
payload). The budget is thus enforced in code + test, not merely
documented.

### 4.2 Scoped adjudicator prompt

New `src/drift/llm/prompts/l3.js`. Reframes the judge from "scan the
whole team's state for drift" to a scoped adjudication: *"Here is one
task's code change, the project's machine-checkable contract, and the
deterministic signal. Is this a genuine spec violation the operator
must act on?"* Output JSON:
`{ verdict: 'drift'|'clean', confidence: 'high'|'low', findings: [...] }`.
`confidence:'low'` is the model's self-reported ambiguity signal — the
**only** escalation trigger.

### 4.3 `l3Judge(packet, provider)` — Haiku→Sonnet, one escalation

New thin wrapper over the reused `llmJudge`. Resolve provider via the
existing `providerResolver` (`PROVIDER_MAP`: tier1 = Haiku family,
tier2 = Sonnet/strong — same map, semantics repurposed: tier1 = the
common Haiku judge, tier2 = the escalation judge). Run Haiku on the
packet. If Haiku returns `confidence:'low'` (self-flagged ambiguity)
→ re-run the **same packet** once through the tier2 model. **Exactly
one escalation, never a loop.** If Sonnet *also* returns
`confidence:'low'`, the verdict is **cached and returned with low
confidence carried through** — a genuinely ambiguous case yields a
low-confidence finding the operator can weight, not an infinite
resolve attempt.

- The cached verdict structure includes `tier: 'haiku' |
  'sonnet-escalated'` (telemetry — future-you will want "what fraction
  needed Sonnet"). The cache stores the **final** verdict (Sonnet's
  when escalated), never the intermediate.
- Findings carry which model produced them.
- Severity cap: Haiku-only findings capped at `high`; `critical` only
  from the Sonnet escalation — a small/cheap model must not
  unilaterally produce the highest-severity verdict. **This invariant
  is INTRODUCED, not preserved.** Verified during spec review: the
  cap currently lives *only* at `checkLlmSemantic.js:257`
  (`severity: tier === 1 && f.severity === 'critical' ? 'high' :
  f.severity`) — exactly the code Approach 1 deletes/rewrites. No
  independent registry-side or `llmJudge`-side enforcement exists
  (`llmJudge.validateFinding` only range-checks severity, it does not
  cap by tier). So Slice A must **re-implement** the cap as an
  explicit, tested enforcement point inside `l3Judge` (cap any
  Haiku-tier finding's `critical`→`high` before returning; allow
  `critical` only on the `tier:'sonnet-escalated'` path). The §7
  `l3Judge` unit ("Haiku severity capped at `high`") is that test.

### 4.4 Engine integration

In `#runDriftInner`, after L1 findings are produced + scored and
after the periodic-cooldown early-return (already shipped): call
`l3Gate`. Cached-verdict → fold those findings in, no spawn.
Invoke → `l3Judge` for the boundary task, merge findings (existing
dedupe-by-id), persist, store the verdict under the cache key.

L3 findings carry `checkName:'check_llm_semantic'`, `kind:'drift'`
(taxonomy passthrough — scorer / UI / lead routing treat them like
any other drift finding; **no `if (finding.from==='l3')` special-case
anywhere** — pass-through keeps the abstraction boundary clean so L3
can be replaced wholesale without touching downstream, same discipline
as the broker-seam's no-consumer rule).

The old `check_llm_semantic_t1` (tier-1-always) / `_t2`
(score-escalated) registry entries are **removed** — L3 is
gate-invoked, not tier-list-invoked. The
`DETERMINISTIC_CHECKS`/`ALL_CHECKS` split collapses to one check set;
L3 is conditionally invoked by `l3Gate`, not by tier membership.

**Cross-cutting consistency (must land in the same un-pause commit):**
the conformance/drift taxonomy `src/drift/checks/checkKinds.js`
(`CHECK_KIND` map) has a **load-time completeness guard that throws if
any registered check is unclassified**, and currently maps
`check_llm_semantic_t1`/`_t2` → `'drift'`. Removing those registry
entries and introducing the single `check_llm_semantic` requires the
taxonomy map updated in lockstep: drop the two `_t1`/`_t2` keys, add
`check_llm_semantic: 'drift'` (+ its checkKinds test). Otherwise the
guard either throws at load (new check unclassified) or persisted L3
findings read back with `kind:null`. This is part of the atomic
un-pause commit (§8), not a separate step.

### 4.5 Failure handling

Reuse `llmJudge`'s posture: spawn failure / timeout / invalid JSON →
a single **non-blocking meta-finding** (as today), the run continues,
the verdict is **not cached** (transient → retry next boundary).
Never throws out of a drift run — L3 adds capability, it must never
gate the delivery of deterministic L1 findings. The L3-failure
meta-finding is **operator-UI only, not lead-routed** (it is an
infrastructure event, not drift the lead coordinates around).

## 5. `needsSemanticReview` flagging (Slice A)

`needsSemanticReview` is an **additive optional finding field**.
Checks opt-in only their genuine *judgment-call* classes (YAGNI —
start with the two highest-value; the mechanism makes adding more a
one-line opt-in later):

- **`check_structural_undeclared_present` (L1.2b)** — "a module
  exists the spec never declared": scope-creep drift or a legitimate
  refactor split? L1 cannot tell. **Flag.**
- **`check_constitution` (L1.3) observe-mode hits** — a grep hit can
  be contextually fine (the exact FP classes fought during L1.3:
  doc-comments describing a prohibition, governance prose). A scoped
  semantic second opinion is high-value. **Flag observe-mode hits
  only.** This is **doctrinal, not a v1 limitation**: gate-mode hits
  are already enforced deterministically by the merge gate — running
  L3 over a gate-mode hit is redundant (L3 agrees, gate already
  blocked) or contradictory (L3 says "fine", operator gets a mixed
  signal about a gate that already fired). Gates are deterministic by
  design; semantic ambiguity lives in observe-mode. There is no
  future "add gate-mode L3" — it is doctrinally wrong.
- **Not flagged in Slice A** (deterministic, binary — L1 already
  produces the right answer; L3 would burn capacity): dependency
  drift (L1.1 — dep is in spec or not), declared-absent + its
  honest-dormant metas (L1.2a — spec says X, source has X or not,
  task delivers X or not), contract presence/arity (L1.4a/b —
  signature matches or not).

## 6. Lead system-prompt change (same slice — ruled)

One addition to the lead guidance in `src/team/teamSystemPrompts.js`:
when an L3 finding exists for a task in `review`, the lead **bundles
it into the review-request message as a single coherent review
packet** (not a separate message, not blocking until the reviewer
acks — bundled into the one review-request message the reviewer
reads). Surfacing at `review` (the highest-leverage trigger) means
the reviewer reads L3's verdict alongside their own review rather
than discovering it at merge_ready. Prose-only, no code coupling.
Lands in the same slice as the trigger work so the value is realized
atomically (the trigger doesn't fire into a void).

**Interface-contract note (not code coupling, but real):** the lead's
bundling renders specific L3-finding fields in human-readable form
(`title`, `expected`, `actual`, `recommendedCorrection`, and the
`confidence` signal). This is a soft prose↔schema contract: if the L3
finding schema evolves (Slice B adds fields, or a future iteration
renames `confidence`), this prompt section must be reviewed so the
lead keeps rendering the right fields and does not surface garbage.
The §7 finding-schema snapshot test is the tripwire — a schema change
breaks that snapshot, which is the signal to re-review this prompt
section. Stated so a future contributor knows the dependency exists.

## 7. Testing (TDD, RED→GREEN)

- **`l3Gate` pure-unit:** all 5 ordered steps; periodic → never;
  `task_event` with `testing`/other non-submission → never;
  review/merge_ready/done eligible; manual eligible + cache-bypass;
  ambiguity gate (flagged vs not); cache hit returns verdict w/o
  spawn; cache miss invokes; circuit breaker fires an
  **observer-severity** finding at the config cap; circuit-breaker
  skip does **not** populate the cache.
- **Hash-stability units (lock the §3.3 contract in code):**
  - `diffHash` stable to whitespace/format churn; **and** changes
    when content actually changes (coarseness guard).
  - `l1FindingSetHash` order-independent; **and** changes when the
    finding set changes (one added / one removed — order-independence
    must not collapse into content-blindness).
  - `spec.provenanceHash` flips on `reviewed` change; **and** on any
    other provenance field (`version`, `extracted_by`,
    `extracted_at`) — the broader cache-invalidation contract, not
    just the primary case.
- **`buildL3Packet` unit:** contains the one task's diff + whole
  `spec.json` + the L1 signal; **no foundry prose**; kilobyte-scale.
- **`l3Judge` unit** (injected spawn — `llmJudge` already takes
  `spawnImpl`): Haiku happy path; `confidence:'low'` → exactly one
  Sonnet re-run of the **same** packet; Sonnet-also-low → cached low,
  no loop, `tier:'sonnet-escalated'`; spawn fail / timeout / bad-JSON
  → meta-finding, **not cached**; Haiku severity capped at `high`.
- **Finding-schema snapshot test:** the finding shape **with and
  without** `needsSemanticReview` set, to lock the schema contract
  (the flag is referenced by `l3Gate` and eventually the UI — any
  drift in its name/type/presence semantics causes silent breakage).
- **Engine integration:** boundary `task_event` + flagged L1 finding
  → L3 invoked, findings merged + verdict cached; next transition same
  key → cached, no spawn; manual → bypass; periodic → never. Existing
  L1 suites stay green (the new flag is additive — characterization).
- **Dogfood on real Reaper before un-pause.**

## 8. Un-pause sequencing

Un-pause is the **final commit of Slice A**, only after the whole
mechanism dogfoods clean on real Reaper. It is **one atomic commit**:
collapse the `DETERMINISTIC_CHECKS`/`ALL_CHECKS` split + remove the
`_t1`/`_t2` registry entries + wire the gate-invoked path in the
engine + `dev-api-server.mjs`, **together**. Splitting "collapse the
check sets" and "wire the gate path" into two commits would leave an
intermediate state with no L3 capability AND no dead `_t1`/`_t2` — a
momentarily broken engine. Single commit flips the system
paused→live; either it's in or it's out. Because every upstream Slice
A commit is dogfooded-safe, the un-pause commit itself is trivially
revertible if something subtle surfaces in production, without
endangering the upstream work.

## 9. Non-goals (named so they do not creep)

- **Slice B's silent-but-significant detector** — separate slice; the
  gate's `OR` slot stays stubbed `false` in Slice A.
- **No L3 on any non-submission lifecycle status.** The `testing`
  exclusion generalizes: not `in_progress`, not any future status
  (`awaiting_review`, etc.). L3 fires only at submission boundaries
  (`review`, `merge_ready`, `done`) + manual.
- **L2 embeddings** — still deferred-last per §8a (after L1/L3
  stable).
- **The observe-mode message-drift broker-seam consumer** — separate,
  unrelated (from the broker observer-seam work; that slice shipped
  the seam only).
- **No behavior change to the merge gate or L1 checks' core logic** —
  only the additive `needsSemanticReview` flag on two L1 classes.
- **The per-provider compaction / memory-file / token-monitoring /
  rate-limit-routing discipline + unified `provider_adapter` config**
  — explicitly deferred per the sequencing ruling ("don't implement
  the per-provider discipline until L3 is done; doing both in parallel
  is exactly the context-thrashing that produces context rot").
  Captured **verbatim** in Appendix A so it is ready to execute as its
  own design once L3 ships clean — NOT summarized (a summary would
  require re-derivation later).

---

## Appendix A — DEFERRED: Per-provider compaction / memory / rate-limit discipline

> Captured verbatim from the L3 trigger ruling. **Do not implement
> until L3 (Slices A + B) ships clean.** This is a sprawling
> cross-cutting change touching every CLI adapter; sequencing it after
> L3 prevents context-thrash. When picked up, it gets its own
> brainstorm → spec → plan cycle.

**The universal truths (apply to all three providers):** Every CLI on
plan auth burns capacity, not dollars. Every CLI has a context window
that grows as you talk to it. Every CLI suffers context rot — quality
degrades long before the window fills. Every CLI has a compaction
mechanism. Every CLI supports a project-level memory file. Every CLI
is better off rotated at task boundaries than resumed across them.

**Per-CLI differences that matter for Symphony's supervisor logic:**

*Claude Code:* Memory file `CLAUDE.md`. Compaction `/compact`
(manual), auto-compact ~85%. Resume `claude -c` (latest) / `claude -r
<id>` (specific) — restores full context, does not save tokens. Token
visibility: `/context` slash command, also emitted in stream-json
events. Threshold rec: exit/restart at ~80% for complex multi-file
work (research says 85–90%; 95% is often too late). Auth for Symphony:
plan auth via `claude login`.

*Codex CLI:* Memory file `AGENTS.md` (different name, same concept).
Compaction: two-tier on auto-threshold — (1) Session Memory Compact
(checks whether structured session-memory info can substitute for a
full LLM summarization call; most auto-compactions take this path,
avoiding an LLM call entirely); (2) Server-Side Compact via Responses
API (`POST /v1/responses/compact`, proprietary, returns an
`encrypted_content` blob) when session memory is insufficient. Codex
compaction is partially free (no LLM call needed for many cases).
Resume: `codex resume` (picker), `codex resume --last`, `codex resume
<SESSION_ID>`. Token visibility `/status`. Notable: has run
continuously up to ~7 hours on complex tasks via this mechanism;
compaction is unusually good. Auth: plan auth via ChatGPT account.

*Gemini CLI:* Memory file `GEMINI.md`. Compaction `/compress`;
`chatCompression.contextPercentageThreshold: 0.6` config knob (most
explicit of any CLI). Auto-compression automatic since v0.38.0: when
context crosses the threshold a summarization sub-agent rewrites
conversation history compactly; it targets ephemeral content (tool
call sequences, raw file output, multi-turn dialogue) and explicitly
**excludes** `GEMINI.md` system context (project instructions/
conventions left untouched). Resume `/chat save <tag>` + `/chat
resume <tag>` (named branches, not auto-resume). Token visibility
`/stats` — cached-token info only displayed with API-key auth, not
OAuth (plan-auth users get less granularity). Checkpointing: saves a
project snapshot before tools modify files; `/restore` lists/restores
— unique to Gemini. Auth: plan auth via Google account / Gemini Code
Assist subscription. Rate-limiting is **per-day** on free/plan tiers
("You have reached your daily gemini-2.5-pro quota limit") — a
different shape than Claude/Codex.

**The supervisor logic Symphony needs (three layers, per provider):**

- **Layer 1: Provider-aware token monitoring.** `RuntimeSupervisor`
  needs a provider adapter that reads token usage out of each CLI's
  event stream — Claude in stream-json system events, Codex via
  `/status`, Gemini via `/stats`. Unified
  `getContextUsage(agentId): { used, total, percentage }` interface
  regardless of provider.
- **Layer 2: Provider-aware compaction triggers.** Sweet spots
  differ: Claude `/compact` at 65–70% (auto fires at 85%, too late);
  Codex `/compact` at 70–75% (compaction cheaper there via the
  session-memory path); Gemini set
  `chatCompression.contextPercentageThreshold: 0.6` in settings.json
  + supplement with manual `/compress` at task boundaries. Supervisor
  sends the right signal to each via the same stdin rail Symphony
  already uses for messages.
- **Layer 3: Provider-aware memory file management.**
  `foundry_project_materialize` should emit all three —
  `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` at project root, same
  vision/conventions/stack info formatted per CLI convention.
  Redundant but free (markdown), and a worker spawned on any provider
  gets the same baseline alignment.

**Asymmetries worth flagging:** Gemini's plan-auth rate-limiting is
harsher + more visible (per-day quota) — expect Gemini to hit caps
first; have a fallback (route that worker's tasks to a free
Claude/Codex worker for the rest of the day). Codex's compaction is
best — route very long sustained (multi-hour) tasks to Codex. Gemini's
checkpointing is unique — for risky filesystem changes Gemini has an
extra safety net (relevant to task assignment). Gemini's
auto-compression at 60% preserves `GEMINI.md` — strong reason to put
vision/steering in the memory file (conversation content gets
summarized; the memory file is protected); same logic applies to
`CLAUDE.md`/`AGENTS.md` though Anthropic/OpenAI don't document the
equivalent protection as explicitly.

**Unified per-provider config shape Symphony should aim for:**

```
provider_adapter:
  claude:
    memory_file: CLAUDE.md
    compaction_command: /compact
    compaction_threshold: 0.65
    token_query: stream-json system events
    resume_command: claude -r <id>
  codex:
    memory_file: AGENTS.md
    compaction_command: /compact
    compaction_threshold: 0.70
    token_query: /status (or parse exec output)
    resume_command: codex resume <id>
  gemini:
    memory_file: GEMINI.md
    compaction_command: /compress
    compaction_threshold: 0.60 (config in settings.json)
    token_query: /stats
    resume_command: /chat resume <tag>
    rate_limit_aware: true  # per-day caps on plan tier
```

That structure lets every higher-level concept (compact early, rotate
sessions, lean memory files, vision in system) implement identically
across providers while routing through the right per-provider
mechanism underneath.
