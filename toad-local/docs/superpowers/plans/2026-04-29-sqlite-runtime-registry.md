# SQLite Runtime Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist runtime instances and current agent delivery-mode mappings in SQLite so runtime routing state is no longer only in memory.

**Architecture:** Add a focused `SqliteRuntimeRegistry` beside the broker/task storage classes. The registry owns durable `runtime_instances` rows and current `agent_delivery_modes` rows; `RuntimeSupervisor` optionally calls it on launch, stop, and child exit. `RuntimeDirectory` remains the fast in-memory resolver, and the registry can hydrate it at startup.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, `node:sqlite`, existing `openToadDatabase()`, existing `RuntimeDirectory`, existing `RuntimeSupervisor`.

---

## File Structure

- Modify `C:\Project-TOAD\toad-local\src\storage\schema.sql`
  - Add `runtime_instances` and `agent_delivery_modes`.
- Create `C:\Project-TOAD\toad-local\src\runtime\sqliteRuntimeRegistry.js`
  - Owns durable runtime lifecycle records and delivery-mode mapping persistence.
- Create `C:\Project-TOAD\toad-local\test\sqliteRuntimeRegistry.test.js`
  - Tests runtime persistence, delivery-mode hydration, and stopped-runtime cleanup.
- Modify `C:\Project-TOAD\toad-local\src\runtime\RuntimeSupervisor.js`
  - Optional `runtimeRegistry` hook for launch, stop, and child exit.
- Modify `C:\Project-TOAD\toad-local\test\runtimeSupervisor.test.js`
  - Tests supervisor registry integration with a fake registry.
- Modify `C:\Project-TOAD\toad-local\package.json`
  - Adds the registry test to `npm test`.
- Modify `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
  - Records the durable runtime registry scaffold and coverage.

---

### Task 1: Durable Runtime Registry Storage

**Files:**
- Modify: `C:\Project-TOAD\toad-local\src\storage\schema.sql`
- Create: `C:\Project-TOAD\toad-local\src\runtime\sqliteRuntimeRegistry.js`
- Create: `C:\Project-TOAD\toad-local\test\sqliteRuntimeRegistry.test.js`

- [x] **Step 1: Write failing runtime persistence tests**

Create `C:\Project-TOAD\toad-local\test\sqliteRuntimeRegistry.test.js` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';
import { SqliteRuntimeRegistry } from '../src/runtime/sqliteRuntimeRegistry.js';

function withRegistry(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-runtime-registry-'));
  const registry = new SqliteRuntimeRegistry({ filePath: join(dir, 'toad.db') });
  try {
    testFn(registry);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteRuntimeRegistry persists runtime instances', () => {
  withRegistry((registry) => {
    const saved = registry.upsertRuntime({
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      providerId: 'claude',
      command: 'claude',
      args: ['--output-format', 'stream-json'],
      cwd: 'C:\\Project-TOAD',
      env: { TOAD_TEAM_ID: 'team-a' },
      deliveryMode: 'runtime_stdin',
      pid: 2468,
      status: 'running',
      startedAt: '2026-04-29T00:00:00.000Z',
    });

    assert.equal(saved.runtimeId, 'runtime-lead-1');
    assert.equal(saved.status, 'running');
    assert.deepEqual(saved.args, ['--output-format', 'stream-json']);
    assert.equal(saved.env.TOAD_TEAM_ID, 'team-a');

    const reopened = registry.getRuntime('runtime-lead-1');
    assert.equal(reopened.providerId, 'claude');
    assert.equal(reopened.pid, 2468);
    assert.equal(registry.listRuntimes({ teamId: 'team-a' }).length, 1);
  });
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node --no-warnings test/sqliteRuntimeRegistry.test.js
```

Expected: failure because `sqliteRuntimeRegistry.js` does not exist.

- [x] **Step 3: Add schema tables**

Add to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS runtime_instances (
  runtime_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  cwd TEXT,
  env_json TEXT NOT NULL DEFAULT '{}',
  delivery_mode TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_instances_team
  ON runtime_instances(team_id, agent_id, status);

CREATE TABLE IF NOT EXISTS agent_delivery_modes (
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id),
  FOREIGN KEY (team_id) REFERENCES teams(team_id),
  FOREIGN KEY (runtime_id) REFERENCES runtime_instances(runtime_id)
);
```

- [x] **Step 4: Implement runtime persistence**

Create `sqliteRuntimeRegistry.js` with constructor, `close()`, `upsertRuntime()`, `getRuntime()`, and `listRuntimes()` using existing `openToadDatabase()`, `jsonStringify()`, and `jsonParseObject()`.

- [x] **Step 5: Run runtime persistence tests**

Run:

```powershell
node --no-warnings test/sqliteRuntimeRegistry.test.js
```

Expected: runtime persistence test passes.

---

### Task 2: Delivery Mode Persistence And Hydration

**Files:**
- Modify: `C:\Project-TOAD\toad-local\src\runtime\sqliteRuntimeRegistry.js`
- Modify: `C:\Project-TOAD\toad-local\test\sqliteRuntimeRegistry.test.js`

- [x] **Step 1: Add failing delivery-mode tests**

Append:

```js
test('SqliteRuntimeRegistry persists and hydrates agent delivery modes', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      providerId: 'claude',
      command: 'claude',
      deliveryMode: 'runtime_stdin',
      status: 'running',
    });
    registry.registerDeliveryMode({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      deliveryMode: 'runtime_stdin',
      metadata: { pid: 2468, providerId: 'claude' },
    });

    const modes = registry.listDeliveryModes();
    assert.equal(modes.length, 1);
    assert.equal(modes[0].runtimeId, 'runtime-lead-1');
    assert.equal(modes[0].metadata.pid, 2468);

    const directory = new RuntimeDirectory();
    registry.hydrateRuntimeDirectory(directory);

    const resolved = directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' });
    assert.equal(resolved.runtimeId, 'runtime-lead-1');
    assert.equal(resolved.deliveryMode, 'runtime_stdin');
    assert.equal(resolved.metadata.pid, 2468);
  });
});

test('SqliteRuntimeRegistry removes delivery modes when runtimes stop', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      providerId: 'claude',
      command: 'claude',
      deliveryMode: 'runtime_stdin',
      status: 'running',
    });
    registry.registerDeliveryMode({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      deliveryMode: 'runtime_stdin',
    });

    const stopped = registry.markRuntimeStopped({
      runtimeId: 'runtime-lead-1',
      status: 'stopped',
      exitCode: 0,
      signal: 'SIGTERM',
      stoppedAt: '2026-04-29T00:01:00.000Z',
    });

    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.exitCode, 0);
    assert.equal(registry.listDeliveryModes().length, 0);
  });
});
```

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node --no-warnings test/sqliteRuntimeRegistry.test.js
```

Expected: failure because delivery-mode methods do not exist.

- [x] **Step 3: Implement delivery-mode APIs**

Add `registerDeliveryMode()`, `unregisterDeliveryMode()`, `listDeliveryModes()`, `hydrateRuntimeDirectory()`, and `markRuntimeStopped()` to `SqliteRuntimeRegistry`.

- [x] **Step 4: Run registry tests**

Run:

```powershell
node --no-warnings test/sqliteRuntimeRegistry.test.js
```

Expected: all registry tests pass.

---

### Task 3: Supervisor Registry Hooks

**Files:**
- Modify: `C:\Project-TOAD\toad-local\src\runtime\RuntimeSupervisor.js`
- Modify: `C:\Project-TOAD\toad-local\test\runtimeSupervisor.test.js`

- [x] **Step 1: Add failing supervisor registry test**

Append a test proving `RuntimeSupervisor` calls `upsertRuntime()`, `registerDeliveryMode()`, and `markRuntimeStopped()` on launch and stop.

- [x] **Step 2: Run test to verify failure**

Run:

```powershell
node test/runtimeSupervisor.test.js
```

Expected: failure because `RuntimeSupervisor` ignores `runtimeRegistry`.

- [x] **Step 3: Add optional registry hooks**

Modify the constructor to accept `runtimeRegistry = null`. On launch, call `upsertRuntime()` and `registerDeliveryMode()`. On `stopAgent()` and child exit, call `markRuntimeStopped()`.

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

- [x] **Step 1: Add registry test to package script**

Modify `package.json` test script so it includes:

```json
"... && node --no-warnings test/sqliteRuntimeRegistry.test.js && node test/runtimeSupervisor.test.js"
```

- [x] **Step 2: Update staged plan scaffold**

Under `Local scaffold:` add:

```markdown
- `toad-local/src/runtime/sqliteRuntimeRegistry.js`
- `toad-local/test/sqliteRuntimeRegistry.test.js`
```

Under `Current verification:`, append:

```markdown
SQLite runtime registry tests cover durable runtime instance rows, delivery-mode mapping persistence, runtime-directory hydration, and stop-time mapping cleanup.
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

- This slice persists runtime identity and current routing metadata only; it does not reattach to old child processes after a restart.
- Hydrating a `runtime_stdin` mapping without an in-memory adapter can still fail retryably in `DeliveryWorker`, which is correct until process reattachment exists.
- Restart policy and stale runtime cleanup are intentionally separate future slices.
