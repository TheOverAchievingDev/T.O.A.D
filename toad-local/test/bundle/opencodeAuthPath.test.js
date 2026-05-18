/**
 * BR6 — Important A5 (bundle whole-impl review): the OpenCode auth path was
 * hardcoded `~/.local/share/opencode/auth.json` (Linux/XDG). On Windows
 * (the target platform) that resolves under %USERPROFILE%\.local\share,
 * where OpenCode does NOT store creds → #prepareOpencodeRuntime fails fast
 * ("OpenCode not authenticated") for a correctly-signed-in Windows user.
 * Fix: resolve per-platform, honoring XDG_DATA_HOME / %APPDATA%.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveOpencodeAuthFile } from '../../src/providers/providerAuth.js';

test('XDG_DATA_HOME wins on any platform', () => {
  const p = resolveOpencodeAuthFile({ env: { XDG_DATA_HOME: '/xdg/data' }, platform: 'linux', homedir: '/home/u' });
  assert.equal(p, path.join('/xdg/data', 'opencode', 'auth.json'));
  const pw = resolveOpencodeAuthFile({ env: { XDG_DATA_HOME: 'D:\\xdg' }, platform: 'win32', homedir: 'C:\\Users\\u' });
  assert.equal(pw, path.join('D:\\xdg', 'opencode', 'auth.json'));
});

test('Windows without XDG uses %APPDATA% (NOT ~/.local/share)', () => {
  const p = resolveOpencodeAuthFile({
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\u',
  });
  assert.equal(p, path.join('C:\\Users\\u\\AppData\\Roaming', 'opencode', 'auth.json'));
  assert.ok(!p.includes('.local'), 'must not fall back to the Linux ~/.local/share path on Windows');
});

test('Linux/mac without XDG falls back to ~/.local/share/opencode/auth.json', () => {
  const p = resolveOpencodeAuthFile({ env: {}, platform: 'linux', homedir: '/home/u' });
  assert.equal(p, path.join('/home/u', '.local', 'share', 'opencode', 'auth.json'));
});
