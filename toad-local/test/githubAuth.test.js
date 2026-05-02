import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestDeviceCode,
  exchangeDeviceCode,
  getCurrentUser,
  verifyPersonalAccessToken,
  GITHUB_AUTH_URLS,
} from '../src/github/githubAuth.js';

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

test('requestDeviceCode parses GitHub success response', async () => {
  const fetchImpl = makeMockFetch(({ url, init }) => {
    assert.equal(url, GITHUB_AUTH_URLS.DEVICE_CODE);
    assert.equal(init.method, 'POST');
    assert.match(init.body, /client_id=cid-123/);
    assert.match(init.body, /scope=repo\+read%3Auser/);
    return jsonResponse({
      device_code: 'dc_abc',
      user_code: 'AAAA-BBBB',
      verification_uri: 'https://github.com/login/device',
      verification_uri_complete: 'https://github.com/login/device?user_code=AAAA-BBBB',
      expires_in: 900,
      interval: 5,
    });
  });

  const result = await requestDeviceCode({ clientId: 'cid-123', fetchImpl });
  assert.deepEqual(result, {
    deviceCode: 'dc_abc',
    userCode: 'AAAA-BBBB',
    verificationUri: 'https://github.com/login/device',
    verificationUriComplete: 'https://github.com/login/device?user_code=AAAA-BBBB',
    expiresIn: 900,
    interval: 5,
  });
});

test('requestDeviceCode throws on missing clientId', async () => {
  await assert.rejects(() => requestDeviceCode({ fetchImpl: () => {} }), /clientId is required/);
});

test('requestDeviceCode surfaces error_description from GitHub', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ error: 'unauthorized_client', error_description: 'OAuth app not allowed' }, { status: 400 }),
  );
  await assert.rejects(
    () => requestDeviceCode({ clientId: 'cid', fetchImpl }),
    /OAuth app not allowed/,
  );
});

test('exchangeDeviceCode returns granted on access_token', async () => {
  const fetchImpl = makeMockFetch(({ init }) => {
    assert.match(init.body, /device_code=dc_abc/);
    return jsonResponse({
      access_token: 'gho_realtoken',
      token_type: 'bearer',
      scope: 'repo,read:user',
    });
  });
  const result = await exchangeDeviceCode({ clientId: 'cid', deviceCode: 'dc_abc', fetchImpl });
  assert.equal(result.status, 'granted');
  assert.equal(result.accessToken, 'gho_realtoken');
  assert.deepEqual(result.scopes, ['repo', 'read:user']);
});

test('exchangeDeviceCode reports authorization_pending', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ error: 'authorization_pending', error_description: 'pending' }),
  );
  const result = await exchangeDeviceCode({ clientId: 'cid', deviceCode: 'dc', fetchImpl });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'authorization_pending');
});

test('exchangeDeviceCode reports slow_down with interval bump', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ error: 'slow_down', error_description: 'too fast', interval: 10 }),
  );
  const result = await exchangeDeviceCode({ clientId: 'cid', deviceCode: 'dc', fetchImpl });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'slow_down');
  assert.equal(result.interval, 10);
});

test('exchangeDeviceCode reports access_denied', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ error: 'access_denied' }),
  );
  const result = await exchangeDeviceCode({ clientId: 'cid', deviceCode: 'dc', fetchImpl });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'access_denied');
});

test('exchangeDeviceCode throws on unexpected error', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ error: 'invalid_grant', error_description: 'bad device code' }),
  );
  await assert.rejects(
    () => exchangeDeviceCode({ clientId: 'cid', deviceCode: 'dc', fetchImpl }),
    /bad device code/,
  );
});

test('getCurrentUser returns ok with profile + parsed scopes', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse(
      { login: 'octocat', id: 1, name: 'The Octocat', avatar_url: 'https://x/a', html_url: 'https://github.com/octocat' },
      { headers: { 'x-oauth-scopes': 'repo, read:user' } },
    ),
  );
  const result = await getCurrentUser({ token: 't', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.user.login, 'octocat');
  assert.deepEqual(result.scopes, ['repo', 'read:user']);
});

test('getCurrentUser returns ok=false on 401', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ message: 'Bad credentials' }, { status: 401 }),
  );
  const result = await getCurrentUser({ token: 't', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('verifyPersonalAccessToken delegates to getCurrentUser', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse(
      { login: 'alice', id: 7, name: null, avatar_url: null, html_url: null },
      { headers: { 'x-oauth-scopes': 'repo' } },
    ),
  );
  const result = await verifyPersonalAccessToken({ token: 'pat_xxx', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.user.login, 'alice');
});
