import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_STATUS, getAuthStatus } from '../src/providers/providerAuth.js';

function statusFor(credsObj) {
  const json = JSON.stringify(credsObj);
  return getAuthStatus({ providerId: 'anthropic', readFileImpl: () => json, statImpl: () => ({}) });
}
const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 3_600_000;

test('TOKEN_STATUS is the frozen sealed set', () => {
  assert.deepEqual(TOKEN_STATUS, { FRESH: 'fresh', STALE_REFRESHABLE: 'stale_refreshable', UNRECOVERABLE: 'unrecoverable' });
  assert.throws(() => { TOKEN_STATUS.X = 1; }, TypeError);
});

test('fresh: not expired (future expiresAt) → signedIn:true tokenStatus:fresh', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: FUTURE, refreshToken: 'r', subscriptionType: 'max' } });
  assert.equal(s.signedIn, true);
  assert.equal(s.tokenStatus, 'fresh');
});

test('fresh: expiresAt absent → fresh (cannot prove expiry)', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
  assert.equal(s.signedIn, true);
  assert.equal(s.tokenStatus, 'fresh');
});

test('stale_refreshable: expired + refresh token → signedIn:true tokenStatus:stale_refreshable + reason', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: PAST, refreshToken: 'r' } });
  assert.equal(s.signedIn, true);
  assert.equal(s.tokenStatus, 'stale_refreshable');
  assert.equal(typeof s.reason, 'string');
  assert.ok(s.reason.length > 0);
});

test('unrecoverable: expired + no refresh → signedIn:false (UNCHANGED) tokenStatus:unrecoverable', () => {
  const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: PAST } });
  assert.equal(s.signedIn, false);
  assert.equal(s.tokenStatus, 'unrecoverable');
  assert.equal(s.reason, 'OAuth tokens expired and no refresh token to renew them');
});

test('unrecoverable: no accessToken → signedIn:false (UNCHANGED) tokenStatus:unrecoverable', () => {
  const s = statusFor({ claudeAiOauth: {} });
  assert.equal(s.signedIn, false);
  assert.equal(s.tokenStatus, 'unrecoverable');
  assert.equal(s.reason, 'no claudeAiOauth.accessToken in credentials file');
});

test('unrecoverable: not a JSON object → signedIn:false (UNCHANGED) tokenStatus:unrecoverable', () => {
  const s = getAuthStatus({ providerId: 'anthropic', readFileImpl: () => '[]', statImpl: () => ({}) });
  assert.equal(s.signedIn, false);
  assert.equal(s.tokenStatus, 'unrecoverable');
  assert.equal(s.reason, 'credentials file did not parse as a JSON object');
});

test('expiresAt === now boundary → NOT expired → fresh', () => {
  const fixed = 1_900_000_000_000;
  const realNow = Date.now;
  Date.now = () => fixed;
  try {
    const s = statusFor({ claudeAiOauth: { accessToken: 'a', expiresAt: fixed, refreshToken: 'r' } });
    assert.equal(s.tokenStatus, 'fresh');
  } finally { Date.now = realNow; }
});
