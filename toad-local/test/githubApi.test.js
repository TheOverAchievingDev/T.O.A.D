import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRepository,
  getBranchProtection,
  createPullRequest,
  GITHUB_API_BASE,
} from '../src/github/githubApi.js';

function makeMockFetch(handler) {
  return async (url, init) => handler({ url, init });
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = JSON.stringify(body);
  const headersObj = {
    get(name) {
      const k = name.toLowerCase();
      for (const [hk, hv] of Object.entries(headers)) {
        if (hk.toLowerCase() === k) return hv;
      }
      return null;
    },
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersObj,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

test('getRepository hits /repos/{owner}/{repo} with bearer token and returns normalized fields', async () => {
  let captured;
  const fetchImpl = makeMockFetch(({ url, init }) => {
    captured = { url, init };
    return jsonResponse({
      id: 12345,
      name: 'toad',
      full_name: 'kaydenraquel/toad',
      private: false,
      default_branch: 'main',
      html_url: 'https://github.com/kaydenraquel/toad',
      visibility: 'public',
      description: 'Local-first multi-agent CLI orchestrator',
      fork: false,
      archived: false,
      disabled: false,
      license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
      permissions: { admin: true, push: true, pull: true },
    });
  });

  const result = await getRepository({
    token: 'ghs_token123',
    owner: 'kaydenraquel',
    repo: 'toad',
    fetchImpl,
  });

  assert.equal(captured.url, `${GITHUB_API_BASE}/repos/kaydenraquel/toad`);
  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.headers.Authorization, 'Bearer ghs_token123');
  assert.equal(captured.init.headers.Accept, 'application/vnd.github+json');
  assert.equal(captured.init.headers['X-GitHub-Api-Version'], '2022-11-28');

  assert.equal(result.ok, true);
  assert.equal(result.repo.fullName, 'kaydenraquel/toad');
  assert.equal(result.repo.defaultBranch, 'main');
  assert.equal(result.repo.private, false);
  assert.equal(result.repo.visibility, 'public');
  assert.equal(result.repo.htmlUrl, 'https://github.com/kaydenraquel/toad');
  assert.equal(result.repo.archived, false);
  assert.equal(result.repo.license.spdxId, 'MIT');
  assert.deepEqual(result.repo.permissions, { admin: true, push: true, pull: true });
});

test('getRepository returns ok=false on 401 without throwing', async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse({ message: 'Bad credentials' }, { status: 401 }));
  const result = await getRepository({
    token: 'bad',
    owner: 'kaydenraquel',
    repo: 'toad',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('getRepository returns ok=false on 404 without throwing', async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse({ message: 'Not Found' }, { status: 404 }));
  const result = await getRepository({
    token: 'ghs_token',
    owner: 'kaydenraquel',
    repo: 'does-not-exist',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('getRepository throws on unexpected 5xx so callers can retry', async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse({ message: 'oops' }, { status: 503 }));
  await assert.rejects(
    () => getRepository({ token: 't', owner: 'a', repo: 'b', fetchImpl }),
    /HTTP 503/,
  );
});

test('getRepository validates required arguments', async () => {
  await assert.rejects(() => getRepository({ owner: 'a', repo: 'b' }), /token is required/);
  await assert.rejects(() => getRepository({ token: 't', repo: 'b' }), /owner is required/);
  await assert.rejects(() => getRepository({ token: 't', owner: 'a' }), /repo is required/);
});

// --- getBranchProtection -----------------------------------------------------

test('getBranchProtection returns ok=true, protected=true, and normalized requirements', async () => {
  let captured;
  const fetchImpl = makeMockFetch(({ url, init }) => {
    captured = { url, init };
    return jsonResponse({
      url: 'https://api.github.com/repos/o/r/branches/main/protection',
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
      },
      required_status_checks: {
        strict: true,
        contexts: ['ci/build', 'ci/test'],
      },
      enforce_admins: { enabled: true },
      restrictions: { users: [], teams: [], apps: [] },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      required_linear_history: { enabled: true },
    });
  });

  const result = await getBranchProtection({
    token: 'ghs_t',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    fetchImpl,
  });

  assert.equal(captured.url, `${GITHUB_API_BASE}/repos/o/r/branches/main/protection`);
  assert.equal(captured.init.headers.Authorization, 'Bearer ghs_t');
  assert.equal(result.ok, true);
  assert.equal(result.protected, true);
  assert.equal(result.requiresPullRequest, true);
  assert.equal(result.requiredApprovingReviewCount, 2);
  assert.equal(result.requiresStatusChecks, true);
  assert.deepEqual(result.requiredStatusCheckContexts, ['ci/build', 'ci/test']);
  assert.equal(result.enforceAdmins, true);
  assert.equal(result.allowForcePushes, false);
  assert.equal(result.allowDeletions, false);
  assert.equal(result.requiresLinearHistory, true);
  assert.equal(result.hasPushRestrictions, true);
});

test('getBranchProtection returns ok=true, protected=false on 404 (branch is unprotected)', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ message: 'Branch not protected' }, { status: 404 }),
  );
  const result = await getBranchProtection({
    token: 't',
    owner: 'o',
    repo: 'r',
    branch: 'feature',
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.protected, false);
  assert.equal(result.requiresPullRequest, false);
});

test('getBranchProtection returns ok=false on 401 (token rejected)', async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse({ message: 'Bad credentials' }, { status: 401 }));
  const result = await getBranchProtection({
    token: 'bad',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('getBranchProtection treats missing requirement objects as absent', async () => {
  // Some protection configs only enable a subset; we should not crash on
  // missing nested keys.
  const fetchImpl = makeMockFetch(() => jsonResponse({
    url: 'https://api.github.com/repos/o/r/branches/main/protection',
    enforce_admins: { enabled: false },
  }));
  const result = await getBranchProtection({
    token: 't', owner: 'o', repo: 'r', branch: 'main', fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.protected, true);
  assert.equal(result.requiresPullRequest, false);
  assert.equal(result.requiredApprovingReviewCount, null);
  assert.equal(result.requiresStatusChecks, false);
  assert.deepEqual(result.requiredStatusCheckContexts, []);
  assert.equal(result.enforceAdmins, false);
  assert.equal(result.hasPushRestrictions, false);
});

test('getBranchProtection url-encodes branch names with slashes', async () => {
  let captured;
  const fetchImpl = makeMockFetch(({ url }) => {
    captured = url;
    return jsonResponse({ message: 'Branch not protected' }, { status: 404 });
  });
  await getBranchProtection({
    token: 't', owner: 'o', repo: 'r', branch: 'release/2026-q2', fetchImpl,
  });
  assert.equal(captured, `${GITHUB_API_BASE}/repos/o/r/branches/release%2F2026-q2/protection`);
});

test('getBranchProtection validates required arguments', async () => {
  await assert.rejects(() => getBranchProtection({ owner: 'a', repo: 'b', branch: 'm' }), /token is required/);
  await assert.rejects(() => getBranchProtection({ token: 't', repo: 'b', branch: 'm' }), /owner is required/);
  await assert.rejects(() => getBranchProtection({ token: 't', owner: 'a', branch: 'm' }), /repo is required/);
  await assert.rejects(() => getBranchProtection({ token: 't', owner: 'a', repo: 'b' }), /branch is required/);
});

// --- createPullRequest -------------------------------------------------------

test('createPullRequest POSTs to /repos/{owner}/{repo}/pulls and returns the new PR', async () => {
  let captured;
  const fetchImpl = makeMockFetch(({ url, init }) => {
    captured = { url, init };
    return jsonResponse(
      {
        id: 42,
        number: 17,
        state: 'open',
        title: 'Add risk-policy editor',
        body: 'Implements §3d',
        html_url: 'https://github.com/kaydenraquel/toad/pull/17',
        draft: false,
        merged: false,
        head: { ref: 'feat/risk-policy', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        user: { login: 'kaydenraquel' },
      },
      { status: 201 },
    );
  });

  const result = await createPullRequest({
    token: 'ghs_t',
    owner: 'kaydenraquel',
    repo: 'toad',
    head: 'feat/risk-policy',
    base: 'main',
    title: 'Add risk-policy editor',
    body: 'Implements §3d',
    fetchImpl,
  });

  assert.equal(captured.url, `${GITHUB_API_BASE}/repos/kaydenraquel/toad/pulls`);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer ghs_t');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  const sentBody = JSON.parse(captured.init.body);
  assert.equal(sentBody.head, 'feat/risk-policy');
  assert.equal(sentBody.base, 'main');
  assert.equal(sentBody.title, 'Add risk-policy editor');
  assert.equal(sentBody.body, 'Implements §3d');
  assert.equal(sentBody.draft, undefined);

  assert.equal(result.ok, true);
  assert.equal(result.pr.number, 17);
  assert.equal(result.pr.state, 'open');
  assert.equal(result.pr.title, 'Add risk-policy editor');
  assert.equal(result.pr.htmlUrl, 'https://github.com/kaydenraquel/toad/pull/17');
  assert.equal(result.pr.draft, false);
  assert.equal(result.pr.head.ref, 'feat/risk-policy');
  assert.equal(result.pr.base.ref, 'main');
});

test('createPullRequest passes draft=true when requested', async () => {
  let captured;
  const fetchImpl = makeMockFetch(({ url, init }) => {
    captured = { url, init };
    return jsonResponse(
      { id: 1, number: 2, state: 'open', title: 'WIP', html_url: 'h', draft: true,
        head: { ref: 'wip', sha: 'a' }, base: { ref: 'main', sha: 'b' } },
      { status: 201 },
    );
  });
  await createPullRequest({
    token: 't', owner: 'o', repo: 'r', head: 'wip', base: 'main', title: 'WIP', draft: true, fetchImpl,
  });
  const sentBody = JSON.parse(captured.init.body);
  assert.equal(sentBody.draft, true);
});

test('createPullRequest returns ok=false with structured errors on 422 (PR already exists)', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse(
      {
        message: 'Validation Failed',
        errors: [
          {
            resource: 'PullRequest',
            code: 'custom',
            message: 'A pull request already exists for kaydenraquel:feat/risk-policy.',
          },
        ],
        documentation_url: 'https://docs.github.com/...',
      },
      { status: 422 },
    ),
  );
  const result = await createPullRequest({
    token: 't', owner: 'kaydenraquel', repo: 'toad',
    head: 'feat/risk-policy', base: 'main', title: 'x', fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.message, 'Validation Failed');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /already exists/);
});

test('createPullRequest returns ok=false on 401 / 403 / 404 without throwing', async () => {
  for (const status of [401, 403, 404]) {
    const fetchImpl = makeMockFetch(() =>
      jsonResponse({ message: 'Bad' }, { status }),
    );
    const result = await createPullRequest({
      token: 't', owner: 'o', repo: 'r', head: 'h', base: 'main', title: 'x', fetchImpl,
    });
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(result.status, status);
  }
});

test('createPullRequest throws on unexpected 5xx so callers can retry', async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse({ message: 'oops' }, { status: 502 }));
  await assert.rejects(
    () => createPullRequest({
      token: 't', owner: 'o', repo: 'r', head: 'h', base: 'main', title: 'x', fetchImpl,
    }),
    /HTTP 502/,
  );
});

test('createPullRequest validates required arguments', async () => {
  const base = { token: 't', owner: 'o', repo: 'r', head: 'h', base: 'main', title: 'x' };
  await assert.rejects(() => createPullRequest({ ...base, token: undefined }), /token is required/);
  await assert.rejects(() => createPullRequest({ ...base, owner: undefined }), /owner is required/);
  await assert.rejects(() => createPullRequest({ ...base, repo: undefined }), /repo is required/);
  await assert.rejects(() => createPullRequest({ ...base, head: undefined }), /head is required/);
  await assert.rejects(() => createPullRequest({ ...base, base: undefined }), /base is required/);
  await assert.rejects(() => createPullRequest({ ...base, title: undefined }), /title is required/);
});
