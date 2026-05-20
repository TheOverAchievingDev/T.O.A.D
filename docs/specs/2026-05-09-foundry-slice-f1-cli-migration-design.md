# Foundry Slice F.1 — CLI Migration Design

**Status:** brainstormed 2026-05-09. Migrates Foundry's LLM call from OpenAI API to a persistent Claude CLI subprocess. Closes the "your subscription, not API" cost-story hole.

**Cross-references:**
- `toad-local/docs/FUTURE-IDEAS.md` — Foundry F.2 (provider-aware) and F.3+ (planning-quality enhancements) follow-ups
- `toad-local/src/runtime/RuntimeSupervisor.js` — the persistent-subprocess pattern this design mirrors
- `toad-local/src/runtime/ClaudeStreamJsonAdapter.js` — existing stream-json parser, reused
- `toad-local/src/app/LocalToadRuntime.js:497` — runtime tier's documented flag set (`--verbose --input-format stream-json --output-format stream-json`)
- `toad-local/src/tools/localToolFacade.js:2543` — current `#foundryChatTurn` (the migration target)
- `toad-local/src/tools/localToolFacade.js:3263` — `callOpenAiFoundry` (to be removed)
- `toad-local/src/tools/localToolFacade.js:3302` — `FOUNDRY_CHAT_INSTRUCTIONS` (extract to file)

## The pitch

Symphony's economic differentiator is "use the subscriptions you already have." Foundry violates this — it's the only Symphony surface that calls an external API rather than spawning a CLI authenticated against the operator's plan. F.1 fixes that. After F.1, every LLM-touching surface in Symphony — runtime tier agents, drift LLM judge, Foundry — uses the same persistent-CLI-subprocess pattern. The pitch becomes honest and the cost story becomes coherent.

## Decisions log (from brainstorming)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Provider strategy | **Two-step migration.** F.1 ships Claude-only. F.2 adds Codex/Gemini once usage data justifies the per-provider abstraction. |
| Q2 | API removal stance | **Clean break.** Remove `callOpenAiFoundry`, `openaiFetch` injection, `resolveOpenAiFoundryConfig`. No fallback to API. |
| Q3 | Conversation state | **Persistent subprocess.** One `claude` child process per Foundry session, held alive for the session's lifetime. User messages pipe via stdin, responses parse via stdout. NOT spawn-per-turn. NOT `--resume` as primary mode (only for sidecar-restart recovery). |
| Q4 | Tool access | **Tools disabled.** `--disallowedTools "*"`. Foundry is planning, not execution; same behavior as today's tool-less API path. |
| Q5 | Pre-built planning plugins (`/deep-plan`, spec-kit, etc.) | **Don't adopt.** Symphony's 7-doc Foundry format is more opinionated than these tools and is deeply wired into downstream lifecycle. Borrow patterns later as Symphony-native tools (F.3+); don't fork the Foundry contract for F.1. |

## 1. Architecture

```
                 ┌──────────────────────────────────────┐
 Foundry UI ──→  │  foundry_chat_turn (LocalToolFacade) │
                 └────────────────┬─────────────────────┘
                                  │
                                  ▼
                 ┌──────────────────────────────────────┐
                 │  FoundryRuntime  (NEW)               │
                 │  • Holds child process per session   │
                 │  • Spawns on first turn              │
                 │  • Sends user message via stdin      │
                 │  • Awaits assistant_message via      │
                 │    stream-json adapter               │
                 │  • Reaps process on session close    │
                 └────────────────┬─────────────────────┘
                                  │
                                  ▼
                 ┌──────────────────────────────────────┐
                 │  child_process: claude               │
                 │  --verbose                           │
                 │  --input-format stream-json          │
                 │  --output-format stream-json         │
                 │  --append-system-prompt-file <path>  │
                 │  --disallowedTools "*"               │
                 │  --session-id <uuid>                 │
                 └──────────────────────────────────────┘
```

The new `FoundryRuntime` mirrors `RuntimeSupervisor.js`'s design:
- Spawns `claude` once per Foundry session (lazy: on first chat turn, not on session creation)
- Holds the child process handle in an in-memory `Map<foundrySessionId, ChildProcess>`
- Routes each chat turn's user message to the existing process via stdin
- Reads stream-json events via stdout, parses via `ClaudeStreamJsonAdapter`
- Awaits the `assistant_message` event for that turn, returns text + metadata
- Reaps the child process when the Foundry session closes, when the operator finalizes docs, OR when the sidecar shuts down

## 2. Module layout

```
src/foundry/
├── sqliteFoundryStore.js          ← MODIFY: schema migration + cli_session_id field
├── foundryRuntime.js              ← NEW: per-session subprocess manager
├── foundryProcessRegistry.js      ← NEW: in-memory Map<foundrySessionId, ChildProcess>
└── foundryInstructions.txt        ← NEW: extracted from FOUNDRY_CHAT_INSTRUCTIONS const

src/tools/localToolFacade.js       ← MODIFY:
                                     - #foundryChatTurn: delegates to foundryRuntime.send()
                                     - removes callOpenAiFoundry helper
                                     - removes FOUNDRY_CHAT_INSTRUCTIONS const (now in file)
                                     - removes openaiFetch / resolveOpenAiFoundryConfig
                                     - removes openaiFetch from constructor params

src/storage/schema.sql             ← MODIFY: ALTER TABLE foundry_sessions ADD COLUMN
                                              cli_session_id TEXT (and applyMigrations
                                              entry per the slice-3 schema migration pattern)

scripts/dev-api-server.mjs         ← MODIFY: construct FoundryRuntime, inject into facade
                                              (analog to driftEngine wire-up at line 74-75)

test/foundry/
├── foundryRuntime.test.js         ← NEW: full unit coverage with injected fake spawn
└── (sqliteFoundryStore.test.js extended for the new column)

test/localToolFacade.test.js       ← MODIFY: replace callOpenAiFoundry mocks with
                                              foundryRuntime injection
```

## 3. The new `FoundryRuntime` module

### Responsibility

One concept: routes Foundry chat turns through a persistent Claude CLI subprocess. Handles spawn, stdin/stdout piping, stream-json adapter integration, lifecycle (kill on close, restart-with-resume on crash), and process registry.

### Public API

```js
export class FoundryRuntime {
  constructor({
    spawnImpl = childProcessSpawn,
    instructionsPath,        // absolute path to foundryInstructions.txt
    streamAdapter = ClaudeStreamJsonAdapter,
    timeoutMs = 5 * 60 * 1000,  // 5 min per turn
    onCrash,                 // optional callback: ({ sessionId, error }) => void
  } = {}) {}

  /**
   * Send a user message to the session's persistent Claude subprocess.
   * Spawns the process on first call for a session, reuses on subsequent.
   * Returns { text, eventCount, model, sessionUuid }.
   *
   * @param {object} args
   * @param {string} args.foundrySessionId   Symphony's foundry_session id
   * @param {string} args.text               new user message text
   * @param {string} [args.cliSessionId]     Claude session UUID for resume; if
   *                                         provided AND no live process,
   *                                         spawns with --resume to recover state
   * @returns {Promise<{ text, eventCount, model, sessionUuid }>}
   */
  async send({ foundrySessionId, text, cliSessionId }) {}

  /**
   * Reap the child process for a Foundry session. Called on:
   *   - Foundry session close (artifact_export or operator close)
   *   - Sidecar shutdown (registry-wide reap)
   * Idempotent: ok to call when no process exists.
   */
  async close({ foundrySessionId }) {}

  /**
   * Reap all live processes. Called by sidecar shutdown handler.
   */
  async closeAll() {}

  /**
   * Returns true if a live process exists for this session.
   * (Used by tests + diagnostics.)
   */
  isLive({ foundrySessionId }) {}
}
```

### Spawn args (locked)

```js
const args = [
  '--verbose',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--append-system-prompt-file', this.instructionsPath,
  '--disallowedTools', '*',
  '--session-id', cliSessionId,        // generated UUID if first call, else resumed
];
if (resuming) args.push('--resume', cliSessionId);
```

### Crash recovery (sidecar restart or process death)

If `send()` is called for a session whose process is missing AND a `cliSessionId` was previously stored on the foundry_session row:
- Spawn fresh with `--resume <cliSessionId>`. Claude's on-disk session store restores conversation state.
- If `--resume` fails (Claude session storage was wiped), fall back: clear `cli_session_id` and start a new session by re-seeding the conversation from `foundry_messages` (replay each prior message via stdin in order before processing the new turn).
- Re-seeding is the disaster-recovery path; under normal conditions `--resume` succeeds and is invisible to the operator.

### stream-json event handling

The existing `ClaudeStreamJsonAdapter` parses these event types:
- `system` (init events with model + session info)
- `assistant_message` (the text we want)
- `tool_use` / `tool_result` (shouldn't appear with `--disallowedTools "*"`, but defensive)
- `error` (raise as Error from `send()`)

For Foundry, only `assistant_message` is forwarded. Other events get logged at debug level. The adapter is reused as-is; no changes needed.

## 4. Schema migration

`drift_findings` had `correction_task_id` added in slice 3 via a dual approach (column in `CREATE TABLE` + `applyMigrations` for existing DBs). Same pattern here:

In `src/storage/schema.sql`, find the `CREATE TABLE IF NOT EXISTS foundry_sessions` block. Add a new column at the end of the column list, before the closing paren:

```sql
CREATE TABLE IF NOT EXISTS foundry_sessions (
  session_id      TEXT PRIMARY KEY,
  ...
  cli_session_id  TEXT,
  ...
);
```

In `src/storage/sqlite.js`'s `applyMigrations`, add (in try/catch to swallow "duplicate column"):

```js
try {
  db.exec("ALTER TABLE foundry_sessions ADD COLUMN cli_session_id TEXT");
} catch { /* already migrated */ }
```

(No partial index needed — we never query `WHERE cli_session_id IS NOT NULL`.)

`SqliteFoundryStore` gains a method:

```js
setCliSessionId({ sessionId, cliSessionId }) {
  this.db.prepare(
    'UPDATE foundry_sessions SET cli_session_id = ? WHERE session_id = ?'
  ).run(cliSessionId, sessionId);
}
```

And `getSession()`'s row mapping exposes `cliSessionId: row.cli_session_id ?? null`.

## 5. Modifications to `LocalToolFacade`

### `#foundryChatTurn` rewrites to:

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
    cliSessionId: snapshot.cliSessionId ?? null,
  });

  // First turn: persist the new CLI session UUID so subsequent turns + crash
  // recovery can find it.
  if (!snapshot.cliSessionId && response.sessionUuid) {
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

### Things to delete

- `callOpenAiFoundry` async function (~40 LOC)
- `FOUNDRY_CHAT_INSTRUCTIONS` const (~80 LOC; content moves to `foundryInstructions.txt`)
- `formatFoundryTranscript` function (used only by `callOpenAiFoundry`)
- `extractOpenAiText` helper
- `#resolveOpenAiFoundryConfig` private method
- `openaiFetch` constructor param + `this.openaiFetch` field assignment
- Any related typedefs / dead imports

### Things to add to constructor

```js
constructor({ ..., foundryRuntime = null, ... } = {}) {
  // ...
  this.foundryRuntime = foundryRuntime
    && typeof foundryRuntime.send === 'function'
      ? foundryRuntime
      : null;
}
```

## 6. dev-api-server wiring

`scripts/dev-api-server.mjs` currently constructs the runtime, drift engine, plugin stores, etc. Add:

```js
import { FoundryRuntime } from '../src/foundry/foundryRuntime.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Sidecar shutdown: reap all Foundry CLI processes
process.on('SIGINT', () => { void foundryRuntime.closeAll(); });
process.on('SIGTERM', () => { void foundryRuntime.closeAll(); });
process.on('exit', () => { void foundryRuntime.closeAll(); });
```

The shutdown hooks ensure no orphan Claude processes survive the sidecar.

## 7. Failure modes + recovery matrix

| Scenario | Symphony's response |
|---|---|
| Claude CLI not installed at spawn time | `send()` throws `Error('Claude CLI not installed. Install from claude.com/code, run "claude /login", retry. (Codex/Gemini support coming in slice F.2.)')`. Surfaced to operator in chat. |
| Claude CLI installed but not authenticated (no plan auth) | spawn succeeds, but Claude exits early with auth-required error on stdout/stderr. `send()` surfaces: `Error('Claude CLI not authenticated. Run "claude /login" then retry.')` |
| Subprocess crashes mid-conversation | Detect via `'close'` event, mark process dead in registry. Next chat turn re-spawns with `--resume <cliSessionId>` (if known) or fresh session (if recovery fails). |
| Stream-json parse error | `ClaudeStreamJsonAdapter` throws `RuntimeAdapterError`. `send()` surfaces as turn failure but does NOT kill the process unless errors repeat (>2 in a row → kill + restart). |
| Subprocess hang (no `assistant_message` after timeout) | After `timeoutMs` (5 min), kill subprocess, return turn error. Operator can retry; next attempt re-spawns with `--resume`. |
| `--resume <uuid>` fails (Claude session store wiped) | Fall back to re-seeding from `foundry_messages` — replay each prior message via stdin before the new turn. Costs one full transcript replay; only happens once after recovery. |
| Sidecar shutdown | `SIGINT/SIGTERM/exit` handlers call `closeAll()`, killing every live Foundry subprocess. Subsequent operator reopen re-spawns via `--resume`. |

## 8. Testing strategy

### `test/foundry/foundryRuntime.test.js` (new)

- `send` spawns subprocess on first call with correct args (verify spawn invocation: command, flags, env)
- Subsequent `send()` for the same `foundrySessionId` reuses the existing process (no second spawn)
- User message is written to subprocess stdin in stream-json format
- `assistant_message` event from stream-json adapter resolves the `send()` promise with `{text, eventCount, model, sessionUuid}`
- Concurrent `send()` for different session IDs spawn separate processes
- `close()` kills the process and removes registry entry
- `closeAll()` kills every live process
- Session-id passthrough: when `cliSessionId` provided AND no live process, spawn includes `--resume`
- Subprocess crash mid-call: `send()` rejects with crash error; subsequent `send()` for same session re-spawns with `--resume`
- Timeout: subprocess that doesn't respond within `timeoutMs` is killed; `send()` rejects with timeout error
- Tool-disable assertion: spawn args include `--disallowedTools "*"`

### `test/sqliteFoundryStore.test.js` (extend)

- `setCliSessionId` round-trips correctly
- `getSession` exposes `cliSessionId` (camelCase) from the snake_case column
- Schema migration (fresh DB): new sessions can be inserted with `cli_session_id`

### `test/localToolFacade.test.js` (extend)

- `foundry_chat_turn` delegates to `foundryRuntime.send()` (replace OpenAI mock with FoundryRuntime mock)
- `foundry_chat_turn` persists the returned `sessionUuid` to `cli_session_id` on first turn
- `foundry_chat_turn` passes the existing `cliSessionId` to `send()` on subsequent turns
- `foundry_chat_turn` throws when `foundryRuntime` not configured

### Removed tests

Any existing test that exercised the OpenAI API path (`callOpenAiFoundry`, `formatFoundryTranscript`, `extractOpenAiText`) gets deleted along with that code.

### Backend npm test chain

`package.json` `test` script appends:
- `&& node --no-warnings --test test/foundry/foundryRuntime.test.js`

(The existing `sqliteFoundryStore.test.js` is already in the chain; extending it doesn't change the chain.)

## 9. Risks / non-goals

### Non-goals (F.1)

- Codex/Gemini support — F.2
- Cross-LLM critique loop — F.3+
- AskUserQuestion structured interviews — F.3+
- Phase artifact pipeline formalization — F.3+
- Tool access for Foundry (file read, web search, etc) — F.4+ if data justifies
- Migration of existing OpenAI-backed Foundry session data — out of scope. Existing sessions stay in SQLite as historical record; if reopened they re-seed (the `cli_session_id IS NULL` path triggers fresh spawn + replay from messages).

### Risks

- *Stream-json adapter edge cases:* `ClaudeStreamJsonAdapter` was built for runtime-tier agents that use tools heavily. Foundry's tool-less path may exercise event sequences the adapter hasn't seen. Mitigation: tests use synthetic stream-json fixtures matching Foundry's expected event flow; debug-log unhandled events for visibility during early runs.
- *Process leak on abnormal termination:* if sidecar dies via SIGKILL (no shutdown hook fires), child Claude processes survive as orphans. Mitigation: register `process.on('exit', ...)` AND a process-group strategy if Node version supports it. On Windows where signal handling is weaker, the OS reaps orphans when the parent process tree closes; long-term a watchdog could detect.
- *Per-turn latency:* persistent subprocess avoids per-turn cold-start, but the FIRST turn has cold-start latency (~1-3 seconds for Claude CLI to boot + load instructions). UI should show a spinner during the first call. Subsequent turns return as fast as the model responds.
- *`foundryInstructions.txt` drift:* the prompt content lives in a file now, not a const. Risk: someone edits the file and forgets to update tests. Mitigation: snapshot test that hashes the file and warns on change (lightweight, optional for F.1).

## 10. Estimated scope

- ~14 tasks for the implementation plan
- Backend: ~600-800 LOC added (FoundryRuntime is the bulk; foundryProcessRegistry small; instructions extracted to file)
- Backend: ~200 LOC removed (callOpenAiFoundry helper, FOUNDRY_CHAT_INSTRUCTIONS const, formatFoundryTranscript, extractOpenAiText, resolveOpenAiFoundryConfig, openaiFetch wiring)
- ~15-20 new test cases
- 2-3 days of subagent-driven execution

## 11. Self-review

- **Placeholders:** None. All sections concrete; method signatures shown; spawn args fully specified; failure modes enumerated.
- **Internal consistency:** Decisions log Q1-Q5 ↔ architecture diagram ↔ module layout ↔ failure matrix all line up. The "persistent subprocess as primary, `--resume` only for recovery" semantic is consistent across §1, §3, §7. The "tools disabled" decision (Q4) is consistent across §3's spawn args, §8's test cases, and §9's non-goals.
- **Scope:** Focused on a single coherent feature (Foundry's API-to-CLI migration). F.2/F.3+ are enumerated as explicit non-goals with cross-references to FUTURE-IDEAS.md.
- **Ambiguity:** "Persistent subprocess" is explicitly defined (one process per session, alive for session lifetime; `--resume` is recovery only, not primary mode). "Tool access" is explicitly `--disallowedTools "*"` (no read tools, no write tools, no bash). "Provider strategy" is explicitly Claude-only (F.2 deferred). "Failure recovery" matrix covers every named failure.
