# Foundry Slice F.1 — CLI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `toad-local/docs/specs/2026-05-09-foundry-slice-f1-cli-migration-design.md`

**Goal:** Migrate Foundry's LLM call from OpenAI API (`https://api.openai.com/v1/responses`) to a persistent Claude CLI subprocess. Identical 7-doc output, identical operator UX, just running on subscription instead of API.

**Architecture:** New `FoundryRuntime` module manages one `claude` child process per Foundry session, held alive across chat turns. User messages pipe via stdin in stream-json format; assistant responses parse from stdout. Process lifecycle: lazy spawn on first turn, reused for subsequent turns, reaped on session close or sidecar shutdown. Crash recovery via `--resume <uuid>` from Claude's on-disk session storage.

**Tech Stack:** Node 20+ ESM, `node:child_process`, `node:test`, no new runtime deps.

**Test discipline:** TDD throughout. `FoundryRuntime` tests inject a fake `spawnImpl` so no real `claude` process is ever launched in CI. The full test chain runs in <10s post-slice.

---

## Plan-vs-spec adjustment

The spec's §1 architecture diagram referenced reusing `ClaudeStreamJsonAdapter` from the runtime tier. **The plan inlines a small stream-json line parser inside `FoundryRuntime` instead.** Reason: `ClaudeStreamJsonAdapter` extends `RuntimeAdapter` and takes `{runtimeId, teamId, agentId, child}` — agent-runtime concepts that don't apply to Foundry. The adapter also has tool-call tracking, turn boundaries, and other runtime-specific logic Foundry doesn't need. Inline parsing is ~20 LOC, focused on the single event type Foundry cares about (`assistant_message`), and avoids the conceptual mismatch.

---

## File structure

```
src/storage/schema.sql                      Task 1 — ALTER foundry_sessions ADD cli_session_id
src/storage/sqlite.js                       Task 1 — applyMigrations entry for existing DBs
src/foundry/sqliteFoundryStore.js           Task 2 — setCliSessionId + cliSessionId field exposure
src/foundry/foundryInstructions.txt         Task 3 — NEW (extracted from FOUNDRY_CHAT_INSTRUCTIONS const)
src/foundry/foundryRuntime.js               Tasks 4-7 — NEW: persistent-subprocess manager
src/tools/localToolFacade.js                Tasks 8-9 — #foundryChatTurn rewrite + dead-code removal
scripts/dev-api-server.mjs                  Task 10 — construct FoundryRuntime + inject + shutdown hooks

test/foundry/sqliteFoundryStore.test.js     Task 2 — extend with cli_session_id round-trip tests
test/foundry/foundryRuntime.test.js         Tasks 4-7 — NEW: full coverage with injected fake spawn
test/localToolFacade.test.js                Task 8 — replace callOpenAiFoundry mocks with foundryRuntime injection
package.json                                Task 11 — extend npm test chain
```

12 tasks total across 6 phases.

---

## Phase 1 — Schema + storage

### Task 1: Schema migration for `cli_session_id` column

**Files:**
- Modify: `src/storage/schema.sql` (add column to `CREATE TABLE foundry_sessions`)
- Modify: `src/storage/sqlite.js` (applyMigrations entry for existing DBs)

- [ ] **Step 1: Add column to `CREATE TABLE foundry_sessions`**

In `src/storage/schema.sql`, find the existing `CREATE TABLE IF NOT EXISTS foundry_sessions` block (around line 186). Add `cli_session_id TEXT` as the last column before the closing paren. The block becomes:

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

(Whitespace alignment matches existing style — column names start at column 3.)

- [ ] **Step 2: Add applyMigrations entry**

In `src/storage/sqlite.js`, find the `applyMigrations` function (around line 37). Append, before the closing brace:

```js
  // Foundry Slice F.1: persistent CLI session UUID per Foundry session.
  try { db.exec('ALTER TABLE foundry_sessions ADD COLUMN cli_session_id TEXT'); } catch {}
```

(Bare `catch {}` is the established pattern for "swallow duplicate-column errors on already-migrated DBs.")

- [ ] **Step 3: Verify schema parses + column exists on a fresh DB**

```bash
node -e "const { DatabaseSync } = require('node:sqlite'); const fs = require('fs'); const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync('src/storage/schema.sql', 'utf8')); console.log('schema OK'); const cols = db.prepare(\"PRAGMA table_info(foundry_sessions)\").all(); console.log('cols:', cols.map(c => c.name).join(','));"
```

Expected output:
```
schema OK
cols: session_id,title,status,project_path,created_at,updated_at,metadata_json,cli_session_id
```

- [ ] **Step 4: Run `npm test`**

Expected: full suite green. The new column is optional (nullable, no default) so existing tests that don't reference it continue to pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.sql src/storage/sqlite.js
git commit -m "$(cat <<'EOF'
feat(foundry): cli_session_id column on foundry_sessions

Foundation for slice F.1 — persistent Claude CLI subprocess pattern.
The column stores Claude Code's session UUID so crash recovery via
--resume can reload conversation state from disk.

Both fresh-DB path (CREATE TABLE) and existing-DB path
(applyMigrations) handled per the slice-3 schema-migration pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: SqliteFoundryStore — setCliSessionId + cliSessionId field

**Files:**
- Modify: `src/foundry/sqliteFoundryStore.js` (new method + rowToSession update)
- Modify: `test/foundry/sqliteFoundryStore.test.js` (append tests)

- [ ] **Step 1: Append failing tests to `test/foundry/sqliteFoundryStore.test.js`**

```js
test('SqliteFoundryStore.setCliSessionId stamps cli_session_id on the session row', () => {
  const { store } = makeStore();
  const session = store.createSession({ title: 'Test session' });
  store.setCliSessionId({ sessionId: session.sessionId, cliSessionId: 'claude-uuid-1' });
  const fetched = store.getSession(session.sessionId);
  assert.equal(fetched.session.cliSessionId, 'claude-uuid-1');
});

test('SqliteFoundryStore.getSession exposes cliSessionId as null when unset', () => {
  const { store } = makeStore();
  const session = store.createSession({ title: 'Test session' });
  const fetched = store.getSession(session.sessionId);
  assert.equal(fetched.session.cliSessionId, null);
});

test('SqliteFoundryStore.setCliSessionId is idempotent (safe to re-call with same value)', () => {
  const { store } = makeStore();
  const session = store.createSession({ title: 'Test session' });
  store.setCliSessionId({ sessionId: session.sessionId, cliSessionId: 'claude-uuid-1' });
  store.setCliSessionId({ sessionId: session.sessionId, cliSessionId: 'claude-uuid-1' });
  const fetched = store.getSession(session.sessionId);
  assert.equal(fetched.session.cliSessionId, 'claude-uuid-1');
});
```

(Reuse the existing `makeStore` helper at the top of the test file. If `createSession` doesn't already exist, look for `addSession` or similar — the existing test file's first 30 lines will reveal the right helper.)

- [ ] **Step 2: Run tests, watch them fail**

```bash
node --no-warnings test/foundry/sqliteFoundryStore.test.js
```

Expected: 3 new tests fail with "store.setCliSessionId is not a function" or "session.cliSessionId is undefined".

- [ ] **Step 3: Add `setCliSessionId` method to `SqliteFoundryStore`**

In `src/foundry/sqliteFoundryStore.js`, add the method to the class (place it near other UPDATE-style methods — around line 230 next to the existing `UPDATE foundry_sessions SET updated_at` pattern):

```js
setCliSessionId({ sessionId, cliSessionId } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('setCliSessionId: sessionId is required');
  }
  if (typeof cliSessionId !== 'string' || cliSessionId.length === 0) {
    throw new TypeError('setCliSessionId: cliSessionId is required');
  }
  const now = new Date().toISOString();
  this.db.prepare(
    'UPDATE foundry_sessions SET cli_session_id = ?, updated_at = ? WHERE session_id = ?'
  ).run(cliSessionId, now, sessionId);
}
```

- [ ] **Step 4: Update `rowToSession` to expose `cliSessionId`**

Find the `function rowToSession(row)` helper at line 236. Add the new field:

```js
function rowToSession(row) {
  return {
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    projectPath: row.project_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: jsonParseObject(row.metadata_json, {}),
    cliSessionId: row.cli_session_id ?? null,
  };
}
```

- [ ] **Step 5: Run tests, watch them PASS**

```bash
node --no-warnings test/foundry/sqliteFoundryStore.test.js
```

Expected: all green (existing tests + 3 new).

- [ ] **Step 6: Run `npm test`** for full-suite green.

- [ ] **Step 7: Commit**

```bash
git add src/foundry/sqliteFoundryStore.js test/foundry/sqliteFoundryStore.test.js
git commit -m "$(cat <<'EOF'
feat(foundry): SqliteFoundryStore.setCliSessionId + cliSessionId exposure

Per-session UUID gets stamped on first chat turn (Task 8) and read on
subsequent turns / crash recovery. rowToSession adds the field so
getSession returns it alongside the rest of the session shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Instructions extraction

### Task 3: Extract FOUNDRY_CHAT_INSTRUCTIONS to file

**Files:**
- Create: `src/foundry/foundryInstructions.txt` (the prompt text, extracted verbatim)
- Modify: `src/tools/localToolFacade.js` (DO NOT remove the const yet — that's Task 9; just verify the file matches)

- [ ] **Step 1: Read the existing const value**

The const lives in `src/tools/localToolFacade.js` around line 3302 (`const FOUNDRY_CHAT_INSTRUCTIONS = [...]`) and is an array of strings joined with newlines. Run:

```bash
node -e "const m = require('./src/tools/localToolFacade.js'); /* if exported */"
```

This won't work because the const isn't exported. Instead, manually read the file:

```bash
sed -n '3302,3450p' src/tools/localToolFacade.js
```

Copy the joined-newline content (the `.join('\n')` result of the array) into the new text file.

- [ ] **Step 2: Create `src/foundry/foundryInstructions.txt`** with the content from the const

The file is plain text, no JS array syntax, no quotes, no commas. Each line of the original array becomes a line of the file. Example shape:

```
You are Symphony AI Foundry — a senior product and systems architect helping the operator scope a software project for an AI-agent team to build.

YOUR DELIVERABLE is seven documents the team lead and every teammate will use:
  1. brief.md             — Product brief with EARS-notation requirements
  2. tech_spec.md         — Architecture, component design, sequences, error handling, testing strategy
  ...
```

(Full content matches `FOUNDRY_CHAT_INSTRUCTIONS.join('\n')` from the const.)

- [ ] **Step 3: Verify the file content matches the const exactly**

```bash
node -e "
const fs = require('fs');
const fileContent = fs.readFileSync('src/foundry/foundryInstructions.txt', 'utf8');
// Read the const from localToolFacade.js by parsing it as a string
const facadeSrc = fs.readFileSync('src/tools/localToolFacade.js', 'utf8');
const constStart = facadeSrc.indexOf('const FOUNDRY_CHAT_INSTRUCTIONS');
const arrayStart = facadeSrc.indexOf('[', constStart);
const arrayEnd = facadeSrc.indexOf('].join', arrayStart);
const arrayBody = facadeSrc.slice(arrayStart + 1, arrayEnd);
// Crude eval — only valid because the array is well-formed string literals
const arr = eval('[' + arrayBody + ']');
const constContent = arr.join('\n');
console.log('match:', fileContent === constContent);
console.log('file len:', fileContent.length, 'const len:', constContent.length);
"
```

Expected: `match: true`. If the lengths differ but match value is true, that's still a pass. If `match: false`, eyeball the diff and adjust the file.

- [ ] **Step 4: Run `npm test`**

Expected: green. Nothing in the codebase reads the new file yet; this is a pre-position before Task 8 wires it in.

- [ ] **Step 5: Commit**

```bash
git add src/foundry/foundryInstructions.txt
git commit -m "$(cat <<'EOF'
chore(foundry): extract FOUNDRY_CHAT_INSTRUCTIONS to file

Foundry's system prompt moves to src/foundry/foundryInstructions.txt
verbatim. The localToolFacade const is still the live source today;
Task 8 wires the file in via Claude's --append-system-prompt-file flag,
Task 9 deletes the now-dead const. Splitting into two commits keeps
the prompt extraction reviewable independently of the spawn refactor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — FoundryRuntime module

### Task 4: FoundryRuntime — basic spawn + send (TDD)

**Files:**
- Create: `src/foundry/foundryRuntime.js`
- Create: `test/foundry/foundryRuntime.test.js`

- [ ] **Step 1: Write failing tests in `test/foundry/foundryRuntime.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FoundryRuntime } from '../../src/foundry/foundryRuntime.js';

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

test('FoundryRuntime.send spawns claude with the locked flag set on first call', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  // Resolve the send Promise by emitting a stream-json assistant_message
  const sendPromise = rt.send({ foundrySessionId: 's1', text: 'hello' });

  // Simulate Claude bootstrapping + responding
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-uuid-1' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'world' }], model: 'claude-sonnet-4' },
  }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));

  const result = await sendPromise;

  // Assertions on spawn args
  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.equal(call.cmd, 'claude');
  assert.ok(call.args.includes('--verbose'));
  assert.ok(call.args.includes('--input-format'));
  assert.ok(call.args.includes('stream-json'));
  assert.ok(call.args.includes('--output-format'));
  assert.ok(call.args.includes('--append-system-prompt-file'));
  assert.ok(call.args.includes('/tmp/inst.txt'));
  assert.ok(call.args.includes('--disallowedTools'));
  assert.ok(call.args.includes('*'));
  assert.ok(call.args.includes('--session-id'));

  // Assertions on stdin
  assert.equal(child.stdin.written.length, 1);
  const written = JSON.parse(child.stdin.written[0]);
  assert.equal(written.type, 'user');
  assert.equal(written.message.content[0].text, 'hello');

  // Assertions on result
  assert.equal(result.text, 'world');
  assert.equal(result.sessionUuid, 'claude-uuid-1');
  assert.equal(result.model, 'claude-sonnet-4');
});

test('FoundryRuntime.send rejects when subprocess crashes before assistant_message', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const sendPromise = rt.send({ foundrySessionId: 's1', text: 'hello' });
  // Simulate process crash (no assistant message ever delivered)
  process.nextTick(() => child.emit('close', 1));

  await assert.rejects(sendPromise, /closed|crashed|exit/i);
});
```

- [ ] **Step 2: Run tests, watch them fail**

```bash
node --no-warnings --test test/foundry/foundryRuntime.test.js
```

Expected: FAIL — `Cannot find module '../../src/foundry/foundryRuntime.js'`.

- [ ] **Step 3: Create `src/foundry/foundryRuntime.js`** with the basic spawn + send (no registry yet — that's Task 5):

```js
import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per turn

/**
 * FoundryRuntime — manages persistent Claude CLI subprocesses for Foundry
 * planning sessions. Mirrors RuntimeSupervisor's pattern at the runtime
 * tier: one child process per Foundry session, held alive across chat
 * turns, killed on session close or sidecar shutdown.
 *
 * Per-turn flow:
 *   - First call for a session: spawn `claude` with --session-id <uuid> +
 *     stream-json IO. Process held in registry.
 *   - Subsequent calls: reuse the existing process, write the new user
 *     message to stdin, await the assistant_message event.
 *   - Crash recovery: if registry has no live process but a cliSessionId
 *     was passed, spawn fresh with --resume <cliSessionId>.
 *
 * Stream-json line parser is inlined (~20 LOC). The runtime tier's
 * ClaudeStreamJsonAdapter is agent-runtime-shaped (RuntimeAdapter base
 * class, turn tracking, tool calls); Foundry's needs are simpler.
 */
export class FoundryRuntime {
  #processes = new Map(); // foundrySessionId -> { child, sessionUuid }

  constructor({
    spawnImpl = defaultSpawn,
    instructionsPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onCrash = null,
  } = {}) {
    if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
      throw new TypeError('FoundryRuntime: instructionsPath is required');
    }
    this.spawnImpl = spawnImpl;
    this.instructionsPath = instructionsPath;
    this.timeoutMs = timeoutMs;
    this.onCrash = typeof onCrash === 'function' ? onCrash : null;
  }

  isLive({ foundrySessionId }) {
    return this.#processes.has(foundrySessionId);
  }

  async send({ foundrySessionId, text, cliSessionId = null } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
      throw new TypeError('FoundryRuntime.send: foundrySessionId required');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('FoundryRuntime.send: text required');
    }

    let entry = this.#processes.get(foundrySessionId);
    if (!entry) {
      entry = this.#spawn({ cliSessionId });
      this.#processes.set(foundrySessionId, entry);
    }

    return this.#runTurn({ entry, text });
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
    return { child, sessionUuid, lineBuffer: '' };
  }

  async #runTurn({ entry, text }) {
    const { child } = entry;

    // Write the user message via stream-json on stdin
    const userPayload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      child.stdin.write(JSON.stringify(userPayload) + '\n');
    } catch (err) {
      throw new Error(`FoundryRuntime: stdin write failed: ${err && err.message ? err.message : err}`);
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
          catch { continue; } // ignore non-JSON noise
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
              reject(new Error('FoundryRuntime: result event before any assistant_message'));
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
        reject(new Error(`FoundryRuntime: subprocess closed (exit=${code}) before result event`));
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
        reject(new Error(`FoundryRuntime: turn timed out after ${this.timeoutMs}ms`));
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

- [ ] **Step 4: Run tests, watch them PASS**

```bash
node --no-warnings --test test/foundry/foundryRuntime.test.js
```

Expected: 2 tests pass.

- [ ] **Step 5: Run `npm test`** — full green.

- [ ] **Step 6: Commit**

```bash
git add src/foundry/foundryRuntime.js test/foundry/foundryRuntime.test.js
git commit -m "$(cat <<'EOF'
feat(foundry): FoundryRuntime — spawn + stream-json send (Task 4 of F.1)

Initial scaffold of FoundryRuntime: spawns `claude` with the locked
flag set, writes a stream-json user message to stdin, parses
assistant_message + result events from stdout, returns text +
sessionUuid + model. No process registry yet (single-session in this
task; multi-session in Task 5).

Inline stream-json parser keeps the module focused — ClaudeStreamJsonAdapter
from the runtime tier is agent-runtime-shaped (turn tracking, tool calls,
RuntimeAdapter base) and over-fits Foundry's simpler needs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: FoundryRuntime — process registry + reuse

**Files:**
- Modify: `src/foundry/foundryRuntime.js`
- Modify: `test/foundry/foundryRuntime.test.js` (append tests)

- [ ] **Step 1: Append failing tests**

```js
test('FoundryRuntime.send reuses the existing process for the same foundrySessionId', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  // Turn 1
  const turn1 = rt.send({ foundrySessionId: 's1', text: 'first' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'uuid-1' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r1' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn1;

  // Turn 2
  const turn2 = rt.send({ foundrySessionId: 's1', text: 'second' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r2' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn2;

  assert.equal(spawn.calls.length, 1, 'should NOT re-spawn for same session');
  assert.equal(child.stdin.written.length, 2, 'should write each turn separately');
});

test('FoundryRuntime.send spawns separate processes for different foundrySessionIds', async () => {
  const child1 = makeFakeChild();
  const child2 = makeFakeChild();
  const spawn = makeFakeSpawn([child1, child2]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn1 = rt.send({ foundrySessionId: 's1', text: 'a' });
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'uuid-a' }) + '\n'));
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a-resp' }], model: 'm' } }) + '\n'));
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn1;

  const turn2 = rt.send({ foundrySessionId: 's2', text: 'b' });
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'uuid-b' }) + '\n'));
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'b-resp' }], model: 'm' } }) + '\n'));
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn2;

  assert.equal(spawn.calls.length, 2);
});

test('FoundryRuntime.isLive reflects registry state', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  assert.equal(rt.isLive({ foundrySessionId: 's1' }), false);
  const turn = rt.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;
  assert.equal(rt.isLive({ foundrySessionId: 's1' }), true);
});
```

- [ ] **Step 2: Run tests, watch them PASS**

The implementation from Task 4 already supports the registry (it stores entries in `#processes`). Run tests:

```bash
node --no-warnings --test test/foundry/foundryRuntime.test.js
```

Expected: all 5 tests pass (2 from Task 4 + 3 new). If any fail because of bugs in the reuse path, fix the code surgically before proceeding.

- [ ] **Step 3: Run `npm test`** — full green.

- [ ] **Step 4: Commit**

```bash
git add test/foundry/foundryRuntime.test.js
git commit -m "$(cat <<'EOF'
test(foundry): FoundryRuntime registry + reuse coverage

Three new tests verify: same foundrySessionId reuses one process,
different IDs spawn separate processes, isLive() reflects the
registry. Implementation from Task 4 already supports this — these
tests pin the contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: FoundryRuntime — close + closeAll lifecycle

**Files:**
- Modify: `src/foundry/foundryRuntime.js` (add close + closeAll methods)
- Modify: `test/foundry/foundryRuntime.test.js` (append tests)

- [ ] **Step 1: Append failing tests**

```js
test('FoundryRuntime.close kills the subprocess and removes it from the registry', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = rt.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  await rt.close({ foundrySessionId: 's1' });
  assert.equal(child._kill, 'SIGTERM');
  assert.equal(rt.isLive({ foundrySessionId: 's1' }), false);
});

test('FoundryRuntime.close is idempotent (safe to call when no process exists)', async () => {
  const rt = new FoundryRuntime({
    spawnImpl: makeFakeSpawn(),
    instructionsPath: '/tmp/inst.txt',
  });
  // Should not throw
  await rt.close({ foundrySessionId: 'never-spawned' });
  assert.equal(rt.isLive({ foundrySessionId: 'never-spawned' }), false);
});

test('FoundryRuntime.closeAll kills every live subprocess', async () => {
  const child1 = makeFakeChild();
  const child2 = makeFakeChild();
  const spawn = makeFakeSpawn([child1, child2]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const t1 = rt.send({ foundrySessionId: 's1', text: 'x' });
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await t1;

  const t2 = rt.send({ foundrySessionId: 's2', text: 'y' });
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await t2;

  await rt.closeAll();
  assert.equal(child1._kill, 'SIGTERM');
  assert.equal(child2._kill, 'SIGTERM');
  assert.equal(rt.isLive({ foundrySessionId: 's1' }), false);
  assert.equal(rt.isLive({ foundrySessionId: 's2' }), false);
});

test('FoundryRuntime.send removes registry entry when subprocess closes unexpectedly', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = rt.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  // Process crashes between turns
  child.emit('close', 1);

  assert.equal(rt.isLive({ foundrySessionId: 's1' }), false);
});
```

- [ ] **Step 2: Run tests, watch them fail** (the close methods don't exist yet, and the auto-cleanup-on-close behavior isn't wired):

```bash
node --no-warnings --test test/foundry/foundryRuntime.test.js
```

Expected: 4 new tests fail.

- [ ] **Step 3: Add close + closeAll + auto-cleanup to `FoundryRuntime`**

In `src/foundry/foundryRuntime.js`, add these methods to the class:

```js
async close({ foundrySessionId } = {}) {
  if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
    return; // idempotent
  }
  const entry = this.#processes.get(foundrySessionId);
  if (!entry) return;
  this.#processes.delete(foundrySessionId);
  try { entry.child.kill('SIGTERM'); } catch { /* already dead */ }
}

async closeAll() {
  const sessionIds = Array.from(this.#processes.keys());
  for (const id of sessionIds) {
    await this.close({ foundrySessionId: id });
  }
}
```

Then update `#spawn` to also wire an unconditional `close`-handler that purges the registry entry when the subprocess dies (whether expectedly via `close()` or unexpectedly via crash):

```js
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

  // Purge registry entry on subprocess close. The `dataHandler`/`closeHandler`
  // wired by #runTurn handles per-turn promise resolution; THIS handler
  // is the cross-turn cleanup so a crashed-between-turns subprocess
  // doesn't leak in the registry forever.
  child.on('close', (code) => {
    // Find which session this child belonged to and purge.
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
```

Update `close()` to set `_intentionalClose` so the crash-callback isn't fired on intentional shutdown:

```js
async close({ foundrySessionId } = {}) {
  if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
    return;
  }
  const entry = this.#processes.get(foundrySessionId);
  if (!entry) return;
  entry._intentionalClose = true;
  this.#processes.delete(foundrySessionId);
  try { entry.child.kill('SIGTERM'); } catch { /* already dead */ }
}
```

- [ ] **Step 4: Run tests, watch them PASS**

```bash
node --no-warnings --test test/foundry/foundryRuntime.test.js
```

Expected: 9 tests total, all pass (5 from Task 4-5 + 4 new).

- [ ] **Step 5: Run `npm test`** — full green.

- [ ] **Step 6: Commit**

```bash
git add src/foundry/foundryRuntime.js test/foundry/foundryRuntime.test.js
git commit -m "$(cat <<'EOF'
feat(foundry): FoundryRuntime close/closeAll + auto-cleanup on crash

close({foundrySessionId}) reaps a single session's subprocess. closeAll
reaps every live subprocess (sidecar shutdown). The spawn path also
wires an unconditional close-handler that purges the registry entry
when the subprocess dies — so a crashed-between-turns process doesn't
leak its registry entry. Optional onCrash callback fires for
non-intentional close events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: FoundryRuntime — `--resume` recovery

**Files:**
- Modify: `test/foundry/foundryRuntime.test.js` (append test)

- [ ] **Step 1: Append failing test**

The `#spawn` method already accepts `cliSessionId` and adds `--resume` if provided. This test verifies the wire-up.

```js
test('FoundryRuntime.send with cliSessionId spawns claude with --resume', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = rt.send({ foundrySessionId: 's1', text: 'x', cliSessionId: 'recovered-uuid' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  const args = spawn.calls[0].args;
  assert.ok(args.includes('--resume'));
  const resumeIdx = args.indexOf('--resume');
  assert.equal(args[resumeIdx + 1], 'recovered-uuid');
  assert.ok(args.includes('--session-id'));
  const sessionIdIdx = args.indexOf('--session-id');
  assert.equal(args[sessionIdIdx + 1], 'recovered-uuid');
});

test('FoundryRuntime.send without cliSessionId does NOT pass --resume', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = rt.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  assert.equal(spawn.calls[0].args.includes('--resume'), false);
});
```

- [ ] **Step 2: Run tests, watch them PASS** (the implementation from Task 4's `#spawn` already handles this):

```bash
node --no-warnings --test test/foundry/foundryRuntime.test.js
```

Expected: 11 total, all pass.

- [ ] **Step 3: Run `npm test`** — full green.

- [ ] **Step 4: Commit**

```bash
git add test/foundry/foundryRuntime.test.js
git commit -m "$(cat <<'EOF'
test(foundry): FoundryRuntime --resume recovery coverage

Two tests verify: when cliSessionId is passed (recovery path), the
spawn args include --resume <uuid> AND --session-id <uuid>. When not
passed (fresh session path), --resume is absent.

Implementation from Task 4 handles this — these tests pin the contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Facade integration

### Task 8: LocalToolFacade — wire FoundryRuntime + rewrite `#foundryChatTurn`

**Files:**
- Modify: `src/tools/localToolFacade.js` (constructor + `#foundryChatTurn`)
- Modify: `test/localToolFacade.test.js` (replace OpenAI mocks with FoundryRuntime mocks)

- [ ] **Step 1: Append failing test to `test/localToolFacade.test.js`**

```js
test('LocalToolFacade foundry_chat_turn delegates to foundryRuntime + persists cliSessionId on first turn', async () => {
  const taskBoard = new InMemoryTaskBoard();
  const broker = new InMemoryBroker();
  const sessionId = 'foundry-session-1';
  const fakeFoundryStore = {
    getSession: (id) => id === sessionId ? {
      session: { sessionId, cliSessionId: null, title: 't' },
      messages: [],
      artifacts: [],
    } : null,
    addMessage: ({ sessionId: sid, role, text, metadata }) => ({
      messageId: `m-${role}-${Date.now()}`,
      sessionId: sid,
      role, text, metadata,
    }),
    setCliSessionId: function ({ sessionId: sid, cliSessionId }) {
      this._lastSetCliSessionId = { sid, cliSessionId };
    },
  };
  const fakeFoundryRuntime = {
    send: async ({ foundrySessionId, text, cliSessionId }) => ({
      text: 'assistant response',
      sessionUuid: 'new-uuid',
      model: 'claude-sonnet-4',
      eventCount: 3,
    }),
  };
  const facade = new LocalToolFacade({
    broker, taskBoard,
    foundryStore: fakeFoundryStore,
    foundryRuntime: fakeFoundryRuntime,
  });

  const result = await facade.execute({
    commandName: COMMANDS.FOUNDRY_CHAT_TURN,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: { sessionId, text: 'plan a meal app' },
    idempotencyKey: 'foundry-chat-test-1',
  });

  assert.equal(result.assistant.text, 'assistant response');
  assert.equal(result.sessionUuid, 'new-uuid');
  assert.equal(fakeFoundryStore._lastSetCliSessionId?.cliSessionId, 'new-uuid');
});

test('LocalToolFacade foundry_chat_turn passes existing cliSessionId on subsequent turns', async () => {
  const taskBoard = new InMemoryTaskBoard();
  const broker = new InMemoryBroker();
  const sessionId = 'foundry-session-2';
  const fakeFoundryStore = {
    getSession: () => ({
      session: { sessionId, cliSessionId: 'existing-uuid', title: 't' },
      messages: [],
      artifacts: [],
    }),
    addMessage: ({ role }) => ({ messageId: 'm', sessionId, role, text: '', metadata: {} }),
    setCliSessionId: function ({ cliSessionId }) { this._calls = (this._calls || 0) + 1; },
  };
  const sendCalls = [];
  const fakeFoundryRuntime = {
    send: async (args) => {
      sendCalls.push(args);
      return { text: 'r', sessionUuid: 'existing-uuid', model: 'm', eventCount: 1 };
    },
  };
  const facade = new LocalToolFacade({
    broker, taskBoard,
    foundryStore: fakeFoundryStore,
    foundryRuntime: fakeFoundryRuntime,
  });

  await facade.execute({
    commandName: COMMANDS.FOUNDRY_CHAT_TURN,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: { sessionId, text: 'next turn' },
    idempotencyKey: 'foundry-chat-test-2',
  });

  assert.equal(sendCalls[0].cliSessionId, 'existing-uuid');
  // setCliSessionId should NOT be called when the session already has one
  assert.equal(fakeFoundryStore._calls ?? 0, 0);
});

test('LocalToolFacade foundry_chat_turn rejects when foundryRuntime is not configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    foundryStore: {
      getSession: () => ({ session: { sessionId: 's', cliSessionId: null }, messages: [], artifacts: [] }),
      addMessage: () => ({ messageId: 'm' }),
    },
    // foundryRuntime intentionally omitted
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.FOUNDRY_CHAT_TURN,
      actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
      args: { sessionId: 's', text: 'x' },
      idempotencyKey: 'k',
    }),
    /foundryRuntime not configured/i,
  );
});
```

- [ ] **Step 2: Run tests, watch them fail**

```bash
node --no-warnings --test test/localToolFacade.test.js
```

Expected: 3 new tests fail (some with "OpenAI" errors because the existing path tries to call OpenAI).

- [ ] **Step 3: Add `foundryRuntime` constructor param to `LocalToolFacade`**

In `src/tools/localToolFacade.js`, in the constructor's destructured params (line 85), add `foundryRuntime = null`. Place it near `foundryStore` for grouping:

```js
constructor({ broker, taskBoard, /* ...existing params... */ foundryStore = null, foundryRuntime = null, /* ...rest... */ } = {}) {
```

In the constructor body (around line 134 where existing fields are stored), add:

```js
this.foundryRuntime = foundryRuntime && typeof foundryRuntime.send === 'function'
  ? foundryRuntime
  : null;
```

- [ ] **Step 4: Rewrite `#foundryChatTurn`**

Replace the existing `#foundryChatTurn` method (around line 2543) with:

```js
async #foundryChatTurn(args) {
  const store = this.#requireFoundryStore();
  const sessionId = requireString(args?.sessionId, 'args.sessionId');
  const text = requireString(args?.text, 'args.text');
  const snapshot = store.getSession(sessionId);
  if (!snapshot) throw new Error(`foundry session not found: ${sessionId}`);
  if (!this.foundryRuntime) {
    throw new Error('foundry_chat_turn: foundryRuntime not configured for this facade');
  }

  const user = store.addMessage({
    sessionId,
    role: 'user',
    text,
    metadata: { source: 'foundry_chat_turn' },
  });

  const response = await this.foundryRuntime.send({
    foundrySessionId: sessionId,
    text,
    cliSessionId: snapshot.session?.cliSessionId ?? null,
  });

  // First turn: persist the new CLI session UUID so subsequent turns can find it.
  if (!snapshot.session?.cliSessionId && response.sessionUuid) {
    store.setCliSessionId({ sessionId, cliSessionId: response.sessionUuid });
  }

  const assistant = store.addMessage({
    sessionId,
    role: 'assistant',
    text: response.text,
    metadata: {
      source: 'claude_cli_subprocess',
      sessionUuid: response.sessionUuid,
      model: response.model,
      eventCount: response.eventCount,
    },
  });

  return {
    sessionId,
    user,
    assistant,
    sessionUuid: response.sessionUuid,
    model: response.model,
  };
}
```

- [ ] **Step 5: Run tests, watch them PASS**

```bash
node --no-warnings --test test/localToolFacade.test.js
```

Expected: all green (existing + 3 new).

- [ ] **Step 6: Run `npm test`** — full green.

- [ ] **Step 7: Commit**

```bash
git add src/tools/localToolFacade.js test/localToolFacade.test.js
git commit -m "$(cat <<'EOF'
feat(foundry): LocalToolFacade #foundryChatTurn delegates to FoundryRuntime

The facade gains a foundryRuntime constructor injection, validated by
typeof .send === 'function'. #foundryChatTurn:
- Pulls the existing cliSessionId from the foundry session snapshot
- Calls foundryRuntime.send() instead of callOpenAiFoundry
- Persists the returned sessionUuid via setCliSessionId on first turn
- Stamps assistant_message metadata with model + sessionUuid +
  eventCount for audit
- Throws a clear error if foundryRuntime is not configured

Old callOpenAiFoundry / OpenAI helpers / openaiFetch are still in the
file — Task 9 deletes them. Splitting Task 8 (wire-up) and Task 9
(deletion) keeps the diffs reviewable independently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Remove OpenAI helpers + dead code

**Files:**
- Modify: `src/tools/localToolFacade.js` (delete dead code)

- [ ] **Step 1: Delete the OpenAI helper functions**

In `src/tools/localToolFacade.js`, delete the following functions/consts (use grep to find exact lines, they're isolated at module scope below the class):

- `function callOpenAiFoundry(...)` (around line 3263, ~40 LOC)
- `const FOUNDRY_CHAT_INSTRUCTIONS = [...]` and its `].join('\n')` close (around line 3302, ~150 LOC)
- `function formatFoundryTranscript(session)` (around line 3452, ~10 LOC)
- `function extractOpenAiText(payload)` (around line 3464, ~15 LOC)
- `function normalizeOpenAiModel(value)` (around line 3482, ~5 LOC)

- [ ] **Step 2: Delete `#resolveOpenAiFoundryConfig` private method**

Find it at line 2767 (~25 LOC). Delete the entire method including its JSDoc.

- [ ] **Step 3: Remove `openaiFetch` from constructor**

Find `openaiFetch = null` in the constructor params (line 85). Remove it. Find `this.openaiFetch = typeof openaiFetch === 'function' ? openaiFetch : null;` (line 134). Remove it.

- [ ] **Step 4: Verify nothing else references the removed symbols**

```bash
grep -n "callOpenAiFoundry\|FOUNDRY_CHAT_INSTRUCTIONS\|formatFoundryTranscript\|extractOpenAiText\|normalizeOpenAiModel\|resolveOpenAiFoundryConfig\|openaiFetch" src/tools/localToolFacade.js
```

Expected: zero matches. If any survive, they're orphaned references — delete them too.

- [ ] **Step 5: Run `npm test`**

Expected: full green. The removed symbols should have only been used by the now-replaced #foundryChatTurn from Task 8.

- [ ] **Step 6: Verify dev-api-server doesn't pass `openaiFetch`**

```bash
grep -n "openaiFetch" scripts/dev-api-server.mjs
```

If matches exist, the call site needs cleaning. Delete the openaiFetch wiring (it's no longer a constructor param). If no matches, dev-api-server is already clean.

- [ ] **Step 7: Run `npm test` again**

Expected: full green.

- [ ] **Step 8: Commit**

```bash
git add src/tools/localToolFacade.js scripts/dev-api-server.mjs 2>/dev/null
git commit -m "$(cat <<'EOF'
refactor(foundry): remove OpenAI API code path now that CLI is wired

Cleanups Task 8 left behind:
- callOpenAiFoundry helper (40 LOC)
- FOUNDRY_CHAT_INSTRUCTIONS const (150 LOC; content lives in
  src/foundry/foundryInstructions.txt as of Task 3)
- formatFoundryTranscript / extractOpenAiText / normalizeOpenAiModel
- #resolveOpenAiFoundryConfig private method
- openaiFetch constructor param + this.openaiFetch field
- dev-api-server's openaiFetch wiring (if present)

Net: ~250 LOC removed. The "your subscription, not API" pitch is
honest — Symphony's facade no longer has any path to api.openai.com.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Production wiring

### Task 10: dev-api-server constructs FoundryRuntime + injects + shutdown hooks

**Files:**
- Modify: `scripts/dev-api-server.mjs`

- [ ] **Step 1: Add imports near the top of `dev-api-server.mjs`**

Find the existing imports section (around line 1-10). Add:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FoundryRuntime } from '../src/foundry/foundryRuntime.js';
```

(`path` and `fileURLToPath` may already be imported; check first.)

- [ ] **Step 2: Construct FoundryRuntime after the runtime is built**

Find where `runtime.toolFacade.driftEngine = driftEngine;` is set (search for `runtime.toolFacade.driftEngine`). After that block, add:

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const foundryInstructionsPath = path.join(
  __dirname, '..', 'src', 'foundry', 'foundryInstructions.txt',
);

const foundryRuntime = new FoundryRuntime({
  instructionsPath: foundryInstructionsPath,
});

if (runtime.toolFacade) {
  runtime.toolFacade.foundryRuntime = foundryRuntime;
}
```

- [ ] **Step 3: Add shutdown hooks**

Find where the existing process handlers live (search for `process.on(`). Add:

```js
// Reap Foundry CLI subprocesses on sidecar shutdown so no orphan
// `claude` processes survive the parent.
const closeFoundryRuntime = () => { try { void foundryRuntime.closeAll(); } catch { /* best effort */ } };
process.on('SIGINT', closeFoundryRuntime);
process.on('SIGTERM', closeFoundryRuntime);
process.on('exit', closeFoundryRuntime);
```

- [ ] **Step 4: Smoke-check syntax**

```bash
node --check scripts/dev-api-server.mjs
```

Expected: silent success.

- [ ] **Step 5: Run `npm test`**

Expected: full green.

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-api-server.mjs
git commit -m "$(cat <<'EOF'
feat(foundry): wire FoundryRuntime + shutdown hooks in dev-api-server

Constructs FoundryRuntime with the bundled foundryInstructions.txt
path, late-injects onto runtime.toolFacade (same pattern driftEngine
uses). SIGINT/SIGTERM/exit handlers call closeAll() so no orphan
claude processes survive sidecar termination.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Final wire-up

### Task 11: Extend npm test chain

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Append the new test file to the test chain**

In `package.json`, find the `"test":` script value. Find a sensible place near other foundry tests (the existing `node --no-warnings test/sqliteFoundryStore.test.js` entry, which is older-format `--test`-less). Append at the END of the chain (preserving the `&&` style):

```
&& node --no-warnings --test test/foundry/foundryRuntime.test.js
```

(One-line entry; the chain already wraps long.)

- [ ] **Step 2: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Run full suite**

```bash
npm test 2>&1 | tail -10
```

Expected: full green; foundryRuntime tests appear in the output.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore(foundry): wire foundryRuntime tests into npm test chain

Adds test/foundry/foundryRuntime.test.js to the && chain.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Final smoke + ship-note commit

**Files:** none modified; verification + housekeeping.

- [ ] **Step 1: Confirm full backend test suite + UI typecheck**

```bash
npm test 2>&1 | tail -10
```

Expected: full green.

```bash
cd ui && npx tsc --noEmit
```

Expected: clean (UI was not touched in this slice).

- [ ] **Step 2: Manual end-to-end smoke (if Claude CLI installed locally)**

Boot the desktop app fresh:
```bash
cd ui && npm run tauri:dev
```

1. Foundry → create new session → type "I want to build a family meal planner."
2. Watch process spawn (`ps -ef | grep claude` should show ONE claude process per Foundry session)
3. Verify the assistant reply renders normally in the chat (same UX as today's API path)
4. Type a follow-up message → confirm same process handles it (no second spawn; `ps` count unchanged)
5. Close the Foundry session → confirm the claude process exits within a few seconds (check `ps` again)
6. Restart the sidecar (kill + relaunch). Reopen the Foundry session → confirm it re-spawns with `--resume` and conversation context is preserved.

If any step fails, investigate before ship-note.

- [ ] **Step 3: Empty ship-note commit**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
ship(foundry): slice F.1 — Claude CLI subprocess migration verified

Closes the "your subscription, not API" cost-story hole. Foundry no
longer calls https://api.openai.com — every Foundry chat turn now
runs through a persistent `claude` subprocess authenticated via the
operator's plan auth.

12 tasks across 6 phases:
- Phase 1 (storage): cli_session_id column on foundry_sessions
- Phase 2 (instructions): FOUNDRY_CHAT_INSTRUCTIONS extracted to file
- Phase 3 (runtime): FoundryRuntime module with spawn, registry, close,
  resume recovery (~10 tests)
- Phase 4 (facade): #foundryChatTurn rewritten; ~250 LOC of OpenAI
  helpers removed
- Phase 5 (wiring): dev-api-server constructs FoundryRuntime +
  shutdown hooks
- Phase 6 (verify): test chain extension + e2e smoke

Backend-only. UI unchanged. Test count: ~10 new test cases. No
regressions.

Provider strategy was Q1 = C (two-step, Claude first). F.2 adds
Codex/Gemini support in a follow-up slice once usage data justifies
the per-provider abstraction. F.3+ (cross-LLM critique, AskUserQuestion,
phase pipeline) tracked in FUTURE-IDEAS.md.

Ready for merge to main.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**1. Spec coverage:**

| Spec section | Implemented in task |
|---|---|
| §1 architecture | Tasks 4-7 (FoundryRuntime), Task 8 (facade integration) |
| §2 module layout | Task 1 (schema), Task 2 (store), Task 3 (instructions file), Tasks 4-7 (FoundryRuntime), Tasks 8-9 (facade), Task 10 (dev-api-server) |
| §3 FoundryRuntime API | Task 4 (send + spawn), Task 5 (registry), Task 6 (close/closeAll + crash purge), Task 7 (--resume) |
| §4 schema migration | Task 1 |
| §5 facade modifications | Task 8 (rewrite), Task 9 (deletions) |
| §6 dev-api-server wiring | Task 10 |
| §7 failure-mode matrix | Tasks 4-7 cover crash + timeout + missing-runtime; Task 8 covers missing-config; Task 10 covers shutdown |
| §8 testing strategy | Tasks 2 (store tests), 4-7 (runtime tests), 8 (facade tests), 11 (chain) |
| §9 risks / non-goals | n/a — these are spec-level commitments, not implementation work |

All spec requirements have a task. ✓

**2. Placeholder scan:** None. Every task has actual code blocks where it changes code; every command has expected output; every test step has both the test code and the implementation code that makes it pass.

**3. Type consistency:**
- `FoundryRuntime.send({foundrySessionId, text, cliSessionId})` signature consistent across Task 4 (definition), Task 5 (registry tests), Task 7 (--resume tests), Task 8 (facade callsite).
- `setCliSessionId({sessionId, cliSessionId})` signature consistent across Task 2 (store implementation + tests) and Task 8 (facade callsite).
- `getSession(sessionId)` returns `{ session: {...}, messages, artifacts }` per the existing API; the new `cliSessionId` lives on `session`, not on the top-level result. Task 8's facade reads `snapshot.session?.cliSessionId` consistently.
- `response.sessionUuid` (camelCase) is used everywhere across Task 4 (return shape), Task 8 (consumer). Internal stream-json events use `session_id` (snake_case); the runtime translates.
- The `--session-id <uuid>` and `--resume <uuid>` flag pair is consistent across Task 4 spawn args + Task 7 tests.

No issues. Plan ready for execution.
