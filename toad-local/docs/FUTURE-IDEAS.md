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

### Foundry slice F.1: CLI-mediated planning — SHIPPED
Foundry was migrated from API to persistent Claude CLI subprocess. Spawns `claude --verbose --input-format stream-json --output-format stream-json --append-system-prompt-file --disallowedTools "*" --session-id <uuid>` per Foundry session and holds the process alive across all turns. Closes the cost-story hole — the bouncer-givers-up audience uses their Claude Pro subscription, not API tokens. Shipped commit `6acecc1`.

### Foundry slice F.2: provider-aware Foundry — SHIPPED
Adapter pattern: `FoundryProviderAdapter` base + `ClaudeFoundryAdapter` (port of F.1) + `CodexFoundryAdapter` (new). Codex uses `codex exec --json` per turn with `codex exec resume <id>` for subsequent turns — Codex preserves session state on disk between calls so we never replay tokens. Settings has `foundry.defaultProvider`; FoundryScreen lets users override per-session at create time. Ship marker on F.2 ship commit. Defers Gemini to F.2.5.

### Foundry slice F.2.5: Gemini support
Drop in a `GeminiFoundryAdapter` following the same shape as the Codex adapter. Gemini CLI's documented "persistent JSON output modes for consistent, structured data formats" suggests it has the equivalent of Codex's `exec --json` event stream — research the actual flag and event shape (probably `gemini --prompt-file` or similar plus a JSON-output flag). Same per-turn-with-resume pattern, same normalized event interface. Lands once F.2 usage data shows real demand for a third provider.

### Foundry slice F.3+: planning-quality enhancements
Patterns worth borrowing from external planning tools (`/deep-plan`, spec-kit, planning-with-files) but built as Symphony-native tools/skills, not third-party plugin adoptions:

1. **Cross-LLM critique loop** (from `/deep-plan` by Pierce Lamb): post-doc-generation, send the 7 docs to a different provider for "find what we missed" review. Mirrors drift slice 2's Opus-tier escalation pattern. Blocks on F.2's multi-provider work. Triples LLM cost per refinement; only worth shipping if real Foundry-quality data justifies.

2. **AskUserQuestion-style structured interviews** (from `/deep-plan`): instead of free-text "any other questions?", a Symphony MCP tool the planning agent calls to capture explicit Q+A pairs. Trackable across turns, surfaces which decisions are still open. Better Foundry hygiene than free-text exchange.

3. **Phase artifact pipeline formalization** (from GitHub spec-kit): make the brief.md → tech_spec.md → roadmap.md → tasks.md dependency explicit instead of implicit. Each phase reads prior phase's artifact as input rather than relying on conversation context. Tightens output quality and reduces "the model forgot what we agreed in turn 2" failures.

4. **Hook-based plan re-reading** (from planning-with-files by OthmanAdi): when an agent in the runtime tier is mid-task, hook makes them re-read tasks.md and steering.md before tool calls. Catches drift early before code ships. **Belongs in runtime tier, NOT Foundry** — different slice entirely. Probably a hardening item once IDE Phase 4 lands.

Each is a candidate for a future slice driven by observed need, not pre-emptive scope expansion. F.1 explicitly does NOT include any of these — it's a pure migration with identical behavior to today's API path.

### Drift v2 — code-consistency monitor

The current drift monitor catches **process drift** well — task lifecycle violations, role-permission breaches, missing test artifacts, etc. The 8 deterministic checks do their job. The LLM semantic check tries to catch **semantic drift** but is the noisiest part: open-ended prompt, Windows-spawn bugs (same root cause as F.2 — never ported the fixes), expensive (60s polling), hallucinated findings, brittle stable-ID design that fights LLM nondeterminism.

What's missing is **code-consistency drift** — the failure mode where multiple providers and models touching different parts of the codebase produce a patchwork: agent A establishes a pattern in Claude, agent B implements similar code differently in Codex, agent C in Gemini reviews both and doesn't notice the inconsistency. This is the most insidious kind of drift in multi-agent work and the current monitor can't see it.

Sketch of what Drift v2 would add (deferred until usage data shows what real drift looks like — don't pre-emptively design):

1. **Pattern indexing** — scan the codebase for established patterns (error handling, naming, abstraction shapes) via AST/regex. Deterministically check new code against them. Fast, cheap, no hallucination.
2. **Cross-task review continuity** — when a reviewer agent picks up task B, give it context about how similar task A was resolved. Drift *prevention*, not detection.
3. **Codebase rules from AGENTS.md / CLAUDE.md as drift baselines** — already a convention in the project. Drift becomes "did this change violate a documented rule?"
4. **Compaction-aware steering re-injection** — when an agent's session compacts, re-inject architecture decisions so they don't get forgotten between tasks.
5. **Narrow LLM judge prompts** — instead of "find drift," ask "does the diff in task B follow the same error-handling pattern as `src/X/handler.js`?" Specific questions get specific answers.

Order of operations: ship Drift hardening first (the polish slice that fixes Windows spawn + polling + duplicate-DRIFT_RUN bugs in the current monitor). Use that hardened version in production for weeks. Observe what kinds of drift the team actually produces. Then design v2 against that evidence, not against speculation.

References worth borrowing from when v2 lands: CodeRabbit's published prompt structures for LLM-driven code review; Open Policy Agent (OPA) for declarative rule-engine patterns; Terraform's "expected vs actual" vocabulary; DSPy/LangSmith for structured-output LLM eval patterns. Symphony's drift v2 will probably set the playbook for multi-agent code-consistency monitoring — nobody's solved this exact framing yet.

### UI re-envisioning — surface what's hidden

The project has shipped a deep set of capabilities — Foundry's chat-driven discovery, the runtime supervisor, the drift monitor, approvals, costs, diagnostics, the audit/code/review surfaces, plugin auth, GitHub auth, risk policies, settings tuning, the reopen flow, bug-fix task type, project picker — but the way you *reach* most of them today is either through the command palette (⌘K) or by knowing which sidebar icon happens to expose the thing you want. A new user staring at Cockpit has no way to discover that "Open Project picker" or "Open Providers modal" or any of the other ~30 command-palette entries even exist.

Specific gaps observed so far (capture more as they're hit):

- **No visible team / project switcher.** Once you're on a team, the only way to switch to another existing project is `⌘K → "Open Project picker"`. The picker screen itself is well-built; it's just invisible from inside the app. A "switch project" chip next to the team name in the Cockpit header, or a project list in the sidebar footer, would close this gap without adding new screens. **This is the immediate item to fix.**
- **Settings is one flat list.** Drift, providers, risk policy, GitHub auth, themes, tweaks — all live in the same Settings screen with no obvious grouping for the casual user.
- **Foundry → Cockpit handoff is fine, but coming back to an existing project goes through reopen logic that's invisible to the user.** The user doesn't know whether Symphony "remembered" their project or is starting fresh until they're already on a screen.
- **Many actions live in modals invoked from the command palette only.** Providers, shortcuts, plugins, GitHub linking — none of these have a visible front door.
- **Cockpit's bottom panel is cramped** (already captured under power-user mode notes). The validation runner, terminal, focused output all compete for the same horizontal strip.

What a re-envisioning should produce:

1. **A discoverability audit.** Walk every feature the engine exposes, ask "how would a brand-new user find this without reading docs?" — list the gaps.
2. **A navigation model.** Today the left sidebar is the only nav; the top bar is search-only. The new model should make space for: (a) project context (which project / team you're on, switch action), (b) primary nav (the workspaces), (c) global actions (notifications, help, settings, runtime status), (d) the command palette as a power-user shortcut, not the only door.
3. **A visual hierarchy refresh.** The current Cockpit is information-dense but flat — Cursor / Linear / Raycast all do better at making the operator's eye land on the right thing first.
4. **Per-persona defaults.** Tie this to power-user mode (see top of doc): the "AI builds it FOR me" persona should land on a calmer, more guided Cockpit; the "WITH me" persona should land on a developer-mode layout with terminal + diff hunks + raw event log surfaced.
5. **An onboarding overlay system.** First-run already exists; what's missing is contextual "did you know X exists?" prompts when a user has been on a screen for a while without using its features.

Sequencing: do this AFTER the maintenance trilogy and drift hardening slice ship. The re-envisioning is a brainstorming → design → spec → implementation workstream of its own, not a punch-list item. Capture more "I can't find X" moments as we hit them so the brainstorm has concrete grievances to design against, not just abstract aspirations.

### ASPE — Activity Stream Plain English
A low-priority background agent (Haiku-class) watches each agent's tool-call stream and emits plain-English summaries: "this agent just refactored useDrift.ts to extract the linkage filter; here's a one-line summary." Closes the gap that drove the project's origin story (copy-pasting agent output into another session to translate).

### Symphony Cloud
Hosted Foundry + agent runtime + plugin auth, $20-30/mo, "skip the install dance, pay us, build your meal planner." Targets the bouncer-givers-up who won't tolerate the local install dance. Open-source desktop ships first, builds trust, cloud is the convenience play.
