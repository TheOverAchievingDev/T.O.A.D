/**
 * BR6-fix (regression from the ungrounded single-path A5 change): the
 * OpenCode creds file location is NOT grounded (that's deferred A3), so
 * resolving to a single platform-guessed path regressed detection where
 * creds actually live at the legacy ~/.local/share path (broke
 * "provider_auth_status reports opencode" → result.apiOnly undefined).
 * Fix: try MULTIPLE candidate paths; use the first that exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthStatus, resolveOpencodeAuthFileCandidates } from '../../src/providers/providerAuth.js';

test('resolveOpencodeAuthFileCandidates yields the platform path AND the legacy ~/.local/share path', () => {
  const c = resolveOpencodeAuthFileCandidates({ env: { APPDATA: 'C:\\AppData' }, platform: 'win32', homedir: 'C:\\Users\\u' });
  assert.ok(c.some((p) => p.includes('AppData')), 'includes the Windows %APPDATA% candidate');
  assert.ok(c.some((p) => p.includes('.local') && p.includes('share')), 'still includes the legacy ~/.local/share candidate');
});

test('opencode auth resolves to apiOnly via parse when ONLY the legacy path has creds', () => {
  // Simulate: the platform-preferred path is absent; the legacy path holds
  // a valid opencode auth.json. Pre-fix (single path) → ENOENT → no apiOnly.
  const validAuth = JSON.stringify({ openai: { type: 'api', key: 'sk-x' } });
  const statImpl = (p) => {
    if (String(p).includes('.local') && String(p).includes('share')) return { isFile: () => true };
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  };
  const readFileImpl = (p) => {
    if (String(p).includes('.local') && String(p).includes('share')) return validAuth;
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  };
  const res = getAuthStatus({ providerId: 'opencode', statImpl, readFileImpl });
  assert.equal(res.supported, true);
  assert.equal(res.apiOnly, true, 'must resolve through the opencode parse path (apiOnly), not the generic ENOENT path');
});
