# Bundle Whole-Impl Review + Fixes — `5a46617f` + `9384637e`

**RATIFIED 2026-05-18 (user-approved "fix everything possible now").** Range reviewed: `6af42304..9384637e` (the bundled parallel work: SP1b/SP1c Gemini+Opencode, drift-L3, secret-substitution, claudeUsageProbe refactor, demo/tauri/UI + the ctor crash fix).

## Process

3 parallel reviewers (A: SP1b/SP1c — Opus; B+C: drift/secret/usage-probe — Opus; D: demo/tauri/UI — Sonnet) + controller full root-suite gate (✅ 1668 pass / 0 fail) + controller invariant check (✅ bundle byte-unchanged vs SP1a Stage-2 delivery core / Claude / Codex / normalizer — additive at the registry/launch layer only). **Verdict: NOT mergeable as-is.**

## Findings

**Clean / confirmed good:** seam reuse faithful (Claude/Codex byte-unchanged), session-aware stuck detector correctly inherited by Gemini/Opencode, normalizers pure/total/never-throw, the `9384637e` ctor fix correct & complete (no other same-class bugs), no secret leakage in `providerModels`, `roleAuthority` classifies `provider_model_list` correctly, `claudeUsageProbe` confirmed *pure dead-code deletion* (Claude usage feature intact), `teamSystemPrompts` clean (12/12), deleted UI components have zero importers (no build break), CORS/CSP/`CREATE_NO_WINDOW` correct & tested.

**Critical**
- **A1** `GeminiExecAdapter.js`/`OpencodeExecAdapter.js` `sendTurn` clears `_pendingTexts` before spawn; a synchronous spawn throw loses the coalesced batch while later slots return false `{accepted:true,coalesced}` → silent message loss. Codex guards this exact case (`CodexExecAdapter.js:73-83`, the W5 fix); SP1b/SP1c didn't port it.
- **B1** `driftEngine.js:~433` gate-mode notification `appendMessage({to:{kind:'team'}})` has **no `teamId`** → `normalizeRecipient` throws, swallowed by bare `catch` → every gate-mode alert silently lost; Step E non-functional, untested.

**Important**
- **A3 (deferred — needs real CLIs)** Gemini/OpenCode CLI flags + JSON event vocabularies wholly ungrounded (no grounding doc/spec), contrary to SP1a §10/§11 ratify discipline. A wrong flag/shape = every Gemini/OpenCode agent silently broken in prod with green tests.
- **A4 (deferred — cross-adapter)** No first-turn MCP-tool visibility probe → silent mute agent on a broken rail. Codex Stage-1 also lacks it; tracked as a Stage-2 item across all session adapters.
- **A2** `registerSessionAgent` re-derives provider from `command` only, discarding authoritative `input.providerId` → non-canonical command + `providerId:'gemini'` builds a `CodexExecAdapter`.
- **A5** OpenCode auth path hardcoded `~/.local/share/opencode/auth.json` (Linux/XDG) → refuses valid Windows logins (target platform).
- **A6** `OpencodeExecAdapter` passes unsanitized `--model/--agent/--variant` values with `shell:true` → widens CVE-2024-27980 argument-injection surface.
- **C** `secretSubstitution.js` is inert (zero importers, never populated) — ships a security control that isn't wired; fails *open* on unknown tokens; security tests missing. (Slice-1 audit redactor IS live → today's leak risk limited.)
- **B2** UTF-8 BOM injected into `driftEngine.js:1`. **D** `capture-demo-screenshots.mjs:~165` dead `if/else` hides required-action failures (demo tooling only).

**Minor** `redactForAudit` substring-unsafe; short-secret silent skip; tauri `@lydell` resource over-broad; Titlebar inline hover styles; inconsistent default providerId; weak `adapterForProvider` provider-precedence tests; stale opencode `unsupportedReason`.

## Fix decomposition (TDD red→green, one commit each)

- [ ] **BR1 — A1 (Critical):** port the `CodexExecAdapter.js:73-83` try/catch batch-restore guard into `GeminiExecAdapter.sendTurn` + `OpencodeExecAdapter.sendTurn`. Tests mirror `codexExecAdapter.spawnThrow.test.js` for both.
- [ ] **BR2 — B1 (Critical):** `driftEngine.js` gate notification `to:{kind:'team', teamId}`; add a Step-E test asserting a gate finding produces a brokered message (none exists).
- [ ] **BR3 — B2:** strip the BOM from `driftEngine.js`; add a repo guard test rejecting BOMs in `src/**/*.js`.
- [ ] **BR4 — A2:** thread `providerId` through `registerSessionAgent` + `#prepare{Gemini,Opencode}Runtime`; prefer `input.providerId || providerForCommand(command) || 'openai'`; tighten the routing test.
- [ ] **BR5 — A6:** strict allowlist (`/^[\w./:@-]+$/`) on `--model/--agent/--variant` in `normalizeOpencodeArgs` before any `shell:true` spawn; adversarial test.
- [ ] **BR6 — A5:** resolve OpenCode creds path per-platform (Windows config dir / honor `XDG_DATA_HOME`/`OPENCODE_*`); test Windows resolution.
- [ ] **BR7 — C:** harden `secretSubstitution.js` *as scaffolding*: explicit not-integrated marker in docstring/export; fail-**closed** default for unknown tokens (strict default, opt-in fail-open); length-desc ordering in `redactForAudit`; structured signal on short-secret skip; adversarial tests.
- [ ] **BR8 — D + minors:** fix `capture-demo-screenshots.mjs` dead branch; tauri `@lydell` → explicit package paths; stale opencode `unsupportedReason`; inconsistent default providerId note.

**Deferred (own follow-up, RATIFIED as tracked):** **A3** ground Gemini/OpenCode CLI invocation contracts + event vocabularies against the real installed CLIs, pin a grounding doc, add an SP1a-style scripted-CLI front-loaded e2e proof; **A4** add the first-turn MCP-tool visibility probe across *all* session adapters (Codex/Gemini/Opencode). These cannot be code-fixed without the real CLIs and are blockers for trusting SP1b/SP1c in production / before any GitHub push.

> After BR1–BR8: controller re-runs the full root-suite gate (EXIT=0, fail 0), then report. Do NOT push to GitHub until A3/A4 are resolved.
