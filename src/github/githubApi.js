/**
 * §3c GitHub REST API client. Sibling to githubAuth.js — that file gets a
 * token, this file uses it. fetchImpl is injectable for tests; production
 * callers default to globalThis.fetch.
 */

export const GITHUB_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'TOAD-Local/0.1';

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is not available; pass fetchImpl explicitly');
  }
  return globalThis.fetch;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function authHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };
}

function jsonAuthHeaders(token) {
  return { ...authHeaders(token), 'Content-Type': 'application/json' };
}

/**
 * GET /repos/{owner}/{repo}. Returns normalized repo metadata.
 *
 * Soft errors (401/403/404) come back as { ok: false, status }. Hard errors
 * (5xx, network) throw so callers can decide whether to retry.
 *
 * @returns {Promise<
 *   | { ok: true, repo: NormalizedRepo }
 *   | { ok: false, status: number }
 * >}
 */
export async function getRepository({ token, owner, repo, fetchImpl } = {}) {
  requireString(token, 'token');
  requireString(owner, 'owner');
  requireString(repo, 'repo');
  const fetcher = fetchImpl || defaultFetch();

  const response = await fetcher(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    method: 'GET',
    headers: authHeaders(token),
  });

  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { ok: false, status: response.status };
  }
  if (!response.ok) {
    throw new Error(`getRepository: HTTP ${response.status}`);
  }

  const json = await response.json();
  return {
    ok: true,
    repo: {
      id: json.id ?? null,
      name: json.name ?? null,
      fullName: json.full_name ?? null,
      private: json.private === true,
      defaultBranch: json.default_branch ?? null,
      htmlUrl: json.html_url ?? null,
      visibility: json.visibility ?? null,
      description: json.description ?? null,
      fork: json.fork === true,
      archived: json.archived === true,
      disabled: json.disabled === true,
      license: json.license
        ? {
            key: json.license.key ?? null,
            name: json.license.name ?? null,
            spdxId: json.license.spdx_id ?? null,
          }
        : null,
      permissions: json.permissions
        ? {
            admin: json.permissions.admin === true,
            push: json.permissions.push === true,
            pull: json.permissions.pull === true,
          }
        : null,
    },
  };
}

/**
 * GET /repos/{owner}/{repo}/branches/{branch}/protection. Returns a
 * normalized "what would block a direct push" view rather than the raw
 * GitHub shape, so the merge-integrator can decide policy without
 * pattern-matching on optional nested keys.
 *
 * Important behavior: GitHub returns 404 for unprotected branches. We
 * convert that to `{ ok: true, protected: false }` because "not protected"
 * is a normal answer, not an error. Real auth/permission failures stay as
 * `{ ok: false, status }`.
 *
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       protected: boolean,
 *       requiresPullRequest: boolean,
 *       requiredApprovingReviewCount: number | null,
 *       requiresStatusChecks: boolean,
 *       requiredStatusCheckContexts: string[],
 *       enforceAdmins: boolean,
 *       allowForcePushes: boolean,
 *       allowDeletions: boolean,
 *       requiresLinearHistory: boolean,
 *       hasPushRestrictions: boolean,
 *     }
 *   | { ok: false, status: number }
 * >}
 */
export async function getBranchProtection({ token, owner, repo, branch, fetchImpl } = {}) {
  requireString(token, 'token');
  requireString(owner, 'owner');
  requireString(repo, 'repo');
  requireString(branch, 'branch');
  const fetcher = fetchImpl || defaultFetch();

  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`;
  const response = await fetcher(url, { method: 'GET', headers: authHeaders(token) });

  if (response.status === 404) {
    // GitHub uses 404 to signal "branch is not protected" — that's a
    // legitimate answer, not an error.
    return {
      ok: true,
      protected: false,
      requiresPullRequest: false,
      requiredApprovingReviewCount: null,
      requiresStatusChecks: false,
      requiredStatusCheckContexts: [],
      enforceAdmins: false,
      allowForcePushes: true,
      allowDeletions: true,
      requiresLinearHistory: false,
      hasPushRestrictions: false,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status };
  }
  if (!response.ok) {
    throw new Error(`getBranchProtection: HTTP ${response.status}`);
  }

  const json = await response.json();
  const prReviews = json.required_pull_request_reviews;
  const statusChecks = json.required_status_checks;
  const restrictions = json.restrictions;

  return {
    ok: true,
    protected: true,
    requiresPullRequest: !!prReviews,
    requiredApprovingReviewCount:
      prReviews && typeof prReviews.required_approving_review_count === 'number'
        ? prReviews.required_approving_review_count
        : null,
    requiresStatusChecks: !!statusChecks,
    requiredStatusCheckContexts:
      statusChecks && Array.isArray(statusChecks.contexts) ? statusChecks.contexts : [],
    enforceAdmins: !!(json.enforce_admins && json.enforce_admins.enabled),
    allowForcePushes: !!(json.allow_force_pushes && json.allow_force_pushes.enabled),
    allowDeletions: !!(json.allow_deletions && json.allow_deletions.enabled),
    requiresLinearHistory: !!(json.required_linear_history && json.required_linear_history.enabled),
    hasPushRestrictions: !!restrictions,
  };
}

/**
 * POST /repos/{owner}/{repo}/pulls. First *write* action — creates a pull
 * request from `head` (task branch, optionally `owner:branch` for cross-fork)
 * into `base`. Surfaces 422 validation errors as a structured object so the
 * UI can show the actual reason ("PR already exists", "branch not pushed",
 * etc.) — these are caller-actionable, not retriable.
 *
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       pr: {
 *         id: number, number: number, state: string, title: string, body: string|null,
 *         htmlUrl: string, draft: boolean, merged: boolean,
 *         head: { ref: string, sha: string },
 *         base: { ref: string, sha: string },
 *         user: { login: string|null } | null,
 *       }
 *     }
 *   | { ok: false, status: 422, message: string, errors: Array<{ resource?: string, code?: string, message?: string, field?: string }> }
 *   | { ok: false, status: 401 | 403 | 404 }
 * >}
 */
export async function createPullRequest({
  token,
  owner,
  repo,
  head,
  base,
  title,
  body = null,
  draft = false,
  fetchImpl,
} = {}) {
  requireString(token, 'token');
  requireString(owner, 'owner');
  requireString(repo, 'repo');
  requireString(head, 'head');
  requireString(base, 'base');
  requireString(title, 'title');
  const fetcher = fetchImpl || defaultFetch();

  const payload = { head, base, title };
  if (typeof body === 'string' && body.length > 0) payload.body = body;
  if (draft === true) payload.draft = true;

  const response = await fetcher(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: jsonAuthHeaders(token),
    body: JSON.stringify(payload),
  });

  if (response.status === 422) {
    // Validation error — surface the GitHub reason verbatim. Callers
    // typically want to display this to the human (head not pushed,
    // PR already exists, etc.).
    let json;
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    return {
      ok: false,
      status: 422,
      message: typeof json.message === 'string' ? json.message : 'Validation Failed',
      errors: Array.isArray(json.errors)
        ? json.errors.map((e) => ({
            resource: e.resource ?? null,
            code: e.code ?? null,
            message: e.message ?? null,
            field: e.field ?? null,
          }))
        : [],
    };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { ok: false, status: response.status };
  }
  if (!response.ok) {
    throw new Error(`createPullRequest: HTTP ${response.status}`);
  }

  const json = await response.json();
  return {
    ok: true,
    pr: {
      id: json.id ?? null,
      number: json.number ?? null,
      state: json.state ?? null,
      title: json.title ?? null,
      body: json.body ?? null,
      htmlUrl: json.html_url ?? null,
      draft: json.draft === true,
      merged: json.merged === true,
      head: json.head
        ? { ref: json.head.ref ?? null, sha: json.head.sha ?? null }
        : null,
      base: json.base
        ? { ref: json.base.ref ?? null, sha: json.base.sha ?? null }
        : null,
      user: json.user ? { login: json.user.login ?? null } : null,
    },
  };
}

/**
 * POST /user/repos. Creates a new repository on GitHub under the
 * authenticated user. Returns clone URLs the caller can use to wire up an
 * `origin` remote on a local git repo.
 *
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       repo: {
 *         name: string, fullName: string, private: boolean,
 *         htmlUrl: string, cloneUrl: string, sshUrl: string,
 *         defaultBranch: string,
 *       }
 *     }
 *   | { ok: false, status: 422, message: string, errors: Array<object> }
 *   | { ok: false, status: number }
 * >}
 */
export async function createRepository({
  token,
  name,
  description = null,
  private: isPrivate = true,
  autoInit = false,
  fetchImpl,
} = {}) {
  requireString(token, 'token');
  requireString(name, 'name');
  const fetcher = fetchImpl || defaultFetch();

  const payload = { name, private: isPrivate === true };
  if (typeof description === 'string' && description.length > 0) payload.description = description;
  if (autoInit === true) payload.auto_init = true;

  const response = await fetcher(`${GITHUB_API_BASE}/user/repos`, {
    method: 'POST',
    headers: jsonAuthHeaders(token),
    body: JSON.stringify(payload),
  });

  if (response.status === 422) {
    let json;
    try { json = await response.json(); } catch { json = {}; }
    return {
      ok: false,
      status: 422,
      message: typeof json.message === 'string' ? json.message : 'Validation Failed',
      errors: Array.isArray(json.errors) ? json.errors : [],
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status };
  }
  if (!response.ok) {
    throw new Error(`createRepository: HTTP ${response.status}`);
  }

  const json = await response.json();
  return {
    ok: true,
    repo: {
      name: json.name ?? name,
      fullName: json.full_name ?? null,
      private: json.private === true,
      htmlUrl: json.html_url ?? null,
      cloneUrl: json.clone_url ?? null,
      sshUrl: json.ssh_url ?? null,
      defaultBranch: json.default_branch ?? 'main',
    },
  };
}
