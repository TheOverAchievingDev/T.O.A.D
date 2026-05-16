import test from 'node:test';
import assert from 'node:assert/strict';
import { touchesDeclaredSurface } from '../../../src/drift/llm/silentSignificance.js';

const mods = [
  { kind: 'module', name: 'sampler', evidence: 'src/sampler.rs' },
  { kind: 'module', name: 'win', evidence: 'src/win/procs.rs' },
];

test('a changed file matching a declared module → true', () => {
  assert.equal(touchesDeclaredSurface(['src/sampler.rs'], mods), true);
});
test('a changed file under a declared module directory → true', () => {
  assert.equal(touchesDeclaredSurface(['src/sampler/core.rs'], mods), true);
});
test('no changed file maps to any declared module → false', () => {
  assert.equal(touchesDeclaredSurface(['README.md', 'src/other.rs'], mods), false);
});
test('non-array inputs → false (conservative)', () => {
  assert.equal(touchesDeclaredSurface(null, mods), false);
  assert.equal(touchesDeclaredSurface(['a'], null), false);
});

import { meetsMagnitudeFloor } from '../../../src/drift/llm/silentSignificance.js';

const declared = (f) => f === 'src/sampler.rs';

function diff(lines) { return lines.join('\n'); }

test('counts +/- content lines in declared files, >= floor → true', () => {
  const body = diff([
    'diff --git a/src/sampler.rs b/src/sampler.rs',
    '--- a/src/sampler.rs', '+++ b/src/sampler.rs',
    '@@ -1,2 +1,4 @@',
    '+let a = 1;', '+let b = 2;', '+let c = 3;', '-old();',
  ]);
  assert.equal(meetsMagnitudeFloor(body, declared, 4), true);
  assert.equal(meetsMagnitudeFloor(body, declared, 5), false, 'N=4 < floor 5');
});
test('lines in NON-declared files do not count', () => {
  const body = diff([
    'diff --git a/src/other.rs b/src/other.rs',
    '--- a/src/other.rs', '+++ b/src/other.rs',
    '@@ -1 +1,9 @@',
    '+1', '+2', '+3', '+4', '+5', '+6', '+7', '+8', '+9',
  ]);
  assert.equal(meetsMagnitudeFloor(body, declared, 1), false);
});
test('whitespace-only +/- lines excluded; comments INCLUDED (ruled)', () => {
  const body = diff([
    '+++ b/src/sampler.rs', '@@ -1 +1,4 @@',
    '+   ',            // whitespace-only — excluded
    '-\t',             // whitespace-only — excluded
    '+// a real comment line counts', // comment — INCLUDED
    '+// another comment',            // comment — INCLUDED
  ]);
  assert.equal(meetsMagnitudeFloor(body, declared, 2), true, 'comments count: 2');
  assert.equal(meetsMagnitudeFloor(body, declared, 3), false, 'only 2 non-ws lines');
});
test('binary-file section contributes zero', () => {
  const body = diff([
    'diff --git a/src/sampler.rs b/src/sampler.rs',
    'Binary files a/src/sampler.rs and b/src/sampler.rs differ',
  ]);
  assert.equal(meetsMagnitudeFloor(body, declared, 1), false);
});
test('+++ /dev/null (deletion) attributes nothing; floor clamps < 1 → 1', () => {
  const body = diff(['+++ /dev/null', '@@ -1 +0,0 @@', '-gone']);
  assert.equal(meetsMagnitudeFloor(body, declared, 0), false, 'dev/null not declared; floor clamped to 1');
  assert.equal(meetsMagnitudeFloor('', declared, 5), false, 'empty diff → false');
  assert.equal(meetsMagnitudeFloor(null, declared, 5), false, 'non-string → false');
});
test('floor non-finite → default 10', () => {
  const body = diff(['+++ b/src/sampler.rs', '@@ @@'].concat(
    Array.from({ length: 10 }, (_, i) => `+line ${i}`)));
  assert.equal(meetsMagnitudeFloor(body, declared, undefined), true, '10 lines == default floor 10');
  const nine = diff(['+++ b/src/sampler.rs', '@@ @@'].concat(
    Array.from({ length: 9 }, (_, i) => `+line ${i}`)));
  assert.equal(meetsMagnitudeFloor(nine, declared, undefined), false, '9 < default 10');
});

import { countDeclaredChangedLines } from '../../../src/drift/llm/silentSignificance.js';
test('countDeclaredChangedLines: declared-only, ws-excluded, comment-included, binary-zero', () => {
  const body = diff([
    '+++ b/src/sampler.rs', '@@ @@', '+a=1;', '+// c', '+   ',
    '+++ b/src/other.rs', '@@ @@', '+ignored=1;',
  ]);
  assert.equal(countDeclaredChangedLines(body, declared), 2, 'a=1; + // c ; ws & non-declared excluded');
});
test('git C-quoted +++ path (spaces/special chars) still attributes to the declared file', () => {
  const body = diff([
    'diff --git "a/src/sampler.rs" "b/src/sampler.rs"',
    '--- "a/src/sampler.rs"', '+++ "b/src/sampler.rs"',
    '@@ -1 +1,2 @@', '+let a = 1;', '+let b = 2;',
  ]);
  assert.equal(countDeclaredChangedLines(body, declared), 2,
    'quoted post-image header must unquote so the declared file matches');
  assert.equal(meetsMagnitudeFloor(body, declared, 2), true);
});

import { silentButSignificant } from '../../../src/drift/llm/silentSignificance.js';
import { checkStructuralUndeclaredPresent } from '../../../src/drift/checks/checkStructuralUndeclaredPresent.js';

const SPEC = {
  version: 1,
  structure: { required: [{ kind: 'module', name: 'sampler', evidence: 'src/sampler.rs' }] },
  provenance: { reviewed: true },
};
function snap({ changedFiles = [], body = '', error = null, floor = 10, taskId = 'T1' } = {}) {
  return {
    snapshot: {
      teamId: 't', spec: SPEC, l3SilentMagnitudeFloor: floor,
      diffsByTask: { [taskId]: { changedFiles, diff: body, error } },
    },
    boundaryTaskId: taskId,
  };
}
const bigDeclared = (n) => ['+++ b/src/sampler.rs', '@@ @@']
  .concat(Array.from({ length: n }, (_, i) => `+x${i}=1;`)).join('\n');

test('no diff entry / diff error / non-string diff → false', () => {
  assert.equal(silentButSignificant({ snapshot: { spec: SPEC }, boundaryTaskId: 'T1' }), false);
  assert.equal(silentButSignificant(snap({ changedFiles: ['src/sampler.rs'], error: 'boom' })), false);
  assert.equal(silentButSignificant(snap({ changedFiles: ['src/sampler.rs'], body: 42 })), false);
});
test('declared surface + magnitude >= floor → true', () => {
  assert.equal(silentButSignificant(snap({ changedFiles: ['src/sampler.rs'], body: bigDeclared(10) })), true);
});
test('declared surface but below floor → false', () => {
  assert.equal(silentButSignificant(snap({ changedFiles: ['src/sampler.rs'], body: bigDeclared(9) })), false);
});
test('non-declared file, large change → false', () => {
  const body = ['+++ b/README.md', '@@ @@'].concat(Array.from({ length: 50 }, () => '+x')).join('\n');
  assert.equal(silentButSignificant(snap({ changedFiles: ['README.md'], body })), false);
});
test('no module entries declared → false', () => {
  const s = snap({ changedFiles: ['src/sampler.rs'], body: bigDeclared(10) });
  s.snapshot.spec = { version: 1, structure: { required: [] }, provenance: { reviewed: true } };
  assert.equal(silentButSignificant(s), false);
});
test('comment-only ≥ floor on a declared file → true (documented limitation)', () => {
  const body = ['+++ b/src/sampler.rs', '@@ @@']
    .concat(Array.from({ length: 10 }, (_, i) => `+// comment ${i}`)).join('\n');
  assert.equal(silentButSignificant(snap({ changedFiles: ['src/sampler.rs'], body })), true);
});

test('LOCKSTEP: touchesDeclaredSurface agrees with L1.2 on every (file,module) row', () => {
  const moduleEntries = SPEC.structure.required;
  const cases = ['src/sampler.rs', 'src/sampler/core.rs', 'src/other.rs', 'README.md', 'src/sampler.test.rs'];
  for (const f of cases) {
    const l1Undeclared = checkStructuralUndeclaredPresent({
      snapshot: { teamId: 't', spec: SPEC, sourceModules: [f] },
    }).some((x) => x.title === `Undeclared source module: ${f.replace(/\\/g, '/')}`);
    const sliceBdeclared = touchesDeclaredSurface([f], moduleEntries);
    assert.equal(sliceBdeclared, !l1Undeclared,
      `divergence on ${f}: L1.2 undeclared=${l1Undeclared} vs Slice-B declared=${sliceBdeclared}`);
  }
});
