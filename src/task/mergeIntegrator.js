import { runGit as defaultRunGit } from '../git/runGit.js';

/**
 * Merge integrator — §19 slice 2. Performs the actual integration commit on
 * `baseBranch` after the conflict gate (slice 1) and human-approval gate (§14)
 * have cleared. Non-destructive: no checkout, no working-directory mutation,
 * just `merge-tree --write-tree` → `commit-tree` → `update-ref` with optimistic
 * concurrency on the `baseBranch` ref.
 *
 * Returns:
 *   { status: 'merged', baseBranch, mergeCommit, parents, mergedAt }
 *   { status: 'skipped', reason: 'not_in_git_repo'|'task_branch_not_found'
 *       |'base_branch_not_found'|'no_common_ancestor', stderr? }
 *   { status: 'error', reason: 'merge_tree_conflict'|'commit_tree_failed'
 *       |'update_ref_failed', stderr }
 *
 * `skipped` lets the lifecycle continue (e.g. non-git workspaces); `error`
 * blocks the transition (the orchestrator throws based on this verdict).
 */
export function integrate({
  projectCwd,
  taskBranch,
  baseBranch,
  taskSubject = '',
  runGit = defaultRunGit,
} = {}) {
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) {
    return { status: 'skipped', reason: 'projectCwd missing' };
  }
  if (typeof taskBranch !== 'string' || taskBranch.length === 0) {
    return { status: 'skipped', reason: 'taskBranch missing' };
  }
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
    return { status: 'skipped', reason: 'baseBranch missing' };
  }

  const baseTipResult = runGit(['rev-parse', `refs/heads/${baseBranch}`], { cwd: projectCwd });
  if (baseTipResult.exitCode !== 0) {
    return { status: 'skipped', reason: 'base_branch_not_found', stderr: baseTipResult.stderr };
  }
  const baseTip = baseTipResult.stdout.trim();

  const taskTipResult = runGit(['rev-parse', `refs/heads/${taskBranch}`], { cwd: projectCwd });
  if (taskTipResult.exitCode !== 0) {
    return { status: 'skipped', reason: 'task_branch_not_found', stderr: taskTipResult.stderr };
  }
  const taskTip = taskTipResult.stdout.trim();

  const mergeBaseResult = runGit(['merge-base', baseTip, taskTip], { cwd: projectCwd });
  if (mergeBaseResult.exitCode !== 0) {
    return { status: 'skipped', reason: 'no_common_ancestor', stderr: mergeBaseResult.stderr };
  }
  const mergeBase = mergeBaseResult.stdout.trim();

  // git ≥ 2.38: write-tree mode produces the merged tree SHA on success or
  // exits non-zero on conflict.
  const treeResult = runGit(
    ['merge-tree', '--write-tree', `--merge-base=${mergeBase}`, baseTip, taskTip],
    { cwd: projectCwd },
  );
  if (treeResult.exitCode !== 0) {
    return {
      status: 'error',
      reason: 'merge_tree_conflict',
      stderr: treeResult.stderr || treeResult.stdout || 'merge-tree reported conflict',
    };
  }
  const tree = treeResult.stdout.trim();

  const message = taskSubject && taskSubject.length > 0
    ? `Merge task branch ${taskBranch}\n\n${taskSubject}`
    : `Merge task branch ${taskBranch}`;

  // Parent order: base FIRST so `git log <baseBranch>` keeps the linear
  // first-parent history of the integration branch.
  const commitResult = runGit(
    ['commit-tree', tree, '-p', baseTip, '-p', taskTip, '-m', message],
    { cwd: projectCwd },
  );
  if (commitResult.exitCode !== 0) {
    return {
      status: 'error',
      reason: 'commit_tree_failed',
      stderr: commitResult.stderr || 'commit-tree failed',
    };
  }
  const mergeCommit = commitResult.stdout.trim();

  // Optimistic concurrency: 4-arg form requires baseTip to still be the
  // current value of refs/heads/<baseBranch>. If someone advanced it while
  // we were classifying, this fails and we surface that to the caller.
  const updateResult = runGit(
    ['update-ref', `refs/heads/${baseBranch}`, mergeCommit, baseTip],
    { cwd: projectCwd },
  );
  if (updateResult.exitCode !== 0) {
    return {
      status: 'error',
      reason: 'update_ref_failed',
      stderr: updateResult.stderr || 'update-ref failed',
    };
  }

  return {
    status: 'merged',
    baseBranch,
    mergeCommit,
    parents: [baseTip, taskTip],
    mergedAt: new Date().toISOString(),
  };
}
