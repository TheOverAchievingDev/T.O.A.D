import test from 'node:test';
import assert from 'node:assert/strict';
import { runGit } from '../src/git/runGit.js';

test('runGit forwards args and cwd to the injected spawn function', () => {
  const calls = [];
  const fakeSpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { status: 0, stdout: 'output\n', stderr: '' };
  };
  const result = runGit(['rev-parse', 'HEAD'], { cwd: '/some/dir', spawn: fakeSpawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'git');
  assert.deepEqual(calls[0].args, ['rev-parse', 'HEAD']);
  assert.equal(calls[0].opts.cwd, '/some/dir');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'output\n');
  assert.equal(result.stderr, '');
});

test('runGit normalizes spawn result fields', () => {
  const fakeSpawn = () => ({ status: 1, stdout: Buffer.from('out'), stderr: Buffer.from('err') });
  const result = runGit(['status'], { cwd: '.', spawn: fakeSpawn });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
});

test('runGit defaults to a real spawn when none injected — smoke check git --version', () => {
  const result = runGit(['--version'], { cwd: process.cwd() });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /git version/);
});

test('runGit reports exitCode -1 when spawn throws (e.g., git binary missing)', () => {
  const fakeSpawn = () => { throw new Error('ENOENT'); };
  const result = runGit(['status'], { cwd: '.', spawn: fakeSpawn });
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /ENOENT/);
});
