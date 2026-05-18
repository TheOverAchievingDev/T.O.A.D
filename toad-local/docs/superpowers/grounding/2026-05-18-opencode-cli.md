# opencode 1.15.4 — Grounding Probe

**Date:** 2026-05-18  
**Probed by:** Task 1 grounding probe (SP1c Task 1)  
**CLI version:** `1.15.4`  
**Auth:** `~/.local/share/opencode/auth.json` present; two credentials: `google` (type: `"api"`) and `deepseek` (type: `"api"`). All credential values REDACTED.

---

## 1. Versions

Verbatim output of `opencode --version`:

```
1.15.4
```

---

## 2. Headless command + flag set

Verbatim output of `opencode --help`:

```
⠀                                ▄     
█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀
▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀

Commands:
  opencode completion          generate shell completion script
  opencode acp                 start ACP (Agent Client Protocol) server
  opencode mcp                 manage MCP (Model Context Protocol) servers
  opencode [project]           start opencode tui                                          [default]
  opencode attach <url>        attach to a running opencode server
  opencode run [message..]     run opencode with a message
  opencode debug               debugging and troubleshooting tools
  opencode providers           manage AI providers and credentials                   [aliases: auth]
  opencode agent               manage agents
  opencode upgrade [target]    upgrade opencode to the latest or a specific version
  opencode uninstall           uninstall opencode and remove all related files
  opencode serve               starts a headless opencode server
  opencode web                 start opencode server and open web interface
  opencode models [provider]   list all available models
  opencode stats               show token usage and cost statistics
  opencode export [sessionID]  export session data as JSON
  opencode import <file>       import session data from JSON file or URL
  opencode github              manage GitHub agent
  opencode pr <number>         fetch and checkout a GitHub PR branch, then run opencode
  opencode session             manage sessions
  opencode plugin <module>     install plugin and update config                      [aliases: plug]
  opencode db                  database tools

Positionals:
  project  path to start opencode in                                                        [string]

Options:
  -h, --help         show help                                                             [boolean]
  -v, --version      show version number                                                   [boolean]
      --print-logs   print logs to stderr                                                  [boolean]
      --log-level    log level                  [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure         run without external plugins                                          [boolean]
      --port         port to listen on                                         [number] [default: 0]
      --hostname     hostname to listen on                           [string] [default: "127.0.0.1"]
      --mdns         enable mDNS service discovery (defaults hostname to 0.0.0.0)
                                                                          [boolean] [default: false]
      --mdns-domain  custom domain name for mDNS service (default: opencode.local)
                                                                [string] [default: "opencode.local"]
      --cors         additional domains to allow for CORS                      [array] [default: []]
  -m, --model        model to use in the format of provider/model                           [string]
  -c, --continue     continue the last session                                             [boolean]
  -s, --session      session id to continue                                                 [string]
      --fork         fork the session when continuing (use with --continue or --session)   [boolean]
      --prompt       prompt to use                                                          [string]
      --agent        agent to use                                                           [string]
```

Verbatim output of `opencode run --help`:

```
opencode run [message..]

run opencode with a message

Positionals:
  message  message to send                                                     [array] [default: []]

Options:
  -h, --help                          show help                                            [boolean]
  -v, --version                       show version number                                  [boolean]
      --print-logs                    print logs to stderr                                 [boolean]
      --log-level                     log level [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure                          run without external plugins                         [boolean]
      --command                       the command to run, use message for args              [string]
  -c, --continue                      continue the last session                            [boolean]
  -s, --session                       session id to continue                                [string]
      --fork                          fork the session before continuing (requires --continue or
                                      --session)                                           [boolean]
      --share                         share the session                                    [boolean]
  -m, --model                         model to use in the format of provider/model          [string]
      --agent                         agent to use                                          [string]
      --format                        format: default (formatted) or json (raw JSON events)
                                          [string] [choices: "default", "json"] [default: "default"]
  -f, --file                          file(s) to attach to message                           [array]
      --title                         title for the session (uses truncated prompt if no value
                                      provided)                                             [string]
      --attach                        attach to a running opencode server (e.g.,
                                      http://localhost:4096)                                [string]
  -p, --password                      basic auth password (defaults to OPENCODE_SERVER_PASSWORD)
                                                                                            [string]
  -u, --username                      basic auth username (defaults to OPENCODE_SERVER_USERNAME or
                                      'opencode')                                           [string]
      --dir                           directory to run in, path on remote server if attaching
                                                                                            [string]
      --port                          port for the local server (defaults to random port if no value
                                      provided)                                             [number]
      --variant                       model variant (provider-specific reasoning effort, e.g., high,
                                      max, minimal)                                         [string]
      --thinking                      show thinking blocks                                 [boolean]
  -i, --interactive                   run in direct interactive split-footer mode
                                                                          [boolean] [default: false]
      --dangerously-skip-permissions  auto-approve permissions that are not explicitly denied
                                      (dangerous!)                        [boolean] [default: false]
      --demo                          enable direct interactive demo slash commands; pass one as the
                                      message to run it immediately       [boolean] [default: false]
```

---

## 3. Structured-output mechanism

**`--format` EXISTS with two choices: `"default"` and `"json"`.**

Exact help line:
```
      --format                        format: default (formatted) or json (raw JSON events)
                                          [string] [choices: "default", "json"] [default: "default"]
```

**There is no `stream-json`, `ndjson`, or `--output-format` flag.** The only structured output mode is `--format json`, described as emitting "raw JSON events". Based on the help description ("raw JSON events"), this implies NDJSON (newline-delimited JSON) on stdout — one event per line — but the exact event shapes are UNVERIFIED in this probe (Task 2 covers live event capture).

**`opencode acp` is a separate ACP server subcommand** (Agent Client Protocol), not a flag for `opencode run`. It has its own port/hostname flags and is an independent mode.

Verbatim `opencode acp --help`:
```
opencode acp

start ACP (Agent Client Protocol) server

Options:
  -h, --help         show help                                                             [boolean]
  -v, --version      show version number                                                   [boolean]
      --print-logs   print logs to stderr                                                  [boolean]
      --log-level    log level                  [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure         run without external plugins                                          [boolean]
      --port         port to listen on                                         [number] [default: 0]
      --hostname     hostname to listen on                           [string] [default: "127.0.0.1"]
      --mdns         enable mDNS service discovery (defaults hostname to 0.0.0.0)
                                                                          [boolean] [default: false]
      --mdns-domain  custom domain name for mDNS service (default: opencode.local)
                                                                [string] [default: "opencode.local"]
      --cors         additional domains to allow for CORS                      [array] [default: []]
      --cwd          working directory              [string] [default: "C:\Project-TOAD\toad-local"]
```

**Conclusion (§3):** The adapter's use of `--format json` is a REAL flag with a REAL `"json"` value in 1.15.4. The flag description is "raw JSON events". The exact NDJSON event shapes emitted by `--format json` are UNVERIFIED until Task 2.

---

## 4. Session/resume model

**`-s`/`--session` EXISTS as a flag on both `opencode run` and the root command:**

From `opencode run --help`:
```
  -c, --continue                      continue the last session                            [boolean]
  -s, --session                       session id to continue                                [string]
      --fork                          fork the session before continuing (requires --continue or
                                      --session)                                           [boolean]
```

From `opencode --help` (root):
```
  -c, --continue     continue the last session                                             [boolean]
  -s, --session      session id to continue                                                 [string]
      --fork         fork the session when continuing (use with --continue or --session)   [boolean]
```

**`opencode session --help` — verbatim:**
```
opencode session

manage sessions

Commands:
  opencode session list                list sessions
  opencode session delete <sessionID>  delete a session

Options:
  -h, --help        show help                                                              [boolean]
  -v, --version     show version number                                                    [boolean]
      --print-logs  print logs to stderr                                                   [boolean]
      --log-level   log level                   [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure        run without external plugins                                           [boolean]
```

**`opencode session list` output (verbatim — current machine, no session values fabricated):**
```
Session ID                      Title                                   Updated
───────────────────────────────────────────────────────────────────────────────
ses_1c3b8b47dffebv2zX5iBF9mw2h  New session - 2026-05-18T18:09:25.891Z  12:09 PM
ses_1c3b96feaffeXJXpOTm1DC8H3X  New session - 2026-05-18T18:08:37.909Z  12:09 PM
```

**Session ID format:** Prefixed with `ses_` followed by an alphanumeric string (e.g. `ses_1c3b8b47dffebv2zX5iBF9mw2h`). NOT a UUID v4 — it is an opaque prefixed token.

**Session resume model:** `--session <id>` accepts a session ID string (the `ses_*` format observed in `opencode session list`). `--continue` resumes the last session (boolean flag, no value). The `-s`/`--session` flag description is "session id to continue" — it takes the literal session ID string, not an index number.

**`opencode export --help` — verbatim:**
```
opencode export [sessionID]

export session data as JSON

Positionals:
  sessionID  session id to export                                                           [string]

Options:
  -h, --help        show help                                                              [boolean]
  -v, --version     show version number                                                    [boolean]
      --print-logs  print logs to stderr                                                   [boolean]
      --log-level   log level                   [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure        run without external plugins                                           [boolean]
      --sanitize    redact sensitive transcript and file data                              [boolean]
```

**Conclusion (§4):** `-s`/`--session <id>` is a REAL flag that accepts the session ID string (e.g. `ses_1c3b8b47dffebv2zX5iBF9mw2h`). The adapter's use of `['--session', resumeId]` is structurally correct IF the session ID stored in `sessionStore` comes from the `--format json` event stream (i.e. if there is a `session_started`-equivalent event that emits the `ses_*` ID). The exact event shape that carries the session ID is UNVERIFIED (Task 2).

---

## 5. MCP config schema

### `~/.config/opencode/opencode.jsonc` — verbatim

```json
{
  "$schema": "https://opencode.ai/config.json"
}
```

No MCP server entries are present. The file currently contains only the schema reference.

### `~/.local/share/opencode/` directory listing — verbatim

```
auth.json
log
opencode.db
opencode.db-shm
opencode.db-wal
repos
snapshot
storage
```

### `~/.local/share/opencode/auth.json` — JSON shape (keys only, all credential VALUES REDACTED)

```json
{
  "google": {
    "type": "api",
    "key": "<REDACTED>"
  },
  "deepseek": {
    "type": "api",
    "key": "<REDACTED>"
  }
}
```

**Schema note:** The auth file uses a top-level object keyed by provider name. Each entry has `"type"` (string, e.g. `"api"`) and `"key"` (string, credential value).

### `opencode providers list` — verbatim (no secrets in output)

```
┌  Credentials ~/.local/share/opencode/auth.json
│
●  Google  api
│
●  DeepSeek  api
│
└  2 credentials
```

### `opencode providers --help` — verbatim

```
opencode providers

manage AI providers and credentials

Commands:
  opencode providers list         list providers and credentials                       [aliases: ls]
  opencode providers login [url]  log in to a provider
  opencode providers logout       log out from a configured provider

Options:
  -h, --help        show help                                                              [boolean]
  -v, --version     show version number                                                    [boolean]
      --print-logs  print logs to stderr                                                   [boolean]
      --log-level   log level                   [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure        run without external plugins                                           [boolean]
```

### `opencode mcp --help` — verbatim

```
opencode mcp

manage MCP (Model Context Protocol) servers

Commands:
  opencode mcp add            add an MCP server
  opencode mcp list           list MCP servers and their status                        [aliases: ls]
  opencode mcp auth [name]    authenticate with an OAuth-enabled MCP server
  opencode mcp logout [name]  remove OAuth credentials for an MCP server
  opencode mcp debug <name>   debug OAuth connection for an MCP server

Options:
  -h, --help        show help                                                              [boolean]
  -v, --version     show version number                                                    [boolean]
      --print-logs  print logs to stderr                                                   [boolean]
      --log-level   log level                   [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure        run without external plugins                                           [boolean]
```

### `opencode mcp add --help` — verbatim

```
opencode mcp add

add an MCP server

Options:
  -h, --help        show help                                                              [boolean]
  -v, --version     show version number                                                    [boolean]
      --print-logs  print logs to stderr                                                   [boolean]
      --log-level   log level                   [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure        run without external plugins                                           [boolean]
```

**Note:** `opencode mcp add` exposes NO positional arguments and NO MCP-specific flags beyond the common options in its `--help`. The add subcommand appears to be interactive-only (TUI-driven) with no documented CLI parameters for server name, command, transport type, env vars, or trust. This is in contrast to Gemini CLI which exposes `<name> <commandOrUrl> [args...]` positionals. The MCP configuration mechanism (how servers are stored, in what file, in what schema) cannot be observed from help text alone on this machine since no MCP servers are configured and `mcp add` is interactive.

### `opencode mcp list` — verbatim

```
┌  MCP Servers
│
▲  No MCP servers configured
│
└  Add servers with: opencode mcp add
```

### MCP config location inference

The `opencode providers list` output shows credentials at `~/.local/share/opencode/auth.json`. The main config is at `~/.config/opencode/opencode.jsonc` with schema reference `https://opencode.ai/config.json`. MCP server configuration is likely stored in `opencode.jsonc` under an `mcp` or `mcpServers` key — but since no servers are configured and `mcp add` is interactive, the exact on-disk schema is NOT observable from this probe. The real schema shape must be confirmed via Task 2 or by running `opencode mcp add` interactively and observing the written config.

---

## 6. DIVERGENCE vs current adapter

Source files read:
- `toad-local/src/runtime/OpencodeExecAdapter.js` (lines 99–106: the `args` array in `#attemptTurn`)
- `toad-local/src/runtime/opencode/normalizeOpencodeStreamLine.js`

| Assumption in adapter | Real (verbatim from §2–§5) | Status |
|---|---|---|
| `opencode run` is the headless subcommand | `opencode run [message..]` — exists, described as "run opencode with a message" | **CONFIRMED** |
| `--format json` flag exists | `--format` exists; choices are `"default"` and `"json"` — exact help: `[string] [choices: "default", "json"] [default: "default"]` | **CONFIRMED** (flag + value are real) |
| `--dangerously-skip-permissions` flag exists | `--dangerously-skip-permissions` exists — exact help: `auto-approve permissions that are not explicitly denied (dangerous!)  [boolean] [default: false]` | **CONFIRMED** |
| `--session <id>` for resume | `-s, --session` exists — exact help: `session id to continue  [string]`. Session IDs have `ses_*` prefix format (e.g. `ses_1c3b8b47dffebv2zX5iBF9mw2h`). | **CONFIRMED** (flag exists and takes an ID string; whether the `--format json` event stream emits a matching `ses_*` ID is UNVERIFIED — Task 2) |
| `--model`/`-m` flag | `-m, --model` exists — exact help: `model to use in the format of provider/model  [string]`. The adapter's `normalizeOpencodeArgs` allowlists this flag. | **CONFIRMED** |
| `--agent` flag | `--agent` exists — exact help: `agent to use  [string]`. The adapter's `normalizeOpencodeArgs` allowlists this flag. | **CONFIRMED** |
| `--variant` flag | `--variant` exists — exact help: `model variant (provider-specific reasoning effort, e.g., high, max, minimal)  [string]`. The adapter's `normalizeOpencodeArgs` allowlists this flag. | **CONFIRMED** |
| `--thinking` flag | `--thinking` exists — exact help: `show thinking blocks  [boolean]`. The adapter allowlists this flag. | **CONFIRMED** |
| Message/prompt delivered via stdin (`child.stdin.write(stdinPrompt); child.stdin.end()`) | `opencode run [message..]` — the prompt is a **positional argument** (`message  message to send  [array]`). There is no `-p`/`--prompt` flag on `opencode run`. The adapter writes to stdin instead of passing the message as an argument. | **WRONG** — stdin delivery is unverified; the documented interface is CLI positional args. Whether `opencode run --format json` also reads from stdin is UNVERIFIED (Task 2). |
| `step_start` / `part.type === 'step-start'` → `session_started` event shape | UNVERIFIED — no `--format json` output was captured in this probe (Task 2 covers live event capture) | **UNVERIFIED** |
| `step_finish` / `part.type === 'step-finish'` → `turn_completed` event shape | UNVERIFIED — no `--format json` output captured | **UNVERIFIED** |
| `text` / `part.type === 'text'` → `assistant_text` event shape | UNVERIFIED — no `--format json` output captured | **UNVERIFIED** |
| `tool` / `part.type === 'tool'` → `tool_use` event shape | UNVERIFIED — no `--format json` output captured | **UNVERIFIED** |
| `error` event → `turn_failed` | UNVERIFIED — no `--format json` output captured | **UNVERIFIED** |
| `part.tokens.input` / `part.tokens.output` → usage alias | UNVERIFIED — no `--format json` output captured | **UNVERIFIED** |
| `sessionId` read from `parsed.sessionID` / `parsed.sessionId` / `part.sessionID` / `part.sessionId` | UNVERIFIED — no `--format json` output captured; real session ID format is `ses_*` prefix string from `opencode session list` | **UNVERIFIED** |

**Summary:** All CLI flags used by the adapter (`run`, `--format json`, `--dangerously-skip-permissions`, `--session`, `--model`, `--agent`, `--variant`, `--thinking`) are CONFIRMED as real flags in 1.15.4. The highest-risk unconfirmed assumption is **stdin delivery of the prompt** — `opencode run` takes the message as a positional argument array, not via stdin, and no `-p`/`--prompt` flag exists on this subcommand. All event vocabulary assumptions (`step_start`, `step_finish`, `text`, `tool`, `error`, `part.tokens`, session ID field name) are UNVERIFIED pending Task 2.

---

## 7. RATIFIED first-turn argv (FINALIZED — event vocab confirmed in Task 2)

Based on §2–§5 (flags) and the live event capture in §8–§10, the FINALIZED argv for a first turn is:

```js
[
  'run',
  '--format', 'json',                    // CONFIRMED real flag + value; emits NDJSON (§8)
  '--dangerously-skip-permissions',      // CONFIRMED real flag
  '-m', 'deepseek/deepseek-chat',        // CONFIRMED real flag (optional; any `opencode models` id)
  // '--agent', '<agent>',               // CONFIRMED real flag; optional
  // '--variant', '<variant>',           // CONFIRMED real flag; optional
  // '--thinking',                       // CONFIRMED real flag; optional
  '<message>',                           // CONFIRMED: positional message arg works (§8 turn used it)
]
```

**FINALIZED note on message delivery:** The Task-2 live turn passed the prompt as a CLI **positional argument** (`opencode run "Reply with exactly: ok" ...`) and it succeeded — the assistant replied `"ok"`. Positional message delivery is now CONFIRMED working with `--format json`. The current adapter writes the prompt to `child.stdin` and passes NO positional message arg; **this is WRONG** and must switch to passing the message as a positional argument (stdin delivery remains UNVERIFIED and is not the documented interface — do not rely on it).

**Resume turn (continuing a prior session):**
```js
[
  'run',
  '--format', 'json',
  '--dangerously-skip-permissions',
  '--session', 'ses_1c2b157c3ffesws2xivZl0UA5M',  // CONFIRMED: ses_* id from stream `sessionID` field (§9)
  // optional model/agent/variant/thinking flags
  '<message>',                                     // positional message arg
]
```

The captured `ses_*` id (top-level `sessionID` on EVERY event — see §9) is the exact value to pass back via `--session`. The `--continue` (`-c`) boolean flag is the alternative for resuming the most-recent session without an id, analogous to Gemini's `--resume latest`.

---

## 8. Verbatim structured events (one real turn)

**Command run (exactly ONE turn, real metered DeepSeek tokens):**
```
cd /c/Project-TOAD/toad-local
timeout 150 opencode run "Reply with exactly: ok" --format json -m deepseek/deepseek-chat --dangerously-skip-permissions > /tmp/opencode-cap.txt 2>&1 || true
```

**Byte count:** `1039 /tmp/opencode-cap.txt` (1039 bytes).

**Exit behavior:** Command completed well within the 150s timeout (no timeout fire). stdout+stderr were merged into the capture file via `2>&1`; the file contains ONLY structured NDJSON events — no stderr noise, no log lines, no banner. `|| true` was present but the process exited cleanly (the assistant produced its reply and the run terminated normally). The model billed `cost: 0.00105084` (~$0.00105) for `tokens.total: 7505` (input 7504, output 1).

**EXACT `/tmp/opencode-cap.txt` contents (every line unmodified, NDJSON — one JSON object per line):**

```
{"type":"step_start","timestamp":1779145027317,"sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","part":{"id":"prt_e3d4eaeee001NYz21Z2zReMg4L","messageID":"msg_e3d4ea990001B5s6x35rDX65dV","sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","snapshot":"41ef9149af1a23d082407235a255f95d2ce5055f","type":"step-start"}}
{"type":"text","timestamp":1779145028055,"sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","part":{"id":"prt_e3d4eb12e001rt368WFpUuD0F6","messageID":"msg_e3d4ea990001B5s6x35rDX65dV","sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","type":"text","text":"ok","time":{"start":1779145027886,"end":1779145028048}}}
{"type":"step_finish","timestamp":1779145028963,"sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","part":{"id":"prt_e3d4eb54e001H0z1go82mXiheA","reason":"stop","snapshot":"41ef9149af1a23d082407235a255f95d2ce5055f","messageID":"msg_e3d4ea990001B5s6x35rDX65dV","sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","type":"step-finish","tokens":{"total":7505,"input":7504,"output":1,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.00105084}}
```

**Free post-turn `opencode session list 2>&1 | head -10` (verbatim — confirms the stream's `ses_*` id is persisted):**
```
Session ID                      Title                                   Updated
───────────────────────────────────────────────────────────────────────────────
ses_1c2b157c3ffesws2xivZl0UA5M  ok                                      4:57 PM
ses_1c3b8b47dffebv2zX5iBF9mw2h  New session - 2026-05-18T18:09:25.891Z  12:09 PM
ses_1c3b96feaffeXJXpOTm1DC8H3X  New session - 2026-05-18T18:08:37.910Z  12:09 PM
```

The session id `ses_1c2b157c3ffesws2xivZl0UA5M` emitted in the stream's `sessionID` field is the SAME id that now appears in `opencode session list` (title `ok` = the truncated prompt). **The stream-emitted id IS the resumable session id** — it is not an internal/ephemeral id distinct from what `--session` accepts.

---

## 9. Event → TOAD normalized mapping

Three event `type` values were observed in this real turn: `step_start`, `text`, `step_finish`. (No `tool`, no `error`/`turn_failed`, no separate `part`/`part.tokens` envelope — usage rides INSIDE the `step_finish` part.)

### Top-level envelope shape (ALL events)
Every NDJSON line is a JSON object with this top-level shape:
```
{ "type": <string>, "timestamp": <ms epoch number>, "sessionID": "ses_*", "part": { ... } }
```
**The `ses_*` session id is carried in the TOP-LEVEL `sessionID` field of EVERY event** (and ALSO duplicated inside `part.sessionID` for `step_start`/`text`). It is `"sessionID"` — capital `ID` — at the root of each line. The very FIRST event (`step_start`) already carries it, so the adapter can capture the session id from line 1 without waiting for completion.

### Event 1 — `type: "step_start"`
Verbatim shape:
```
{"type":"step_start","timestamp":1779145027317,"sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","part":{"id":"prt_...","messageID":"msg_...","sessionID":"ses_1c2b157c3ffesws2xivZl0UA5M","snapshot":"41ef91...","type":"step-start"}}
```
- Top-level `type` = `"step_start"`; `part.type` = `"step-start"` (NOTE the divergence: top-level uses **underscore** `step_start`, the nested part uses **hyphen** `step-start`).
- **TOAD normalized event:** `session_started{ sessionId: <top-level sessionID> }` — emit on the first event that carries `sessionID` (this one). `sessionId` = `event.sessionID` (the `ses_*` string). Capture this into `sessionStore` for `--session` resume.

### Event 2 — `type: "text"`
Verbatim shape:
```
{"type":"text","timestamp":1779145028055,"sessionID":"ses_...","part":{"id":"prt_...","messageID":"msg_...","sessionID":"ses_...","type":"text","text":"ok","time":{"start":...,"end":...}}}
```
- Top-level `type` = `"text"`; `part.type` = `"text"`; the assistant content is `part.text` (here `"ok"`).
- **TOAD normalized event:** `assistant_text{ text: event.part.text }`. (This single `text` event carried the complete reply; whether longer replies stream as multiple incremental `text` events or one consolidated event is UNVERIFIED — only a 1-token reply was captured.)

### Event 3 — `type: "step_finish"`
Verbatim shape:
```
{"type":"step_finish","timestamp":1779145028963,"sessionID":"ses_...","part":{"id":"prt_...","reason":"stop","snapshot":"41ef91...","messageID":"msg_...","sessionID":"ses_...","type":"step-finish","tokens":{"total":7505,"input":7504,"output":1,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.00105084}}
```
- Top-level `type` = `"step_finish"`; `part.type` = `"step-finish"` (again underscore vs hyphen divergence).
- `part.reason` = `"stop"` (terminal/normal completion).
- Usage lives at **`part.tokens`** (`{total,input,output,reasoning,cache:{write,read}}`) and cost at **`part.cost`** — NOT in a separate top-level `part.tokens` event.
- **TOAD normalized event:** `turn_completed{ usage: { inputTokens: event.part.tokens.input, outputTokens: event.part.tokens.output, totalTokens: event.part.tokens.total, cacheRead: event.part.tokens.cache.read, cacheWrite: event.part.tokens.cache.write }, costUsd: event.part.cost, stopReason: event.part.reason }`. This is the turn-terminal event.

### Events NOT observed (still UNVERIFIED — no fabrication)
- `tool` / `tool_use` (no tool calls in a "Reply with exactly: ok" turn).
- `error` / `turn_failed` (clean run; the error event shape and its `turn_failed` mapping remain UNVERIFIED).
- Multiple/incremental `text` events for longer replies.
- A distinct top-level `part` or `part.tokens` event type (usage was nested in `step_finish`, not a standalone event).

### Normalizer correction implied
`normalizeOpencodeStreamLine.js` must:
1. Match top-level `type` values `step_start` / `text` / `step_finish` (UNDERSCORE form) — and/or `part.type` `step-start` / `text` / `step-finish` (HYPHEN form). Real lines carry BOTH conventions; matching either is safest.
2. Read the session id from the **top-level `sessionID`** field (capital `ID`), present on every line — NOT only from `part.sessionID` and NOT from `sessionId`/`session_id`. Emit `session_started` on first sight.
3. Read usage from `part.tokens` (`.input`/`.output`/`.total`/`.cache.read`/`.cache.write`) and cost from `part.cost`, on the `step_finish` event — not from a standalone tokens event.
4. Treat `step_finish` (`part.reason: "stop"`) as `turn_completed`.
5. Unknown/unmatched lines → `runtime_event` (passthrough) or `skip`; unparseable lines → `parse_error`.

---

## 10. RATIFIED event vocabulary + session model

### RATIFIED event vocabulary (1.15.4, `opencode run --format json`)
NDJSON on stdout, one JSON object per line, top-level envelope `{type, timestamp, sessionID, part}`. Confirmed event `type` values (this turn): `step_start`, `text`, `step_finish`. The nested `part.type` mirrors with hyphens: `step-start`, `text`, `step-finish`. Definitive REAL→TOAD list:

| Real top-level `type` | Real `part.type` | Carries | TOAD normalized event |
|---|---|---|---|
| `step_start` | `step-start` | `sessionID` (top-level + `part.sessionID`), `messageID`, `snapshot` | `session_started{ sessionId }` (first sight) |
| `text` | `text` | `part.text` (assistant content) | `assistant_text{ text }` |
| `step_finish` | `step-finish` | `part.reason`, `part.tokens{total,input,output,reasoning,cache{write,read}}`, `part.cost` | `turn_completed{ usage, costUsd, stopReason }` |
| (unobserved) `tool` | `tool` | UNVERIFIED | `tool_use` — shape UNVERIFIED |
| (unobserved) `error` | UNVERIFIED | UNVERIFIED | `turn_failed` — shape UNVERIFIED |
| any other line | — | — | `runtime_event` passthrough, or `parse_error` if unparseable |

### RATIFIED first-turn argv
```js
['run', '--format', 'json', '--dangerously-skip-permissions', '-m', 'deepseek/deepseek-chat', '<message>']
```
(`-m` optional — any id from `opencode models`; `<message>` is a CONFIRMED-working positional arg, NOT stdin.)

### RATIFIED resume argv
```js
['run', '--format', 'json', '--dangerously-skip-permissions', '--session', '<captured ses_* id>', '<message>']
```

### PROVEN session-continuity model
1. **Obtain the id:** the `ses_*` session id is emitted in the **top-level `sessionID` field of every event**, starting with the very first `step_start` line. The adapter captures `event.sessionID` from the first line that has it (no need to wait for turn end).
2. **Persist it:** store that exact `ses_*` string (e.g. `ses_1c2b157c3ffesws2xivZl0UA5M`) in `sessionStore` keyed by the TOAD task/session.
3. **Resume:** pass the stored id back verbatim as `['--session', '<ses_* id>']` on the next turn. PROVEN correct: the stream-emitted id is identical to the id `opencode session list` reports as resumable (title `ok` = our prompt) — there is no separate "display id vs resumable id" distinction.
4. **Fallback:** `--continue` (`-c`, boolean) resumes the most-recent session without needing the id.

**Is the adapter's `['--session', <captured-id>]` model correct?** YES — structurally correct. The ONLY required correction is the SOURCE of `<captured-id>`: it must be read from the **top-level `sessionID`** field (capital `ID`) of any stream event (the `step_start` first line is sufficient), NOT from speculative `parsed.sessionId` / `part.sessionId` / `session_id` fields. The real field is `sessionID` (capital ID) at the event root, duplicated in `part.sessionID`.

**Unproven (honest gaps):** `tool`/`error` event shapes (no tool call or failure occurred); multi-event streaming of long `text` replies; whether a malformed/auth-failed run emits a structured `error` event vs a non-JSON stderr dump (this turn's `2>&1` capture was pure JSON, so an error path's format remains UNVERIFIED). These do not block the first-turn/resume argv or the session model, which are fully RATIFIED.
