# Foundry Slice F.2 — Provider-Aware Foundry (Claude + Codex) — Design

**Date:** 2026-05-10
**Slice:** F.2 of post-F.1 Foundry roadmap
**Builds on:** F.1 (`docs/specs/2026-05-09-foundry-slice-f1-cli-migration-design.md`) which migrated Foundry from API to persistent Claude CLI subprocess.

---

## Goal

Let Foundry plan a project using **either Claude or Codex CLI** as the planning agent, picked per-session with a global default. Both providers preserve conversation context across turns without us replaying tokens. Output from both is monitorable as a normalized event stream so a future ASPE-style interpreter agent can summarize agent activity in plain English regardless of provider.

## Non-goals

- Gemini support (deferred — F.2.5 once Codex usage data clarifies demand; the Gemini CLI's persistent JSON output mode is encouraging for that next slice).
- Mid-session provider switching (sessions are provider-locked at creation).
- Per-team-member Foundry providers (Foundry runs once before a team exists; no per-member concept here).
- Replacing the F.1 Claude implementation — its persistent-subprocess pattern stays untouched.
- Wiring an actual ASPE interpreter agent — F.2 only normalizes the event stream so a future slice can subscribe.

---

## Architecture

A new adapter-based abstraction inside `src/foundry/`:

```
                    ┌──────────────────────────────────────┐
                    │       LocalToolFacade                │
                    │ (foundry_chat_turn handler)          │
                    └─────────────────┬────────────────────┘
                                      │
                                      ▼
                    ┌──────────────────────────────────────┐
                    │       FoundryRuntime                 │
                    │ (dispatcher; reads provider          │
                    │  from session, picks adapter)        │
                    └────────┬─────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
      ┌─────────────────────┐    ┌─────────────────────┐
      │ ClaudeFoundryAdapter│    │ CodexFoundryAdapter │
      │ (persistent child;  │    │ (spawn-per-turn     │
      │  stream-json IO)    │    │  with exec resume)  │
      └─────────────────────┘    └─────────────────────┘
                │                         │
                ▼                         ▼
         claude (CLI)              codex (CLI)
```

Both adapters extend a small `FoundryProviderAdapter` base class with a uniform `send()` contract. From the UI's perspective and the LocalToolFacade's perspective, nothing changes — same `foundry_chat_turn` tool, same return shape, same SSE behavior.

## Components

### 1. `FoundryProviderAdapter` base class — `src/foundry/providers/FoundryProviderAdapter.js` (NEW)

Mirrors `src/runtime/RuntimeAdapter.js` shape — small abstract base with throw-on-unimplemented stubs.

```js
export class FoundryProviderAdapter {
  constructor(providerId) {
    if (new.target === FoundryProviderAdapter) {
      throw new TypeError('FoundryProviderAdapter is an abstract base class');
    }
    this.providerId = providerId;
  }

  /**
   * Send a user message to the conversation, await the assistant response.
   *
   * @param {object} args
   * @param {string} args.foundrySessionId — Symphony's session id (NOT the CLI session id)
   * @param {string} args.text — user message text for this turn
   * @param {string|null} args.cliSessionId — null on first turn, the CLI's session id on subsequent turns
   * @returns {Promise<{
   *   text: string,            // assistant reply text
   *   sessionUuid: string,     // CLI session id (claude session id OR codex thread id)
   *   model: string|null,      // model name if available
   *   eventCount: number,      // for diagnostics
   *   normalizedEvents?: Array<NormalizedFoundryEvent>  // optional, for ASPE
   * }>}
   */
  async send(_args) {
    throw new Error(`${this.providerId}: send() not implemented`);
  }

  isAttached(_args) { return false; }
  async close(_args) { /* no-op default */ }
  async closeAll() { /* no-op default */ }
}
```

`isAttached({ foundrySessionId })` returns true when the adapter is holding state for this session that would be lost on `close()` — for Claude that's "process is alive in registry," for Codex that's a no-op (no in-memory state held between turns; resume info lives in SQLite).

### 2. `ClaudeFoundryAdapter` — `src/foundry/providers/ClaudeFoundryAdapter.js` (NEW, mostly extracted from current FoundryRuntime)

A direct port of the current F.1 logic from `src/foundry/foundryRuntime.js` into the new adapter shape. **No behavior change.** Persistent subprocess, stream-json IO, `--input-format stream-json --output-format stream-json --append-system-prompt-file --disallowedTools "*" --session-id <uuid>` argv. The current `FoundryRuntime` class effectively *becomes* `ClaudeFoundryAdapter` with the public API renamed to match the base class.

`isAttached()` returns true iff a child is in the registry. `close()` kills the child + drops the registry entry.

### 3. `CodexFoundryAdapter` — `src/foundry/providers/CodexFoundryAdapter.js` (NEW)

Each `send()` call spawns a fresh `codex` subprocess for ONE turn, then exits. Codex's session state (the conversation history) lives on disk in `~/.codex/sessions/<id>/` — the LLM sees the full prior context on resume without us replaying anything.

**First turn argv** (no `cliSessionId`):
```
codex exec --json --skip-git-repo-check -C <foundryCwd> "<systemPrompt>\n\n<userMessage>"
```

The system prompt (contents of `foundryInstructions.txt`) is **prepended to the first turn's user message** because `codex exec` has no `--append-system-prompt-file` equivalent. The model treats leading instructions as governing — same pattern the existing drift `llmJudge.js` uses for one-shot Codex calls.

**Subsequent turn argv** (with `cliSessionId`):
```
codex exec resume <cliSessionId> --json --skip-git-repo-check -C <foundryCwd> "<userMessage>"
```

Only the new user message — no system prompt re-sent, no transcript replay. Codex loads the prior conversation from its own session file.

**Notes on flags:**
- Default Codex behavior persists rollouts to disk. We do NOT pass `--ephemeral` — that flag would discard session state and break resume.
- `--skip-git-repo-check` matches what the upstream's Phase 0 signoff used and avoids errors when Foundry runs against non-git folders.
- `-C <foundryCwd>` sets Codex's working directory. Use the active project path; if no project is active, fall back to a sensible default (the same path Claude uses today, presumably the user's home or a tmp dir).

**Working directory resolution:** Today's `LocalToolFacade.#foundryChatTurn` doesn't pass a cwd to `FoundryRuntime`. The Codex adapter needs one (Codex requires being told where to run). Resolve via `LocalToolFacade.projectCwd` (already in scope for `#foundryArtifactExport`) or fall back to `process.cwd()`.

**Reading the JSON event stream**: `codex exec --json` emits newline-delimited JSON events to stdout. Stderr emits warnings interleaved (drained but ignored, same as F.1's Claude adapter). Event shape — observed live on `codex-cli 0.117.0` in the upstream's signoff (2026-04-19):

| Event type (`event.type`) | Meaning | We extract |
|---|---|---|
| `thread.started` | New thread or resumed thread starting | `event.thread_id` → store as `cliSessionId` |
| `turn.started` | This turn is now executing | nothing — for ASPE only |
| `item.completed` (with `item.type === "agent_message"`) | Assistant produced a message item | `event.item.text` → append to assistant reply |
| `item.completed` (other `item.type`) | Tool call, reasoning, exec command, etc. | optional ASPE event |
| `turn.completed` | This turn is done | resolve the promise; `event.usage.{input_tokens,cached_input_tokens,output_tokens}` available |

**Resolution rule:** the promise resolves when `turn.completed` fires. The accumulated text from all `item.completed` events with `item.type === "agent_message"` is the assistant reply. If `turn.completed` fires with no agent messages, that's an error.

**Implementation hint for the implementer:** keep an inline newline-delimited JSON parser (~20 LOC) similar to F.1's. Each line: trim, JSON.parse (skip non-JSON warning lines silently), dispatch on `event.type`. Don't import `ClaudeStreamJsonAdapter` — it's runtime-tier-shaped and inappropriate here.

`isAttached()` always returns false (no held state between turns). `close()` is a no-op. `closeAll()` is a no-op. Crash recovery is automatic — the next `send()` call with the stored `cliSessionId` resumes the conversation transparently.

### 4. `FoundryRuntime` becomes a dispatcher — `src/foundry/foundryRuntime.js` (REWRITE)

The existing class loses its Claude-specific internals (those move to `ClaudeFoundryAdapter`) and becomes a thin coordinator:

```js
export class FoundryRuntime {
  constructor({
    instructionsPath,           // path to foundryInstructions.txt — passed to Claude adapter
    projectCwdResolver,         // () => string — passed to Codex adapter
    spawnImpl,                  // optional, for tests
    timeoutMs,                  // optional, default 5min
  }) {
    this.adapters = {
      anthropic: new ClaudeFoundryAdapter({ instructionsPath, spawnImpl, timeoutMs }),
      openai:    new CodexFoundryAdapter({ instructionsPath, projectCwdResolver, spawnImpl, timeoutMs }),
    };
  }

  async send({ foundrySessionId, text, cliSessionId, provider }) {
    const adapter = this.#requireAdapter(provider);
    return adapter.send({ foundrySessionId, text, cliSessionId });
  }

  isAttached({ foundrySessionId, provider }) {
    return this.#requireAdapter(provider).isAttached({ foundrySessionId });
  }

  async close({ foundrySessionId, provider }) {
    if (provider) return this.#requireAdapter(provider).close({ foundrySessionId });
    // Unknown provider → close on all adapters (defensive cleanup)
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

The provider parameter is mandatory on every call. The caller (`LocalToolFacade.#foundryChatTurn`) reads the provider from the SQLite session row.

### 5. SQLite schema migration

Add a `provider` column to `foundry_sessions`:

```sql
-- in src/storage/schema.sql, CREATE TABLE foundry_sessions
provider TEXT NOT NULL DEFAULT 'anthropic'
```

Plus a `applyMigrations` entry in `src/storage/sqlite.js`:

```js
try { db.exec("ALTER TABLE foundry_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'"); } catch {}
```

`SQLite Foundry store changes:**
- `createSession()` accepts an optional `provider` arg, defaults to `'anthropic'`. Persists it.
- `rowToSession()` exposes `provider: row.provider ?? 'anthropic'`.

### 6. Settings

New backend setting: `foundry.defaultProvider` (`'anthropic' | 'openai'`, default `'anthropic'`). Persisted in the existing settings store. Read at session creation time only — once set on a session, the session's provider is locked.

The setting lives in the same shape as existing settings (e.g. drift settings under `settings.drift.*`). Add a `foundry` namespace.

### 7. UI surfaces

**Two surfaces:**

**a) Settings → Foundry section** (NEW — first time Foundry has its own settings section).
Component: `ui/src/components/settings/FoundrySettings.tsx` (NEW). Renders a single radio:
- "Claude (default)"
- "Codex"

Wired into `SettingsScreen` next to the existing `ProvidersSettings`. Reads/writes `foundry.defaultProvider` via the existing settings API.

**b) FoundryScreen — per-session override at create time.**
The existing "+ New" button in `FoundryScreen.tsx` becomes a split button or grows a small dropdown next to it: "+ New ▾". The dropdown lets the user choose Claude or Codex for this new session. Defaults to the global setting. The chosen provider is passed to `foundry_session_create` as a new arg.

**c) Provider chip on session rows** (read-only). In the session list sidebar, each session shows a tiny "C" or "X" chip (Claude / Codex) so the user can see at a glance which provider that plan was created with. Sessions are provider-locked — no way to change after creation.

### 8. `foundry_session_create` tool — accept `provider` arg

`src/tools/localToolFacade.js` `#foundrySessionCreate` accepts an optional `provider` arg (`'anthropic' | 'openai'`, defaults to settings value or `'anthropic'`). Passes through to the store.

### 9. `foundry_chat_turn` tool — read provider from session

`#foundryChatTurn` already loads the session via `store.getSession(sessionId)`. It now reads `session.provider` and passes that to `runtime.send({ ..., provider })`. The dispatcher routes to the correct adapter.

### 10. Normalized event interface (ASPE preparation)

Both adapters can optionally emit a normalized event stream during a `send()` call. The shape is provider-agnostic:

```ts
type NormalizedFoundryEvent =
  | { kind: 'thread_started';    threadId: string;                  timestamp: string }
  | { kind: 'turn_started';      timestamp: string }
  | { kind: 'message_delta';     text: string;                      timestamp: string }
  | { kind: 'tool_call';         tool: string;     payload: unknown; timestamp: string }
  | { kind: 'turn_completed';    usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }; timestamp: string }
  | { kind: 'warning';           source: 'stderr' | 'protocol';     text: string; timestamp: string };
```

Each adapter's `send()` returns a `normalizedEvents` array on its result. F.2 captures these for completeness; consumption (i.e. the actual ASPE interpreter agent) is a future slice.

**Provider→normalized event mapping:**

| Normalized kind | Claude (stream-json) | Codex (`exec --json`) |
|---|---|---|
| `thread_started` | `system.subtype === 'init'` event (extract `session_id`) | `event.type === 'thread.started'` (extract `thread_id`) |
| `turn_started` | `assistant` event with empty content (or first delta) | `event.type === 'turn.started'` |
| `message_delta` | `assistant` event with `content[].type === 'text'` | `item.completed` with `item.type === 'agent_message'` |
| `tool_call` | `assistant` event with `content[].type === 'tool_use'` | `item.completed` with `item.type === 'function_call'`/`local_shell_call` |
| `turn_completed` | `result` event | `turn.completed` event |
| `warning` | stderr lines (drained but capturable) | stderr lines + `unsupported_raw_event`-style fallthrough |

The implementer can leave `tool_call` and tool-use mappings as `kind: 'unknown'` placeholders if exact upstream mappings are still in flux — Foundry today doesn't actually expose tools (`--disallowedTools '*'` for Claude), so tool events are unlikely to appear in practice. The interface needs to exist so a future slice doesn't have to renegotiate it.

### 11. Crash recovery

**Claude (existing F.1 behavior):** if the registry has no live process but `cliSessionId` is stored, spawn fresh with `--resume <cliSessionId>`.

**Codex:** every turn after the first uses `codex exec resume <cliSessionId>`. If the sidecar crashed or restarted between turns, the next `send()` simply uses the stored ID and Codex loads the conversation from disk. No special crash-recovery code path needed in the adapter — recovery IS the normal turn path.

**One-shot rollout file durability:** Codex writes to `~/.codex/sessions/<id>/` synchronously per turn (default behavior). If the `codex exec` process is killed mid-turn, the partial conversation may be malformed — but this is rare (we kill on timeout, which is 5 minutes). Treat killed-mid-turn as an error, surface to operator, let them retry.

---

## Data flow — example Codex session

```
Operator: clicks "+ New" → "Codex" in FoundryScreen
  └─> foundry_session_create({ title: "FamPlan v2", provider: 'openai' })
        └─> store inserts row with provider = 'openai', cli_session_id = null
              └─> session id "fnd-123" returned to UI

Operator types "a meal planner for picky kids" + Send
  └─> foundry_chat_turn({ sessionId: "fnd-123", text: "a meal planner..." })
        └─> LocalToolFacade reads session.provider === 'openai', session.cli_session_id === null
              └─> runtime.send({ foundrySessionId: "fnd-123", text: "...", cliSessionId: null, provider: 'openai' })
                    └─> CodexFoundryAdapter.send()
                          ├─ spawns: codex exec --json --skip-git-repo-check -C <cwd>
                          │    "<foundryInstructions.txt contents>\n\na meal planner for picky kids"
                          ├─ reads stdout JSON events:
                          │    {"type":"thread.started","thread_id":"abc-123"}    → save thread_id
                          │    {"type":"turn.started"}
                          │    {"type":"item.completed","item":{"type":"agent_message","text":"Got it. Let me ask a few clarifying questions..."}}
                          │    {"type":"turn.completed","usage":{"input_tokens":2048,"output_tokens":312}}
                          ├─ resolves: { text: "Got it...", sessionUuid: "abc-123", model: null, eventCount: 4 }
                    └─> LocalToolFacade.setCliSessionId("fnd-123", "abc-123")
                          └─> assistant message persisted
                                └─> UI re-renders with the response

Operator types "kids are 6 and 9" + Send (Turn 2)
  └─> foundry_chat_turn({ sessionId: "fnd-123", text: "kids are 6 and 9" })
        └─> LocalToolFacade reads session.provider === 'openai', session.cli_session_id === "abc-123"
              └─> runtime.send({ foundrySessionId: "fnd-123", text: "...", cliSessionId: "abc-123", provider: 'openai' })
                    └─> CodexFoundryAdapter.send()
                          └─ spawns: codex exec resume abc-123 --json --skip-git-repo-check -C <cwd>
                              "kids are 6 and 9"
                          (no system prompt — Codex has the full prior conversation on disk)
```

---

## Error handling

- **Codex CLI not installed**: `send()` first turn throws `Error('Codex CLI not installed. Install from openai.com/codex, run "codex login", retry.')`. Surface in chat.
- **Login expired / no auth**: Codex emits an error to stderr or exits non-zero. Surface to operator with "Run `codex login` and retry."
- **Spawn failure**: standard child-process error → throw with provider context.
- **Timeout (5 minutes per turn)**: kill the child with SIGKILL, throw `Error('Codex turn timed out')`.
- **Resume with invalid session id**: Codex returns an error. Surface to operator. Don't auto-create new session — that would silently break the conversation thread.
- **Mid-stream non-JSON line on stdout**: skip silently (drained warning lines).
- **`turn.completed` with no preceding `agent_message`**: throw `Error('Codex turn completed without assistant message')`. This is the same defensive check F.1's Claude adapter has.

---

## Testing

The `toad-local/test/` directory has full TDD coverage for backend code. F.2 follows the same convention.

**New tests:**

- `test/foundry/providers/foundryProviderAdapter.test.js`
  - Throws when constructed directly.
  - Default `isAttached` returns false.
  - Default `close`/`closeAll` are no-ops.

- `test/foundry/providers/claudeFoundryAdapter.test.js`
  - Port of existing `test/foundry/foundryRuntime.test.js` against the new class. Same 11 scenarios (spawn args, registry reuse, separate processes, close/closeAll, crash auto-cleanup, --resume passthrough). Mark each test with `// MIGRATED FROM foundryRuntime.test.js`.

- `test/foundry/providers/codexFoundryAdapter.test.js` (NEW)
  - First-turn argv: `codex exec --json --skip-git-repo-check -C <cwd> "<systemPrompt>\n\n<text>"`. No `--ephemeral` flag.
  - Resume-turn argv: `codex exec resume <cliSessionId> --json --skip-git-repo-check -C <cwd> "<text>"`. No system prompt re-sent.
  - JSON event parser: emits `thread.started`/`turn.started`/`item.completed`(agent_message)/`turn.completed` via fake stdout, returns `{text, sessionUuid, ...}`.
  - Multiple `item.completed` agent_message events: text concatenates.
  - `turn.completed` without `agent_message` → throws.
  - Non-JSON stderr lines: skipped silently, don't break parsing.
  - Timeout triggers SIGKILL + throws.
  - Spawn failure throws with provider context.
  - `isAttached` always returns false. `close` and `closeAll` are no-ops.

- `test/foundry/foundryRuntime.test.js` (REWRITE — significantly slimmed)
  - With injected fake adapters, `send()` dispatches to the right adapter by provider.
  - `close()`/`closeAll()` propagates to all adapters.
  - Throws on unknown provider.

- `test/sqliteFoundryStore.test.js` (EXTEND)
  - `createSession({ provider: 'openai' })` persists provider; round-trips.
  - `createSession()` without provider defaults to `'anthropic'`.
  - `rowToSession` exposes `provider`.

- `test/localToolFacade.test.js` (EXTEND)
  - `foundry_session_create` with `provider` arg passes it to the store.
  - `foundry_session_create` without `provider` reads `foundry.defaultProvider` from settings, falls back to `'anthropic'` if unset.
  - `foundry_chat_turn` reads `session.provider` and passes it to `runtime.send`.

**Smoke / manual test:**
- Real Codex run end-to-end with `codex login`'d credentials. Wipe a Foundry session, create a new one with provider='openai', send "Reply only with OK", verify response, send a second turn, verify Codex resumes the conversation.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/foundry/providers/FoundryProviderAdapter.js` | Create | Abstract base class for Foundry CLI adapters |
| `src/foundry/providers/ClaudeFoundryAdapter.js` | Create | Persistent Claude subprocess (extracted from current `foundryRuntime.js`) |
| `src/foundry/providers/CodexFoundryAdapter.js` | Create | Codex spawn-per-turn-with-resume adapter |
| `src/foundry/foundryRuntime.js` | Rewrite | Thin dispatcher that picks adapter by provider |
| `src/storage/schema.sql` | Modify | Add `provider TEXT NOT NULL DEFAULT 'anthropic'` to `foundry_sessions` |
| `src/storage/sqlite.js` | Modify | Add `ALTER TABLE foundry_sessions ADD COLUMN provider` migration |
| `src/foundry/sqliteFoundryStore.js` | Modify | `createSession` accepts `provider`; `rowToSession` exposes `provider` |
| `src/tools/localToolFacade.js` | Modify | `#foundrySessionCreate` accepts `provider`; `#foundryChatTurn` passes `session.provider` to runtime |
| `src/mcp/localToolDefinitions.js` | Modify | Add `provider` arg to `foundry_session_create` schema |
| `scripts/dev-api-server.mjs` | Modify | Pass `projectCwdResolver` to `FoundryRuntime` constructor |
| `ui/src/components/settings/FoundrySettings.tsx` | Create | Radio for `foundry.defaultProvider` |
| `ui/src/components/settings/SettingsScreen.tsx` | Modify | Mount FoundrySettings section |
| `ui/src/components/FoundryScreen.tsx` | Modify | "+ New" split-button picks provider; session-row provider chip |
| `test/foundry/providers/*.test.js` | Create | New adapter tests |
| `test/foundry/foundryRuntime.test.js` | Rewrite | Dispatcher tests with fake adapters |
| `test/sqliteFoundryStore.test.js` | Modify | `provider` column round-trip |
| `test/localToolFacade.test.js` | Modify | Provider arg passthrough + session.provider read |
| `docs/FUTURE-IDEAS.md` | Modify | Update F.2 entry to "shipped" status; refine F.2.5 (Gemini) entry |

---

## What this slice does NOT change

- `foundry_artifact_generate` and `foundry_project_materialize` remain pure data transformations from chat transcripts — no LLM calls, no provider concept needed.
- F.1's Claude path stays bit-identical at the network level. Same flags, same stream-json IO, same `cliSessionId` reuse.
- The `foundry_chat_turn` MCP tool surface is unchanged from the caller's perspective. New behavior is internal dispatch only.
- UI Foundry chat surface is unchanged for existing Anthropic-default users — they never see the picker unless they go look for it in Settings.

## What this slice unblocks

- **F.2.5 (Gemini)**: drop in a `GeminiFoundryAdapter`, register it in `FoundryRuntime.adapters`, add `'gemini'` to the union types and UI radios. No other architecture change.
- **ASPE / interpreter agent**: the `normalizedEvents` array on each `send()` result is the input contract. A future slice writes the interpreter and subscribes.

---

## References

- F.1 spec: `docs/specs/2026-05-09-foundry-slice-f1-cli-migration-design.md`
- F.1 plan: `docs/plans/2026-05-09-foundry-slice-f1-cli-migration.md`
- Upstream Phase 0 implementation spec (Codex JSON event shape, observed live on `codex-cli 0.117.0` 2026-04-19): `C:/Project-TOAD/upstream-reference/agent-teams-ai-main/docs/research/codex-native-runtime-phase-0-implementation-spec.md` lines 137-172
- Upstream Phase 0 signoff evidence: `C:/Project-TOAD/upstream-reference/agent-teams-ai-main/docs/research/codex-native-runtime-phase-0-signoff-evidence.md`
- Upstream Codex `app-server` JSON-RPC client (NOT used in F.2 but documented for future reference): `C:/Project-TOAD/upstream-reference/agent-teams-ai-main/src/main/services/infrastructure/codexAppServer/`
- Symphony's existing per-provider abstraction pattern: `src/drift/llm/providerResolver.js` and `src/drift/llm/llmJudge.js`
- Symphony's existing provider auth: `src/providers/providerAuth.js`
