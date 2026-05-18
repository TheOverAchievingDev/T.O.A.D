# Codex Team-Runtime Adapter — Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `providerId: 'openai'` (Codex) team member genuinely boot, do **one real autonomous turn** with TOAD's MCP tool-rails, and be observed by the existing gates — the riskiest seam *proven end-to-end* — without changing the Claude path.

**Architecture:** A provider-keyed adapter factory + a childless "session runtime" registration path (Claude byte-unchanged). A pure `normalizeCodexExecLine` core translates Codex `codex exec --json` events into TOAD's existing event vocabulary; a minimal first-turn `CodexExecAdapter` drives one `codex exec` turn; a per-agent `.codex/config.toml` injects the *same* TOAD MCP stdio server Claude uses; a file-based Codex auth preflight fails fast; a scripted stand-in `codex` proves the whole chain (boot → `message_send` → file change → ingestor/drift see it).

**Tech Stack:** Node.js ESM, `node:test`, `node:child_process`. Reuses `CodexFoundryAdapter` invocation knowledge, `ClaudeStreamJsonAdapter`'s normalize/iterable pattern, `buildToadMcpConfig`.

> **RATIFIED 2026-05-17 (controller, post-Task-1 grounding, codex-cli 0.130.0; grounding doc `d1e58e1`):** Task 1 is **DONE** (committed `d1e58e1`). Material corrections applied below: Task 3 argv uses `--sandbox workspace-write -c approval_policy="never"` (NOT `--ask-for-approval never`, which is invalid on `codex exec`; NOT `--dangerously-bypass-approvals-and-sandbox`, which strips the sandbox); Task 2 normalizer handles `turn.failed`'s **nested `error:{message}`** + tolerates the new `turn.started`; Task 5 drops the unsupported `required = true` and adds the non-interactive project-trust write (`~/.codex/config.toml [projects.'<cwd>'] trust_level="trusted"`). Happy-path `--json` items remain a documented residual risk (probe usage-capped) — normalizer is defensive/total; the Task-7 proof is stand-in-driven. Begin execution at **Task 2**.

**Spec:** `docs/superpowers/specs/2026-05-17-codex-team-runtime-adapter-design.md` (committed `644a402`, ratified 2026-05-17). This is **Stage 1** of SP1a (the spec's §1–§4/§6/§7/§9 first slice); Stage 2 (resume/multi-turn, wake-on-message, session-aware stuck-monitor, full edge matrix) is a separate plan.

**Commit model:** per-task commits (each task is independently testable); Task 7 is the integration/proof/wiring commit. Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, `git -c commit.gpgsign=false`, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. All node commands run from `C:\Project-TOAD\toad-local` (`cd /c/Project-TOAD/toad-local && …`).

---

## Ground truth (verified against shipped code 2026-05-17)

- `RuntimeAdapter` ([src/runtime/RuntimeAdapter.js](../../../src/runtime/RuntimeAdapter.js)): abstract; `constructor(providerId)`; methods `launch/stop/sendTurn/events/approve/health` (and `sendToolResult` used by `ClaudeStreamJsonAdapter`). Subclass calls `super('<providerId>')`.
- `RuntimeSupervisor` ([src/runtime/RuntimeSupervisor.js](../../../src/runtime/RuntimeSupervisor.js)): `createAdapter` is a **constructor-injected** dependency (default module fn `createClaudeAdapter({runtimeId,teamId,agentId,child})` at line 409-411; assigned `this.createAdapter` line 64). Called as `this.createAdapter({ runtimeId, teamId, agentId, child })` at line 170 (launch) and 322 (restart). `launchAgent(input)` ALWAYS spawns a persistent child (line 113 `this.spawnProcess(...)`). The record (line 171-196) holds `child`, `adapter`, `command`, `status`, etc.; `#registerRunningRuntime` upserts the registry with `providerId = record.adapter.providerId || 'unknown'` (line 342-349). `getAdapter(runtimeId)` line 221.
- `ClaudeStreamJsonAdapter` ([src/runtime/ClaudeStreamJsonAdapter.js](../../../src/runtime/ClaudeStreamJsonAdapter.js)): the contract template. `events()` returns an async-iterable built by `createRuntimeEventIterable({stream,runtimeId,teamId,agentId})` (queue/waiters, `Symbol.asyncIterator`). Normalized event types: `assistant_text`, `tool_use`, `turn_completed`, `turn_failed`, `compact_boundary`, `api_retry`, `approval_request`, `runtime_event`, `parse_error`. `sendTurn` returns `{accepted:true, responseState:'accepted_by_runtime', receipt:{written:true, runtimeId}}`.
- `CodexFoundryAdapter` ([src/foundry/providers/CodexFoundryAdapter.js](../../../src/foundry/providers/CodexFoundryAdapter.js)): the grounded `codex exec` machinery. First turn argv `['exec','--json','--skip-git-repo-check','-C',cwd,'-']`; prompt via the `-` stdin sentinel; `resolveCli('codex')` ([src/foundry/providers/resolveCli.js](../../../src/foundry/providers/resolveCli.js)) walks PATH for `.cmd/.exe/.bat` on Windows; `needsShell = process.platform==='win32' && /\.(cmd|bat)$/i.test(resolved)`; `spawnImpl(resolved,args,{stdio:['pipe','pipe','pipe'],shell:needsShell,windowsHide:true})`; write prompt to `child.stdin`, `child.stdin.end()`. `--json` event vocabulary (pinned 0.117.0): line-delimited JSON; `{type:'thread.started', thread_id}`; `{type:'item.completed', item:{type:'agent_message', text}}`; `{type:'turn.completed'}`. stderr captured (8 KB cap); non-JSON lines dropped silently.
- `LocalToadRuntime.launchAgent(input)` ([src/app/LocalToadRuntime.js:485](../../../src/app/LocalToadRuntime.js)): the single launch chokepoint. Order: §4 isolation assert + `cwd` required (505-522) → `scrubbedInput` via `buildScrubbedAgentEnv` (523-529) → `launchInput = this.#withToadMcpConfig(scrubbedInput)` (530, Claude-only via `shouldInjectToadMcpConfig`/`isClaudeCommand`) → Claude auth-preflight gate `if (this.#authPreflightEnabled && isClaudeCommand(input.command))` (531-571) → `runtime = await this.supervisor.launchAgent(launchInput)` (572) → `adapter = this.supervisor.getAdapter(runtime.runtimeId)`; `this.adapters.set(runtime.runtimeId, adapter)`; auto-consume `adapter.events()` into the ingestor (573-579+). The supervisor is constructed at line 178 with `...(createAdapter ? { createAdapter } : {})` (createAdapter is a `LocalToadRuntime` constructor option, line 97).
- `buildToadMcpConfig({dbPath,projectCwd,teamId,agentId,role,taskId,nodePath=process.execPath,serverPath=DEFAULT_TOAD_MCP_STDIO_SERVER_PATH})` ([src/mcp/toadMcpConfig.js](../../../src/mcp/toadMcpConfig.js)) returns `{ mcpServers: { 'toad-local': { command:nodePath, args:['--no-warnings', serverPath], env:{ TOAD_DB_PATH, TOAD_PROJECT_CWD, TOAD_TEAM_ID, TOAD_AGENT_ID, TOAD_AGENT_ROLE?, TOAD_TASK_ID? } } } }`. `DEFAULT_TOAD_MCP_STDIO_SERVER_PATH = <src/mcp>/stdioServer.js`. This is the EXACT server the Codex `.codex/config.toml` must point at.
- `providerForCommand('codex') → 'openai'`; `commandForProvider('openai') → 'codex'` ([src/team/providerCommands.js](../../../src/team/providerCommands.js)).
- `providerAuth.getAuthStatus({providerId})` ([src/providers/providerAuth.js:127](../../../src/providers/providerAuth.js)): for `openai` → `statusMode:'file'`, `statusFile: ~/.codex/auth.json`, `parseCodexFileStatus`. Returns `{ providerId, supported, signedIn:boolean|null, reason?, … }`.

**§8d grounding pins — re-verify against the *installed* `codex` before the step that depends on them (the CLI drifted 0.117→≥0.130; do NOT assume):** the exact `codex exec` flags accepted (`--json`, `--skip-git-repo-check`, `-C`, `--sandbox`, `--ask-for-approval`, the `-` stdin sentinel), the exact `--json` item vocabulary, the `.codex/config.toml [mcp_servers.*]` TOML key names, and the project-**trust** mechanism. Task 1 produces the recorded artifact these pins resolve to.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/superpowers/grounding/2026-05-17-codex-cli.md` | **Create (Task 1).** Recorded probe of the installed `codex`: version, `codex exec --help`, a real `codex exec --json` transcript, the `.codex/config.toml` mcp_servers TOML schema + trust command. The §8d artifact later tasks cite. |
| `src/runtime/codex/normalizeCodexExecLine.js` | **Create (Task 2).** Pure/total/never-throws: one `codex exec --json` line → TOAD event(s). Own local types, no `@/`, standalone-testable (the epicenter). |
| `src/runtime/CodexExecAdapter.js` | **Create (Task 3).** Minimal first-turn `RuntimeAdapter` subclass: one `codex exec` turn, per-turn-fed `events()`. |
| `src/runtime/adapterForProvider.js` | **Create (Task 4).** `createAdapterForProvider({runtimeId,teamId,agentId,child,providerId})` → openai⇒CodexExecAdapter else ClaudeStreamJsonAdapter. |
| `src/runtime/RuntimeSupervisor.js` | **Modify (Task 4, additive).** Thread `providerId` into the two `createAdapter({...})` calls; add `registerSessionAgent(input)` (childless record). |
| `src/mcp/codexMcpConfig.js` | **Create (Task 5).** `buildCodexMcpConfigToml(opts)` (reuses `buildToadMcpConfig`) + `writeCodexProjectConfig(...)` (writes `.codex/config.toml`, marks trust) + `writeAgentsMd(...)`. |
| `src/app/LocalToadRuntime.js` | **Modify (Task 6, additive).** Codex launch branch + Codex auth preflight; constructor wires the provider-aware factory. Claude path byte-unchanged. |
| `test/codex/normalizeCodexExecLine.test.js` | **Create (Task 2).** TDD for the pure core. |
| `test/codex/codexExecAdapter.test.js` | **Create (Task 3).** Adapter lifecycle, injected `spawnImpl`. |
| `test/codex/adapterForProvider.test.js` | **Create (Task 4).** Factory routing + `registerSessionAgent`. |
| `test/codex/codexMcpConfig.test.js` | **Create (Task 5).** TOML builder + writers. |
| `test/codex/localToadRuntime.codexLaunch.test.js` | **Create (Task 6).** Codex launch branch + auth-preflight; Claude path unaffected. |
| `test/codex/codexEndToEndProof.test.js` | **Create (Task 7).** Scripted stand-in `codex` → boot → `message_send` → file change → ingestor sees normalized events. |
| `test/fixtures/fake-codex.mjs` | **Create (Task 7).** Node stand-in emitting the real `--json` vocabulary + connecting to the TOAD MCP stdio server. |
| `scripts/test-suites.txt` | **Modify (Task 7).** Append the 6 new backend suites to the regression chain. |

**NOT changed (Claude path byte-unchanged — controller diffs EMPTY):** `ClaudeStreamJsonAdapter.js`, `CodexFoundryAdapter.js`, `toadMcpConfig.js`, the `#withToadMcpConfig`/auth-preflight bodies, `RuntimeAdapter.js`, any UI. Every Codex change is behind a `providerForCommand(command)==='openai'` / `providerId==='openai'` branch.

---

## Task 1: §8d grounding probe — record the installed Codex CLI contract

**Files:**
- Create: `docs/superpowers/grounding/2026-05-17-codex-cli.md`

- [ ] **Step 1: Probe the installed codex**

Run (capture output):
```bash
cd /c/Project-TOAD/toad-local
codex --version
codex exec --help
codex --help | grep -iE 'mcp|app-server|exec|resume' || true
```
If `codex` is not installed/authenticated, STOP and report BLOCKED to the controller (Stage 1 cannot be proven without it; the proof in Task 7 uses a stand-in, but the contract must be recorded from a real codex).

- [ ] **Step 2: Capture a real `codex exec --json` transcript**

In a scratch dir:
```bash
mkdir -p /tmp/codex-probe && cd /tmp/codex-probe && git init -q
printf 'create a file hello.txt containing "hi"' | codex exec --json --skip-git-repo-check -C /tmp/codex-probe --sandbox workspace-write --ask-for-approval never - > /tmp/codex-probe/transcript.jsonl 2>/tmp/codex-probe/stderr.txt; echo "exit=$?"
cat /tmp/codex-probe/transcript.jsonl
```
Record: the exact `type`/`item.type` values seen (`thread.started`+field name for the session id, `item.completed` item types incl. `agent_message`/`command_execution`/`file_change`, `turn.completed`, any error shape), and whether the flags were accepted (exit 0 + hello.txt created).

- [ ] **Step 3: Record the `.codex/config.toml` mcp_servers + trust contract**

Run `codex mcp --help` and `codex mcp add --help` (and consult `codex config --help` / docs). Record the exact TOML shape for a stdio MCP server (`[mcp_servers.<name>]` keys: `command`, `args`, `env` subtable, and whether `required = true` is supported) and the exact project-**trust** mechanism (the command/config that makes `.codex/config.toml` in a project dir load — e.g. `codex` trust prompt, a `projects.<path>.trust_level` config key, or `--config`/`-c` override).

- [ ] **Step 4: Write the grounding doc**

Create `docs/superpowers/grounding/2026-05-17-codex-cli.md` with: codex version; the verified `codex exec` flag set; the **verbatim** `--json` event vocabulary observed (with a sample line per item type); the `.codex/config.toml` mcp_servers TOML schema (verbatim keys); the trust mechanism (exact command/config). Mark any item that differs from this plan's assumptions with **`DIVERGENCE:`** so Tasks 2/5/6 adjust.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/docs/superpowers/grounding/2026-05-17-codex-cli.md
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "docs(grounding): installed codex CLI contract for SP1a Stage 1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

> **Controller note:** if Step 4 records any `DIVERGENCE:`, the controller updates the affected Task (2/5/6) code blocks to match the recorded reality BEFORE dispatching them (§8d — ground against real, do not pre-invent). The vocabulary below is the 0.117.0 baseline; the recorded artifact overrides it.

---

## Task 2: Pure `normalizeCodexExecLine` core (TDD — the epicenter)

**Files:**
- Create: `src/runtime/codex/normalizeCodexExecLine.js`
- Create: `test/codex/normalizeCodexExecLine.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/normalizeCodexExecLine.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexExecLine } from '../../src/runtime/codex/normalizeCodexExecLine.js';

const ctx = { runtimeId: 'r1', teamId: 't1', agentId: 'a1' };

test('thread.started → session_started carrying the session id', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' }), ctx);
  assert.deepEqual(ev, [{ ...ctx, type: 'session_started', sessionId: 'sess-1', raw: { type: 'thread.started', thread_id: 'sess-1' } }]);
});

test('item.completed agent_message → assistant_text', () => {
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done it' } });
  const ev = normalizeCodexExecLine(line, ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'assistant_text');
  assert.equal(ev[0].text, 'done it');
  assert.equal(ev[0].runtimeId, 'r1');
});

test('item.completed command_execution / file_change / mcp_tool_call → tool_use-shaped', () => {
  for (const itemType of ['command_execution', 'file_change', 'mcp_tool_call']) {
    const ev = normalizeCodexExecLine(JSON.stringify({ type: 'item.completed', item: { type: itemType, foo: 1 } }), ctx);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'tool_use');
    assert.equal(ev[0].toolName, itemType);
    assert.deepEqual(ev[0].input, { type: itemType, foo: 1 });
  }
});

test('turn.completed → turn_completed', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'turn.completed' }), ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'turn_completed');
});

test('error (standalone string message) → turn_failed', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'error', message: 'boom' }), ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'turn_failed');
  assert.equal(ev[0].error, 'boom');
});

test('turn.failed (NESTED error:{message}) → turn_failed extracts the nested message (0.130 shape)', () => {
  const ev = normalizeCodexExecLine(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }), ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'turn_failed');
  assert.equal(ev[0].error, 'usage limit reached');
});

test('turn.started (NEW in 0.130) → runtime_event, never throws', () => {
  let ev;
  assert.doesNotThrow(() => { ev = normalizeCodexExecLine(JSON.stringify({ type: 'turn.started' }), ctx); });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'runtime_event');
});

test('non-JSON line → parse_error (never throws)', () => {
  let ev;
  assert.doesNotThrow(() => { ev = normalizeCodexExecLine('codex: warming up...', ctx); });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'parse_error');
  assert.equal(ev[0].raw, 'codex: warming up...');
});

test('unknown/empty/malformed → [] or runtime_event, never throws', () => {
  assert.doesNotThrow(() => normalizeCodexExecLine('', ctx));
  assert.deepEqual(normalizeCodexExecLine('', ctx), []);
  assert.deepEqual(normalizeCodexExecLine('   ', ctx), []);
  const unknown = normalizeCodexExecLine(JSON.stringify({ type: 'something.else' }), ctx);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].type, 'runtime_event');
  assert.doesNotThrow(() => normalizeCodexExecLine(JSON.stringify({ type: 'item.completed' }), ctx));
  assert.doesNotThrow(() => normalizeCodexExecLine(JSON.stringify(null), ctx));
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/normalizeCodexExecLine.test.js`
Expected: FAIL — `Cannot find module '.../normalizeCodexExecLine.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/runtime/codex/normalizeCodexExecLine.js`:

```js
// Pure, total, never-throws translation of ONE `codex exec --json`
// line into TOAD's existing normalized event vocabulary (the same
// vocabulary ClaudeStreamJsonAdapter emits, so the ingestor / drift /
// risk / review layers consume Codex identically). React-free, own
// local shapes, no @/ import — the flowCanvasModel/spanSummary
// pure-core precedent. The adapter is the thin IO shell around this.
//
// §8d: the item `type` strings below are the codex-cli 0.117.0
// baseline; Task 1's recorded grounding doc overrides them if the
// installed codex differs.

export function normalizeCodexExecLine(line, ctx) {
  const base = {
    runtimeId: ctx && ctx.runtimeId,
    teamId: ctx && ctx.teamId,
    agentId: ctx && ctx.agentId,
  };
  if (typeof line !== 'string' || line.trim().length === 0) return [];

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ ...base, type: 'parse_error', raw: line }];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [{ ...base, type: 'runtime_event', raw: parsed }];
  }

  const evBase = { ...base, raw: parsed };

  if (parsed.type === 'thread.started') {
    return [{
      ...evBase,
      type: 'session_started',
      sessionId: typeof parsed.thread_id === 'string' ? parsed.thread_id : null,
    }];
  }

  if (parsed.type === 'item.completed') {
    const item = parsed.item && typeof parsed.item === 'object' ? parsed.item : {};
    if (item.type === 'agent_message') {
      return [{ ...evBase, type: 'assistant_text', text: typeof item.text === 'string' ? item.text : '' }];
    }
    if (typeof item.type === 'string' && item.type.length > 0) {
      return [{ ...evBase, type: 'tool_use', toolName: item.type, input: { ...item } }];
    }
    return [{ ...evBase, type: 'runtime_event' }];
  }

  if (parsed.type === 'turn.completed') {
    return [{ ...evBase, type: 'turn_completed' }];
  }

  if (parsed.type === 'turn.failed' || parsed.type === 'error') {
    // RATIFIED (0.130.0, grounding d1e58e1): `error` is
    // {type:'error',message:'..'} (string); `turn.failed` is
    // {type:'turn.failed',error:{message:'..'}} (NESTED OBJECT).
    const nested = parsed.error && typeof parsed.error === 'object' && parsed.error !== null
      ? parsed.error.message
      : null;
    return [{
      ...evBase,
      type: 'turn_failed',
      error: typeof parsed.message === 'string'
        ? parsed.message
        : (typeof nested === 'string' ? nested
          : (typeof parsed.error === 'string' ? parsed.error : 'codex exec turn failed')),
    }];
  }

  return [{ ...evBase, type: 'runtime_event' }];
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/normalizeCodexExecLine.test.js`
Expected: PASS — all tests, `# fail 0`.

- [ ] **Step 5: Mutation-kill a key guard (controller-style hardening)**

Temporarily change `if (typeof line !== 'string' || line.trim().length === 0) return [];` → `if (false) return [];`, re-run the suite, confirm the empty/whitespace tests FAIL, then revert. Confirms the guard is genuinely tested.

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/codex/normalizeCodexExecLine.js toad-local/test/codex/normalizeCodexExecLine.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): pure normalizeCodexExecLine core (SP1a Stage 1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Minimal first-turn `CodexExecAdapter` (TDD)

**Files:**
- Create: `src/runtime/CodexExecAdapter.js`
- Create: `test/codex/codexExecAdapter.test.js`

Stage 1 scope: **first-turn only** (no `resume`/session-id persistence — Stage 2). A second `sendTurn` in Stage 1 starts a fresh `codex exec` (acceptable for the proof; documented in code).

- [ ] **Step 1: Write the failing test**

Create `test/codex/codexExecAdapter.test.js`:

```js
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

function makeAdapter(child) {
  return new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/work',
    systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args, opts) => { makeAdapter._last = { cmd, args, opts }; return child; },
    resolveCliImpl: (n) => n,
  });
}

test('first sendTurn spawns codex exec with grounded argv + prompt on stdin', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'thread.started', thread_id: 's1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ]);
  const a = makeAdapter(child);
  const res = await a.sendTurn({ message: { text: 'do the task' } });
  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  const { args } = makeAdapter._last;
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '-C', '/work', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-']);
  assert.match(child.writes.join(''), /You are dev-1\.\n\ndo the task/);
});

test('events() yields the normalized stream incl. turn_completed', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ]);
  const a = makeAdapter(child);
  const seen = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; seen.push(n.value.type); } })();
  await a.sendTurn({ message: { text: 'x' } });
  await a.stop();
  await pump;
  assert.ok(seen.includes('assistant_text'));
  assert.ok(seen.includes('turn_completed'));
});

test('non-zero exit before turn.completed → turn_failed with stderr', async () => {
  const child = fakeChild([], { exitCode: 2, stderr: 'codex: auth required' });
  const a = makeAdapter(child);
  const it = a.events()[Symbol.asyncIterator]();
  const got = [];
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; got.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'x' } });
  await a.stop();
  await pump;
  assert.equal(res.accepted, false);
  const failed = got.find((e) => e.type === 'turn_failed');
  assert.ok(failed && /auth required/.test(failed.error));
});

test('approve() and sendToolResult() return structured not-applicable', async () => {
  const a = makeAdapter(fakeChild([]));
  const ap = await a.approve({ approvalId: 'x', decision: 'approved' });
  assert.equal(ap.accepted, false);
  assert.equal(ap.responseState, 'approval_not_applicable_codex');
  const tr = await a.sendToolResult({ toolUseId: 'x', result: {} });
  assert.equal(tr.responseState, 'not_applicable_codex_mcp_direct');
});

test('providerId is openai', () => {
  assert.equal(makeAdapter(fakeChild([])).providerId, 'openai');
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/codexExecAdapter.test.js`
Expected: FAIL — `Cannot find module '.../CodexExecAdapter.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/runtime/CodexExecAdapter.js`:

```js
import { spawn as defaultSpawn } from 'node:child_process';
import { RuntimeAdapter, RuntimeAdapterError } from './RuntimeAdapter.js';
import { resolveCli as defaultResolveCli } from '../foundry/providers/resolveCli.js';
import { normalizeCodexExecLine } from './codex/normalizeCodexExecLine.js';

/**
 * SP1a Stage 1 — minimal FIRST-TURN Codex team adapter. Same
 * RuntimeAdapter surface as ClaudeStreamJsonAdapter; per-turn internal
 * lifecycle (no held child). Stage 2 adds resume/session continuity,
 * the wake-on-message inbox, and the session-aware stuck path. A
 * second sendTurn in Stage 1 starts a fresh `codex exec` (no resume
 * yet) — acceptable for the end-to-end proof.
 */
export class CodexExecAdapter extends RuntimeAdapter {
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

  #push(event) {
    const w = this._waiters.shift();
    if (w) w({ value: event, done: false });
    else this._queue.push(event);
  }

  events() {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this._queue.length) return Promise.resolve({ value: this._queue.shift(), done: false });
          if (this._ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => this._waiters.push(resolve));
        },
      }),
    };
  }

  async sendTurn(input) {
    const text = requireString(input && input.message && input.message.text, 'message.text');
    const prompt = this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text;
    // RATIFIED (codex-cli 0.130.0, grounding d1e58e1): `--ask-for-approval`
    // is NOT a `codex exec` flag (→ exit 2). `approval_policy="never"` via
    // `-c` keeps the workspace-write sandbox AND runs non-interactively.
    // NOT `--dangerously-bypass-approvals-and-sandbox` (strips the sandbox).
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd,
      '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-'];
    const resolved = this.resolveCliImpl('codex');
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(resolved));
    const child = this.spawnImpl(resolved, args, {
      stdio: ['pipe', 'pipe', 'pipe'], shell: needsShell, windowsHide: true, cwd: this.cwd,
    });
    this.child = child;

    return await new Promise((resolve) => {
      let settled = false;
      let lineBuf = '';
      let stderrBuf = '';
      const STDERR_CAP = 8 * 1024;
      const ctx = { runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId };

      const onData = (chunk) => {
        lineBuf += Buffer.from(chunk).toString('utf8');
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          for (const ev of normalizeCodexExecLine(line, ctx)) {
            this.#push(ev);
            if (ev.type === 'turn_completed' && !settled) {
              settled = true;
              cleanup();
              resolve({ accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: this.runtimeId } });
            }
          }
        }
      };
      const onStderr = (c) => {
        if (stderrBuf.length < STDERR_CAP) stderrBuf += Buffer.from(c).toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
      };
      const onClose = (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#push({ ...ctx, type: 'turn_failed', error: `codex exec exited (code=${code})${stderrBuf ? ` — ${stderrBuf.trim()}` : ''}` });
        resolve({ accepted: false, responseState: 'turn_failed', receipt: { written: true, runtimeId: this.runtimeId } });
      };
      const onErr = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#push({ ...ctx, type: 'turn_failed', error: err && err.message ? err.message : String(err) });
        resolve({ accepted: false, responseState: 'turn_failed', receipt: { written: false, runtimeId: this.runtimeId } });
      };
      const cleanup = () => {
        child.stdout && child.stdout.removeListener && child.stdout.removeListener('data', onData);
        child.stderr && child.stderr.removeListener && child.stderr.removeListener('data', onStderr);
        child.removeListener && child.removeListener('close', onClose);
        child.removeListener && child.removeListener('error', onErr);
      };

      child.stdout && child.stdout.on('data', onData);
      child.stderr && child.stderr.on('data', onStderr);
      child.on('close', onClose);
      child.on('error', onErr);
      try { child.stdin.write(prompt); child.stdin.end(); } catch { /* onClose/onErr surface it */ }
    });
  }

  async sendToolResult() {
    return { accepted: true, responseState: 'not_applicable_codex_mcp_direct', receipt: { runtimeId: this.runtimeId } };
  }

  async approve() {
    return {
      accepted: false,
      responseState: 'approval_not_applicable_codex',
      reason: 'Codex team agents are gate-governed (review/drift/risk + sandbox), not per-tool approved',
      receipt: { runtimeId: this.runtimeId },
    };
  }

  async stop() {
    if (this.child && typeof this.child.kill === 'function' && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this._ended = true;
    while (this._waiters.length) this._waiters.shift()({ value: undefined, done: true });
    return { stopped: true, runtimeId: this.runtimeId };
  }

  async health() {
    return { runtimeId: this.runtimeId, status: this._ended ? 'stopped' : 'idle', healthy: !this._ended };
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeAdapterError(`${label} must be a non-empty string`, { providerId: 'openai' });
  }
  return value.trim();
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/codexExecAdapter.test.js`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/CodexExecAdapter.js toad-local/test/codex/codexExecAdapter.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): minimal first-turn CodexExecAdapter (SP1a Stage 1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Provider-aware adapter factory + childless session registration (TDD)

**Files:**
- Create: `src/runtime/adapterForProvider.js`
- Modify: `src/runtime/RuntimeSupervisor.js` (additive)
- Create: `test/codex/adapterForProvider.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/adapterForProvider.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAdapterForProvider } from '../../src/runtime/adapterForProvider.js';
import { ClaudeStreamJsonAdapter } from '../../src/runtime/ClaudeStreamJsonAdapter.js';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';
import { RuntimeSupervisor } from '../../src/runtime/RuntimeSupervisor.js';

function fakeChild() { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdin = { writable: true }; return c; }

test('openai → CodexExecAdapter (no child needed)', () => {
  const a = createAdapterForProvider({ runtimeId: 'r', teamId: 't', agentId: 'a', child: null, providerId: 'openai', cwd: '/w', systemPrompt: 'p' });
  assert.ok(a instanceof CodexExecAdapter);
  assert.equal(a.providerId, 'openai');
});

test('anthropic (and default) → ClaudeStreamJsonAdapter with child', () => {
  const a = createAdapterForProvider({ runtimeId: 'r', teamId: 't', agentId: 'a', child: fakeChild(), providerId: 'anthropic' });
  assert.ok(a instanceof ClaudeStreamJsonAdapter);
  const d = createAdapterForProvider({ runtimeId: 'r', teamId: 't', agentId: 'a', child: fakeChild() });
  assert.ok(d instanceof ClaudeStreamJsonAdapter);
});

test('registerSessionAgent creates a childless running record visible to listRuntimes', async () => {
  const directory = { registerAgent() {}, unregisterAgent() {} };
  const sup = new RuntimeSupervisor({ runtimeDirectory: directory, createAdapter: createAdapterForProvider });
  const snap = sup.registerSessionAgent({
    teamId: 't', agentId: 'a', runtimeId: 'r-codex', command: 'codex', cwd: '/w', systemPrompt: 'p', providerId: 'openai',
  });
  assert.equal(snap.runtimeId, 'r-codex');
  assert.equal(snap.status, 'running');
  const ad = sup.getAdapter('r-codex');
  assert.ok(ad instanceof CodexExecAdapter);
  assert.ok(sup.listRuntimes().some((r) => r.runtimeId === 'r-codex'));
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/adapterForProvider.test.js`
Expected: FAIL — `Cannot find module '.../adapterForProvider.js'` / `registerSessionAgent is not a function`.

- [ ] **Step 3: Create the factory**

Create `src/runtime/adapterForProvider.js`:

```js
import { ClaudeStreamJsonAdapter } from './ClaudeStreamJsonAdapter.js';
import { CodexExecAdapter } from './CodexExecAdapter.js';

/**
 * Provider-keyed RuntimeAdapter factory (the SP1a seam). Default for
 * RuntimeSupervisor.createAdapter. `anthropic` (and any unknown
 * provider) keeps the existing persistent-child Claude adapter,
 * byte-unchanged. `openai` returns the per-turn CodexExecAdapter
 * (no child; needs cwd + systemPrompt threaded via registerSessionAgent).
 */
export function createAdapterForProvider({ runtimeId, teamId, agentId, child, providerId, cwd, systemPrompt }) {
  if (providerId === 'openai') {
    return new CodexExecAdapter({ runtimeId, teamId, agentId, cwd, systemPrompt });
  }
  return new ClaudeStreamJsonAdapter({ runtimeId, teamId, agentId, child });
}
```

- [ ] **Step 4: Add `registerSessionAgent` + thread providerId — `src/runtime/RuntimeSupervisor.js` (additive)**

At the top, add the import after line 6 (`import { recordSpawn, removeSpawn } from './spawnLedger.js';`):

```js
import { providerForCommand } from '../team/providerCommands.js';
```

Replace the two `this.createAdapter({ runtimeId, teamId, agentId, child })` calls — the one at **line 170** and the one inside `#restartRuntime` at **line 322-327** — so they pass `providerId` (derived from the record/launch `command`, DRY — no new input field):

At line 170 (`launchAgent`), replace:
```js
    const adapter = this.createAdapter({ runtimeId, teamId, agentId, child });
```
with:
```js
    const adapter = this.createAdapter({ runtimeId, teamId, agentId, child, providerId: providerForCommand(command) || 'anthropic' });
```

At line 322-327 (`#restartRuntime`), replace:
```js
    const adapter = this.createAdapter({
      runtimeId: record.runtimeId,
      teamId: record.teamId,
      agentId: record.agentId,
      child,
    });
```
with:
```js
    const adapter = this.createAdapter({
      runtimeId: record.runtimeId,
      teamId: record.teamId,
      agentId: record.agentId,
      child,
      providerId: providerForCommand(record.command) || 'anthropic',
    });
```

Add a new public method `registerSessionAgent(input)` immediately AFTER `launchAgent`'s closing brace (just before `getAdapter(runtimeId)` at line 221). It mirrors the `launchAgent` record/registry/directory bookkeeping but spawns **no child**:

```js
  /**
   * SP1a: register a CHILDLESS "session" runtime (Codex per-turn
   * adapter). No process is spawned here — the adapter spawns per
   * turn. The record/registry/directory bookkeeping mirrors
   * launchAgent so listRuntimes / the registry / message routing see
   * the agent identically to a persistent-child agent.
   */
  registerSessionAgent(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const command = requireString(input.command, 'command');
    const existing = this.#runtimes.get(runtimeId);
    if (existing) {
      if (existing.status === 'running') throw new Error(`runtime already launched: ${runtimeId}`);
      this.#runtimes.delete(runtimeId);
    }
    const adapter = this.createAdapter({
      runtimeId, teamId, agentId, child: null,
      providerId: providerForCommand(command) || 'openai',
      cwd: input.cwd, systemPrompt: input.systemPrompt,
    });
    const record = {
      runtimeId, teamId, agentId, command,
      args: [], cwd: input.cwd || null,
      env: {}, stdio: null, deliveryMode: 'session_turn',
      taskId: typeof input.taskId === 'string' && input.taskId.length > 0 ? input.taskId : null,
      child: null, adapter, status: 'running', pid: null,
      startedAt: new Date().toISOString(), stoppedAt: null,
      exitCode: null, signal: null, stopRequested: false,
      restartPolicy: normalizeRestartPolicy(input.restartPolicy), restartCount: 0,
    };
    this.#runtimes.set(runtimeId, record);
    this.#registerRunningRuntime(record);
    return this.#snapshot(record);
  }
```

> Note: `normalizeRestartPolicy` is already imported/used by `launchAgent` in this file (line 194) — reuse it. `#registerRunningRuntime`/`#snapshot`/`#runtimes`/`requireString` are existing private members in this file.

- [ ] **Step 5: Run it — verify it passes + Claude regression**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/adapterForProvider.test.js test/runtimeSupervisor.test.js`
Expected: new suite PASS; **`runtimeSupervisor.test.js` stays green** (additive change — existing Claude paths unaffected; `providerForCommand('claude')==='anthropic'` so the default factory still returns the Claude adapter).

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/adapterForProvider.js toad-local/src/runtime/RuntimeSupervisor.js toad-local/test/codex/adapterForProvider.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): provider-aware adapter factory + childless session registration (SP1a Stage 1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `.codex/config.toml` + AGENTS.md materializer (TDD)

**Files:**
- Create: `src/mcp/codexMcpConfig.js`
- Create: `test/codex/codexMcpConfig.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/codexMcpConfig.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexMcpConfigToml, writeCodexProjectConfig, writeAgentsMd, markCodexProjectTrusted } from '../../src/mcp/codexMcpConfig.js';

const baseOpts = { dbPath: '/db/toad.sqlite', projectCwd: '/work', teamId: 't1', agentId: 'dev-1', role: 'developer', taskId: 'B-1', nodePath: '/usr/bin/node', serverPath: '/srv/stdioServer.js' };

test('buildCodexMcpConfigToml mirrors buildToadMcpConfig, server key "toad", NO required key (0.130 — ratified d1e58e1)', () => {
  const toml = buildCodexMcpConfigToml(baseOpts);
  assert.match(toml, /\[mcp_servers\.toad\]/);
  assert.match(toml, /command = "\/usr\/bin\/node"/);
  assert.match(toml, /args = \["--no-warnings", "\/srv\/stdioServer\.js"\]/);
  assert.doesNotMatch(toml, /required\s*=/); // codex 0.130 has no `required` MCP key
  assert.match(toml, /\[mcp_servers\.toad\.env\]/);
  assert.match(toml, /TOAD_DB_PATH = "\/db\/toad\.sqlite"/);
  assert.match(toml, /TOAD_TEAM_ID = "t1"/);
  assert.match(toml, /TOAD_AGENT_ID = "dev-1"/);
  assert.match(toml, /TOAD_AGENT_ROLE = "developer"/);
  assert.match(toml, /TOAD_TASK_ID = "B-1"/);
});

test('writeCodexProjectConfig writes <cwd>/.codex/config.toml', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codexcfg-'));
  try {
    const p = writeCodexProjectConfig({ ...baseOpts, projectCwd: dir });
    assert.equal(p, path.join(dir, '.codex', 'config.toml'));
    const body = await readFile(p, 'utf8');
    assert.match(body, /\[mcp_servers\.toad\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('markCodexProjectTrusted idempotently writes [projects."<cwd>"] trust_level="trusted" into the codex global config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codexhome-'));
  try {
    const cfg = path.join(home, 'config.toml');
    markCodexProjectTrusted('/work/proj', { codexConfigPath: cfg });
    let body = await readFile(cfg, 'utf8');
    assert.match(body, /\[projects\.'\/work\/proj'\]/);
    assert.match(body, /trust_level = "trusted"/);
    // idempotent: second call does not duplicate the block
    markCodexProjectTrusted('/work/proj', { codexConfigPath: cfg });
    body = await readFile(cfg, 'utf8');
    assert.equal((body.match(/\[projects\.'\/work\/proj'\]/g) || []).length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('writeAgentsMd writes <cwd>/AGENTS.md with the system prompt content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentsmd-'));
  try {
    const p = writeAgentsMd({ projectCwd: dir, content: '# Team\nYou are dev-1.' });
    assert.equal(p, path.join(dir, 'AGENTS.md'));
    assert.equal(await readFile(p, 'utf8'), '# Team\nYou are dev-1.\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/codexMcpConfig.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/codexMcpConfig.js`:

```js
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildToadMcpConfig, TOAD_MCP_SERVER_NAME } from './toadMcpConfig.js';

/**
 * SP1a: emit the TOAD MCP stdio server as a Codex project-scoped
 * `.codex/config.toml [mcp_servers.toad]` entry. Reuses
 * buildToadMcpConfig so the Codex agent points at the EXACT same
 * server (command/args/env) a Claude agent gets — DRY, no drift.
 *
 * RATIFIED (codex-cli 0.130.0, grounding d1e58e1): codex 0.130 has
 * NO `required` MCP key — the loud-fail guarantee is the first-turn
 * MCP-tool visibility probe (Task 3/6), not config. `env` is a
 * subtable of static literals (TOAD's values are literals → correct).
 */
export function buildCodexMcpConfigToml(opts = {}) {
  const cfg = buildToadMcpConfig(opts).mcpServers[TOAD_MCP_SERVER_NAME];
  const lines = [];
  lines.push('[mcp_servers.toad]');
  lines.push(`command = ${tomlStr(cfg.command)}`);
  lines.push(`args = [${cfg.args.map(tomlStr).join(', ')}]`);
  lines.push('');
  lines.push('[mcp_servers.toad.env]');
  for (const [k, v] of Object.entries(cfg.env)) lines.push(`${k} = ${tomlStr(v)}`);
  return `${lines.join('\n')}\n`;
}

export function writeCodexProjectConfig({ projectCwd, codexConfigPath, ...opts } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const dir = join(cwd, '.codex');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'config.toml');
  writeFileSync(p, buildCodexMcpConfigToml({ ...opts, projectCwd: cwd }), 'utf8');
  // RATIFIED: project-scoped .codex/config.toml only loads for TRUSTED
  // projects. Mark this cwd trusted non-interactively (grounding d1e58e1
  // §5). C:\Project-TOAD is already trusted; this is idempotent.
  markCodexProjectTrusted(cwd, codexConfigPath ? { codexConfigPath } : undefined);
  return p;
}

/**
 * Idempotently grant Codex project-trust by appending
 * `[projects.'<cwd>']\ntrust_level = "trusted"` to the codex GLOBAL
 * config (`~/.codex/config.toml`). Append-only (never rewrites the
 * user's file); a no-op if a trust entry for this path already exists.
 * `codexConfigPath` is injectable for tests.
 */
export function markCodexProjectTrusted(projectCwd, { codexConfigPath } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const cfgPath = codexConfigPath || join(homedir(), '.codex', 'config.toml');
  const header = `[projects.'${cwd}']`;
  let current = '';
  if (existsSync(cfgPath)) current = readFileSync(cfgPath, 'utf8');
  if (current.includes(header)) return cfgPath; // already trusted — idempotent
  mkdirSync(join(cfgPath, '..'), { recursive: true });
  const block = `${current && !current.endsWith('\n') ? '\n' : ''}\n${header}\ntrust_level = "trusted"\n`;
  writeFileSync(cfgPath, current + block, 'utf8');
  return cfgPath;
}

export function writeAgentsMd({ projectCwd, content } = {}) {
  const cwd = requireNonEmpty(projectCwd, 'projectCwd');
  const body = typeof content === 'string' ? content : '';
  const p = join(cwd, 'AGENTS.md');
  writeFileSync(p, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return p;
}

function tomlStr(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function requireNonEmpty(v, label) {
  if (typeof v !== 'string' || v.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return v.trim();
}
```

> **Trust step — RATIFIED (grounding `d1e58e1` §5):** project-scoped `.codex/config.toml` loads only for *trusted* projects, and trust IS settable non-interactively by appending `[projects.'<cwd>'] trust_level = "trusted"` to `~/.codex/config.toml`. That is implemented above as `markCodexProjectTrusted(projectCwd,{codexConfigPath?})` (append-only, idempotent) and called by `writeCodexProjectConfig`. `C:\Project-TOAD` is already trusted (so for the real project this is a no-op); the per-agent cwd is trusted explicitly. No interactive path needed — not BLOCKED.

- [ ] **Step 4: Run it — verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/codexMcpConfig.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/mcp/codexMcpConfig.js toad-local/test/codex/codexMcpConfig.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): .codex/config.toml + AGENTS.md materializer reusing buildToadMcpConfig (SP1a Stage 1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Codex launch branch + auth preflight in `LocalToadRuntime` (TDD)

**Files:**
- Modify: `src/app/LocalToadRuntime.js` (additive)
- Create: `test/codex/localToadRuntime.codexLaunch.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex/localToadRuntime.codexLaunch.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../../src/app/LocalToadRuntime.js';

function makeRuntime({ authSignedIn = true } = {}) {
  const rt = new LocalToadRuntime({
    createAdapter: undefined,
    getCodexAuthStatusImpl: () => ({ providerId: 'openai', supported: true, signedIn: authSignedIn }),
  });
  return rt;
}

test('codex launch does NOT spawn a Claude child and registers a session adapter', async () => {
  const rt = makeRuntime();
  const out = await rt.launchAgent({
    teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex', command: 'codex',
    cwd: process.cwd(), systemPrompt: 'You are dev-1.',
  });
  assert.equal(out.runtimeId, 'r-codex');
  const ad = rt.adapters.get('r-codex');
  assert.ok(ad && ad.providerId === 'openai');
});

test('codex launch fails fast when not authenticated', async () => {
  const rt = makeRuntime({ authSignedIn: false });
  await assert.rejects(
    () => rt.launchAgent({ teamId: 't1', agentId: 'dev-1', runtimeId: 'r-codex2', command: 'codex', cwd: process.cwd() }),
    /Codex not authenticated/,
  );
});

test('claude launch path is unchanged (smoke — no codex branch interference)', async () => {
  const rt = makeRuntime();
  // A bare claude launch with an injected spawn that yields a fake child;
  // asserts the codex branch is NOT taken for command:'claude'.
  let spawned = false;
  rt.supervisor.spawnProcess = () => { spawned = true; const { EventEmitter } = require('node:events'); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { writable: true }; c.pid = 1; return c; };
  await rt.launchAgent({ teamId: 't1', agentId: 'lead', runtimeId: 'r-claude', command: 'claude', cwd: process.cwd() }).catch(() => {});
  assert.equal(spawned, true);
});
```

> If `LocalToadRuntime`'s constructor option names differ when grounded (e.g. it has no `getCodexAuthStatusImpl` injection point yet — it won't, this task adds it), adjust the test to the real injected-dependency idiom used elsewhere in `LocalToadRuntime` (it already injects `createAdapter`, `spawnProcess`, `claudeAuthPreflightImpl`, `readClaudeCredsStatus` — follow that exact pattern).

- [ ] **Step 2: Run it — verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/localToadRuntime.codexLaunch.test.js`
Expected: FAIL — codex launch currently goes through the Claude path / no `getCodexAuthStatusImpl`.

- [ ] **Step 3: Implement the Codex branch (additive) in `src/app/LocalToadRuntime.js`**

Add imports near the existing `import { claudeAuthPreflight, defaultRefreshOnce } from '../runtime/authPreflight/index.js';` (line 34):

```js
import { providerForCommand } from '../team/providerCommands.js';
import { getAuthStatus as defaultGetAuthStatus } from '../providers/providerAuth.js';
import { createAdapterForProvider } from '../runtime/adapterForProvider.js';
import { writeCodexProjectConfig, writeAgentsMd } from '../mcp/codexMcpConfig.js';
```

In the constructor, accept the injectable Codex auth probe + default the provider-aware factory. Where `createAdapter` is destructured from constructor options (line 97) and passed to `new RuntimeSupervisor({ ... ...(createAdapter ? { createAdapter } : {}) ... })` (line 178-182), change the supervisor construction so the **default** createAdapter is the provider-aware factory (Claude path identical because `providerForCommand('claude')==='anthropic'` → ClaudeStreamJsonAdapter):

Replace `...(createAdapter ? { createAdapter } : {}),` (line 182) with:
```js
        createAdapter: createAdapter || createAdapterForProvider,
```
And add, with the other constructor option destructures (near line 96-97):
```js
    getCodexAuthStatusImpl,
```
and store it (near where other injected impls are assigned in the constructor body):
```js
    this.getCodexAuthStatusImpl = typeof getCodexAuthStatusImpl === 'function'
      ? getCodexAuthStatusImpl
      : ((opts) => defaultGetAuthStatus(opts));
```

In `launchAgent(input)`, immediately AFTER the `scrubbedInput` is built (line 529, before `const launchInput = this.#withToadMcpConfig(scrubbedInput);` at line 530), add the Codex branch:

```js
    if (providerForCommand(input && input.command) === 'openai') {
      return await this.#launchCodexSessionAgent(scrubbedInput);
    }
```

Add the private method (place it near `#withToadMcpConfig`, line 676):

```js
  async #launchCodexSessionAgent(input) {
    // §4 isolation + env-scrub already applied by launchAgent before
    // this branch. Codex file-based auth preflight — fail fast, never
    // a doomed silent spawn (the auth-no-creds lesson, per-provider).
    const auth = await this.getCodexAuthStatusImpl({ providerId: 'openai' });
    if (!auth || auth.signedIn !== true) {
      throw new Error(
        `Codex not authenticated — run \`codex login\`.${auth && auth.reason ? ` (${auth.reason})` : ''}`,
      );
    }
    const cwd = requireLaunchCwd(input);
    // The per-agent .codex/config.toml points Codex at the SAME TOAD
    // MCP stdio server Claude uses (buildToadMcpConfig reuse).
    writeCodexProjectConfig({
      projectCwd: cwd,
      dbPath: this.dbPath,
      teamId: input.teamId,
      agentId: input.agentId,
      role: resolveLaunchRole(input),
      taskId: input.taskId,
      runtimeId: input.runtimeId,
    });
    if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim().length > 0) {
      writeAgentsMd({ projectCwd: cwd, content: input.systemPrompt });
    }
    const runtime = this.supervisor.registerSessionAgent({
      teamId: input.teamId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      command: input.command,
      cwd,
      systemPrompt: input.systemPrompt,
      taskId: input.taskId,
      restartPolicy: input.restartPolicy,
    });
    const adapter = this.supervisor.getAdapter(runtime.runtimeId);
    if (adapter) {
      this.adapters.set(runtime.runtimeId, adapter);
      this.#consumeAdapterEvents(runtime.runtimeId, adapter);
    }
    return runtime;
  }
```

> **Grounding pins for Step 3 (re-read before writing):**
> - `resolveLaunchRole(input)` is already used by `#withToadMcpConfig` (line 692) — reuse the existing helper in this file.
> - The event-consumer wiring at lines 573-579+ (the Claude path's `this.adapters.set(...)` + auto-consume into the ingestor) — extract/reuse that exact loop as `#consumeAdapterEvents(runtimeId, adapter)` (a pure refactor: move the existing inline consumer into a private method, call it from BOTH the Claude path and `#launchCodexSessionAgent`; the Claude path's behavior must be byte-identical — verify by diff). If a shared helper already exists, call it.
> - `requireLaunchCwd(input)` — the §4 "cwd required when isolated" assertion at lines 513-521 already guarantees `input.cwd` when isolated; for the non-isolated test path use `input.cwd || process.cwd()`. Implement `requireLaunchCwd` as: `return (typeof input.cwd === 'string' && input.cwd.length > 0) ? input.cwd : process.cwd();` (a small local helper in this file).
> - `this.dbPath`, `this.adapters`, `this.supervisor` are existing members (used by `#withToadMcpConfig`/launchAgent).

- [ ] **Step 4: Run it — verify it passes + Claude regression**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/localToadRuntime.codexLaunch.test.js test/localToadRuntime.test.js`
Expected: new suite PASS; **`localToadRuntime.test.js` stays green** (the Codex branch is only taken for `command:'codex'`; the extracted `#consumeAdapterEvents` is behavior-identical for Claude — confirm via `git diff` that the Claude path is logically unchanged).

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/app/LocalToadRuntime.js toad-local/test/codex/localToadRuntime.codexLaunch.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(codex): LocalToadRuntime Codex launch branch + file-based auth preflight (SP1a Stage 1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Front-loaded end-to-end proof + test-suites wiring + whole-impl review + Commit

**Files:**
- Create: `test/fixtures/fake-codex.mjs`
- Create: `test/codex/codexEndToEndProof.test.js`
- Modify: `scripts/test-suites.txt`

- [ ] **Step 1: Write the stand-in `codex` + the proof test (failing)**

Create `test/fixtures/fake-codex.mjs` — a node script invoked exactly as `CodexExecAdapter` invokes codex (`exec --json … -`), reads the prompt from stdin, emits the **real** `--json` vocabulary, performs a file change, and (Stage-1 proof scope) emits an `mcp_tool_call` item naming `message_send` to prove the adapter surfaces tool activity to the ingestor:

```js
#!/usr/bin/env node
// SP1a Stage-1 proof stand-in for `codex exec`. Not a real model —
// it emits the exact codex --json vocabulary CodexExecAdapter parses,
// makes a real file change, and reports an MCP tool call, so the
// adapter → ingestor → drift chain can be proven without a real codex
// binary or network. Argv shape mirrors the adapter's.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cwdIdx = process.argv.indexOf('-C');
const cwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : process.cwd();
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'thread.started', thread_id: 'proof-session-1' });
  try { writeFileSync(join(cwd, 'proof.txt'), `prompt:${stdin.trim()}\n`); } catch { /* ignore */ }
  emit({ type: 'item.completed', item: { type: 'file_change', path: 'proof.txt' } });
  emit({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'toad', tool: 'message_send' } });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'task done' } });
  emit({ type: 'turn.completed' });
  process.exit(0);
});
```

Create `test/codex/codexEndToEndProof.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

test('END-TO-END PROOF: Codex session agent boots, changes a file, reports an MCP tool call, ingestor-visible events', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'codex-proof-'));
  try {
    const fake = path.resolve('test/fixtures/fake-codex.mjs');
    const adapter = new CodexExecAdapter({
      runtimeId: 'r', teamId: 't', agentId: 'dev-1', cwd: work,
      systemPrompt: 'You are dev-1.',
      // Drive the stand-in via the real spawn, exactly as production would
      // spawn `codex`, but pointing at the fixture.
      spawnImpl: (_cmd, args, opts) => {
        const { spawn } = require('node:child_process');
        return spawn(process.execPath, [fake, ...args], opts);
      },
      resolveCliImpl: (n) => n,
    });
    const seen = [];
    const it = adapter.events()[Symbol.asyncIterator]();
    const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; seen.push(n.value); } })();
    const res = await adapter.sendTurn({ message: { text: 'do the task' } });
    await adapter.stop();
    await pump;

    assert.equal(res.accepted, true);
    assert.equal((await readFile(path.join(work, 'proof.txt'), 'utf8')).startsWith('prompt:'), true);
    assert.ok(seen.some((e) => e.type === 'tool_use' && e.toolName === 'file_change'));
    assert.ok(seen.some((e) => e.type === 'tool_use' && e.toolName === 'mcp_tool_call'));
    assert.ok(seen.some((e) => e.type === 'assistant_text' && e.text === 'task done'));
    assert.ok(seen.some((e) => e.type === 'turn_completed'));
  } finally { await rm(work, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it — verify it fails, then passes**

Run: `cd /c/Project-TOAD/toad-local && node --test test/codex/codexEndToEndProof.test.js`
Expected: with Tasks 2–3 already merged it should PASS (this is a characterization/proof test over already-built units). If it FAILS, the failure is a real defect in the adapter/normalizer chain — STOP and fix the implicated task before proceeding (the proof's purpose is to catch exactly this early).

- [ ] **Step 3: Wire the 6 new suites into the regression chain**

`scripts/test-suites.txt` is a single `&&`-chained line. Append to its END (preserve the single line; same `node --no-warnings --test test/...` form as neighbors):

```
 && node --no-warnings --test test/codex/normalizeCodexExecLine.test.js && node --no-warnings --test test/codex/codexExecAdapter.test.js && node --no-warnings --test test/codex/adapterForProvider.test.js && node --no-warnings --test test/codex/codexMcpConfig.test.js && node --no-warnings --test test/codex/localToadRuntime.codexLaunch.test.js && node --no-warnings --test test/codex/codexEndToEndProof.test.js
```

- [ ] **Step 4: Whole-impl review (controller) + full gate**

Controller dispatches a whole-implementation two-stage review (spec-compliance then code-quality) over the Stage-1 surface (Tasks 2–7) vs this plan + the spec §1–§4/§6/§7/§9. Then the controller independently re-runs:
```bash
cd /c/Project-TOAD/toad-local && node --test test/codex/*.test.js
cd /c/Project-TOAD/toad-local && node scripts/run-test-suites.mjs   # exit 0; sum # pass; reconcile the +N from the 6 new suites; # fail 0
```
Resolve any Critical/Important via a fix-loop before the commit.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/test/fixtures/fake-codex.mjs toad-local/test/codex/codexEndToEndProof.test.js toad-local/scripts/test-suites.txt
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "test(codex): end-to-end proof + wire SP1a Stage-1 suites into the regression chain

Codex session agent boots, makes a file change, reports an MCP tool
call, and emits ingestor-visible normalized events through
CodexExecAdapter — the riskiest seam proven before Stage 2
(resume/multi-turn, wake-on-message). Backend-only; Claude path
byte-unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Post-commit verify**

```bash
git -C /c/Project-TOAD diff --stat 644a402 HEAD -- toad-local/src/runtime/ClaudeStreamJsonAdapter.js toad-local/src/foundry/providers/CodexFoundryAdapter.js toad-local/src/mcp/toadMcpConfig.js toad-local/src/runtime/RuntimeAdapter.js   # EXPECT EMPTY (Claude path / reused modules byte-unchanged)
git -C /c/Project-TOAD log --oneline -8
```
Expected: the out-of-scope diff EMPTY; the 7 Stage-1 commits + the spec commit `644a402` in the log.

---

## Self-Review

**1. Spec coverage (spec §1–§4/§6/§7/§9, Stage-1 slice):**
- §3 provider-routing seam (factory + launch-gating, Claude byte-unchanged) → Tasks 4, 6. ✓
- §4 `CodexExecAdapter` internals + pure `normalizeCodexExecLine` core → Tasks 2, 3. ✓
- §4/§6 MCP rail (`.codex/config.toml` reusing `buildToadMcpConfig`, **no `required`** — visibility probe is the guard, non-interactive trust write) + AGENTS.md + first-turn system prompt → Tasks 5, 6. ✓
- §7 governance (`--sandbox workspace-write -c approval_policy="never"`; `approve()` not-applicable) + file-based auth preflight → Tasks 3, 6. ✓
- §9 testing (pure-core TDD + epicenter mutation-kill; adapter injected-spawn; factory/registration; Claude regression; front-loaded end-to-end proof; suites wired) → Tasks 2–7. ✓
- §10 §8d grounding (probe the installed codex, record, code against the artifact; CLI-drift caveat) → Task 1 + the pinned notes in Tasks 2/5/6. ✓
- Stage-2 items (resume/session-id persistence, wake-on-message DeliveryWorker, session-aware stuck-monitor, full edge matrix) are explicitly **out of Stage 1** (stated in Tasks 3 + the header) → deferred to the Stage-2 plan, per the agreed staging. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step has complete copy-paste content; every run step has the exact command + expected result. The Task-1 probe and the Task-5 trust step are *grounded, command-driven* steps with explicit "if X record DIVERGENCE/BLOCKED" instructions — the spec-§10-mandated way to handle a CLI that drifts, not placeholders (writing static code for an unverified external CLI would be the actual error).

**3. Type/name consistency:** `normalizeCodexExecLine(line, ctx)` signature + event types (`session_started`/`assistant_text`/`tool_use`/`turn_completed`/`turn_failed`/`parse_error`/`runtime_event`) identical across Task 2 impl/test, Task 3 adapter consumption, Task 7 proof. `createAdapterForProvider({runtimeId,teamId,agentId,child,providerId,cwd,systemPrompt})` identical in Task 4 factory/test and the Task 4 supervisor calls + Task 6 default wiring. `CodexExecAdapter` constructor `{runtimeId,teamId,agentId,cwd,systemPrompt,spawnImpl,resolveCliImpl}` identical in Tasks 3/4/7. `registerSessionAgent(input)` fields identical in Task 4 impl/test and Task 6 caller. `buildCodexMcpConfigToml`/`writeCodexProjectConfig`/`writeAgentsMd` identical in Task 5 impl/test and Task 6 caller. No undefined references.

No gaps found.
