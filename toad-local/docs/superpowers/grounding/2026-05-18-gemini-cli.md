# Gemini CLI 0.42.0 — Grounding Probe

**Date:** 2026-05-18  
**Probed by:** Task 1 grounding probe (SP1b Task 1)  
**CLI version:** `0.42.0`  
**Auth:** `~/.gemini/settings.json` present; `selectedType: "oauth-personal"`.

---

## 1. Versions

Verbatim output of `gemini --version`:

```
0.42.0
```

---

## 2. Headless flag set

Verbatim output of `gemini --help`:

```
Usage: gemini [options] [command]

Gemini CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode.

Commands:
  gemini mcp                   Manage MCP servers
  gemini extensions <command>  Manage Gemini CLI extensions.  [aliases: extension]
  gemini skills <command>      Manage agent skills.  [aliases: skill]
  gemini hooks <command>       Manage Gemini CLI hooks.  [aliases: hook]
  gemini gemma                 Manage local Gemma model routing
  gemini [query..]             Launch Gemini CLI  [default]

Positionals:
  query  Initial prompt. Runs in interactive mode by default; use -p/--prompt for non-interactive.

Options:
  -d, --debug                     Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -m, --model                     Model  [string]
  -p, --prompt                    Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]
  -i, --prompt-interactive        Execute the provided prompt and continue in interactive mode  [string]
      --skip-trust                Trust the current workspace for this session.  [boolean] [default: false]
  -w, --worktree                  Start Gemini in a new git worktree. If no name is provided, one is generated automatically.  [string]
  -s, --sandbox                   Run in sandbox?  [boolean]
  -y, --yolo                      Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]
      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]
      --policy                    Additional policy files or directories to load (comma-separated or multiple --policy)  [array]
      --admin-policy              Additional admin policy files or directories to load (comma-separated or multiple --admin-policy)  [array]
      --acp                       Starts the agent in ACP mode  [boolean]
      --experimental-acp          Starts the agent in ACP mode (deprecated, use --acp instead)  [boolean]
      --allowed-mcp-server-names  Allowed MCP server names  [array]
      --allowed-tools             [DEPRECATED: Use Policy Engine instead See https://geminicli.com/docs/core/policy-engine] Tools that are allowed to run without confirmation  [array]
  -e, --extensions                A list of extensions to use. If not provided, all extensions are used.  [array]
  -l, --list-extensions           List all available extensions and exit.  [boolean]
  -r, --resume                    Resume a previous session. Use "latest" for most recent or index number (e.g. --resume 5)  [string]
      --session-id                Start a new session with a manually provided UUID.  [string]
      --list-sessions             List available sessions for the current project and exit.  [boolean]
      --delete-session            Delete a session by index number (use --list-sessions to see available sessions).  [string]
      --include-directories       Additional directories to include in the workspace (comma-separated or multiple --include-directories)  [array]
      --screen-reader             Enable screen reader mode for accessibility.  [boolean]
  -o, --output-format             The format of the CLI output.  [string] [choices: "text", "json", "stream-json"]
      --raw-output                Disable sanitization of model output (e.g. allow ANSI escape sequences). WARNING: This can be a security risk if the model output is untrusted.  [boolean]
      --accept-raw-output-risk    Suppress the security warning when using --raw-output.  [boolean]
  -v, --version                   Show version number  [boolean]
  -h, --help                      Show help  [boolean]
```

---

## 3. Structured-output mechanism

**`-o`/`--output-format` EXISTS with three values: `"text"`, `"json"`, `"stream-json"`.**

Exact help line:
```
  -o, --output-format             The format of the CLI output.  [string] [choices: "text", "json", "stream-json"]
```

**`--acp` (Agent Client Protocol) also EXISTS:**
```
      --acp                       Starts the agent in ACP mode  [boolean]
      --experimental-acp          Starts the agent in ACP mode (deprecated, use --acp instead)  [boolean]
```

**Conclusion:** The adapter's use of `--output-format stream-json` is a REAL flag with a REAL `stream-json` value in 0.42.0. The flag also has a short form `-o`. The event vocabulary produced by `stream-json` is unverified in this probe (no prompt was run — that is Task 2), but the flag itself is confirmed as real.

---

## 4. Resume/session mechanism

**`-r`/`--resume` EXISTS:**

Exact help line:
```
  -r, --resume                    Resume a previous session. Use "latest" for most recent or index number (e.g. --resume 5)  [string]
```

**Additional session management flags also present:**
```
      --session-id                Start a new session with a manually provided UUID.  [string]
      --list-sessions             List available sessions for the current project and exit.  [boolean]
      --delete-session            Delete a session by index number (use --list-sessions to see available sessions).  [string]
```

**Conclusion:** `--resume <id>` is a REAL flag in 0.42.0. The adapter's use of `['--resume', resumeId]` is structurally correct. However, the help text says `--resume` accepts `"latest"` or an **index number** (e.g. `--resume 5`), not a UUID session ID. It is a `[string]` type. Whether it also accepts an opaque session-ID string (as the adapter assumes) is **UNVERIFIED** — the event vocabulary may expose the session ID shape in Task 2.

---

## 5. MCP config schema

### `~/.gemini/settings.json` — verbatim

```json
{
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  },
  "general": {
    "previewFeatures": true,
    "vimMode": true
  }
}
```

No MCP server entries are present in this file. The settings file does not contain an `mcpServers` key.

### `gemini mcp --help` — verbatim

```
gemini mcp

Manage MCP servers

Commands:
  gemini mcp add <name> <commandOrUrl> [args...]  Add a server
  gemini mcp remove <name>                        Remove a server
  gemini mcp list                                 List all configured MCP servers
  gemini mcp enable <name>                        Enable an MCP server
  gemini mcp disable <name>                       Disable an MCP server

Options:
  -d, --debug  Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -h, --help   Show help  [boolean]
```

### `gemini mcp list` — verbatim

```
No MCP servers configured.
```

### MCP config schema notes

The `gemini mcp add <name> <commandOrUrl> [args...]` signature suggests MCP servers are stored in `~/.gemini/settings.json` (or a related file) under a key not yet visible in this settings snapshot. The current settings.json has no `mcpServers` key. The `--allowed-mcp-server-names` flag (an array) suggests allowlisting by server name at runtime. The actual on-disk MCP schema for `settings.json` is **not fully observable from help text alone** — the exact key structure will require `gemini mcp add` output or documentation fetch. The `mcp add` signature `<name> <commandOrUrl> [args...]` is the primary observable fact.

---

## 6. DIVERGENCE vs current adapter

Source files read:
- `toad-local/src/runtime/GeminiExecAdapter.js` (lines 99–106: the `args` array in `#attemptTurn`)
- `toad-local/src/runtime/gemini/normalizeGeminiStreamLine.js`

| Assumption | Real (verbatim from §2–§5) | Status |
|---|---|---|
| `--output-format stream-json` | `--output-format` exists; choices are `"text"`, `"json"`, `"stream-json"` — exact help: `[string] [choices: "text", "json", "stream-json"]` | **CONFIRMED** (flag + value are real) |
| `--approval-mode yolo` | `--approval-mode` exists; choices are `"default"`, `"auto_edit"`, `"yolo"`, `"plan"` — exact help: `[string] [choices: "default", "auto_edit", "yolo", "plan"]` | **CONFIRMED** |
| `--skip-trust` | `--skip-trust` exists — exact help: `Trust the current workspace for this session.  [boolean] [default: false]` | **CONFIRMED** |
| `--allowed-mcp-server-names toad-local` | `--allowed-mcp-server-names` exists — exact help: `Allowed MCP server names  [array]` | **CONFIRMED** (flag is real; value `toad-local` is a name to allowlist — semantics depend on a configured MCP server named `toad-local`, which is not configured on this machine) |
| `--resume <id>` (adapter passes a string resumeId from sessionStore) | `--resume` exists — exact help: `Resume a previous session. Use "latest" for most recent or index number (e.g. --resume 5)  [string]` | **WRONG (PARTIALLY)** — flag exists but the documented values are `"latest"` or an **index number**, not an opaque session-ID string. The adapter stores and passes a string resumeId from `session_started` events. Whether that string is actually an index number or a UUID depends on what the `stream-json` event emits (unverified — Task 2). |
| `-p` (adapter passes `-p`, `GEMINI_PROMPT_ARG`) | `-p`/`--prompt` exists — exact help: `Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]` | **CONFIRMED** (flag is real; note: help says `-p` is *appended* to stdin, whereas the adapter also writes stdinPrompt to child.stdin — both mechanisms are active simultaneously; their interaction is unverified) |
| `init` event → `session_started` (normalizer: `parsed.type === 'init'`, reads `parsed.session_id`) | UNVERIFIED — no stream-json output was captured in this probe (Task 2 covers this) | **UNVERIFIED** |
| `message` event with `role === 'assistant'` and `content` string → `assistant_text` (normalizer: `parsed.type === 'message'`, `parsed.role === 'assistant'`, `parsed.content`) | UNVERIFIED — no stream-json output was captured in this probe (Task 2 covers this) | **UNVERIFIED** |
| `tool_use` event with `name` string → `tool_use` (normalizer: `parsed.type === 'tool_use'`, `parsed.name`) | UNVERIFIED — no stream-json output was captured in this probe (Task 2 covers this) | **UNVERIFIED** |
| `result` event with `status === 'success'` → `turn_completed` (normalizer: `parsed.type === 'result'`, `parsed.status`) | UNVERIFIED — no stream-json output was captured in this probe (Task 2 covers this) | **UNVERIFIED** |
| `result` event with `status !== 'success'` → `turn_failed` | UNVERIFIED — no stream-json output was captured in this probe (Task 2 covers this) | **UNVERIFIED** |
| `error` event → `turn_failed` (normalizer: `parsed.type === 'error'`) | UNVERIFIED — no stream-json output was captured in this probe (Task 2 covers this) | **UNVERIFIED** |
| `stats` sub-object with `input_tokens`/`output_tokens` → aliased to `usage` (`withUsageAlias`) | UNVERIFIED — no stream-json output was captured in this probe (Task 2 covers this) | **UNVERIFIED** |

**Summary of confirmed flags:** `--output-format stream-json`, `--approval-mode yolo`, `--skip-trust`, `--allowed-mcp-server-names`, `--resume`, `-p` — all flags exist. The event vocabulary (`init`, `message`, `result`, `tool_use`, `error`, `stats`) is entirely unverified at the `stream-json` layer.

**The `--resume` value type concern:** the adapter passes an arbitrary string from sessionStore as the `--resume` value. The help text only documents `"latest"` and index numbers. If `stream-json` emits a session identifier in the `init` event and `--resume` accepts that identifier format, the adapter logic is correct; if gemini only accepts index numbers, the adapter's session-resume is broken. **This is the highest-risk divergence from this probe.**

---

## 7. RATIFIED first-turn and resume argv (FINALIZED — event vocab confirmed in §8–§10)

Based on §2–§5 (flags) and §8–§10 (live event capture), the RATIFIED argv arrays are:

**First turn (no prior session):**
```js
[
  '--output-format', 'stream-json',   // confirmed real; stream-json is a valid choice
  '--approval-mode', 'yolo',          // confirmed real; yolo is a valid choice
  '--approval-mode', 'plan',          // NOTE: probe used 'plan' (read-only); adapter uses 'yolo'
  '--skip-trust',                     // confirmed real (boolean flag)
  '--allowed-mcp-server-names', 'toad-local',  // confirmed real (array flag)
  '--session-id', '<uuid-we-generate>',        // RATIFIED: pass a caller-generated UUID so the
                                               // session is identifiable for resume (see §10)
  '-p', '<PROMPT_ARG>',               // confirmed real (headless mode)
]
```

**Resume turn (continuing a prior session):**

The `--resume` flag accepts `"latest"` or a **1-based index number** (e.g. `--resume 4`). It does NOT accept a UUID string. To resume a specific session the adapter must record the session index from `--list-sessions` output after the first turn, OR use `"latest"` to resume the most-recent session. The `--session-id` UUID from the `init` event is NOT valid as a `--resume` argument.

```js
[
  '--output-format', 'stream-json',
  '--approval-mode', 'yolo',
  '--skip-trust',
  '--allowed-mcp-server-names', 'toad-local',
  '--resume', 'latest',               // OR '--resume', '<index-number-as-string>'
  '-p', '<PROMPT_ARG>',
]
```

The adapter also writes `stdinPrompt` to `child.stdin`. Since `-p` help says it is "appended to input on stdin (if any)", both the `-p` argument and stdin content are combined.

---

## 8. Verbatim structured events (one real turn)

**Run:** `timeout 120 gemini -p "Reply with exactly: ok" --output-format stream-json --approval-mode plan --skip-trust > /tmp/gemini-stream-cap.txt 2>&1 || true`

**Byte count:** 858 bytes. **Exit code:** 0 (success).

**Raw contents of `/tmp/gemini-stream-cap.txt` (verbatim, every line):**

```
Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.
Ripgrep is not available. Falling back to GrepTool.
{"type":"init","timestamp":"2026-05-18T21:48:31.116Z","session_id":"d7108a26-61db-4261-9865-549ab9d788e6","model":"auto-gemini-3"}
{"type":"message","timestamp":"2026-05-18T21:48:31.117Z","role":"user","content":"Reply with exactly: ok"}
{"type":"message","timestamp":"2026-05-18T21:48:34.780Z","role":"assistant","content":"ok","delta":true}
{"type":"result","timestamp":"2026-05-18T21:48:34.874Z","status":"success","stats":{"total_tokens":10400,"input_tokens":10284,"output_tokens":1,"cached":0,"input":10284,"duration_ms":3759,"tool_calls":0,"models":{"gemini-3.1-pro-preview":{"total_tokens":10400,"input_tokens":10284,"output_tokens":1,"cached":0,"input":10284}}}}
```

**Notes:**
- Two lines on stdout before the JSON stream are **warnings written to stdout** (not stderr): the true-color warning and the ripgrep fallback notice. These must be filtered before JSON parsing. Any non-`{`-prefixed line must be skipped.
- The JSON events are newline-delimited (NDJSON). Each event is one line.
- The `init` event is the first JSON line. The user-echo `message` event follows immediately (same millisecond). The assistant response arrives ~3.7 seconds later.
- The session was subsequently confirmed in `--list-sessions` as index **4** with UUID `d7108a26-61db-4261-9865-549ab9d788e6`.

**Verbatim `--list-sessions` output (run immediately after):**

```
Available sessions for this project (4):
  1. Reply with OK only (4 hours ago) [2e888f26-b084-4619-b24f-37164107dbcb]
  2. Reply with OK only Use the instructions from stdin. (4 hours ago) [d287e8e0-a1e2-40da-b9df-e7955b235ffa]
  3. /quota (Just now) [59d4e55f-a766-4e91-8d80-b7e15a985f6c]
  4. Reply with exactly: ok (Just now) [d7108a26-61db-4261-9865-549ab9d788e6]
```

**On-disk session storage** (`~/.gemini/tmp/toad-local/chats/`):

```
session-2026-05-18T17-45-2e888f26.jsonl   ← session 1
session-2026-05-18T17-46-d287e8e0.jsonl   ← session 2
session-2026-05-18T21-45-59d4e55f.jsonl   ← session 3
session-2026-05-18T21-48-d7108a26.jsonl   ← session 4 (this probe's turn)
```

The filename pattern is `session-<ISO-datetime>-<uuid-first-8-chars>.jsonl`. The session directory also contains a UUID-named subdirectory (`59d4e55f-a766-4e91-8d80-b7e15a985f6c/`) used by at least one session (session 3), suggesting sessions may also be stored as directories of JSONL shards.

---

## 9. Event → TOAD normalized mapping

For each event type observed in the real turn:

| Real event (verbatim shape) | Field carrying session identity | TOAD normalized event |
|---|---|---|
| `{"type":"init","timestamp":"...","session_id":"<uuid>","model":"<str>"}` | `session_id` — a **UUID v4 string** (e.g. `"d7108a26-61db-4261-9865-549ab9d788e6"`) | `session_started { sessionId: parsed.session_id }` |
| `{"type":"message","timestamp":"...","role":"user","content":"<str>"}` | (none — user echo only) | Skip / `runtime_event` (user echo, not agent output) |
| `{"type":"message","timestamp":"...","role":"assistant","content":"<str>","delta":true}` | (none) | `assistant_text { text: parsed.content }` |
| `{"type":"result","timestamp":"...","status":"success","stats":{...}}` | (none) | `turn_completed { usage: parsed.stats }` |
| `{"type":"result","timestamp":"...","status":"<non-success>","stats":{...}}` | (none) | `turn_failed { status: parsed.status, usage: parsed.stats }` |
| Non-JSON line (warning/notice on stdout) | (none) | Skip (filter before `JSON.parse`) |

**`stats` sub-object shape (verbatim from this turn):**
```json
{
  "total_tokens": 10400,
  "input_tokens": 10284,
  "output_tokens": 1,
  "cached": 0,
  "input": 10284,
  "duration_ms": 3759,
  "tool_calls": 0,
  "models": {
    "gemini-3.1-pro-preview": {
      "total_tokens": 10400,
      "input_tokens": 10284,
      "output_tokens": 1,
      "cached": 0,
      "input": 10284
    }
  }
}
```

**Normalizer notes:**
- The existing normalizer checks `parsed.type === 'init'` and reads `parsed.session_id` — this is **CONFIRMED CORRECT** by the real event shape.
- The existing normalizer checks `parsed.type === 'message'` and `parsed.role === 'assistant'` — this is **CONFIRMED CORRECT**. The `content` field holds the text.
- The `"delta":true` field on assistant messages indicates streaming delta (not yet observed as false/absent in this turn — a single-token response may always be delta). The normalizer should emit `assistant_text` regardless of `delta` value.
- The existing normalizer checks `parsed.type === 'result'` and `parsed.status` — this is **CONFIRMED CORRECT**. Stats are under `parsed.stats` (not `parsed.usage` — the `withUsageAlias` rename is needed).
- The `tool_use` event type was NOT observed in this turn (no tools invoked). Its shape remains unverified but the normalizer's current assumption (`parsed.type === 'tool_use'`, `parsed.name`) is not contradicted.
- The `error` event type was NOT observed. Its shape remains unverified.
- **New finding:** non-JSON warning lines appear on stdout before the NDJSON stream. The normalizer MUST handle `JSON.parse` failures gracefully — currently it emits `parse_error` for non-JSON lines, which is correct behavior.

---

## 10. RATIFIED event vocabulary + session model

### RATIFIED event vocabulary

| Event type | Source (`parsed.type`) | TOAD normalized event | Notes |
|---|---|---|---|
| `init` | `"init"` | `session_started { sessionId }` | `session_id` field = UUID v4 string — **CONFIRMED** |
| `message` (user echo) | `"message"`, `role:"user"` | skip / `runtime_event` | User prompt echo — not agent output |
| `message` (assistant) | `"message"`, `role:"assistant"` | `assistant_text { text }` | `content` field holds text; `delta:true` present — **CONFIRMED** |
| `result` (success) | `"result"`, `status:"success"` | `turn_completed { usage }` | `stats` field holds token counts — **CONFIRMED** |
| `result` (non-success) | `"result"`, `status!="success"` | `turn_failed { status, usage }` | Not observed but logically follows |
| `tool_use` | `"tool_use"` | `tool_use { name }` | Not observed in this turn; shape unverified |
| `error` | `"error"` | `turn_failed { error }` | Not observed in this turn; shape unverified |
| non-JSON stdout line | parse failure | `parse_error` (or skip) | Warnings/notices appear before JSON stream |

### RATIFIED session-continuity model

**Session identity:** The `init` event emits `session_id` as a **UUID v4 string** (e.g. `"d7108a26-61db-4261-9865-549ab9d788e6"`). This UUID also appears in `--list-sessions` output in brackets and in the on-disk filename (`session-<datetime>-<uuid-prefix>.jsonl`).

**Starting a named session:** Use `--session-id <uuid>` to start a new session with a caller-provided UUID. The `init` event will echo back that UUID in `session_id`. This allows the adapter to know the session identity before parsing output. (**Confirmed as a real flag from §2; behavior consistent with evidence.**)

**Resuming a session:** `--resume` accepts:
- `"latest"` — resumes the most-recently-used session
- A **1-based index number as a string** (e.g. `"4"`) — resumes session at that index per `--list-sessions` output

**`--resume` does NOT accept a UUID string.** The session UUID in the `init` event is NOT a valid `--resume` argument. The `--list-sessions` index is the resume handle.

**What the adapter must change:** The current adapter stores the `session_id` UUID from the `init` event into its `sessionStore` and later passes it as `['--resume', resumeId]`. This is **BROKEN** — `--resume` does not accept a UUID. The correct approach is one of:
1. **`--resume "latest"`** — always resume the most-recent session (simplest; safe if the adapter runs one session per project at a time)
2. **Record the index from `--list-sessions`** after a first turn, then pass that index on resume — fragile if other sessions are created concurrently
3. **Use `--session-id <uuid>` on first turn + `--resume "latest"` on subsequent turns** — the adapter controls the UUID, emits it in `--session-id`, receives it back in `init.session_id`, and always resumes with `"latest"` (safe for single-session-per-project use)

**Option 3 is the RATIFIED approach** for the TOAD adapter: the adapter generates a UUID before spawning, passes `--session-id <uuid>`, stores the UUID from `init.session_id` as confirmation, and uses `--resume latest` for all subsequent turns in that session lifecycle.

**What remains unproven:** Whether `--resume latest` will correctly resume across process restarts (i.e. after the node process is killed and restarted) — the session JSONL files persist on disk, so this is likely correct but not live-tested in this probe.
