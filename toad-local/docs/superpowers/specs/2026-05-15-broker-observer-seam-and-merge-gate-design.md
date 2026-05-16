# Broker Observer Seam + Constitution Merge Gate — Design

> Status: approved through brainstorming (4 sections, ruled
> incrementally). Realizes PROJECT.md §8b's observe/gate model.
> Supersedes the §8b "block the message" framing → "block the merge".

## 0. Summary

Two independent implementation slices that together give Symphony's
drift system its first capability that *genuinely stops bad code from
landing* — without ever wolf-crying:

- **Slice 1 — Constitution merge gate (the enforcement).** A fourth
  synchronous gate in the existing `localToolFacade.#taskUpdate`
  `merge_ready → done` chain, immediately before
  `mergeIntegrator.integrate()`. Blocks a merge **iff this branch
  introduces** a `mode:'gate'` constitution violation (diffed against
  trunk). Preexisting trunk violations never block.
- **Slice 2 — Broker observer seam (the observation).** `subscribe(fn)`
  on `SqliteBroker` + `InMemoryBroker`, mirroring
  `SqliteTaskBoard.subscribe`, fired after a successful
  `appendMessage`. Ships the *seam only* — no consumer.

The slices have **no code dependency** on each other. Recommended
order: Slice 1 first (higher-value, fully independent), then Slice 2.

## 1. Why the merge boundary (the ruling)

The observe/gate distinction separates "useful to know about" from
"must not happen." In a code-vs-spec system, "must not happen" has a
specific moment when it actually matters: when violating code stops
being a worktree experiment and becomes trunk reality. **That is the
merge boundary.** Before merge a violation is a finding to address;
after merge it is a production problem. Gating at the merge boundary
aligns the technical mechanism with the semantic meaning, and resolves
the wolf-cry risk completely: the worker can carry a violation in
their worktree all day (observer-mode findings fire, the lead sees
them, the worker fixes in their own time); the gate fires only when
someone tries to *land* the change, where blocking is the correct
response, not a false alarm.

This rejects the literal §8b "block the message" reading: L1.3
constitution rules are **whole-tree source scans (standing
invariants)**, not message-content matchers. Blocking the lead's
message because the *current source* trips a standing rule the message
never touched would be pure wolf-cry.

## 2. Three-tier enforcement model

A cleaner severity model than info/warn/critical, tied to *when and to
whom* a finding matters:

| Tier | Trigger | Audience | Blocks? |
|---|---|---|---|
| **info** | unreviewed spec, low confidence (ruling #4 clamp) | logged for human review, **not sent to lead** | no |
| **observer** | real drift, reviewed spec | lead notified via broker, shapes coordination | no |
| **gate** | `mode:'gate'` constitution rule, reviewed spec, **violation introduced by this merge** | the merge initiator (lead / automation) | **yes — at merge boundary only** |

The two-key safety property: a merge is blocked **only if** the rule
has been promoted to `mode:'gate'` **and** the spec has been formally
ratified (`spec.provenance.reviewed === true`). Hard to trip by
accident — the property you want for anything that can stop the team.

## 3. Architecture: where each tier lives

```
message_send ─► broker.appendMessage ─► [Slice 2 subscribe hook] ─► (future observe-mode message-drift consumer; DEFERRED)
                                          │
                                          └─ findings only, never blocks

task_update(merge_ready → done) in localToolFacade.#taskUpdate:
   1. mergeChecker conflict gate        ─ throw "blocked by merge conflict"
   2. human-approval gate (§14)         ─ throw "blocked by human-approval gate"
   3. ┌─────────────────────────────────────────────────────────────┐
      │ Slice 1: constitution merge gate (NEW)                       │
      │   throw "blocked by constitution gate: …" if introduced      │
      └─────────────────────────────────────────────────────────────┘
   4. mergeIntegrator.integrate()       ─ the actual non-destructive merge
```

Standing whole-tree drift runs (the existing periodic/event drift
engine) are unchanged and remain the defense-in-depth backstop.

## 4. Slice 1 — Constitution merge gate

### 4.1 Placement

A new gate clause in `localToolFacade.#taskUpdate`, inside the
existing `fromStatus === 'merge_ready' && args.status === 'done'`
block, ordered **after** the conflict gate + human-approval gate and
**immediately before** `this.mergeIntegrator.integrate()`. Firing
guard identical to the conflict gate: worktree `status === 'created'`,
has `branch` + `baseRef`/`baseBranch`. If the spec declares **no**
`mode:'gate'` constitution rules the gate is a fast no-op (zero
overhead for projects that don't use gating).

### 4.2 Testable unit

The gate logic is a standalone unit, not buried inline:

```
constitutionMergeGate({
  projectCwd, worktreePath, baseRef, spec,
  runGit,                               // injected, like the rest of drift
  evalConstitutionRuleImpl,             // injected; defaults to the shared helper
}) → { blocked: boolean,
       introduced: Finding[],            // gate-eligible (block)
       preexisting: Finding[],           // observer-mode (do not block)
       scanError: { command, file, message } | null }
```

**One detector implementation, two consumers (no divergence).** The
gate does *not* call `scanConstitution` (a whole-tree walker) — it
needs to evaluate a single rule against a *specific file's content*
(the worktree blob, then the `git show <baseRef>` blob). scan
Constitution's per-content detector evaluation (the grep-regex /
`path_presence` logic, including its comment-stripping) is extracted
into a shared pure helper — `evalConstitutionRule(rule, { path,
content })` → `hit | null` — that **both** `scanConstitution` (the
whole-tree standing scan) and `constitutionMergeGate` (this gate)
call. One source of truth for "does this content violate rule R";
the two paths can never diverge. This extraction is part of Slice 1.

`#taskUpdate` calls it and `throw`s iff `blocked`. Keeps `#taskUpdate`
thin and the gate fully unit-testable with injected `runGit`/fs — the
exact injection pattern `scanConstitution` / `mergeIntegrator` /
`diffComputer` already establish (one testing approach across drift
components).

### 4.3 Introduced-vs-preexisting mechanism (no checkout)

Consistent with the non-destructive integrator — git plumbing only,
never mutates working state:

1. `diffComputer.computeDiff({ worktreePath, baseRef })` → `files[]`
   this branch changes vs trunk, **plus per-file change type**. Scope
   is *only these files* — a violation in an untouched file cannot
   gate.
2. For each `mode:'gate'` rule × each changed **text** file:
   - **Added file** (no trunk version, per computeDiff change type):
     skip the trunk-side scan entirely; any hit is *by definition
     introduced* → gate. This is a **correctness** requirement, not an
     optimization: without it the "`git show` errored" path could
     mis-route an introduced violation into fail-open observer mode.
   - **Modified file:** run the rule detector on the **worktree**
     version (already on disk at `worktreePath`). On a hit, fetch the
     **trunk** version via `git show <baseRef>:<file>` and run the
     same detector on it:
     - hit in worktree **and** trunk → **preexisting** → observer-mode
       finding, **does not block** (needs its own remediation task).
     - hit in worktree **only** → **introduced by this merge** →
       **gate → block**.
3. **Binary skip — one shared `isTextFile` helper (no asymmetry).**
   Binary detection is extracted into a shared pure helper
   `isTextFile(path, { content?, runGit?, projectCwd? })` → boolean,
   the same one-source-of-truth extraction pattern as
   `evalConstitutionRule` (§4.2). It combines the stricter signals
   (`git check-attr binary` + an extension/MIME binary set) and
   subsumes scanConstitution's existing ad-hoc `TEXT_EXT` regex —
   **both** the whole-tree scanner and the gate route binary
   decisions through `isTextFile`, so the stricter check is used
   everywhere and the two paths cannot drift. (The earlier draft made
   the gate deliberately stricter than scanConstitution; consolidation
   is preferred over a defended asymmetry — the stricter check is the
   one you want in both places.) Prevents a rule like "no API keys in
   source" spuriously matching a base64 chunk inside a PNG.

### 4.4 Reviewed-spec clamp

Per ruling #4 + the three-tier model: the gate engages **only** when
`spec.provenance.reviewed === true` **and** `rule.mode === 'gate'`. An
unreviewed spec → info tier → never blocks. The unit re-reads
`spec.provenance.reviewed` every call (no stale cache): a flag flip
mid-session is respected on the next call.

### 4.5 The rejection

Mirror the existing three gates exactly — `throw new Error(...)` with
the same `task_update: merge_ready → done blocked by …` shape that
propagates straight back to the initiator (lead/automation) as the
task_update failure. Lists **every** introduced violation (not
whack-a-mole). Human string form:

```
task_update: merge_ready → done blocked by constitution gate:
  [constitution.<id>] <file>:<line> — <description>
  …(one line per introduced violation)…
Address these and retry the merge. See docs/foundry/spec.json
constitution rule "<id>".
```

**Structured payload alongside the string (baked into v1 — it is
cheap).** The thrown Error carries a structured field:

```
err.constitutionGate = [
  { ruleId, file, line, specRef, description }, …
]
```

so the lead acts on fields, not parsed English. One line is added to
the lead system prompt naming the constitution gate (the lead prompt
already honors `merge_ready → done blocked by…`).

### 4.6 Fail-open on scan error

If the gate scan itself errors (scanner throws, `git show`/diff
fails unexpectedly on a *modified* file): **fail open** — do **not**
block — and record a **loud high-severity observer finding** whose
payload includes the **actual error detail** (the failed command, the
file being scanned, the message/stack).

Rationale, stated explicitly so the same call is made for future
gates: *gates exist to prevent specific known violations from landing,
not to prevent unknown states from landing.* A scanner error means the
scanner cannot tell whether a violation exists. Fail-closed treats "I
don't know" as "yes there is one" — a false-positive failure mode, and
false positives in a gate are the worst kind because they block real
work for everyone. Second-order: gates that fail-closed on infra
errors get disabled by frustrated teams during a release crunch and
never re-enabled, leaving the invariant unprotected indefinitely.
Fail-open keeps the gate trusted and on; the loud finding makes the
scanner bug visible; the standing whole-tree drift run is the
defense-in-depth backstop. (Note added files are classified before any
`git show`, §4.3 — so an added-file violation is never silently
fail-opened.)

### 4.7 Honest modeling limitation

We scan `worktreePath` (the branch's working tree) as the
"would-be-merged" proxy, **not** the literal 3-way merge tree. These
differ only if trunk independently introduced a violation in a file
the branch also touched — which the `git show <baseRef>` step already
classifies as **preexisting → observer, not gate**. So for the
question that matters ("did *this branch* introduce a forbidden
pattern?") the proxy is sound.

The one remaining divergence — two branches both *add* a new file at
the same path with different content — is surfaced by the **upstream
conflict gate (step 1 of the chain)** as a merge conflict and never
reaches the constitution gate. Documented here so the next reader's
"wait, what about two-sided adds?" is answered by the design, not
left to reverse-engineering.

## 5. Slice 2 — Broker observer seam

A pure mechanical mirror of the proven `SqliteTaskBoard.subscribe`
pattern, applied to **both** `SqliteBroker` and `InMemoryBroker` (kept
symmetric so the in-memory test path validates the real contract, not
a degenerate one):

- private `#subscribers = new Set()`; `subscribe(fn)` validates `fn`
  is a function, adds it, returns an unsubscribe closure.
- `#fireSubscribers(message)` invoked **after** a successful insert in
  `appendMessage`, passing the message envelope. Subscriber
  exceptions are caught + `console.warn`'d so a bad subscriber can
  never break the broker write path (identical contract to the task
  board).
- **Not** fired on the idempotent-dedup return (`{ inserted: false }`)
  — exactly mirroring the task board's "no fire on dedup hit." Only
  genuinely-new messages notify. (Phantom notifications that look
  identical to real ones but represent no state change are an
  hours-to-debug class of bug; the contract forbids them.)

**Durability contract (explicit — in a broker code comment *and*
here).** `#fireSubscribers` fires **synchronously after the INSERT
statement returns**; the message is queryable via the broker on the
same connection (a subscriber may `broker.getMessage(id)` from within
its handler and get a non-null result). **No stronger cross-process
disk-durability guarantee is made.** Explicit beats implicit for a
contract surface future consumers depend on.

Scope: ships **only the seam**. No subscriber is wired — no check
inspects message text today; the observe-mode message-drift *consumer*
is a separate future brainstorm. Shipping the seam now (proven
pattern, isolated, fully testable) makes that future consumer slice
zero-change to the broker — the same forward-compatible discipline as
carrying `constitutionMode` before the gate existed. **Pattern adopted
deliberately:** land the architectural primitive while it is small and
uncontroversial; defer the policy question until there is real signal
to design against.

## 6. Testing (TDD, RED→GREEN)

**Slice 1 — `constitutionMergeGate` unit** (injected `runGit` + fs,
mirroring `scanConstitution.test.js` vfs + `mergeIntegrator.test.js`
runGit stub):

- introduced violation (worktree-only hit) → `blocked`, listed
- preexisting violation (hit in worktree **and** `git show baseRef`) →
  not blocked, returned in `preexisting[]`
- added file with a violation → blocked (introduced), **no trunk scan
  attempted**
- changed file but violation outside `files[]` → ignored
- binary file with an apparent hit → skipped
- unreviewed spec → never blocks (info tier)
- `spec.provenance.reviewed` flips mid-session → next call respects
  the new value (re-read, not cached)
- no `mode:'gate'` rules → fast no-op
- scan / `git show` error on a modified file → fail-open, not blocked,
  loud observer finding **carrying the error detail**
- multiple introduced violations → all in the string **and** the
  structured `constitutionGate` payload

**Slice 1 — integration at the seam:** `merge_ready → done` with an
introduced violation → `task_update` throws `blocked by constitution
gate`, `integrate()` **never called**, no `INTEGRATION_MERGED` event;
only-preexisting → merges normally.

**Slice 2 — observer seam** (same assertions run against `SqliteBroker`
*and* `InMemoryBroker`):

- `subscribe` returns an unsubscribe; unsubscribe stops delivery
- exactly one fire per new `appendMessage`, passing the envelope
- **no** fire on idempotent dedup (same idempotencyKey twice → one
  fire)
- subscriber throw is caught; the message is still inserted + returned
- **durability lock:** a subscriber that calls `broker.getMessage(id)`
  from within its handler asserts non-null (contract in code, not just
  comments)

## 7. Doctrine + documentation updates

- **PROJECT.md §8b:** "block the message" → "block the merge". Rewrite
  the observe/gate descriptions to the final model (observe =
  post-`appendMessage` subscribe hook, findings, no block; gate =
  merge-boundary, diff-scoped to introduced-only, reviewed-spec-only,
  fail-open on scan error). Remove the now-stale "SqliteBroker has no
  observer seam … prerequisite" note. Add the explicit three-tier
  model (§2).
- **Lead system prompt:** one line naming the constitution gate so a
  `blocked by constitution gate` rejection is routed correctly.
- **Stale-reference sweep:** grep `docs/` for `block the message`,
  `constitution gate`, `observer mode` and fix anything the §8b
  rewrite doesn't already cover (5-minute task; prevents future
  human/agent confusion).

## 8. Non-goals (named so they do not creep)

- **No message-delivery gating** (Option 1 chosen — gate is the merge
  boundary, never `#messageSend`).
- **No observe-mode message-drift consumer.** Slice 2 ships the seam
  only; what subscribes to it is a separate future design.
- **No retroactive sweep of preexisting violations as gate findings on
  spec ratification.** Gate fires only at the merge boundary; a
  `reviewed` flag flip does not trigger a merge and must never trigger
  a retroactive trunk sweep — that would be a wolf-cry generator of
  the highest order. Preexisting violations are observer-mode findings
  with their own remediation path, full stop.
- **L3 reform / L2 embeddings:** unchanged by this design.

## 8a. Implementation-time verification (carried into the plan)

Three items the implementation plan MUST verify against the real code
before the dependent task is written (flagged in spec review; not
design changes, but they gate correctness):

1. **`computeDiff` change type.** §4.3 step 1 assumes `computeDiff`
   returns per-file change type (added vs modified) — the added-file
   "skip trunk scan, any hit is introduced" correctness path depends
   on it. Exploration confirmed `files[]`; change type is **not**
   confirmed. The plan's first gate task verifies `computeDiff`'s
   return shape and, if change type is absent, extends `computeDiff`
   (or has `constitutionMergeGate` issue `git diff --name-status
   <baseRef>..HEAD` itself) before any added-file logic is written.
2. **Broker read method name.** §6's durability-lock test calls
   `broker.getMessage(id)` from within a subscriber. Confirmed:
   `SqliteBroker.getMessage(messageId)` exists (src/broker/
   sqliteBroker.js) and `InMemoryBroker` must expose the same. The
   plan still re-verifies both signatures before writing the test so
   it is correct first time.
3. **Per-file hit matching semantics.** The gate emits **all** hits
   per file (better operator messages: "forbidden pattern at lines
   12, 47, 89"), not first-hit. Preexisting classification is
   therefore *per-hit*: a worktree hit is preexisting iff the trunk
   blob has a matching hit, matched by **normalized line content**
   (not line number — line numbers shift when the branch adds code
   above). The plan specifies this matching explicitly in the gate
   unit's design and tests it directly (worktree adds an unrelated
   line above a preexisting violation → still classified preexisting,
   not introduced).

## 9. Slice ordering & independence

Slice 1 depends only on `diffComputer` + `scanConstitution` + the
existing `#taskUpdate` gate-chain + injected `runGit`. Slice 2 depends
only on the broker write path. Neither imports the other. Ship Slice 1
first (the higher-value "must not happen" capability, fully
independent and dogfoodable on real Reaper once a `mode:'gate'` rule
is seeded), then Slice 2. Each is its own TDD'd commit, dogfooded
before landing — the same discipline as L1.1–L1.4b.
