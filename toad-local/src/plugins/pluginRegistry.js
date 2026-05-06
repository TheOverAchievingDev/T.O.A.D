import path from 'node:path';

/**
 * Registry of supported plugins. Mirrors src/providers/providerAuth.js's
 * PROVIDER_COMMANDS shape — same CLI-mediated, file-based auth-detection
 * pattern, just for infrastructure providers instead of LLM providers.
 *
 * Each entry's riskProfile maps action names to risk levels consumed by
 * the riskClassifier hook (see src/policy/riskClassifier.js plugin
 * integration).
 */

export const SUPPORTED_PLUGINS = Object.freeze(['railway', 'eas', 'vercel']);

export const PLUGIN_COMMANDS = Object.freeze({
  railway: Object.freeze({
    label: 'Railway',
    cli: 'railway',
    statusMode: 'file',
    statusFile: path.join('~', '.config', 'railway', 'config.json'),
    parseFileStatus: parseRailwayFileStatus,
    manualLogin: true,
    loginInstructions: 'Run `railway login` in a terminal. Symphony will detect the auth file once you complete the browser flow.',
    logoutArgs: ['logout'],
    supported: true,
    riskProfile: Object.freeze({
      link:                  'low',
      provision_db:          'medium',
      get_connection_string: 'medium',
      run_migration:         'high',
    }),
  }),
  eas: Object.freeze({
    label: 'EAS',
    cli: 'eas',
    statusMode: 'file',
    statusFile: path.join('~', '.expo', 'state.json'),
    parseFileStatus: parseEasFileStatus,
    manualLogin: true,
    loginInstructions: 'Run `eas login` in a terminal. Symphony will detect the auth file once you complete the browser flow.',
    supported: true,
    riskProfile: Object.freeze({
      project_info: 'low',
      build:        'high',
      update:       'high',
      job_get:      'low',
      job_list:     'low',
    }),
  }),
  vercel: Object.freeze({
    label: 'Vercel',
    cli: 'vercel',
    statusMode: 'file',
    statusFile: path.join('~', '.config', 'vercel', 'auth.json'),
    parseFileStatus: () => ({ signedIn: false, reason: 'Vercel plugin not implemented in slice 1' }),
    manualLogin: true,
    loginInstructions: 'Vercel plugin lands in slice 3.',
    supported: false,
    unsupportedReason: 'Vercel plugin lands in slice 3 (after EAS validates the long-running-job pattern).',
    riskProfile: Object.freeze({}),
  }),
});

/**
 * Verify Railway's auth file has a token. The Railway CLI stores its
 * config at ~/.config/railway/config.json with a `token` field after
 * `railway login` completes.
 */
export function parseRailwayFileStatus(authJson, _infoJson, providerId) {
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: 'Railway auth file is empty or not an object.',
    };
  }
  const token = pickString(authJson.token, authJson.access_token);
  if (!token) {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: 'Railway auth file present but token is missing.',
    };
  }
  const user = (authJson.user && typeof authJson.user === 'object') ? authJson.user : {};
  return {
    providerId,
    supported: true,
    signedIn: true,
    user: {
      email: pickString(user.email, authJson.email),
      login: pickString(user.username, user.name),
      name: pickString(user.name),
    },
    plan: pickString(authJson.plan, user.plan),
    raw: { tokenLength: token.length },
  };
}

/**
 * Verify EAS (Expo) auth file. Expo stores session info in
 * ~/.expo/state.json under `auth.sessionToken`.
 */
export function parseEasFileStatus(authJson, _infoJson, providerId) {
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: 'EAS auth file is empty or not an object.',
    };
  }
  const token = authJson.auth?.sessionToken;
  if (!token) {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: 'EAS auth file present but sessionToken is missing.',
    };
  }
  // Expo state.json doesn't always have user info directly; it might
  // just have the token.
  return {
    providerId,
    supported: true,
    signedIn: true,
    user: authJson.auth?.username ? { login: authJson.auth.username } : null,
    raw: { tokenLength: token.length },
  };
}

function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}
