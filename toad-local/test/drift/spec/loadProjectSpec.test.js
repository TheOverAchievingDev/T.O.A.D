import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectSpec } from '../../../src/drift/spec/loadProjectSpec.js';

// loadProjectSpec reads docs/foundry/spec.json relative to projectCwd.
// fs is injected so these tests never touch a real disk.

function fakeFs(files) {
  return {
    existsSyncImpl: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSyncImpl: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
      }
      return files[p];
    },
  };
}

const SPEC_PATH = '/proj/docs/foundry/spec.json';

test('returns { spec: null } when projectCwd is missing/empty (no spec to check against)', () => {
  assert.deepEqual(loadProjectSpec({ projectCwd: '' }), { spec: null, error: null });
  assert.deepEqual(loadProjectSpec({ projectCwd: null }), { spec: null, error: null });
  assert.deepEqual(loadProjectSpec({}), { spec: null, error: null });
});

test('returns { spec: null } when spec.json does not exist (absence is not this check\'s finding)', () => {
  const { existsSyncImpl, readFileSyncImpl } = fakeFs({});
  const r = loadProjectSpec({ projectCwd: '/proj', existsSyncImpl, readFileSyncImpl });
  assert.equal(r.spec, null);
  assert.equal(r.error, null);
});

test('parses a valid spec.json and returns the object', () => {
  const spec = {
    version: 1,
    stack: { language: 'rust', manifest: 'Cargo.toml', module_root: 'src/main.rs' },
    dependencies: { authorized: ['serde', 'toml'], forbidden: ['reqwest'] },
    provenance: { reviewed: true, extracted_by: 'foundry_extract_spec@v1' },
  };
  const { existsSyncImpl, readFileSyncImpl } = fakeFs({ [SPEC_PATH]: JSON.stringify(spec) });
  const r = loadProjectSpec({ projectCwd: '/proj', existsSyncImpl, readFileSyncImpl });
  assert.equal(r.error, null);
  assert.equal(r.spec.version, 1);
  assert.equal(r.spec.stack.manifest, 'Cargo.toml');
  assert.deepEqual(r.spec.dependencies.authorized, ['serde', 'toml']);
  assert.equal(r.spec.provenance.reviewed, true);
});

test('returns { spec: null, error } when spec.json is malformed JSON (degrade, do not throw)', () => {
  const { existsSyncImpl, readFileSyncImpl } = fakeFs({ [SPEC_PATH]: 'not-json{' });
  const r = loadProjectSpec({ projectCwd: '/proj', existsSyncImpl, readFileSyncImpl });
  assert.equal(r.spec, null);
  assert.match(r.error, /parse/i);
});

test('returns { spec: null, error } when spec.json is valid JSON but not an object', () => {
  const { existsSyncImpl, readFileSyncImpl } = fakeFs({ [SPEC_PATH]: '"a string"' });
  const r = loadProjectSpec({ projectCwd: '/proj', existsSyncImpl, readFileSyncImpl });
  assert.equal(r.spec, null);
  assert.match(r.error, /object/i);
});

test('returns { spec: null, error } when version is unsupported (forward-compat guard)', () => {
  const { existsSyncImpl, readFileSyncImpl } = fakeFs({
    [SPEC_PATH]: JSON.stringify({ version: 999, stack: {} }),
  });
  const r = loadProjectSpec({ projectCwd: '/proj', existsSyncImpl, readFileSyncImpl });
  assert.equal(r.spec, null);
  assert.match(r.error, /version/i);
});

test('joins projectCwd + docs/foundry/spec.json with forward slashes (cross-platform)', () => {
  // Windows path with backslashes still resolves; we normalize internally.
  const winPath = 'C:\\proj';
  const expected = 'C:/proj/docs/foundry/spec.json';
  let probed = null;
  const r = loadProjectSpec({
    projectCwd: winPath,
    existsSyncImpl: (p) => { probed = p.replace(/\\/g, '/'); return false; },
    readFileSyncImpl: () => '',
  });
  assert.equal(r.spec, null);
  assert.equal(probed, expected);
});
