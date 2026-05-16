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

This spec ships a **data contract** (`{ signedIn, tokenStatus, reason }`),
not a UI redesign. The honesty requirement is that the *status data*
carries the stale dimension so a consumer can stop presenting an
unqualified ✓; the exact downstream UI treatment (distinct icon vs ✓
plus a modifier/chip) is **not pinned here** and is downstream of this
contract (§5).

**Success criteria**
1. `parseAnthropicFileStatus` emits a sealed `tokenStatus` distinguishing `fresh` / `stale_refreshable` / `unrecoverable`; `signedIn` stays backward-compatible for existing consumers.
2. The facade `provider_auth_status` projection propagates `tokenStatus` + `reason` (today it drops them), so the auth panel can distinguish a stale/expired token from a fresh one instead of an unqualified ✓.
3. A Claude-provider agent launch runs a pre-launch preflight: `fresh` → zero-overhead proceed; `stale_refreshable` → one isolated `claude --model haiku --print` refresh attempt, re-verify; every state where the token is *knowably* unusable (no/dead refresh token, definitive auth rejection, or a *completed* refresh turn that still didn't renew) → hard-block with an actionable error; only the "refresh turn never completed" transient → warn-and-proceed (the sole genuinely-uncertain case — never stricter than reality, but never proceeding into a *provable* 401, so goal #3 holds).
4. No silent degradation: a blocked launch fails fast with a clear re-login instruction; a warn-and-proceed launch is visibly marked stale in the same auth panel.
5. Root `npm test` stays `fail 0`; UI `tsc -b`/`vite build` stay green.

---

## 2. Grounded reality (verified in code 2026-05-16 — the spec is built on these)

- **`src/providers/providerAuth.js` `parseAnthropicFileStatus(authJson,_infoJson,providerId)` (≈L329-360).** Creds file `~/.claude/.credentials.json` shape: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } }`. Current logic: missing/!object → `signedIn:false`; no `accessToken` → `signedIn:false`; `accessExpired && !hasRefresh` (≈L341-343) → `signedIn:false`; **otherwise `signedIn:true`** — so `accessExpired && hasRefresh` collapses to `signedIn:true` with only a `raw.accessExpired:true` buried in `raw`. The comment at ≈L326-327 ("An expired access token + a refresh token still counts as signed in because the CLI silently refreshes on next use") encodes the now-falsified assumption.
- **`PROVIDER_COMMANDS.anthropic` (≈L45-64):** `cli:'claude'`, `manualLogin:true` (TOAD deliberately does NOT auto-spawn `claude auth login` — wrong OAuth scope), `statusMode:'file'`, `statusFile:~/.claude/.credentials.json`, `parseFileStatus:parseAnthropicFileStatus`. `loginInstructions`: "Run `claude` in a terminal, then type `/login`".
- **Facade projection — `src/tools/localToolFacade.js` ≈L2355-2389.** `providerGetAuthStatus(...)` → `const signedIn = authStatus && authStatus.signedIn === true;` → builds the provider entry `{ providerId, label, signedIn: signedIn||false, plan, user, reason: !signedIn ? authStatus?.reason : null, quota, symphonyUsage }`. **`raw` / any expiry signal is NOT propagated**; `reason` is nulled whenever `signedIn`. This entry is the `provider_auth_status` surface the UI polls (MCP tool `localToolDefinitions.js:931`; "The UI polls provider_auth_status until signedIn flips true", `:940`).
- **No launch preflight exists.** `grep` of `src/app/LocalToadRuntime.js` + `src/runtime/RuntimeSupervisor.js` for any auth/credentials/preflight check before spawn → **nothing**. `LocalToadRuntime.launchAgent(input)` is at ≈L404; it builds env via `buildScrubbedAgentEnv` (≈L444) then calls `await this.supervisor.launchAgent(launchInput)` (≈L450). The 401 is only discovered at runtime.
- **No token refresh anywhere (pre-change).** *Today* TOAD never triggers a refresh; it relies entirely on the CLI's silent refresh, which does not reliably fire for the non-interactive spawned stream-json agent. (Layer B changes this: TOAD still does **not** own the OAuth exchange, but it will trigger the CLI's own refresh *indirectly* via a one-shot `claude --print` "use" — see §4. This bullet describes the grounded pre-change state the design starts from.)
- **One-shot `claude --print` is a precedented pattern.** `src/drift/llm/llmJudge.js` shells `claude --model <m> --print` with `CLAUDE_ISOLATION_FLAGS`/`CLAUDE_INLINE_ISOLATION_FLAGS` (≈L121/138); `src/providers/claudeUsageProbe.js` uses `--print "/usage"`. A minimal isolated `claude --print` turn is an established, working, non-interactive invocation — and a "turn" is exactly the "use" that triggers the CLI's own silent token refresh + rewrite of `~/.claude/.credentials.json`.
- **`providerGetAuthStatus` is dependency-injectable** (`spawnSyncImpl`/`readFileImpl`/`statImpl` already threaded from `LocalToadRuntime` constructor — `providerAuthSpawn`/`providerAuthSpawnSync`/etc., ≈L87/207). Same DI seam the preflight reuses for testability.

This is **not greenfield** (§8d question-#1): it is a contract refinement to `parseAnthropicFileStatus`, a propagation fix in the facade projection, and a new preflight inserted into the existing `launchAgent` path.

---

## 3. Layer A — honest token-status contract

### 3.1 Sealed `tokenStatus`

`parseAnthropicFileStatus` returns a new sealed field
`tokenStatus: 'fresh' | 'stale_refreshable' | 'unrecoverable'`
(sealed/exported, single source of truth — same discipline as
Sub-project B's sealed `source` enum). `unrecoverable` is the precise
name for "no path to a working token from here" — it covers BOTH
*expired-with-no-refresh-token* AND *absent/unparseable creds* (review
finding: those are not "expired", and the gate treats them identically
— both are provably-doomed → `block`; the human distinction lives in
`reason`, the decision-relevant property is the single sealed value).
Mapping (preserves today's `signedIn` for the existing cases):

| Creds state | `signedIn` | `tokenStatus` | `reason` |
|---|---|---|---|
| `accessToken` present, not expired (`expiresAt` absent OR `expiresAt >= now`) | `true` | `'fresh'` | omitted |
| `accessToken` present, `accessExpired` **and** `hasRefresh` | `true` | `'stale_refreshable'` | `"access token expired; a refresh token is present but the credentials have not been renewed yet"` |
| `accessToken` present, `accessExpired` **and** `!hasRefresh` | `false` (unchanged from current L341-343) | `'unrecoverable'` | `"OAuth tokens expired and no refresh token to renew them"` |
| not an object / no `accessToken` | `false` | `'unrecoverable'` | existing reason strings (file did not parse / no accessToken) — unchanged from today |

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
rendered as today.) **Regression guard (parallel to §3.1's):** the
`signedIn:false`/`unrecoverable` cases must still surface their `reason`
*exactly as today* — the old projection nulled `reason` only when
`signedIn`, so `!signedIn` already carried it; the new "reason when not
`fresh`" rule is a strict superset and must not change those entries
(an explicit test asserts the `signedIn:false` entry shape is
byte-identical to pre-change aside from the additive `tokenStatus`).

---

## 4. Layer B — pre-launch preflight + gate

### 4.1 Module

New focused module **`src/runtime/authPreflight/`** (mirrors the
`contextUsage`/`eventNarration` pure-core + injected-IO style):

- `claudeAuthPreflight({ readCredsStatus, refreshOnce, now }) → { decision: 'proceed' | 'block', tokenStatus, reason }`
  - Pure decision core; all IO injected:
    - `readCredsStatus()` → the Layer-A status object (defaults to `parseAnthropicFileStatus` over the real creds file via the same `readFileImpl`/`statImpl` DI seam the facade uses).
    - `refreshOnce()` → performs the single isolated `claude --print` turn and resolves `{ ok: boolean, authRejected: boolean, timedOut: boolean }`:
      - **`ok` ≜ a `claude --print` turn actually *completed*** — i.e. the CLI ran far enough to have had the opportunity to perform its silent refresh. `ok` is **NOT** merely "no thrown error"; a spawn failure, non-zero exit, kill, or timeout is `ok:false` (the CLI did not get the chance to refresh). This precise meaning is what makes `ok` load-bearing in §4.2.
      - **`authRejected`** = the turn failed with a *definitive* auth/credential rejection (401/credential-invalid class), distinguished from transient/non-auth errors by exit-code/stderr classification (same kind of CLI-outcome classification `llmJudge`/`claudeUsageProbe` already do).
      - **`timedOut`** = the bounded timeout fired (⇒ also `ok:false`; the CLI was killed before completing → it did not get the chance to refresh → treated as the "did-not-run" transient class in §4.2).
- The real `refreshOnce` default: spawn `claude --model haiku --print` with a minimal fixed prompt and the **same isolation flags `llmJudge.js` uses** (`CLAUDE_ISOLATION_FLAGS`-equivalent: no MCP, scrubbed env, bounded timeout, `windowsHide`), discarding output. `--model haiku` is pinned: a refresh-only turn must burn the cheapest plan tier, never the operator's default (which could be Opus). It exists solely to force the CLI's own silent refresh; TOAD never parses a token or calls the OAuth endpoint itself.

### 4.2 Decision flow (pinned)

```
status = readCredsStatus()
if status.tokenStatus === 'fresh'        → { proceed }                 # zero overhead, no spawn
if status.tokenStatus === 'unrecoverable'→ { block }                  # no refresh token / absent / unparseable — definitely doomed
# stale_refreshable:
if relaunchGuardTripped(credsPath, now)  → { block }                  # see "Relaunch bound" below
r = refreshOnce()
status2 = readCredsStatus()                                           # re-read after the attempt
if status2.tokenStatus === 'fresh'       → { proceed }                # refresh worked — the goal case
if r.authRejected === true               → { block }                  # definitive auth rejection — token dead
if status2.tokenStatus === 'unrecoverable'→ { block }                 # refresh consumed/removed the refresh token
if r.ok === true  (a turn COMPLETED) && status2 still 'stale_refreshable'
                                         → { block }                  # ruling — see reasoning
otherwise  (r.ok === false: refreshOnce did NOT complete — spawn err / timeout / kill /
            non-auth transient) && status2 still 'stale_refreshable'
                                         → { proceed, warn }          # the ONLY genuinely-uncertain case
```

**Ruling & reasoning (review finding #1 — defended, not quietly
accepted).** The earlier draft's single `else → proceed+warn` violated
success-criterion #3 ("prevent the predictable mid-run 401"): it
proceeded into the exact trap the spec exists to eliminate. The fix
splits it on whether the refresh *turn completed*:

- **`r.ok === true` (a `claude --print` turn completed) yet creds are
  still stale → `block`.** The CLI was just given a real "use" and did
  **not** refresh. The spawned agent's first turn is the *same* kind of
  use; it will near-certainly 401. This is not a hypothetical transient
  — it is an *observed* failure of the exact recovery mechanism, so it
  is provably-doomed-in-practice. Failing fast with the actionable
  re-login honors goal #3 (we do **not** proceed into a 401 we can
  prove is coming) and makes `r.ok` load-bearing (resolves finding #2).
- **`r.ok === false` (the turn did NOT complete: spawn error / timeout
  / kill / non-auth transient) and still stale → `proceed, warn`.** The
  CLI never got the *opportunity* to refresh — this is an environment
  problem, not a dead token. This is the **only** case where we
  genuinely cannot tell the token is unusable; out-stricting reality
  here would false-block a launch the real agent's first turn could
  salvage once the environment recovers. Timeout routes here by
  construction (`timedOut ⇒ ok:false`; resolves finding #3). The
  false-block of a working launch on a transient blip is the worse
  failure mode *only* in this did-not-run case — everywhere the token
  is knowably dead we block.

Net: every state where the token is *knowably* unusable blocks (goal #3
holds); `proceed+warn` is now narrowly the "refresh mechanism never
ran" case alone.

**Relaunch bound (review finding #1, option-b, folded in).** To stop an
operator who relaunches *without* re-logging from looping on the narrow
`proceed+warn` path: `claudeAuthPreflight` records, per credentials
path, the outcome+timestamp of the last preflight. If the previous
preflight for this creds path was `proceed+warn` (still-stale) within
`RELAUNCH_GUARD_MS`, the next stale preflight short-circuits to
`block` (with the re-login `reason`) instead of spending another
`claude --print`. `RELAUNCH_GUARD_MS` default = 60_000 (impl-pinned;
single in-process map keyed by creds path, lives at the wiring layer
with the §4.3 mutex, not in the pure decision core).

`block` carries `reason` = an actionable message:
`"Claude token expired and the automatic refresh did not succeed. Re-login: run \`claude\` in a terminal, then \`/login\`, and relaunch."`
`proceed, warn` proceeds; the still-stale creds mean the next
`provider_auth_status` poll already reports `stale_refreshable` via
Layer A (§3) — that is the surfacing (no separate marker, §4.3).

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
- **Serialized Claude preflight (review finding #4 — multi-agent race,
  pinned).** Symphony's core is multi-agent orchestration: a team
  launch spawns lead + workers near-simultaneously, so concurrent
  Claude-provider launches all hitting `stale_refreshable` and racing
  `claude --print` against the single `~/.claude/.credentials.json`
  (concurrent CLI writers → partial read / duplicate refresh that
  invalidates the winner's token) is foreseeable, not theoretical. An
  in-process async mutex in `LocalToadRuntime` serializes the
  Claude-provider preflight: a launch acquires it, runs preflight, then
  releases; a second concurrent Claude launch **waits**, then on entry
  **re-reads status first** — so if the first launch already refreshed
  the token to `fresh`, the second sees `fresh` and proceeds with **no
  extra `claude --print`** (the mutex both fixes the race *and*
  de-dups the refresh under the common team-launch burst). The mutex
  lives at this wiring layer (alongside the §4.2 relaunch-guard map),
  never in the pure decision core; non-Claude launches do not contend
  for it.

### 4.4 Cost discipline (banked-pattern note)

`refreshOnce` is a **single** `claude --model haiku --print` turn,
fires **only** on `stale_refreshable` (never on `fresh`), with a
bounded timeout. Plan auth is rate-limited, not unbounded (same
discipline as L3 / the banked summarizer) — but one tiny cheapest-tier
refresh turn on an already-expired token is strictly better than a
guaranteed mid-run worker 401. No retry loop, no scheduler, no
background polling.

**Expected frequency (review finding #6).** `stale_refreshable` is a
*transient boundary* state — it occurs when an access token has aged
past `expiresAt` (token lifetime is on the order of hours), so under
normal use it is hit at most a few times a day, typically at the first
launch after an idle gap, not per-launch. The §4.3 serialization
collapses a whole team-launch burst to **one** refresh; the §4.2
relaunch-guard prevents a stuck operator from re-spending it. Net
expected cost: single-digit cheapest-tier turns/day under normal use.
If field observation shows materially higher (e.g. the CLI's silent
refresh never sticks, so every cold launch refreshes), that is a signal
to revisit the mechanism — bank it as a watch item, do not pre-optimize.

---

## 5. Surfacing (honest-degradation — never silent)

- **Blocked launch:** fails fast with the actionable re-login `reason`
  via the existing `launchAgent` error path — the operator sees a clear
  instruction, never a cryptic mid-run 401.
- **warn-and-proceed:** the runtime is spawned; because the creds are
  still stale on disk, the very next `provider_auth_status` poll returns
  `signedIn:true, tokenStatus:'stale_refreshable', reason:…` via Layer
  A — so the panel can distinguish stale from fresh with **no extra
  plumbing** (the honest poll is the single source; no separate
  per-launch marker). How the consumer renders that (a distinct icon, a
  ✓-with-modifier, a re-login chip — *all illustrative, none pinned*)
  is downstream of the `{signedIn,tokenStatus,reason}` contract per §1;
  the data contract is the entirety of what this spec fixes.
- This is the Sub-project-B honest-degradation lineage: report the true
  state, never paper over it.

---

## 6. Testing

- **TDD throughout.**
- **Layer A state machine** (`parseAnthropicFileStatus`): unit tests for every §3.1 row (fresh; `expiresAt` absent → fresh; `expiresAt === now` boundary; stale_refreshable; `unrecoverable` via expired+no-refresh; `unrecoverable` via not-an-object; `unrecoverable` via no-`accessToken`; non-string `refreshToken`). **Regression guard:** assert `signedIn` is byte-identical to pre-change for *every* case that already set it (fresh→true, stale→true, expired-no-refresh→false, unparseable→false), proving `tokenStatus` is purely additive.
- **Facade projection:** `stale_refreshable` → entry `signedIn:true, tokenStatus:'stale_refreshable', reason` non-null; `fresh` → `tokenStatus:'fresh', reason:null`; **`unrecoverable`/`signedIn:false` → entry byte-identical to pre-change aside from the additive `tokenStatus` (the §3.2 regression guard — `reason` still surfaced exactly as today)**; Codex/Gemini → `tokenStatus:null`.
- **Preflight decision core** (`claudeAuthPreflight`, injected `readCredsStatus`/`refreshOnce`/`now`/relaunch-state): decision-table tests for every §4.2 branch — `fresh`→proceed & **assert `refreshOnce` NOT invoked**; `unrecoverable`→block & refreshOnce not invoked; `stale_refreshable`→refreshOnce then re-read `fresh`→proceed; `r.authRejected:true`→block; re-read `unrecoverable`→block; **`r.ok:true` (turn completed) & still `stale_refreshable`→block** (the finding-#1 ruling — the load-bearing new case); **`r.ok:false` (refreshOnce did not complete) & still stale→proceed+warn**; **`r.timedOut:true`→`ok:false`→proceed+warn** (timeout disposition); **relaunch guard:** prior outcome `proceed+warn` for this creds path within `RELAUNCH_GUARD_MS`→next stale preflight short-circuits to block **without** calling `refreshOnce`.
- **Wiring:** `launchAgent` for a Claude-provider input with a `block` decision does NOT call `supervisor.launchAgent` and surfaces the actionable reason; non-Claude provider → preflight skipped entirely (mutex not contended). **Concurrent/mutex (review finding #4):** two near-simultaneous Claude launches both initially `stale_refreshable` → the serialized preflight calls `refreshOnce` **once** (second waiter re-reads, sees `fresh`, proceeds with no second `claude --print`) — assert `refreshOnce` invoked exactly once and no interleaved creds read/write.
- **Gates:** root `npm test` `fail 0`; new test files wired into the canonical `npm test` chain (no un-wired-test false-green); UI `tsc -b`/`vite build` green (UI touched only if the panel must render the new field — minimal/optional).

---

## 7. Pinned-vs-open summary

**Pinned:** ships a `{ signedIn, tokenStatus, reason }` **data contract** (UI treatment downstream, not pinned); sealed `tokenStatus` enum **`fresh|stale_refreshable|unrecoverable`** (`unrecoverable` covers expired-no-refresh AND absent/unparseable — decision-relevant single value, human distinction in `reason`); `signedIn` strictly additive/backward-compatible (byte-identical for every pre-existing case — regression-guarded); facade projects `tokenStatus`+`reason` (reason when not `fresh`; `signedIn:false` entries unchanged aside from additive `tokenStatus`); new `src/runtime/authPreflight/` pure decision core + injected IO; preflight in `launchAgent` before `supervisor.launchAgent`, **Claude-provider only**, **serialized by an in-process mutex** at the wiring layer (race-safe + burst-dedups the refresh); refresh = **one** isolated **`claude --model haiku --print`** turn (llmJudge isolation pattern), TOAD never owns OAuth; `refreshOnce → { ok, authRejected, timedOut }` where **`ok` ≜ a turn *completed*** (not "no error"; timeout/kill/spawn-fail ⇒ `ok:false`); gate = proceed-on-`fresh` (no spawn) / **block on every knowably-dead state** (`unrecoverable`, definitive auth rejection, refresh consumed the refresh token, **or `ok:true` turn completed yet still stale** — the finding-#1 ruling that keeps goal #3) / **proceed+warn ONLY when the refresh turn did not complete** (`ok:false`/timeout — the sole genuinely-uncertain case) / **relaunch-guard** short-circuits a repeated stale preflight (`RELAUNCH_GUARD_MS` default 60_000) to block; blocked launch fails fast with actionable re-login reason; warn-and-proceed surfaced solely by the next honest `provider_auth_status` poll (no marker channel); L326-327 comment corrected; cost = single cheapest-tier refresh turn, stale-only, burst-deduped, no loop/scheduler.

**Open (resolved in implementation, not pre-invented):** the exact
`refreshOnce` exit/stderr classification separating *definitive auth
rejection* (`authRejected:true`) from *did-not-complete transient*
(`ok:false`) — derived from the real `claude --model haiku --print`
failure surface during implementation, mirroring how
`llmJudge`/`claudeUsageProbe` already classify CLI outcomes; the exact
provider-resolution call already available inside `launchAgent`; the
exact `RELAUNCH_GUARD_MS` literal (default 60_000, tune if field shows
otherwise); the optional UI chip wording. None change the architecture
or the §4.2 ruling.
