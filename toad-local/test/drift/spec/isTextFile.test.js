import test from 'node:test';
import assert from 'node:assert/strict';
import { isTextFile } from '../../../src/drift/spec/isTextFile.js';

test('known text extensions → true', () => {
  for (const p of ['src/a.rs', 'Cargo.toml', 'x.ts', 'app.manifest', 'a.py', 'README.md']) {
    assert.equal(isTextFile(p), true, p);
  }
});

test('known binary / non-text extensions → false', () => {
  for (const p of ['bin/reaper.exe', 'img/logo.png', 'a.jpg', 'lib.so', 'x.dll', 'data.bin']) {
    assert.equal(isTextFile(p), false, p);
  }
});

test('git check-attr binary overrides to false when runGit provided', () => {
  const runGit = () => ({ exitCode: 0, stdout: 'generated.rs: binary: set\n', stderr: '' });
  assert.equal(isTextFile('generated.rs', { runGit, projectCwd: '/p' }), false);
});

test('git check-attr non-binary leaves the extension verdict intact', () => {
  const runGit = () => ({ exitCode: 0, stdout: 'src/a.rs: binary: unspecified\n', stderr: '' });
  assert.equal(isTextFile('src/a.rs', { runGit, projectCwd: '/p' }), true);
});

test('unknown extension defaults to false (conservative — never scan a maybe-binary)', () => {
  assert.equal(isTextFile('weird.xyzzy'), false);
});
