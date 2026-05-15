# spec.yaml — Machine-Checkable Project Contract (Schema Design)

> **Status:** DRAFT for review. No code depends on this yet. Reviewer
> should push back on shape before any Foundry / L1-check code is
> written. This is the Day Zero artifact gating all L1 drift work.

**Date:** 2026-05-15
**Author:** Symphony drift-architecture workstream
**Consumers:** the four staged Layer-1 drift checks + the reformed
Layer-3 LLM judge
**Producer:** Foundry (on materialize, going forward) + a one-shot
extraction tool (for existing prose-only projects)

---

## 1. Purpose

The seven Foundry docs are **prose for humans and LLMs**. They stay.
`spec.yaml` is a *parallel, narrow, machine-checkable projection* of
the assertions in those docs that a deterministic check can evaluate
in milliseconds without an LLM.

It is NOT a replacement for the prose docs. It is the answer to "what
in the spec can a `grep`/AST/parse check verify cheaply, and what does
that check need to read?"

### Non-goals

- Not a full IDL/OpenAPI replacement. Contract drift (L1.4) borrows
  JSON-Schema *fragments* but spec.yaml is not itself an API spec.
- Not hand-authored by operators in the common case. Foundry emits it;
  operators may hand-edit to correct extraction misses.
- Not versioned per-task. One `spec.yaml` per project, updated when
  the foundry docs are re-materialized or an ADR lands.

---

## 2. Hard constraint: language-agnostic

The reviewer's earlier framing assumed Node (`package.json`). The
actual project in the user's workspace (`Reaper`) is **Rust** —
`Cargo.toml`, `cargo clippy`, `eframe`/`egui`/`windows` crates,
`x86_64-pc-windows-msvc`. Symphony builds *any* kind of app a vibe
coder describes. The schema MUST NOT bake in a Node assumption.

Resolution: a top-level `stack` block names the language/ecosystem.
Each L1 check uses `stack` to decide *how* to resolve the same
logical question:

| Logical check | Node | Rust | Python |
|---|---|---|---|
| dependency manifest | `package.json` deps | `Cargo.toml` `[dependencies]` | `pyproject.toml` / `requirements.txt` |
| crate/module root | `src/index.ts` | `src/main.rs` / `lib.rs` | package `__init__.py` |
| build/lint cmd | `npm run lint` | `cargo clippy` | `ruff` |

`spec.yaml` declares the *intent* ("only these deps authorized"); the
check resolves the *mechanism* per `stack.manifest`.

---

## 3. The schema (annotated)

```yaml
# spec.yaml — version 1
version: 1

# ── stack ───────────────────────────────────────────────────────────
# Drives HOW every L1 check resolves language-specific mechanisms.
# Extracted from tech-spec.md "Architecture" + "External Dependencies"
# + "Toolchain" sections.
stack:
  language: rust                 # rust | typescript | python | go | …
  manifest: Cargo.toml           # the dependency manifest filename
  module_root: src/main.rs       # entrypoint the structural check anchors on
  # Free-form tags the LLM judge (L3) can read for context; not
  # machine-enforced. Keeps "React + TypeScript" style intent legible.
  declared_stack:
    - "Rust stable >= 1.78"
    - "egui/eframe immediate-mode GUI"
    - "windows crate (Win32 bindings)"
    - "single-binary, no installer, no network"

# ── dependencies ────────────────────────────────────────────────────
# Consumed by L1.1 check_dependency_drift.
# `authorized` = the only top-level deps the spec sanctions.
# `forbidden` = explicit anti-deps (e.g. "no network in Phase 1").
# Anything in the manifest NOT in authorized AND NOT a transitive
# dep → drift finding. Anything matching forbidden → hard finding.
# Extracted from tech-spec.md "External Dependencies" + steering.md
# "Never Do" (network/telemetry bans).
dependencies:
  authorized:
    - eframe          # >=0.27
    - egui_extras
    - windows         # >=0.56
    - serde
    - toml
    - directories
    - parking_lot
    - log
    - env_logger
  forbidden:
    # steering.md: "Never add a network dependency, telemetry beacon,
    # or update-fetch in Phase 1."
    - reqwest
    - hyper
    - tokio            # ADR-002 explicitly rejected an async runtime
    - ureq
    - sentry

# ── structure ───────────────────────────────────────────────────────
# Consumed by L1.2 check_endpoint_drift (here generalized to
# "structural surface" — modules for a desktop app, endpoints for a
# web app). Extracted from tech-spec.md "Component Design".
# A required module that does not exist in source → drift.
structure:
  # `kind` tells the check how to verify presence:
  #   module  → a source module/path must exist
  #   endpoint→ an HTTP route must be registered (web apps)
  kind: module
  required:
    - name: "win::procs"
      evidence: "src/win/procs.rs or src/win/mod.rs exposing procs"
    - name: "sampler"
      evidence: "src/sampler.rs"
    - name: "heuristics"
      evidence: "src/heuristics.rs"
    - name: "safety"
      evidence: "src/safety.rs"
    - name: "killer"
      evidence: "src/killer.rs"
    - name: "settings"
      evidence: "src/settings.rs"
    - name: "ui"
      evidence: "src/ui.rs or src/ui/mod.rs"
  # For web projects this section instead looks like:
  #   kind: endpoint
  #   required:
  #     - { method: POST, path: /api/auth/login }
  #     - { method: GET,  path: /api/health }

# ── contracts ───────────────────────────────────────────────────────
# Consumed by L1.4 check_contract_drift (last L1 stage).
# Inter-component or API contracts. JSON-Schema fragments for web
# request/response; signature strings for internal calls.
# Extracted from tech-spec.md "API / Tool Surface" table + "Data Model".
contracts:
  - id: killer.kill
    caller: ui
    callee: killer
    signature: "fn kill(pids: &[u32]) -> KillReport"
  - id: safety.is_protected
    caller: "ui, killer"
    callee: safety
    signature: "fn is_protected(row: &ProcessRow) -> Option<ProtectedReason>"
  - id: heuristics.score
    caller: ui
    callee: heuristics
    signature: "fn score(row: &ProcessRow, cfg: &HeuristicConfig) -> Staleness"
  # Web example:
  # - id: auth.login
  #   request_schema: { type: object, required: [email, password], … }
  #   response_schema: { type: object, required: [token], … }

# ── constitution ────────────────────────────────────────────────────
# Consumed by L1.3 check_constitution (generalizes the existing
# check_provider_logic_leakage prototype). Each rule is a
# grep/AST-checkable assertion with a mode (see §5).
# Extracted from steering.md "Never Do" + "Coding Standards".
constitution:
  rules:
    - id: no-sedebug-privilege
      description: "Never request SeDebugPrivilege or auto-elevate"
      detector:
        type: grep
        pattern: 'SeDebugPrivilege|requestedExecutionLevel\s*=\s*"requireAdministrator"'
      severity: critical
      mode: gate            # block the message/commit that introduces it
      source: "steering.md › Never Do"
    - id: no-silent-win32-discard
      description: "Never `let _ = …;` a Win32 result"
      detector:
        type: grep
        pattern: 'let\s+_\s*=\s*[A-Za-z_]+::(Open|Terminate|Enum|GetProcess)'
      severity: high
      mode: observe
      source: "steering.md › Never Do"
    - id: no-anyhow-outside-main
      description: "anyhow::Error only in main.rs / integration tests"
      detector:
        type: grep
        pattern: 'anyhow::Error'
        exclude_paths: ['src/main.rs', 'tests/**']
      severity: medium
      mode: observe
      source: "steering.md › Coding Standards"
    - id: win32-gated-through-win-procs
      description: "UI/sampler/killer never call the windows crate directly"
      detector:
        type: grep
        pattern: '^\s*use\s+windows::'
        exclude_paths: ['src/win/**']
      severity: high
      mode: observe
      source: "steering.md › Architecture Constraints"
    - id: no-binary-artifacts-committed
      description: "Never commit target/ or *.exe or settings files"
      detector:
        type: path_presence
        forbidden_paths: ['target/**', '**/*.exe', '**/settings.toml']
      severity: high
      mode: observe
      source: "steering.md › Never Do"

# ── adrs ────────────────────────────────────────────────────────────
# NOT machine-enforced by L1 — too semantic. This block is the
# scoped context the reformed L3 judge reads when L1/L2 flags
# something near an ADR's domain. Extracted from design-decisions.md
# headings + Decision lines only (not full prose — the judge fetches
# full prose on demand).
adrs:
  - id: ADR-001
    title: "Native Rust + egui over Tauri/Electron/C#"
    decision: "single-binary native Rust, eframe/egui, windows crate"
  - id: ADR-002
    title: "Sampler thread + immutable snapshot frames"
    decision: "dedicated sampler thread, mpsc channel, no shared mutable state, no async runtime"
  - id: ADR-004
    title: "Manifest as asInvoker, no auto-elevation"
    decision: "requestedExecutionLevel=asInvoker; never SeDebugPrivilege"
  - id: ADR-005
    title: "Hard-coded protected allowlist, user-immutable in v1"
    decision: "baked-in image-name allowlist; users may add (Phase 2), never remove"

# ── provenance ──────────────────────────────────────────────────────
# Audit trail: which doc + section each block was extracted from, and
# whether a human reviewed the extraction. The extraction tool sets
# reviewed:false; an operator flips it after eyeballing.
provenance:
  extracted_at: "2026-05-15T00:00:00Z"
  extracted_by: "foundry_extract_spec@v1"
  source_docs:
    - docs/foundry/tech-spec.md
    - docs/foundry/steering.md
    - docs/foundry/design-decisions.md
    - docs/foundry/product-brief.md
  reviewed: false
```

---

## 4. Per-section → consumer mapping

This is the load-bearing table. Each L1 check reads exactly one or two
sections; the schema shape is dictated by what makes the check's
read-path trivial.

| spec.yaml section | Consumer | Read path | Ships in |
|---|---|---|---|
| `stack` | all L1 checks | resolve manifest/module filenames per language | Day Zero |
| `dependencies.authorized` / `.forbidden` | `check_dependency_drift` | parse `stack.manifest`, diff dep names | **L1.1** |
| `structure.required` | `check_structural_drift` | glob/AST for each `evidence` path; web: route enumeration | **L1.2** |
| `constitution.rules[]` | `check_constitution` | run each `detector` (grep/path) across diff | **L1.3** |
| `contracts[]` | `check_contract_drift` | match signature/schema against handler/fn | **L1.4** |
| `adrs[]` + `provenance` | reformed L3 judge | scoped context payload when L1/L2 flags near an ADR domain | L3 reform |

Design consequence: each check is a small focused file that does
`const spec = loadSpec(projectCwd); for (const x of spec.<section>) …`.
No check needs the whole spec; no check needs an LLM.

---

## 5. gate vs observe (per the reviewer's insight)

Each `constitution.rule` carries a `mode`:

- **`observe`** (default) — check runs *after* the message/commit; a
  violation produces a drift finding but doesn't block. Fast, no
  latency added to agent throughput. Right for ~90% of rules.
- **`gate`** — check runs at the broker's
  `appendMessage → deliverMessage` seam *before* delivery; a
  violation blocks the message and returns a rejection the lead's
  system prompt is told to respect. Reserved for `severity: critical`
  hard-rules ("never write secrets to logs", "never SeDebugPrivilege",
  "never call forbidden API").

`mode` is declared in `spec.yaml` (legible, per-rule) AND surfaced in
the check registry (`src/drift/checks/index.js`) as the enforcement
policy. Only the constitution check supports `gate` in v1 — structural
/ dependency / contract drift are inherently post-hoc (they need a
written diff to evaluate) so they're always `observe`.

**Prerequisite this exposes:** the broker has no observer seam today.
`SqliteTaskBoard` has `subscribe(fn)` (line 25); `SqliteBroker.appendMessage`
(line 14) just writes. The gate path requires adding a pre-delivery
hook at the `appendMessage → DeliveryWorker.deliverMessage` boundary
(`src/broker/sqliteBroker.js` + `src/delivery/deliveryWorker.js`).
That's its own small slice, listed separately in the todo — not a
free property.

---

## 6. Producer integration

### 6a. Foundry generates spec.yaml on materialize (going forward)

The materialize artifact list lives at `localToolFacade.js:3731` —
an array of `{ kind, title, content, targetPath }` parsed from the
Foundry chat's `===DOC: xxx===` blocks. spec.yaml slots in as a new
entry:

```js
const specYamlContent = parsed.get('spec_yaml') ?? parsed.get('spec');
if (specYamlContent) {
  out.push({
    kind: 'spec_yaml',
    title: 'Machine-checkable spec',
    content: specYamlContent,
    targetPath: 'docs/foundry/spec.yaml',
  });
}
```

The Foundry planner prompt gets a new instruction: after drafting the
prose docs, emit a `===DOC: spec_yaml===` block following this schema.
The planner already has the full design in context — structured
emission alongside prose is cheap.

### 6b. Extraction tool for existing prose-only projects

Existing projects (like the user's `Reaper`) have no spec.yaml. A new
facade command `foundry_extract_spec`:

1. Reads the existing `docs/foundry/*.md`
2. LLM-assisted single pass (Claude Code itself, or the team's
   provider) extracts assertions into spec.yaml per this schema
3. Writes `docs/foundry/spec.yaml` with `provenance.reviewed: false`
4. Operator eyeballs, corrects misses, flips `reviewed: true`

This is a one-shot bootstrap, not a per-run cost. It is **not** the
same as the old check_llm_semantic (which re-did extraction every 60s
against the whole prose corpus). Extraction happens once; L1 then runs
deterministically against the YAML forever.

---

## 7. Open questions for the reviewer

1. **`structure.kind` discriminator** — modeled as `module` (desktop)
   vs `endpoint` (web). Is a single discriminator enough, or do we
   need per-entry kinds (a project with both a CLI module surface AND
   HTTP endpoints)? Leaning: per-entry `kind` on each `required[]`
   item instead of section-level. Want a ruling before I bake it in.
2. **`contracts` for non-web** — Rust internal call signatures as
   opaque strings (`fn kill(pids: &[u32]) -> KillReport`). L1.4 can
   only string-match these unless we AST-parse the language. Is
   string-presence ("a fn named `kill` with arity matching exists")
   sufficient for v1, deferring true signature typechecking? Leaning:
   yes — presence + arity in v1, full typecheck never (that's the
   compiler's job, not drift's).
3. **`forbidden` deps precision** — banning `tokio` by name is brittle
   (a sanctioned dep might pull it transitively; ADR-002 only bans it
   as a *direct* architectural choice). Should `forbidden` mean
   "direct dependency only" and ignore transitive? Leaning: yes,
   direct-only — transitive bans are unenforceable without a full
   resolve and produce false positives.
4. **Provenance review gate** — should L1 checks *refuse to run*
   against a spec.yaml with `reviewed: false`, or run but down-weight
   findings to `info` severity until reviewed? Leaning: run at
   `info` until reviewed, so operators get signal immediately but
   aren't blocked on the curation step.
5. **Schema location** — `docs/foundry/spec.yaml` keeps it beside the
   prose it projects. Alternative: `.toad/spec.yaml` (alongside the
   DB, out of the agent's normal view). Leaning: `docs/foundry/` —
   the spec is project documentation, agents *should* be able to read
   it (it tells them what they're allowed to do).

---

## 8. What this unblocks

Once the schema is approved:

- **L1.1 (`check_dependency_drift`)** becomes a ~40-line file: load
  spec, parse `stack.manifest`, diff `dependencies`. First real
  code-vs-spec drift Symphony has ever shipped.
- Foundry materialize gets the spec_yaml emission block (~10 lines).
- `foundry_extract_spec` bootstraps the user's existing Reaper project
  so we can dogfood L1.1 against real divergence immediately.

Each subsequent L1 stage is additive and reads its own section. No
big-bang subsystem.
