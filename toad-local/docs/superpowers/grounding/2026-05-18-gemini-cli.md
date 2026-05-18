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

## 7. RATIFIED first-turn argv (provisional — event vocab confirmed in Task 2)

Based on §2–§5, the flags used by the adapter for a first turn are all confirmed as real. The provisional ratified argv for a first turn is:

```js
[
  '--output-format', 'stream-json',   // confirmed real, stream-json is a valid choice
  '--approval-mode', 'yolo',          // confirmed real, yolo is a valid choice
  '--skip-trust',                     // confirmed real (boolean flag, trusts workspace for session)
  '--allowed-mcp-server-names', 'toad-local',  // confirmed real (array flag)
  '-p', '<PROMPT_ARG>',               // confirmed real (headless mode; note: appended to stdin)
]
```

The adapter also writes `stdinPrompt` to `child.stdin`. Since `-p` help says it is "appended to input on stdin (if any)", both the `-p` argument and stdin content are combined. On a first turn the adapter sets `-p` to the constant `'Follow the instructions above.'` and writes the full system+user prompt to stdin. This dual-channel approach may or may not be intentional — it is not contradicted by the flag definition but the interaction is unverified until Task 2 observes actual model output.

**For resume turns,** the adapter inserts `['--resume', resumeId]` before `-p`. The flag exists; the acceptability of the resumeId string value (versus an index number) is the key open question from §4 and §6. Until Task 2 confirms the `init` event shape and the resume ID format, treat resume as **provisionally correct in structure, unverified in ID format**.
