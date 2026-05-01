# Worktree per Task — Checklist §8 (slice 1)

Slice: 2026-05-01
Status: in progress

Maps to: **§8** of `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`. Builds on the plan-before-code gate (§2) and state machine (§3) so that worktree creation has a clean trigger point. Gates §7 finished diff tracking and §19 merge workflow.

## Goal

When a task transitions `ready → planned` (which the plan-before-code gate already requires an approved plan for), the orchestrator creates an isolated git worktree on a task-scoped branch. The task projection records the worktree path so future slices can:

- enforce that `agent_launch` for the task uses the worktree as `cwd` (§8 second half),
- compute diffs against the base ref (§7 finished),
- merge the task branch back to the base ref on `merge_ready → done` (§19),
- remove the worktree on `done` / `rejected` cleanup (§8 third half).

This first slice covers **creation + projection only**. Cwd enforcement, removal, and merge integration come in follow-up slices.

## Design

### Worktree path scheme

Deterministic, gitignored:

```
${projectCwd}/.toad/worktrees/${teamId}/${taskId}
```

Predictable so operators (and future restart-recovery) can find them. Lives under `.toad/` which is already gitignored.

### Branch scheme

Each worktree gets its own branch:

```
toad/${teamId}/${taskId}
```

Created from a base ref the task captures at planning time. For now: `HEAD` of the working repo. A future slice will make `task.baseRef` explicit on task creation (part of §1 schema).

### New event types

```js
TASK_EVENT_TYPES.WORKTREE_CREATED = 'task.worktree_created'
TASK_EVENT_TYPES.WORKTREE_REMOVED = 'task.worktree_removed'   // (slice 3)
```

Payload for `WORKTREE_CREATED`:

```js
{
  path: string,           // absolute filesystem path
  branch: string,         // toad/${teamId}/${taskId}
  baseRef: string,        // commit SHA the worktree was created from
  createdAt: string,
}
```

Failure mode: emit `WORKTREE_CREATED` with `{ status: 'skipped', reason: '...' }` payload variant when:
- not in a git repo,
- git binary missing,
- worktree path already exists with conflicting branch.

The state machine does NOT block planning when worktree creation is skipped — that would lock non-git users out of the system entirely. Skipped events still land in the audit trail.

### Task projection

```js
task.worktree = {
  status: 'created' | 'skipped',
  path?: string,
  branch?: string,
  baseRef?: string,
  createdAt?: string,
  reason?: string,        // populated when status === 'skipped'
}
```

### New module: `src/git/runGit.js`

Tiny wrapper. Synchronous (worktree creation is on the critical path of a state transition). Returns `{ exitCode, stdout, stderr }`.

```js
runGit(args, { cwd }) → { exitCode, stdout, stderr }
```

Tests inject a fake. Default uses `spawnSync('git', args, { cwd, ...})`.

### New module: `src/task/worktreeManager.js`

Pure-ish — given `runGit`, `projectCwd`, `teamId`, `taskId`, plans and runs the right sequence:

1. `git rev-parse --is-inside-work-tree` → if exit != 0, return `{ status: 'skipped', reason: 'not_in_git_repo' }`.
2. `git rev-parse HEAD` → capture baseRef.
3. Compute `path = ${projectCwd}/.toad/worktrees/${teamId}/${taskId}` and `branch = toad/${teamId}/${taskId}`.
4. If `path` exists, return `{ status: 'skipped', reason: 'path_exists' }`. (Idempotent re-creation handled by checking projection first; this is just a safety belt.)
5. `git worktree add -b ${branch} ${path} ${baseRef}` — on failure, return `{ status: 'skipped', reason: 'git_command_failed', stderr }`.
6. Return `{ status: 'created', path, branch, baseRef, createdAt }`.

### Facade integration

`LocalToolFacade` constructor gains optional `worktreeManager` (defaults to `null` — feature-flagged opt-in). When set, `#taskUpdate` after the state transition validates and the existing CI gates pass:

- if the new status is `planned` AND `task.worktree?.status !== 'created'` (idempotent), call `worktreeManager.createForTask({ teamId, taskId })`,
- append a `WORKTREE_CREATED` event with the result (`status: 'created'` or `status: 'skipped'`) plus the payload,
- the projection picks it up.

If `worktreeManager` is null, the gate is a no-op — preserves backward compat for tests and the legacy command surface.

## TDD plan

Two test files: `test/runGit.test.js` and `test/worktreeManager.test.js`. RED before each GREEN.

`runGit.test.js` (small):
1. Default `runGit` uses spawn — smoke that `git --version` returns exit 0 in the project repo.
2. Custom `spawn` injection passes through args + cwd.

`worktreeManager.test.js`:
1. Skipped when `git rev-parse --is-inside-work-tree` exits non-zero (returns `status: 'skipped', reason: 'not_in_git_repo'`).
2. Skipped when worktree path already exists.
3. Created — runs `git worktree add -b <branch> <path> <baseRef>` with the right args; returns `status: 'created'` with all fields populated.
4. Skipped when `git worktree add` itself fails.

Then a small facade integration test in `localToolFacade.test.js`:
1. `ready → planned` triggers worktree creation; projection picks it up.
2. Facade is robust when `worktreeManager.createForTask` throws (best-effort, like `tool_call_denied`).

## Out of scope (future slices)

- **Cwd enforcement on `agent_launch`** — slice 2 of §8. Reject when caller-supplied cwd disagrees with the task's worktree path.
- **Worktree removal on `done` / `rejected`** — slice 3 of §8. `git worktree remove --force`.
- **Explicit `task.baseRef` on task creation** — part of §1 schema work, will replace "HEAD at planning time" with operator-supplied base ref.
- **Diff computation against baseRef** — §7 finished. Depends on this slice landing.
- **Merge workflow** — §19. Depends on this slice landing.
- **Diagnostics check `worktree_present_per_task`** — wires once we have at least one task in `planned` we can probe.
