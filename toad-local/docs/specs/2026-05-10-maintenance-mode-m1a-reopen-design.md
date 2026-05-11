# Maintenance Mode Slice M.1a — Reopen Project Flow — Design

**Date:** 2026-05-10
**Slice:** M.1a of the post-F.2 Maintenance roadmap (first of three: M.1a reopen → M.1b bug-fix task type → M.1c drift retargeting).

---

## Goal

When a user opens Symphony pointed at an existing project (a folder with a populated `.toad/toad.db`), Symphony detects that a team is already configured and routes the user directly to Cockpit in a "paused" state — without making them re-run Foundry discovery. The user sees what their team was last working on and clicks **Resume team** when they're ready to spawn the agent processes again.

The whole experience should feel like "I'm back, here's where I left off," not "let me set this up again."

## Non-goals

- **Bug-fix task type** (M.1b — separate slice).
- **Drift retargeting against current state** (M.1c — separate slice).
- **Per-project last-screen restoration** (polish — deferred).
- **Multi-team picker UI** (polish — current behavior: pick the most-recently-touched team).
- **"Reopen recent project" tile in welcome screen** (polish — deferred).
- **Cockpit context-strip clickthrough behavior** (polish — strip is read-only in M.1a).
- **Auto-resume on reopen** (deliberate choice: Resume is explicit per Q3 brainstorm).

---

## Architecture

Two pieces:

1. **New MCP tool `project_state_describe`** — reads from the loaded `.toad/toad.db` and returns the project's lifecycle state plus a reopen-context block. App.tsx calls this once after project switch / app mount to decide routing.
2. **Cockpit paused-state header + context strip** — when the chosen team has zero running runtimes, Cockpit shows a "Team paused — last active [timestamp]. [Resume team]" header with context tiles (last task, last drift score, last commit). The Resume button wires to the existing `team_launch` MCP tool.

No schema migrations. No changes to Foundry session storage. No new tables. The whole slice rides on existing data and adds one read-only MCP tool plus a UI affordance.

## Components

### 1. `project_state_describe` MCP tool — `src/tools/localToolFacade.js` (NEW method)

Read-only tool. No idempotency key needed (pure read).

**Response shape:**

```ts
{
  state: 'has_team' | 'half_foundried' | 'fresh',
  teamConfigs: number,
  foundrySessions: number,
  // Reopen-context block, populated when state === 'has_team'.
  // Pulled from existing tables; nullable fields when data isn't available.
  reopenContext?: {
    teamId: string,                // most-recently-touched team if multiple
    teamName: string,
    isRunning: boolean,            // any runtime currently in 'running' state?
    lastActiveAt: string | null,   // most recent task_events.created_at ISO timestamp
    lastTask?: { taskId: string, subject: string, status: string },
    lastDriftScore?: { teamScore: number, status: string, runId: string, createdAt: string },
    lastCommit?: { sha: string, message: string, authoredAt: string },
  },
}
```

**State determination logic:**

```js
async #projectStateDescribe(args) {
  const teamConfigsCount = this.#countTeamConfigs();
  const foundrySessionsCount = this.#countFoundrySessions();

  if (teamConfigsCount === 0 && foundrySessionsCount === 0) {
    return { state: 'fresh', teamConfigs: 0, foundrySessions: 0 };
  }
  if (teamConfigsCount === 0) {
    return { state: 'half_foundried', teamConfigs: 0, foundrySessions: foundrySessionsCount };
  }

  // has_team — pick the most-recently-touched team and gather reopen context.
  const team = this.#pickMostRecentTeam();
  const lastTask = this.#getLastTouchedTask(team.teamId);
  const lastDrift = this.#getLastDriftRun(team.teamId);
  const lastCommit = await this.#getLastCommitSafely(team); // best-effort; null on error
  const isRunning = this.#runtimeIsRunningForTeam(team.teamId);

  return {
    state: 'has_team',
    teamConfigs: teamConfigsCount,
    foundrySessions: foundrySessionsCount,
    reopenContext: {
      teamId: team.teamId,
      teamName: team.displayName || team.teamId,
      isRunning,
      lastActiveAt: lastTask?.createdAt ?? null,
      lastTask: lastTask ? { taskId: lastTask.taskId, subject: lastTask.subject, status: lastTask.status } : undefined,
      lastDriftScore: lastDrift ? { teamScore: lastDrift.teamScore, status: lastDrift.status, runId: lastDrift.runId, createdAt: lastDrift.createdAt } : undefined,
      lastCommit: lastCommit || undefined,
    },
  };
}
```

**Most-recently-touched team selection:**

```sql
SELECT t.team_id, t.display_name, MAX(te.created_at) AS last_event_at
FROM teams t
LEFT JOIN task_events te ON te.team_id = t.team_id
GROUP BY t.team_id
ORDER BY last_event_at DESC NULLS LAST
LIMIT 1
```

Documented behavior: when multiple teams exist, the one with the most recent `task_events` row wins. Ties broken by team creation order (older first — stable).

**Last commit lookup:**

Uses the existing `runGit` helper (already in `src/git/runGit.js`) to call `git log -1 --pretty=format:%H%n%s%n%aI` against the project cwd. Wrapped in try/catch — returns `null` on error (not a git repo, command fails, etc.). Don't let git issues block the routing decision.

### 2. App.tsx routing changes — `ui/src/App.tsx`

Replace the current first-run-redirect useEffect with one that consults `project_state_describe`:

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
      });
      // Cache the result for downstream components (Cockpit reads it for
      // the paused-state header).
      setReopenContext(state.reopenContext ?? null);

      if (state.state === 'has_team') {
        setTweak('screen', 'cockpit');
        setActiveTeamId(state.reopenContext.teamId);
      } else if (state.state === 'half_foundried') {
        setTweak('screen', 'foundry');
      } else if (!tweaks.firstRunComplete) {
        setTweak('screen', 'foundry');
      } else {
        // Fresh project, returning user — empty cockpit is fine.
        setTweak('screen', 'cockpit');
      }
    } catch (err) {
      // If the call fails (no sidecar, etc.), fall back to existing
      // first-run logic so we don't soft-lock the UI.
      if (!tweaks.firstRunComplete && projectRegistry.projects.length === 0) {
        setTweak('screen', 'foundry');
      }
    }
  })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

New top-level state `reopenContext` lives on the AppInner component and is passed as a prop to CockpitScreen.

The picker redirect (returning-user-no-projects case) stays unchanged; it fires in its own useEffect that depends on `tweaks.firstRunComplete` and `projectRegistry.projects.length`.

### 3. CockpitScreen paused header — `ui/src/components/CockpitScreen.tsx`

New top-of-screen header block, rendered only when `reopenContext != null && !reopenContext.isRunning`:

```tsx
<header className="cockpit-paused-header">
  <div className="cockpit-paused-summary">
    <span className="cockpit-paused-eyebrow">Team paused</span>
    <h2>{reopenContext.teamName}</h2>
    {reopenContext.lastActiveAt && (
      <span className="dim">
        Last active {formatRelative(reopenContext.lastActiveAt)}
      </span>
    )}
  </div>
  <button
    type="button"
    className="btn btn-primary"
    disabled={resuming}
    onClick={() => void resumeTeam(reopenContext.teamId)}
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
```

The `resumeTeam` callback calls the existing `team_launch` MCP tool with the persisted team config. On success, `isRunning` flips to true via runtime SSE events and the header re-renders without the paused chrome.

**Visibility rule:**

- `reopenContext == null`: don't render (fresh project or no team).
- `reopenContext != null && reopenContext.isRunning`: don't render (team is actively running — show normal Cockpit).
- `reopenContext != null && !reopenContext.isRunning`: render the paused header.

When the user navigates away and back to Cockpit within the same session, the header continues to show until they click Resume. We don't re-poll `project_state_describe` mid-session — the initial response sticks until project switch / app reload.

### 4. CSS — `ui/src/styles/app-shell.css`

New `.cockpit-paused-header`, `.cockpit-paused-summary`, `.cockpit-paused-eyebrow`, `.cockpit-paused-context`, `.cockpit-paused-tile` selectors. Layout: flex row with the Resume button on the right, summary + context tiles flowing left-to-right. Visual: matches the existing Cockpit eyebrow/heading style. Subtle dashed-border treatment on the container to signal "this isn't a normal state — your team is paused."

### 5. MCP schema — `src/mcp/localToolDefinitions.js`

Add `project_state_describe` as a new MCP tool definition. No required args, no idempotency key.

### 6. Command contract — `src/commands/command-contract.js`

Register `PROJECT_STATE_DESCRIBE` constant + dispatch entry.

---

## Data flow

```
User opens Symphony pointed at C:/Projects/meal-planner (has .toad/toad.db)
  └─> Tauri shell respawns sidecar with TOAD_PROJECT_CWD=C:/Projects/meal-planner
        └─> sidecar boots; SQLite opens C:/Projects/meal-planner/.toad/toad.db
              └─> UI mounts; first-run effect fires once
                    └─> callTool({ method: 'project_state_describe' })
                          └─> facade reads team_configs, foundry_sessions
                                └─> finds team_configs[0] = 'meal-planner-team'
                                      └─> reads last task_event (status='in_progress')
                                            └─> reads last drift_score_history row
                                                  └─> runs `git log -1` in cwd
                                                        └─> returns:
                                                            { state: 'has_team',
                                                              reopenContext: {
                                                                teamId: 'meal-planner-team',
                                                                isRunning: false,
                                                                lastActiveAt: '...',
                                                                lastTask: { subject: 'Wire OAuth', ... },
                                                                lastDriftScore: { score: 87, ... },
                                                                lastCommit: { sha: 'abc1234', message: '...' },
                                                              }
                                                            }
                    └─> App.tsx routes to Cockpit, stashes reopenContext, sets activeTeamId
                          └─> CockpitScreen renders paused header + context tiles
                                └─> user clicks Resume team
                                      └─> calls team_launch (existing tool)
                                            └─> runtimes spawn → SSE 'runtime_started' events
                                                  └─> isRunning flips true (via useToadData re-fetch)
                                                        └─> paused header hides → normal Cockpit chrome shows
```

## Error handling

- **`project_state_describe` HTTP failure** (sidecar offline / crashed): App.tsx falls back to the existing first-run logic so the UI doesn't soft-lock. Banner shows the API error.
- **Team launch fails on Resume click**: existing `team_launch` error path surfaces (toast / banner). Button re-enables; user can retry.
- **`git log` fails** during reopen context gathering (not a git repo, permission denied, etc.): `lastCommit` is omitted from response. Other context tiles still render. Routing decision unaffected.
- **`team_configs` exists but is corrupted JSON**: the existing read path in `sqliteTeamConfigRegistry` throws. `project_state_describe` wraps the call in try/catch — falls back to `state: 'fresh'` if the read errors. Defensive; rare in practice.
- **Multiple teams with no recent task_events**: ordering picks the team with `MAX(created_at)` falling back to team-creation timestamp. Stable.

## Testing

Backend tests (TDD):

- `test/localToolFacade.test.js` — extend with `project_state_describe` coverage:
  - Returns `state: 'fresh'` when both tables empty.
  - Returns `state: 'half_foundried'` when foundry_sessions has rows but team_configs is empty.
  - Returns `state: 'has_team'` with reopenContext when team_configs has at least one row.
  - Multi-team scenario: picks the team with most recent task_events.
  - Returns `null` for lastCommit when git fails (mock `runGit` to throw).
  - Returns proper `isRunning: false` when no runtime_instances are status='running'.
  - Returns `isRunning: true` when at least one runtime row is status='running'.

- `test/localMcpToolDefinitions.test.js` — verify `project_state_describe` is registered with correct schema (no required args, response type defined).

UI side (typecheck + lint + manual smoke per existing UI convention):

- Manual smoke checklist documented in plan:
  1. Open a fresh folder → lands on Foundry with welcome banner (existing F.1 behavior preserved).
  2. Open a half-foundried project → lands on Foundry without banner, prior sessions visible.
  3. Open a project with a team → lands on Cockpit with paused header showing team name, last activity, context tiles.
  4. Click Resume team → paused header transitions out, normal Cockpit chrome appears, runtime SSE events flow in.
  5. Reopen the same project after pausing → paused header re-appears with updated context.
  6. Switch between two projects (each with a team) → routing re-evaluates correctly for each.

## What this slice does NOT change

- Foundry behavior on fresh projects — unchanged.
- First-run welcome banner — unchanged (still fires only on `state === 'fresh' && !firstRunComplete`).
- `team_launch` / `team_stop` MCP tools — unchanged.
- SSE runtime events — unchanged.
- Cockpit's normal (non-paused) chrome — unchanged.
- The project picker UI — unchanged for now (future polish slice can add per-project status indicators).

## What this slice unblocks

- **M.1b (bug-fix task type)** — can now assume "user reopened project to fix a bug" is a real flow with a place to land (Cockpit paused header). Add-task affordance gets a "task type" dropdown.
- **M.1c (drift retargeting)** — drift's "compare against original spec" assumption breaks once users are doing maintenance work. Reopen state surfaces this clearly: a reopened team probably wants drift compared against current main, not the original brief.
- **Polish slice**: project picker tiles showing "[active]" / "[paused]" / "[fresh]" status — uses the same `project_state_describe` call.

---

## References

- F.1 spec: `docs/specs/2026-05-09-foundry-slice-f1-cli-migration-design.md`
- F.2 spec: `docs/specs/2026-05-10-foundry-slice-f2-provider-aware-design.md`
- First-run onboarding spec: `docs/specs/2026-05-09-first-run-onboarding-design.md` (where the firstRunComplete tweak originates)
- FUTURE-IDEAS.md "Maintenance mode" entry — original three-piece brief.
- `src/storage/schema.sql` — `team_configs`, `foundry_sessions`, `task_events`, `runtime_instances`, `drift_score_history` tables.
- `src/task/sqliteTaskBoard.js` — event-sourced task store (used by reopenContext.lastTask lookup).
- `src/git/runGit.js` — git invocation helper (used by reopenContext.lastCommit lookup).
- `src/runtime/sqliteRuntimeRegistry.js` — runtime status read (used for `isRunning`).
