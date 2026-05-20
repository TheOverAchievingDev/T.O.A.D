import { runGit as defaultRunGit } from '../git/runGit.js';
import { getBranchProtection } from '../github/githubApi.js';
import { evaluateRemoteMergePolicy, parseGithubRemote } from './remoteMergePolicy.js';

/**
 * Build the `{ evaluate }` collaborator that LocalToolFacade uses for the
 * §19 follow-up branch-protection gate. Wires together:
 *   - `git remote get-url origin`  → owner/repo
 *   - settingsStore                → stored GitHub access token
 *   - `getBranchProtection`        → REST call with bound token
 *
 * Returns null only if the caller passes a falsy `settingsStore` (degraded
 * setup); otherwise always returns an object whose `evaluate` is safe to
 * call. The `evaluate` method itself returns an `{ allow, reason }` verdict
 * for every input — no thrown exceptions.
 */
export function buildRemoteMergePolicy({
  projectCwd,
  settingsStore,
  githubFetch = null,
  runGit = defaultRunGit,
} = {}) {
  if (!settingsStore || typeof settingsStore.readEffective !== 'function') {
    return null;
  }

  return {
    async evaluate({ baseBranch, taskBranch }) {
      const remoteResult = runGit(['remote', 'get-url', 'origin'], { cwd: projectCwd });
      if (!remoteResult || remoteResult.exitCode !== 0) {
        return { allow: true, reason: 'no_origin_remote' };
      }
      const parsed = parseGithubRemote((remoteResult.stdout || '').trim());
      if (!parsed) {
        return { allow: true, reason: 'origin_not_github' };
      }

      let merged;
      try {
        merged = await settingsStore.readEffective();
      } catch {
        return { allow: true, reason: 'settings_read_failed' };
      }
      const token = merged?.github?.accessToken;
      if (typeof token !== 'string' || token.length === 0) {
        return { allow: true, reason: 'github_not_connected' };
      }

      return evaluateRemoteMergePolicy({
        baseBranch,
        owner: parsed.owner,
        repo: parsed.repo,
        getProtection: ({ owner, repo, branch }) =>
          getBranchProtection({ token, owner, repo, branch, fetchImpl: githubFetch }),
      });
    },
  };
}
