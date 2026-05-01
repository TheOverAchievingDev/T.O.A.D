import { runGit as defaultRunGit } from '../git/runGit.js';

/**
 * Compute the diff between a worktree's HEAD and its baseRef. Implements the
 * "finished" half of checklist §7 — the orchestrator computes the diff itself
 * rather than trusting whatever the agent passes in.
 *
 * Returns:
 *   { diff: string, files: string[] }            — on success
 *   { diff: null, files: [], error: string }      — on failure (caller decides
 *                                                   whether to fall back to a
 *                                                   passed-in diff or skip)
 *
 * The function is best-effort: a missing worktree, bad baseRef, or git failure
 * returns an `error` field rather than throwing. Caller (the facade) handles
 * the fallback policy.
 */
export function computeDiff({ worktreePath, baseRef, runGit = defaultRunGit } = {}) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    return { diff: null, files: [], error: 'worktreePath must be a non-empty string' };
  }
  if (typeof baseRef !== 'string' || baseRef.length === 0) {
    return { diff: null, files: [], error: 'baseRef must be a non-empty string' };
  }

  const range = `${baseRef}..HEAD`;
  const namesResult = runGit(['diff', range, '--name-only'], { cwd: worktreePath });
  if (namesResult.exitCode !== 0) {
    return {
      diff: null,
      files: [],
      error: namesResult.stderr || 'git diff --name-only failed',
    };
  }
  const files = namesResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const diffResult = runGit(['diff', range], { cwd: worktreePath });
  if (diffResult.exitCode !== 0) {
    return {
      diff: null,
      files,
      error: diffResult.stderr || 'git diff failed',
    };
  }
  return { diff: diffResult.stdout, files };
}
