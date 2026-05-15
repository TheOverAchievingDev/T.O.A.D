import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifestDeps } from '../../../src/drift/spec/parseManifestDeps.js';

// parseManifestDeps extracts the set of DIRECT dependency names from a
// language's manifest. Ruling #3: direct deps only — transitive bans
// are unenforceable without a full resolve and produce false positives.

function reader(content) {
  return (p) => {
    if (p === '/proj/MANIFEST') return content;
    const e = new Error(`ENOENT ${p}`); e.code = 'ENOENT'; throw e;
  };
}

test('package.json — returns direct deps (dependencies + devDependencies)', () => {
  const pkg = JSON.stringify({
    dependencies: { react: '^18', '@vercel/sdk': '1.0.0' },
    devDependencies: { vitest: '^2', typescript: '5.4' },
  });
  const r = parseManifestDeps({
    manifestPath: '/proj/MANIFEST',
    language: 'typescript',
    readFileSyncImpl: reader(pkg),
  });
  assert.equal(r.error, null);
  assert.deepEqual([...r.deps].sort(), ['@vercel/sdk', 'react', 'typescript', 'vitest']);
});

test('package.json — empty/missing dep blocks yield empty set, not error', () => {
  const r = parseManifestDeps({
    manifestPath: '/proj/MANIFEST',
    language: 'typescript',
    readFileSyncImpl: reader('{}'),
  });
  assert.equal(r.error, null);
  assert.equal(r.deps.size, 0);
});

test('Cargo.toml — parses [dependencies] simple + table forms', () => {
  const cargo = [
    '[package]',
    'name = "reaper"',
    'rust-version = "1.78"',
    '',
    '[dependencies]',
    'serde = "1.0"',
    'eframe = { version = "0.27", features = ["wgpu"] }',
    'windows = { version = "0.56" }',
    '',
    '[dev-dependencies]',
    'tempfile = "3"',
    '',
    '[build-dependencies]',
    'cc = "1"',
  ].join('\n');
  const r = parseManifestDeps({
    manifestPath: '/proj/MANIFEST',
    language: 'rust',
    readFileSyncImpl: reader(cargo),
  });
  assert.equal(r.error, null);
  // serde/eframe/windows from [dependencies], tempfile from
  // [dev-dependencies], cc from [build-dependencies] — all DIRECT.
  assert.deepEqual([...r.deps].sort(), ['cc', 'eframe', 'serde', 'tempfile', 'windows']);
});

test('Cargo.toml — ignores keys inside inline tables (features array is not a dep)', () => {
  const cargo = [
    '[dependencies]',
    'tokio = { version = "1", features = ["full", "macros"] }',
  ].join('\n');
  const r = parseManifestDeps({
    manifestPath: '/proj/MANIFEST',
    language: 'rust',
    readFileSyncImpl: reader(cargo),
  });
  assert.equal(r.error, null);
  // Only `tokio` — NOT `full`, `macros`, or `features`.
  assert.deepEqual([...r.deps], ['tokio']);
});

test('Cargo.toml — target-specific dependency tables are also direct deps', () => {
  const cargo = [
    '[dependencies]',
    'serde = "1"',
    '',
    '[target.\'cfg(windows)\'.dependencies]',
    'winapi = "0.3"',
  ].join('\n');
  const r = parseManifestDeps({
    manifestPath: '/proj/MANIFEST',
    language: 'rust',
    readFileSyncImpl: reader(cargo),
  });
  assert.equal(r.error, null);
  assert.deepEqual([...r.deps].sort(), ['serde', 'winapi']);
});

test('unsupported language returns a clear error (honest, not a silent pass)', () => {
  const r = parseManifestDeps({
    manifestPath: '/proj/MANIFEST',
    language: 'haskell',
    readFileSyncImpl: reader('whatever'),
  });
  assert.equal(r.deps, null);
  assert.match(r.error, /haskell|unsupported|not implemented/i);
});

test('manifest read failure returns an error, does not throw', () => {
  const r = parseManifestDeps({
    manifestPath: '/proj/MISSING',
    language: 'typescript',
    readFileSyncImpl: reader('{}'), // only /proj/MANIFEST exists
  });
  assert.equal(r.deps, null);
  assert.match(r.error, /read|ENOENT/i);
});

test('malformed package.json returns parse error, does not throw', () => {
  const r = parseManifestDeps({
    manifestPath: '/proj/MANIFEST',
    language: 'typescript',
    readFileSyncImpl: reader('{not json'),
  });
  assert.equal(r.deps, null);
  assert.match(r.error, /parse/i);
});
