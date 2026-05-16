import test from 'node:test';
import assert from 'node:assert/strict';
import { constitutionMergeGate } from '../../../src/drift/checks/constitutionMergeGate.js';

function fakeRunGit(table) {
  return (args) => {
    for (const [prefix, result] of table) {
      if (prefix.length <= args.length && prefix.every((v, i) => v === args[i])) return result;
    }
    return { exitCode: 127, stdout: '', stderr: 'no matcher' };
  };
}

const REVIEWED = { reviewed: true, extracted_by: 'hand', source_docs: ['docs/foundry/steering.md'] };
function spec({ rules, reviewed = true }) {
  return { version: 1, provenance: reviewed ? { ...REVIEWED } : { ...REVIEWED, reviewed: false }, constitution: { rules } };
}
const GATE_RULE = {
  id: 'no-sedebug', description: 'Never request SeDebugPrivilege',
  detector: { type: 'grep', pattern: 'SeDebugPrivilege' }, severity: 'critical', mode: 'gate',
};

function readFileSyncImpl(map) {
  return (abs) => {
    const rel = abs.replace(/\\/g, '/').replace('/wt/', '');
    if (!(rel in map)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return map[rel];
  };
}

test('introduced violation (worktree-only) → blocked, listed', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'M\tsrc/p.rs\n', stderr: '' }],
    [['show', 'main:src/p.rs'], { exitCode: 0, stdout: 'fn ok() {}\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/p.rs': 'fn ok() {}\nenable(SeDebugPrivilege);\n' }),
  });
  assert.equal(r.blocked, true);
  assert.equal(r.introduced.length, 1);
  assert.equal(r.introduced[0].ruleId, 'no-sedebug');
  assert.equal(r.introduced[0].file, 'src/p.rs');
  assert.equal(r.introduced[0].line, 2);
  assert.equal(r.preexisting.length, 0);
  assert.equal(r.scanError, null);
});

test('preexisting violation (in worktree AND trunk) → NOT blocked, observer-listed', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'M\tsrc/p.rs\n', stderr: '' }],
    [['show', 'main:src/p.rs'], { exitCode: 0, stdout: 'enable(SeDebugPrivilege);\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/p.rs': 'let added=1;\nenable(SeDebugPrivilege);\n' }),
  });
  assert.equal(r.blocked, false);
  assert.equal(r.introduced.length, 0);
  assert.equal(r.preexisting.length, 1, 'still surfaced as observer finding');
});

test('line added ABOVE a preexisting violation → still preexisting (content-matched, not line#)', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'M\tsrc/p.rs\n', stderr: '' }],
    [['show', 'main:src/p.rs'], { exitCode: 0, stdout: 'a();\nenable(SeDebugPrivilege);\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/p.rs': 'a();\nnewline();\nenable(SeDebugPrivilege);\n' }),
  });
  assert.equal(r.blocked, false, 'shifted line is the SAME violation, not a new one');
  assert.equal(r.preexisting.length, 1);
});

test('added file (status A) with a violation → blocked, NO trunk show attempted', () => {
  const calls = [];
  const runGit = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'diff') return { exitCode: 0, stdout: 'A\tsrc/new.rs\n', stderr: '' };
    return { exitCode: 128, stdout: '', stderr: 'fatal: path does not exist' };
  };
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/new.rs': 'enable(SeDebugPrivilege);\n' }),
  });
  assert.equal(r.blocked, true);
  assert.equal(r.introduced.length, 1);
  assert.ok(!calls.some((c) => c.startsWith('show ')), 'no git show for an added file');
});

test('violation in a file OUTSIDE the changed set → ignored entirely', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'M\tsrc/other.rs\n', stderr: '' }],
    [['show', 'main:src/other.rs'], { exitCode: 0, stdout: 'clean\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/other.rs': 'clean\n', 'src/p.rs': 'enable(SeDebugPrivilege);\n' }),
  });
  assert.equal(r.blocked, false);
  assert.deepEqual(r.introduced, []);
});

test('binary changed file → skipped (no false hit)', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'A\tassets/logo.png\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'assets/logo.png': 'SeDebugPrivilege-lookalike-bytes' }),
  });
  assert.equal(r.blocked, false);
});

test('unreviewed spec → never blocks (info tier)', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'A\tsrc/p.rs\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE], reviewed: false }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/p.rs': 'enable(SeDebugPrivilege);\n' }),
  });
  assert.equal(r.blocked, false);
});

test('reviewed flag is re-read each call (flip true→false respected)', () => {
  const s = spec({ rules: [GATE_RULE] });
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'A\tsrc/p.rs\n', stderr: '' }],
  ]);
  const args = {
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main', spec: s, runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/p.rs': 'enable(SeDebugPrivilege);\n' }),
  };
  assert.equal(constitutionMergeGate(args).blocked, true);
  s.provenance.reviewed = false;
  assert.equal(constitutionMergeGate(args).blocked, false, 'no stale cache');
});

test('no mode:gate rules → fast no-op (never blocks, no git calls)', () => {
  let called = false;
  const runGit = () => { called = true; return { exitCode: 0, stdout: '', stderr: '' }; };
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [{ ...GATE_RULE, mode: 'observe' }] }), runGit,
    readFileSyncImpl: () => '',
  });
  assert.equal(r.blocked, false);
  assert.equal(called, false, 'no diff issued when nothing can gate');
});

test('git diff failure on a MODIFIED file → fail-open, not blocked, scanError populated', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 128, stdout: '', stderr: 'fatal: bad revision' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit, readFileSyncImpl: () => '',
  });
  assert.equal(r.blocked, false);
  assert.ok(r.scanError && /bad revision|diff/.test(r.scanError.message));
  assert.ok(r.scanError.command.includes('diff'));
});

test('multiple introduced violations → all listed', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'A\tsrc/a.rs\nA\tsrc/b.rs\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [GATE_RULE] }), runGit,
    readFileSyncImpl: readFileSyncImpl({ 'src/a.rs': 'enable(SeDebugPrivilege);\n', 'src/b.rs': 'x();\nSeDebugPrivilege\n' }),
  });
  assert.equal(r.blocked, true);
  assert.equal(r.introduced.length, 2);
});

test('unsupported detector among gate rules → recorded, does not crash, does not block on it', () => {
  const runGit = fakeRunGit([
    [['diff', '--name-status', 'main..HEAD'], { exitCode: 0, stdout: 'A\tsrc/p.rs\n', stderr: '' }],
  ]);
  const r = constitutionMergeGate({
    projectCwd: '/proj', worktreePath: '/wt', baseRef: 'main',
    spec: spec({ rules: [{ id: 'ast-x', detector: { type: 'ast' }, mode: 'gate', severity: 'critical' }] }),
    runGit, readFileSyncImpl: readFileSyncImpl({ 'src/p.rs': 'whatever\n' }),
  });
  assert.equal(r.blocked, false);
  assert.deepEqual(r.unsupported, ['ast-x']);
});
