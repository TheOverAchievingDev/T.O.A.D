# Runtime Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local runtime supervisor that launches child processes, registers live agents in the runtime directory, exposes adapters to delivery workers, and stops processes cleanly.

**Architecture:** `RuntimeSupervisor` is an in-memory lifecycle coordinator for the first local prototype. It accepts injected `spawnProcess` and `createAdapter` functions so tests do not launch real CLIs, while production callers can default to `node:child_process.spawn` and `ClaudeStreamJsonAdapter`.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, `node:events`, existing `RuntimeDirectory`, existing `ClaudeStreamJsonAdapter`.

---

## File Structure

- Create `C:\Project-TOAD\toad-local\src\runtime\RuntimeSupervisor.js`
  - Owns launch, adapter registration, process status tracking, stop, and health.
- Create `C:\Project-TOAD\toad-local\test\runtimeSupervisor.test.js`
  - Tests launch registration, adapter delivery compatibility, exit status projection, and stop.
- Modify `C:\Project-TOAD\toad-local\src\delivery\runtimeDirectory.js`
  - Adds `unregisterAgent()` and `listAgents()` so supervisor stop can remove live destinations and tests can inspect registered agents.
- Modify `C:\Project-TOAD\toad-local\package.json`
  - Adds the supervisor test to `npm test`.
- Modify `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
  - Records the runtime supervisor scaffold and verification coverage.

---

### Task 1: Runtime Directory Removal And Inspection

**Files:**
- Modify: `C:\Project-TOAD\toad-local\src\delivery\runtimeDirectory.js`
- Create: `C:\Project-TOAD\toad-local\test\runtimeSupervisor.test.js`

- [x] **Step 1: Write failing directory tests**

Create `C:\Project-TOAD\toad-local\test\runtimeSupervisor.test.js` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';
import { RuntimeSupervisor } from '../src/runtime/RuntimeSupervisor.js';

test('RuntimeDirectory unregisters agents and lists current registrations', () => {
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-1',
    deliveryMode: 'runtime_stdin',
    metadata: { role: 'lead' },
  });

  assert.deepEqual(directory.listAgents(), [
    {
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-1',
      deliveryMode: 'runtime_stdin',
      metadata: { role: 'lead' },
    },
  ]);

  const removed = directory.unregisterAgent({ teamId: 'team-a', agentId: 'lead' });

  assert.equal(removed, true);
  assert.equal(directory.listAgents().length, 0);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).deliveryMode,
    'offline_queue'
  );
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/runtimeSupervisor.test.js
```

Expected: failure because `RuntimeSupervisor.js` does not exist and `RuntimeDirectory.listAgents()` / `unregisterAgent()` do not exist.

- [x] **Step 3: Add directory APIs**

Modify `RuntimeDirectory`:

```js
  unregisterAgent(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    return this.#agents.delete(buildAgentKey(teamId, agentId));
  }

  listAgents() {
    return Array.from(this.#agents.values()).map((agent) => ({
      ...agent,
      metadata: { ...agent.metadata },
    }));
  }
```

- [x] **Step 4: Run directory test**

Run:

```powershell
node test/runtimeSupervisor.test.js
```

Expected: the test still fails only because `RuntimeSupervisor.js` does not exist.

---

### Task 2: Launch And Register Runtime

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\runtimeSupervisor.test.js`
- Create: `C:\Project-TOAD\toad-local\src\runtime\RuntimeSupervisor.js`

- [x] **Step 1: Add failing launch test**

Append:

```js
function createFakeChild({ pid = 1234 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.killCalls = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.killCalls.push(signal);
    child.emit('exit', 0, signal);
    return true;
  };
  return child;
}

test('RuntimeSupervisor launches a process and registers its adapter destination', async () => {
  const directory = new RuntimeDirectory();
  const spawnCalls = [];
  const child = createFakeChild({ pid: 2468 });
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    createAdapter({ runtimeId, teamId, agentId, child: launchedChild }) {
      return {
        runtimeId,
        teamId,
        agentId,
        child: launchedChild,
        async sendTurn() {
          return { accepted: true, responseState: 'accepted_by_runtime' };
        },
      };
    },
  });

  const result = await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
    args: ['--output-format', 'stream-json'],
    cwd: 'C:\\Project-TOAD',
    env: { TOAD_TEAM_ID: 'team-a' },
    deliveryMode: 'runtime_stdin',
  });

  assert.equal(result.runtimeId, 'runtime-lead-1');
  assert.equal(result.status, 'running');
  assert.equal(result.pid, 2468);
  assert.equal(spawnCalls[0].command, 'claude');
  assert.deepEqual(spawnCalls[0].args, ['--output-format', 'stream-json']);
  assert.equal(spawnCalls[0].options.cwd, 'C:\\Project-TOAD');
  assert.equal(spawnCalls[0].options.env.TOAD_TEAM_ID, 'team-a');
  assert.equal(directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).runtimeId, 'runtime-lead-1');
  assert.equal(supervisor.getAdapter('runtime-lead-1').child, child);
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/runtimeSupervisor.test.js
```

Expected: failure because `RuntimeSupervisor` is not implemented.

- [x] **Step 3: Implement minimal supervisor launch**

Create `C:\Project-TOAD\toad-local\src\runtime\RuntimeSupervisor.js` with:

```js
import { spawn } from 'node:child_process';
import { ClaudeStreamJsonAdapter } from './ClaudeStreamJsonAdapter.js';

export class RuntimeSupervisor {
  #runtimes = new Map();

  constructor({ runtimeDirectory, spawnProcess = spawn, createAdapter = createClaudeAdapter } = {}) {
    if (!runtimeDirectory) throw new TypeError('runtimeDirectory is required');
    this.runtimeDirectory = runtimeDirectory;
    this.spawnProcess = spawnProcess;
    this.createAdapter = createAdapter;
  }

  async launchAgent(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const command = requireString(input.command, 'command');
    if (this.#runtimes.has(runtimeId)) {
      throw new Error(`runtime already launched: ${runtimeId}`);
    }

    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const child = this.spawnProcess(command, args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env || {}) },
      stdio: input.stdio || ['pipe', 'pipe', 'pipe'],
    });
    const adapter = this.createAdapter({ runtimeId, teamId, agentId, child });
    const record = {
      runtimeId,
      teamId,
      agentId,
      command,
      args,
      child,
      adapter,
      status: 'running',
      pid: typeof child.pid === 'number' ? child.pid : null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      exitCode: null,
      signal: null,
    };
    this.#runtimes.set(runtimeId, record);
    this.runtimeDirectory.registerAgent({
      teamId,
      agentId,
      runtimeId,
      deliveryMode: input.deliveryMode || 'runtime_stdin',
      metadata: { pid: record.pid, providerId: adapter.providerId || 'unknown' },
    });
    if (typeof child.once === 'function') {
      child.once('exit', (code, signal) => this.#markExited(runtimeId, code, signal));
    }

    return this.#snapshot(record);
  }

  getAdapter(runtimeId) {
    return this.#runtimes.get(runtimeId)?.adapter || null;
  }

  getRuntime(runtimeId) {
    const record = this.#runtimes.get(runtimeId);
    return record ? this.#snapshot(record) : null;
  }

  listRuntimes() {
    return Array.from(this.#runtimes.values()).map((record) => this.#snapshot(record));
  }

  #markExited(runtimeId, code, signal) {
    const record = this.#runtimes.get(runtimeId);
    if (!record || record.status === 'stopped') return;
    record.status = 'exited';
    record.exitCode = typeof code === 'number' ? code : null;
    record.signal = typeof signal === 'string' ? signal : null;
    record.stoppedAt = new Date().toISOString();
    this.runtimeDirectory.unregisterAgent({ teamId: record.teamId, agentId: record.agentId });
  }

  #snapshot(record) {
    return {
      runtimeId: record.runtimeId,
      teamId: record.teamId,
      agentId: record.agentId,
      command: record.command,
      args: [...record.args],
      status: record.status,
      pid: record.pid,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      exitCode: record.exitCode,
      signal: record.signal,
    };
  }
}

function createClaudeAdapter({ runtimeId, teamId, agentId, child }) {
  return new ClaudeStreamJsonAdapter({ runtimeId, teamId, agentId, child });
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
```

- [x] **Step 4: Run launch tests**

Run:

```powershell
node test/runtimeSupervisor.test.js
```

Expected: launch tests pass.

---

### Task 3: Stop And Health

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\runtimeSupervisor.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\runtime\RuntimeSupervisor.js`

- [x] **Step 1: Add failing stop and health tests**

Append:

```js
test('RuntimeSupervisor reports health and unregisters stopped runtimes', async () => {
  const directory = new RuntimeDirectory();
  const child = createFakeChild({ pid: 1357 });
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      return child;
    },
    createAdapter({ runtimeId }) {
      return { runtimeId };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  assert.deepEqual(await supervisor.health('runtime-lead-1'), {
    runtimeId: 'runtime-lead-1',
    status: 'running',
    healthy: true,
    pid: 1357,
    exitCode: null,
    signal: null,
  });

  const stopped = await supervisor.stopAgent('runtime-lead-1', { signal: 'SIGTERM' });

  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).deliveryMode,
    'offline_queue'
  );
  assert.deepEqual(await supervisor.health('runtime-lead-1'), {
    runtimeId: 'runtime-lead-1',
    status: 'stopped',
    healthy: false,
    pid: 1357,
    exitCode: 0,
    signal: 'SIGTERM',
  });
});

test('RuntimeSupervisor marks child exit as exited without explicit stop', async () => {
  const directory = new RuntimeDirectory();
  const child = createFakeChild({ pid: 999 });
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      return child;
    },
    createAdapter({ runtimeId }) {
      return { runtimeId };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  child.emit('exit', 7, null);

  assert.equal(supervisor.getRuntime('runtime-lead-1').status, 'exited');
  assert.equal(supervisor.getRuntime('runtime-lead-1').exitCode, 7);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).deliveryMode,
    'offline_queue'
  );
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/runtimeSupervisor.test.js
```

Expected: failure because `stopAgent()` and `health()` do not exist.

- [x] **Step 3: Implement stop and health**

Add methods to `RuntimeSupervisor`:

```js
  async stopAgent(runtimeId, { signal = 'SIGTERM' } = {}) {
    const record = this.#requireRuntime(runtimeId);
    if (record.status === 'running' && record.child && typeof record.child.kill === 'function') {
      record.child.kill(signal);
    }
    record.status = 'stopped';
    record.signal = signal;
    record.stoppedAt = record.stoppedAt || new Date().toISOString();
    this.runtimeDirectory.unregisterAgent({ teamId: record.teamId, agentId: record.agentId });
    return this.#snapshot(record);
  }

  async health(runtimeId) {
    const record = this.#requireRuntime(runtimeId);
    return {
      runtimeId: record.runtimeId,
      status: record.status,
      healthy: record.status === 'running',
      pid: record.pid,
      exitCode: record.exitCode,
      signal: record.signal,
    };
  }

  #requireRuntime(runtimeId) {
    const id = requireString(runtimeId, 'runtimeId');
    const record = this.#runtimes.get(id);
    if (!record) throw new Error(`unknown runtime: ${id}`);
    return record;
  }
```

- [x] **Step 4: Run supervisor tests**

Run:

```powershell
node test/runtimeSupervisor.test.js
```

Expected: all supervisor tests pass.

---

### Task 4: Package And Staged Plan Checkpoint

**Files:**
- Modify: `C:\Project-TOAD\toad-local\package.json`
- Modify: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

- [x] **Step 1: Add supervisor test to package script**

Modify `package.json` test script so it ends with:

```json
"... && node test/claudeStreamJsonAdapter.test.js && node test/runtimeSupervisor.test.js"
```

- [x] **Step 2: Update staged plan scaffold**

Under `Local scaffold:` add:

```markdown
- `toad-local/src/runtime/RuntimeSupervisor.js`
- `toad-local/test/runtimeSupervisor.test.js`
```

Under `Current verification:`, append:

```markdown
Runtime supervisor tests cover directory unregister/list behavior, process launch registration, adapter lookup, child exit projection, stop-time unregister, and health reporting.
```

- [x] **Step 3: Run final verification**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

Because this workspace has no `.git` metadata and the user asked to keep work local, skip commits and report changed files.

---

## Self-Review Notes

- This slice intentionally stays in-memory; durable `runtime_instances` and restart policy should be added after the lifecycle API is stable.
- The default production path can launch a real command through `node:child_process.spawn`, but tests inject a fake process and fake adapter.
- `stopAgent()` records local supervisor state and unregisters the agent immediately; a future graceful-stop watchdog can distinguish requested stop, timeout, and forced kill.
