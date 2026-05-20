// T7 follow-up — creds-reader contract for the auth preflight.
//
// CRITICAL bug guarded here: getAuthStatus → readFileStatus has three
// early returns (ENOENT/missing, non-ENOENT read failure, JSON-parse
// failure) that bypass parseAnthropicFileStatus and OMIT tokenStatus.
// The pure preflight core has no 4th branch — an undefined tokenStatus
// skips FRESH and UNRECOVERABLE, falls into the refresh path, and
// resolves proceed+warn for the MOST COMMON doomed state (never logged
// in / logged out / creds deleted): the feature fails OPEN exactly
// where it must block.
//
// readClaudeCredsStatusForPreflight normalizes those tokenStatus-less
// states to UNRECOVERABLE (fail-closed; never proceed on a state we
// cannot substantiate) while passing valid classifications through
// unchanged.
//
// TDD discipline: written BEFORE the helper exists; first run MUST fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeCredsStatusForPreflight, TOKEN_STATUS } from '../src/providers/providerAuth.js';

const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 3_600_000;

test('ENOENT (missing creds file) → normalized to UNRECOVERABLE, signedIn:false preserved', () => {
  const s = readClaudeCredsStatusForPreflight({
    statImpl: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
    readFileImpl: () => { throw new Error('should not be reached'); },
  });
  assert.equal(s.tokenStatus, TOKEN_STATUS.UNRECOVERABLE);
  assert.equal(s.signedIn, false);
});

test('non-ENOENT read failure → normalized to UNRECOVERABLE', () => {
  const s = readClaudeCredsStatusForPreflight({
    statImpl: () => ({}),
    readFileImpl: () => { throw new Error('EACCES'); },
  });
  assert.equal(s.tokenStatus, TOKEN_STATUS.UNRECOVERABLE);
});

test('JSON-parse failure → normalized to UNRECOVERABLE', () => {
  const s = readClaudeCredsStatusForPreflight({
    statImpl: () => ({}),
    readFileImpl: () => 'not-json{',
  });
  assert.equal(s.tokenStatus, TOKEN_STATUS.UNRECOVERABLE);
});

test('valid FRESH creds → passthrough (NOT normalized)', () => {
  const json = JSON.stringify({
    claudeAiOauth: { accessToken: 'a', expiresAt: FUTURE, refreshToken: 'r', subscriptionType: 'max' },
  });
  const s = readClaudeCredsStatusForPreflight({
    statImpl: () => ({}),
    readFileImpl: () => json,
  });
  assert.equal(s.tokenStatus, TOKEN_STATUS.FRESH);
  assert.equal(s.signedIn, true);
});

test('valid STALE_REFRESHABLE creds → passthrough (NOT normalized)', () => {
  const json = JSON.stringify({
    claudeAiOauth: { accessToken: 'a', expiresAt: PAST, refreshToken: 'r' },
  });
  const s = readClaudeCredsStatusForPreflight({
    statImpl: () => ({}),
    readFileImpl: () => json,
  });
  assert.equal(s.tokenStatus, TOKEN_STATUS.STALE_REFRESHABLE);
  assert.equal(s.signedIn, true);
});
