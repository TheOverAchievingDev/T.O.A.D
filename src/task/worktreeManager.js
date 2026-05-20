import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGit as defaultRunGit } from '../git/runGit.js';

/**
 * Worktree-per-task manager. Implements the creation half of checklist §8.
 *
 * `createForTask({ teamId, taskId })` returns one of:
 *   { status: 'created', path, branch, baseRef, createdAt }
 *   { status: 'skipped', reason: 'not_in_git_repo' | 'path_exists' | 'git_command_failed', stderr? }
 *
 * Skipped variants are not failures — they're recorded as audit events so
 * non-git users (and edge cases like existing worktrees) don't block the
 * state machine. The orchestrator hooks this into `ready → planned`.
 */
export class WorktreeManager {
  constructor({ projectCwd, runGit = defaultRunGit, fsExistsSync = existsSync } = {}) {
    if (typeof projectCwd !== 'string' || projectCwd.length === 0) {
      throw new TypeError('projectCwd must be a non-empty string');
    }
    this.projectCwd = projectCwd;
    this.runGit = runGit;
    this.fsExistsSync = fsExistsSync;
  }

  worktreePathFor({ teamId, taskId }) {
    return join(this.projectCwd, '.toad', 'worktrees', teamId, taskId);
  }

  branchNameFor({ teamId, taskId }) {
    return `toad/${teamId}/${taskId}`;
  }

  createForTask({ teamId, taskId, baseRef: explicitBaseRef = null }) {
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new TypeError('teamId must be a non-empty string');
    }
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new TypeError('taskId must be a non-empty string');
    }

    const inRepo = this.runGit(['rev-parse', '--is-inside-work-tree'], { cwd: this.projectCwd });
    if (inRepo.exitCode !== 0) {
      return { status: 'skipped', reason: 'not_in_git_repo' };
    }

    // §8 slice 4: prefer the operator-supplied baseRef. Falls back to
    // rev-parse HEAD only when the task didn't capture one at creation time.
    let baseRef;
    if (typeof explicitBaseRef === 'string' && explicitBaseRef.length > 0) {
      baseRef = explicitBaseRef;
    } else {
      const headResult = this.runGit(['rev-parse', 'HEAD'], { cwd: this.projectCwd });
      if (headResult.exitCode !== 0) {
        return {
          status: 'skipped',
          reason: 'git_command_failed',
          stderr: headResult.stderr || 'rev-parse HEAD failed',
        };
      }
      baseRef = headResult.stdout.trim();
    }

    const path = this.worktreePathFor({ teamId, taskId });
    const branch = this.branchNameFor({ teamId, taskId });

    if (this.fsExistsSync(path)) {
      return { status: 'skipped', reason: 'path_exists' };
    }

    const addResult = this.runGit(
      ['worktree', 'add', '-b', branch, path, baseRef],
      { cwd: this.projectCwd },
    );
    if (addResult.exitCode !== 0) {
      return {
        status: 'skipped',
        reason: 'git_command_failed',
        stderr: addResult.stderr || 'worktree add failed',
      };
    }

    return {
      status: 'created',
      path,
      branch,
      baseRef,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Remove the worktree for a completed task. Returns one of:
   *   { status: 'removed', path, removedAt }
   *   { status: 'skipped', reason: 'git_command_failed', stderr }
   *
   * `git worktree remove --force` deletes the worktree directory and detaches
   * its administrative entry. The branch itself (`toad/${teamId}/${taskId}`)
   * is preserved so the merge commit / history is still reachable from the
   * mainline ref. A future cleanup tool can prune the branch separately.
   */
  removeForTask({ teamId, taskId }) {
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new TypeError('teamId must be a non-empty string');
    }
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new TypeError('taskId must be a non-empty string');
    }
    const path = this.worktreePathFor({ teamId, taskId });
    const result = this.runGit(['worktree', 'remove', '--force', path], { cwd: this.projectCwd });
    if (result.exitCode !== 0) {
      return {
        status: 'skipped',
        reason: 'git_command_failed',
        stderr: result.stderr || 'worktree remove failed',
      };
    }
    return {
      status: 'removed',
      path,
      removedAt: new Date().toISOString(),
    };
  }
}
