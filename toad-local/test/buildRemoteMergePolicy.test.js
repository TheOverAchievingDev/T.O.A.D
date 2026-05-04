import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteMergePolicy } from '../src/task/buildRemoteMergePolicy.js';

function fakeRunGit(behavior) {
  return (args /* , opts */) => {
    if (Array.isArray(args) && args[0] === 'remote' && args[1] === 'get-url') {
      return behavior;
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected git invocation' };
  };
}

function fakeSettingsStore(github) {
  return {
    readEffective: async () => ({ github }),
  };
}

test('buildRemoteMergePolicy returns allow=no_origin_remote when origin lookup fails', async () => {
  const policy = buildRemoteMergePolicy({
    projectCwd: '/repo',
    settingsStore: fakeSettingsStore({ accessToken: 'tok' }),
    githubFetch: async () => assert.fail('fetch should not be called'),
    runGit: fakeRunGit({ exitCode: 128, stdout: '', stderr: 'no origin' }),
  });
  const verdict = await policy.evaluate({ baseBranch: 'main', taskBranch: 'feat' });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'no_origin_remote');
});

test('buildRemoteMergePolicy returns allow=origin_not_github for non-github remotes', async () => {
  const policy = buildRemoteMergePolicy({
    projectCwd: '/repo',
    settingsStore: fakeSettingsStore({ accessToken: 'tok' }),
    githubFetch: async () => assert.fail('fetch should not be called'),
    runGit: fakeRunGit({ exitCode: 0, stdout: 'https://gitlab.com/o/r.git\n', stderr: '' }),
  });
  const verdict = await policy.evaluate({ baseBranch: 'main', taskBranch: 'feat' });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'origin_not_github');
});

test('buildRemoteMergePolicy returns allow=github_not_connected when no token stored', async () => {
  const policy = buildRemoteMergePolicy({
    projectCwd: '/repo',
    settingsStore: fakeSettingsStore({}),  // no accessToken
    githubFetch: async () => assert.fail('fetch should not be called'),
    runGit: fakeRunGit({ exitCode: 0, stdout: 'git@github.com:k/t.git\n', stderr: '' }),
  });
  const verdict = await policy.evaluate({ baseBranch: 'main', taskBranch: 'feat' });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'github_not_connected');
});

test('buildRemoteMergePolicy refuses when GitHub says base branch requires PR', async () => {
  let capturedRequest;
  const githubFetch = async (url, init) => {
    capturedRequest = { url, init };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({
        required_pull_request_reviews: { required_approving_review_count: 1 },
        enforce_admins: { enabled: true },
      }),
    };
  };
  const policy = buildRemoteMergePolicy({
    projectCwd: '/repo',
    settingsStore: fakeSettingsStore({ accessToken: 'ghs_real' }),
    githubFetch,
    runGit: fakeRunGit({ exitCode: 0, stdout: 'https://github.com/kaydenraquel/toad.git\n', stderr: '' }),
  });

  const verdict = await policy.evaluate({ baseBranch: 'main', taskBranch: 'feat/x' });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'requires_pr');
  assert.match(capturedRequest.url, /\/repos\/kaydenraquel\/toad\/branches\/main\/protection$/);
  assert.equal(capturedRequest.init.headers.Authorization, 'Bearer ghs_real');
});

test('buildRemoteMergePolicy allows when remote branch is unprotected (404 from GitHub)', async () => {
  const githubFetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => '{"message":"Branch not protected"}',
    json: async () => ({ message: 'Branch not protected' }),
  });
  const policy = buildRemoteMergePolicy({
    projectCwd: '/repo',
    settingsStore: fakeSettingsStore({ accessToken: 'ghs_real' }),
    githubFetch,
    runGit: fakeRunGit({ exitCode: 0, stdout: 'git@github.com:k/t.git\n', stderr: '' }),
  });
  const verdict = await policy.evaluate({ baseBranch: 'feature', taskBranch: 'wip' });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'unprotected');
});
