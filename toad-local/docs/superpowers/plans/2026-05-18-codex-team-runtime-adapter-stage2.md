# Codex Team-Runtime Adapter — SP1a Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex team agents multi-turn and message-driven — session continuity across turns (`codex exec resume`), wake-on-message delivery, crash reconciliation, a session-aware stuck-monitor, and a configurable per-turn timeout.

**Architecture:** Stage 1 shipped a childless per-turn `CodexExecAdapter` (one `codex exec` process per `sendTurn`) registered via `RuntimeSupervisor.registerSessionAgent` with `deliveryMode:'session_turn'`. Stage 2 adds *continuity orchestration only* — the parse layer (`normalizeCodexExecLine`) needs **zero change** (verified against real codex 0.130: resume re-emits `thread.started` with the **same** `thread_id` and identical `--json` vocabulary; grounding §10). A nullable `cli_session_id` registry column persists Codex's disk-session id; the adapter dispatches first-turn-vs-`resume` argv off it, serializes turns FIFO per agent (coalescing concurrent messages into one batched resume), falls back to a fresh first-turn on session loss, and times out long turns. `DeliveryWorker` becomes `session_turn`-aware (wake = `adapter.sendTurn`); a boot pass reconciles undelivered inboxes; the stuck detector skips idle session agents and flags only in-flight stalled turns.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`, `node:sqlite` (`DatabaseSync`), existing TOAD broker / runtime-registry / supervisor / delivery layers.

**Authoritative design:** `docs/superpowers/specs/2026-05-17-codex-team-runtime-adapter-design.md` §4 (resume / `cliSessionId` / FIFO), §5 (wake-on-message), §8 (edge matrix), §9 (Stage-2 tests). **Grounding:** `docs/superpowers/grounding/2026-05-17-codex-cli.md` §9 (first-turn vocab) + §10 (resume contract: argv `codex exec resume --json --skip-git-repo-check <id> -`, stdin=message, `cwd=<worktree>`, NO `-C`/`--sandbox`; `thread.started` re-emits same `thread_id`; vocab identical to first-turn).

**Conventions:** Backend-only (no UI). TDD throughout (red→green, watch every test fail first). The Claude / `runtime_stdin` path must be **provably byte-unchanged** (every new behaviour behind a `deliveryMode==='session_turn'` / `providerId==='openai'` branch or an optional injected dependency that defaults to Stage-1 behaviour). Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, `git -c commit.gpgsign=false`, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. One commit per task. Subagent-driven execution: fresh implementer per task, two-stage review (spec-compliance then code-quality), controller independently verifies every DONE; mandatory whole-impl review + full root-suite gate before the final wrap.

---

## File Structure

**Modify:**
- `src/storage/sqlite.js` — add the idempotent `cli_session_id` column migration (Task 1).
- `src/runtime/sqliteRuntimeRegistry.js` — `setRuntimeCliSessionId(...)` + expose `cliSessionId` in `#rowToRuntime` (Task 1).
- `src/runtime/adapterForProvider.js` — thread optional `sessionStore` into `CodexExecAdapter` (Task 3).
- `src/app/LocalToadRuntime.js` — build the registry-backed session store + a `turnTimeoutMs` and pass them through the `createAdapter` closure; boot reconciliation pass (Tasks 3, 9).
- `src/runtime/CodexExecAdapter.js` — resume dispatch + session capture (Task 4), FIFO + coalescing (Task 5), per-turn timeout (Task 6), session-loss fallback (Task 7), `isTurnInFlight()`/`turnStartedAt` + turn-start `runtime_event` (Task 11).
- `src/delivery/deliveryWorker.js` — `session_turn` wake-on-message branch (Task 8).
- `src/diagnostics/stuckRuntimeDetector.js` — session-aware branch (Task 10).
- `src/diagnostics/stuckRuntimeMonitor.js` — build the `sessionInFlight` map from the supervisor and pass it to the detector (Task 11).
- `scripts/test-suites.txt` — append the new Stage-2 suites (Task 12).

**Create:**
- `src/runtime/codex/runtimeRegistrySessionStore.js` — the `{get,set,clear}` session store backed by the runtime registry (Task 2).
- `src/runtime/codex/reconcileSessionInboxes.js` — pure helper computing which session agents have undelivered inbox messages (Task 9).
- Test files: `test/codex/runtimeRegistrySessionStore.test.js`, `test/codex/codexExecAdapter.resume.test.js`, `test/codex/codexExecAdapter.fifo.test.js`, `test/codex/codexExecAdapter.timeout.test.js`, `test/codex/codexExecAdapter.sessionLoss.test.js`, `test/codex/deliveryWorker.sessionTurn.test.js`, `test/codex/reconcileSessionInboxes.test.js`, `test/codex/stuckRuntime.sessionAware.test.js`, `test/codex/codexStage2.e2e.test.js`. Extend `test/sqliteRuntimeRegistry.test.js`.

**Untouched (byte-identical):** `ClaudeStreamJsonAdapter`, `CodexFoundryAdapter`, `normalizeCodexExecLine` (verified sufficient), `RuntimeSupervisor` (consumed, not modified — `getAdapter`/`registerSessionAgent`/`stopAgent` already suffice), `RuntimeAdapter`, the broker, `runtimeDirectory`.

---

### Task 1: Persist the Codex session id (`cli_session_id` registry column)

**Files:**
- Modify: `src/storage/sqlite.js:37-51` (`applyMigrations`)
- Modify: `src/runtime/sqliteRuntimeRegistry.js:269-289` (`#rowToRuntime`); add `setRuntimeCliSessionId` near `markRuntimeStopped` (after line 257)
- Test: `test/sqliteRuntimeRegistry.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/sqliteRuntimeRegistry.test.js` (uses the existing `withRegistry` helper at the top of that file):

```javascript
test('cliSessionId defaults null, persists via setRuntimeCliSessionId, survives reopen, preserved across re-upsert', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'r-codex-1', teamId: 'team-a', agentId: 'dev-1',
      providerId: 'openai', command: 'codex', deliveryMode: 'session_turn',
      status: 'running', startedAt: '2026-05-18T00:00:00.000Z',
    });
    assert.equal(registry.getRuntime('r-codex-1').cliSessionId, null);

    const updated = registry.setRuntimeCliSessionId({ runtimeId: 'r-codex-1', cliSessionId: 'sess-abc' });
    assert.equal(updated.cliSessionId, 'sess-abc');
    assert.equal(registry.getRuntime('r-codex-1').cliSessionId, 'sess-abc');

    // A later re-registration of the same runtime must NOT clobber the session id.
    registry.upsertRuntime({
      runtimeId: 'r-codex-1', teamId: 'team-a', agentId: 'dev-1',
      providerId: 'openai', command: 'codex', deliveryMode: 'session_turn',
      status: 'running', startedAt: '2026-05-18T00:00:00.000Z',
    });
    assert.equal(registry.getRuntime('r-codex-1').cliSessionId, 'sess-abc');

    // Clearing (session-loss) sets it back to null.
    assert.equal(registry.setRuntimeCliSessionId({ runtimeId: 'r-codex-1', cliSessionId: null }).cliSessionId, null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="cliSessionId defaults null" test/sqliteRuntimeRegistry.test.js`
Expected: FAIL — `registry.setRuntimeCliSessionId is not a function` (and `cliSessionId` is `undefined`, not `null`).

- [ ] **Step 3: Add the idempotent migration**

In `src/storage/sqlite.js`, inside `applyMigrations(db)`, add after the existing `task_id` line (line 39):

```javascript
  // SP1a Stage 2: persist Codex's disk-session id for `codex exec resume`.
  try { db.exec('ALTER TABLE runtime_instances ADD COLUMN cli_session_id TEXT'); } catch {}
```

- [ ] **Step 4: Expose the column on reads**

In `src/runtime/sqliteRuntimeRegistry.js`, in `#rowToRuntime(row)` (currently ends at `taskId: row.task_id || null,`), add one field:

```javascript
      taskId: row.task_id || null,
      cliSessionId: row.cli_session_id || null,
```

- [ ] **Step 5: Add the dedicated writer**

In `src/runtime/sqliteRuntimeRegistry.js`, add this method immediately after `markRuntimeStopped(...)` (after line 257, before `#ensureTeam`):

```javascript
  setRuntimeCliSessionId({ runtimeId, cliSessionId }) {
    const id = requireString(runtimeId, 'runtimeId');
    if (!this.getRuntime(id)) {
      throw new Error(`unknown runtime: ${id}`);
    }
    const value = typeof cliSessionId === 'string' && cliSessionId.length > 0 ? cliSessionId : null;
    this.db.prepare(
      'UPDATE runtime_instances SET cli_session_id = ?, updated_at = ? WHERE runtime_id = ?'
    ).run(value, new Date().toISOString(), id);
    return this.getRuntime(id);
  }
```

Note: `upsertRuntime` is intentionally **not** modified — `cli_session_id` is absent from its INSERT column list (so a new row defaults `NULL`) and absent from its `ON CONFLICT DO UPDATE SET` clause (so a re-registration preserves an existing id). This is what the test's "preserved across re-upsert" assertion verifies.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test --test-name-pattern="cliSessionId defaults null" test/sqliteRuntimeRegistry.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full registry suite (no regression)**

Run: `node --test test/sqliteRuntimeRegistry.test.js`
Expected: all tests pass, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/storage/sqlite.js toad-local/src/runtime/sqliteRuntimeRegistry.js toad-local/test/sqliteRuntimeRegistry.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): persist cli_session_id on runtime registry (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Registry-backed session store

A tiny `{ get, set, clear }` adapter over the runtime registry so `CodexExecAdapter` reads/writes the session id without depending on the registry's full surface. Pure logic over an injected registry — standalone-testable with a fake.

**Files:**
- Create: `src/runtime/codex/runtimeRegistrySessionStore.js`
- Test: `test/codex/runtimeRegistrySessionStore.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/runtimeRegistrySessionStore.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntimeRegistrySessionStore } from '../../src/runtime/codex/runtimeRegistrySessionStore.js';

function fakeRegistry() {
  const rows = new Map();
  return {
    _rows: rows,
    getRuntime: (id) => (rows.has(id) ? { runtimeId: id, cliSessionId: rows.get(id) } : null),
    setRuntimeCliSessionId: ({ runtimeId, cliSessionId }) => {
      rows.set(runtimeId, typeof cliSessionId === 'string' && cliSessionId.length > 0 ? cliSessionId : null);
      return { runtimeId, cliSessionId: rows.get(runtimeId) };
    },
  };
}

test('get returns null when unset; set then get round-trips; clear nulls it', () => {
  const reg = fakeRegistry();
  reg._rows.set('r1', null);
  const store = makeRuntimeRegistrySessionStore(reg);

  assert.equal(store.get('r1'), null);
  store.set('r1', 'sess-1');
  assert.equal(store.get('r1'), 'sess-1');
  store.clear('r1');
  assert.equal(store.get('r1'), null);
});

test('get returns null for an unknown runtime (never throws)', () => {
  const store = makeRuntimeRegistrySessionStore(fakeRegistry());
  assert.doesNotThrow(() => store.get('missing'));
  assert.equal(store.get('missing'), null);
});

test('set/clear on an unknown runtime are swallowed (best-effort, never throw)', () => {
  const reg = { getRuntime: () => null, setRuntimeCliSessionId: () => { throw new Error('unknown runtime: x'); } };
  const store = makeRuntimeRegistrySessionStore(reg);
  assert.doesNotThrow(() => store.set('x', 'sess'));
  assert.doesNotThrow(() => store.clear('x'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/runtimeRegistrySessionStore.test.js`
Expected: FAIL — cannot find module `runtimeRegistrySessionStore.js`.

- [ ] **Step 3: Implement the store**

Create `src/runtime/codex/runtimeRegistrySessionStore.js`:

```javascript
// SP1a Stage 2 — the {get,set,clear} session-id store CodexExecAdapter
// uses for first-turn-vs-resume dispatch, backed by the runtime
// registry's nullable cli_session_id column. Total / never-throws:
// session persistence is best-effort continuity, never a turn-blocker
// (a failed read just degrades to a fresh first turn).
export function makeRuntimeRegistrySessionStore(registry) {
  return {
    get(runtimeId) {
      try {
        const row = registry.getRuntime(runtimeId);
        return row && typeof row.cliSessionId === 'string' && row.cliSessionId.length > 0
          ? row.cliSessionId
          : null;
      } catch {
        return null;
      }
    },
    set(runtimeId, cliSessionId) {
      try { registry.setRuntimeCliSessionId({ runtimeId, cliSessionId }); } catch { /* best effort */ }
    },
    clear(runtimeId) {
      try { registry.setRuntimeCliSessionId({ runtimeId, cliSessionId: null }); } catch { /* best effort */ }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/runtimeRegistrySessionStore.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/codex/runtimeRegistrySessionStore.js toad-local/test/codex/runtimeRegistrySessionStore.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): registry-backed session-id store (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Thread `sessionStore` (and `turnTimeoutMs`) into `CodexExecAdapter`

The supervisor calls `createAdapter({ runtimeId, teamId, agentId, child, providerId, cwd, systemPrompt })` (RuntimeSupervisor.js:239-243). We extend `createAdapterForProvider` to accept and forward an optional `sessionStore` + `turnTimeoutMs`, and have `LocalToadRuntime` pass a closure that injects the registry-backed store. The Claude branch is byte-unchanged; absent `sessionStore` ⇒ Stage-1 behaviour (always first-turn).

**Files:**
- Modify: `src/runtime/adapterForProvider.js:11-16`
- Modify: `src/runtime/CodexExecAdapter.js:15-28` (constructor only — accept + store the deps; behaviour lands in Tasks 4-7)
- Modify: `src/app/LocalToadRuntime.js` (the `RuntimeSupervisor` construction site — pass a `createAdapter` closure)
- Test: `test/codex/adapterForProvider.test.js` (extend), `test/codex/codexExecAdapter.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/codex/adapterForProvider.test.js`:

```javascript
test('createAdapterForProvider threads sessionStore + turnTimeoutMs into the Codex adapter; Claude branch ignores them', async () => {
  const { createAdapterForProvider } = await import('../../src/runtime/adapterForProvider.js');
  const sessionStore = { get: () => null, set: () => {}, clear: () => {} };
  const codex = createAdapterForProvider({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', providerId: 'openai',
    cwd: '/w', systemPrompt: 'sp', sessionStore, turnTimeoutMs: 1234,
  });
  assert.equal(codex.providerId, 'openai');
  assert.equal(codex.sessionStore, sessionStore);
  assert.equal(codex.turnTimeoutMs, 1234);

  const claude = createAdapterForProvider({
    runtimeId: 'r2', teamId: 't1', agentId: 'lead', providerId: 'anthropic',
    child: null, sessionStore, turnTimeoutMs: 1234,
  });
  assert.equal(claude.providerId, 'anthropic');
  assert.equal(claude.sessionStore, undefined); // never leaks into Claude
});
```

Append to `test/codex/codexExecAdapter.test.js`:

```javascript
test('constructor accepts optional sessionStore + turnTimeoutMs (defaults: no store, generous timeout)', () => {
  const a = makeAdapter(fakeChild([]));
  assert.equal(a.sessionStore, null);
  assert.equal(typeof a.turnTimeoutMs, 'number');
  assert.ok(a.turnTimeoutMs >= 600000); // generous default (≥10 min) — team turns are long
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/codex/adapterForProvider.test.js test/codex/codexExecAdapter.test.js`
Expected: FAIL — `codex.sessionStore` is `undefined`/missing; `a.sessionStore` is `undefined`; `a.turnTimeoutMs` is `undefined`.

- [ ] **Step 3: Extend `createAdapterForProvider`**

Replace the body of `src/runtime/adapterForProvider.js` (keep the file header comment):

```javascript
export function createAdapterForProvider({
  runtimeId, teamId, agentId, child, providerId, cwd, systemPrompt,
  sessionStore, turnTimeoutMs,
}) {
  if (providerId === 'openai') {
    return new CodexExecAdapter({ runtimeId, teamId, agentId, cwd, systemPrompt, sessionStore, turnTimeoutMs });
  }
  return new ClaudeStreamJsonAdapter({ runtimeId, teamId, agentId, child });
}
```

- [ ] **Step 4: Extend the `CodexExecAdapter` constructor**

In `src/runtime/CodexExecAdapter.js`, change the constructor signature + body. Current:

```javascript
  constructor({ runtimeId, teamId, agentId, cwd, systemPrompt = '', spawnImpl, resolveCliImpl } = {}) {
    super('openai');
    this.runtimeId = requireString(runtimeId, 'runtimeId');
    this.teamId = requireString(teamId, 'teamId');
    this.agentId = requireString(agentId, 'agentId');
    this.cwd = requireString(cwd, 'cwd');
    this.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn;
    this.resolveCliImpl = typeof resolveCliImpl === 'function' ? resolveCliImpl : defaultResolveCli;
    this.child = null;
    this._queue = [];
    this._waiters = [];
    this._ended = false;
  }
```

Replace with (adds the two deps + the FIFO chain seed + in-flight tracking used by later tasks):

```javascript
  constructor({ runtimeId, teamId, agentId, cwd, systemPrompt = '', spawnImpl, resolveCliImpl, sessionStore, turnTimeoutMs } = {}) {
    super('openai');
    this.runtimeId = requireString(runtimeId, 'runtimeId');
    this.teamId = requireString(teamId, 'teamId');
    this.agentId = requireString(agentId, 'agentId');
    this.cwd = requireString(cwd, 'cwd');
    this.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn;
    this.resolveCliImpl = typeof resolveCliImpl === 'function' ? resolveCliImpl : defaultResolveCli;
    this.sessionStore = sessionStore && typeof sessionStore.get === 'function' ? sessionStore : null;
    this.turnTimeoutMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0
      ? turnTimeoutMs
      : 30 * 60_000; // 30 min — team turns are long autonomous runs (spec §8)
    this.child = null;
    this._queue = [];
    this._waiters = [];
    this._ended = false;
    this._chain = Promise.resolve();   // FIFO per-agent turn serializer (Task 5)
    this._pendingTexts = [];           // coalesced messages awaiting the next turn (Task 5)
    this._turnStartedAt = null;        // ISO while a turn is in-flight (Task 11)
  }
```

- [ ] **Step 5: Wire the closure in `LocalToadRuntime`**

In `src/app/LocalToadRuntime.js`, find where `RuntimeSupervisor` is constructed with `createAdapter: createAdapterForProvider` (search `createAdapterForProvider`). Replace that argument with a closure that injects the registry-backed store and the configurable timeout. Add near the other imports:

```javascript
import { makeRuntimeRegistrySessionStore } from '../runtime/codex/runtimeRegistrySessionStore.js';
```

At the `RuntimeSupervisor` construction, where `this.runtimeRegistry` (the `SqliteRuntimeRegistry`) is already available, replace `createAdapter: createAdapterForProvider` with:

```javascript
      createAdapter: (adapterArgs) => createAdapterForProvider({
        ...adapterArgs,
        sessionStore: this.runtimeRegistry
          ? makeRuntimeRegistrySessionStore(this.runtimeRegistry)
          : undefined,
        turnTimeoutMs: this.codexTurnTimeoutMs,
      }),
```

And in the `LocalToadRuntime` constructor, accept the optional override (place beside the other `this.x = x` constructor assignments):

```javascript
    this.codexTurnTimeoutMs = Number.isFinite(opts?.codexTurnTimeoutMs) && opts.codexTurnTimeoutMs > 0
      ? opts.codexTurnTimeoutMs
      : undefined; // undefined ⇒ adapter's 30-min default
```

(Replace `opts` with this file's actual constructor parameter name — inspect the constructor signature; the other `this.* = ` assignments show the exact name.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/codex/adapterForProvider.test.js test/codex/codexExecAdapter.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Claude-byte-unchanged guard**

Run: `node --test test/codex/registerSessionAgentStop.test.js test/codex/localToadRuntime.codexLaunch.test.js test/localToadRuntime.authPreflight.test.js`
Expected: all PASS, `# fail 0` (the Claude/`runtime_stdin` path and the launch dispatch are unaffected).

- [ ] **Step 8: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/adapterForProvider.js toad-local/src/runtime/CodexExecAdapter.js toad-local/src/app/LocalToadRuntime.js toad-local/test/codex/adapterForProvider.test.js toad-local/test/codex/codexExecAdapter.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): thread sessionStore + turnTimeoutMs into CodexExecAdapter (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: First-turn-vs-`resume` dispatch + session-id capture

The adapter chooses argv off `sessionStore.get(runtimeId)`: null ⇒ first turn (existing Stage-1 argv, stdin = `systemPrompt\n\nmessage`); a value ⇒ resume (grounding §10 argv, stdin = message only). On the `session_started` normalized event (from `thread.started`) it persists the id via `sessionStore.set`.

**Files:**
- Modify: `src/runtime/CodexExecAdapter.js` (`sendTurn` — the argv/stdin construction + the `session_started` capture in the `onData` loop)
- Test: `test/codex/codexExecAdapter.resume.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/codexExecAdapter.resume.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function fakeChild(scriptLines, { exitCode = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  child.stdin = { write: (s) => { writes.push(String(s)); }, end: () => {
    setImmediate(() => {
      for (const l of scriptLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
  }, writable: true, destroyed: false };
  child.writes = writes;
  child.kill = () => { child.killed = true; };
  return child;
}

function memStore() {
  const m = new Map();
  return { get: (id) => (m.has(id) ? m.get(id) : null), set: (id, v) => m.set(id, v), clear: (id) => m.set(id, null), _m: m };
}

function makeAdapter(child, sessionStore) {
  const spawns = [];
  const a = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/work', systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return child(); },
    resolveCliImpl: (n) => n, sessionStore,
  });
  a._spawns = spawns;
  return a;
}

test('first turn (no session id) uses first-turn argv + prepends systemPrompt; captures + persists thread_id', async () => {
  const store = memStore();
  const a = makeAdapter(() => fakeChild([
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-xyz' }),
    JSON.stringify({ type: 'turn.completed' }),
  ]), store);
  const res = await a.sendTurn({ message: { text: 'do it' } });
  assert.equal(res.accepted, true);
  assert.deepEqual(a._spawns[0].args, ['exec', '--json', '--skip-git-repo-check', '-C', '/work', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-']);
  assert.equal(store.get('r1'), 'sess-xyz');
});

test('second turn (session id present) uses resume argv + message-only stdin (no systemPrompt)', async () => {
  const store = memStore();
  store.set('r1', 'sess-xyz');
  let writes;
  const a = makeAdapter(() => { const c = fakeChild([JSON.stringify({ type: 'thread.started', thread_id: 'sess-xyz' }), JSON.stringify({ type: 'turn.completed' })]); writes = c.writes; return c; }, store);
  const res = await a.sendTurn({ message: { text: 'follow up' } });
  assert.equal(res.accepted, true);
  assert.deepEqual(a._spawns[0].args, ['exec', 'resume', '--json', '--skip-git-repo-check', 'sess-xyz', '-']);
  assert.equal(writes.join(''), 'follow up');           // message only — NO "You are dev-1." prefix
  assert.ok(!writes.join('').includes('You are dev-1.'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/codexExecAdapter.resume.test.js`
Expected: FAIL — the resume test gets the first-turn argv (resume dispatch not implemented) and the systemPrompt is still prepended; the capture test's `store.get('r1')` is `null` (capture not implemented).

- [ ] **Step 3: Implement dispatch + capture**

In `src/runtime/CodexExecAdapter.js` `sendTurn(input)`, replace the prompt/argv construction. Current:

```javascript
    const text = requireString(input && input.message && input.message.text, 'message.text');
    const prompt = this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text;
    // RATIFIED (codex-cli 0.130.0, grounding d1e58e1): ...
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd,
      '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-'];
```

Replace with:

```javascript
    const text = requireString(input && input.message && input.message.text, 'message.text');
    const resumeId = this.sessionStore ? this.sessionStore.get(this.runtimeId) : null;
    const isResume = typeof resumeId === 'string' && resumeId.length > 0;
    // First turn: prepend systemPrompt (codex exec has no append-system-prompt
    // flag; conventions live in AGENTS.md). Resume: prior convo + instructions
    // are on disk — send the message only (grounding §10).
    const prompt = isResume
      ? text
      : (this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text);
    // RATIFIED argv: first-turn keeps the Stage-1 sandbox argv. Resume
    // (grounding §10, real codex 0.130) rejects -C/--sandbox (session-stored
    // cwd is authoritative; process is spawned with cwd=this.cwd) but accepts
    // --skip-git-repo-check (worktrees may not be git repos); `-` reads the
    // prompt from stdin (accepted on resume in 0.130).
    const args = isResume
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', resumeId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd,
        '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-'];
```

Then, in the same `sendTurn`, inside the `onData` loop where each normalized event is pushed (the `for (const ev of normalizeCodexExecLine(line, ctx))` block, right after `this.#push(ev);`), add session capture:

```javascript
          for (const ev of normalizeCodexExecLine(line, ctx)) {
            this.#push(ev);
            if (ev.type === 'session_started' && typeof ev.sessionId === 'string'
                && ev.sessionId.length > 0 && this.sessionStore) {
              this.sessionStore.set(this.runtimeId, ev.sessionId);
            }
            if (ev.type === 'turn_completed' && !settled) {
              settled = true;
              cleanup();
              resolve({ accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: this.runtimeId } });
            }
          }
```

(That is the existing block with the one new `if (ev.type === 'session_started' …)` clause inserted before the existing `turn_completed` clause. `resume` re-emits `thread.started` with the same id — `set` is therefore idempotent.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/codexExecAdapter.resume.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Stage-1 regression guard**

Run: `node --test test/codex/codexExecAdapter.test.js test/codex/normalizeCodexExecLine.test.js`
Expected: all PASS (Stage-1 first-turn behaviour unchanged when no `sessionStore` — `this.sessionStore` is `null`, so `resumeId` is `null`, first-turn path taken exactly as before).

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/CodexExecAdapter.js toad-local/test/codex/codexExecAdapter.resume.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): first-turn-vs-resume dispatch + session-id capture (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: FIFO per-agent turn serialization + concurrent-message coalescing

> **RATIFIED 2026-05-18 (controller, mid-execution):** the original Step-1
> test over-specified a microtask-timing detail — it issued three
> *synchronous* `sendTurn` calls and asserted "turn 1 = first; turn 2 =
> second+third (exactly 2 children)". That partition is **not** spec-mandated:
> spec §5 says a burst of pending messages is *batched into one resume turn*,
> so a synchronous burst coalescing into a single turn is spec-correct. The
> pure `_chain` serializer in Step 3 is correct and **race-free**; do **not**
> add a `_turnInFlight` "start turn 1 synchronously" shortcut to satisfy the
> old test — that shortcut lets a `sendTurn` arriving in the microtask gap
> between a turn's completion and the next queued drain take the fast path,
> **overwrite `_chain` (orphaning queued drains) and double-spawn**, an
> overlapping `codex exec` on one runtime that spec §4 explicitly says
> "corrupts continuity". The ratified test below is **staggered** (messages
> arrive *mid-turn*, the spec's actual model) so it is deterministic against
> the pure design, plus a burst test pinning the coalesce-into-one behaviour.

Spec §4: "turns serialized per agent (FIFO, one in-flight `codex exec resume` per `runtimeId`)". Spec §5: "mid-turn: enqueue; the next turn drains the inbox — multiple queued messages batch into one resume turn". Implement by wrapping the per-turn work in a serialized chain; calls arriving while a turn is in-flight have their message text appended to `_pendingTexts` and are satisfied by one coalesced follow-up turn. **No `_turnInFlight` flag / Path-A shortcut — pure `_chain` only (see RATIFIED note).**

**Files:**
- Modify: `src/runtime/CodexExecAdapter.js` (`sendTurn` becomes a thin enqueue wrapper around the existing per-turn body, now `#runTurn`)
- Test: `test/codex/codexExecAdapter.fifo.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/codexExecAdapter.fifo.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function gatedChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.release = () => {
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 's1' }) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
      child.emit('close', 0);
    });
  };
  child.stdin = { write: (s) => child.writes.push(String(s)), end: () => {}, writable: true };
  child.kill = () => { child.killed = true; };
  return child;
}

function makeFifoAdapter(children) {
  return new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: '',
    spawnImpl: () => { const c = gatedChild(); children.push(c); return c; },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
  });
}

test('FIFO: a turn runs alone; messages arriving MID-TURN coalesce into exactly ONE follow-up turn (no overlap)', async () => {
  const children = [];
  const a = makeFifoAdapter(children);

  // Turn 1 starts and is in-flight (child spawned, not released).
  const p1 = a.sendTurn({ message: { text: 'first' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1);

  // These arrive WHILE turn 1 is in-flight → queue + coalesce into the next turn.
  const p2 = a.sendTurn({ message: { text: 'second' } });
  const p3 = a.sendTurn({ message: { text: 'third' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1); // NO overlap — turn 2 has not started while turn 1 is in-flight

  children[0].release();
  const r1 = await p1;
  assert.equal(r1.accepted, true);

  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 2); // exactly one coalesced follow-up turn
  assert.match(children[1].writes.join(''), /second[\s\S]*third/);
  children[1].release();
  const [r2, r3] = await Promise.all([p2, p3]);
  assert.equal(r2.accepted, true);
  assert.equal(r3.accepted, true);
  assert.equal(children.length, 2); // 1 + 1 coalesced, never overlapping
});

test('a SYNCHRONOUS burst coalesces into a single turn carrying all messages (spec §5 batch; no overlap; all accepted)', async () => {
  const children = [];
  const a = makeFifoAdapter(children);

  const ps = [
    a.sendTurn({ message: { text: 'a' } }),
    a.sendTurn({ message: { text: 'b' } }),
    a.sendTurn({ message: { text: 'c' } }),
  ];
  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1); // burst batched into ONE in-flight turn (spec §5: carry the pending message(s))
  assert.match(children[0].writes.join(''), /a[\s\S]*b[\s\S]*c/);

  children[0].release();
  const rs = await Promise.all(ps);
  assert.ok(rs.every((r) => r.accepted === true)); // every caller satisfied — no message lost
  assert.equal(children.length, 1); // exactly one turn for the whole burst
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/codexExecAdapter.fifo.test.js`
Expected: FAIL — without the `_chain` serializer, the FIFO test's mid-turn `p2`/`p3` each spawn their own child immediately while turn 1 is in-flight, so `children.length === 3` at the post-`p2`/`p3` `setImmediate`, failing `assert.equal(children.length, 1)` (the no-overlap assertion); the burst test likewise spawns 3 children, failing its `children.length === 1`.

- [ ] **Step 3: Refactor `sendTurn` into an enqueue wrapper + `#runTurn`**

In `src/runtime/CodexExecAdapter.js`: rename the current `async sendTurn(input) { ... }` method body to a private `async #runTurn(text) { ... }` that takes the already-resolved message text (string) instead of `input`, and replace the line `const text = requireString(input && input.message && input.message.text, 'message.text');` inside it with using the `text` parameter directly (it is already a validated non-empty string — the validation moves to the wrapper). Everything else in the per-turn body (argv dispatch from Task 4, spawn, `onData`, resolve on `turn_completed`, close/err handling) stays identical.

Add the new public `sendTurn` as the FIFO + coalescing wrapper:

```javascript
  async sendTurn(input) {
    const text = requireString(input && input.message && input.message.text, 'message.text');
    // Coalesce: if a turn is already in-flight (or queued), this message
    // joins the pending batch and is satisfied by the next turn — spec §5
    // (batch multiple queued messages into one resume turn).
    this._pendingTexts.push(text);
    const run = this._chain.then(async () => {
      const batch = this._pendingTexts;
      if (batch.length === 0) return { accepted: true, responseState: 'coalesced', receipt: { written: true, runtimeId: this.runtimeId } };
      this._pendingTexts = [];
      return this.#runTurn(batch.join('\n\n'));
    });
    // Keep the chain alive even if a turn rejects (it shouldn't — #runTurn
    // resolves with {accepted:false} rather than throwing — but be safe).
    this._chain = run.then(() => {}, () => {});
    return run;
  }
```

Behaviour (pure `_chain`, race-free): every `sendTurn` pushes its text and chains a drain slot onto `_chain`; the first slot to run drains *whatever is currently pending* into one `#runTurn`, later slots that find `_pendingTexts` empty resolve immediately as `coalesced`. Two regimes, both spec-correct:

- **Staggered (the spec's model — messages arrive mid-turn):** call 1's slot runs first and drains `['first']` → turn 1. While turn 1 is in-flight, calls 2 & 3 push `'second'`/`'third'`; their slots are chained *after* turn 1. When turn 1 finishes, slot 2 drains `['second','third']` into ONE coalesced turn; slot 3 finds nothing → `coalesced`. Exactly two turns; no overlap (turn 2 cannot start until turn 1's slot settled — `_chain` guarantees it).
- **Synchronous burst:** all three push before any microtask drain runs, so the first slot drains `['a','b','c']` into ONE turn carrying all three; slots 2 & 3 → `coalesced`. One turn for the whole burst. This is spec §5 ("batch … into one resume turn"), **not** a defect — do not contort the design to split a synchronous burst.

In both regimes there is never more than one `#runTurn` in flight (FIFO per spec §4) and every caller gets an `accepted` receipt (no lost message). The `_chain = run.then(()=>{}, ()=>{})` tail keeps the serializer alive even if a turn rejects (it shouldn't — `#runTurn` resolves `{accepted:false}` rather than throwing).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/codexExecAdapter.fifo.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Regression guard (all prior Codex behaviour intact)**

Run: `node --test test/codex/codexExecAdapter.test.js test/codex/codexExecAdapter.resume.test.js test/codex/codexEndToEndProof.test.js`
Expected: all PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/CodexExecAdapter.js toad-local/test/codex/codexExecAdapter.fifo.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): FIFO per-agent turn serialization + message coalescing (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Configurable per-turn timeout

Spec §8: a generous, configurable per-turn cap; on cap → SIGTERM the in-flight child → `turn_failed(timeout)`. `turnTimeoutMs` is already on the constructor (Task 3, default 30 min). Add the timer to `#runTurn`.

**Files:**
- Modify: `src/runtime/CodexExecAdapter.js` (`#runTurn` — add a timeout timer around the in-flight child)
- Test: `test/codex/codexExecAdapter.timeout.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/codexExecAdapter.timeout.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function hangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, writable: true };
  child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
  return child; // never emits turn.completed on its own
}

test('a turn exceeding turnTimeoutMs is SIGTERM-killed and resolves turn_failed(timeout)', async () => {
  const child = hangingChild();
  const a = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: '',
    spawnImpl: () => child, resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
    turnTimeoutMs: 40,
  });
  const events = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; events.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'work forever' } });
  await a.stop();
  await pump;
  assert.equal(res.accepted, false);
  assert.equal(child.killed, true);
  const failed = events.find((e) => e.type === 'turn_failed');
  assert.ok(failed && /timeout/i.test(failed.error));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/codexExecAdapter.timeout.test.js`
Expected: FAIL — the test hangs until the node:test default timeout (no timeout logic yet); when it does end it is not a clean `turn_failed(timeout)`.

- [ ] **Step 3: Add the timeout timer to `#runTurn`**

In `src/runtime/CodexExecAdapter.js` `#runTurn`, inside the `return await new Promise((resolve) => { ... })`, declare a timer alongside `settled`/`lineBuf`/`stderrBuf` and arm it after the child is spawned. Add to the `cleanup` function a `clearTimeout`, and add the timeout handler:

```javascript
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try { if (child && typeof child.kill === 'function' && !child.killed) child.kill('SIGTERM'); } catch { /* ignore */ }
      }, this.turnTimeoutMs);
```

In `cleanup()` add as the first line: `clearTimeout(timeoutTimer);`

In the existing `onClose(code)` handler, make the failure message timeout-aware — replace its `this.#push({ ...ctx, type: 'turn_failed', error: ... })` line with:

```javascript
        this.#push({ ...ctx, type: 'turn_failed', error: timedOut
          ? `codex exec turn timeout after ${this.turnTimeoutMs}ms`
          : `codex exec exited (code=${code})${stderrBuf ? ` — ${stderrBuf.trim()}` : ''}` });
```

(The SIGTERM from the timeout makes the child emit `close`, which runs `onClose`; `timedOut` selects the timeout message. `onErr` path unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/codexExecAdapter.timeout.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Regression guard**

Run: `node --test test/codex/codexExecAdapter.test.js test/codex/codexExecAdapter.fifo.test.js test/codex/codexEndToEndProof.test.js`
Expected: all PASS (normal turns resolve well under the 30-min default; the proof and fifo suites unaffected).

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/CodexExecAdapter.js toad-local/test/codex/codexExecAdapter.timeout.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): configurable per-turn timeout → turn_failed(timeout) (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Session-loss fallback (stale/pruned `cliSessionId`)

Spec §5/§8: a `resume` whose session id is unknown/pruned must not wedge the agent — clear the id, emit a `runtime_event` "codex session reset", and retry **once** as a fresh first-turn carrying the same message + re-materialized systemPrompt. Never a lost message.

**Files:**
- Modify: `src/runtime/CodexExecAdapter.js` (`#runTurn` — detect the unknown-session failure and retry)
- Test: `test/codex/codexExecAdapter.sessionLoss.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/codexExecAdapter.sessionLoss.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function fakeChild(scriptLines, { exitCode = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.stdin = { write: (s) => child.writes.push(String(s)), end: () => {
    setImmediate(() => {
      for (const l of scriptLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
  }, writable: true };
  child.kill = () => { child.killed = true; };
  return child;
}

test('resume with an unknown session id clears it, emits codex_session_reset, retries as a fresh first-turn carrying the message', async () => {
  const m = new Map([['r1', 'stale-sess']]);
  const store = { get: (id) => (m.has(id) ? m.get(id) : null), set: (id, v) => m.set(id, v), clear: (id) => m.set(id, null) };
  const spawns = [];
  let call = 0;
  const a = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args) => {
      spawns.push(args);
      call += 1;
      if (call === 1) return fakeChild([], { exitCode: 1, stderr: 'Error: unknown session id: stale-sess' });
      return fakeChild([JSON.stringify({ type: 'thread.started', thread_id: 'fresh-sess' }), JSON.stringify({ type: 'turn.completed' })]);
    },
    resolveCliImpl: (n) => n, sessionStore: store,
  });
  const events = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; events.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'still must arrive' } });
  await a.stop();
  await pump;

  assert.equal(res.accepted, true);                       // recovered, not lost
  assert.deepEqual(spawns[0].slice(0, 2), ['exec', 'resume']);          // 1st attempt: resume
  assert.equal(spawns[1][0], 'exec');                                   // 2nd attempt: fresh first-turn
  assert.notEqual(spawns[1][1], 'resume');
  assert.equal(store.get('r1'), 'fresh-sess');                          // re-captured
  assert.ok(events.some((e) => e.type === 'runtime_event' && e.note === 'codex_session_reset'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/codexExecAdapter.sessionLoss.test.js`
Expected: FAIL — the first (resume) attempt fails and is surfaced as `turn_failed`; no retry happens, `res.accepted` is `false`, no `codex_session_reset` event, `store.get('r1')` is still `stale-sess`.

- [ ] **Step 3: Implement the fallback in `#runTurn`**

In `src/runtime/CodexExecAdapter.js`, factor the unknown-session detection and add a one-shot retry. At the top of the file (module scope, near the other helpers) add:

```javascript
const UNKNOWN_SESSION_RE = /unknown session|session not found|no (such )?session|session id .* not found|invalid session/i;
```

In `#runTurn(text)`, the method currently builds `isResume`/`resumeId`/`args` then spawns and resolves a Promise. Wrap the existing per-turn Promise body in a helper and add the retry. Concretely: keep the existing Promise as an inner `const attempt = (argv, stdinPrompt) => new Promise((resolve) => { ...existing body using argv/stdinPrompt... })`, then:

```javascript
    const firstTurnArgs = ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd,
      '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-'];
    const firstTurnPrompt = this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text;

    let result = await attempt(args, prompt);
    if (result.accepted !== true && isResume && UNKNOWN_SESSION_RE.test(result.__stderr || '')) {
      // The disk session is gone/pruned. Don't wedge the agent or lose the
      // message — reset to a fresh first turn carrying the same message.
      if (this.sessionStore) this.sessionStore.clear(this.runtimeId);
      this.#push({ runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId,
        type: 'runtime_event', note: 'codex_session_reset',
        detail: 'codex resume session unknown — restarting as a fresh session' });
      result = await attempt(firstTurnArgs, firstTurnPrompt);
    }
    return result;
```

For `UNKNOWN_SESSION_RE.test(result.__stderr || '')` to work, the `attempt` Promise's `onClose`/`onErr` failure resolutions must include the captured stderr. In the `onClose` failure `resolve({ accepted: false, ... })` add `__stderr: stderrBuf,`; in `onErr` add `__stderr: String(err && err.message || err),`. (`__stderr` is an internal field consumed here and ignored by `DeliveryWorker`, which only reads `accepted`/`responseState`/`receipt`.) The `session_started` capture clause from Task 4 already re-persists `fresh-sess` on the retry attempt.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/codexExecAdapter.sessionLoss.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Regression guard (whole adapter)**

Run: `node --test test/codex/codexExecAdapter.test.js test/codex/codexExecAdapter.resume.test.js test/codex/codexExecAdapter.fifo.test.js test/codex/codexExecAdapter.timeout.test.js test/codex/codexEndToEndProof.test.js`
Expected: all PASS, `# fail 0` (a successful resume never matches `UNKNOWN_SESSION_RE`; the first-turn-only paths never set `isResume`).

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/CodexExecAdapter.js toad-local/test/codex/codexExecAdapter.sessionLoss.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): session-loss fallback → reset + fresh first-turn (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `DeliveryWorker` wake-on-message for `session_turn`

Spec §5: a message to a `session_turn` recipient wakes it — the worker calls the adapter's `sendTurn` (the adapter's FIFO+resume logic transparently handles idle-wake vs mid-turn-batch). If the adapter is not currently registered (agent parked/not launched), keep the existing durable "queued_for_recipient" commit so the message survives for crash-reconciliation/relaunch.

**Files:**
- Modify: `src/delivery/deliveryWorker.js:3` (new mode set) and `:33-70` (new branch)
- Test: `test/codex/deliveryWorker.sessionTurn.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/deliveryWorker.sessionTurn.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';

function appended(broker, to) {
  const { message } = broker.appendMessage({
    teamId: 't1', from: { kind: 'agent', teamId: 't1', agentId: 'lead' },
    to, kind: 'chat', body: 'ping', idempotencyKey: `k-${Math.random()}`,
  });
  return message;
}

test('session_turn recipient with a registered adapter is woken via sendTurn and committed accepted', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });
  const seen = [];
  const adapters = new Map([['r-codex-1', { async sendTurn(t) { seen.push(t); return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true } }; } }]]);
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });

  const msg = appended(broker, { kind: 'agent', teamId: 't1', agentId: 'dev-1' });
  const attempt = await worker.deliverMessage(msg.messageId);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].message.messageId, msg.messageId);
  assert.equal(attempt.status, 'committed');
  assert.equal(attempt.responseState, 'accepted_by_runtime');
});

test('session_turn recipient with NO registered adapter is durably queued (survives for reconciliation)', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters: new Map() });

  const msg = appended(broker, { kind: 'agent', teamId: 't1', agentId: 'dev-1' });
  const attempt = await worker.deliverMessage(msg.messageId);

  assert.equal(attempt.status, 'committed');
  assert.equal(attempt.responseState, 'queued_for_recipient');
});
```

(If the `appendMessage` envelope fields differ, mirror an existing append in `test/deliveryWorker.test.js` — match its exact message shape.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/deliveryWorker.sessionTurn.test.js`
Expected: FAIL — the first test: `seen.length` is `0` (no `sendTurn` called; `session_turn` falls through to the queued commit), so `attempt.responseState` is `queued_for_recipient`, not `accepted_by_runtime`.

- [ ] **Step 3: Implement the branch**

In `src/delivery/deliveryWorker.js`, add after line 3:

```javascript
const SESSION_DELIVERY_MODES = new Set(['session_turn']);
```

Inside `deliverMessage`, in the `try { ... }` block, add this branch immediately **after** the closing `}` of the `if (RUNTIME_DELIVERY_MODES.has(resolved.deliveryMode)) { ... }` block and **before** the final `return this.broker.commitDeliveryAttempt({ ... queued ... })`:

```javascript
      if (SESSION_DELIVERY_MODES.has(resolved.deliveryMode)) {
        const adapter = this.adapters.get(resolved.runtimeId);
        if (adapter && typeof adapter.sendTurn === 'function') {
          // Wake-on-message: the adapter's FIFO + resume logic handles
          // idle-wake vs mid-turn batching transparently (spec §5).
          const receipt = await adapter.sendTurn({
            runtimeId: resolved.runtimeId,
            deliveryMode: resolved.deliveryMode,
            destination: resolved.destination,
            message,
          });
          if (!receipt || receipt.accepted !== true) {
            throw new Error(receipt?.reason || 'session runtime did not accept message');
          }
          return this.broker.commitDeliveryAttempt({
            attemptId: begin.attempt.attemptId,
            receipt: {
              deliveryMode: resolved.deliveryMode,
              responseState: receipt.responseState || 'accepted_by_runtime',
              ...(receipt.receipt && typeof receipt.receipt === 'object' ? receipt.receipt : {}),
            },
            responseState: receipt.responseState || 'accepted_by_runtime',
          });
        }
        // No live adapter (agent parked / not yet launched): fall through to
        // the durable queued commit below — the broker is durable, so the
        // boot reconciliation pass (Task 9) re-delivers on relaunch.
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/deliveryWorker.sessionTurn.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Regression guard (existing delivery unchanged)**

Run: `node --test test/deliveryWorker.test.js`
Expected: all PASS, `# fail 0` (`runtime_stdin`/`runtime_bridge`/`offline_queue` paths untouched — the new branch only triggers for `session_turn`).

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/delivery/deliveryWorker.js toad-local/test/codex/deliveryWorker.sessionTurn.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): DeliveryWorker session_turn wake-on-message (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Crash/boot reconciliation of undelivered session inboxes

> **RATIFIED 2026-05-18 (controller, mid-execution):** the boot pass is a
> *defensive secondary net*, not the primary spec-§5/§8 guarantee. Verified
> against real code: `SqliteRuntimeRegistry.reconcileOrphans()` (boot step 1)
> stops **and unbinds** every still-live runtime row (`DELETE FROM
> agent_delivery_modes` for reconciled rows); `#reconcileSessionInboxes()`
> runs *after* that and filters `status==='running'`, so on a normal
> post-crash boot it finds **zero** running session_turn rows and is a
> no-op. The *actual* "no lost message after restart" guarantee is the
> pre-existing path: a message to a stopped/unbound session agent resolves
> to `offline_queue` → durably committed → the 500 ms delivery retry sweep
> (`listMessagesNeedingDelivery` covers `offline_queue`) re-attempts → once
> the agent relaunches and re-registers its `session_turn` directory binding
> + adapter, `runtimeDirectory.resolve` returns the session runtime (a fresh
> delivery idempotency key, distinct from the offline one) → Task-8
> wake-on-message delivers it. The pure helper + boot call are kept (correct,
> harmless, and a genuine net for the narrow case where a session row is
> running with no adapter, e.g. adapter briefly absent while bound). **The
> spec guarantee must be VERIFIED end-to-end, not assumed** — Task 9 adds an
> end-to-end recovery test (Step 5a) proving a queued message to a
> not-yet-adapter-registered session agent is delivered exactly once after
> the adapter registers (no loss, no duplicate), exercised through the real
> broker + DeliveryWorker.

Spec §5/§8: after a TOAD restart, any `session_turn` agent with inbox messages that were never delivered must get them — no lost messages. A pure helper computes the undelivered set; `LocalToadRuntime` invokes `deliverMessage` for each on boot (idempotent via `beginDeliveryAttempt`) as a defensive net; the primary guarantee is the offline_queue + retry-sweep + Task-8-wake path (see RATIFIED note). Task 9 additionally adds an end-to-end test that the recovery guarantee actually holds.

**Files:**
- Create: `src/runtime/codex/reconcileSessionInboxes.js`
- Modify: `src/app/LocalToadRuntime.js` (call it once during boot, after the supervisor/registry/broker are ready and the runtime directory is hydrated)
- Test: `test/codex/reconcileSessionInboxes.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/reconcileSessionInboxes.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUndeliveredSessionMessages } from '../../src/runtime/codex/reconcileSessionInboxes.js';

test('returns inbox messages for session_turn agents that have no committed delivery attempt', () => {
  const sessionRuntimes = [
    { runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running' },
    { runtimeId: 'r-claude-1', teamId: 't1', agentId: 'lead', deliveryMode: 'runtime_stdin', status: 'running' },
  ];
  const inbox = {
    'dev-1': [{ messageId: 'm1' }, { messageId: 'm2' }, { messageId: 'm3' }],
    'lead': [{ messageId: 'm9' }],
  };
  const committed = new Set(['m2']); // m2 already delivered
  const out = computeUndeliveredSessionMessages({
    runtimes: sessionRuntimes,
    listInbox: ({ agentId }) => inbox[agentId] || [],
    isCommitted: (messageId) => committed.has(messageId),
  });
  // Only dev-1 (session_turn), only m1 + m3 (m2 already committed). Claude agent ignored.
  assert.deepEqual(out.map((x) => x.messageId), ['m1', 'm3']);
  assert.equal(out[0].runtimeId, 'r-codex-1');
});

test('skips non-running session agents and is empty when nothing pending', () => {
  const out = computeUndeliveredSessionMessages({
    runtimes: [{ runtimeId: 'r1', teamId: 't1', agentId: 'd', deliveryMode: 'session_turn', status: 'stopped' }],
    listInbox: () => [{ messageId: 'mX' }],
    isCommitted: () => false,
  });
  assert.deepEqual(out, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/reconcileSessionInboxes.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper**

Create `src/runtime/codex/reconcileSessionInboxes.js`:

```javascript
// SP1a Stage 2 — pure boot-reconciliation core. Given the live runtimes,
// an inbox reader, and a "was this message already delivered" predicate,
// return the (runtimeId, message) pairs that a session_turn agent still
// owes a resume turn. Pure / total: LocalToadRuntime does the I/O of
// re-invoking DeliveryWorker.deliverMessage for each.
export function computeUndeliveredSessionMessages({ runtimes, listInbox, isCommitted }) {
  if (!Array.isArray(runtimes)) return [];
  const out = [];
  for (const r of runtimes) {
    if (!r || r.deliveryMode !== 'session_turn' || r.status !== 'running') continue;
    let inbox;
    try { inbox = listInbox({ teamId: r.teamId, agentId: r.agentId }); } catch { inbox = []; }
    if (!Array.isArray(inbox)) continue;
    for (const m of inbox) {
      if (!m || typeof m.messageId !== 'string') continue;
      let done = false;
      try { done = isCommitted(m.messageId) === true; } catch { done = false; }
      if (!done) out.push({ runtimeId: r.runtimeId, teamId: r.teamId, agentId: r.agentId, messageId: m.messageId });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/reconcileSessionInboxes.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Wire it into `LocalToadRuntime` boot**

In `src/app/LocalToadRuntime.js`, add the import:

```javascript
import { computeUndeliveredSessionMessages } from '../runtime/codex/reconcileSessionInboxes.js';
```

Add a private async method and call it once during boot, after the broker, runtime registry, runtime directory hydration, and `DeliveryWorker` are all constructed (locate the existing boot/start sequence — search for where `DeliveryWorker` is instantiated or where `hydrateRuntimeDirectory` / `reconcileOrphans` is called; place this immediately after that, awaited):

```javascript
  async #reconcileSessionInboxes() {
    if (!this.runtimeRegistry || !this.broker || !this.deliveryWorker) return;
    const runtimes = this.runtimeRegistry.listRuntimes({});
    const isCommitted = (messageId) => {
      try { return this.broker.hasCommittedRuntimeDelivery
        ? this.broker.hasCommittedRuntimeDelivery(messageId) === true
        : false; } catch { return false; }
    };
    const pending = computeUndeliveredSessionMessages({
      runtimes,
      listInbox: ({ teamId, agentId }) => this.broker.listInbox({ teamId, recipient: { kind: 'agent', teamId, agentId } }),
      isCommitted,
    });
    for (const p of pending) {
      try { await this.deliveryWorker.deliverMessage(p.messageId); } catch { /* idempotent retry on next boot */ }
    }
  }
```

Then add `await this.#reconcileSessionInboxes();` at the chosen boot point.

**Note for the implementer:** verify the broker exposes a committed-delivery check. The code-explorer found `SqliteBroker.listMessagesNeedingDelivery({limit})` and the delivery-attempt API (`beginDeliveryAttempt`/`commitDeliveryAttempt`). If there is no `hasCommittedRuntimeDelivery(messageId)` method, the `isCommitted` predicate above safely returns `false` (its `try/catch`), which makes reconciliation re-invoke `deliverMessage` for every inbox message — that is still correct because `deliverMessage` is idempotent (`beginDeliveryAttempt` returns the existing committed attempt without re-sending; see `deliveryWorker.js:29-31`). So this task is correct with or without that method; prefer the precise check if a committed-query method exists, else rely on `deliverMessage` idempotency.

- [ ] **Step 5a: End-to-end recovery proof (verifies the spec §5/§8 guarantee — RATIFIED)**

Append to `test/codex/reconcileSessionInboxes.test.js` a test that proves the *actual* "no lost message after restart" guarantee through the real broker + DeliveryWorker (not the inert boot helper): a message addressed to a session agent that has **no registered adapter yet** is durably retained, and once the adapter registers it is delivered **exactly once** (no loss, no duplicate). Mirror the valid envelope shape used in `test/deliveryWorker.test.js` (read it; `from:{kind:'user',id:'lead'}`, a valid `MESSAGE_KINDS` `kind`, `text:` — not `body`/`agentId`).

```javascript
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';
import { DeliveryWorker } from '../../src/delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';

test('END-TO-END: a message to a not-yet-adapter-registered session agent is delivered exactly once after the adapter registers (spec §5/§8 — no loss, no dup)', async () => {
  const broker = new InMemoryBroker();
  const directory = new RuntimeDirectory();
  directory.registerAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex-1', deliveryMode: 'session_turn' });
  const adapters = new Map(); // agent not yet (re)launched — no adapter
  const worker = new DeliveryWorker({ broker, runtimeDirectory: directory, adapters });

  const { message } = broker.appendMessage({
    teamId: 't1', from: { kind: 'user', id: 'lead' }, to: { kind: 'agent', teamId: 't1', agentId: 'dev-1' },
    kind: 'instruction', text: 'must survive restart', idempotencyKey: 'k-recover-1',
  });

  // Parked: no adapter → durably queued (not delivered to a runtime).
  const a1 = await worker.deliverMessage(message.messageId);
  assert.equal(a1.status, 'committed');
  assert.equal(a1.responseState, 'queued_for_recipient');

  // Agent relaunches: its adapter registers. The retry sweep / a fresh
  // delivery attempt now wakes it. Delivery must reach the adapter exactly
  // once and the message must not be lost.
  const seen = [];
  adapters.set('r-codex-1', { async sendTurn(t) { seen.push(t.message.messageId); return { accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: 'r-codex-1' } }; } });
  const a2 = await worker.deliverMessage(message.messageId);

  assert.equal(seen.length, 1, 'delivered to the adapter exactly once after it registered');
  assert.equal(seen[0], message.messageId);
  assert.equal(a2.status, 'committed');
  assert.equal(a2.responseState, 'accepted_by_runtime');
});
```

If `deliverMessage`'s idempotency gate (same `messageId`+`runtimeId`+`deliveryMode` → returns the prior committed `queued_for_recipient` attempt) prevents the second call from reaching `sendTurn`, that is a **real lost-message defect** (the agent never gets the message after relaunch) — surface it as a finding, do not weaken the test. The correct production behaviour is that the post-relaunch delivery reaches `sendTurn` exactly once; if the idempotency key makes the parked `queued_for_recipient` commit swallow the redelivery, the controller must be told (it changes the §5/§8 recovery design).

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/reconcileSessionInboxes.test.js`
Expected: all 3 tests PASS (`# fail 0`). If the end-to-end test FAILS because of the idempotency-gate swallow described above, **STOP and report it to the controller** — it is a genuine spec-§5/§8 defect requiring a design decision, not a test to soften.

- [ ] **Step 6: Run the helper test + the boot smoke**

Run: `node --test test/codex/reconcileSessionInboxes.test.js test/localToadRuntime.test.js`
Expected: all PASS, `# fail 0` (boot still works; no behaviour change for non-session agents).

- [ ] **Step 7: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/codex/reconcileSessionInboxes.js toad-local/src/app/LocalToadRuntime.js toad-local/test/codex/reconcileSessionInboxes.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): boot reconciliation of undelivered session inboxes (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Session-aware stuck detector

Spec §8: `stuckRuntimeMonitor` assumes a persistent child; for session agents idle-between-turns is normal and must NOT flag. "Stuck" = an in-flight turn exceeding the cap with no `--json` progress. The pure `detectStuckRuntimes` gains a `sessionInFlight` map argument (`runtimeId → turnStartedAt ISO | null`, supplied by the monitor in Task 11). Branch: `deliveryMode==='session_turn'` ⇒ if not in-flight, never stuck; if in-flight, stuck when silence (from the later of turn-start / last event) exceeds threshold.

**Files:**
- Modify: `src/diagnostics/stuckRuntimeDetector.js:19-54`
- Test: `test/codex/stuckRuntime.sessionAware.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/stuckRuntime.sessionAware.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStuckRuntimes } from '../../src/diagnostics/stuckRuntimeDetector.js';

const T0 = '2026-05-18T00:00:00.000Z';
const NOW = '2026-05-18T01:00:00.000Z'; // 60 min later
const session = (over) => ({ runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running', startedAt: T0, ...over });

test('idle session agent (no in-flight turn) is NEVER flagged stuck even after long silence', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map(),                 // not in-flight
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.deepEqual(out, []);
});

test('in-flight session turn with no progress past threshold IS flagged stuck', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map([['r-codex-1', T0]]), // turn started 60 min ago, no events since
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].runtimeId, 'r-codex-1');
  assert.ok(out[0].silentMs > 15 * 60_000);
});

test('in-flight session turn making recent progress is NOT flagged', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map([['r-codex-1', '2026-05-18T00:58:00.000Z']]), // 2 min ago
    sessionInFlight: new Map([['r-codex-1', T0]]),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.deepEqual(out, []);
});

test('persistent (Claude) runtimes are unaffected by the session branch', () => {
  const out = detectStuckRuntimes({
    runtimes: [{ runtimeId: 'r-claude-1', teamId: 't1', agentId: 'lead', deliveryMode: 'runtime_stdin', status: 'running', startedAt: T0 }],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map(),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.equal(out.length, 1); // unchanged classic behaviour: silent > threshold ⇒ stuck
  assert.equal(out[0].runtimeId, 'r-claude-1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex/stuckRuntime.sessionAware.test.js`
Expected: FAIL — the "idle session agent never flagged" test fails (current detector uses `startedAt` ⇒ 60 min silence ⇒ flagged); `sessionInFlight` is ignored.

- [ ] **Step 3: Implement the session branch**

In `src/diagnostics/stuckRuntimeDetector.js`, add `sessionInFlight` to the destructured args and a session branch in the loop. Replace the function signature + loop:

```javascript
export function detectStuckRuntimes({
  runtimes,
  latestEventByRuntime,
  sessionInFlight,
  now,
  thresholdMs = DEFAULT_THRESHOLD_MS,
} = {}) {
  if (!Array.isArray(runtimes) || runtimes.length === 0) return [];
  if (!latestEventByRuntime || typeof latestEventByRuntime.get !== 'function') {
    latestEventByRuntime = new Map();
  }
  const inFlight = sessionInFlight && typeof sessionInFlight.get === 'function' ? sessionInFlight : new Map();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];

  const stuck = [];
  for (const r of runtimes) {
    if (!r || r.status !== 'running') continue;

    if (r.deliveryMode === 'session_turn') {
      // Idle between turns is NORMAL for a session agent — only an
      // in-flight turn can be "stuck" (spec §8). The in-flight signal
      // is the turn-start timestamp supplied by the monitor.
      const turnStartedAt = inFlight.get(r.runtimeId);
      if (typeof turnStartedAt !== 'string') continue; // not in a turn ⇒ never stuck
      const startMs = Date.parse(turnStartedAt);
      if (!Number.isFinite(startMs)) continue;
      const lastEv = latestEventByRuntime.get(r.runtimeId);
      const lastEvMs = typeof lastEv === 'string' ? Date.parse(lastEv) : NaN;
      // Reference = the later of (turn start) and (last --json progress).
      const refMs = Number.isFinite(lastEvMs) && lastEvMs > startMs ? lastEvMs : startMs;
      const silentMs = nowMs - refMs;
      if (silentMs > thresholdMs) {
        stuck.push({ runtimeId: r.runtimeId, teamId: r.teamId, agentId: r.agentId,
          taskId: r.taskId || null, lastEventAt: new Date(refMs).toISOString(), silentMs, thresholdMs });
      }
      continue;
    }

    const ref = latestEventByRuntime.get(r.runtimeId) || r.startedAt;
    if (typeof ref !== 'string') continue;
    const refMs = Date.parse(ref);
    if (!Number.isFinite(refMs)) continue;
    const silentMs = nowMs - refMs;
    if (silentMs > thresholdMs) {
      stuck.push({
        runtimeId: r.runtimeId,
        teamId: r.teamId,
        agentId: r.agentId,
        taskId: r.taskId || null,
        lastEventAt: ref,
        silentMs,
        thresholdMs,
      });
    }
  }
  stuck.sort((a, b) => b.silentMs - a.silentMs);
  return stuck;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/stuckRuntime.sessionAware.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Regression guard (classic detector unchanged)**

Run: `node --test test/stuckRuntimeDetector.test.js`
Expected: all PASS, `# fail 0` (non-`session_turn` runtimes take the unchanged classic branch; `sessionInFlight` defaults to an empty Map when omitted).

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/diagnostics/stuckRuntimeDetector.js toad-local/test/codex/stuckRuntime.sessionAware.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): session-aware stuck detector (idle≠stuck; in-flight stall=stuck) (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Monitor wiring — expose in-flight turn state + feed the detector

The detector needs the `sessionInFlight` map. The adapter already tracks `_turnStartedAt` (Task 3 seeded it). Set it in `#runTurn` (in-flight while a turn runs; cleared on settle) and expose `isTurnInFlight()`/`turnStartedAt`. `StuckRuntimeMonitor.tick()` builds the map from the supervisor's session adapters and passes it to `detectStuckRuntimes`.

**Files:**
- Modify: `src/runtime/CodexExecAdapter.js` (`#runTurn` — set/clear `_turnStartedAt`; add accessors)
- Modify: `src/diagnostics/stuckRuntimeMonitor.js` (accept an optional `supervisor`; build `sessionInFlight` in `tick()`)
- Test: `test/codex/codexExecAdapter.test.js` (extend — in-flight accessor) and `test/codex/stuckRuntime.sessionAware.test.js` (extend — monitor builds the map)

- [ ] **Step 1: Write the failing tests**

Append to `test/codex/codexExecAdapter.test.js`:

```javascript
test('turnStartedAt/isTurnInFlight reflect an in-flight turn and clear on completion', async () => {
  let resolveData;
  const child = (() => {
    const c = new (require('node:events').EventEmitter)();
    c.stdout = new (require('node:events').EventEmitter)();
    c.stderr = new (require('node:events').EventEmitter)();
    c.stdin = { write: () => {}, end: () => { resolveData = () => { c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n')); c.emit('close', 0); }; }, writable: true };
    c.kill = () => {};
    return c;
  })();
  const a = new CodexExecAdapter({ runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: '', spawnImpl: () => child, resolveCliImpl: (n) => n, sessionStore: { get: () => null, set: () => {}, clear: () => {} } });
  assert.equal(a.isTurnInFlight(), false);
  const p = a.sendTurn({ message: { text: 'x' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(a.isTurnInFlight(), true);
  assert.equal(typeof a.turnStartedAt, 'string');
  resolveData();
  await p;
  assert.equal(a.isTurnInFlight(), false);
  assert.equal(a.turnStartedAt, null);
});
```

(Use `import { EventEmitter } from 'node:events';` already at the top of that file instead of `require` if the file is ESM — match the file's existing import style; the `fakeChild` helper there can be reused with a gated `end()` instead.)

Append to `test/codex/stuckRuntime.sessionAware.test.js`:

```javascript
import { StuckRuntimeMonitor } from '../../src/diagnostics/stuckRuntimeMonitor.js';

test('StuckRuntimeMonitor builds sessionInFlight from the supervisor and flags a stalled in-flight session turn', () => {
  const T0 = '2026-05-18T00:00:00.000Z';
  const runtimes = [{ runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running', startedAt: T0 }];
  const supervisor = { getAdapter: (id) => (id === 'r-codex-1' ? { turnStartedAt: T0, isTurnInFlight: () => true } : null) };
  const events = [];
  const monitor = new StuckRuntimeMonitor({
    runtimeRegistry: { listRuntimes: () => runtimes },
    eventLog: { latestEventByRuntime: () => new Map() },
    eventBus: { emit: (n, e) => events.push([n, e]) },
    supervisor,
    now: () => '2026-05-18T01:00:00.000Z',
    thresholdMs: 15 * 60_000,
    setTimer: () => 0, clearTimer: () => {},
  });
  const stuck = monitor.tick();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].runtimeId, 'r-codex-1');
  assert.ok(events.some(([n, e]) => n === 'runtime_event' && e.type === 'STUCK_RUNTIME_DETECTED' && e.runtimeId === 'r-codex-1'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/codex/codexExecAdapter.test.js test/codex/stuckRuntime.sessionAware.test.js`
Expected: FAIL — `a.isTurnInFlight is not a function` / `a.turnStartedAt` undefined; `StuckRuntimeMonitor` does not accept `supervisor` nor build `sessionInFlight`, so the in-flight session turn is not flagged.

- [ ] **Step 3: Expose in-flight state on the adapter**

In `src/runtime/CodexExecAdapter.js` `#runTurn(text)`: set `this._turnStartedAt = new Date().toISOString();` immediately before the child is spawned, and clear it (`this._turnStartedAt = null;`) inside `cleanup()` (so it clears on every settle path — `turn_completed`, close, error, timeout). Add the accessors as methods:

```javascript
  get turnStartedAt() { return this._turnStartedAt; }
  isTurnInFlight() { return typeof this._turnStartedAt === 'string'; }
```

(Place beside `health()`. `_turnStartedAt` was seeded `null` in the Task-3 constructor.)

- [ ] **Step 4: Feed the map from the monitor**

In `src/diagnostics/stuckRuntimeMonitor.js`: accept an optional `supervisor` in the constructor (store `this.#supervisor = supervisor && typeof supervisor.getAdapter === 'function' ? supervisor : null;` — add the private field declaration `#supervisor;` with the others). In `tick()`, build the map before calling the detector and pass it through:

```javascript
    const sessionInFlight = new Map();
    if (this.#supervisor) {
      for (const r of runtimes) {
        if (r && r.deliveryMode === 'session_turn') {
          const ad = this.#supervisor.getAdapter(r.runtimeId);
          const at = ad && typeof ad.isTurnInFlight === 'function' && ad.isTurnInFlight() ? ad.turnStartedAt : null;
          if (typeof at === 'string') sessionInFlight.set(r.runtimeId, at);
        }
      }
    }
    const stuck = detectStuckRuntimes({
      runtimes,
      latestEventByRuntime,
      sessionInFlight,
      now: this.#now(),
      thresholdMs: this.#thresholdMs,
    });
```

(Replace the existing `const stuck = detectStuckRuntimes({ runtimes, latestEventByRuntime, now: this.#now(), thresholdMs: this.#thresholdMs });` call with the block above. `supervisor` is optional — when omitted, `sessionInFlight` is empty and session agents are simply never flagged, which is the safe default.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/codex/codexExecAdapter.test.js test/codex/stuckRuntime.sessionAware.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Regression guard (monitor unchanged for classic runtimes)**

Run: `node --test test/stuckRuntimeMonitor.test.js test/stuckRuntimeDetector.test.js`
Expected: all PASS, `# fail 0` (supervisor optional; classic path unchanged).

- [ ] **Step 7: Wire the supervisor into the monitor at the boot site (no test — integration)**

In `src/app/LocalToadRuntime.js`, where `StuckRuntimeMonitor` is constructed (search `new StuckRuntimeMonitor`), add `supervisor: this.supervisor,` to its options object. (If `StuckRuntimeMonitor` is not constructed in `LocalToadRuntime`, locate its construction site via `grep -rn "new StuckRuntimeMonitor" src` and add the field there.)

- [ ] **Step 8: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/CodexExecAdapter.js toad-local/src/diagnostics/stuckRuntimeMonitor.js toad-local/src/app/LocalToadRuntime.js toad-local/test/codex/codexExecAdapter.test.js toad-local/test/codex/stuckRuntime.sessionAware.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): expose in-flight turn state + monitor feeds session detector (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: End-to-end multi-turn proof + wire suites into the regression chain

A front-loaded-style proof using a real-spawned stand-in `codex` that emits the real `--json` vocabulary across **two** turns and honours `exec resume` — proving the whole Stage-2 seam (first turn → session capture → wake-on-message → resume → continuity) end to end, no real `codex` binary. Then append all new Stage-2 suites to `scripts/test-suites.txt`.

**Files:**
- Create: `test/fixtures/fake-codex-stage2.mjs` (a 2-turn-aware stand-in)
- Create: `test/codex/codexStage2.e2e.test.js`
- Modify: `scripts/test-suites.txt`

- [ ] **Step 1: Write the failing test**

Create `test/fixtures/fake-codex-stage2.mjs`:

```javascript
#!/usr/bin/env node
// SP1a Stage-2 proof stand-in. Honours `codex exec` (first turn) vs
// `codex exec resume <id>` (resume) and emits the real 0.130 --json
// vocabulary. First turn writes turn1.txt + emits thread.started(sess);
// resume appends to it + re-emits thread.started with the SAME id.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const isResume = argv[0] === 'exec' && argv[1] === 'resume';
const cIdx = argv.indexOf('-C');
const cwd = cIdx !== -1 ? argv[cIdx + 1] : process.cwd();
const SESSION = 'stage2-sess-1';
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'thread.started', thread_id: SESSION }); // resume re-emits SAME id
  emit({ type: 'turn.started' });
  try {
    if (isResume) { appendFileSync(join(cwd, 'turn1.txt'), '\nBETA'); }
    else { writeFileSync(join(cwd, 'turn1.txt'), 'ALPHA'); }
  } catch { /* ignore */ }
  emit({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'turn1.txt', kind: isResume ? 'update' : 'add' }] } });
  emit({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: isResume ? 'appended' : 'created' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
  process.exit(0);
});
```

Create `test/codex/codexStage2.e2e.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

test('STAGE-2 PROOF: first turn captures session id; second message resumes the SAME session with continuity', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'codex-stage2-'));
  const fake = path.resolve('test/fixtures/fake-codex-stage2.mjs');
  const children = [];
  const m = new Map();
  const sessionStore = { get: (id) => (m.has(id) ? m.get(id) : null), set: (id, v) => m.set(id, v), clear: (id) => m.set(id, null) };
  const adapter = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'dev-1', cwd: work, systemPrompt: 'You are dev-1.',
    spawnImpl: (_cmd, args, opts) => { const c = spawn(process.execPath, [fake, ...args], opts); children.push(c); return c; },
    resolveCliImpl: (n) => n, sessionStore,
  });
  try {
    const r1 = await adapter.sendTurn({ message: { text: 'create the file' } });
    assert.equal(r1.accepted, true);
    assert.equal(sessionStore.get('r1'), 'stage2-sess-1');               // captured
    assert.equal((await readFile(path.join(work, 'turn1.txt'), 'utf8')).trim(), 'ALPHA');

    const r2 = await adapter.sendTurn({ message: { text: 'now append' } });
    assert.equal(r2.accepted, true);
    // Second spawn used the resume argv with the captured id.
    const a2 = children[1].spawnargs.join(' ');
    assert.ok(/exec resume/.test(a2) && /stage2-sess-1/.test(a2));
    assert.equal((await readFile(path.join(work, 'turn1.txt'), 'utf8')).trim(), 'ALPHA\nBETA'); // continuity
    await adapter.stop();
  } finally {
    for (const c of children) { try { if (c.exitCode === null && !c.killed) c.kill('SIGTERM'); } catch {} }
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails (before Tasks 4-7 are present)**

Run: `node --test test/codex/codexStage2.e2e.test.js`
Expected (if run before the adapter changes): FAIL — second turn does not use `exec resume` / no continuity. (After Tasks 4-11 it passes — this proof is authored here but exercises the whole Stage-2 adapter; if executing strictly task-by-task it goes green once Tasks 4-7 land. Run it last.)

- [ ] **Step 3: Make it pass**

No new production code — this is the integration proof for Tasks 1-11. If it fails, the defect is in the earlier task's implementation; fix there, not here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex/codexStage2.e2e.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Append the new suites to the regression chain**

In `scripts/test-suites.txt` (a single `&&`-joined line, no trailing newline — preserve that), append (in this order) to the very end, each prefixed with ` && `:

```
node --no-warnings --test test/codex/runtimeRegistrySessionStore.test.js && node --no-warnings --test test/codex/codexExecAdapter.resume.test.js && node --no-warnings --test test/codex/codexExecAdapter.fifo.test.js && node --no-warnings --test test/codex/codexExecAdapter.timeout.test.js && node --no-warnings --test test/codex/codexExecAdapter.sessionLoss.test.js && node --no-warnings --test test/codex/deliveryWorker.sessionTurn.test.js && node --no-warnings --test test/codex/reconcileSessionInboxes.test.js && node --no-warnings --test test/codex/stuckRuntime.sessionAware.test.js && node --no-warnings --test test/codex/codexStage2.e2e.test.js
```

(Do not add a trailing newline. The existing chain already ends with `... && node --no-warnings --test test/codex/registerSessionAgentStop.test.js` with `\ No newline at end of file` — append after it.)

- [ ] **Step 6: Run the full root-suite gate**

Run: `cd /c/Project-TOAD/toad-local && bash -c "$(cat scripts/test-suites.txt)"`
Expected: exit code 0; summed `# fail 0` across every suite; the 9 new Stage-2 suites all run and pass.

- [ ] **Step 7: Commit**

```bash
git -C /c/Project-TOAD add toad-local/test/fixtures/fake-codex-stage2.mjs toad-local/test/codex/codexStage2.e2e.test.js toad-local/scripts/test-suites.txt
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "test(codex): Stage-2 multi-turn e2e proof + wire suites into the regression chain (SP1a Stage 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Whole-Implementation Review (controller, before wrap)

After all 12 tasks: dispatch the mandatory whole-impl two-stage review (spec-compliance vs `2026-05-17-codex-team-runtime-adapter-design.md` §4/§5/§8/§9, then code-quality), fix any findings, then the controller independently re-runs the **full root-suite gate** (`bash -c "$(cat scripts/test-suites.txt)"` from `toad-local/`), confirms `EXIT=0` + summed `fail 0`, reconciles the pass count against the prior 1597 baseline + the new Stage-2 test cases, and confirms the out-of-scope diff is EMPTY (Claude/`ClaudeStreamJsonAdapter`/`CodexFoundryAdapter`/`normalizeCodexExecLine` byte-unchanged; no UI). Then use `superpowers:finishing-a-development-branch`.

---

## Self-Review (writing-plans checklist)

**1. Spec coverage:**
- §4 `cliSessionId` nullable column → Task 1. First-turn-vs-resume argv + session capture → Task 4. FIFO per-agent serialization → Task 5. `events()` per-turn iterable, `sendToolResult`/`approve`/`stop`/`health` → unchanged from Stage 1 (no task needed; still correct). ✓
- §5 wake-on-message: idle→wake → Task 8. mid-turn→batch → Task 5 (coalescing). crash reconciliation → Task 9. session-loss fallback → Task 7. ✓
- §8 edge matrix: turn timeout → Task 6. stale/lost `cliSessionId` → Task 7. session-aware stuck monitor → Tasks 10+11. codex-not-installed/non-zero-exit/empty-turn → already handled by the Stage-1 adapter (ENOENT→`onErr`→`turn_failed`; non-zero→`onClose`→`turn_failed`+stderr; these paths are unchanged and still covered by `test/codex/codexExecAdapter.test.js`). stop mid-turn → Stage-1 `stop()` + supervisor `stopAgent` session_turn drain (unchanged, covered by `registerSessionAgentStop.test.js`). ✓
- §9 Stage-2 tests: DeliveryWorker session-shape → Task 8 test. stuck-monitor session path → Tasks 10/11 tests. multi-turn proof → Task 12. ✓
- Grounding §10 resume argv (`exec resume --json --skip-git-repo-check <id> -`, no `-C`/`--sandbox`, stdin=message) → Task 4 implementation matches verbatim. ✓

**2. Placeholder scan:** Every code step shows complete code. Task 3 Step 5 and Task 9 Step 5 and Task 11 Step 7 contain explicit "locate the construction site / verify the broker method" instructions with the exact fallback behaviour spelled out (idempotent `deliverMessage`; optional `supervisor`/`sessionStore` defaulting to safe Stage-1 behaviour) — these are grounded contingencies, not placeholders, because the safe default is fully specified. No "TBD"/"handle edge cases"/"similar to Task N".

**3. Type consistency:** `sessionStore` interface `{ get(runtimeId)→string|null, set(runtimeId,id), clear(runtimeId) }` is identical in Tasks 2,3,4,5,6,7,11,12. Registry method `setRuntimeCliSessionId({runtimeId,cliSessionId})` + `#rowToRuntime` field `cliSessionId` consistent (Tasks 1,2). Adapter accessors `turnStartedAt` (ISO string|null) + `isTurnInFlight()` consistent (Tasks 3,10,11). Detector arg `sessionInFlight` (Map runtimeId→ISO) consistent (Tasks 10,11). `runtime_event` reset marker `note:'codex_session_reset'` consistent (Task 7 impl + test). `#runTurn(text:string)` private + `sendTurn(input)` public wrapper consistent (Tasks 4,5,6,7,11). No drift found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-codex-team-runtime-adapter-stage2.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec then quality) between tasks, controller independently verifies every DONE + the full root gate; same rigor as Stage 1.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batched with checkpoints.

Which approach?
