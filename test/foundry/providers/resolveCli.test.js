import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCli } from '../../../src/foundry/providers/resolveCli.js';

test('resolveCli returns name unchanged on non-Windows platforms', () => {
  assert.equal(
    resolveCli('codex', {
      platform: 'linux',
      pathEnv: '/usr/local/bin:/usr/bin',
      existsSyncImpl: () => true,
    }),
    'codex',
  );
  assert.equal(
    resolveCli('codex', { platform: 'darwin', pathEnv: '/opt/homebrew/bin' }),
    'codex',
  );
});

test('resolveCli finds .cmd wrapper on Windows (npm-installed pattern)', () => {
  const existing = new Set(['C:\\Users\\X\\AppData\\Roaming\\npm\\codex.cmd']);
  const resolved = resolveCli('codex', {
    platform: 'win32',
    pathEnv: 'C:\\Users\\X\\AppData\\Roaming\\npm;C:\\Windows\\System32',
    existsSyncImpl: (p) => existing.has(p),
  });
  assert.equal(resolved, 'C:\\Users\\X\\AppData\\Roaming\\npm\\codex.cmd');
});

test('resolveCli finds .exe when .cmd is not present', () => {
  const existing = new Set(['C:\\Program Files\\Claude\\claude.exe']);
  const resolved = resolveCli('claude', {
    platform: 'win32',
    pathEnv: 'C:\\Program Files\\Claude',
    existsSyncImpl: (p) => existing.has(p),
  });
  assert.equal(resolved, 'C:\\Program Files\\Claude\\claude.exe');
});

test('resolveCli prefers .cmd over .exe when both exist (npm-installed wins)', () => {
  const existing = new Set([
    'C:\\dir\\codex.cmd',
    'C:\\dir\\codex.exe',
  ]);
  const resolved = resolveCli('codex', {
    platform: 'win32',
    pathEnv: 'C:\\dir',
    existsSyncImpl: (p) => existing.has(p),
  });
  assert.equal(resolved, 'C:\\dir\\codex.cmd');
});

test('resolveCli returns name unchanged on Windows when nothing matches (preserves ENOENT)', () => {
  const resolved = resolveCli('nonexistent', {
    platform: 'win32',
    pathEnv: 'C:\\Windows;C:\\Windows\\System32',
    existsSyncImpl: () => false,
  });
  assert.equal(resolved, 'nonexistent');
});

test('resolveCli skips empty PATH entries', () => {
  const existing = new Set(['C:\\real\\codex.cmd']);
  const resolved = resolveCli('codex', {
    platform: 'win32',
    pathEnv: ';;C:\\real;;',
    existsSyncImpl: (p) => existing.has(p),
  });
  assert.equal(resolved, 'C:\\real\\codex.cmd');
});

test('resolveCli throws on missing/empty name', () => {
  assert.throws(() => resolveCli(''), /name/i);
  assert.throws(() => resolveCli(), /name/i);
});

test('resolveCli walks multiple PATH dirs in order', () => {
  const existing = new Set(['C:\\second\\codex.cmd']);
  const resolved = resolveCli('codex', {
    platform: 'win32',
    pathEnv: 'C:\\first;C:\\second;C:\\third',
    existsSyncImpl: (p) => existing.has(p),
  });
  assert.equal(resolved, 'C:\\second\\codex.cmd');
});
