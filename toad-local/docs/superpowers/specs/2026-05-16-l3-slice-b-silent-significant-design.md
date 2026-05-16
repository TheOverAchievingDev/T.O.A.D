# L3 Slice B — silent-but-significant detector (design)

> Sibling to `2026-05-15-l3-reform-design.md` (Slice A, shipped). Slice
> A reserved the gate's `OR` slot with a literal stub
> `silentButSignificant(...) { return false; }`. Slice B replaces that
> stub with a real predicate and wires it through the engine. This
> document specifies Slice B in full and names Slice C (contract-aware
> silent significance) as scoped future work.

## 1. Goal & doctrinal anchor

L3 must fire at a task **submission boundary** when the task's diff
**materially modifies spec-declared module surface** even though L1
raised **no `needsSemanticReview` flag** — the case L1's deterministic
structural layer is blind to (behavior drift *inside* declared
structure, where presence/arity/dependency checks all pass).

**Doctrinal anchor — cost discipline IS the predicate's tightness, not
the rate cap.** Slice B is rare *by construction* (declared-surface
AND magnitude floor, both load-bearing). The §3.4 rate cap remains a
circuit breaker for *system bugs*, never routine throttling — the same
correctness reason as Slice A. This rejects, explicitly and on the
record, any "let it fire broadly and let the rate cap absorb the cost"
framing. A future contributor must not re-litigate this.

## 2. The predicate

`silentButSignificant({ snapshot, boundaryTaskId })` — **pure,
findings-free** (matches the stub signature exactly; takes no L1
findings argument), returns a boolean.

```
silentButSignificant  =  touchesDeclaredSurface(diff, spec)
                     AND  meetsMagnitudeFloor(diff)
```

Strict **AND** — both clauses are load-bearing; dropping either to OR
reopens the broad-sweep failure mode.

**"Silent" is emergent from the gate, not a clause here.** `l3Gate`
already composes `ambiguous = flagged || silentSignificant`. If any L1
finding for the task carries `needsSemanticReview`, Slice A's flagged
branch already wins; `silentSignificant` only changes the outcome when
L1 is flag-silent. A non-flagged *deterministic* finding (e.g.
dependency drift) does **not** suppress Slice B — it answers an
orthogonal question. The predicate therefore needs no L1-findings
input, which is why its signature stays `{ snapshot, boundaryTaskId }`.

**Conservative defaults (failure mode = "do not fire L3").** Let
`d = snapshot.diffsByTask?.[boundaryTaskId]`. Return **`false`** if any
of: `d` is absent; `d.error` is truthy; `d.changedFiles` is not a
non-empty array; `d.diff` is not a string. Malformed/absent input must
never throw and never spuriously fire — same discipline as the merge
gate's fail-open-on-scan-error and L3's no-cache-pollution-on-skip.

## 3. `touchesDeclaredSurface`

True iff **some `changedFile` resolves to some `spec.structure.required`
entry of `kind === 'module'`** under the shared helper of §4.

Contracts (`spec.contracts`, shape `{ id, signature }`) are
**excluded** — they carry no file locus in the schema; tying a diff to
a contract requires an L1.4-domain symbol scan. This is a real,
named coverage limitation resolved as **Slice C** (§11), not an
omission.

`spec.structure.required[].evidence` is a **free-text hint**, not a
clean path or glob (real examples: `"src/sampler.rs"`, but also
`"src/win/procs.rs or src/win/mod.rs exposing procs"`,
`"src/ui.rs or src/ui/mod.rs"`). Slice B therefore must **not** do a
literal `Set` intersection on raw `evidence`; it resolves declared
surface the way L1.2 already does, via the shared helper.

## 4. Shared helper `isFileDeclaredByModule` (single source of truth)

```
isFileDeclaredByModule(changedFile: string, moduleEntry)
  -> { declared: boolean,
       matchKind: 'exact_evidence_path' | 'under_module_directory' | 'none' }
```

Encapsulates L1.2's existing resolution rule — *exact evidence path
OR the changed file lives under the module's directory* (the rule
`checkStructuralUndeclaredPresent` already applies). The structured
`matchKind` is near-free and pays off the first time anyone debugs
"why did/didn't Slice B fire on this file" — same telemetry discipline
as `tier: 'haiku' | 'sonnet-escalated'` in the L3 reform.

**Sequencing — two commits, extraction first (mirrors the `judgeSpawn`
extraction discipline of the L3 reform plan):**

- **Commit 1 — pure refactor, no behavior change.** Extract
  `isFileDeclaredByModule` into a shared module. Point
  `checkStructuralUndeclaredPresent` (L1.2) at it. **Sweep**
  conformance/process checks for *any other* "is this file part of
  this module" logic and fold every instance into this one helper —
  sweep once; leaving a third inconsistent implementation costs the
  same bug class this extraction eliminates. L1.2's existing tests
  stay green; the commit is a defensible code-quality improvement
  that stands on its own even if Commit 2 changes.
- **Commit 2 — Slice B.** `touchesDeclaredSurface` consumes the
  shared helper; the rest of Slice B builds on top.

**Lockstep-agreement test (pins the property).** A parameterized test
over a matrix of `(changedFile, moduleEntry)` cases asserts that
L1.2's resolution and Slice B's `touchesDeclaredSurface` **agree** on
every case. It passes today by construction (one helper) and fires
immediately if a future contributor re-inlines or diverges either
side. Cheap test, real protection — this is the structural
impossibility of layer-divergence, not a convention.

> **Architecture principle (bank it; third instance).** Merge-gate
> established `evalConstitutionRule` as the shared-helper pattern; the
> L3 reform extracted `judgeSpawn`; Slice B extracts
> `isFileDeclaredByModule`. **Whenever a check needs to ask the same
> logical question another check already asks, the answer is a shared
> helper, never a reimplementation.** Cost of the principle: one
> extraction per case. Cost of violating it: silent layer-divergence
> bugs that are near-undiagnosable. State this in the Symphony
> architecture notes so it is not re-litigated each time.

## 5. `meetsMagnitudeFloor`

The count = **changed source lines attributed to declared files only**
(a changed line in a non-declared file never counts), where a "changed
line" is an added or removed diff line, **excluding**:

- diff structural lines: `+++`, `---`, and `@@` hunk headers;
- **whitespace-only lines** — after stripping the single leading `+`
  or `-`, if the remainder is empty or whitespace-only, it does not
  count (a reformat is not significance);
- **binary-file diff sections contribute zero** — a binary file's
  diff carries no `+`/`-` content lines (`Binary files … differ`);
  this is stated explicitly so the predicate is deterministic on
  binary changes, not accidentally-zero.

**Comment-only lines are deliberately counted** (NOT excluded). This
is a ruled tradeoff: excluding comments would require per-language
syntax awareness (expensive, brittle, Slice-C-grade). A doc-comment
rewrite of a declared file may fire L3; the cost is one Haiku verdict
that returns clean quickly. Cheap to implement, defensible cost
profile, named as Slice B's known limitation rather than hidden.

The count is compared `>=` the floor:
`settings.drift.l3SilentMagnitudeFloor`, **default 10**. The floor
**always applies** — it is a non-negotiable load-bearing component,
not a feature that can be disabled. The threshold value is
config-tunable; a configured value `< 1` is **clamped to 1** (never
"off"). The floor's existence is what distinguishes "rename a
variable in declared/auth.ts" (noise) from "rewrite the auth flow in
declared/auth.ts" (the case L3 exists for) — same predicate, opposite
value density.

## 6. Gate composition — unchanged

`l3Gate`'s `ambiguous = flagged || silentSignificant` and its
non-negotiable step ordering are **untouched**. The only change inside
`l3Gate.js` is that `silentButSignificant`'s body is replaced (no
longer `return false`) **plus** the eligibility export below.

**Canonical ownership of eligibility rules (directionality is
load-bearing).** The "what counts as a submission status" set and the
"cheap-eligible trigger/boundary combination" predicate are
**canonically owned by `l3Gate.js`** and **consumed by the engine** —
never the inverse. `l3Gate.js` exports:

- the `SUBMISSION` set (or an `isSubmissionStatus(s)` accessor), and
- `l3CheapEligible({ trigger, boundaryTo, boundaryTaskId })` →
  boolean, returning true iff `trigger !== 'periodic'` AND
  (`trigger === 'manual'` OR `boundaryTo ∈ SUBMISSION`) AND
  `boundaryTaskId` is a non-empty string.

The gate defines the rules; the engine respects them. Inverting this
(engine deciding eligibility, gate trusting it) would create two
consumers of a rule with no source of truth — the exact anti-pattern
the §4 lockstep test exists to prevent.

## 7. Engine wiring (honest blast radius — wider than "only the body")

Today the engine passes a **literal `silentSignificant: false`** at
**both** gate call sites (phase-1 and phase-2 of the two-phase gate).
So the Slice A stub is exported and unit-tested but **not actually
invoked** — the `false` is structurally enforced, not merely stubbed.
Slice B must therefore actively wire the predicate in at **both** call
sites, not just replace a function body. The implementation plan must
budget for this; it is not "one function."

- Compute the predicate **once** per task-boundary evaluation and pass
  the same value to both phase-1 and phase-2 gate calls.
- **Cost-safety:** the predicate scans the diff + spec — it must never
  run on the periodic hot path. Guard the computation with
  `l3CheapEligible(...)` (§6): if not cheap-eligible, pass
  `silentSignificant: false` *without computing the predicate*. This
  mirrors Slice A's "compute the expensive hash only past the cheap
  gate" discipline — the periodic tick pays nothing.

## 8. Packet — the silent-gap `l1Signal` (`buildL3Packet` unchanged)

`buildL3Packet` already `JSON.stringify`s whatever `l1Signal` it is
handed (the Slice A "or the silent-gap note (Slice B)" slot). **No
packet-builder change.** The engine selects `l1Signal` by precedence:

- flagged findings exist for the task → `{ kind: 'flagged',
  findings: [...] }` — Slice A, unchanged, **wins** (more specific
  signal);
- else (silent path) → `{ kind: 'silent_significant',
  declaredFiles: [the matched changed files], changedLines: N,
  note: "L1 raised no semantic-review flag. This diff modifies
  spec-declared module surface (listed) by N lines. Adjudicate
  whether the change semantically drifts from spec.json — L1 is
  structurally blind to behavior change within declared structure." }`.

## 9. Verdict cache — flagged and silent must not cross-serve

`l3CacheKey` gains a new component, `l1SignalKind`, folded into the
hash alongside `diffHash + specProvenanceHash + l1FindingSetHash +
l3PromptHash`. Rationale: a flagged invocation and a silent invocation
for the *same* diff/spec/prompt represent different adjudication
framings (different packet `l1Signal`) and may yield different
verdicts; they must be **structurally** distinct cache entries, not
incidentally distinct. Relying on `l1FindingSetHash` emptiness is
**not** a reliable discriminator — the engine passes the broad
boundary task-finding set to the cache key, not only the flagged
subset, so a silent invocation can carry a non-empty finding set.

`l1SignalKind` is a **sealed enum**: exactly `'flagged' |
'silent_significant'`, nothing else, ever. Adding a value (e.g. a
future Slice-C `'contract_silent'`) is **by design** a cache-key
change that invalidates prior in-memory verdicts — that invalidation
is correct and intended, not a regression. (In-memory verdicts are
lost on restart anyway; the upgrade-time invalidation is acceptable.)

Blast radius of this section: `l3CacheKey` + its hash-stability unit
tests + the dogfood cache-key line.

## 10. Clean-verdict operator telemetry (the silent net must be visible)

Slice A's flagged branch has clear value even on a clean verdict: the
L1 finding is visible and L3's "clean" tells the operator "L1 fired,
judge says fine." Slice B's silent branch is subtler: no L1 finding
existed, Slice B fired L3 anyway, L3 says clean — from the operator's
seat, *did anything happen?* A silent net that is invisible when it
works erodes trust in the layer.

**Ruling: yes, surface it — low-volume, operator-UI-only telemetry.**
When the **silent path** (`l1SignalKind === 'silent_significant'`)
produces a **clean** verdict (judge returned no drift findings), the
engine emits a single meta-finding:

- `severity: 'observer'` (reuses Slice A's observer taxonomy: weight
  0, surfaced, never scored, never blocking);
- `checkName: 'check_llm_semantic'`, a stable code such as
  `silent_clean`;
- human text along the lines of *"Silent-significance check ran on
  task X (modified N declared file(s) by M lines): clean."*

It is **operator-UI-only**: explicitly **not** lead-routed and **not**
action-required. The lead review-packet bundling (L3 reform §6) keys
on actual L3 *drift* findings (`title/expected/actual/
recommendedCorrection`); an `observer`-severity telemetry meta is not
a drift finding and is naturally excluded — Slice B's design states
this explicitly so the exclusion is intentional, not incidental, and
so the lead-bundling predicate is never widened to swallow it.

Drift verdicts (judge returned findings) on the silent path are normal
L3 findings — lead-bundled exactly like Slice A. Over-budget /
failure / rate-cap on the silent path reuse Slice A's existing metas
unchanged. The only **new** meta is `silent_clean`.

## 11. Slice C — contract-aware silent significance (named future work)

Not built here; carved out by name so the contract gap is a tracked
roadmap item, not a silent omission.

- **Why not Slice B:** contracts are symbol-level (`{ id, signature }`,
  no file locus); the predicate would need symbol-scan work that is
  L1.4's domain and too expensive to inline into a cheap predicate.
- **What it catches:** the "signature-same, behavior-drifted" case —
  L1.4 arity/presence passed but a contract-bearing function body
  materially changed.
- **When:** after Slice B ships and produces real signal on whether
  contract-gap coverage is meaningful enough to earn the symbol-scan
  cost.
- **Trigger shape:** like Slice B, but `changedFiles` intersected
  against the *symbol-resolved* files for declared contracts rather
  than `structure.required` evidence paths; new `l1SignalKind`
  `'contract_silent'` (cache-invalidating by design, per §9).

## 12. Testing & dogfood (TDD)

**Unit — `isFileDeclaredByModule`:** exact-evidence-path hit;
under-module-directory hit; no-match; `matchKind` correct for each;
prose/multi-path evidence (`"a.rs or b.rs exposing x"`) resolves the
same as L1.2 does today.

**Unit — `silentButSignificant` truth table:** no diff entry → false;
`d.error` set → false; non-string `d.diff` → false; touches declared +
below floor → false; touches declared + at floor (N) → true; touches
declared + just below floor (N−1) → false; large change to a
non-declared file → false; declared file but only whitespace/`@@`
lines → false; declared file, comment-only change ≥ floor → **true**
(documented limitation); binary-only change to a declared file → false
(zero magnitude).

**Unit — lockstep-agreement:** parameterized matrix asserting L1.2 and
`touchesDeclaredSurface` agree on every `(changedFile, moduleEntry)`.

**Gate composition (stays green):** flagged still wins regardless of
`silentSignificant`; not-flagged + `silentSignificant === true` →
`invoke/ambiguous`; not-flagged + false → `skip/not_ambiguous`;
periodic/non-submission/no-boundary still short-circuit before the
predicate would matter.

**Engine:** silent path → `invoke` + packet `l1Signal.kind ===
'silent_significant'` + verdict cached under the kind-folded key;
periodic run → predicate **never computed** (assert via a spy/guard);
flagged precedence when both flagged and significant hold; silent +
clean verdict → exactly one `observer` `silent_clean` meta, not
lead-bundled; silent + drift verdict → normal lead-bundled findings.

**Cache:** a flagged verdict and a silent verdict for an otherwise
identical diff/spec/prompt occupy **distinct** cache entries
(kind-fold); hash-stability snapshot updated for the new component.

**Dogfood on real Reaper (before the Slice B commit):** a synthesized
diff touching `src/sampler.rs` with ≥ floor non-whitespace lines and
no L1 flag → gate `invoke` with reason `ambiguous` (silent path); a
3-line change to `src/sampler.rs` → `skip` (below floor); a large
change to a non-declared file → `skip` (not declared surface); a
whitespace-only reformat of `src/sampler.rs` → `skip` (zero magnitude).

## 13. Non-goals (named so they do not creep)

- **Contracts / symbol scan** — Slice C (§11).
- **No new lifecycle triggers** — submission boundaries only, as
  Slice A.
- **No AST/touched-symbol magnitude** — line-count floor only; the
  touched-symbol upgrade is the natural Slice-C-grade refinement if
  line-count proves too coarse from real signal, explicitly *not*
  smuggled into Slice B as "a parameter."
- **No rate-cap-as-throttle** — cost discipline is the predicate (§1).
- **No `buildL3Packet` restructure** — the silent-gap slot exists from
  Slice A (§8).
- **No change to Slice A's flagged-branch behavior or its precedence**
  over the silent path.

## 14. Blast radius (honest, stated up front)

Not "just the stub body":

- **Commit 1 (pure refactor):** new shared `isFileDeclaredByModule`
  module; `checkStructuralUndeclaredPresent` (and any swept
  duplicates) re-pointed at it; L1.2 tests unchanged & green.
- **Commit 2 (Slice B):** `silentButSignificant` body;
  `touchesDeclaredSurface` + `meetsMagnitudeFloor`;
  `l3CheapEligible` + `SUBMISSION` export from `l3Gate.js`; engine
  wiring at **both** gate call sites + cheap-eligibility guard +
  `l1Signal` kind selection; `l3CacheKey` `l1SignalKind` fold;
  `DEFAULT_SETTINGS.drift.l3SilentMagnitudeFloor`; the `silent_clean`
  observer telemetry meta; unit + lockstep + gate + engine + cache
  tests; Reaper dogfood.

## 15. Spec self-review

- **Placeholders:** none — every clause has a concrete rule, field
  name (`evidence`, `changedFiles`, `d.diff`, `d.error`), default
  (floor 10), enum (`'flagged' | 'silent_significant'`), and file
  locus.
- **Internal consistency:** §5's whitespace-excluded / comment-included
  / binary-zero matches the §12 truth-table cases exactly; §10's
  observer-severity + not-lead-routed is consistent with the L3 reform
  §6 lead-bundling predicate (drift findings only) and §3.4 observer
  taxonomy (weight 0, surfaced); §9's kind-fold matches §11's
  cache-invalidating `'contract_silent'` note.
- **Scope:** one implementation plan, two commits (extraction then
  feature); Slice C explicitly out.
- **Ambiguity:** "silent" defined unambiguously as emergent from the
  gate, not a predicate clause; "declared surface" pinned to
  `structure.required` modules via the shared L1.2 resolver;
  "magnitude" pinned to non-whitespace, comment-inclusive,
  binary-zero, declared-files-only line count `>=` a clamped,
  always-on floor.
