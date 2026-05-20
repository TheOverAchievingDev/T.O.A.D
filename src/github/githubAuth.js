/**
 * §3c GitHub auth helpers.
 *
 * Two flows:
 *   - Device Flow (preferred): user code + verification URL, no callback URL
 *     needed. Works for desktop apps shipped to many users.
 *   - PAT fallback: user pastes a Personal Access Token, we verify it by
 *     calling /user.
 *
 * `fetchImpl` is injectable so tests can replace it without monkey-patching
 * global fetch. Production callers default to globalThis.fetch.
 */

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

const DEFAULT_SCOPES = ['repo', 'read:user'];

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('global fetch is not available; pass fetchImpl explicitly');
  }
  return globalThis.fetch;
}

/**
 * Step 1 of Device Flow. Requests a device code + user code from GitHub.
 *
 * @returns {Promise<{
 *   deviceCode: string,
 *   userCode: string,
 *   verificationUri: string,
 *   verificationUriComplete?: string,
 *   expiresIn: number,
 *   interval: number,
 * }>}
 */
export async function requestDeviceCode({ clientId, scopes = DEFAULT_SCOPES, fetchImpl } = {}) {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('requestDeviceCode: clientId is required');
  }
  const fetcher = fetchImpl || defaultFetch();

  const body = new URLSearchParams({
    client_id: clientId,
    scope: scopes.join(' '),
  });

  const response = await fetcher(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`requestDeviceCode: GitHub returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!response.ok || json.error) {
    throw new Error(`requestDeviceCode: ${json.error_description || json.error || `HTTP ${response.status}`}`);
  }

  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    verificationUriComplete: json.verification_uri_complete,
    expiresIn: Number(json.expires_in) || 900,
    interval: Number(json.interval) || 5,
  };
}

/**
 * Step 2 of Device Flow. Exchanges the device code for an access token. Does
 * NOT loop — caller controls polling cadence (so we can test it deterministically).
 *
 * @returns {Promise<
 *   | { status: 'granted', accessToken: string, tokenType: string, scopes: string[] }
 *   | { status: 'pending', reason: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied', interval?: number }
 * >}
 */
export async function exchangeDeviceCode({ clientId, deviceCode, fetchImpl } = {}) {
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error('exchangeDeviceCode: clientId is required');
  }
  if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
    throw new Error('exchangeDeviceCode: deviceCode is required');
  }
  const fetcher = fetchImpl || defaultFetch();

  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  const response = await fetcher(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`exchangeDeviceCode: GitHub returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (json.access_token) {
    return {
      status: 'granted',
      accessToken: String(json.access_token),
      tokenType: json.token_type || 'bearer',
      scopes: typeof json.scope === 'string' && json.scope.length > 0
        ? json.scope.split(/[\s,]+/).filter(Boolean)
        : [],
    };
  }

  // GitHub returns 200 with `error` for the soft-pending states.
  const reason = json.error || 'authorization_pending';
  if (reason === 'authorization_pending' || reason === 'slow_down' || reason === 'expired_token' || reason === 'access_denied') {
    const result = { status: 'pending', reason };
    if (typeof json.interval === 'number') result.interval = json.interval;
    return result;
  }

  throw new Error(`exchangeDeviceCode: ${json.error_description || reason}`);
}

/**
 * Calls GET /user with the token. Used by both flows to verify + capture
 * profile data. Returns null on auth failure rather than throwing, so callers
 * can distinguish "token rejected" from "GitHub down".
 */
export async function getCurrentUser({ token, fetchImpl } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('getCurrentUser: token is required');
  }
  const fetcher = fetchImpl || defaultFetch();

  const response = await fetcher(GITHUB_USER_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TOAD-Local/0.1',
    },
  });

  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status };
  }
  if (!response.ok) {
    throw new Error(`getCurrentUser: HTTP ${response.status}`);
  }
  // GitHub exposes granted scopes in this header on PATs and OAuth tokens.
  const scopes = String(response.headers?.get?.('x-oauth-scopes') ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const json = await response.json();
  return {
    ok: true,
    user: {
      login: json.login,
      id: json.id,
      name: json.name ?? null,
      avatarUrl: json.avatar_url ?? null,
      htmlUrl: json.html_url ?? null,
    },
    scopes,
  };
}

/**
 * Verify a PAT by calling /user. Bundles user-fetch + scope-extraction.
 * Throws on bad input; returns { ok: false } on token rejection.
 */
export async function verifyPersonalAccessToken({ token, fetchImpl } = {}) {
  return getCurrentUser({ token, fetchImpl });
}

export const GITHUB_AUTH_URLS = Object.freeze({
  DEVICE_CODE: GITHUB_DEVICE_CODE_URL,
  TOKEN: GITHUB_TOKEN_URL,
  USER: GITHUB_USER_URL,
});

export const DEFAULT_GITHUB_SCOPES = DEFAULT_SCOPES;
