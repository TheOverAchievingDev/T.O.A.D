import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGithubRemote,
  evaluateRemoteMergePolicy,
} from '../src/task/remoteMergePolicy.js';

// --- parseGithubRemote -------------------------------------------------------

test('parseGithubRemote handles https URLs with .git suffix', () => {
  assert.deepEqual(
    parseGithubRemote('https://github.com/kaydenraquel/toad.git'),
    { owner: 'kaydenraquel', repo: 'toad' },
  );
});

test('parseGithubRemote handles https URLs without .git suffix', () => {
  assert.deepEqual(
    parseGithubRemote('https://github.com/kaydenraquel/toad'),
    { owner: 'kaydenraquel', repo: 'toad' },
  );
});

test('parseGithubRemote handles git@ SSH URLs', () => {
  assert.deepEqual(
    parseGithubRemote('git@github.com:kaydenraquel/toad.git'),
    { owner: 'kaydenraquel', repo: 'toad' },
  );
});

test('parseGithubRemote handles ssh:// URLs', () => {
  assert.deepEqual(
    parseGithubRemote('ssh://git@github.com/kaydenraquel/toad.git'),
    { owner: 'kaydenraquel', repo: 'toad' },
  );
});

test('parseGithubRemote returns null for non-github hosts', () => {
  assert.equal(parseGithubRemote('https://gitlab.com/kaydenraquel/toad.git'), null);
  assert.equal(parseGithubRemote('git@bitbucket.org:k/t.git'), null);
});

test('parseGithubRemote returns null for malformed input', () => {
  assert.equal(parseGithubRemote(''), null);
  assert.equal(parseGithubRemote(null), null);
  assert.equal(parseGithubRemote(undefined), null);
  assert.equal(parseGithubRemote('not a url at all'), null);
  assert.equal(parseGithubRemote('https://github.com/'), null);
  assert.equal(parseGithubRemote('https://github.com/onlyone'), null);
});

// --- evaluateRemoteMergePolicy ----------------------------------------------

test('evaluateRemoteMergePolicy refuses when base branch requires PR', async () => {
  const getProtection = async () => ({
    ok: true, protected: true, requiresPullRequest: true,
    requiredApprovingReviewCount: 1, requiresStatusChecks: false,
    requiredStatusCheckContexts: [], enforceAdmins: false,
    allowForcePushes: false, allowDeletions: false,
    requiresLinearHistory: false, hasPushRestrictions: false,
  });
  const verdict = await evaluateRemoteMergePolicy({
    baseBranch: 'main', owner: 'k', repo: 't', getProtection,
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'requires_pr');
  assert.equal(verdict.protection.requiredApprovingReviewCount, 1);
});

test('evaluateRemoteMergePolicy allows when branch is unprotected', async () => {
  const getProtection = async () => ({ ok: true, protected: false });
  const verdict = await evaluateRemoteMergePolicy({
    baseBranch: 'main', owner: 'k', repo: 't', getProtection,
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'unprotected');
});

test('evaluateRemoteMergePolicy allows when protected but PR not required', async () => {
  // Some teams use protection just for force-push prevention, not PR-only.
  const getProtection = async () => ({
    ok: true, protected: true, requiresPullRequest: false,
    requiredApprovingReviewCount: null, requiresStatusChecks: true,
    requiredStatusCheckContexts: ['ci'], enforceAdmins: false,
    allowForcePushes: false, allowDeletions: false,
    requiresLinearHistory: false, hasPushRestrictions: false,
  });
  const verdict = await evaluateRemoteMergePolicy({
    baseBranch: 'main', owner: 'k', repo: 't', getProtection,
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'protected_but_pr_not_required');
});

test('evaluateRemoteMergePolicy allows on auth failure (degraded — local-merge proceeds)', async () => {
  // We don't want a transient 401 to block a local merge on every dev's
  // machine; treat it as "couldn't check" and let the merge proceed.
  const getProtection = async () => ({ ok: false, status: 401 });
  const verdict = await evaluateRemoteMergePolicy({
    baseBranch: 'main', owner: 'k', repo: 't', getProtection,
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'protection_check_failed:401');
});

test('evaluateRemoteMergePolicy allows when getter throws', async () => {
  const getProtection = async () => { throw new Error('network down'); };
  const verdict = await evaluateRemoteMergePolicy({
    baseBranch: 'main', owner: 'k', repo: 't', getProtection,
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'protection_check_threw');
});

test('evaluateRemoteMergePolicy allows when owner/repo/baseBranch missing (no remote info)', async () => {
  const getProtection = async () => assert.fail('should not be called');
  const verdict = await evaluateRemoteMergePolicy({
    baseBranch: '', owner: '', repo: '', getProtection,
  });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.reason, 'no_remote_info');
});

test('evaluateRemoteMergePolicy validates getProtection is a function', async () => {
  await assert.rejects(
    () => evaluateRemoteMergePolicy({ baseBranch: 'main', owner: 'k', repo: 't', getProtection: null }),
    /getProtection must be a function/,
  );
});
