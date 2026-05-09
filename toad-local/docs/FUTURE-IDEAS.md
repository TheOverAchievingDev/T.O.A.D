# Symphony AI — Future ideas

A short, opinionated list of directions Symphony might grow into. Not a roadmap, not a commitment — a place to capture ideas before they're lost, with enough rationale that someone picking it up later (you, me, a future contributor) understands the why.

## Power-user mode: "AI builds it WITH me" vs "AI builds it FOR me"

Symphony's default is **AI builds it FOR me**: the operator describes the project, agents plan and build, the operator watches and ships. The Cockpit, Foundry, drift monitor, plugins — all of these serve that flow. The user audience is the non-developer with ideas and tech-adjacent skills who's been priced out of professional software development.

But there's a second persona who'd benefit from Symphony with a different UI emphasis: **AI builds it WITH me** — the operator who codes alongside agents, runs validations manually, intervenes more directly in the work. They want pair-programming-with-a-team-of-agents, not delegation.

The two personas need different surfaces:

| Surface | "Build it FOR me" (default) | "Build it WITH me" (power mode) |
|---|---|---|
| Default landing | Cockpit (passive observation) | Code editor + active agents in sidebar |
| Validations | Run by agents, surfaced in Inspector | Inline test/lint/typecheck/build runner with kind selector + history |
| Diffs | Auto-applied; revert per task in Review | Per-hunk keep/revert in IDE editor pane |
| Terminal | Hidden | First-class panel with kind dropdown + chip history + output |
| Risk gates | Approval modal blocks the work | Operator can override gates with explicit attestation |
| Drift findings | Operator clicks "Create correction task" | Operator can edit findings, dismiss, mark won't-fix |
| Foundry | Chat-driven discovery | Direct doc editing in editor pane |
| Cost telemetry | Single "estimated cost" up front | Per-call live cost tracking |

Implementation hint: a single Settings → "Developer mode" toggle that:
- Sets a `tweaks.developerMode: boolean` in settings.json
- Flips Cockpit's center-tab default from `flow` → `code`
- Reveals additional surfaces (terminal panel, hunk-level diff controls, raw event log viewer, cost-per-call breakdown)
- Enables a different shortcut palette (Cmd+T runs tests, Cmd+R runs current task review, etc.)

The dev-mode UI is additive, not a separate fork. Same backend, same data; just different defaults and more surfaced controls. The "FOR me" mode keeps things hidden so the bouncer-givers-up audience doesn't bounce again.

## Specific features deferred to power-user mode

### Inline terminal / test runner
**What it would do:** A bottom-of-Cockpit panel with a validation kind selector (`test`, `lint`, `typecheck`, `build`, `security`, `install`), a Run button, recent-run chips, and a live output pre tag. One-click manual validation runs against the selected task's worktree.

**Why it was removed from default:** vibe-coder audience won't manually run validations — agents already call `validation_run` automatically, and the result surfaces in the Cockpit Review pane and the right-side Inspector. The bar added a trigger affordance for power users, not new information for everyone.

**Where the code lived:** The full implementation (`<section className="cockpit-bottom">` JSX block, `cockpit-bottom*`/`cockpit-terminal*`/`cockpit-validation-bar`/`cockpit-validation-history`/`cockpit-terminal-output` CSS classes, `runSelectedTaskValidation` with kind-selector state) was removed in commit (TBD). Bring it back behind the developer-mode toggle when power-mode lands. The relevant CSS+JSX is recoverable from git history at the parent commit `e885afe`.

### Hunk-level diff keep/revert
North-star Phase 4. Default users get a per-task accept/revert in Review; power users get per-hunk control inside the IDE editor pane.

### Raw event log viewer
The SQLite event log is the truth source. Default users see it summarized through Cockpit + Audit. Power users want a filterable table view with JSON inspection.

### Cost per call
Default mode shows aggregate Foundry/team cost estimates. Power mode shows real-time per-call token + dollar tracking, exposing which agent / which check is burning the most budget.

## Other future directions

### Maintenance mode
The vibe-coder ships v1, then six months later wants to fix a bug. Today: opening Symphony on the existing project re-runs Foundry-style discovery, which is wrong for "fix this bug." Maintenance mode is a distinct flow:
- "Reopen project" — finds existing `.toad/` folder, reattaches the team without re-Foundrying
- "Fix bug" task type — bypasses planning gates, agents go straight to investigation + fix
- Diff-against-current-state drift — not against the original spec

### Foundry slice F.1: CLI-mediated planning
Foundry currently uses LLM API for doc generation. The rest of Symphony uses CLI subscriptions (Claude Pro, Codex, Gemini Pro) — Foundry is the only piece that violates the "your subscription, not API" promise. Migrate to spawn `claude` as a persistent subprocess (matching how `RuntimeSupervisor.js` already runs runtime-tier agents) — NOT one-shot per turn. Closes the cost-story hole.

### Foundry slice F.2: provider-aware Foundry
After F.1 ships Claude-only, evaluate adding Codex/Gemini support to Foundry. Each CLI's flags differ (Claude `-p` + stream-json; Codex `--output-format json`; Gemini `--prompt-file`); needs the per-provider abstraction the drift LLM judge already pioneered. Operator picks per-session or per-project which provider to plan with. Lands once usage data shows which providers vibe coders actually use for planning.

### Foundry slice F.3+: planning-quality enhancements
Patterns worth borrowing from external planning tools (`/deep-plan`, spec-kit, planning-with-files) but built as Symphony-native tools/skills, not third-party plugin adoptions:

1. **Cross-LLM critique loop** (from `/deep-plan` by Pierce Lamb): post-doc-generation, send the 7 docs to a different provider for "find what we missed" review. Mirrors drift slice 2's Opus-tier escalation pattern. Blocks on F.2's multi-provider work. Triples LLM cost per refinement; only worth shipping if real Foundry-quality data justifies.

2. **AskUserQuestion-style structured interviews** (from `/deep-plan`): instead of free-text "any other questions?", a Symphony MCP tool the planning agent calls to capture explicit Q+A pairs. Trackable across turns, surfaces which decisions are still open. Better Foundry hygiene than free-text exchange.

3. **Phase artifact pipeline formalization** (from GitHub spec-kit): make the brief.md → tech_spec.md → roadmap.md → tasks.md dependency explicit instead of implicit. Each phase reads prior phase's artifact as input rather than relying on conversation context. Tightens output quality and reduces "the model forgot what we agreed in turn 2" failures.

4. **Hook-based plan re-reading** (from planning-with-files by OthmanAdi): when an agent in the runtime tier is mid-task, hook makes them re-read tasks.md and steering.md before tool calls. Catches drift early before code ships. **Belongs in runtime tier, NOT Foundry** — different slice entirely. Probably a hardening item once IDE Phase 4 lands.

Each is a candidate for a future slice driven by observed need, not pre-emptive scope expansion. F.1 explicitly does NOT include any of these — it's a pure migration with identical behavior to today's API path.

### ASPE — Activity Stream Plain English
A low-priority background agent (Haiku-class) watches each agent's tool-call stream and emits plain-English summaries: "this agent just refactored useDrift.ts to extract the linkage filter; here's a one-line summary." Closes the gap that drove the project's origin story (copy-pasting agent output into another session to translate).

### Symphony Cloud
Hosted Foundry + agent runtime + plugin auth, $20-30/mo, "skip the install dance, pay us, build your meal planner." Targets the bouncer-givers-up who won't tolerate the local install dance. Open-source desktop ships first, builds trust, cloud is the convenience play.
