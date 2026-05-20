# Maintenance Mode M.1a Implementation Plan — Reopen Project Flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user opens Symphony pointed at an existing project (`.toad/toad.db` already populated with at least one team), route directly to Cockpit in a paused state with a Resume CTA — instead of forcing them through Foundry discovery again. Cockpit's paused header surfaces the team's last activity (last task, last drift score, last commit) so reopen feels like resuming, not restarting.

**Architecture:** One new read-only MCP tool (`project_state_describe`) returns the project's lifecycle state + a reopen-context block. App.tsx calls it once on mount and routes accordingly. CockpitScreen renders a paused-team header when `reopenContext` is present and no runtime is running. Resume button wires to the existing `team_launch` tool. No schema migrations. No new tables.

**Tech Stack:** Node 20+ ESM, `node:sqlite` (DatabaseSync), `child_process.spawn` (via existing `runGit` helper). UI: TypeScript, React 18, Vite.

**Spec:** `docs/specs/2026-05-10-maintenance-mode-m1a-reopen-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/commands/command-contract.js` | Modify | Register `PROJECT_STATE_DESCRIBE` constant + dispatch entry |
| `src/tools/localToolFacade.js` | Modify | Implement `#projectStateDescribe` handler + private helpers |
| `src/mcp/localToolDefinitions.js` | Modify | Add MCP schema for `project_state_describe` |
| `test/localToolFacade.test.js` | Modify | TDD coverage for the new handler |
| `test/localMcpToolDefinitions.test.js` | Modify | Verify schema is registered |
| `ui/src/App.tsx` | Modify | Call `project_state_describe` on mount; route based on result; lift `reopenContext` state |
| `ui/src/components/CockpitScreen.tsx` | Modify | Accept `reopenContext` prop; render paused header when present and team not running |
| `ui/src/styles/app-shell.css` | Modify | `.cockpit-paused-header` + child selectors |

---

## Pre-flight

- [ ] **Step P.1: Backend tests pass**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: all suites pass.

- [ ] **Step P.2: UI typecheck + lint clean**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: zero errors.

- [ ] **Step P.3: Git clean**

Run: `git -C C:/Project-TOAD/toad-local status --short`
Expected: only the recent maintenance-mode spec commit, nothing else dirty.

---

## Task 1: Register the new command + MCP schema

**Files:**
- Modify: `src/commands/command-contract.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `test/localMcpToolDefinitions.test.js`

- [ ] **Step 1.1: Find existing FOUNDRY_SESSION_LIST registration in command-contract**

Run: `grep -n "FOUNDRY_SESSION_LIST\|COMMANDS\." "C:/Project-TOAD/toad-local/src/commands/command-contract.js" | head -10`

Note the pattern. Each command has a `COMMANDS.X` constant + a dispatch case in the facade's `execute` method.

- [ ] **Step 1.2: Add PROJECT_STATE_DESCRIBE constant**

In `src/commands/command-contract.js`, find the `COMMANDS` object. Add (alphabetically with the other PROJECT_* / FOUNDRY_* commands; if no good slot exists, put it next to FOUNDRY_SESSION_LIST since both are read-only project-level reads):

```js
PROJECT_STATE_DESCRIBE: 'project_state_describe',
```

- [ ] **Step 1.3: Find the MCP tool definition pattern**

Run: `grep -n "FOUNDRY_SESSION_LIST" "C:/Project-TOAD/toad-local/src/mcp/localToolDefinitions.js" | head -5`

Read the matched block — it shows the read-only tool pattern (no required args, no idempotency).

- [ ] **Step 1.4: Add MCP schema for project_state_describe**

In `src/mcp/localToolDefinitions.js`, add a new tool entry near the other foundry/project read tools:

```js
makeTool({
  name: COMMANDS.PROJECT_STATE_DESCRIBE,
  title: 'Describe Project State',
  description: 'Read-only inspection of the loaded project. Returns one of three states (fresh / half_foundried / has_team) plus a reopenContext block when a team exists. Used by the UI to decide whether to route reopen to Cockpit or Foundry.',
  required: [],
  properties: {},
}),
```

- [ ] **Step 1.5: Write a failing schema test**

In `test/localMcpToolDefinitions.test.js`, add:

```js
test('localToolDefinitions includes project_state_describe with no required args', () => {
  const def = TOOL_DEFINITIONS.find((t) => t.name === 'project_state_describe');
  assert.ok(def, 'project_state_describe should be registered');
  assert.deepEqual(def.inputSchema.required ?? [], []);
});
```

(Adapt the import + test bootstrap pattern to match the rest of the file.)

- [ ] **Step 1.6: Run schema test — verify passing**

Run: `cd C:/Project-TOAD/toad-local && node test/localMcpToolDefinitions.test.js 2>&1 | tail -10`
Expected: all pass including the new one.

- [ ] **Step 1.7: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/commands/command-contract.js src/mcp/localToolDefinitions.js test/localMcpToolDefinitions.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): register project_state_describe command + MCP schema

First step of M.1a. Adds COMMANDS.PROJECT_STATE_DESCRIBE and the MCP
tool definition (no required args, read-only). The facade handler
that actually computes the response lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Implement the `project_state_describe` facade handler (TDD)

**Files:**
- Modify: `src/tools/localToolFacade.js`
- Modify: `test/localToolFacade.test.js`

This is the core backend work. Build it TDD-style, one branch at a time.

- [ ] **Step 2.1: Add the dispatch case in `execute()`**

In `src/tools/localToolFacade.js`, find the giant `execute(command)` switch. Add a new case before the `default:` clause:

```js
case COMMANDS.PROJECT_STATE_DESCRIBE:
  return this.#projectStateDescribe(args);
```

- [ ] **Step 2.2: Add a failing test for the `fresh` state**

In `test/localToolFacade.test.js`, find existing foundry-related tests and add:

```js
test('project_state_describe returns fresh when no teams and no foundry sessions exist', async () => {
  const { facade } = makeTestFacade(); // or whatever helper the file uses
  const result = await facade.execute({
    commandName: COMMANDS.PROJECT_STATE_DESCRIBE,
    actor: { teamId: 'system', agentId: 'ui-client', role: 'human' },
    args: {},
  });
  assert.equal(result.state, 'fresh');
  assert.equal(result.teamConfigs, 0);
  assert.equal(result.foundrySessions, 0);
  assert.equal(result.reopenContext, undefined);
});
```

(Adapt the helper / constructor pattern to whatever the file already uses — `LocalToolFacade` with injected `foundryStore`, `taskBoard`, etc.)

- [ ] **Step 2.3: Run — verify fail**

Run: `cd C:/Project-TOAD/toad-local && node test/localToolFacade.test.js 2>&1 | tail -10`
Expected: failure because `#projectStateDescribe` doesn't exist yet.

- [ ] **Step 2.4: Implement the minimal handler that passes the `fresh` test**

Near the other `#foundry*` private methods in `src/tools/localToolFacade.js`, add:

```js
async #projectStateDescribe(_args) {
  const teamConfigs = this.#countTeamConfigs();
  const foundrySessions = this.#countFoundrySessions();
  if (teamConfigs === 0 && foundrySessions === 0) {
    return { state: 'fresh', teamConfigs, foundrySessions };
  }
  if (teamConfigs === 0) {
    return { state: 'half_foundried', teamConfigs, foundrySessions };
  }
  // has_team — full reopen context below.
  return {
    state: 'has_team',
    teamConfigs,
    foundrySessions,
    reopenContext: await this.#buildReopenContext(),
  };
}

#countTeamConfigs() {
  if (typeof this.teamConfigRegistry?.listTeamIds !== 'function') return 0;
  try {
    return this.teamConfigRegistry.listTeamIds().length;
  } catch {
    return 0;
  }
}

#countFoundrySessions() {
  const store = this.foundryStore;
  if (!store || typeof store.listSessions !== 'function') return 0;
  try {
    return store.listSessions().length;
  } catch {
    return 0;
  }
}

async #buildReopenContext() {
  // Placeholder — implemented incrementally in steps below.
  return { teamId: 'TODO', teamName: 'TODO', isRunning: false, lastActiveAt: null };
}
```

(Substitute the actual method names on `teamConfigRegistry` and `foundryStore` — verify them by reading those files first. If `listTeamIds` doesn't exist, find the equivalent method.)

- [ ] **Step 2.5: Run — verify the fresh test passes**

Run: `cd C:/Project-TOAD/toad-local && node test/localToolFacade.test.js 2>&1 | tail -10`
Expected: the fresh test passes. Other tests still pass.

- [ ] **Step 2.6: Add a failing test for `half_foundried`**

```js
test('project_state_describe returns half_foundried when only foundry_sessions has rows', async () => {
  const { facade, foundryStore } = makeTestFacade();
  foundryStore.createSession({ title: 'Test plan' });
  const result = await facade.execute({
    commandName: COMMANDS.PROJECT_STATE_DESCRIBE,
    actor: { teamId: 'system', agentId: 'ui-client', role: 'human' },
    args: {},
  });
  assert.equal(result.state, 'half_foundried');
  assert.equal(result.teamConfigs, 0);
  assert.equal(result.foundrySessions, 1);
  assert.equal(result.reopenContext, undefined);
});
```

- [ ] **Step 2.7: Run — verify pass**

The handler from step 2.4 already covers this case. Run: `node test/localToolFacade.test.js`. Expected: pass.

- [ ] **Step 2.8: Add a failing test for `has_team` with reopenContext shape**

```js
test('project_state_describe returns has_team with reopenContext when a team exists', async () => {
  const { facade, foundryStore, teamConfigRegistry, taskBoard } = makeTestFacade();
  // Seed: one team, one task event, no runtime running.
  teamConfigRegistry.saveTeamConfig({
    teamId: 'demo-team',
    displayName: 'Demo Team',
    config: { /* minimal valid config */ },
  });
  taskBoard.appendEvent({
    teamId: 'demo-team',
    taskId: 't1',
    eventType: 'task_create',
    actorId: 'user',
    payload: { subject: 'Wire OAuth' },
  });

  const result = await facade.execute({
    commandName: COMMANDS.PROJECT_STATE_DESCRIBE,
    actor: { teamId: 'system', agentId: 'ui-client', role: 'human' },
    args: {},
  });
  assert.equal(result.state, 'has_team');
  assert.equal(result.teamConfigs, 1);
  assert.ok(result.reopenContext);
  assert.equal(result.reopenContext.teamId, 'demo-team');
  assert.equal(result.reopenContext.isRunning, false);
  assert.ok(result.reopenContext.lastTask, 'reopenContext.lastTask should be populated');
  assert.equal(result.reopenContext.lastTask.subject, 'Wire OAuth');
});
```

(Adjust seed helpers and method names to match the actual taskBoard / teamConfigRegistry API. Read those files first if unfamiliar.)

- [ ] **Step 2.9: Run — verify fail**

The placeholder `#buildReopenContext` returns `{ teamId: 'TODO', ... }`, so the team-id assertion fails.

- [ ] **Step 2.10: Implement `#buildReopenContext`**

Replace the placeholder with the full implementation:

```js
async #buildReopenContext() {
  const team = this.#pickMostRecentTeam();
  if (!team) {
    // Shouldn't happen — caller already verified teamConfigs > 0 — but
    // be defensive in case of race or corrupted state.
    return { teamId: 'unknown', teamName: 'unknown', isRunning: false, lastActiveAt: null };
  }
  const lastTask = this.#getLastTouchedTask(team.teamId);
  const lastDrift = this.#getLastDriftRun(team.teamId);
  const lastCommit = await this.#getLastCommitSafely();
  const isRunning = this.#isAnyRuntimeRunning(team.teamId);

  return {
    teamId: team.teamId,
    teamName: team.displayName || team.teamId,
    isRunning,
    lastActiveAt: lastTask?.createdAt ?? null,
    lastTask: lastTask ? {
      taskId: lastTask.taskId,
      subject: lastTask.subject,
      status: lastTask.status,
    } : undefined,
    lastDriftScore: lastDrift ? {
      teamScore: lastDrift.teamScore,
      status: lastDrift.status,
      runId: lastDrift.runId,
      createdAt: lastDrift.createdAt,
    } : undefined,
    lastCommit: lastCommit || undefined,
  };
}

#pickMostRecentTeam() {
  // Query teams + their most-recent task_event timestamp; pick the
  // top one. Falls back to oldest team if nobody has touched any task.
  const db = this.teamConfigRegistry?.db || this.taskBoard?.db || null;
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT t.team_id AS teamId, t.display_name AS displayName,
             MAX(te.created_at) AS lastEventAt, t.created_at AS teamCreatedAt
      FROM teams t
      LEFT JOIN task_events te ON te.team_id = t.team_id
      GROUP BY t.team_id
      ORDER BY lastEventAt DESC NULLS LAST, teamCreatedAt ASC
      LIMIT 1
    `).get();
    return row || null;
  } catch {
    return null;
  }
}

#getLastTouchedTask(teamId) {
  if (!this.taskBoard || typeof this.taskBoard.listEvents !== 'function') return null;
  try {
    // Get all events for the team, fold into task state, return the
    // most-recently-touched task. taskBoard.projectTask() does this for
    // a single task — we need it for "most recent."
    const events = this.taskBoard.listEvents({ teamId });
    if (!events || events.length === 0) return null;
    // Sort newest first, find the first event with a non-empty taskId,
    // then project that task to get its current state.
    const sorted = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const newest = sorted.find((e) => typeof e.taskId === 'string' && e.taskId.length > 0);
    if (!newest) return null;
    const task = this.taskBoard.projectTask({ teamId, taskId: newest.taskId });
    if (!task) return null;
    return {
      taskId: task.taskId,
      subject: task.subject,
      status: task.status,
      createdAt: newest.createdAt,
    };
  } catch {
    return null;
  }
}

#getLastDriftRun(teamId) {
  // The drift store lives on this.driftStore (if injected) OR is
  // accessible via the drift db. Use whichever path the facade
  // already has wired.
  const driftStore = this.driftStore;
  if (!driftStore || typeof driftStore.listHistory !== 'function') return null;
  try {
    const history = driftStore.listHistory({ teamId, limit: 1 });
    if (!history || history.length === 0) return null;
    const row = history[0];
    return {
      teamScore: row.teamScore ?? row.team_score,
      status: row.status,
      runId: row.runId ?? row.run_id,
      createdAt: row.createdAt ?? row.created_at,
    };
  } catch {
    return null;
  }
}

async #getLastCommitSafely() {
  // Best-effort `git log -1`. Returns null on any failure so the routing
  // decision doesn't get blocked by a missing git repo.
  if (!this.projectCwd) return null;
  try {
    const { runGit } = await import('../git/runGit.js');
    const result = await runGit({
      cwd: this.projectCwd,
      args: ['log', '-1', '--pretty=format:%H%n%s%n%aI'],
      timeoutMs: 3_000,
    });
    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') return null;
    const lines = result.stdout.split('\n');
    if (lines.length < 2) return null;
    return {
      sha: lines[0].trim(),
      message: lines[1].trim(),
      authoredAt: (lines[2] || '').trim() || null,
    };
  } catch {
    return null;
  }
}

#isAnyRuntimeRunning(teamId) {
  const reg = this.runtimeRegistry;
  if (!reg || typeof reg.listRuntimes !== 'function') return false;
  try {
    const runtimes = reg.listRuntimes({ teamId });
    return runtimes.some((r) => r.status === 'running');
  } catch {
    return false;
  }
}
```

**Verification reminder**: before pasting these, **read the actual method signatures** on `teamConfigRegistry`, `taskBoard`, `driftStore`, and `runtimeRegistry`. If any method name differs (e.g., `listRuntimes()` takes no args), adapt. The shape of the implementation matters — exact method names should match reality.

- [ ] **Step 2.11: Run — verify has_team test passes**

Run: `cd C:/Project-TOAD/toad-local && node test/localToolFacade.test.js 2>&1 | tail -10`
Expected: all 3 new tests pass.

- [ ] **Step 2.12: Add tests for the runtime-running / drift / git fallbacks**

Add these tests (4 more):

```js
test('project_state_describe.isRunning is true when at least one runtime is status=running', async () => {
  const { facade, teamConfigRegistry, runtimeRegistry } = makeTestFacade();
  teamConfigRegistry.saveTeamConfig({ teamId: 'demo-team', displayName: 'Demo', config: {} });
  runtimeRegistry.registerRuntime({
    runtimeId: 'rt1', teamId: 'demo-team', agentId: 'lead',
    providerId: 'anthropic', command: 'claude', argsJson: [], cwd: '.', envJson: {},
    deliveryMode: 'stdin', status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const result = await facade.execute({
    commandName: COMMANDS.PROJECT_STATE_DESCRIBE,
    actor: { teamId: 'system', agentId: 'ui', role: 'human' },
    args: {},
  });
  assert.equal(result.reopenContext.isRunning, true);
});

test('project_state_describe.isRunning is false when all runtimes are status=stopped', async () => {
  const { facade, teamConfigRegistry, runtimeRegistry } = makeTestFacade();
  teamConfigRegistry.saveTeamConfig({ teamId: 'demo-team', displayName: 'Demo', config: {} });
  runtimeRegistry.registerRuntime({
    runtimeId: 'rt1', teamId: 'demo-team', agentId: 'lead',
    providerId: 'anthropic', command: 'claude', argsJson: [], cwd: '.', envJson: {},
    deliveryMode: 'stdin', status: 'stopped', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const result = await facade.execute({
    commandName: COMMANDS.PROJECT_STATE_DESCRIBE,
    actor: { teamId: 'system', agentId: 'ui', role: 'human' },
    args: {},
  });
  assert.equal(result.reopenContext.isRunning, false);
});

test('project_state_describe picks most-recently-touched team when multiple teams exist', async () => {
  const { facade, teamConfigRegistry, taskBoard } = makeTestFacade();
  teamConfigRegistry.saveTeamConfig({ teamId: 'team-old', displayName: 'Old', config: {} });
  teamConfigRegistry.saveTeamConfig({ teamId: 'team-new', displayName: 'New', config: {} });
  taskBoard.appendEvent({
    teamId: 'team-old', taskId: 't-old', eventType: 'task_create', actorId: 'u',
    payload: { subject: 'Old work' }, idempotencyKey: 'iko',
  });
  // Newer event for team-new
  await new Promise((r) => setTimeout(r, 10));
  taskBoard.appendEvent({
    teamId: 'team-new', taskId: 't-new', eventType: 'task_create', actorId: 'u',
    payload: { subject: 'New work' }, idempotencyKey: 'ikn',
  });
  const result = await facade.execute({
    commandName: COMMANDS.PROJECT_STATE_DESCRIBE,
    actor: { teamId: 'system', agentId: 'ui', role: 'human' },
    args: {},
  });
  assert.equal(result.reopenContext.teamId, 'team-new');
});

test('project_state_describe.lastCommit is undefined when git fails', async () => {
  // Construct facade with a projectCwd that's NOT a git repo (e.g., a
  // temp dir or :memory:). The runGit call should error; the handler
  // should swallow it and omit lastCommit.
  const { facade, teamConfigRegistry } = makeTestFacade({ projectCwd: ':memory:' });
  teamConfigRegistry.saveTeamConfig({ teamId: 't', displayName: 't', config: {} });
  const result = await facade.execute({
    commandName: COMMANDS.PROJECT_STATE_DESCRIBE,
    actor: { teamId: 'system', agentId: 'ui', role: 'human' },
    args: {},
  });
  assert.equal(result.state, 'has_team');
  assert.equal(result.reopenContext.lastCommit, undefined);
});
```

- [ ] **Step 2.13: Run all the tests**

Run: `cd C:/Project-TOAD/toad-local && node test/localToolFacade.test.js 2>&1 | tail -15`
Expected: all new tests pass. (If the most-recent-team test is flaky on timing, bump the sleep to 50ms.)

- [ ] **Step 2.14: Run the full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: every suite green.

- [ ] **Step 2.15: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/tools/localToolFacade.js test/localToolFacade.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): project_state_describe facade handler

Read-only query of the loaded project's lifecycle state. Returns one
of three states (fresh / half_foundried / has_team) plus a
reopenContext block with the team's last activity (last task, last
drift score, last commit, isRunning) when a team exists.

Multi-team handling: picks the team with most-recent task_events,
ties broken by team creation order. Documented in the spec.

git log is best-effort — failures (no git repo, command unavailable)
omit lastCommit but don't block the routing decision.

7 tests cover fresh / half_foundried / has_team / isRunning true /
isRunning false / multi-team selection / git-fails fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: App.tsx routing — consume `project_state_describe`

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 3.1: Add `reopenContext` state + type**

In `ui/src/App.tsx`, near the other useState calls in `AppInner`, add:

```ts
interface ReopenContext {
  teamId: string;
  teamName: string;
  isRunning: boolean;
  lastActiveAt: string | null;
  lastTask?: { taskId: string; subject: string; status: string };
  lastDriftScore?: { teamScore: number; status: string; runId: string; createdAt: string };
  lastCommit?: { sha: string; message: string; authoredAt: string | null };
}

const [reopenContext, setReopenContext] = useState<ReopenContext | null>(null);
```

(Move the interface to `@/types` if the project conventionally separates them — read `ui/src/types/index.ts` to see.)

- [ ] **Step 3.2: Replace the first-run-redirect useEffect**

Find the existing block:

```ts
const firstRunRedirectDone = useRef(false);
useEffect(() => {
  if (firstRunRedirectDone.current) return;
  firstRunRedirectDone.current = true;
  if (!tweaks.firstRunComplete && projectRegistry.projects.length === 0) {
    if (tweaks.screen !== 'foundry' && tweaks.screen !== 'settings') {
      setTweak('screen', 'foundry');
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

Replace with:

```ts
const firstRunRedirectDone = useRef(false);
useEffect(() => {
  if (firstRunRedirectDone.current) return;
  firstRunRedirectDone.current = true;
  void (async () => {
    try {
      const state = await callToadApi({
        actor: { teamId: 'system', agentId: 'ui-client', role: 'human' },
        method: 'project_state_describe',
      }) as { state: 'has_team' | 'half_foundried' | 'fresh'; reopenContext?: ReopenContext };
      setReopenContext(state.reopenContext ?? null);
      if (state.state === 'has_team' && state.reopenContext) {
        setActiveTeamId(state.reopenContext.teamId);
        if (tweaks.screen !== 'settings') setTweak('screen', 'cockpit');
      } else if (state.state === 'half_foundried') {
        if (tweaks.screen !== 'settings') setTweak('screen', 'foundry');
      } else if (!tweaks.firstRunComplete) {
        // fresh + first-run user → Foundry with welcome banner
        if (tweaks.screen !== 'foundry' && tweaks.screen !== 'settings') {
          setTweak('screen', 'foundry');
        }
      }
      // Otherwise: fresh + returning user → respect last-stored screen.
    } catch (err) {
      // Sidecar offline / call failed — fall back to existing first-run
      // behaviour so the UI doesn't soft-lock.
      // eslint-disable-next-line no-console
      console.warn('[app] project_state_describe failed; falling back to first-run logic:', err);
      if (!tweaks.firstRunComplete && projectRegistry.projects.length === 0) {
        if (tweaks.screen !== 'foundry' && tweaks.screen !== 'settings') {
          setTweak('screen', 'foundry');
        }
      }
    }
  })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

- [ ] **Step 3.3: Pass `reopenContext` to CockpitScreen**

Find the `<CockpitScreen ... />` JSX block. Add a new prop:

```tsx
<CockpitScreen
  // ... existing props
  reopenContext={reopenContext}
  onResumeTeam={() => {
    if (!reopenContext?.teamId) return;
    void callToadApi({
      actor: { teamId: reopenContext.teamId, agentId: 'ui-client', role: 'human' },
      method: 'team_launch',
      args: { teamId: reopenContext.teamId },
      idempotencyKey: `resume-${reopenContext.teamId}-${Date.now()}`,
    })
      .then(() => refresh())
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[app] team_launch (resume) failed:', err);
      });
  }}
/>
```

- [ ] **Step 3.4: Typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: both clean. (Until Task 4 adds the props to CockpitScreen, typecheck will error here — that's the next step. Run-and-defer typecheck verification to Task 4 if you want a cleaner sequence; otherwise quickly add stub `reopenContext?: any` to CockpitScreenProps to unblock.)

- [ ] **Step 3.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/App.tsx
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): App.tsx routes by project_state_describe on mount

Single call to the new backend tool on first mount; result drives
routing:
- state=has_team    → Cockpit, with reopenContext lifted to AppInner
- state=half_foundried → Foundry (existing sessions visible)
- state=fresh + !firstRunComplete → Foundry with welcome banner
- state=fresh + returning user → respect last-stored screen

reopenContext is passed through to CockpitScreen along with an
onResumeTeam callback that wires to team_launch. SSE refresh after
resume picks up the runtime_started events.

Falls back to the existing first-run logic if the call errors
(sidecar offline etc.) so the UI doesn't soft-lock.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: CockpitScreen — paused header + context tiles

**Files:**
- Modify: `ui/src/components/CockpitScreen.tsx`

- [ ] **Step 4.1: Read existing CockpitScreen props**

Run: `grep -n "CockpitScreenProps\|export function CockpitScreen" "C:/Project-TOAD/toad-local/ui/src/components/CockpitScreen.tsx" | head -5`

Read the interface block — note the existing prop shape.

- [ ] **Step 4.2: Add `reopenContext` + `onResumeTeam` to the props interface**

Add to `CockpitScreenProps`:

```ts
/** Context block from project_state_describe — present when this
 *  Cockpit was reached via reopen-flow. Drives the paused-team header.
 *  Null on fresh projects or normal navigation. */
reopenContext?: {
  teamId: string;
  teamName: string;
  isRunning: boolean;
  lastActiveAt: string | null;
  lastTask?: { taskId: string; subject: string; status: string };
  lastDriftScore?: { teamScore: number; status: string; runId: string; createdAt: string };
  lastCommit?: { sha: string; message: string; authoredAt: string | null };
} | null;

/** Called when the user clicks "Resume team" in the paused header.
 *  Parent wires this to the team_launch MCP tool. */
onResumeTeam?: () => void;
```

- [ ] **Step 4.3: Destructure the new props in the component signature**

Add to the destructure list (along with the existing props):

```ts
reopenContext = null,
onResumeTeam,
```

- [ ] **Step 4.4: Add a `resuming` state for the button**

```ts
const [resuming, setResuming] = useState(false);
```

(Useful for disabling the button + showing a "Resuming…" label during the network round-trip.)

- [ ] **Step 4.5: Render the paused header**

At the top of the Cockpit render output (above existing chrome but inside the main container), add:

```tsx
{reopenContext && !reopenContext.isRunning && (
  <header className="cockpit-paused-header">
    <div className="cockpit-paused-summary">
      <span className="cockpit-paused-eyebrow">Team paused</span>
      <h2>{reopenContext.teamName}</h2>
      {reopenContext.lastActiveAt && (
        <span className="dim">
          Last active {formatRelativeTime(reopenContext.lastActiveAt)}
        </span>
      )}
    </div>
    <button
      type="button"
      className="btn btn-primary"
      disabled={resuming}
      onClick={() => {
        if (!onResumeTeam) return;
        setResuming(true);
        onResumeTeam();
        // The header will hide automatically once SSE updates flip
        // isRunning. Reset resuming after a short timeout so the
        // button label doesn't stick if the SSE round-trip is slow.
        window.setTimeout(() => setResuming(false), 4000);
      }}
    >
      {resuming ? 'Resuming…' : 'Resume team'}
    </button>
    <div className="cockpit-paused-context">
      {reopenContext.lastTask && (
        <div className="cockpit-paused-tile">
          <span className="eyebrow">Last task</span>
          <span>{reopenContext.lastTask.subject}</span>
          <span className="dim">{reopenContext.lastTask.status}</span>
        </div>
      )}
      {reopenContext.lastDriftScore && (
        <div className="cockpit-paused-tile">
          <span className="eyebrow">Last drift</span>
          <span>{reopenContext.lastDriftScore.teamScore}/100</span>
          <span className="dim">{reopenContext.lastDriftScore.status}</span>
        </div>
      )}
      {reopenContext.lastCommit && (
        <div className="cockpit-paused-tile">
          <span className="eyebrow">Last commit</span>
          <span className="mono">{reopenContext.lastCommit.sha.slice(0, 7)}</span>
          <span className="dim">{reopenContext.lastCommit.message.slice(0, 60)}</span>
        </div>
      )}
    </div>
  </header>
)}
```

- [ ] **Step 4.6: Add `formatRelativeTime` helper**

Search the project first: `grep -rn "formatRelative\|relativeTime" "C:/Project-TOAD/toad-local/ui/src/" | head`. If a helper already exists, import it. Otherwise add a small one at the bottom of `CockpitScreen.tsx`:

```ts
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const deltaSec = Math.floor((Date.now() - t) / 1000);
  if (deltaSec < 60) return 'just now';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
```

- [ ] **Step 4.7: Typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 4.8: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/components/CockpitScreen.tsx
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): CockpitScreen paused header + context tiles

When CockpitScreen receives a reopenContext prop and the team has no
running runtimes, render a header above the normal chrome showing:

- Team name + "Team paused" eyebrow + relative timestamp of last
  activity.
- A primary Resume button that calls the onResumeTeam parent
  callback (wires to team_launch).
- Three context tiles (last task, last drift score, last commit)
  populated from reopenContext. Each tile is conditional on its
  data being present.

The header auto-hides once isRunning flips true via SSE updates.
The button has a transient "Resuming…" state on click to bridge
the network round-trip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CSS — `.cockpit-paused-header` and friends

**Files:**
- Modify: `ui/src/styles/app-shell.css`

- [ ] **Step 5.1: Find the existing Cockpit-related styles**

Run: `grep -n "\.cockpit" "C:/Project-TOAD/toad-local/ui/src/styles/app-shell.css" | head -10`

Note where the existing cockpit selectors live so the new ones can sit alongside them.

- [ ] **Step 5.2: Add the paused-header selectors**

Append (or place near other `.cockpit-*` rules):

```css
.cockpit-paused-header {
  margin: 16px 20px;
  padding: 16px 20px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 16px;
  row-gap: 12px;
}

.cockpit-paused-summary {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cockpit-paused-eyebrow {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  color: var(--fg-dim);
}

.cockpit-paused-summary h2 {
  margin: 0;
  font-size: 16px;
  line-height: 1.2;
  color: var(--fg);
}

.cockpit-paused-header > .btn {
  align-self: start;
}

.cockpit-paused-context {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.cockpit-paused-tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 120px;
  flex: 1 1 auto;
  max-width: 280px;
}
```

- [ ] **Step 5.3: Visual smoke**

Hard-refresh the browser if dev server is running and look at the new paused header (you'll need to be in a reopen state for it to render — Task 6 covers manual smoke). For this step, just confirm the CSS parses with no errors via lint.

Run: `cd C:/Project-TOAD/toad-local/ui && npm run lint 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 5.4: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/styles/app-shell.css
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): styles for cockpit-paused-header + context tiles

Grid-based layout with team-name + last-activity in column 1, Resume
button in column 2, and a context-tile row spanning both columns
underneath. Dashed border signals "not a normal state — your team is
paused." Tile container is flex-wrap so 1-3 tiles all look good
regardless of which context fields are populated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual smoke tests (USER-DRIVEN)

The UI tier has no test framework — these are the gates before declaring done.

- [ ] **Step 6.1: Restart sidecar to pick up backend changes**

Run `C:/Project-TOAD/restart-dev.bat` (or Ctrl+C + `npm run api:dev` manually).

- [ ] **Step 6.2: Smoke — fresh project**

In Symphony, switch to a fresh folder (no `.toad/` directory).
Expected: lands on Foundry with welcome banner (existing F.1 behavior preserved).

- [ ] **Step 6.3: Smoke — half-foundried project**

Create a folder, run a Foundry session in it (start typing a plan), then switch away. Switch back.
Expected: lands on Foundry, prior session visible in the sidebar. No welcome banner.

- [ ] **Step 6.4: Smoke — project with existing team**

Use the seeded `symphony-demo` team in `toad-local/`'s own `.toad/toad.db` (already populated from earlier screenshot capture). Switch Symphony to that folder.
Expected:
- Lands on Cockpit immediately.
- Top of Cockpit shows "Team paused — symphony-demo — Last active [time]".
- Three context tiles visible: last task ("Wire OAuth..."), last drift score, last commit.
- Resume team button enabled.

- [ ] **Step 6.5: Smoke — Resume team flow**

Click "Resume team."
Expected:
- Button transitions to "Resuming…" briefly.
- SSE runtime_started events flow in (visible in the sidecar terminal or via runtimes badge).
- Paused header disappears, normal Cockpit chrome shows.
- (Runtimes may stay in 'launching' state for a few seconds depending on CLI startup — that's fine.)

- [ ] **Step 6.6: Smoke — re-reopen after pause**

Stop the team (existing Pause team button if available, or kill the sidecar). Reload the page or switch projects + back.
Expected: paused header re-appears with updated `lastActiveAt`.

- [ ] **Step 6.7: Smoke — graceful API failure fallback**

Stop the sidecar. Reload the UI.
Expected: UI doesn't soft-lock. Existing API-not-reachable banner shows. If no projects + !firstRunComplete, lands on Foundry as before. (No project_state_describe call succeeds, but the fallback path in App.tsx covers this.)

- [ ] **Step 6.8: Document results**

If all 6 pass, the slice is ready to ship. Paste anything weird back to the controller.

---

## Task 7: Final verification + ship marker

- [ ] **Step 7.1: Full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 7.2: UI typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7.3: Confirm commit chain**

Run: `git -C C:/Project-TOAD/toad-local log --oneline -15`
Expected: 5 task commits above the M.1a spec commit.

- [ ] **Step 7.4: Ship marker**

```bash
git -C C:/Project-TOAD/toad-local commit --allow-empty -m "$(cat <<'EOF'
ship(maintenance): slice M.1a — reopen project flow

Users opening Symphony on an existing project (folder with .toad/toad.db
populated with at least one team) now route directly to Cockpit in a
paused state with a Resume CTA, instead of being forced through
Foundry discovery again. Cockpit's paused header surfaces last
activity context (last task, last drift score, last commit) so reopen
feels like resuming, not restarting.

Implementation:
- New read-only MCP tool project_state_describe returns state
  (fresh / half_foundried / has_team) + reopenContext block.
- App.tsx calls it once on mount; routes per state.
- CockpitScreen renders a paused header when reopenContext is
  present and isRunning is false. Resume button wires to existing
  team_launch.
- No schema migrations; rides on existing team_configs, task_events,
  drift_score_history, runtime_instances tables.

Sets up M.1b (bug-fix task type) and M.1c (drift retargeting) as
follow-on slices.

Closes M.1a of the post-F.2 maintenance roadmap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

- [x] Spec coverage: every architecture component (1-6 in spec) has a corresponding task.
- [x] No placeholders: every step has concrete code or commands.
- [x] Type consistency: `reopenContext` shape is identical in spec, backend response, App.tsx state, and CockpitScreen props.
- [x] Order is correct: backend (commands → MCP schema → handler) before UI (routing → component → CSS). Smoke and ship last.
- [x] TDD where applicable: backend handler has 7 tests with explicit failing-first cycles. UI follows existing typecheck+lint+manual-smoke convention.
- [x] Each task ends with a commit so reverts are granular.
- [x] Manual smoke is explicit because UI has no test framework — 6 scenarios documented in Task 6.
- [x] Graceful fallback documented when project_state_describe fails (Task 3 step 3.2 + Task 6 step 6.7).
