# Merge Integration — Checklist §19 slice 2

Date: 2026-05-01
Status: in progress

Builds on §19 slice 1 (conflict gate). Today the orchestrator only verifies the merge is feasible; the operator does the actual integration by hand. After this slice, the orchestrator advances `task.baseBranch` to a new merge commit when a task transitions `merge_ready → done`.

## Goal

The `merge_ready → done` transition becomes the actual integration step, not just a feasibility check. After the human-approval gate (§14) and the conflict gate (§19.1) pass, TOAD performs:

```
git merge-tree --write-tree --merge-base=<base> <baseBranch> <taskBranch>
git commit-tree <tree> -p <baseTip> -p <taskTip> -m "Merge ..."
git update-ref refs/heads/<baseBranch> <new-commit> <expected-old>
```

This is **non-destructive**:
- HEAD is never touched
- The working directory is never modified
- The user's currently-checked-out branch (which may be `baseBranch` itself) keeps its working copy
- Only the branch ref advances atomically

The user sees the merge land on `baseBranch` next time they `git fetch` / `git status` / look at log.

## Why this approach

The naive approach — `git checkout baseBranch && git merge && git checkout -` — would:
- Fail when the user has uncommitted changes in their HEAD checkout
- Race against the user's editor / dev server / file watchers
- Be visibly destructive even when it works

`merge-tree --write-tree` + `commit-tree` + `update-ref` runs entirely in `.git/objects` and modifies only `.git/refs/heads/<baseBranch>`. Worst case if interrupted: an orphaned tree/commit object that `git gc` cleans up. The branch ref is updated atomically by `update-ref` with optimistic concurrency (`<expected-old>` arg).

`git merge-tree --write-tree` requires git ≥ 2.38 (October 2022). Diagnostics already detected git 2.51 on this machine; the rest of the team config can declare a min-git in §25 later.

## Behavior

Fires when:
- `fromStatus === 'merge_ready'` AND `args.status === 'done'`
- task has `worktree.status === 'created'` AND `worktree.branch` set
- task has `baseBranch` set (operator declared it at `task_create`; otherwise this slice no-ops with a `skipped` event)
- `mergeIntegrator` is configured on the facade
- (the existing conflict gate already ran clean by the time we get here)

Skips (with audit event, but transition succeeds — back-compat for non-git workspaces) when:
- `not_in_git_repo`, `task_branch_not_found`, `base_branch_not_found`, `no_common_ancestor`

Fails the transition (throws, blocks `done`) when:
- `git merge-tree` reports conflicts (would have been caught by §19.1, but if races happen)
- `git update-ref` fails the optimistic-concurrency check (someone advanced `baseBranch` while we were classifying)
- `git commit-tree` fails (filesystem error, malformed tree)

## Event schema

```js
TASK_EVENT_TYPES.INTEGRATION_MERGED = 'task.integration_merged'
```

Payload (success):

```js
{
  status: 'merged',
  baseBranch: 'main',
  mergeCommit: '<sha>',
  parents: ['<base-tip-before>', '<task-tip>'],
  mergedAt: '<iso>',
}
```

Payload (skipped — best-effort, lifecycle continues):

```js
{
  status: 'skipped',
  reason: 'not_in_git_repo' | 'task_branch_not_found' | 'base_branch_not_found' | 'no_common_ancestor',
  stderr?: string,
}
```

## Projection

```js
task.integration = {
  status: 'merged' | 'skipped' | null,   // null = never attempted
  baseBranch: string | null,
  mergeCommit: string | null,
  parents: string[] | null,
  mergedAt: string | null,
  reason: string | null,                 // populated when skipped
}
```

Initial value `null` so existing tasks stay backward-compatible.

## Module

`src/task/mergeIntegrator.js` exporting `integrate({ projectCwd, taskBranch, baseBranch, taskSubject, runGit })`. Returns the payload shape above. Pure: no event emission, just runs git and reports.

## Wiring

`LocalToadRuntime` auto-instantiates the integrator when `projectCwd` is set (same pattern as `worktreeManager` and `mergeChecker`). Facade gets `mergeIntegrator` constructor option.

## Order of gates in `#taskUpdate` for `merge_ready → done`

1. Existing conflict gate (slice 1) — bails on conflict/error.
2. Existing human-approval gate (§14) — bails when `requiresHumanApproval && !humanApproval.approved`.
3. **NEW: integration step** — runs the actual merge. On failure (commit-tree, update-ref), throws and blocks `done`. On `skipped`, emits the event and lets the transition through.
4. STATUS_CHANGED is appended.
5. Existing worktree-removal hook (slice 3) runs.

The integration step happens BEFORE the worktree removal so we still have the task branch pointing at a known commit for the merge. The worktree removal then deletes the worktree directory but the branch lives on (slice 3 already preserves it) — and now there's an actual merge commit on `baseBranch` that points back to the task branch as its second parent.

## TDD plan

1. `mergeIntegrator` unit tests (8): success, missing baseBranch (skipped), missing taskBranch (skipped), no common ancestor (skipped), conflict in merge-tree, commit-tree failure, update-ref failure (optimistic concurrency), validates inputs.
2. Projection test: `INTEGRATION_MERGED` populates `task.integration`.
3. Facade integration tests (4): success path advances baseBranch and emits event; missing baseBranch on task → skip event but transition succeeds; integrator throw → transition blocked; ordering — integration runs after human-approval gate.
4. Runtime test: `LocalToadRuntime` auto-instantiates the integrator with `projectCwd`.

## Out of scope

- Pushing to remote (operator does this manually).
- Detecting force-pushes / rewrites of baseBranch since baseRef.
- Rebase strategy (slice 3+).
- Squash merges.
- Updating dependency tasks' baseRef when a parent merges (cascade slice).
