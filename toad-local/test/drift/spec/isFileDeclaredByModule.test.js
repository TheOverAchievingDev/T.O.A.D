import test from 'node:test';
import assert from 'node:assert/strict';
import { isFileDeclaredByModule } from '../../../src/drift/spec/isFileDeclaredByModule.js';

const mod = (evidence) => ({ kind: 'module', name: 'm', evidence });

test('exact normalized evidence path → declared, exact_evidence_path', () => {
  assert.deepEqual(isFileDeclaredByModule('src/sampler.rs', mod('src/sampler.rs')),
    { declared: true, matchKind: 'exact_evidence_path' });
});
test('./ and backslash normalization both sides', () => {
  assert.deepEqual(isFileDeclaredByModule('.\\src\\sampler.rs', mod('./src/sampler.rs')),
    { declared: true, matchKind: 'exact_evidence_path' });
});
test('file under the module directory promotion → under_module_directory', () => {
  assert.deepEqual(isFileDeclaredByModule('src/sampler/core.rs', mod('src/sampler.rs')),
    { declared: true, matchKind: 'under_module_directory' });
});
test('unrelated file → none', () => {
  assert.deepEqual(isFileDeclaredByModule('src/other.rs', mod('src/sampler.rs')),
    { declared: false, matchKind: 'none' });
});
test('non-module entry / non-string evidence / empty file → none', () => {
  assert.deepEqual(isFileDeclaredByModule('src/a.rs', { kind: 'endpoint', evidence: 'x' }),
    { declared: false, matchKind: 'none' });
  assert.deepEqual(isFileDeclaredByModule('src/a.rs', { kind: 'module', evidence: 42 }),
    { declared: false, matchKind: 'none' });
  assert.deepEqual(isFileDeclaredByModule('', mod('src/a.rs')),
    { declared: false, matchKind: 'none' });
});
test('prose/multi-path evidence resolves identically to L1.2 today (no "or" splitting)', () => {
  // L1.2 never split on " or " — it treats the whole string as one
  // path and strips the LAST extension. Behavior preserved verbatim.
  const m = mod('src/win/procs.rs or src/win/mod.rs exposing procs');
  // last '.' is in "mod.rs", last '/' before it is "src/win/" → stem
  // = "src/win/procs.rs or src/win/mod", promotionPrefix = stem + '/'.
  assert.equal(isFileDeclaredByModule('src/win/procs.rs', m).declared, false,
    'pre-existing L1.2 imperfection preserved — not "fixed" in a pure refactor');
  assert.equal(
    isFileDeclaredByModule('src/win/procs.rs or src/win/mod/x', m).matchKind,
    'under_module_directory');
  assert.equal(isFileDeclaredByModule('src/win/mod.rs', m).declared, false,
    'the 2nd real path in prose evidence is also NOT matched — the imperfection L3 Slice B will inherit');
});

test('root-level module evidence (no slash): exact + directory promotion', () => {
  const m = mod('foo.rs');
  assert.deepEqual(isFileDeclaredByModule('foo.rs', m),
    { declared: true, matchKind: 'exact_evidence_path' });
  assert.deepEqual(isFileDeclaredByModule('foo/bar.rs', m),
    { declared: true, matchKind: 'under_module_directory' });
  assert.deepEqual(isFileDeclaredByModule('other.rs', m),
    { declared: false, matchKind: 'none' });
});
