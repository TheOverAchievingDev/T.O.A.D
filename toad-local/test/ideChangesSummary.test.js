import test from 'node:test';
import assert from 'node:assert/strict';
import { getIdeChangesSummary } from '../src/ide/ideChangesSummary.js';

// Fake runGit: returns canned {exitCode,stdout,stderr} per git subcommand.
function fakeRunGit(map) {
  return (args) => {
    const key = args.join(' ');
    if (key in map) return map[key];
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const baseArgs = {
  projectCwd: '/tmp/fake-project',
  taskBoard: null,
  teamId: 'team-a',
  source: { kind: 'project' },
};

test('getIdeChangesSummary merges numstat counts with porcelain status', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': {
      exitCode: 0,
      stdout: '12\t3\tsrc/foo.ts\n1\t18\tsrc/bar.js\n0\t9\tsrc/gone.ts\n',
      stderr: '',
    },
    'status --porcelain': {
      exitCode: 0,
      stdout: ' M src/foo.ts\n M src/bar.js\n D src/gone.ts\n?? notes.md\n',
      stderr: '',
    },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.equal(result.error, undefined);
  const byPath = Object.fromEntries(result.files.map((f) => [f.relativePath, f]));

  assert.deepEqual(byPath['src/foo.ts'], {
    relativePath: 'src/foo.ts', status: 'M', additions: 12, deletions: 3, binary: false,
  });
  assert.deepEqual(byPath['src/bar.js'], {
    relativePath: 'src/bar.js', status: 'M', additions: 1, deletions: 18, binary: false,
  });
  assert.deepEqual(byPath['src/gone.ts'], {
    relativePath: 'src/gone.ts', status: 'D', additions: 0, deletions: 9, binary: false,
  });
  // Untracked: present in porcelain only → status '?', null counts.
  assert.deepEqual(byPath['notes.md'], {
    relativePath: 'notes.md', status: '?', additions: null, deletions: null, binary: false,
  });
});

test('getIdeChangesSummary flags binary files (numstat "-\\t-")', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': { exitCode: 0, stdout: '-\t-\tassets/logo.png\n', stderr: '' },
    'status --porcelain': { exitCode: 0, stdout: ' M assets/logo.png\n', stderr: '' },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files[0], {
    relativePath: 'assets/logo.png', status: 'M', additions: null, deletions: null, binary: true,
  });
});

test('getIdeChangesSummary surfaces renamed file as the new path with status R', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': { exitCode: 0, stdout: '5\t2\tsrc/new-name.ts\n', stderr: '' },
    'status --porcelain': { exitCode: 0, stdout: 'R  src/old-name.ts -> src/new-name.ts\n', stderr: '' },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files[0], {
    relativePath: 'src/new-name.ts', status: 'R', additions: 5, deletions: 2, binary: false,
  });
});

test('getIdeChangesSummary returns empty files when nothing changed', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': { exitCode: 0, stdout: '', stderr: '' },
    'status --porcelain': { exitCode: 0, stdout: '', stderr: '' },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files, []);
  assert.equal(result.error, undefined);
});

test('getIdeChangesSummary returns graceful error on git failure (non-git dir)', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': {
      exitCode: 128, stdout: '', stderr: 'fatal: not a git repository',
    },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files, []);
  assert.match(result.error, /not a git repository/);
});

test('getIdeChangesSummary returns graceful error when source resolution throws', () => {
  const result = getIdeChangesSummary({
    projectCwd: undefined, taskBoard: null, teamId: 'team-a',
    source: { kind: 'project' }, runGit: fakeRunGit({}),
  });
  assert.deepEqual(result.files, []);
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

test('getIdeChangesSummary reports a staged-added file as status A with counts', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': { exitCode: 0, stdout: '7\t0\tsrc/added.ts\n', stderr: '' },
    'status --porcelain': { exitCode: 0, stdout: 'A  src/added.ts\n', stderr: '' },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files[0], {
    relativePath: 'src/added.ts', status: 'A', additions: 7, deletions: 0, binary: false,
  });
});
