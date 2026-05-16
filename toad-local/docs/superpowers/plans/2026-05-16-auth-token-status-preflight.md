# Claude Auth Token-Status Honesty + Pre-Launch Preflight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude plan-auth status honest (a sealed `tokenStatus` that distinguishes a fresh token from an expired-but-refreshable one, propagated to the auth panel) and prevent the predictable mid-run 401 with a Claude-only pre-launch preflight that attempts the CLI's own refresh once and blocks only the provably-doomed launch.

**Architecture:** Layer A — `parseAnthropicFileStatus` gains a sealed `tokenStatus` (`fresh|stale_refreshable|unrecoverable`); `signedIn` is strictly additive (byte-identical for every pre-existing case); the facade `provider_auth_status` projection propagates `tokenStatus`+`reason`. Layer B — a new pure `src/runtime/authPreflight/` decision core + injected IO (`refreshOnce` = one isolated `claude --model haiku --print` turn reusing `llmJudge`'s isolation/Windows/timeout machinery), wired into `LocalToadRuntime.launchAgent` (before `supervisor.launchAgent`, only when `input.command` is the claude CLI) behind an in-process serialized mutex + relaunch-guard at the wiring layer.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict` (root suite, `node --no-warnings --test`, same pattern as `src/runtime/contextUsage/`/`eventNarration/`). Repo root `/c/Project-TOAD`; project `toad-local/`; commit to `main` via `git -C /c/Project-TOAD …`, `toad-local/`-prefixed paths, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Authoritative spec:** `docs/superpowers/specs/2026-05-16-auth-token-status-preflight-design.md` (`78ab37d`).

**Suite baseline:** root `npm test` `fail 0`; UI `tsc -b`/`vite build` green.

**Out of scope:** Codex/Gemini auth; background/proactive refresh loop or scheduler; TOAD owning the OAuth exchange; Sub-project C; the shipped eventNarration/locCount work.

---

## Grounded facts (verified in code — the plan is built on these)

- **`src/providers/providerAuth.js` `parseAnthropicFileStatus(authJson,_infoJson,providerId)` ≈L329-360.** Current branches: not-object/array → `{signedIn:false, reason:'credentials file did not parse as a JSON object'}`; no `claudeAiOauth.accessToken` → `{signedIn:false, reason:'no claudeAiOauth.accessToken in credentials file'}`; computes `now=Date.now()`, `expiresAt = typeof oauth.expiresAt==='number'?oauth.expiresAt:null`, `accessExpired = expiresAt!==null && expiresAt<now`, `hasRefresh = typeof oauth.refreshToken==='string' && oauth.refreshToken.length>0`; `if (accessExpired && !hasRefresh) return {signedIn:false, reason:'OAuth tokens expired and no refresh token to renew them'}`; else returns `{signedIn:true, user:null, plan, subscriptionType, authMethod:'claude.ai oauth', raw:{accessExpired,hasRefreshToken,scopes,rateLimitTier}}`. Comment ≈L320-327 ends "An expired access token + a refresh token still counts as signed in because the CLI silently refreshes on next use." (the falsified line).
- **No `TOKEN_STATUS` constant exists** anywhere; `providerAuth.js` exports `getAuthStatus`, `triggerAuthLogin`, `triggerAuthLogout`, `SUPPORTED_PROVIDERS`, `PROVIDER_AUTH_DEFINITIONS` (verify exact export list when editing).
- **Facade projection — `src/tools/localToolFacade.js` ≈L2360-2389.** `authStatus = providerGetAuthStatus({providerId, spawnSyncImpl:this.providerAuthSpawnSync, readFileImpl:this.providerAuthReadFile, statImpl:this.providerAuthStat})` in a try/catch (catch → `authStatus=null`); `const signedIn = authStatus && authStatus.signedIn === true;`; entry = `{ providerId, label, signedIn: signedIn||false, plan: authStatus?.plan ?? authStatus?.subscriptionType ?? null, user: authStatus?.user ?? null, reason: !signedIn ? (authStatus?.reason ?? null) : null, quota, symphonyUsage }`. `raw`/`tokenStatus` NOT propagated. This is the `provider_auth_status` surface.
- **`LocalToadRuntime.launchAgent(input)` ≈L404-450.** Isolation gate (`assertWorkspaceIsolated`, cwd requirement) → `scrubbedInput = {...input, env: buildScrubbedAgentEnv(...)}` → `launchInput = this.#withToadMcpConfig(scrubbedInput)` → `const runtime = await this.supervisor.launchAgent(launchInput)` (≈L450). **`input.command` carries the provider CLI**: `RuntimeSupervisor.launchAgent` does `const command = requireString(input.command,'command')` (RuntimeSupervisor.js:69) then `resolveWindowsCommand(command)` (≈L21-35, Windows `.cmd` shim + CVE-2024-27980). So the Claude-only hook is **the basename of `input.command` being the claude CLI**, available in `LocalToadRuntime.launchAgent` before L450. There is **no `input.provider`** — do not invent one.
- **Constructor DI seam:** `LocalToadRuntime` constructor params include `providerAuthSpawn=null`, `providerAuthSpawnSync=null` (≈L87-88), threaded at ≈L207-208; the facade already uses `this.providerAuthSpawnSync`/`providerAuthReadFile`/`providerAuthStat`. The preflight reuses this seam (inject spawn + creds-reader for tests).
- **`src/drift/llm/llmJudge.js` isolation/spawn/timeout precedent:** `CLAUDE_ISOLATION_FLAGS` (frozen array, ≈L88) used as `args:['--model',model,'--print',...CLAUDE_ISOLATION_FLAGS]` (≈L121); spawn-failure/non-zero-exit/timeout handling with `setTimeout(()=>{proc.kill('SIGKILL');reject('llmJudge: timeout after Nms…')}, timeoutMs)` (≈L354-356), default `timeoutMs=30_000`; Windows direct-`claude` EINVAL caveat (CVE-2024-27980, ≈L14) handled by its spawn wrapper. `refreshOnce` reuses these patterns; it does NOT reimplement spawn/timeout/Windows handling.
- **Test wiring:** root `package.json` `scripts.test` is a single `&&`-chain of `node [--no-warnings] [--test] test/<file>`; new tests append after the last entry (precedent: contextUsage/eventNarration/locCount). `ui/test/*` and `ui/src/**/*.test.ts` are NOT in the root chain.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/providers/providerAuth.js` *(modify ≈L320-360)* | `parseAnthropicFileStatus` emits sealed `tokenStatus`; export frozen `TOKEN_STATUS`; fix the L326-327 comment |
| `test/providerAuth.tokenStatus.test.js` *(create)* | Layer-A state-machine + `signedIn` additive regression guard + `TOKEN_STATUS` frozen |
| `src/tools/localToolFacade.js` *(modify ≈L2380-2389)* | provider entry propagates `tokenStatus`; `reason` when not `fresh`; `signedIn:false` byte-identical |
| `test/localToolFacade.authTokenStatus.test.js` *(create)* | facade projection: fresh/stale/unrecoverable/codex-gemini + `signedIn:false` regression guard |
| `src/runtime/authPreflight/claudeAuthPreflight.js` *(create)* | pure decision core `claudeAuthPreflight(...)` (§4.2 table incl. finding-#1 ruling + relaunch-guard) |
| `src/runtime/authPreflight/refreshOnce.js` *(create)* | real `refreshOnce` default — one isolated `claude --model haiku --print` turn → `{ok,authRejected,timedOut}` |
| `src/runtime/authPreflight/index.js` *(create)* | re-export `claudeAuthPreflight`, `defaultRefreshOnce` |
| `test/authPreflight.decision.test.js` *(create)* | decision-core table (every §4.2 branch, relaunch-guard, timeout) — injected IO |
| `test/authPreflight.refreshOnce.test.js` *(create)* | `refreshOnce` classification (injected spawn): completed→ok:true; auth-reject→authRejected; timeout→timedOut/ok:false; spawn-fail→ok:false |
| `src/app/LocalToadRuntime.js` *(modify ≈L404-450)* | Claude-only preflight before `supervisor.launchAgent`, serialized mutex + relaunch-guard map at wiring layer; block→throw, proceed→continue |
| `test/localToadRuntime.authPreflight.test.js` *(create)* | wiring: claude-block→no supervisor.launchAgent + actionable reason; non-claude→skipped; concurrent→refreshOnce once (mutex) |
| `package.json` *(modify)* | wire the 5 new test files into the canonical `npm test` chain |

**Commit policy (pinned — 2 atomic commits, A then B):**
- **Commit 1 = Layer A end-to-end** (Tasks 1–4): `parseAnthropicFileStatus`+`TOKEN_STATUS` and the facade projection that consumes it, with tests, wired + gated. Independently shippable: this alone fixes the "UI shows a bare ✓ that lies." The contract is *consumed in the same commit* (no dangling field).
- **Commit 2 = Layer B** (Tasks 5–9): preflight decision core, `refreshOnce`, the `launchAgent` wiring (mutex + relaunch-guard), tests, suite wiring, gated.
- Tasks within a commit accumulate uncommitted; the commit is the last task of each group. UI is **not** touched (the `provider_auth_status` data contract change is consumed by the existing UI poll; rendering the new field is downstream/optional and explicitly out of this plan — only the data contract ships).

---

## Task 1: `TOKEN_STATUS` sealed enum + `parseAnthropicFileStatus` tokenStatus

**Files:** Modify `src/providers/providerAuth.js`; Create `test/providerAuth.tokenStatus.test.js`

- [ ] **Step 1: Write the failing test** — create `test/providerAuth.tokenStatus.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_STATUS, PROVIDER_AUTH_DEFINITIONS } from '../src/providers/providerAuth.js';

// parseAnthropicFileStatus is not exported; exercise it via the public
// file-status path the same way the facade does — getAuthStatus with an
// injected readFile/stat that returns our fixture creds JSON.
import { getAuthStatus } from '../src/providers/providerAuth.js';

function statusFor(credsObj) {
  const json = JSON.stringify(credsObj);
  return getAuthStatus({
    providerId: 'anthropic',
    readFileImpl: () => json,
    statImpl: () => ({}), // existence ok
  });
}
const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 3_600_000;

test('TOKEN_STATUS is the frozen sealed set', () => {
  assert.deepEqual(TOKEN_STATUS, { FRESH: 'fresh', STALE_REFRESHABLE: 'stale_refreshable', UNRECOVERABLE: 'unrecoverable' });
  assert.throws(() => { TOKEN_STATUS.X = 1; }, TypeError);
});

test('fresh: not expired (future expiresAt) → signedIn:true tokenStatus:fresh', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: FUTURE, refreshToken: 'r', subscriptionType: 'max' } });
  assert.equal(s.signedIn, true);
  assert.equal(s.tokenStatus, 'fresh');
});

test('fresh: expiresAt absent → fresh (cannot prove expiry)', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
  assert.equal(s.signedIn, true);
  assert.equal(s.tokenStatus, 'fresh');
});

test('stale_refreshable: expired + refresh token → signedIn:true tokenStatus:stale_refreshable + reason', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: PAST, refreshToken: 'r' } });
  assert.equal(s.signedIn, true);
  assert.equal(s.tokenStatus, 'stale_refreshable');
  assert.equal(typeof s.reason, 'string');
  assert.ok(s.reason.length > 0);
});

test('unrecoverable: expired + no refresh → signedIn:false (UNCHANGED) tokenStatus:unrecoverable', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: PAST } });
  assert.equal(s.signedIn, false); // regression guard: byte-identical to today
  assert.equal(s.tokenStatus, 'unrecoverable');
  assert.equal(s.reason, 'OAuth tokens expired and no refresh token to renew them');
});

test('unrecoverable: no accessToken → signedIn:false (UNCHANGED) tokenStatus:unrecoverable', () => {
  const s = statusFor({ claudeAiOauth: {} });
  assert.equal(s.signedIn, false);
  assert.equal(s.tokenStatus, 'unrecoverable');
  assert.equal(s.reason, 'no claudeAiOauth.accessToken in credentials file');
});

test('unrecoverable: not a JSON object → signedIn:false (UNCHANGED) tokenStatus:unrecoverable', () => {
  const s = getAuthStatus({ providerId: 'anthropic', readFileImpl: () => '[]', statImpl: () => ({}) });
  assert.equal(s.signedIn, false);
  assert.equal(s.tokenStatus, 'unrecoverable');
  assert.equal(s.reason, 'credentials file did not parse as a JSON object');
});

test('expiresAt === now boundary → expired (now is not < now → NOT expired → fresh)', () => {
  const fixed = 1_900_000_000_000;
  const realNow = Date.now;
  Date.now = () => fixed;
  try {
    const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: fixed, refreshToken: 'r' } });
    // accessExpired = expiresAt < now → fixed < fixed → false → fresh
    assert.equal(s.tokenStatus, 'fresh');
  } finally { Date.now = realNow; }
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/providerAuth.tokenStatus.test.js`
Expected: FAIL — `TOKEN_STATUS` not exported / `tokenStatus` undefined.

- [ ] **Step 3: Implement** — in `src/providers/providerAuth.js`:

(a) Add the sealed export near the other top-level exports (e.g. just below `SUPPORTED_PROVIDERS`):

```javascript
// Sealed single source of truth for Claude OAuth token state (design
// §3). `unrecoverable` = no path to a working token from here — covers
// expired-with-no-refresh AND absent/unparseable creds (the gate treats
// them identically; the human distinction is in `reason`).
export const TOKEN_STATUS = Object.freeze({
  FRESH: 'fresh',
  STALE_REFRESHABLE: 'stale_refreshable',
  UNRECOVERABLE: 'unrecoverable',
});
```

(b) Replace the comment ≈L320-327's falsified last sentence. Change:
`* An expired access token + a refresh token still counts as signed in`
`* because the CLI silently refreshes on next use.`
to:
```
 * An expired access token + a refresh token is reported signedIn:true
 * but tokenStatus:'stale_refreshable' — the CLI's "silent refresh on
 * next use" is NOT reliable for a non-interactively-spawned stream-json
 * agent (it 401s mid-run), so the launch preflight (design §4) attempts
 * the refresh explicitly. This function only classifies; it never
 * refreshes.
```

(c) Add `tokenStatus` to every return of `parseAnthropicFileStatus` (additive only — do NOT change any existing `signedIn`/`reason`):
- not-object/array return → add `tokenStatus: TOKEN_STATUS.UNRECOVERABLE`
- no-`accessToken` return → add `tokenStatus: TOKEN_STATUS.UNRECOVERABLE`
- `accessExpired && !hasRefresh` return → add `tokenStatus: TOKEN_STATUS.UNRECOVERABLE`
- the final `signedIn:true` return: insert, just before it, the stale branch and tag the fresh one:

```javascript
  if (accessExpired && hasRefresh) {
    return {
      providerId, supported: true, signedIn: true,
      tokenStatus: TOKEN_STATUS.STALE_REFRESHABLE,
      reason: 'access token expired; a refresh token is present but the credentials have not been renewed yet',
      user: null,
      plan: subscriptionType ? `Claude ${subscriptionType.charAt(0).toUpperCase()}${subscriptionType.slice(1)}` : null,
      subscriptionType,
      authMethod: 'claude.ai oauth',
      raw: { accessExpired, hasRefreshToken: hasRefresh, scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [], rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null },
    };
  }
```

and add `tokenStatus: TOKEN_STATUS.FRESH,` to the existing final `signedIn:true` return object (the not-expired / no-expiresAt case). `subscriptionType` is already computed at that point (it is declared just above the final return today — confirm and reuse; if the stale branch is inserted *before* that declaration, move the `const subscriptionType = …` line above both branches so both use it).

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/providerAuth.tokenStatus.test.js`
Expected: PASS (all cases, incl. the three `signedIn:false` regression guards proving additivity).

---

## Task 2: existing providerAuth tests stay green (additive regression guard)

**Files:** none (verification only)

- [ ] **Step 1: Run the existing providerAuth suite**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/providerAuth.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`. The Task-1 change is strictly additive (only new `tokenStatus` keys + a new `accessExpired && hasRefresh` branch that previously fell through to `signedIn:true`); no existing assertion may regress. If any existing test fails, the change was NOT additive — fix `providerAuth.js` (never weaken a test).

---

## Task 3: Facade projection propagates `tokenStatus`

**Files:** Modify `src/tools/localToolFacade.js` (≈L2380-2389); Create `test/localToolFacade.authTokenStatus.test.js`

- [ ] **Step 1: Write the failing test** — create `test/localToolFacade.authTokenStatus.test.js`. Mirror the existing facade test harness in `test/localToolFacade.test.js` for constructing `LocalToolFacade` and dispatching the tool that returns the `providers` array (locate the exact tool/command + actor shape in `test/localToolFacade.test.js` — do NOT invent it; reuse the real construction). Inject `providerAuthReadFile`/`providerAuthStat` (or `providerGetAuthStatus`) so anthropic resolves to a chosen `tokenStatus`. Assertions (keep exactly):

```javascript
// fresh → signedIn:true, tokenStatus:'fresh', reason:null
// stale_refreshable → signedIn:true, tokenStatus:'stale_refreshable', reason non-null (NEW: surfaced though signedIn)
// unrecoverable → signedIn:false, tokenStatus:'unrecoverable', reason non-null
//   AND the entry is byte-identical to the pre-change shape EXCEPT the
//   additive tokenStatus key (regression guard: build the expected
//   object explicitly and deepEqual minus tokenStatus).
// codex / gemini entries → tokenStatus: null (no anthropic token concept)
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToolFacade.authTokenStatus.test.js`
Expected: FAIL — entry has no `tokenStatus`; stale entry shows `reason:null` (current `!signedIn` gate).

- [ ] **Step 3: Implement** — in `src/tools/localToolFacade.js`, in the provider entry object (≈L2380-2389) change exactly two things:

- add `tokenStatus: authStatus?.tokenStatus ?? null,`
- replace `reason: !signedIn ? (authStatus?.reason ?? null) : null,` with:
  `reason: (authStatus?.tokenStatus && authStatus.tokenStatus !== 'fresh') || !signedIn ? (authStatus?.reason ?? null) : null,`

Rationale: `signedIn:false` entries still surface `reason` exactly as today (the `|| !signedIn` keeps the old behavior — byte-identical); `stale_refreshable` (signedIn:true) now also surfaces it; `fresh` and Codex/Gemini (no `tokenStatus`) → `reason:null` as today. No other entry field changes.

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToolFacade.authTokenStatus.test.js`
Expected: PASS.

---

## Task 4: Wire Layer-A tests + gates + **Commit 1**

**Files:** Modify `package.json`

- [ ] **Step 1: Wire the two Layer-A test files** — append to `toad-local/package.json` `scripts.test`, after the last existing entry: `&& node --no-warnings --test test/providerAuth.tokenStatus.test.js && node --no-warnings --test test/localToolFacade.authTokenStatus.test.js`. Validate: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'));console.log('ok')"`.

- [ ] **Step 2: Full root suite**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`; the two new suites visibly executed (grep their unique titles in the run — the un-wired-test false-green trap). Fix code on any regression, never weaken a test.

- [ ] **Step 3: Commit 1** (explicit file list — unrelated untracked dirs exist; never `git add -A` broadly):

```bash
git -C /c/Project-TOAD add toad-local/src/providers/providerAuth.js toad-local/test/providerAuth.tokenStatus.test.js toad-local/src/tools/localToolFacade.js toad-local/test/localToolFacade.authTokenStatus.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(auth): honest Claude token-status (sealed tokenStatus + facade projection) (Layer A)

parseAnthropicFileStatus emits a sealed TOKEN_STATUS
(fresh|stale_refreshable|unrecoverable); signedIn is strictly additive
(byte-identical for every pre-existing case — regression-guarded). The
provider_auth_status facade projection now propagates tokenStatus and
surfaces reason whenever not fresh (signedIn:false entries unchanged).
The expired+refresh case is no longer a bare signedIn:true ✓ — the
panel can distinguish a stale token from a fresh one. Falsified
"silently refreshes on next use" comment corrected. Root suite fail 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -2
```

---

## Task 5: Preflight decision core (`claudeAuthPreflight`)

**Files:** Create `src/runtime/authPreflight/claudeAuthPreflight.js`, `src/runtime/authPreflight/index.js`, `test/authPreflight.decision.test.js`

- [ ] **Step 1: Write the failing tests** — create `test/authPreflight.decision.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeAuthPreflight } from '../src/runtime/authPreflight/index.js';
import { TOKEN_STATUS } from '../src/providers/providerAuth.js';

const FRESH = { tokenStatus: TOKEN_STATUS.FRESH };
const STALE = { tokenStatus: TOKEN_STATUS.STALE_REFRESHABLE, reason: 'stale' };
const DEAD = { tokenStatus: TOKEN_STATUS.UNRECOVERABLE, reason: 'no refresh' };
const T0 = 1_000_000;
function mk(overrides) {
  const calls = { refreshOnce: 0 };
  const base = {
    now: () => T0,
    relaunchState: new Map(),
    credsPath: '/creds',
    readCredsStatus: () => FRESH,
    refreshOnce: async () => { calls.refreshOnce += 1; return { ok: true, authRejected: false, timedOut: false }; },
    ...overrides,
  };
  return { base, calls };
}

test('fresh → proceed, refreshOnce NOT called', async () => {
  const { base, calls } = mk({ readCredsStatus: () => FRESH });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
  assert.equal(calls.refreshOnce, 0);
});

test('unrecoverable → block, refreshOnce NOT called', async () => {
  const { base, calls } = mk({ readCredsStatus: () => DEAD });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
  assert.equal(calls.refreshOnce, 0);
  assert.match(r.reason, /re-login|\/login/i);
});

test('stale → refresh → re-read fresh → proceed', async () => {
  let n = 0;
  const { base } = mk({ readCredsStatus: () => (n++ === 0 ? STALE : FRESH) });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
});

test('stale → refresh authRejected → block', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE,
    refreshOnce: async () => ({ ok: false, authRejected: true, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
});

test('stale → refresh, re-read unrecoverable → block', async () => {
  let n = 0;
  const { base } = mk({
    readCredsStatus: () => (n++ === 0 ? STALE : DEAD),
    refreshOnce: async () => ({ ok: true, authRejected: false, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
});

test('FINDING #1: refresh turn COMPLETED (ok:true) but still stale → BLOCK', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE, // both reads stale
    refreshOnce: async () => ({ ok: true, authRejected: false, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /re-login|\/login/i);
});

test('refresh did NOT complete (ok:false) and still stale → proceed+warn', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE,
    refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
  assert.equal(r.warn, true);
  assert.equal(r.tokenStatus, TOKEN_STATUS.STALE_REFRESHABLE);
});

test('timeout (timedOut:true ⇒ ok:false) and still stale → proceed+warn', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE,
    refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: true }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
  assert.equal(r.warn, true);
});

test('relaunch guard: prior proceed+warn for this credsPath within window → block, NO refreshOnce', async () => {
  const relaunchState = new Map();
  const { base, calls } = mk({ readCredsStatus: () => STALE, relaunchState, refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: false }) });
  const r1 = await claudeAuthPreflight(base);            // proceed+warn, records state
  assert.equal(r1.decision, 'proceed');
  const before = calls.refreshOnce;
  const r2 = await claudeAuthPreflight({ ...base, now: () => T0 + 30_000 }); // within 60s
  assert.equal(r2.decision, 'block');
  assert.equal(calls.refreshOnce, before, 'guard short-circuits before calling refreshOnce');
});

test('relaunch guard expires: prior proceed+warn but now beyond window → not short-circuited', async () => {
  const relaunchState = new Map();
  const { base } = mk({ readCredsStatus: () => STALE, relaunchState, refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: false }) });
  await claudeAuthPreflight(base);
  const r2 = await claudeAuthPreflight({ ...base, now: () => T0 + 120_000 }); // > 60s
  assert.equal(r2.decision, 'proceed'); // re-attempts (still ok:false → proceed+warn), not auto-blocked by the guard
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/authPreflight.decision.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/runtime/authPreflight/claudeAuthPreflight.js`:

```javascript
// Pure decision core (design §4.2). All IO injected. NO spawn/fs here —
// the wiring layer supplies readCredsStatus/refreshOnce and owns the
// mutex + relaunch-guard map. `ok` ≜ a `claude --print` turn COMPLETED
// (the CLI had the opportunity to refresh) — NOT merely "no error".
import { TOKEN_STATUS } from '../../providers/providerAuth.js';

export const RELAUNCH_GUARD_MS = 60_000;

const BLOCK_REASON =
  'Claude token expired and the automatic refresh did not succeed. '
  + 'Re-login: run `claude` in a terminal, then `/login`, and relaunch.';

/**
 * @param {object} a
 * @param {() => {tokenStatus:string, reason?:string}} a.readCredsStatus
 * @param {() => Promise<{ok:boolean,authRejected:boolean,timedOut:boolean}>} a.refreshOnce
 * @param {() => number} a.now
 * @param {Map<string,{outcome:string,at:number}>} a.relaunchState
 * @param {string} a.credsPath  key for the relaunch guard
 * @returns {Promise<{decision:'proceed'|'block', warn?:boolean, tokenStatus:string, reason?:string}>}
 */
export async function claudeAuthPreflight({ readCredsStatus, refreshOnce, now, relaunchState, credsPath }) {
  const s1 = readCredsStatus();
  if (s1.tokenStatus === TOKEN_STATUS.FRESH) {
    return { decision: 'proceed', tokenStatus: s1.tokenStatus };
  }
  if (s1.tokenStatus === TOKEN_STATUS.UNRECOVERABLE) {
    return { decision: 'block', tokenStatus: s1.tokenStatus, reason: s1.reason || BLOCK_REASON };
  }
  // stale_refreshable
  const prev = relaunchState.get(credsPath);
  if (prev && prev.outcome === 'warn' && (now() - prev.at) < RELAUNCH_GUARD_MS) {
    return { decision: 'block', tokenStatus: s1.tokenStatus, reason: BLOCK_REASON };
  }
  const r = await refreshOnce();
  const s2 = readCredsStatus();
  if (s2.tokenStatus === TOKEN_STATUS.FRESH) {
    relaunchState.delete(credsPath);
    return { decision: 'proceed', tokenStatus: s2.tokenStatus };
  }
  if (r.authRejected === true) {
    return { decision: 'block', tokenStatus: s2.tokenStatus, reason: BLOCK_REASON };
  }
  if (s2.tokenStatus === TOKEN_STATUS.UNRECOVERABLE) {
    return { decision: 'block', tokenStatus: s2.tokenStatus, reason: s2.reason || BLOCK_REASON };
  }
  if (r.ok === true) {
    // A turn COMPLETED yet creds are still stale: the CLI was given a
    // real use and did NOT refresh; the spawned agent's first turn is
    // the same use → provably-doomed. (Design §4.2 finding-#1 ruling.)
    return { decision: 'block', tokenStatus: s2.tokenStatus, reason: BLOCK_REASON };
  }
  // r.ok === false: the refresh turn never completed (spawn-fail /
  // timeout / kill / non-auth transient). The CLI never got the chance
  // to refresh — the ONLY genuinely-uncertain case. Proceed+warn, and
  // record it so a relaunch within the window short-circuits to block.
  relaunchState.set(credsPath, { outcome: 'warn', at: now() });
  return { decision: 'proceed', warn: true, tokenStatus: s2.tokenStatus, reason: s2.reason };
}
```

Create `src/runtime/authPreflight/index.js`:

```javascript
export { claudeAuthPreflight, RELAUNCH_GUARD_MS } from './claudeAuthPreflight.js';
export { defaultRefreshOnce } from './refreshOnce.js';
```

(Note: `index.js` re-exports `defaultRefreshOnce` — created in Task 6. Until Task 6, `test/authPreflight.decision.test.js` imports only `claudeAuthPreflight`; an ESM `export … from './refreshOnce.js'` for a not-yet-existing module is a load error, so in **this task** `index.js` must export ONLY `claudeAuthPreflight`/`RELAUNCH_GUARD_MS`; Task 6 Step 3 extends it to add the `defaultRefreshOnce` line. The decision test imports from `index.js` and only needs `claudeAuthPreflight`.)

Correct `index.js` for Task 5:

```javascript
export { claudeAuthPreflight, RELAUNCH_GUARD_MS } from './claudeAuthPreflight.js';
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/authPreflight.decision.test.js`
Expected: PASS (all branches incl. finding-#1 block, relaunch guard, timeout).

---

## Task 6: `refreshOnce` real default (isolated `claude --model haiku --print`)

**Files:** Create `src/runtime/authPreflight/refreshOnce.js`; modify `src/runtime/authPreflight/index.js`; Create `test/authPreflight.refreshOnce.test.js`

> The exit/stderr → `{ok,authRejected,timedOut}` classification is spec
> §7-Open: ground it against the real `claude --model haiku --print`
> failure surface, mirroring how `llmJudge.js`/`claudeUsageProbe.js`
> already classify CLI outcomes (run-and-tighten — start with the
> classification below, verify against a real expired-token run, tighten
> the `authRejected` matcher; never loosen it so a transient error is
> mis-tagged `authRejected` and over-blocks). Reuse `llmJudge`'s
> spawn/timeout/Windows machinery — do NOT reimplement it.

- [ ] **Step 1: Write the failing test** — create `test/authPreflight.refreshOnce.test.js` with an **injected spawn** (the function must accept a `spawnImpl` so no real `claude` runs in tests):

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRefreshOnce } from '../src/runtime/authPreflight/index.js';

// Minimal fake child process: emits the given exit code + stderr, or
// never exits (to exercise the timeout path).
function fakeSpawn({ code = 0, stderr = '', hang = false } = {}) {
  return () => {
    const listeners = {};
    const child = {
      stdout: { on() {} }, stderr: { on(ev, cb) { if (ev === 'data' && stderr) cb(Buffer.from(stderr)); } },
      on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
      kill() { (listeners.exit || []).forEach((cb) => cb(137, 'SIGKILL')); },
    };
    if (!hang) { setImmediate(() => (listeners.exit || []).forEach((cb) => cb(code, null))); }
    return child;
  };
}

test('completed (exit 0) → ok:true, authRejected:false, timedOut:false', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ code: 0 }), timeoutMs: 1000 });
  assert.deepEqual(r, { ok: true, authRejected: false, timedOut: false });
});

test('definitive auth rejection (401/credential stderr) → authRejected:true, ok:false', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ code: 1, stderr: 'API Error: 401 Invalid authentication credentials' }), timeoutMs: 1000 });
  assert.equal(r.authRejected, true);
  assert.equal(r.ok, false);
});

test('non-auth non-zero exit → ok:false, authRejected:false (transient class)', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ code: 1, stderr: 'network unreachable' }), timeoutMs: 1000 });
  assert.deepEqual(r, { ok: false, authRejected: false, timedOut: false });
});

test('timeout → timedOut:true, ok:false', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
});

test('spawn throws → ok:false, authRejected:false (did-not-run)', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: () => { throw new Error('ENOENT'); }, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: false, authRejected: false, timedOut: false });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/authPreflight.refreshOnce.test.js`
Expected: FAIL — `defaultRefreshOnce` not exported.

- [ ] **Step 3: Implement** — first read `src/drift/llm/llmJudge.js` for `CLAUDE_ISOLATION_FLAGS`, its Windows-safe spawn wrapper, and its timeout/kill block; reuse that exact machinery (import the shared spawn helper if `llmJudge` exposes one; otherwise mirror its `resolveWindowsCommand`/spawn/`SIGKILL`-on-timeout pattern — do not invent a new spawn approach). Create `src/runtime/authPreflight/refreshOnce.js`:

```javascript
// One isolated `claude --model haiku --print` turn whose ONLY purpose
// is to force the Claude CLI's own silent token refresh + rewrite of
// ~/.claude/.credentials.json. TOAD never parses a token or calls the
// OAuth endpoint. `ok` ≜ a turn COMPLETED (exit observed, not killed)
// so the CLI had the opportunity to refresh. Spawn/Windows/timeout
// mirror src/drift/llm/llmJudge.js (CVE-2024-27980 — never invoke a
// bare `claude` on win32 without that handling).
import { spawn as nodeSpawn } from 'node:child_process';
// If llmJudge.js exports a reusable isolation-flags const / spawn
// helper, import it instead of duplicating (DRY/§8c). Confirmed list of
// CLAUDE_ISOLATION_FLAGS is read from llmJudge.js at implementation time.

const REFRESH_PROMPT = 'ok'; // minimal one-token turn; output discarded
const DEFAULT_TIMEOUT_MS = 30_000;

// Definitive auth/credential rejection — distinguished from transient.
// Run-and-tighten against the real expired-token `claude --print`
// surface (spec §7); start strict, never loosen.
const AUTH_REJECT_RE = /\b401\b|invalid authentication credentials|unauthorized|not (?:logged in|authenticated)|please run .*\/login/i;

export function defaultRefreshOnce({
  spawnImpl = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  isolationFlags,            // injected from llmJudge's CLAUDE_ISOLATION_FLAGS at the call site
  command = 'claude',
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stderrBuf = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child && child.kill('SIGKILL'); } catch { /* ignore */ }
      done({ ok: false, authRejected: false, timedOut: true });
    }, timeoutMs);
    try {
      child = spawnImpl(command, ['--model', 'haiku', '--print', ...(isolationFlags || []), REFRESH_PROMPT], { windowsHide: true });
    } catch {
      done({ ok: false, authRejected: false, timedOut: false }); // did-not-run
      return;
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (d) => { stderrBuf += String(d); });
    }
    child.on('error', () => done({ ok: false, authRejected: false, timedOut: false }));
    child.on('exit', (code) => {
      // A turn COMPLETED iff we observed an exit (not a timeout-kill).
      if (code === 0) { done({ ok: true, authRejected: false, timedOut: false }); return; }
      const authRejected = AUTH_REJECT_RE.test(stderrBuf);
      done({ ok: false, authRejected, timedOut: false });
    });
  });
}
```

> The win32 bare-`claude` EINVAL handling: at the **call site** (Task 7
> wiring), `command`/spawn must go through the same
> `resolveWindowsCommand`-equivalent path `RuntimeSupervisor`/`llmJudge`
> use. Keep `defaultRefreshOnce` spawn-injected so the wiring layer
> supplies the Windows-safe spawn (and tests supply a fake). If
> `llmJudge` exports its spawn helper, pass it as `spawnImpl`.

Extend `src/runtime/authPreflight/index.js` to its final form:

```javascript
export { claudeAuthPreflight, RELAUNCH_GUARD_MS } from './claudeAuthPreflight.js';
export { defaultRefreshOnce } from './refreshOnce.js';
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/authPreflight.refreshOnce.test.js`
Expected: PASS. Then run `test/authPreflight.decision.test.js` again — still PASS (index.js extension is additive).

---

## Task 7: Wire the preflight into `LocalToadRuntime.launchAgent` (Claude-only, serialized)

**Files:** Modify `src/app/LocalToadRuntime.js` (≈L404-450); Create `test/localToadRuntime.authPreflight.test.js`

- [ ] **Step 1: Write the failing test** — create `test/localToadRuntime.authPreflight.test.js`. Construct `LocalToadRuntime` the way `test/localToadRuntime.test.js` does (mirror it — do NOT invent the constructor/supervisor fakes). Inject a fake `supervisor` whose `launchAgent` records calls, and inject the preflight deps (the constructor must accept an injectable `claudeAuthPreflight` / `refreshOnce` / creds-reader — added in Step 3). Assertions:

```javascript
// (a) input.command basename 'claude' + preflight → block:
//     launchAgent rejects/returns failure with the actionable reason;
//     supervisor.launchAgent NOT called.
// (b) input.command basename 'claude' + preflight → proceed:
//     supervisor.launchAgent called once (existing behavior preserved).
// (c) input.command 'codex' (or anything non-claude): preflight NEVER
//     invoked; supervisor.launchAgent called (no contention).
// (d) concurrent: two launchAgent calls, command 'claude', creds
//     initially stale then fresh after one refresh — assert refreshOnce
//     invoked EXACTLY once (the serialized mutex + second waiter
//     re-reads fresh), both launches proceed.
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.authPreflight.test.js`
Expected: FAIL — no preflight wired; block case still calls supervisor.

- [ ] **Step 3: Implement** — in `src/app/LocalToadRuntime.js`:

(a) Constructor: add injectable deps with real defaults, alongside the existing `providerAuthSpawn`/`providerAuthSpawnSync` params:
- `claudeAuthPreflightImpl = claudeAuthPreflight` (import from `../runtime/authPreflight/index.js`)
- `refreshOnceImpl = null` (when null, build the real `defaultRefreshOnce` bound with the Windows-safe spawn + `llmJudge`'s `CLAUDE_ISOLATION_FLAGS`)
- a private `#authPreflightMutex = Promise.resolve()` and `#authRelaunchState = new Map()` (wiring-layer state, NOT in the pure core)
- `readClaudeCredsStatus = () => parseAnthropicFileStatus-via-getAuthStatus({ providerId:'anthropic', readFileImpl:this.providerAuthReadFile, statImpl:this.providerAuthStat })` (reuse the existing provider-auth DI seam; import `getAuthStatus` + `TOKEN_STATUS` from `../providers/providerAuth.js`).

(b) A helper to detect the Claude CLI from `input.command` (grounded — provider lives in `input.command`, basename, Windows `.cmd`/`.exe` tolerant):

```javascript
function isClaudeCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  const base = command.split(/[\\/]/).pop().toLowerCase();
  return base === 'claude' || base === 'claude.cmd' || base === 'claude.exe' || base === 'claude.bat';
}
```

(c) In `launchAgent(input)`, **after** the isolation gate and env scrub, **before** `const runtime = await this.supervisor.launchAgent(launchInput);` (≈L450), insert the serialized Claude preflight:

```javascript
    if (isClaudeCommand(input && input.command)) {
      // Serialize all Claude preflights in-process: concurrent team
      // launches must not race `claude --print` on the single
      // ~/.claude/.credentials.json (partial read / duplicate refresh).
      // The second waiter re-reads status first, so a burst refreshes
      // at most once. (Design §4.3.)
      const credsPath = '~/.claude/.credentials.json';
      const runPreflight = async () => this.claudeAuthPreflightImpl({
        readCredsStatus: this.readClaudeCredsStatus,
        refreshOnce: this.#resolveRefreshOnce(),
        now: () => Date.now(),
        relaunchState: this.#authRelaunchState,
        credsPath,
      });
      const gate = this.#authPreflightMutex.then(runPreflight, runPreflight);
      // Keep the chain alive regardless of this gate's outcome.
      this.#authPreflightMutex = gate.then(() => {}, () => {});
      const verdict = await gate;
      if (verdict.decision === 'block') {
        throw new Error(verdict.reason);
      }
      // proceed (with or without warn): the still-stale creds mean the
      // next provider_auth_status poll already reports stale via Layer
      // A — no extra marker plumbing (design §4.3/§5).
    }
    const runtime = await this.supervisor.launchAgent(launchInput);
```

`#resolveRefreshOnce()` returns `this.refreshOnceImpl` if set, else a
closure calling `defaultRefreshOnce` with the Windows-safe spawn +
`llmJudge`'s `CLAUDE_ISOLATION_FLAGS` (import the flags/spawn helper
from `llmJudge.js`; if it does not export them, lift the minimal frozen
flags list into `refreshOnce.js` with a comment citing `llmJudge.js` as
the source of truth and a follow-up to share it — do NOT silently
diverge the isolation flags).

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.authPreflight.test.js`
Expected: PASS (block, proceed, non-claude-skip, concurrent-once).

- [ ] **Step 5: Existing LocalToadRuntime suite stays green**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0` (non-claude / no-command launches must be unaffected — the preflight is strictly gated on `isClaudeCommand`). Fix code on regression, never weaken a test.

---

## Task 8: Wire Layer-B tests + full gates

**Files:** Modify `package.json`

- [ ] **Step 1: Wire the three Layer-B test files** — append to `scripts.test`: `&& node --no-warnings --test test/authPreflight.decision.test.js && node --no-warnings --test test/authPreflight.refreshOnce.test.js && node --no-warnings --test test/localToadRuntime.authPreflight.test.js`. Validate JSON.

- [ ] **Step 2: Full root suite**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`; all five new suites visibly executed (grep unique titles — un-wired-test false-green trap).

- [ ] **Step 3: UI gate**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN` → `CLEAN`; `npm run build 2>&1 | tail -2` → `✓ built`. (UI is not modified by this plan — this gate proves the data-contract change broke nothing downstream.)

---

## Task 9: **Commit 2**

- [ ] **Step 1: Commit** (explicit file list):

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/authPreflight toad-local/test/authPreflight.decision.test.js toad-local/test/authPreflight.refreshOnce.test.js toad-local/src/app/LocalToadRuntime.js toad-local/test/localToadRuntime.authPreflight.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(auth): Claude pre-launch token preflight gate (Layer B)

New pure src/runtime/authPreflight/ (claudeAuthPreflight decision core
+ defaultRefreshOnce = one isolated `claude --model haiku --print` turn
reusing llmJudge isolation/Windows/timeout machinery). Wired into
LocalToadRuntime.launchAgent before supervisor.launchAgent, ONLY when
input.command is the claude CLI, behind an in-process serialized mutex
(+ relaunch-guard map) so concurrent team launches refresh at most
once. Gate: proceed-on-fresh (no spawn) / block every knowably-dead
state (unrecoverable, definitive auth rejection, refresh consumed the
token, OR a COMPLETED refresh turn that still didn't renew — the
finding-#1 ruling) / proceed+warn only when the refresh turn never
completed; relaunch-guard short-circuits a repeated stale launch.
Blocked launch fails fast with an actionable re-login error instead of
a cryptic mid-run 401. Root suite fail 0; UI tsc/build green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 2: Post-commit verify**

`git -C /c/Project-TOAD show --stat HEAD` — exactly the listed files, no stray. `git -C /c/Project-TOAD status --porcelain` — clean of plan files (only unrelated untracked dirs remain). HEAD~1 = Commit 1.

---

## Self-Review (plan author)

**1. Spec coverage:** §1 honest data contract → T1 (tokenStatus) + T3 (facade) + T4 commit; success-criterion #3 (every knowably-dead state blocks, proceed+warn only the did-not-complete case) → T5 decision core (explicit finding-#1 test) + T7 wiring. §2 grounded reality → Grounded-facts section. §3.1 sealed enum + 4-row table + signedIn additive → T1 (+ T2 regression run). §3.2 facade projection + signedIn:false byte-identical → T3. §4.1 module + refreshOnce `{ok,authRejected,timedOut}`, `ok≜completed`, `--model haiku`, llmJudge isolation → T5/T6. §4.2 decision table incl. finding-#1 block + relaunch-guard (RELAUNCH_GUARD_MS=60_000) → T5. §4.3 launchAgent wiring, Claude-only via `input.command`, serialized mutex at wiring layer → T7. §4.4 cost (single haiku turn, stale-only, burst-deduped) → enforced by T7 mutex + T5 fresh-no-refresh + relaunch-guard. §5 surfacing (block→throw actionable; warn→next honest poll, no marker) → T7. §6 testing (state machine, facade, decision table, refreshOnce classification, wiring, concurrent) → T1/T3/T5/T6/T7; gates+wiring → T4/T8. §7 Open items (refreshOnce classification, provider-resolution, RELAUNCH_GUARD_MS literal) → resolved: provider-resolution grounded to `input.command`/`isClaudeCommand`; classification = `AUTH_REJECT_RE` run-and-tighten (T6 note); RELAUNCH_GUARD_MS=60_000 pinned. Non-goals respected (no UI change, no Codex/Gemini, no background loop, no owned OAuth).

**2. Placeholder scan:** No TBD/"handle errors". The two "ground at implementation" notes (T6 `AUTH_REJECT_RE` run-and-tighten; the `llmJudge` isolation-flags import-or-lift) are bounded with a starting implementation + an explicit "never loosen / cite source" rule — not placeholders. T3 Step-1 and T7 Step-1 say "mirror the real harness in test/localToolFacade.test.js / test/localToadRuntime.test.js" (named file, assertions fixed, only plumbing adapts) — same bounded pattern used successfully in prior slices, not a TBD.

**3. Type consistency:** `TOKEN_STATUS` (frozen `{FRESH,STALE_REFRESHABLE,UNRECOVERABLE}`) defined in T1 (`providerAuth.js`), imported by T5 decision core + tests — single source, consistent. `claudeAuthPreflight({readCredsStatus,refreshOnce,now,relaunchState,credsPath}) → {decision:'proceed'|'block', warn?, tokenStatus, reason?}` identical T5 ↔ T7 wiring ↔ tests. `refreshOnce()/defaultRefreshOnce({spawnImpl,timeoutMs,isolationFlags,command}) → {ok,authRejected,timedOut}` identical T6 ↔ T5 consumption ↔ T7 ↔ tests. `index.js` re-export is incremental (T5: claudeAuthPreflight+RELAUNCH_GUARD_MS only; T6 extends with defaultRefreshOnce — the ESM-load-order trap is pre-empted in T5 Step-3's note, same lesson as the readability T10 ratification). `isClaudeCommand` defined once in T7. Facade entry gains exactly `tokenStatus` + the widened `reason` ternary — consistent T3 ↔ its test.
