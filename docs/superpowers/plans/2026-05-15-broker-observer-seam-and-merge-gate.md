# Broker Observer Seam + Constitution Merge Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Symphony's drift system its first capability that genuinely blocks bad code from landing — a constitution merge gate that fires only on violations *this* merge introduces — plus the broker observer seam substrate, without ever wolf-crying.

**Architecture:** Two independent slices. Slice 1 adds a fourth synchronous gate to the existing `localToolFacade.#taskUpdate` `merge_ready → done` chain, immediately before `mergeIntegrator.integrate()`; it diffs the branch against trunk via injected `runGit`, applies `mode:'gate'` constitution rules through a shared `evalConstitutionRule` helper, and throws (blocking the merge) only for newly-introduced violations. Slice 2 adds `subscribe(fn)` to both broker implementations, mirroring `SqliteTaskBoard.subscribe` verbatim. The slices share no code.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, `node:sqlite` (`DatabaseSync`), zero new dependencies. Reference design: `docs/superpowers/specs/2026-05-15-broker-observer-seam-and-merge-gate-design.md`.

---

## File Structure

**Slice 1 — constitution merge gate:**
- Create `src/drift/spec/evalConstitutionRule.js` — pure per-content rule detector (grep + path_presence + comment-strip), the single source of truth scanConstitution AND the gate both call.
- Create `src/drift/spec/isTextFile.js` — pure binary/text classifier (extension set + optional `git check-attr binary`), the single source of truth for "scan this file?".
- Create `src/drift/checks/constitutionMergeGate.js` — the gate unit: diff branch vs trunk, classify introduced vs preexisting, return `{ blocked, introduced, preexisting, scanError }`.
- Modify `src/drift/spec/scanConstitution.js` — route detection through `evalConstitutionRule` and binary-skip through `isTextFile` (no behavior change; characterization-tested).
- Modify `src/tools/localToolFacade.js` — call `constitutionMergeGate` as the 4th gate in `#taskUpdate` `merge_ready → done`, before `mergeIntegrator.integrate()`; emit the fail-open observer finding; throw the structured rejection.
- Modify `src/team/teamSystemPrompts.js` — one line naming the constitution gate.
- Modify `PROJECT.md` — §8b doctrine rewrite.
- Modify `C:/Users/Nova_/Downloads/New folder (6)/docs/foundry/spec.json` — seed one `mode:'gate'` rule (dogfood only; not in repo).
- Test: `test/drift/spec/evalConstitutionRule.test.js`, `test/drift/spec/isTextFile.test.js`, `test/drift/checks/constitutionMergeGate.test.js`, plus a merge-gate integration test appended to `test/localToolFacade.test.js`.
- Modify `package.json` — wire the new test files into the `test` script.

**Slice 2 — broker observer seam:**
- Modify `src/broker/inMemoryBroker.js` — `#subscribers`, `subscribe(fn)`, fire after successful `appendMessage`.
- Modify `src/broker/sqliteBroker.js` — same, symmetric.
- Test: `test/brokerSubscribe.test.js` — one file, assertions run against BOTH brokers.
- Modify `package.json` — wire the new test file.

---

## SLICE 1 — Constitution Merge Gate (ship first)

### Task 1: Verify `computeDiff` change-type availability (§8a item 1)

**Files:**
- Read: `src/task/diffComputer.js`

- [ ] **Step 1: Inspect `computeDiff`'s return shape**

Run: `node -e "import('./src/task/diffComputer.js').then(m=>console.log(m.computeDiff.toString()))"`
Expected: confirms `computeDiff` runs `git diff <range> --name-only` and returns `{ diff, files }` — **no per-file change type (added vs modified)**.

- [ ] **Step 2: Record the decision**

`computeDiff` does NOT expose change type and is consumed by many drift sites — do NOT extend it. `constitutionMergeGate` will issue its own `git diff --name-status <baseRef>..HEAD` via injected `runGit` (status letters: `A`=added, `M`=modified, `D`=deleted, `R###`=renamed). This keeps the gate's git interaction self-contained and `computeDiff`'s contract untouched. No code change in this task; this decision is implemented in Task 4.

- [ ] **Step 3: Commit (decision note only — no code)**

Skip commit; this is a verification gate for Task 4. Proceed.

---

### Task 2: Extract `evalConstitutionRule` shared helper

**Files:**
- Create: `src/drift/spec/evalConstitutionRule.js`
- Test: `test/drift/spec/evalConstitutionRule.test.js`
- Modify: `src/drift/spec/scanConstitution.js`

- [ ] **Step 1: Write the failing test**

Create `test/drift/spec/evalConstitutionRule.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { evalConstitutionRule } from '../../../src/drift/spec/evalConstitutionRule.js';

const GREP = { id: 'no-sedebug', detector: { type: 'grep', pattern: 'SeDebugPrivilege' } };

test('grep: returns ALL hits per content, with 1-based line + snippet', () => {
  const content = 'fn a() {}\nenable(SeDebugPrivilege);\nlet x=1;\ncall(SeDebugPrivilege);\n';
  const hits = evalConstitutionRule(GREP, { path: 'src/p.rs', content });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.line), [2, 4]);
  assert.match(hits[0].snippet, /SeDebugPrivilege/);
});

test('grep: comment-only match is suppressed (reuses comment strip)', () => {
  const content = '// no SeDebugPrivilege required per ADR-004\nok();\n';
  assert.deepEqual(evalConstitutionRule(GREP, { path: 'src/p.rs', content }), []);
});

test('grep: real code before a trailing comment still hits', () => {
  const content = 'enable("SeDebugPrivilege"); // bad\n';
  const hits = evalConstitutionRule(GREP, { path: 'src/p.rs', content });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('grep: exclude_paths suppresses the rule for matching paths', () => {
  const rule = { id: 'r', detector: { type: 'grep', pattern: 'X', exclude_paths: ['tests/**'] } };
  assert.deepEqual(evalConstitutionRule(rule, { path: 'tests/a.rs', content: 'X\n' }), []);
  assert.equal(evalConstitutionRule(rule, { path: 'src/a.rs', content: 'X\n' }).length, 1);
});

test('path_presence: hit iff the path matches a forbidden glob (content ignored)', () => {
  const rule = { id: 'no-exe', detector: { type: 'path_presence', forbidden_paths: ['**/*.exe'] } };
  const hits = evalConstitutionRule(rule, { path: 'bin/reaper.exe', content: '' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 0);
  assert.deepEqual(evalConstitutionRule(rule, { path: 'src/main.rs', content: 'x' }), []);
});

test('unsupported detector type → null (caller records unsupported, never silent pass)', () => {
  assert.equal(evalConstitutionRule({ id: 'a', detector: { type: 'ast' } }, { path: 'x', content: 'y' }), null);
});

test('invalid grep regex → null (fail-soft, caller records unsupported)', () => {
  assert.equal(evalConstitutionRule({ id: 'b', detector: { type: 'grep', pattern: '([' } }, { path: 'x.rs', content: 'y' }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings --test test/drift/spec/evalConstitutionRule.test.js`
Expected: FAIL — `Cannot find module .../evalConstitutionRule.js`.

- [ ] **Step 3: Create the helper**

Create `src/drift/spec/evalConstitutionRule.js`. This lifts scanConstitution's existing per-line detector logic verbatim (comment strip, grep regex, path_presence glob, exclude_paths) into a pure function. Returns `hit[]` for a supported rule, `[]` for no match, `null` for an unsupported/uncompilable detector (so the caller records it as unsupported — never a silent pass):

```javascript
const CLIKE_EXT = /\.(rs|js|jsx|ts|tsx|mjs|cjs|go|java|kt|c|h|cpp|hpp|cs|swift|gradle|css|scss)$/i;
const HASH_EXT = /\.(toml|py|sh|bash|zsh|yaml|yml|ini|cfg|env|properties|conf)$/i;

function stripComments(line, path) {
  if (CLIKE_EXT.test(path)) {
    let s = line.replace(/\/\*[\s\S]*?\*\//g, ' ');
    s = s.replace(/(^|[^:])\/\/.*$/, '$1');
    return s;
  }
  if (HASH_EXT.test(path)) return line.replace(/#.*$/, '');
  return line;
}

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else if (c === '?') re += '[^/]';
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) continue;
    try { if (globToRe(g).test(path)) return true; } catch { /* skip bad glob */ }
  }
  return false;
}

/**
 * Evaluate ONE constitution rule against ONE file's content.
 * Single source of truth shared by scanConstitution (whole-tree) and
 * constitutionMergeGate (diff-scoped).
 *
 * @returns {Array<{line:number,snippet:string}>|null}
 *   array (possibly empty) of ALL hits for a supported rule;
 *   null = unsupported detector type OR uncompilable regex (caller
 *   records it as "not enforced" — never treat null as "clean").
 */
export function evalConstitutionRule(rule, { path, content }) {
  const t = rule && rule.detector && rule.detector.type;
  if (t === 'path_presence') {
    if (matchesAny(path, rule.detector.forbidden_paths)) {
      return [{ line: 0, snippet: `forbidden path present: ${path}` }];
    }
    return [];
  }
  if (t === 'grep') {
    if (matchesAny(path, rule.detector.exclude_paths)) return [];
    let re;
    try { re = new RegExp(rule.detector.pattern); } catch { return null; }
    const hits = [];
    const lines = String(content ?? '').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripComments(lines[i], path);
      if (code.length === 0) continue;
      re.lastIndex = 0;
      if (re.test(code)) hits.push({ line: i + 1, snippet: lines[i].trim().slice(0, 200) });
    }
    return hits;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings --test test/drift/spec/evalConstitutionRule.test.js`
Expected: PASS, 7/7.

- [ ] **Step 5: Refactor `scanConstitution` to call the shared helper (no behavior change)**

In `src/drift/spec/scanConstitution.js`, replace the inline grep/path_presence per-file logic with `evalConstitutionRule`. Add the import at the top:

```javascript
import { evalConstitutionRule } from './evalConstitutionRule.js';
```

In the file-scan loop, replace the per-line grep block and the `path_presence` block with: for each applicable rule call `const hits = evalConstitutionRule(rule, { path: rel, content })`. If `hits === null`, push the rule id to `out.unsupportedRules` (preserving the existing "honest not-enforced" behavior). Otherwise for each hit push `{ ruleId: rule.id ?? '(unnamed)', file: rel, line: hit.line, snippet: hit.snippet }` to `out.hits`. Keep the existing rule-bucketing, regex pre-compile-failure → `unsupportedRules`, IGNORED_DIRS, EXCLUDE_PATH_PREFIXES, caps, and fail-soft wrappers unchanged.

- [ ] **Step 6: Run the full scanConstitution + checkConstitution suites — characterization (must stay green)**

Run: `node --no-warnings --test test/drift/spec/scanConstitution.test.js test/drift/checks/checkConstitution.test.js`
Expected: PASS, all green (17 + 10). The refactor is behavior-preserving; existing tests are the characterization safety net.

- [ ] **Step 7: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/drift/spec/evalConstitutionRule.js toad-local/test/drift/spec/evalConstitutionRule.test.js toad-local/src/drift/spec/scanConstitution.js
git -C /c/Project-TOAD commit -m "refactor(drift): extract evalConstitutionRule — one detector, two consumers"
```

---

### Task 3: Extract `isTextFile` shared helper

**Files:**
- Create: `src/drift/spec/isTextFile.js`
- Test: `test/drift/spec/isTextFile.test.js`
- Modify: `src/drift/spec/scanConstitution.js`

- [ ] **Step 1: Write the failing test**

Create `test/drift/spec/isTextFile.test.js`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings --test test/drift/spec/isTextFile.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the helper**

Create `src/drift/spec/isTextFile.js`. Combines scanConstitution's existing `TEXT_EXT` allow-list (the strict signal) with an optional `git check-attr binary` override. Unknown extension → `false` (conservative: a maybe-binary is never scanned, so a rule can't false-hit a base64 PNG chunk):

```javascript
const TEXT_EXT = /\.(rs|toml|js|jsx|ts|tsx|mjs|cjs|json|md|txt|py|go|java|kt|rb|c|h|cpp|hpp|cs|swift|sh|bat|ps1|yaml|yml|cfg|ini|env|manifest|xml|html|css|sql|gradle|properties|lock)$/i;

/**
 * Single source of truth for "should a detector scan this file?".
 * Both scanConstitution (whole-tree) and constitutionMergeGate
 * (diff-scoped) route binary decisions through this — the stricter
 * check is used everywhere; the two paths cannot drift.
 *
 * @param {string} path  repo-relative path
 * @param {{runGit?:Function, projectCwd?:string}} [opts]
 *   when runGit+projectCwd are given, `git check-attr binary` can
 *   force a non-text verdict for generated/vendored blobs.
 * @returns {boolean}
 */
export function isTextFile(path, { runGit = null, projectCwd = null } = {}) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (!TEXT_EXT.test(path)) return false;
  if (typeof runGit === 'function' && typeof projectCwd === 'string') {
    try {
      const r = runGit(['check-attr', 'binary', '--', path], { cwd: projectCwd });
      if (r && r.exitCode === 0 && /:\s*binary:\s*set\b/.test(String(r.stdout || ''))) {
        return false;
      }
    } catch { /* check-attr unavailable → fall back to extension verdict */ }
  }
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings --test test/drift/spec/isTextFile.test.js`
Expected: PASS, 5/5.

- [ ] **Step 5: Route scanConstitution's binary skip through `isTextFile`**

In `src/drift/spec/scanConstitution.js` add `import { isTextFile } from './isTextFile.js';`. Replace the existing `if (!TEXT_EXT.test(name)) continue;` line in the walk with `if (!isTextFile(rel)) continue;` (use the repo-relative `rel`, not `name`, so extension logic is identical and future check-attr wiring works). Leave scanConstitution's local `TEXT_EXT` const removed only if now unused; otherwise leave it (YAGNI — don't churn).

- [ ] **Step 6: Run the scanConstitution suite — characterization**

Run: `node --no-warnings --test test/drift/spec/scanConstitution.test.js`
Expected: PASS, 17/17 (behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/drift/spec/isTextFile.js toad-local/test/drift/spec/isTextFile.test.js toad-local/src/drift/spec/scanConstitution.js
git -C /c/Project-TOAD commit -m "refactor(drift): extract isTextFile — shared binary skip, no asymmetry"
```

---

### Task 4: The `constitutionMergeGate` unit

**Files:**
- Create: `src/drift/checks/constitutionMergeGate.js`
- Test: `test/drift/checks/constitutionMergeGate.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/drift/checks/constitutionMergeGate.test.js`. `fakeRunGit` mirrors `test/mergeIntegrator.test.js`. `vfsRead` simulates reading the worktree file (the "would-be-merged" content); `git show <baseRef>:<file>` is stubbed via the runGit table:

```javascript
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
  return { version: 1, provenance: reviewed ? REVIEWED : { ...REVIEWED, reviewed: false }, constitution: { rules } };
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings --test test/drift/checks/constitutionMergeGate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the gate unit**

Create `src/drift/checks/constitutionMergeGate.js`:

```javascript
import { readFileSync as realReadFileSync } from 'node:fs';
import { runGit as realRunGit } from '../../git/runGit.js';
import { evalConstitutionRule } from '../spec/evalConstitutionRule.js';
import { isTextFile } from '../spec/isTextFile.js';

/**
 * L1.3 gate enforcement at the merge boundary. Diff-scoped: blocks
 * ONLY violations THIS branch introduces vs trunk. Preexisting trunk
 * violations are surfaced (observer) but never block. See
 * docs/superpowers/specs/2026-05-15-broker-observer-seam-and-merge-gate-design.md.
 *
 * Returns:
 *   { blocked, introduced[], preexisting[], unsupported[],
 *     scanError: { command, file, message } | null }
 * introduced/preexisting items: { ruleId, file, line, snippet, description }
 *
 * Fail-OPEN: any scan/git error → blocked:false + scanError populated
 * (the caller emits a loud non-blocking observer finding). A scanner
 * bug must never wedge every team merge.
 */
export function constitutionMergeGate({
  projectCwd,
  worktreePath,
  baseRef,
  spec,
  runGit = realRunGit,
  readFileSyncImpl = realReadFileSync,
} = {}) {
  const out = { blocked: false, introduced: [], preexisting: [], unsupported: [], scanError: null };

  const reviewed = spec && spec.provenance && spec.provenance.reviewed === true;
  const rules = spec && spec.constitution && Array.isArray(spec.constitution.rules)
    ? spec.constitution.rules.filter((r) => r && r.mode === 'gate'
        && typeof r.id === 'string' && r.id.length > 0)
    : [];
  // Two-key: only a ratified spec + a gate-mode rule can ever block.
  if (!reviewed || rules.length === 0) return out;
  if (typeof projectCwd !== 'string' || typeof worktreePath !== 'string'
      || typeof baseRef !== 'string' || baseRef.length === 0) {
    return out;
  }

  // Changed files + status (A/M/D/R) — our own name-status call so we
  // know added-vs-modified (computeDiff only exposes --name-only).
  let diff;
  try {
    diff = runGit(['diff', '--name-status', `${baseRef}..HEAD`], { cwd: worktreePath });
  } catch (err) {
    out.scanError = { command: `git diff --name-status ${baseRef}..HEAD`, file: null, message: String(err && err.message ? err.message : err) };
    return out; // fail-open
  }
  if (!diff || diff.exitCode !== 0) {
    out.scanError = { command: `git diff --name-status ${baseRef}..HEAD`, file: null, message: (diff && diff.stderr) || 'git diff failed' };
    return out; // fail-open
  }

  const changed = [];
  for (const raw of String(diff.stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([ACDMRT])\S*\t(.+)$/.exec(line);
    if (!m) continue;
    const status = m[1];
    // For renames `R100\told\tnew` — take the destination path.
    const parts = line.split('\t');
    const file = parts[parts.length - 1];
    if (status === 'D') continue; // a deletion can't introduce a violation
    changed.push({ status, file });
  }

  for (const { status, file } of changed) {
    if (!isTextFile(file, { runGit, projectCwd })) continue;

    let wtContent;
    try {
      wtContent = readFileSyncImpl(`${worktreePath}/${file}`, 'utf-8');
    } catch {
      continue; // file unreadable in worktree (e.g. submodule) — skip
    }

    for (const rule of rules) {
      const wtHits = evalConstitutionRule(rule, { path: file, content: wtContent });
      if (wtHits === null) {
        if (!out.unsupported.includes(rule.id)) out.unsupported.push(rule.id);
        continue;
      }
      if (wtHits.length === 0) continue;

      // Added file: no trunk version exists — every hit is introduced.
      if (status === 'A') {
        for (const h of wtHits) {
          out.introduced.push({ ruleId: rule.id, file, line: h.line, snippet: h.snippet, description: rule.description || '' });
        }
        continue;
      }

      // Modified file: classify each hit against the trunk blob.
      let baseContent = null;
      let showErrored = false;
      try {
        const show = runGit(['show', `${baseRef}:${file}`], { cwd: projectCwd });
        if (show && show.exitCode === 0) baseContent = String(show.stdout || '');
        else showErrored = true;
      } catch (err) {
        showErrored = true;
        out.scanError = { command: `git show ${baseRef}:${file}`, file, message: String(err && err.message ? err.message : err) };
      }
      if (showErrored && baseContent === null) {
        // Could not read trunk side of a MODIFIED file → fail-open for
        // this file (do not guess). scanError already records why if
        // it threw; a non-zero exit (file new-to-baseRef despite 'M')
        // is rare — treat conservatively as fail-open, not a block.
        if (!out.scanError) {
          out.scanError = { command: `git show ${baseRef}:${file}`, file, message: 'git show non-zero (trunk side unavailable)' };
        }
        continue;
      }
      const baseHits = baseContent === null ? [] : (evalConstitutionRule(rule, { path: file, content: baseContent }) || []);
      // Match by NORMALIZED LINE CONTENT, not line number — a line
      // added above shifts numbers but the violation is the same one.
      const baseSnippets = new Set(baseHits.map((h) => h.snippet.trim()));
      for (const h of wtHits) {
        const item = { ruleId: rule.id, file, line: h.line, snippet: h.snippet, description: rule.description || '' };
        if (baseSnippets.has(h.snippet.trim())) out.preexisting.push(item);
        else out.introduced.push(item);
      }
    }
  }

  out.blocked = out.introduced.length > 0;
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings --test test/drift/checks/constitutionMergeGate.test.js`
Expected: PASS, 12/12.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/drift/checks/constitutionMergeGate.js toad-local/test/drift/checks/constitutionMergeGate.test.js
git -C /c/Project-TOAD commit -m "feat(drift): constitutionMergeGate unit — diff-scoped, fail-open"
```

---

### Task 5: Wire the gate into `#taskUpdate` (4th gate before integrate)

**Files:**
- Modify: `src/tools/localToolFacade.js` (constructor deps + the `merge_ready → done` block, before the `this.mergeIntegrator` integration step, ~line 728)
- Test: append to `test/localToolFacade.test.js`

- [ ] **Step 1: Write the failing integration test**

Append to `test/localToolFacade.test.js` (reuses the existing `buildMergeFacade` + `setupMergeReadyTask` helpers in that file). It injects a `constitutionGate` impl so the test is hermetic:

```javascript
test('merge_ready → done BLOCKED by constitution gate on an introduced violation', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({ checkForConflicts: () => ({ status: 'clean' }) });
  // Inject a gate that reports one introduced violation.
  facade.constitutionGate = () => ({
    blocked: true,
    introduced: [{ ruleId: 'no-sedebug', file: 'src/p.rs', line: 2, snippet: 'enable(SeDebugPrivilege)', description: 'Never request SeDebugPrivilege' }],
    preexisting: [], unsupported: [], scanError: null,
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'cg-blk' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN, idempotencyKey: 'cg-blk-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'cg-blk', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE, idempotencyKey: 'cg-blk-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cg-blk', status: 'merge_ready' },
  });
  let threw = null;
  try {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE, idempotencyKey: 'cg-blk-done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'cg-blk', status: 'done' },
    });
  } catch (e) { threw = e; }
  assert.ok(threw, 'merge must be blocked');
  assert.match(threw.message, /blocked by constitution gate/);
  assert.match(threw.message, /no-sedebug/);
  assert.ok(Array.isArray(threw.constitutionGate), 'structured payload present');
  assert.equal(threw.constitutionGate[0].ruleId, 'no-sedebug');
  assert.notEqual(
    facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'cg-blk' }).status, 'done',
    'task did not transition; integrate() never reached',
  );
});

test('merge_ready → done PROCEEDS when gate reports only preexisting + emits observer finding', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({ checkForConflicts: () => ({ status: 'clean' }) });
  const observed = [];
  facade.constitutionGate = () => ({
    blocked: false, introduced: [],
    preexisting: [{ ruleId: 'no-sedebug', file: 'src/p.rs', line: 9, snippet: 'old', description: 'd' }],
    unsupported: [], scanError: null,
  });
  facade.onObserverFinding = (f) => observed.push(f);
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'cg-pre' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN, idempotencyKey: 'cg-pre-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'cg-pre', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE, idempotencyKey: 'cg-pre-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cg-pre', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE, idempotencyKey: 'cg-pre-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cg-pre', status: 'done' },
  });
  assert.equal(facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'cg-pre' }).status, 'done');
  assert.ok(observed.some((f) => f.kind === 'observer' && f.ruleId === 'no-sedebug'));
});

test('gate scanError → fail-open: merge PROCEEDS, loud observer finding carries error detail', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({ checkForConflicts: () => ({ status: 'clean' }) });
  const observed = [];
  facade.constitutionGate = () => ({
    blocked: false, introduced: [], preexisting: [], unsupported: [],
    scanError: { command: 'git diff --name-status main..HEAD', file: null, message: 'fatal: bad revision' },
  });
  facade.onObserverFinding = (f) => observed.push(f);
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'cg-err' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN, idempotencyKey: 'cg-err-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'cg-err', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE, idempotencyKey: 'cg-err-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cg-err', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE, idempotencyKey: 'cg-err-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cg-err', status: 'done' },
  });
  assert.equal(facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'cg-err' }).status, 'done');
  const errFinding = observed.find((f) => f.scanError);
  assert.ok(errFinding, 'loud observer finding emitted on scan error');
  assert.match(errFinding.scanError.message, /bad revision/);
  assert.equal(errFinding.severity, 'high');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: FAIL on the three new tests (`constitutionGate` not invoked; merge not blocked).

- [ ] **Step 3: Add the constructor wiring**

In `src/tools/localToolFacade.js` constructor, near the `this.mergeIntegrator = …` assignment (~line 127), add injectable seams (defaults to the real gate; tests override the instance fields directly as the integration test does):

```javascript
// §8b constitution merge gate (Slice 1). Injectable for tests.
// onObserverFinding: optional sink for non-blocking (preexisting /
// fail-open) findings; defaults to a console.warn so a missing sink
// is never silent.
this.constitutionGate = typeof opts.constitutionGate === 'function'
  ? opts.constitutionGate
  : defaultConstitutionGate;
this.onObserverFinding = typeof opts.onObserverFinding === 'function'
  ? opts.onObserverFinding
  : ((f) => console.warn('[drift][observer]', f.ruleId || f.scanError?.command || 'finding', f.file || ''));
```

Add the import at the top of `localToolFacade.js`:

```javascript
import { constitutionMergeGate as defaultConstitutionGate } from '../drift/checks/constitutionMergeGate.js';
```

(`opts` is the destructured constructor options object; match the existing destructuring style in that constructor — assign from the same options bag the other deps use.)

- [ ] **Step 4: Insert the gate as the 4th gate in `merge_ready → done`**

In `#taskUpdate`, immediately BEFORE the `if (fromStatus === 'merge_ready' && args.status === 'done' && this.mergeIntegrator) {` integration block (~line 728), insert:

```javascript
// §8b constitution merge gate: the 4th gate in this chain (after
// conflict + human-approval, before the actual integrate). Blocks
// ONLY violations THIS branch introduces vs trunk; preexisting and
// fail-open both flow to the observer sink and DO NOT block.
if (fromStatus === 'merge_ready' && args.status === 'done') {
  const wt = current?.worktree;
  if (wt && wt.status === 'created' && typeof wt.branch === 'string'
      && wt.branch.length > 0 && typeof wt.baseRef === 'string'
      && wt.baseRef.length > 0 && this.spec) {
    let gv;
    try {
      gv = this.constitutionGate({
        projectCwd: this.projectCwd,
        worktreePath: wt.path,
        baseRef: wt.baseRef,
        spec: this.spec,
      });
    } catch (err) {
      // The gate is itself fail-soft; this catch is last-resort
      // fail-open so a gate bug can never wedge the merge.
      gv = { blocked: false, introduced: [], preexisting: [], unsupported: [],
        scanError: { command: 'constitutionMergeGate', file: null, message: String(err && err.message ? err.message : err) } };
    }
    for (const p of gv.preexisting) {
      this.onObserverFinding({ kind: 'observer', severity: 'medium', ...p });
    }
    if (gv.scanError) {
      this.onObserverFinding({ kind: 'observer', severity: 'high', scanError: gv.scanError });
    }
    if (gv.blocked) {
      const lines = gv.introduced
        .map((i) => `  [constitution.${i.ruleId}] ${i.file}:${i.line} — ${i.description || i.snippet}`)
        .join('\n');
      const err = new Error(
        `task_update: merge_ready → done blocked by constitution gate:\n${lines}\n`
        + 'Address these and retry the merge. See docs/foundry/spec.json '
        + `constitution rule "${gv.introduced[0].ruleId}".`,
      );
      err.constitutionGate = gv.introduced.map((i) => ({
        ruleId: i.ruleId, file: i.file, line: i.line,
        specRef: `constitution.${i.ruleId}`, description: i.description || '',
      }));
      throw err;
    }
  }
}
```

Note: `this.spec` — confirm how the facade accesses the project spec. If the facade has no `spec` field, load it once via `loadProjectSpec({ projectCwd: this.projectCwd })` inside the guard (import `loadProjectSpec` from `../drift/spec/loadProjectSpec.js`); cache nothing (the reviewed flag must be re-read each call per spec §4.4). Implement whichever matches the facade's existing pattern for reading project files; the integration tests inject `constitutionGate` directly so they pass regardless, but the production path must pass a real `spec`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: PASS — all prior tests still green + the 3 new ones.

- [ ] **Step 6: Run the full suite (the facade is imported widely)**

Run: `npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END {for (k in a) print k, a[k]}'`
Expected: `fail 0`, pass count = prior total + all new tests.

- [ ] **Step 7: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/tools/localToolFacade.js toad-local/test/localToolFacade.test.js
git -C /c/Project-TOAD commit -m "feat(drift): wire constitution merge gate as 4th merge_ready→done gate"
```

---

### Task 6: Seed a `mode:'gate'` rule + dogfood on Reaper

**Files:**
- Modify: `C:/Users/Nova_/Downloads/New folder (6)/docs/foundry/spec.json` (NOT in repo — Reaper dogfood workspace)

- [ ] **Step 1: Promote one Reaper rule to gate mode**

In Reaper's `spec.json`, change the `no-sedebug-privilege` rule's `"mode": "gate"` is already set — confirm it is `gate`. Ensure `provenance.reviewed` is `true`. No other change.

- [ ] **Step 2: Dogfood the gate against a synthetic introduced violation**

Run this one-off (does not modify Reaper source):

```bash
node --input-type=module -e '
import { constitutionMergeGate } from "./src/drift/checks/constitutionMergeGate.js";
import { loadProjectSpec } from "./src/drift/spec/loadProjectSpec.js";
const projectCwd = "C:/Users/Nova_/Downloads/New folder (6)";
const { spec } = loadProjectSpec({ projectCwd });
// Stub runGit: pretend the branch added one line with SeDebugPrivilege to a new file.
const runGit = (a) => a[0]==="diff"
  ? { exitCode:0, stdout:"A\tsrc/win/evil.rs\n", stderr:"" }
  : { exitCode:128, stdout:"", stderr:"new file" };
const r = constitutionMergeGate({
  projectCwd, worktreePath: projectCwd, baseRef: "main", spec, runGit,
  readFileSyncImpl: () => "fn go(){ enable(SeDebugPrivilege); }\n",
});
console.log("blocked:", r.blocked, "introduced:", JSON.stringify(r.introduced), "scanError:", r.scanError);
'
```

Expected: `blocked: true`, one introduced hit for the SeDebugPrivilege rule, `scanError: null`. Confirms the real Reaper spec + the gate agree end-to-end.

- [ ] **Step 3: Dogfood the clean case**

Re-run Step 2 but with `readFileSyncImpl: () => "fn go(){ ok(); }\n"`.
Expected: `blocked: false`, `introduced: []`. No wolf-cry on clean introduced code.

- [ ] **Step 4: Commit (no repo change — record dogfood result in the next commit message)**

No repo files changed in this task. Proceed; the dogfood evidence is cited in Task 7's commit.

---

### Task 7: Doctrine + prompt + stale-ref sweep

**Files:**
- Modify: `PROJECT.md` (§8b)
- Modify: `src/team/teamSystemPrompts.js`

- [ ] **Step 1: Rewrite PROJECT.md §8b enforcement modes**

Replace the two-bullet "observe / gate" list and the stale "Prerequisite … SqliteBroker has no observer seam" paragraph with the final model: observe = post-`appendMessage` `subscribe` hook (findings only, never blocks); gate = the constitution merge gate at the `merge_ready → done` boundary, diff-scoped to violations this branch introduces, reviewed-spec-only, fail-open on scan error. Change the concrete-consequence sentence from "before delivery" / "block the message" to "block the merge." Add the three-tier model table (info / observer / gate) from design §2.

- [ ] **Step 2: Add the lead-prompt line**

In `src/team/teamSystemPrompts.js`, in the lead guidance (the block that already lists the merge gates / Definition of Done), add one sentence:

```
'A merge_ready → done can also be blocked by the constitution gate: if this task introduces a forbidden pattern (a gate-mode spec.json constitution rule), the merge is refused with "blocked by constitution gate" listing each violation as [constitution.<id>] <file>:<line>. Treat it like the conflict gate — have the assignee remove the introduced violation, then retry; do not work around the rule.',
```

- [ ] **Step 3: Stale-reference sweep**

Run: `grep -rn "block the message\|append→deliver\|appendMessage → DeliveryWorker" docs/ PROJECT.md src/drift/checks/checkConstitution.js`
Expected: review each hit. Update any that describe the old "gate blocks the message at append→deliver" model to the merge-gate model. The `checkConstitution.js` block comment (lines ~23-29) referencing "block the message/commit at the broker's append→deliver seam" → reword to "block the merge at the merge_ready→done constitution gate." Leave `constitutionMode` carrying behavior unchanged (still correct).

- [ ] **Step 4: Run the constitution + facade suites (comment/doc edits shouldn't break tests, but checkConstitution has tests)**

Run: `node --no-warnings --test test/drift/checks/checkConstitution.test.js && node --no-warnings test/localToolFacade.test.js 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/PROJECT.md toad-local/src/team/teamSystemPrompts.js toad-local/src/drift/checks/checkConstitution.js
git -C /c/Project-TOAD commit -m "docs(drift): §8b → block the merge; lead-prompt constitution-gate line; stale-ref sweep"
```

---

## SLICE 2 — Broker Observer Seam (ship second)

### Task 8: Verify `getMessage` on both brokers (§8a item 2)

**Files:**
- Read: `src/broker/sqliteBroker.js`, `src/broker/inMemoryBroker.js`

- [ ] **Step 1: Confirm the read method name**

Run: `grep -n "getMessage" src/broker/sqliteBroker.js src/broker/inMemoryBroker.js`
Expected: both expose `getMessage(messageId)` returning the message or `null`. (Confirmed during design exploration; this re-verifies before the durability-lock test is written so it is correct first time.) No code change.

---

### Task 9: `subscribe` on `InMemoryBroker`

**Files:**
- Modify: `src/broker/inMemoryBroker.js`
- Test: `test/brokerSubscribe.test.js`

- [ ] **Step 1: Write the failing test (parameterized over both brokers; InMemory first)**

Create `test/brokerSubscribe.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { SqliteBroker } from '../src/broker/sqliteBroker.js';

const ENV = (idem) => ({
  teamId: 'team-a', idempotencyKey: idem,
  from: { kind: 'agent', id: 'lead' },
  to: { kind: 'agent', teamId: 'team-a', agentId: 'dev' },
  kind: 'reply', text: 'hello',
});

function brokers() {
  return [
    ['InMemoryBroker', () => new InMemoryBroker()],
    ['SqliteBroker', () => new SqliteBroker({ filePath: ':memory:' })],
  ];
}

for (const [name, make] of brokers()) {
  test(`${name}: subscribe fires once per NEW append with the envelope`, () => {
    const b = make();
    const seen = [];
    b.subscribe((m) => seen.push(m));
    b.appendMessage(ENV('m1'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].teamId, 'team-a');
    assert.equal(seen[0].text, 'hello');
  });

  test(`${name}: no fire on idempotent dedup`, () => {
    const b = make();
    let n = 0;
    b.subscribe(() => { n += 1; });
    b.appendMessage(ENV('dup'));
    b.appendMessage(ENV('dup'));
    assert.equal(n, 1, 'second append is a dedup hit — must not fire');
  });

  test(`${name}: unsubscribe stops delivery`, () => {
    const b = make();
    let n = 0;
    const off = b.subscribe(() => { n += 1; });
    b.appendMessage(ENV('a'));
    off();
    b.appendMessage(ENV('b'));
    assert.equal(n, 1);
  });

  test(`${name}: subscriber throw is caught; message still inserted`, () => {
    const b = make();
    b.subscribe(() => { throw new Error('bad subscriber'); });
    const r = b.appendMessage(ENV('safe'));
    assert.equal(r.inserted, true);
    assert.ok(b.getMessage(r.message.messageId));
  });

  test(`${name}: durability — subscriber can read the message via the broker from its handler`, () => {
    const b = make();
    let readBack = null;
    b.subscribe((m) => { readBack = b.getMessage(m.messageId); });
    b.appendMessage(ENV('dur'));
    assert.ok(readBack, 'message is queryable from within the subscriber (post-INSERT)');
    assert.equal(readBack.text, 'hello');
  });

  test(`${name}: subscribe rejects a non-function`, () => {
    const b = make();
    assert.throws(() => b.subscribe('nope'), /function/);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings --test test/brokerSubscribe.test.js`
Expected: FAIL — `b.subscribe is not a function`.

- [ ] **Step 3: Implement on `InMemoryBroker`**

In `src/broker/inMemoryBroker.js`, add the field + methods, mirroring `SqliteTaskBoard` verbatim. Add to the class:

```javascript
#subscribers = new Set();

/**
 * Register a subscriber that fires AFTER each successfully-inserted
 * message. Mirrors SqliteTaskBoard.subscribe's contract verbatim:
 * does NOT fire on idempotent dedup hits; subscriber exceptions are
 * caught + logged so they cannot break the broker write path.
 *
 * Durability contract: fires synchronously after the message is
 * recorded; the message is queryable via this broker on the same
 * connection from within the handler. No stronger cross-process
 * disk-durability guarantee is made.
 */
subscribe(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('InMemoryBroker.subscribe: fn must be a function');
  }
  this.#subscribers.add(fn);
  return () => { this.#subscribers.delete(fn); };
}

#fireSubscribers(message) {
  for (const fn of this.#subscribers) {
    try { fn(message); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[broker] subscriber threw:', err && err.message ? err.message : err);
    }
  }
}
```

In `appendMessage`, fire only on a genuinely-new insert. Change the success `return`:

```javascript
this.#messages.set(envelope.messageId, envelope);
this.#fireSubscribers(envelope);
return { inserted: true, message: envelope };
```

(The early `return { inserted: false, … }` dedup path is untouched — no fire on dedup.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings --test test/brokerSubscribe.test.js`
Expected: `InMemoryBroker` tests PASS (6); `SqliteBroker` tests still FAIL (next task).

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/broker/inMemoryBroker.js toad-local/test/brokerSubscribe.test.js
git -C /c/Project-TOAD commit -m "feat(broker): InMemoryBroker.subscribe — observer seam (mirrors task board)"
```

---

### Task 10: `subscribe` on `SqliteBroker`

**Files:**
- Modify: `src/broker/sqliteBroker.js`

- [ ] **Step 1: Confirm the SqliteBroker tests currently fail**

Run: `node --no-warnings --test test/brokerSubscribe.test.js 2>&1 | grep "SqliteBroker"`
Expected: the 6 `SqliteBroker:` subtests FAIL (`b.subscribe is not a function`).

- [ ] **Step 2: Implement on `SqliteBroker`, symmetric to InMemoryBroker**

In `src/broker/sqliteBroker.js`, add the identical field + methods to the class (same JSDoc/contract text as Task 9 Step 3, with `SqliteBroker.subscribe` in the TypeError message):

```javascript
#subscribers = new Set();

subscribe(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('SqliteBroker.subscribe: fn must be a function');
  }
  this.#subscribers.add(fn);
  return () => { this.#subscribers.delete(fn); };
}

#fireSubscribers(message) {
  for (const fn of this.#subscribers) {
    try { fn(message); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[broker] subscriber threw:', err && err.message ? err.message : err);
    }
  }
}
```

In `appendMessage`, the dedup path (`if (existing) return { inserted: false, message: existing };`) stays untouched. At the successful-insert return, fire with the freshly-read message (which is what is returned today):

```javascript
const message = this.getMessage(envelope.messageId);
this.#fireSubscribers(message);
return { inserted: true, message };
```

(Replace the existing `return { inserted: true, message: this.getMessage(envelope.messageId) };` with the three lines above so the subscriber receives exactly the object the caller gets, AFTER the INSERT — satisfying the durability-lock test.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --no-warnings --test test/brokerSubscribe.test.js`
Expected: PASS, all 12 (6 InMemory + 6 Sqlite).

- [ ] **Step 4: Wire the new test file into `package.json`**

In `package.json` `scripts.test`, add ` && node --no-warnings --test test/brokerSubscribe.test.js` adjacent to the other broker test entries (after `test/sqliteBroker.test.js`).

- [ ] **Step 5: Run the full suite**

Run: `npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END {for (k in a) print k, a[k]}'`
Expected: `fail 0`.

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/broker/sqliteBroker.js toad-local/package.json
git -C /c/Project-TOAD commit -m "feat(broker): SqliteBroker.subscribe — symmetric observer seam + wire test"
```

---

### Task 11: Wire Slice 1 test files into `package.json` + final full-suite gate

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the Slice 1 test files to the `test` script**

In `package.json` `scripts.test`, add (adjacent to the other `test/drift/spec/*` and `test/drift/checks/*` entries):

```
&& node --no-warnings --test test/drift/spec/evalConstitutionRule.test.js
&& node --no-warnings --test test/drift/spec/isTextFile.test.js
&& node --no-warnings --test test/drift/checks/constitutionMergeGate.test.js
```

(They already ran individually in Tasks 2–4; this ensures CI/`npm test` covers them permanently.)

- [ ] **Step 2: Run the full suite**

Run: `npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END {for (k in a) print k, a[k]}'`
Expected: `fail 0`; pass count = the pre-slice total (1227) + every test added across Tasks 2–10.

- [ ] **Step 3: Commit**

```bash
git -C /c/Project-TOAD add toad-local/package.json
git -C /c/Project-TOAD commit -m "test(drift): wire merge-gate slice test files into npm test"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage:** design §1 merge-boundary rationale → Task 5 placement; §2 three-tier model → Task 7 doctrine + Task 5 observer-finding emission; §4.2 testable unit + shared `evalConstitutionRule` → Tasks 2,4; §4.3 introduced-vs-preexisting + added-file + binary-skip → Task 4 (+ shared `isTextFile` Task 3); §4.4 reviewed clamp + re-read → Task 4 (tests incl. flip); §4.5 rejection string + structured payload → Task 5; §4.6 fail-open + loud finding w/ error detail → Task 4 + Task 5; §4.7 modeling limitation → no code (documented; conflict gate upstream already in chain); §5 observer seam symmetric + durability + no-dedup + exception isolation → Tasks 9,10; §6 full TDD list → Tasks 4,5,9,10 tests; §7 doctrine/prompt/grep → Task 7; §8 non-goals → respected (no message-delivery gate, no consumer wired, no retroactive sweep); §8a verification → Tasks 1,8 + Task 4 content-matching test. All covered.

**2. Placeholder scan:** no TBD/TODO; every code step has complete code; the one "match the facade's existing pattern for `this.spec`" in Task 5 Step 4 is an explicit, bounded verification with a concrete fallback (`loadProjectSpec`), not a vague placeholder.

**3. Type consistency:** `constitutionMergeGate` return shape `{ blocked, introduced[], preexisting[], unsupported[], scanError }` is identical across its definition (Task 4), the integration wiring (Task 5), and the injected test doubles (Task 5 tests). `evalConstitutionRule(rule, { path, content }) → hit[]|null` consistent Tasks 2/4. `isTextFile(path, { runGit, projectCwd }) → bool` consistent Tasks 3/4. Finding item shape `{ ruleId, file, line, snippet, description }` consistent Task 4 ↔ Task 5. `subscribe`/`#fireSubscribers` identical Tasks 9/10.

---
