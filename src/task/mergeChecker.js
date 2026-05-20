import { runGit as defaultRunGit } from '../git/runGit.js';

/**
 * Conflict-detection gate for the `merge_ready → done` transition.
 * Implements the first slice of checklist §19 (merge / integration workflow).
 *
 * The orchestrator runs `git merge --no-commit --no-ff <baseRef>` inside the
 * task's worktree, then aborts. If the merge would conflict, the abort still
 * runs (cleaning up the worktree) and the conflicting file list is captured
 * via `git diff --name-only --diff-filter=U`.
 *
 * Returns:
 *   { status: 'clean' }                    — merge would succeed
 *   { status: 'conflict', files: string[] } — listed files have conflicts
 *   { status: 'error', error: string }      — could not test (dirty worktree,
 *                                              git failed, missing inputs).
 *
 * The actual integration commit on `baseBranch` is NOT done here; this slice
 * only verifies the merge is feasible. Slice 2 of §19 will perform the real
 * merge once we have an explicit `baseBranch` per task.
 */
export function checkForConflicts({ worktreePath, baseRef, runGit = defaultRunGit } = {}) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    return { status: 'error', error: 'worktreePath must be a non-empty string' };
  }
  if (typeof baseRef !== 'string' || baseRef.length === 0) {
    return { status: 'error', error: 'baseRef must be a non-empty string' };
  }

  // Refuse to run if the worktree has uncommitted changes — the merge test
  // wouldn't reflect what would actually happen at integration time.
  const statusResult = runGit(['status', '--porcelain'], { cwd: worktreePath });
  if (statusResult.exitCode !== 0) {
    return { status: 'error', error: statusResult.stderr || 'git status failed' };
  }
  if (statusResult.stdout.trim().length > 0) {
    return { status: 'error', error: 'worktree has uncommitted changes' };
  }

  const mergeResult = runGit(['merge', '--no-commit', '--no-ff', baseRef], { cwd: worktreePath });
  if (mergeResult.exitCode === 0) {
    // Clean merge possible. Abort to leave the worktree in pre-merge state.
    runGit(['merge', '--abort'], { cwd: worktreePath });
    return { status: 'clean' };
  }

  // Conflict. Capture the conflicting file list before aborting.
  const conflictFiles = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreePath });
  const files = conflictFiles.exitCode === 0
    ? conflictFiles.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  runGit(['merge', '--abort'], { cwd: worktreePath });
  return { status: 'conflict', files };
}
