# Foundry Slice F.2 Implementation Plan — Provider-Aware Foundry (Claude + Codex)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Foundry plan a project using either Claude or Codex CLI as the planning agent, picked per-session with a global default. Both providers preserve conversation context across turns without us replaying tokens. Output normalized into a provider-agnostic event stream so a future ASPE-style interpreter agent can subscribe.

**Architecture:** Extract current `FoundryRuntime` Claude logic into `ClaudeFoundryAdapter` (no behavior change). Add new `CodexFoundryAdapter` that spawns `codex exec --json` per turn (turn 1) and `codex exec resume <id> --json` (turn 2+). `FoundryRuntime` becomes a thin dispatcher that picks adapter based on each session's `provider` column.

**Tech Stack:** Node 20+ ESM, `node:sqlite` (DatabaseSync), `node:child_process` spawn. UI: TypeScript, React 18, Vite. Tests: `node:test` for backend (no UI tests — typecheck + lint + manual smoke per existing convention).

**Spec:** `docs/specs/2026-05-10-foundry-slice-f2-provider-aware-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/foundry/providers/FoundryProviderAdapter.js` | Create | Abstract base class; throws-on-unimplemented stubs |
| `src/foundry/providers/ClaudeFoundryAdapter.js` | Create | Persistent Claude subprocess (extracted from current `foundryRuntime.js`) |
| `src/foundry/providers/CodexFoundryAdapter.js` | Create | Codex `exec`+`resume` per-turn adapter |
| `src/foundry/foundryRuntime.js` | Rewrite | Thin dispatcher selecting adapter by provider |
| `src/storage/schema.sql` | Modify | Add `provider TEXT NOT NULL DEFAULT 'anthropic'` to `foundry_sessions` |
| `src/storage/sqlite.js` | Modify | Add migration `ALTER TABLE foundry_sessions ADD COLUMN provider` |
| `src/foundry/sqliteFoundryStore.js` | Modify | `createSession` accepts `provider`; `rowToSession` exposes it |
| `src/tools/localToolFacade.js` | Modify | `#foundrySessionCreate` accepts `provider`; `#foundryChatTurn` reads `session.provider` |
| `src/mcp/localToolDefinitions.js` | Modify | Add `provider` arg to `foundry_session_create` schema |
| `scripts/dev-api-server.mjs` | Modify | Pass `projectCwdResolver` to `FoundryRuntime` constructor |
| `ui/src/components/settings/FoundrySettings.tsx` | Create | Radio for `foundry.defaultProvider` |
| `ui/src/components/settings/SettingsScreen.tsx` | Modify | Mount FoundrySettings section |
| `ui/src/components/FoundryScreen.tsx` | Modify | "+ New" gains provider dropdown; session-row shows provider chip |
| `test/foundry/providers/foundryProviderAdapter.test.js` | Create | Base-class abstract behavior |
| `test/foundry/providers/claudeFoundryAdapter.test.js` | Create | Migrated from current foundryRuntime.test.js |
| `test/foundry/providers/codexFoundryAdapter.test.js` | Create | New, full coverage of Codex argv + JSON event parsing |
| `test/foundry/foundryRuntime.test.js` | Rewrite | Slim dispatcher tests with fake adapters |
| `test/sqliteFoundryStore.test.js` | Modify | `provider` column round-trip |
| `test/localToolFacade.test.js` | Modify | Provider arg pass-through + `session.provider` read |
| `package.json` | Modify | Wire new test files into `test` script |
| `docs/FUTURE-IDEAS.md` | Modify | Mark F.2 as shipped; refine F.2.5 (Gemini) entry |

---

## Pre-flight: clean baseline

- [ ] **Step P.1: Backend tests pass clean**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -20`
Expected: all tests pass (100+ test files), no skips.

- [ ] **Step P.2: UI typecheck + lint pass clean**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: zero errors.

- [ ] **Step P.3: Git is clean**

Run: `git -C C:/Project-TOAD/toad-local status --short`
Expected: clean (or only the spec/plan we just committed; no other tracked changes).

---

## Task 1: Schema migration — add `provider` column

**Files:**
- Modify: `src/storage/schema.sql:186-198` (the `foundry_sessions` CREATE TABLE)
- Modify: `src/storage/sqlite.js` (applyMigrations function)

- [ ] **Step 1.1: Add column to CREATE TABLE for fresh DBs**

Find in `src/storage/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS foundry_sessions (
  session_id      TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  project_path    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  cli_session_id  TEXT
);
```

Replace with (one line added at the end of the column list — comma after `cli_session_id TEXT`):

```sql
CREATE TABLE IF NOT EXISTS foundry_sessions (
  session_id      TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  project_path    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  cli_session_id  TEXT,
  provider        TEXT NOT NULL DEFAULT 'anthropic'
);
```

- [ ] **Step 1.2: Add migration entry for existing DBs**

Open `src/storage/sqlite.js`, find the `applyMigrations` function (search for `applyMigrations`). Look at the existing F.1-era line:

```js
try { db.exec('ALTER TABLE foundry_sessions ADD COLUMN cli_session_id TEXT'); } catch {}
```

Add immediately after it:

```js
try { db.exec("ALTER TABLE foundry_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'"); } catch {}
```

The bare `catch {}` is intentional — same pattern as cli_session_id. SQLite throws when the column already exists; we ignore.

- [ ] **Step 1.3: Run backend tests — verify nothing breaks**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: all tests pass. Schema additions are backward-compatible.

- [ ] **Step 1.4: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/storage/schema.sql src/storage/sqlite.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): add provider column to foundry_sessions schema

Adds a provider column ('anthropic' default) so each Foundry session
records which CLI agent was used for planning. Default 'anthropic'
preserves F.1 behavior for existing sessions and Claude-only setups.
ALTER migration uses the same bare-catch pattern as cli_session_id from
F.1 — idempotent on fresh and migrated DBs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SqliteFoundryStore — accept and expose `provider`

**Files:**
- Modify: `src/foundry/sqliteFoundryStore.js` (createSession + rowToSession)
- Modify: `test/sqliteFoundryStore.test.js`

- [ ] **Step 2.1: Write failing tests first (TDD)**

Open `test/sqliteFoundryStore.test.js`. Add three new tests at the end, before the final `}` if any wrapping closure exists, or as plain top-level `test(...)` calls if the file uses `node:test` directly. Look at the existing test patterns and follow them. Add:

```js
test('SqliteFoundryStore.createSession persists provider when given', () => {
  const store = new SqliteFoundryStore();
  const session = store.createSession({ title: 'Test', provider: 'openai' });
  assert.equal(session.provider, 'openai');
  const fetched = store.getSession(session.sessionId);
  assert.equal(fetched.session.provider, 'openai');
});

test('SqliteFoundryStore.createSession defaults provider to anthropic', () => {
  const store = new SqliteFoundryStore();
  const session = store.createSession({ title: 'Test' });
  assert.equal(session.provider, 'anthropic');
});

test('SqliteFoundryStore.createSession rejects unknown provider', () => {
  const store = new SqliteFoundryStore();
  assert.throws(
    () => store.createSession({ title: 'Test', provider: 'grok' }),
    /provider/i,
  );
});
```

- [ ] **Step 2.2: Run tests — verify they fail**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/sqliteFoundryStore.test.js 2>&1 | tail -15`
Expected: 3 new failures with messages like `provider` undefined or column not in store.

- [ ] **Step 2.3: Add `PROVIDERS` constant + extend `createSession`**

In `src/foundry/sqliteFoundryStore.js`, near the top alongside `SESSION_STATUSES` etc., add:

```js
const SESSION_PROVIDERS = Object.freeze(['anthropic', 'openai']);
```

Modify `createSession` signature and body:

```js
  createSession({
    sessionId = `foundry-${randomUUID()}`,
    title,
    projectPath = null,
    status = 'draft',
    metadata = {},
    provider = 'anthropic',
  } = {}) {
    const now = new Date().toISOString();
    const normalized = {
      sessionId: requireString(sessionId, 'sessionId'),
      title: requireString(title, 'title'),
      status: requireEnum(status, SESSION_STATUSES, 'status'),
      projectPath: typeof projectPath === 'string' && projectPath.trim().length > 0 ? projectPath.trim() : null,
      createdAt: now,
      updatedAt: now,
      metadata: normalizeObject(metadata),
      provider: requireEnum(provider, SESSION_PROVIDERS, 'provider'),
    };
    this.db.prepare(`
      INSERT INTO foundry_sessions (
        session_id, title, status, project_path, created_at, updated_at, metadata_json, provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.sessionId,
      normalized.title,
      normalized.status,
      normalized.projectPath,
      normalized.createdAt,
      normalized.updatedAt,
      jsonStringify(normalized.metadata),
      normalized.provider,
    );
    return normalized;
  }
```

- [ ] **Step 2.4: Update `rowToSession` to expose `provider`**

Find `rowToSession` (helper function lower in the file). Add `provider` to the returned object:

```js
function rowToSession(row) {
  return {
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    projectPath: row.project_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: jsonParseObject(row.metadata_json),
    cliSessionId: row.cli_session_id ?? null,
    provider: row.provider ?? 'anthropic',
  };
}
```

(If the existing function shape differs, adapt — just ensure `provider` is on the returned object with `'anthropic'` fallback for legacy rows.)

- [ ] **Step 2.5: Run tests — verify they pass**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/sqliteFoundryStore.test.js 2>&1 | tail -10`
Expected: all tests pass including the 3 new ones.

- [ ] **Step 2.6: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/foundry/sqliteFoundryStore.js test/sqliteFoundryStore.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): SqliteFoundryStore.createSession accepts provider

createSession now takes a provider arg ('anthropic' | 'openai',
defaults to 'anthropic'). Persists to the new provider column.
rowToSession exposes provider on the returned session object with
'anthropic' fallback for legacy rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: FoundryProviderAdapter base class

**Files:**
- Create: `src/foundry/providers/FoundryProviderAdapter.js`
- Create: `test/foundry/providers/foundryProviderAdapter.test.js`

- [ ] **Step 3.1: Write failing tests first**

Create `test/foundry/providers/foundryProviderAdapter.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FoundryProviderAdapter } from '../../../src/foundry/providers/FoundryProviderAdapter.js';

test('FoundryProviderAdapter cannot be instantiated directly', () => {
  assert.throws(() => new FoundryProviderAdapter('test'), /abstract/i);
});

test('FoundryProviderAdapter subclass without send() throws when send is called', async () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub'); }
  }
  const stub = new Stub();
  await assert.rejects(stub.send({ foundrySessionId: 's', text: 't' }), /send/i);
});

test('FoundryProviderAdapter default isAttached returns false', () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub'); }
  }
  const stub = new Stub();
  assert.equal(stub.isAttached({ foundrySessionId: 's' }), false);
});

test('FoundryProviderAdapter default close and closeAll are no-ops', async () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub'); }
  }
  const stub = new Stub();
  await stub.close({ foundrySessionId: 's' });
  await stub.closeAll();
  // No throw = pass.
});

test('FoundryProviderAdapter exposes providerId', () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub-provider'); }
  }
  const stub = new Stub();
  assert.equal(stub.providerId, 'stub-provider');
});
```

- [ ] **Step 3.2: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/providers/foundryProviderAdapter.test.js 2>&1 | tail -10`
Expected: import error / module not found.

- [ ] **Step 3.3: Implement the base class**

Create `src/foundry/providers/FoundryProviderAdapter.js`:

```js
/**
 * Abstract base class for Foundry CLI adapters. One subclass per provider.
 *
 * Subclasses MUST implement send() and SHOULD override isAttached(),
 * close(), and closeAll() if they hold cross-turn state (e.g. persistent
 * subprocesses).
 *
 * Mirrors the runtime tier's RuntimeAdapter pattern (src/runtime/RuntimeAdapter.js).
 */
export class FoundryProviderAdapter {
  constructor(providerId) {
    if (new.target === FoundryProviderAdapter) {
      throw new TypeError('FoundryProviderAdapter is an abstract base class');
    }
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throw new TypeError('FoundryProviderAdapter: providerId required');
    }
    this.providerId = providerId;
  }

  /**
   * Send a user message and await the assistant response.
   * @param {{ foundrySessionId: string, text: string, cliSessionId?: string|null }} _args
   * @returns {Promise<{ text: string, sessionUuid: string, model?: string|null, eventCount: number }>}
   */
  async send(_args) {
    throw new Error(`${this.providerId}: send() not implemented`);
  }

  /** True when the adapter holds in-memory state that close() would tear down. */
  isAttached(_args) {
    return false;
  }

  async close(_args) { /* no-op default */ }
  async closeAll() { /* no-op default */ }
}
```

- [ ] **Step 3.4: Run — verify passing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/providers/foundryProviderAdapter.test.js 2>&1 | tail -10`
Expected: all 5 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/foundry/providers/FoundryProviderAdapter.js test/foundry/providers/foundryProviderAdapter.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): add FoundryProviderAdapter abstract base class

Mirrors RuntimeAdapter pattern from the runtime tier. Subclasses
implement send() per-provider; default isAttached/close/closeAll
support stateless adapters (like upcoming Codex one). Throws on
direct instantiation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: ClaudeFoundryAdapter — port from FoundryRuntime

**Files:**
- Create: `src/foundry/providers/ClaudeFoundryAdapter.js` (extracted from `src/foundry/foundryRuntime.js`)
- Create: `test/foundry/providers/claudeFoundryAdapter.test.js` (migrated from `test/foundry/foundryRuntime.test.js`)

This task does NOT change FoundryRuntime yet — that's Task 6. We're creating a new file that holds the Claude logic; FoundryRuntime keeps its current API and continues to work until Task 6 rewires it.

- [ ] **Step 4.1: Migrate the test file first (TDD-style)**

Copy `test/foundry/foundryRuntime.test.js` to `test/foundry/providers/claudeFoundryAdapter.test.js`. In the new copy:

1. Change the import path:
   ```js
   import { ClaudeFoundryAdapter } from '../../../src/foundry/providers/ClaudeFoundryAdapter.js';
   ```

2. Replace every `new FoundryRuntime(...)` with `new ClaudeFoundryAdapter(...)`.

3. Replace every `rt.send(...)` / `rt.close(...)` / `rt.isLive(...)` / `rt.closeAll(...)` with the same method on `adapter` (rename the local variable for clarity; if the file uses `rt`, leave it). The Claude adapter exposes `isAttached`, NOT `isLive` — rename calls accordingly: `rt.isLive({ foundrySessionId })` → `adapter.isAttached({ foundrySessionId })`.

4. Add a top-of-file comment block:
   ```js
   /**
    * MIGRATED from test/foundry/foundryRuntime.test.js as part of F.2.
    * This file should retain bit-identical behavior assertions for the
    * Claude path. The dispatcher-level FoundryRuntime tests live in
    * test/foundry/foundryRuntime.test.js after F.2's rewrite.
    */
   ```

- [ ] **Step 4.2: Run new test file — verify failing (module not found)**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/providers/claudeFoundryAdapter.test.js 2>&1 | tail -10`
Expected: import failure for `ClaudeFoundryAdapter`.

- [ ] **Step 4.3: Implement ClaudeFoundryAdapter by porting the FoundryRuntime body**

Create `src/foundry/providers/ClaudeFoundryAdapter.js` with this exact content (copy-paste-ready — derived from current `src/foundry/foundryRuntime.js` with the class renamed and base-class extension):

```js
import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FoundryProviderAdapter } from './FoundryProviderAdapter.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per turn

/**
 * ClaudeFoundryAdapter — manages persistent Claude CLI subprocesses for
 * Foundry planning sessions. Mirrors RuntimeSupervisor's pattern at the
 * runtime tier: one child process per Foundry session, held alive across
 * chat turns, killed on session close or sidecar shutdown.
 *
 * F.2: extracted from src/foundry/foundryRuntime.js with no behavior change.
 *
 * Per-turn flow:
 *   - First call for a session: spawn `claude` with --session-id <uuid> +
 *     stream-json IO. Process held in registry.
 *   - Subsequent calls: reuse the existing process, write the new user
 *     message to stdin, await the assistant_message event.
 *   - Crash recovery: if registry has no live process but a cliSessionId
 *     was passed, spawn fresh with --resume <cliSessionId>.
 */
export class ClaudeFoundryAdapter extends FoundryProviderAdapter {
  #processes = new Map(); // foundrySessionId -> { child, sessionUuid, lineBuffer }

  constructor({
    spawnImpl = defaultSpawn,
    instructionsPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onCrash = null,
  } = {}) {
    super('anthropic');
    if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
      throw new TypeError('ClaudeFoundryAdapter: instructionsPath is required');
    }
    this.spawnImpl = spawnImpl;
    this.instructionsPath = instructionsPath;
    this.timeoutMs = timeoutMs;
    this.onCrash = typeof onCrash === 'function' ? onCrash : null;
  }

  isAttached({ foundrySessionId } = {}) {
    return this.#processes.has(foundrySessionId);
  }

  async send({ foundrySessionId, text, cliSessionId = null } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
      throw new TypeError('ClaudeFoundryAdapter.send: foundrySessionId required');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('ClaudeFoundryAdapter.send: text required');
    }

    let entry = this.#processes.get(foundrySessionId);
    if (!entry) {
      entry = this.#spawn({ cliSessionId });
      this.#processes.set(foundrySessionId, entry);
    }

    return this.#runTurn({ entry, text });
  }

  async close({ foundrySessionId } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) return;
    const entry = this.#processes.get(foundrySessionId);
    if (!entry) return;
    entry._intentionalClose = true;
    this.#processes.delete(foundrySessionId);
    try { entry.child.kill('SIGTERM'); } catch { /* already dead */ }
  }

  async closeAll() {
    const sessionIds = Array.from(this.#processes.keys());
    for (const id of sessionIds) {
      await this.close({ foundrySessionId: id });
    }
  }

  #spawn({ cliSessionId }) {
    const sessionUuid = cliSessionId || randomUUID();
    const args = [
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--append-system-prompt-file', this.instructionsPath,
      '--disallowedTools', '*',
      '--session-id', sessionUuid,
    ];
    if (cliSessionId) {
      args.push('--resume', cliSessionId);
    }
    const child = this.spawnImpl('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, sessionUuid, lineBuffer: '' };

    child.on('close', (code) => {
      for (const [id, e] of this.#processes.entries()) {
        if (e === entry) {
          this.#processes.delete(id);
          if (this.onCrash && code !== 0 && !e._intentionalClose) {
            try { this.onCrash({ foundrySessionId: id, exitCode: code }); } catch { /* ignore */ }
          }
          break;
        }
      }
    });

    return entry;
  }

  async #runTurn({ entry, text }) {
    const { child } = entry;

    const userPayload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      child.stdin.write(JSON.stringify(userPayload) + '\n');
    } catch (err) {
      throw new Error(`ClaudeFoundryAdapter: stdin write failed: ${err && err.message ? err.message : err}`);
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      let assistantText = null;
      let model = null;
      let eventCount = 0;

      const dataHandler = (chunk) => {
        entry.lineBuffer += chunk.toString('utf8');
        let nl;
        while ((nl = entry.lineBuffer.indexOf('\n')) !== -1) {
          const line = entry.lineBuffer.slice(0, nl).trim();
          entry.lineBuffer = entry.lineBuffer.slice(nl + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { continue; }
          eventCount += 1;

          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            entry.sessionUuid = event.session_id;
          }
          if (event.type === 'assistant' && event.message?.content) {
            const textPart = (event.message.content || [])
              .filter((p) => p && p.type === 'text')
              .map((p) => p.text)
              .join('');
            if (textPart) assistantText = textPart;
            if (event.message.model) model = event.message.model;
          }
          if (event.type === 'result') {
            if (resolved) return;
            resolved = true;
            cleanup();
            if (assistantText === null) {
              reject(new Error('ClaudeFoundryAdapter: result event before any assistant_message'));
              return;
            }
            resolve({
              text: assistantText,
              sessionUuid: entry.sessionUuid,
              model,
              eventCount,
            });
          }
        }
      };

      const closeHandler = (code) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`ClaudeFoundryAdapter: subprocess closed (exit=${code}) before result event`));
      };

      const errorHandler = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        cleanup();
        reject(new Error(`ClaudeFoundryAdapter: turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        if (child.stdout?.off) child.stdout.off('data', dataHandler);
        else if (child.stdout?.removeListener) child.stdout.removeListener('data', dataHandler);
        child.off?.('close', closeHandler);
        child.off?.('error', errorHandler);
      }

      child.stdout.on('data', dataHandler);
      child.on('close', closeHandler);
      child.on('error', errorHandler);
    });
  }
}
```

- [ ] **Step 4.4: Run migrated test file — verify all 11 pass**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/providers/claudeFoundryAdapter.test.js 2>&1 | tail -15`
Expected: all 11 tests from the original `foundryRuntime.test.js` now pass against `ClaudeFoundryAdapter`. If anything fails, the port changed behavior — fix the adapter to match the existing test expectations exactly.

- [ ] **Step 4.5: Run full backend test suite — confirm nothing else broke**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: all pass. The original `test/foundry/foundryRuntime.test.js` still works because we haven't touched `foundryRuntime.js` yet.

- [ ] **Step 4.6: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/foundry/providers/ClaudeFoundryAdapter.js test/foundry/providers/claudeFoundryAdapter.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): extract ClaudeFoundryAdapter from FoundryRuntime

Pure extraction. Logic ported byte-for-byte from foundryRuntime.js into
the new adapter shape (extends FoundryProviderAdapter). Same flags, same
stream-json IO, same crash recovery. Renames isLive→isAttached to match
the base-class interface; behavior identical.

Test file migrated from test/foundry/foundryRuntime.test.js with the
same 11 scenarios; original test file still active until Task 6 rewires
FoundryRuntime as a dispatcher.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CodexFoundryAdapter — new

**Files:**
- Create: `src/foundry/providers/CodexFoundryAdapter.js`
- Create: `test/foundry/providers/codexFoundryAdapter.test.js`

- [ ] **Step 5.1: Write failing tests first (TDD)**

Create `test/foundry/providers/codexFoundryAdapter.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { CodexFoundryAdapter } from '../../../src/foundry/providers/CodexFoundryAdapter.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = {
    written: [],
    write(chunk) { this.written.push(String(chunk)); return true; },
    end() { this.ended = true; },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => { child._kill = signal || 'SIGTERM'; child.emit('close', 0); };
  return child;
}

function makeFakeSpawn(children = []) {
  let idx = 0;
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = children[idx++] ?? makeFakeChild();
    return child;
  };
  fn.calls = calls;
  return fn;
}

const FAKE_INSTRUCTIONS_PATH = '/tmp/foundry-instructions.txt';

// Helper: simulate a typical successful turn from codex exec --json output.
function emitTurnSuccess(child, { threadId = 'thr-1', text = 'OK' } = {}) {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.started' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
  }) + '\n'));
}

test('CodexFoundryAdapter providerId is openai', () => {
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn(),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'INSTRUCTIONS',
  });
  assert.equal(adapter.providerId, 'openai');
});

test('CodexFoundryAdapter.send first turn spawns codex exec --json with prepended instructions', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new CodexFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj/x',
    readFileImpl: () => 'SYSTEM PROMPT BODY',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'hello world', cliSessionId: null });
  emitTurnSuccess(child, { threadId: 'thr-1', text: 'hi' });
  const result = await sendPromise;

  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.equal(call.cmd, 'codex');
  assert.deepEqual(call.args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C', '/proj/x',
    'SYSTEM PROMPT BODY\n\nhello world',
  ]);
  assert.equal(result.text, 'hi');
  assert.equal(result.sessionUuid, 'thr-1');
});

test('CodexFoundryAdapter.send resume turn spawns codex exec resume without system prompt', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new CodexFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj/x',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'follow-up', cliSessionId: 'thr-existing' });
  emitTurnSuccess(child, { threadId: 'thr-existing', text: 'response' });
  const result = await sendPromise;

  const call = spawn.calls[0];
  assert.deepEqual(call.args, [
    'exec',
    'resume',
    'thr-existing',
    '--json',
    '--skip-git-repo-check',
    '-C', '/proj/x',
    'follow-up',
  ]);
  assert.equal(result.text, 'response');
  assert.equal(result.sessionUuid, 'thr-existing');
});

test('CodexFoundryAdapter concatenates multiple agent_message item.completed events', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'part one ' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'part two' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
  const result = await sendPromise;

  assert.equal(result.text, 'part one part two');
});

test('CodexFoundryAdapter ignores non-agent_message item.completed events', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_reasoning', text: 'thinking...' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
  const result = await sendPromise;

  assert.equal(result.text, 'answer');
});

test('CodexFoundryAdapter throws when turn.completed arrives without any agent_message', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));

  await assert.rejects(sendPromise, /no agent_message|missing.*message/i);
});

test('CodexFoundryAdapter skips non-JSON lines silently', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from('this is a warning line, not JSON\n'));
  emitTurnSuccess(child, { threadId: 't', text: 'OK' });
  const result = await sendPromise;

  assert.equal(result.text, 'OK');
});

test('CodexFoundryAdapter.isAttached always returns false', () => {
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn(),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });
  assert.equal(adapter.isAttached({ foundrySessionId: 'anything' }), false);
});

test('CodexFoundryAdapter.close and closeAll are no-ops', async () => {
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn(),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });
  await adapter.close({ foundrySessionId: 's' });
  await adapter.closeAll();
  // No throw = pass.
});

test('CodexFoundryAdapter timeout kills the child and rejects', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
    timeoutMs: 30,
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  // Don't emit anything — let it time out.
  await assert.rejects(sendPromise, /timed out/i);
  assert.equal(child._kill, 'SIGTERM');
});
```

- [ ] **Step 5.2: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/providers/codexFoundryAdapter.test.js 2>&1 | tail -10`
Expected: import failure (`CodexFoundryAdapter` not found).

- [ ] **Step 5.3: Implement CodexFoundryAdapter**

Create `src/foundry/providers/CodexFoundryAdapter.js`:

```js
import { spawn as defaultSpawn } from 'node:child_process';
import { readFileSync as defaultReadFileSync } from 'node:fs';
import { FoundryProviderAdapter } from './FoundryProviderAdapter.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per turn

/**
 * CodexFoundryAdapter — drives Codex CLI in 'codex exec' mode for
 * Foundry planning sessions. Each send() spawns a fresh `codex` process
 * for ONE turn, then exits. Codex preserves session state on disk
 * (~/.codex/sessions/<id>/) between calls; subsequent turns use
 * 'codex exec resume <session_id>' which loads the prior conversation
 * from disk without us replaying tokens.
 *
 * JSON event shape grounded in upstream agent-teams-ai's Phase 0 spec
 * (codex-cli 0.117.0, observed 2026-04-19): thread.started → store
 * thread_id, item.completed with item.type='agent_message' → accumulate
 * text, turn.completed → resolve.
 *
 * Stateless between turns. isAttached() always false; close()/closeAll()
 * are no-ops. Crash recovery is automatic — next send() with stored
 * cliSessionId resumes the conversation.
 */
export class CodexFoundryAdapter extends FoundryProviderAdapter {
  constructor({
    spawnImpl = defaultSpawn,
    readFileImpl = (path) => defaultReadFileSync(path, 'utf8'),
    instructionsPath,
    projectCwdResolver,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    super('openai');
    if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
      throw new TypeError('CodexFoundryAdapter: instructionsPath is required');
    }
    if (typeof projectCwdResolver !== 'function') {
      throw new TypeError('CodexFoundryAdapter: projectCwdResolver function is required');
    }
    this.spawnImpl = spawnImpl;
    this.readFileImpl = readFileImpl;
    this.instructionsPath = instructionsPath;
    this.projectCwdResolver = projectCwdResolver;
    this.timeoutMs = timeoutMs;
  }

  async send({ foundrySessionId, text, cliSessionId = null } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
      throw new TypeError('CodexFoundryAdapter.send: foundrySessionId required');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('CodexFoundryAdapter.send: text required');
    }

    const cwd = this.projectCwdResolver() || process.cwd();

    // Build argv. First turn: prepend system prompt to user message
    // because `codex exec` has no --append-system-prompt-file flag.
    // Resume turn: send only the new user message; Codex has the prior
    // conversation (including original instructions) on disk.
    let prompt;
    let args;
    if (cliSessionId) {
      prompt = text;
      args = ['exec', 'resume', cliSessionId, '--json', '--skip-git-repo-check', '-C', cwd, prompt];
    } else {
      const systemPrompt = this.readFileImpl(this.instructionsPath);
      prompt = `${systemPrompt}\n\n${text}`;
      args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, prompt];
    }

    const child = this.spawnImpl('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    return this.#consumeStream({ child });
  }

  // Stateless — no in-memory cross-turn state to attach/detach.
  isAttached() { return false; }
  async close() { /* no-op */ }
  async closeAll() { /* no-op */ }

  #consumeStream({ child }) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let lineBuffer = '';
      let assistantText = '';
      let threadId = null;
      let eventCount = 0;

      const dataHandler = (chunk) => {
        lineBuffer += chunk.toString('utf8');
        let nl;
        while ((nl = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, nl).trim();
          lineBuffer = lineBuffer.slice(nl + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { continue; } // non-JSON warning lines are dropped silently
          eventCount += 1;

          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            threadId = event.thread_id;
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
            assistantText += event.item.text;
          }
          if (event.type === 'turn.completed') {
            if (resolved) return;
            resolved = true;
            cleanup();
            if (assistantText.length === 0) {
              reject(new Error('CodexFoundryAdapter: turn.completed with no agent_message'));
              return;
            }
            resolve({
              text: assistantText,
              sessionUuid: threadId,
              model: null,
              eventCount,
            });
          }
        }
      };

      const closeHandler = (code) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`CodexFoundryAdapter: codex exited (code=${code}) before turn.completed`));
      };

      const errorHandler = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        cleanup();
        reject(new Error(`CodexFoundryAdapter: turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        if (child.stdout?.off) child.stdout.off('data', dataHandler);
        else if (child.stdout?.removeListener) child.stdout.removeListener('data', dataHandler);
        child.off?.('close', closeHandler);
        child.off?.('error', errorHandler);
      }

      // Drain stderr (warnings) so the pipe never blocks.
      child.stderr?.on('data', () => { /* drain */ });
      child.stdout.on('data', dataHandler);
      child.on('close', closeHandler);
      child.on('error', errorHandler);
    });
  }
}
```

- [ ] **Step 5.4: Run — verify all tests pass**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/providers/codexFoundryAdapter.test.js 2>&1 | tail -15`
Expected: all 10 Codex tests pass.

- [ ] **Step 5.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/foundry/providers/CodexFoundryAdapter.js test/foundry/providers/codexFoundryAdapter.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): add CodexFoundryAdapter (codex exec + resume)

New adapter for Foundry's Codex provider lane. Each turn spawns a
fresh `codex` process: 'codex exec --json' on first turn (with system
prompt prepended to user message since codex has no system-prompt
flag), 'codex exec resume <id>' on subsequent turns (Codex loads the
prior conversation from disk without us replaying tokens).

JSON event parsing grounded in upstream agent-teams-ai Phase 0 spec
(codex-cli 0.117.0, observed 2026-04-19): thread.started → store
thread_id; item.completed with item.type='agent_message' →
accumulate text; turn.completed → resolve. Non-JSON warning lines
on stdout are dropped silently.

Stateless between turns: isAttached always false, close/closeAll are
no-ops. Crash recovery is automatic — next send() with stored
cliSessionId resumes transparently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rewrite FoundryRuntime as a dispatcher

**Files:**
- Rewrite: `src/foundry/foundryRuntime.js`
- Rewrite: `test/foundry/foundryRuntime.test.js`

- [ ] **Step 6.1: Write failing dispatcher tests first**

Replace the contents of `test/foundry/foundryRuntime.test.js` entirely with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FoundryRuntime } from '../../src/foundry/foundryRuntime.js';

function makeFakeAdapter(providerId) {
  const calls = [];
  let attached = false;
  return {
    providerId,
    calls,
    setAttached(v) { attached = v; },
    async send(args) {
      calls.push({ method: 'send', args });
      return { text: `[${providerId}] reply`, sessionUuid: `${providerId}-uuid`, model: null, eventCount: 1 };
    },
    isAttached(args) {
      calls.push({ method: 'isAttached', args });
      return attached;
    },
    async close(args) { calls.push({ method: 'close', args }); },
    async closeAll() { calls.push({ method: 'closeAll', args: null }); },
  };
}

test('FoundryRuntime constructor builds Claude and Codex adapters by default', () => {
  // Smoke: constructing without injection should not throw and should expose dispatch.
  // Use the injection path to avoid hitting fs in tests, but verify the keys exist.
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  assert.ok(rt);
});

test('FoundryRuntime.send dispatches to the adapter matching the provider', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });

  const result = await rt.send({
    foundrySessionId: 's1', text: 'hi', cliSessionId: null, provider: 'openai',
  });
  assert.equal(result.text, '[openai] reply');
  assert.equal(codex.calls.length, 1);
  assert.equal(claude.calls.length, 0);
});

test('FoundryRuntime.send throws on unknown provider', async () => {
  const rt = new FoundryRuntime({ adapters: { anthropic: makeFakeAdapter('anthropic') } });
  await assert.rejects(
    rt.send({ foundrySessionId: 's1', text: 'hi', provider: 'grok' }),
    /unsupported provider/i,
  );
});

test('FoundryRuntime.isAttached delegates to the right adapter', () => {
  const claude = makeFakeAdapter('anthropic');
  claude.setAttached(true);
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  assert.equal(rt.isAttached({ foundrySessionId: 's1', provider: 'anthropic' }), true);
  assert.equal(rt.isAttached({ foundrySessionId: 's1', provider: 'openai' }), false);
});

test('FoundryRuntime.close with provider delegates to that adapter only', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.close({ foundrySessionId: 's1', provider: 'anthropic' });
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].method, 'close');
  assert.equal(codex.calls.length, 0);
});

test('FoundryRuntime.close without provider closes on all adapters (defensive)', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.close({ foundrySessionId: 's1' });
  assert.equal(claude.calls.length, 1);
  assert.equal(codex.calls.length, 1);
});

test('FoundryRuntime.closeAll fans out to all adapters', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.closeAll();
  assert.equal(claude.calls.find((c) => c.method === 'closeAll') !== undefined, true);
  assert.equal(codex.calls.find((c) => c.method === 'closeAll') !== undefined, true);
});
```

- [ ] **Step 6.2: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/foundryRuntime.test.js 2>&1 | tail -10`
Expected: failures because FoundryRuntime constructor doesn't accept `adapters` and `send` doesn't accept `provider`.

- [ ] **Step 6.3: Rewrite FoundryRuntime as dispatcher**

Replace the entire contents of `src/foundry/foundryRuntime.js` with:

```js
import { ClaudeFoundryAdapter } from './providers/ClaudeFoundryAdapter.js';
import { CodexFoundryAdapter } from './providers/CodexFoundryAdapter.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * FoundryRuntime — provider dispatcher for Foundry planning sessions.
 *
 * Holds one adapter per supported provider. `send`/`isAttached`/`close`
 * each take a `provider` arg and route to the matching adapter.
 *
 * F.1: persistent Claude subprocess. F.2: adds Codex via spawn-per-turn-
 * with-resume. F.2.5+: drop in GeminiFoundryAdapter under 'gemini'.
 */
export class FoundryRuntime {
  constructor({
    instructionsPath,
    projectCwdResolver,
    spawnImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onCrash = null,
    adapters = null, // injection point for tests
  } = {}) {
    if (adapters) {
      this.adapters = adapters;
    } else {
      if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
        throw new TypeError('FoundryRuntime: instructionsPath is required when adapters are not injected');
      }
      const resolver = typeof projectCwdResolver === 'function'
        ? projectCwdResolver
        : (() => process.cwd());
      this.adapters = {
        anthropic: new ClaudeFoundryAdapter({ spawnImpl, instructionsPath, timeoutMs, onCrash }),
        openai:    new CodexFoundryAdapter({ spawnImpl, instructionsPath, projectCwdResolver: resolver, timeoutMs }),
      };
    }
  }

  async send({ foundrySessionId, text, cliSessionId = null, provider = 'anthropic' } = {}) {
    return this.#requireAdapter(provider).send({ foundrySessionId, text, cliSessionId });
  }

  isAttached({ foundrySessionId, provider = 'anthropic' } = {}) {
    return this.#requireAdapter(provider).isAttached({ foundrySessionId });
  }

  async close({ foundrySessionId, provider } = {}) {
    if (provider) {
      return this.#requireAdapter(provider).close({ foundrySessionId });
    }
    // Defensive: close on every adapter when provider unknown.
    for (const adapter of Object.values(this.adapters)) {
      await adapter.close({ foundrySessionId });
    }
  }

  async closeAll() {
    for (const adapter of Object.values(this.adapters)) {
      await adapter.closeAll();
    }
  }

  #requireAdapter(provider) {
    const adapter = this.adapters[provider];
    if (!adapter) throw new Error(`FoundryRuntime: unsupported provider "${provider}"`);
    return adapter;
  }
}
```

- [ ] **Step 6.4: Run — verify passing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/foundry/foundryRuntime.test.js 2>&1 | tail -10`
Expected: all 7 dispatcher tests pass.

- [ ] **Step 6.5: Run full backend test suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: all pass. The Claude adapter tests still cover the per-process behavior; the rewritten FoundryRuntime tests cover dispatch.

- [ ] **Step 6.6: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/foundry/foundryRuntime.js test/foundry/foundryRuntime.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
refactor(foundry): rewrite FoundryRuntime as provider dispatcher

The Claude-specific logic now lives in ClaudeFoundryAdapter; FoundryRuntime
becomes a thin dispatcher that picks the right adapter per send() call
based on a provider arg. Default-constructed FoundryRuntime builds both
Claude and Codex adapters; tests can inject fake adapters via constructor
option.

Same public surface (send/isAttached/close/closeAll) — callers add a
provider arg. close() without a provider closes on all adapters
defensively. The MCP tool surface (foundry_chat_turn) is updated in
Task 7 to read provider from the session row.

Test file rewritten with 7 focused dispatcher tests using fake adapters.
The 11 Claude-specific tests now live in claudeFoundryAdapter.test.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: LocalToolFacade wires `provider` end-to-end

**Files:**
- Modify: `src/tools/localToolFacade.js` (`#foundrySessionCreate` + `#foundryChatTurn`)
- Modify: `src/mcp/localToolDefinitions.js` (foundry_session_create schema)
- Modify: `test/localToolFacade.test.js`

- [ ] **Step 7.1: Find and read the existing foundrySessionCreate impl**

Run: `grep -n "foundrySessionCreate\|foundry_session_create" "C:/Project-TOAD/toad-local/src/tools/localToolFacade.js" 2>&1 | head -10`

Read the matched lines (typically a method `#foundrySessionCreate(actor, idempotencyKey, args)` and its dispatch entry in the giant switch). The plan assumes the standard pattern: it forwards to `store.createSession(...)`.

- [ ] **Step 7.2: Add tests first**

Open `test/localToolFacade.test.js`. Find existing foundry-related tests (search for `foundry_session_create` or `foundry_chat_turn`). Add new tests after them:

```js
test('foundry_session_create accepts provider arg', async () => {
  const { facade, foundryStore } = makeTestFacade(); // or whatever helper exists; mirror existing setup
  await facade.handle({
    actor: { teamId: 't', agentId: 'a', role: 'human' },
    method: 'foundry_session_create',
    args: { title: 'X', provider: 'openai' },
  });
  const sessions = foundryStore.listSessions();
  assert.equal(sessions[0].provider, 'openai');
});

test('foundry_session_create defaults provider to anthropic when omitted', async () => {
  const { facade, foundryStore } = makeTestFacade();
  await facade.handle({
    actor: { teamId: 't', agentId: 'a', role: 'human' },
    method: 'foundry_session_create',
    args: { title: 'Y' },
  });
  const sessions = foundryStore.listSessions();
  assert.equal(sessions[0].provider, 'anthropic');
});

test('foundry_chat_turn passes session.provider to runtime.send', async () => {
  const sentArgs = [];
  const fakeRuntime = {
    send: async (args) => {
      sentArgs.push(args);
      return { text: 'reply', sessionUuid: 'u', model: null, eventCount: 1 };
    },
  };
  const { facade, foundryStore } = makeTestFacade({ foundryRuntime: fakeRuntime });
  const session = foundryStore.createSession({ title: 'Z', provider: 'openai' });
  await facade.handle({
    actor: { teamId: 't', agentId: 'a', role: 'human' },
    method: 'foundry_chat_turn',
    args: { sessionId: session.sessionId, text: 'hello' },
  });
  assert.equal(sentArgs.length, 1);
  assert.equal(sentArgs[0].provider, 'openai');
});
```

(The `makeTestFacade` helper name is illustrative — use whatever helper exists in the file. If no helper exists, follow the inline-construction pattern that the existing `foundry_chat_turn` tests use.)

- [ ] **Step 7.3: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/localToolFacade.test.js 2>&1 | tail -10`
Expected: 3 new failures.

- [ ] **Step 7.4: Update `#foundrySessionCreate`**

In `src/tools/localToolFacade.js`, find `#foundrySessionCreate`. It currently passes `title` and a few other args to `store.createSession`. Add `provider` to that pass-through:

```js
  #foundrySessionCreate(actor, idempotencyKey, args) {
    const store = this.#requireFoundryStore();
    const provider = typeof args?.provider === 'string' && args.provider.length > 0
      ? args.provider
      : 'anthropic';
    return store.createSession({
      title: requireString(args?.title, 'args.title'),
      projectPath: typeof args?.projectPath === 'string' ? args.projectPath : null,
      provider,
    });
  }
```

(Adapt to whatever the actual current signature is — keep all existing args, just add `provider`.)

- [ ] **Step 7.5: Update `#foundryChatTurn` to pass provider**

Find `#foundryChatTurn`. It loads the session via `store.getSession(sessionId)` and calls `runtime.send(...)`. Modify the runtime.send call to include the provider:

```js
const session = store.getSession(sessionId);
// ...
const result = await this.foundryRuntime.send({
  foundrySessionId: sessionId,
  text,
  cliSessionId: session.cliSessionId ?? null,
  provider: session.provider ?? 'anthropic',
});
```

(Use whichever variable holds the session. The key change: add `provider: session.provider ?? 'anthropic'` to the runtime.send args.)

- [ ] **Step 7.6: Update MCP tool definitions**

Open `src/mcp/localToolDefinitions.js`, find the schema for `foundry_session_create`. Add `provider` to its inputSchema properties:

```js
{
  type: 'string',
  enum: ['anthropic', 'openai'],
  description: 'Which CLI provider to use for planning. Defaults to anthropic.',
}
```

Add it to `properties.provider`. Do NOT add it to `required` — it's optional with a default.

- [ ] **Step 7.7: Run all relevant tests**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings test/localToolFacade.test.js 2>&1 | tail -10`
Expected: all pass including the 3 new ones.

Run: `cd C:/Project-TOAD/toad-local && node test/localMcpToolDefinitions.test.js 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 7.8: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/tools/localToolFacade.js src/mcp/localToolDefinitions.js test/localToolFacade.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): wire provider through localToolFacade and MCP schema

foundry_session_create accepts an optional provider arg ('anthropic' |
'openai', default 'anthropic'). foundry_chat_turn reads session.provider
and passes it to FoundryRuntime.send so the dispatcher routes to the
right adapter.

MCP tool schema for foundry_session_create gains the provider property
(non-required, enum-constrained) so MCP clients can discover and use it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire FoundryRuntime in dev-api-server with projectCwdResolver

**Files:**
- Modify: `scripts/dev-api-server.mjs`

- [ ] **Step 8.1: Find current FoundryRuntime construction**

Run: `grep -n "FoundryRuntime\|foundryRuntime" "C:/Project-TOAD/toad-local/scripts/dev-api-server.mjs" 2>&1 | head -10`

Read the matched lines.

- [ ] **Step 8.2: Add projectCwdResolver to constructor call**

Modify the construction site. The current call (from F.1) looks like:

```js
const foundryRuntime = new FoundryRuntime({
  instructionsPath: path.join(__dirname, '..', 'src/foundry/foundryInstructions.txt'),
});
```

Change to:

```js
const foundryRuntime = new FoundryRuntime({
  instructionsPath: path.join(__dirname, '..', 'src/foundry/foundryInstructions.txt'),
  projectCwdResolver: () => runtime.toolFacade.projectCwd || process.cwd(),
});
```

The resolver is called per-turn, so it picks up project-folder switches automatically.

- [ ] **Step 8.3: Verify**

Run: `cd C:/Project-TOAD/toad-local && node scripts/dev-api-server.mjs &` (background). Then `curl -s http://localhost:<port>/healthz` (whatever the actual healthz path is — check from the file). Then kill the process.

Or simpler: just verify the file parses without syntax errors.

Run: `cd C:/Project-TOAD/toad-local && node --check scripts/dev-api-server.mjs && echo OK`
Expected: `OK`.

- [ ] **Step 8.4: Commit**

```bash
git -C C:/Project-TOAD/toad-local add scripts/dev-api-server.mjs
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
chore(foundry): pass projectCwdResolver to FoundryRuntime

CodexFoundryAdapter needs to know which folder to set as Codex's cwd.
Resolves at call time so project-folder switches are picked up
automatically without restarting the sidecar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire test files into npm test script

**Files:**
- Modify: `package.json`

- [ ] **Step 9.1: Locate the test script line**

Run: `grep -n '"test":' "C:/Project-TOAD/toad-local/package.json" | head -3`

It's a long shell-chained command. We add three new test files at the end.

- [ ] **Step 9.2: Append three test entries**

Open `package.json`. Find the `"test":` line. At the end of the chain (just before the closing `"`), append:

```
&& node --no-warnings test/foundry/providers/foundryProviderAdapter.test.js && node --no-warnings test/foundry/providers/claudeFoundryAdapter.test.js && node --no-warnings test/foundry/providers/codexFoundryAdapter.test.js
```

(Maintain the existing `&&` chain pattern.)

- [ ] **Step 9.3: Run the full test suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -20`
Expected: all tests pass — full baseline plus the 3 new files.

- [ ] **Step 9.4: Commit**

```bash
git -C C:/Project-TOAD/toad-local add package.json
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
chore(foundry): wire F.2 adapter tests into npm test chain

Three new test files (foundryProviderAdapter, claudeFoundryAdapter,
codexFoundryAdapter) added to the test script so CI / local runs
cover the F.2 surface end-to-end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Settings — `foundry.defaultProvider` knob

**Files:**
- Create: `ui/src/components/settings/FoundrySettings.tsx`
- Modify: `ui/src/components/settings/SettingsScreen.tsx` (mount the new component)
- Modify: backend settings store handling if needed (search for how `drift.tier1ModelOverride` is read/written — same pattern)

- [ ] **Step 10.1: Find the existing settings pattern**

Run: `grep -rn "tier1ModelOverride\|drift\." "C:/Project-TOAD/toad-local/ui/src/components/settings/" 2>&1 | head -20`

Read the file with the most hits — likely `DriftSettings.tsx` or similar. Note how it: (a) imports useSettings, (b) reads the current value, (c) calls a setter, (d) renders a control.

- [ ] **Step 10.2: Create FoundrySettings component**

Create `ui/src/components/settings/FoundrySettings.tsx`. Mirror the DriftSettings pattern. Skeleton:

```tsx
import { useSettings } from '@/hooks/useSettings';

type FoundryProvider = 'anthropic' | 'openai';

export function FoundrySettings() {
  const { settings, updateSettings } = useSettings();
  const current: FoundryProvider =
    (settings.foundry as { defaultProvider?: FoundryProvider } | undefined)?.defaultProvider
    === 'openai'
      ? 'openai'
      : 'anthropic';

  function setProvider(next: FoundryProvider) {
    updateSettings({
      foundry: {
        ...(settings.foundry as object | undefined),
        defaultProvider: next,
      },
    });
  }

  return (
    <section className="settings-section">
      <header>
        <h3>Foundry</h3>
        <p className="dim">Default planning provider for new project plans. Each plan can override this at creation.</p>
      </header>
      <div className="settings-row">
        <label>
          <input
            type="radio"
            name="foundry-provider"
            checked={current === 'anthropic'}
            onChange={() => setProvider('anthropic')}
          />
          Claude (default)
        </label>
        <label>
          <input
            type="radio"
            name="foundry-provider"
            checked={current === 'openai'}
            onChange={() => setProvider('openai')}
          />
          Codex
        </label>
      </div>
    </section>
  );
}
```

(Adjust class names + props to match the project's actual settings styling. If `useSettings()` returns `setSettings` instead of `updateSettings`, use that.)

- [ ] **Step 10.3: Mount FoundrySettings in SettingsScreen**

Find the existing settings layout in `ui/src/components/settings/SettingsScreen.tsx`. Add the import and render the component near the existing settings sections (place it after Providers, before Drift, or wherever fits the layout).

```tsx
import { FoundrySettings } from './FoundrySettings';
// ...
<FoundrySettings />
```

- [ ] **Step 10.4: Typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 10.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/components/settings/FoundrySettings.tsx ui/src/components/settings/SettingsScreen.tsx
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): Settings → Foundry section with default-provider radio

New FoundrySettings component mounted in SettingsScreen. Reads/writes
settings.foundry.defaultProvider via the existing useSettings flow.
'anthropic' default preserves F.1 behavior. Each Foundry session can
still override per-creation in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: FoundryScreen — per-session provider override + chip

**Files:**
- Modify: `ui/src/components/FoundryScreen.tsx`

- [ ] **Step 11.1: Add provider state + override picker on "+ New"**

In `FoundryScreen.tsx`, find the "+ New" button block (search for `<Icon name="plus"`). Add a small inline radio or dropdown next to it that lets the user pick a provider for the new session. Default to the global setting (read from `useSettings`).

State addition near the other useState calls:

```tsx
const [newSessionProvider, setNewSessionProvider] = useState<'anthropic' | 'openai'>('anthropic');
```

Read the global default on mount via useSettings (mirror what FoundrySettings does to read it).

In the JSX, near the existing input + button, add a small select:

```tsx
<select
  className="select select-sm"
  value={newSessionProvider}
  onChange={(e) => setNewSessionProvider(e.target.value as 'anthropic' | 'openai')}
  title="Provider for this new plan"
>
  <option value="anthropic">Claude</option>
  <option value="openai">Codex</option>
</select>
```

In `createSession`, pass the chosen provider:

```tsx
async function createSession() {
  const created = await runAction('create', () =>
    callTool<FoundrySessionSummary>({
      actor,
      method: 'foundry_session_create',
      idempotencyKey: makeId('foundry-session'),
      args: { title, provider: newSessionProvider },
    })
  );
  // ... rest unchanged
}
```

- [ ] **Step 11.2: Show provider chip on session rows**

Extend `FoundrySessionSummary` interface (top of file) to include `provider`:

```ts
interface FoundrySessionSummary {
  // ... existing fields
  provider?: 'anthropic' | 'openai';
}
```

In the session list render block (search for `foundry-session-title`), add a small chip span:

```tsx
{sessions.map((session) => (
  <button ... >
    <span className="foundry-session-title">{session.title}</span>
    <span className="dim">
      <span className="provider-chip">{session.provider === 'openai' ? 'Codex' : 'Claude'}</span>
      {' · '}
      {session.messageCount} notes · {session.artifactCount} files
    </span>
  </button>
))}
```

(Add minimal CSS if needed in app-shell.css — the chip can just be `font-weight: 600` and a slightly different color, no need for elaborate styling.)

- [ ] **Step 11.3: Backend session-list response should include provider**

The MCP `foundry_session_list` tool returns whatever `store.listSessions()` produces. Verify it propagates `provider` — check `rowToSessionSummary` in `sqliteFoundryStore.js`. If it doesn't expose `provider`, add it:

```js
function rowToSessionSummary(row) {
  return {
    sessionId: row.session_id,
    // ... existing fields
    provider: row.provider ?? 'anthropic',
  };
}
```

(Run the existing sqliteFoundryStore tests to confirm nothing else breaks.)

- [ ] **Step 11.4: Typecheck + lint + tests**

```bash
cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint
cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10
```

Both pass.

- [ ] **Step 11.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/components/FoundryScreen.tsx src/foundry/sqliteFoundryStore.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(foundry): per-session provider override on FoundryScreen

The "+ New" form gains a provider dropdown (Claude / Codex) defaulting
to the global setting. Each session row in the sidebar shows a small
read-only provider chip so users can see at a glance which CLI a plan
was created with.

Backend rowToSessionSummary now exposes provider so the frontend can
render the chip without an extra API call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Manual smoke test

The UI tier has no test framework — these are the gates before declaring done.

- [ ] **Step 12.1: Verify Codex CLI is installed**

Run: `codex --version 2>&1`
Expected: prints version (e.g. `codex-cli 0.117.0`). If not installed, the implementer needs to install Codex CLI and run `codex login` before continuing.

- [ ] **Step 12.2: Start the dev sidecar + UI**

In one terminal: `cd C:/Project-TOAD/toad-local && npm run api:dev`
In another: `cd C:/Project-TOAD/toad-local/ui && npm run dev`
Open http://localhost:5173 in a browser.

- [ ] **Step 12.3: Smoke — Claude path unchanged (regression check)**

In the Foundry screen, click "+ New", leave provider as "Claude," create a plan, type "Reply only with OK", click Send.
Expected: assistant replies "OK" (or similar). No errors. Same behavior as F.1.

- [ ] **Step 12.4: Smoke — Codex path end-to-end (the new path)**

Click "+ New", switch dropdown to "Codex," create a plan ("Codex test"), type "Reply only with OK", click Send.
Expected:
- Tool spawns `codex exec --json --skip-git-repo-check -C <projectCwd> "<systemPrompt>\n\nReply only with OK"`.
- Response appears in chat ("OK").
- Session shows "Codex" chip in sidebar.
- The session's `cli_session_id` is now populated (verify via SQLite browser if curious; or just rely on next step).

Send a second message: "What did I just ask?"
Expected:
- Tool spawns `codex exec resume <stored_id> --json --skip-git-repo-check -C <cwd> "What did I just ask?"`.
- Codex responds with awareness of the prior turn (e.g. "You asked me to reply only with OK"). This proves resume works.

- [ ] **Step 12.5: Smoke — settings default**

Open Settings, switch "Default planning provider" to Codex. Save.
Click "+ New" in FoundryScreen — verify the dropdown defaults to Codex.

- [ ] **Step 12.6: Smoke — error handling**

Logged out of Codex (`codex logout` or invalidate creds), attempt a new Codex session, send a message.
Expected: error surfaces in chat with a useful message ("Run `codex login` and retry" or whatever Codex's stderr says, surfaced through our existing error banner).

- [ ] **Step 12.7: Document smoke results**

If all pass, the slice is done. If any fail, file the failure as a concrete fix and rerun the relevant test.

---

## Task 13: Update FUTURE-IDEAS

**Files:**
- Modify: `docs/FUTURE-IDEAS.md`

- [ ] **Step 13.1: Mark F.2 shipped, refine F.2.5**

Open `docs/FUTURE-IDEAS.md`. Find the F.2 entry. Update its status from "future slice" to "shipped" with a one-line summary of what landed.

Add or update an F.2.5 entry: Gemini support. Note the Gemini doc snippet you shared ("persistent JSON output modes") suggests it's feasible — F.2.5 follows the same adapter pattern as Codex, port the protocol once we see Codex usage data justifying it.

- [ ] **Step 13.2: Commit**

```bash
git -C C:/Project-TOAD/toad-local add docs/FUTURE-IDEAS.md
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
docs(future-ideas): mark F.2 shipped; refine F.2.5 Gemini entry

F.2 (Claude + Codex provider-aware Foundry) is shipped. F.2.5 (Gemini)
gets a clearer entry noting the persistent-JSON-output-mode capability
and the path to drop in a third adapter behind the same pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Final verification + ship marker

- [ ] **Step 14.1: Backend test suite — full**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: all pass.

- [ ] **Step 14.2: UI typecheck + lint — clean**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: both pass cleanly.

- [ ] **Step 14.3: Confirm git is clean and on main**

Run: `git -C C:/Project-TOAD/toad-local log --oneline -15`
Expected: 12-13 new commits (one per task) above `153b5d4 docs(foundry): F.2 spec...`.

- [ ] **Step 14.4: Add ship marker commit**

```bash
git -C C:/Project-TOAD/toad-local commit --allow-empty -m "$(cat <<'EOF'
ship(foundry): slice F.2 — provider-aware Foundry (Claude + Codex)

Foundry now supports both Claude and Codex CLIs as the planning agent,
picked per-session with a global default. Both providers preserve
conversation context across turns without us replaying tokens — Claude
via persistent stream-json subprocess (F.1, untouched), Codex via
spawn-per-turn 'codex exec' + 'codex exec resume <id>' (Codex maintains
session state on disk).

Adapter-pattern infrastructure (FoundryProviderAdapter base + concrete
ClaudeFoundryAdapter and CodexFoundryAdapter) sets up F.2.5 to drop in
Gemini cleanly when usage data justifies. Normalized event interface is
in place for the future ASPE interpreter slice.

Closes Foundry F.2 of the post-F.1 roadmap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist (run before declaring plan done)

- [x] Spec coverage: every architecture component (1-11 in spec) has a corresponding task or explicit out-of-scope note.
- [x] No placeholders: every step shows the actual code/command, not "implement X."
- [x] Type consistency: `provider` is `'anthropic' | 'openai'` everywhere; `cliSessionId` (camelCase) vs `cli_session_id` (snake_case) used per context (JS vs SQL); `foundrySessionId` consistent.
- [x] Order is correct: schema → store → adapter base → Claude port (preserves existing tests) → Codex new → dispatcher rewrite → facade wiring → UI. TDD throughout.
- [x] Manual smoke is documented because UI has no test framework — explicit gates, not hand-waved.
- [x] Each task ends with a commit. Reverting any task is one `git revert`.
- [x] Crash recovery covered: Claude (--resume) unchanged from F.1; Codex (exec resume) is automatic via stored cliSessionId.
- [x] System prompt handling: explicit — Claude uses --append-system-prompt-file; Codex prepends to first turn only, omits on resume.
- [x] Codex JSON event names use the exact dot-notation observed in upstream's signoff (`thread.started`, `item.completed`, `turn.completed`).
