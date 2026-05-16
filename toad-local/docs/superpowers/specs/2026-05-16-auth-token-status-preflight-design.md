# Claude Auth Token-Status Honesty + Pre-Launch Preflight — Design

**Status:** Approved (brainstormed + grounded 2026-05-16).
**Origin:** The 401 the operator hit — UI showed a ✓ for Claude auth, but the spawned `lead` agent failed with `API Error: 401 Invalid authentication credentials`. Root cause: an expired Claude Max OAuth access token that the CLI's "silent refresh on next use" did not renew for the non-interactively-spawned stream-json agent. Banked as its own brainstorm→spec→fix cycle.
**Out of scope (non-goals):** Codex/Gemini auth (different files, not this gap); a proactive/background refresh loop or scheduler; TOAD owning the OAuth refresh exchange itself; Sub-project C (compaction); the shipped readability work.

---

## 1. Goal

Make Claude plan-auth status **honest** (the UI must distinguish a fresh
token from an expired-but-refreshable one — never a bare ✓ that lies),
and **prevent the predictable mid-run 401** by attempting the CLI's own
refresh once before a Claude-provider agent is spawned, blocking only
the provably-doomed launch with an actionable re-login error.

**Success criteria**
1. `parseAnthropicFileStatus` emits a sealed `tokenStatus` distinguishing `fresh` / `stale_refreshable` / `expired_unrecoverable`; `signedIn` stays backward-compatible for existing consumers.
2. The facade `provider_auth_status` projection propagates `tokenStatus` + `reason` (today it drops them), so the auth panel can show "token expired — re-login" instead of ✓.
3. A Claude-provider agent launch runs a pre-launch preflight: `fresh` → zero-overhead proceed; `stale_refreshable` → one isolated `claude --print` refresh attempt, re-verify; provably-doomed → hard-block with an actionable error; ambiguous/transient → warn-and-proceed (never stricter than reality).
4. No silent degradation: a blocked launch fails fast with a clear re-login instruction; a warn-and-proceed launch is visibly marked stale in the same auth panel.
5. Root `npm test` stays `fail 0`; UI `tsc -b`/`vite build` stay green.

---

## 2. Grounded reality (verified in code 2026-05-16 — the spec is built on these)

- **`src/providers/providerAuth.js` `parseAnthropicFileStatus(authJson,_infoJson,providerId)` (≈L329-360).** Creds file `~/.claude/.credentials.json` shape: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } }`. Current logic: missing/!object → `signedIn:false`; no `accessToken` → `signedIn:false`; `accessExpired && !hasRefresh` (≈L341-343) → `signedIn:false`; **otherwise `signedIn:true`** — so `accessExpired && hasRefresh` collapses to `signedIn:true` with only a `raw.accessExpired:true` buried in `raw`. The comment at ≈L326-327 ("An expired access token + a refresh token still counts as signed in because the CLI silently refreshes on next use") encodes the now-falsified assumption.
- **`PROVIDER_COMMANDS.anthropic` (≈L45-64):** `cli:'claude'`, `manualLogin:true` (TOAD deliberately does NOT auto-spawn `claude auth login` — wrong OAuth scope), `statusMode:'file'`, `statusFile:~/.claude/.credentials.json`, `parseFileStatus:parseAnthropicFileStatus`. `loginInstructions`: "Run `claude` in a terminal, then type `/login`".
- **Facade projection — `src/tools/localToolFacade.js` ≈L2355-2389.** `providerGetAuthStatus(...)` → `const signedIn = authStatus && authStatus.signedIn === true;` → builds the provider entry `{ providerId, label, signedIn: signedIn||false, plan, user, reason: !signedIn ? authStatus?.reason : null, quota, symphonyUsage }`. **`raw` / any expiry signal is NOT propagated**; `reason` is nulled whenever `signedIn`. This entry is the `provider_auth_status` surface the UI polls (MCP tool `localToolDefinitions.js:931`; "The UI polls provider_auth_status until signedIn flips true", `:940`).
- **No launch preflight exists.** `grep` of `src/app/LocalToadRuntime.js` + `src/runtime/RuntimeSupervisor.js` for any auth/credentials/preflight check before spawn → **nothing**. `LocalToadRuntime.launchAgent(input)` is at ≈L404; it builds env via `buildScrubbedAgentEnv` (≈L444) then calls `await this.supervisor.launchAgent(launchInput)` (≈L450). The 401 is only discovered at runtime.
- **No token refresh anywhere.** TOAD never triggers a refresh; it relies entirely on the CLI's silent refresh, which does not reliably fire for the non-interactive spawned stream-json agent.
- **One-shot `claude --print` is a precedented pattern.** `src/drift/llm/llmJudge.js` shells `claude --model <m> --print` with `CLAUDE_ISOLATION_FLAGS`/`CLAUDE_INLINE_ISOLATION_FLAGS` (≈L121/138); `src/providers/claudeUsageProbe.js` uses `--print "/usage"`. A minimal isolated `claude --print` turn is an established, working, non-interactive invocation — and a "turn" is exactly the "use" that triggers the CLI's own silent token refresh + rewrite of `~/.claude/.credentials.json`.
- **`providerGetAuthStatus` is dependency-injectable** (`spawnSyncImpl`/`readFileImpl`/`statImpl` already threaded from `LocalToadRuntime` constructor — `providerAuthSpawn`/`providerAuthSpawnSync`/etc., ≈L87/207). Same DI seam the preflight reuses for testability.

This is **not greenfield** (§8d question-#1): it is a contract refinement to `parseAnthropicFileStatus`, a propagation fix in the facade projection, and a new preflight inserted into the existing `launchAgent` path.

---

## 3. Layer A — honest token-status contract

### 3.1 Sealed `tokenStatus`

`parseAnthropicFileStatus` returns a new sealed field
`tokenStatus: 'fresh' | 'stale_refreshable' | 'expired_unrecoverable'`
(sealed/exported, single source of truth — same discipline as
Sub-project B's sealed `source` enum). Mapping (preserves today's
`signedIn` for the two existing cases):

| Creds state | `signedIn` | `tokenStatus` | `reason` |
|---|---|---|---|
| `accessToken` present, not expired (`expiresAt` absent OR `expiresAt >= now`) | `true` | `'fresh'` | omitted |
| `accessToken` present, `accessExpired` **and** `hasRefresh` | `true` | `'stale_refreshable'` | `"access token expired; a refresh token is present but the credentials have not been renewed yet"` |
| `accessToken` present, `accessExpired` **and** `!hasRefresh` | `false` (unchanged from current L341-343) | `'expired_unrecoverable'` | `"OAuth tokens expired and no refresh token to renew them"` |
| not an object / no `accessToken` | `false` | `'expired_unrecoverable'` | existing reason strings (file did not parse / no accessToken) |

- `signedIn` semantics are **unchanged** for every case that already set it (no regression for code reading only `signedIn`); `tokenStatus` is the added precise dimension. `accessExpired`/`hasRefresh` are computed exactly as today (`expiresAt` numeric & `< now`; `refreshToken` non-empty string).
- The `raw` block keeps `accessExpired`/`hasRefreshToken` as-is (additive change only).
- The falsified comment at ≈L326-327 is corrected to state the real behavior (silent refresh is unreliable for non-interactive spawned agents; hence `tokenStatus` + the preflight).
- A `parseAnthropicStatus` (the CLI-`--json` variant, ≈L362) is **not** in scope — only the file-based path is the live one for anthropic (`statusMode:'file'`); leave it untouched.

### 3.2 Facade projection (the propagation fix)

In `localToolFacade.js` (≈L2380-2389) the provider entry gains
`tokenStatus: authStatus?.tokenStatus ?? null` and surfaces `reason`
whenever `tokenStatus` is not `'fresh'` (not only when `!signedIn`) —
i.e. a `stale_refreshable` entry now carries `signedIn:true` **and**
`tokenStatus:'stale_refreshable'` **and** the reason. No other provider
entry field changes. (Codex/Gemini have no `tokenStatus` → `null`,
rendered as today.)

---

## 4. Layer B — pre-launch preflight + gate

### 4.1 Module

New focused module **`src/runtime/authPreflight/`** (mirrors the
`contextUsage`/`eventNarration` pure-core + injected-IO style):

- `claudeAuthPreflight({ readCredsStatus, refreshOnce, now }) → { decision: 'proceed' | 'block', tokenStatus, reason }`
  - Pure decision core; all IO injected:
    - `readCredsStatus()` → the Layer-A status object (defaults to `parseAnthropicFileStatus` over the real creds file via the same `readFileImpl`/`statImpl` DI seam the facade uses).
    - `refreshOnce()` → performs the single isolated `claude --print` turn and resolves `{ ok: boolean, authRejected: boolean }` (`ok` = the invocation completed without error; `authRejected` = it failed with a definitive auth/credential rejection, distinguished from transient/non-auth errors by exit/stderr classification).
- The real `refreshOnce` default: spawn `claude --print` with a minimal fixed prompt and the **same isolation flags `llmJudge.js` uses** (`CLAUDE_ISOLATION_FLAGS`-equivalent: no MCP, scrubbed env, bounded timeout, `windowsHide`), discarding output. It exists solely to force the CLI's own silent refresh; TOAD never parses a token or calls the OAuth endpoint itself.

### 4.2 Decision flow (pinned)

```
status = readCredsStatus()
if status.tokenStatus === 'fresh'                 → { proceed }            # zero overhead, no spawn
if status.tokenStatus === 'expired_unrecoverable' → { block }             # no refresh token / unparseable
# stale_refreshable:
r = refreshOnce()
status2 = readCredsStatus()                       # re-read after the attempt
if status2.tokenStatus === 'fresh'                → { proceed }            # refresh worked
if r.authRejected === true                        → { block }             # definitive auth rejection
if status2.tokenStatus === 'expired_unrecoverable'→ { block }             # refresh consumed/removed the refresh token
else (transient / non-auth failure, still stale)  → { proceed, warn }     # NOT stricter than reality
```

`block` carries `reason` = an actionable message:
`"Claude token expired and the automatic refresh did not succeed. Re-login: run \`claude\` in a terminal, then \`/login\`, and relaunch."`
`proceed, warn` carries the `stale_refreshable` `tokenStatus`/`reason`
through to the running runtime's auth surface.

### 4.3 Wiring

`LocalToadRuntime.launchAgent(input)` (≈L404), **before**
`await this.supervisor.launchAgent(launchInput)` (≈L450):

- Resolve the launching runtime's provider. **Only when it is
  anthropic/claude** run `claudeAuthPreflight`. (Provider resolution
  uses whatever `launchAgent` already knows about the runtime's
  provider — Codex/Gemini/other → skip entirely; this gap is
  Claude-specific.)
- `decision: 'block'` → `launchAgent` throws/returns a structured
  failure with the actionable `reason` (same channel every other
  `launchAgent` failure already uses to reach the operator). The agent
  is **not** spawned.
- `decision: 'proceed'` (with or without `warn`) → continue to
  `supervisor.launchAgent`. No new UI/marker plumbing is required for
  the `warn` case: the credentials are still stale on disk, so the
  **next `provider_auth_status` poll already returns
  `tokenStatus:'stale_refreshable'`** via Layer A (§3) — that *is* the
  surfacing. `warn` is an internal proceed-with-`reason` signal (logged
  for diagnostics); it does NOT introduce a separate per-launch marker
  channel (YAGNI — the honest poll is the single source).
- `fresh` path adds **no spawn and no measurable latency** (a single
  file stat+read).

### 4.4 Cost discipline (banked-pattern note)

`refreshOnce` is a **single** `claude --print` turn, fires **only** on
`stale_refreshable` (never on `fresh`), with a bounded timeout. Plan
auth is rate-limited, not unbounded (same discipline as L3 / the banked
summarizer) — but one tiny refresh turn on an already-expired token is
strictly better than a guaranteed mid-run worker 401. No retry loop, no
scheduler, no background polling.

---

## 5. Surfacing (honest-degradation — never silent)

- **Blocked launch:** fails fast with the actionable re-login `reason`
  via the existing `launchAgent` error path — the operator sees a clear
  instruction, never a cryptic mid-run 401.
- **warn-and-proceed:** the runtime is spawned; because the creds are
  still stale on disk, the very next `provider_auth_status` poll returns
  `signedIn:true, tokenStatus:'stale_refreshable', reason:…` via Layer
  A — so the auth panel shows "✓ (token stale — re-login recommended)"
  distinct from "✓ fresh" with **no extra plumbing** (the honest poll
  is the single source; no separate per-launch marker). Exact chip
  wording is a small UI nicety, not pinned here; the data contract is
  what this spec fixes.
- This is the Sub-project-B honest-degradation lineage: report the true
  state, never paper over it.

---

## 6. Testing

- **TDD throughout.**
- **Layer A state machine** (`parseAnthropicFileStatus`): unit tests for all four rows of §3.1 (fresh / stale_refreshable / expired_unrecoverable via no-refresh / unparseable), incl. `expiresAt` absent → fresh, `expiresAt` numeric boundary (`=== now`), non-string `refreshToken`. Assert `signedIn` is unchanged vs. pre-change for the two pre-existing cases (explicit regression guard).
- **Facade projection:** test that a `stale_refreshable` status yields a provider entry with `signedIn:true`, `tokenStatus:'stale_refreshable'`, non-null `reason`; a `fresh` status → `tokenStatus:'fresh'`, `reason:null`; Codex/Gemini → `tokenStatus:null`.
- **Preflight decision core** (`claudeAuthPreflight`, injected `readCredsStatus`/`refreshOnce`): decision-table tests covering every §4.2 branch — `fresh`→proceed-no-refreshOnce-called (assert `refreshOnce` not invoked); `expired_unrecoverable`→block-no-refresh; `stale_refreshable` then re-read `fresh`→proceed; then `authRejected`→block; then re-read `expired_unrecoverable`→block; then transient/non-auth still-stale→proceed+warn.
- **Wiring:** a test that `launchAgent` for a Claude-provider input with a `block` decision does NOT call `supervisor.launchAgent` and surfaces the actionable reason; for a non-Claude provider the preflight is skipped entirely.
- **Gates:** root `npm test` `fail 0`; new test files wired into the canonical `npm test` chain (no un-wired-test false-green); UI `tsc -b`/`vite build` green (UI touched only if the panel must render the new field — minimal/optional).

---

## 7. Pinned-vs-open summary

**Pinned:** sealed `tokenStatus` enum (`fresh|stale_refreshable|expired_unrecoverable`); `signedIn` backward-compatible (unchanged for the two pre-existing cases); facade projects `tokenStatus`+`reason` (reason when not `fresh`); new `src/runtime/authPreflight/` pure-core + injected IO; preflight in `launchAgent` before `supervisor.launchAgent`, **Claude-provider only**; refresh = **one** isolated `claude --print` turn (llmJudge isolation pattern), TOAD never owns OAuth; gate = proceed-on-fresh (no spawn) / block-on-provably-doomed (no-refresh OR definitive auth rejection OR refresh consumed the refresh token) / warn-and-proceed on transient/ambiguous; blocked launch fails fast with actionable re-login reason; warn-and-proceed marked in `provider_auth_status`; the L326-327 comment corrected; cost = single refresh turn, stale-only, no loop.

**Open (resolved in implementation, not pre-invented):** the exact
`refreshOnce` error/exit classification that separates "definitive auth
rejection" from "transient/non-auth failure" (derived from the real
`claude --print` failure surface during implementation, mirroring how
`llmJudge`/`claudeUsageProbe` already classify CLI outcomes); the exact
provider-resolution call already available inside `launchAgent`; the
optional UI chip wording. None of these change the architecture above.
