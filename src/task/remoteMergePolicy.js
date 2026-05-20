/**
 * §19 follow-up: remote merge policy gate. Two pure functions that let the
 * orchestrator decide whether a local merge into a base branch should
 * proceed, given what GitHub's branch-protection settings say.
 *
 * Design intent: the gate is *advisory* by default — if we can't reach
 * GitHub, can't parse the remote URL, or hit an auth failure, we allow
 * the local merge to proceed and surface the reason in the task event.
 * Only an explicit "this branch is protected AND requires PRs" verdict
 * blocks the transition. This avoids the failure mode where a transient
 * GitHub outage stops every team from completing tasks.
 */

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/**
 * Parse owner/repo from a git remote URL. Handles the four forms `git remote
 * get-url origin` typically returns:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 *
 * Returns null for non-github hosts, malformed input, or anything else we
 * can't confidently parse — callers fall back to "no remote info" verdict.
 */
export function parseGithubRemote(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  const trimmed = url.trim();

  // git@github.com:owner/repo(.git)? — SCP-style SSH, no scheme
  const scpMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (scpMatch) {
    const [, host, owner, repo] = scpMatch;
    if (!GITHUB_HOSTS.has(host.toLowerCase())) return null;
    if (!owner || !repo) return null;
    return { owner, repo };
  }

  // https://, ssh:// — anything else parseable as a URL
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  // Pathname is /owner/repo(.git)?
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  let repo = segments[1];
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Decide whether a local merge into `baseBranch` should proceed given the
 * remote's branch-protection state. `getProtection` is an injected getter
 * (the facade wires it up to call `getBranchProtection` from githubApi.js
 * with the stored token); tests pass fakes.
 *
 * Verdict shape:
 *   { allow: true, reason: <string> }   — proceed with local merge
 *   { allow: false, reason: 'requires_pr', protection: <full payload> }
 *
 * `reason` is informational — included in the INTEGRATION_MERGED event so
 * the UI can show "skipped protection check (auth failed)" vs "merge
 * proceeded (branch unprotected)".
 */
export async function evaluateRemoteMergePolicy({
  baseBranch,
  owner,
  repo,
  getProtection,
} = {}) {
  if (typeof getProtection !== 'function') {
    throw new TypeError('evaluateRemoteMergePolicy: getProtection must be a function');
  }
  if (!baseBranch || !owner || !repo) {
    return { allow: true, reason: 'no_remote_info' };
  }

  let res;
  try {
    res = await getProtection({ owner, repo, branch: baseBranch });
  } catch {
    return { allow: true, reason: 'protection_check_threw' };
  }

  if (!res || res.ok !== true) {
    const status = res && typeof res.status === 'number' ? res.status : 'unknown';
    return { allow: true, reason: `protection_check_failed:${status}` };
  }

  if (res.protected !== true) {
    return { allow: true, reason: 'unprotected' };
  }

  if (res.requiresPullRequest === true) {
    return { allow: false, reason: 'requires_pr', protection: res };
  }

  return { allow: true, reason: 'protected_but_pr_not_required' };
}
