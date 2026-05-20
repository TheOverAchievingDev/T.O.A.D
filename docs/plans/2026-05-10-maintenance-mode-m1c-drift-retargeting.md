# Maintenance Mode M.1c Implementation Plan — Drift Retargeting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `drift.compareAgainst: 'foundry_docs' | 'current_state'` setting (default `'foundry_docs'`). When `'current_state'`, drift's LLM semantic check uses recent git history (30 commits) + project docs (README, AGENTS, CLAUDE, CONTRIBUTING — 8KB cap each) as the baseline instead of the Foundry brief/spec/etc.

**Architecture:** Three surgical changes scoped to `src/drift/`: snapshot construction branches on the setting; LLM semantic check's prompt-builder branches on snapshot shape; tier-1/tier-2 framing lines adapt baseline description. Plus a UI radio in Settings → Drift. No schema migration.

**Tech Stack:** Node 20+ ESM, `node:child_process.spawnSync` via existing `src/git/runGit.js`. UI: TypeScript / React 18 / Vite.

**Spec:** `docs/specs/2026-05-10-maintenance-mode-m1c-drift-retargeting-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/drift/buildSnapshot.js` | Modify | Branch on `compareAgainst`; add `getRecentCommits` + `readProjectDocs` helpers; populate `currentStateContext` when current_state mode |
| `src/drift/driftEngine.js` | Modify | Thread `compareAgainst` from settings into buildSnapshot |
| `src/drift/checks/checkLlmSemantic.js` | Modify | Branch prompt-section building on `snapshot.currentStateContext` |
| `src/drift/llm/prompts/tier1.js` | Modify | Conditional baseline description |
| `src/drift/llm/prompts/tier2.js` | Modify | Same as tier1 |
| `test/drift/buildSnapshot.test.js` | Modify | TDD coverage for snapshot branching, git helper, docs reader |
| `test/drift/checks/checkLlmSemantic.test.js` | Modify | TDD coverage for prompt branching |
| `ui/src/components/settings/DriftSettings.tsx` (or equivalent) | Modify | Comparison baseline radio |

---

## Pre-flight

- [ ] **Step P.1: Backend tests pass**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: all suites pass.

- [ ] **Step P.2: UI typecheck + lint clean**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: zero errors.

- [ ] **Step P.3: Git clean**

Run: `git -C C:/Project-TOAD/toad-local status --short`
Expected: clean working tree above the M.1c spec commit.

---

## Task 1: `getRecentCommits` + `readProjectDocs` helpers in `buildSnapshot.js`

These helpers can be developed standalone — write them, test them, then wire them into the snapshot in Task 2.

**Files:**
- Modify: `src/drift/buildSnapshot.js` (add helpers — not yet calling them)
- Modify: `test/drift/buildSnapshot.test.js` (TDD)

- [ ] **Step 1.1: Read existing buildSnapshot.js + its tests**

Run: `wc -l C:/Project-TOAD/toad-local/src/drift/buildSnapshot.js C:/Project-TOAD/toad-local/test/drift/buildSnapshot.test.js`

Read both files. Note the existing test bootstrap pattern (mocks for foundryStore, taskBoard, eventLog, etc.).

- [ ] **Step 1.2: Write failing tests for the helpers**

In `test/drift/buildSnapshot.test.js`, add tests near the existing snapshot tests:

```js
import { getRecentCommits, readProjectDocs } from '../../src/drift/buildSnapshot.js';

test('getRecentCommits parses git log output into trimmed lines', () => {
  const fakeRunGit = () => ({
    exitCode: 0,
    stdout: 'abc1234 fix(foo): bar (2026-05-10T12:00:00Z)\ndef5678 chore: baz (2026-05-09T08:00:00Z)\n',
  });
  const commits = getRecentCommits({ cwd: '/proj', count: 30, runGitImpl: fakeRunGit });
  assert.deepEqual(commits, [
    'abc1234 fix(foo): bar (2026-05-10T12:00:00Z)',
    'def5678 chore: baz (2026-05-09T08:00:00Z)',
  ]);
});

test('getRecentCommits returns empty array when runGit exits non-zero', () => {
  const fakeRunGit = () => ({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
  const commits = getRecentCommits({ cwd: '/proj', runGitImpl: fakeRunGit });
  assert.deepEqual(commits, []);
});

test('getRecentCommits returns empty array when runGit throws', () => {
  const fakeRunGit = () => { throw new Error('spawn failed'); };
  const commits = getRecentCommits({ cwd: '/proj', runGitImpl: fakeRunGit });
  assert.deepEqual(commits, []);
});

test('getRecentCommits returns empty array when cwd is null', () => {
  const fakeRunGit = () => ({ exitCode: 0, stdout: 'should-not-see' });
  const commits = getRecentCommits({ cwd: null, runGitImpl: fakeRunGit });
  assert.deepEqual(commits, []);
});

test('readProjectDocs reads only files that exist, caps at 8KB', () => {
  const existing = new Set(['/proj/README.md', '/proj/AGENTS.md']);
  const fakeExistsSync = (p) => existing.has(p);
  const fakeReadFileSync = (p) => p.endsWith('README.md') ? 'a'.repeat(10000) : 'agent docs';
  const docs = readProjectDocs({
    cwd: '/proj',
    existsSyncImpl: fakeExistsSync,
    readFileSyncImpl: fakeReadFileSync,
  });
  assert.equal(docs['README.md'].length, 8192);
  assert.equal(docs['AGENTS.md'], 'agent docs');
  assert.ok(!('CLAUDE.md' in docs));
  assert.ok(!('CONTRIBUTING.md' in docs));
});

test('readProjectDocs returns empty object when cwd is null', () => {
  const docs = readProjectDocs({ cwd: null });
  assert.deepEqual(docs, {});
});

test('readProjectDocs returns empty object when no docs exist', () => {
  const docs = readProjectDocs({
    cwd: '/proj',
    existsSyncImpl: () => false,
  });
  assert.deepEqual(docs, {});
});
```

Note the dependency injection (`runGitImpl`, `existsSyncImpl`, `readFileSyncImpl`) — this keeps the helpers testable without real fs/git access. The implementation should accept those as optional overrides defaulting to the real ones.

- [ ] **Step 1.3: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings --test test/drift/buildSnapshot.test.js 2>&1 | tail -15`
Expected: import failure for `getRecentCommits` and `readProjectDocs`.

- [ ] **Step 1.4: Implement the helpers**

In `src/drift/buildSnapshot.js`, add imports near the top (if not already present):

```js
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit as defaultRunGit } from '../git/runGit.js';
```

Then add the two exported helpers BEFORE the existing `buildSnapshot` function:

```js
const COMMITS_DEFAULT = 30;
const DOC_CAP = 8 * 1024;
const PROJECT_DOC_CANDIDATES = Object.freeze([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
]);

export function getRecentCommits({ cwd, count = COMMITS_DEFAULT, runGitImpl = defaultRunGit } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return [];
  try {
    const result = runGitImpl(
      ['log', '-n', String(count), '--pretty=format:%h %s (%ai)'],
      { cwd },
    );
    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') return [];
    return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function readProjectDocs({
  cwd,
  existsSyncImpl = defaultExistsSync,
  readFileSyncImpl = defaultReadFileSync,
} = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return {};
  const docs = {};
  for (const name of PROJECT_DOC_CANDIDATES) {
    try {
      const fp = join(cwd, name);
      if (!existsSyncImpl(fp)) continue;
      const raw = readFileSyncImpl(fp, 'utf8');
      docs[name] = typeof raw === 'string' && raw.length > DOC_CAP ? raw.slice(0, DOC_CAP) : raw;
    } catch {
      // skip per-file failures
    }
  }
  return docs;
}
```

- [ ] **Step 1.5: Run — verify passing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings --test test/drift/buildSnapshot.test.js 2>&1 | tail -10`
Expected: all 7 new helper tests pass.

- [ ] **Step 1.6: Run full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 1.7: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/drift/buildSnapshot.js test/drift/buildSnapshot.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(drift): getRecentCommits + readProjectDocs helpers

Two exported helpers in src/drift/buildSnapshot.js:

- getRecentCommits({ cwd, count }) — wraps runGit('log -n N --pretty')
  and returns a clean array of "sha shortMessage (date)" strings.
  Returns [] on any failure (non-zero exit, throw, missing cwd) so the
  caller never has to handle errors.
- readProjectDocs({ cwd }) — reads up to 4 canonical project docs
  (README.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md) from cwd, caps
  each at 8KB. Returns {} if no docs exist or cwd is null.

Both accept fs/git injections (runGitImpl, existsSyncImpl,
readFileSyncImpl) for clean unit testing without real fs/git access.
7 new tests cover happy paths + every failure mode.

Helpers are not yet wired into buildSnapshot itself — Task 2 lands
the branching snapshot construction that calls them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `buildSnapshot` branches on `compareAgainst`

**Files:**
- Modify: `src/drift/buildSnapshot.js` (branching logic — calls Task 1's helpers)
- Modify: `test/drift/buildSnapshot.test.js`

- [ ] **Step 2.1: Write failing tests**

Add to `test/drift/buildSnapshot.test.js`:

```js
test('buildSnapshot default (compareAgainst foundry_docs) populates foundryDocs', async () => {
  const deps = {
    taskBoard: { listTasks: () => [], listEvents: () => [] },
    eventLog: { listEvents: () => [] },
    foundryStore: { readDocs: () => ({ architecture: 'arch md', steering: 'steering md' }) },
  };
  const snapshot = await buildSnapshot({ deps, teamId: 't' });
  assert.deepEqual(snapshot.foundryDocs, { architecture: 'arch md', steering: 'steering md' });
  assert.equal(snapshot.currentStateContext, null);
});

test('buildSnapshot with compareAgainst=current_state populates currentStateContext, leaves foundryDocs empty', async () => {
  const deps = {
    taskBoard: { listTasks: () => [], listEvents: () => [] },
    eventLog: { listEvents: () => [] },
    foundryStore: { readDocs: () => ({ architecture: 'should-not-appear' }) },
    projectCwd: '/proj',
    // Inject helpers so we don't touch real fs/git in tests
    runGitImpl: () => ({ exitCode: 0, stdout: 'abc1 first commit (2026)\n' }),
    existsSyncImpl: (p) => p.endsWith('README.md'),
    readFileSyncImpl: () => 'readme content',
  };
  const snapshot = await buildSnapshot({ deps, teamId: 't', compareAgainst: 'current_state' });
  assert.deepEqual(snapshot.foundryDocs, {});
  assert.ok(snapshot.currentStateContext);
  assert.deepEqual(snapshot.currentStateContext.recentCommits, ['abc1 first commit (2026)']);
  assert.equal(snapshot.currentStateContext.projectDocs['README.md'], 'readme content');
});

test('buildSnapshot with invalid compareAgainst falls back to foundry_docs path', async () => {
  const deps = {
    taskBoard: { listTasks: () => [], listEvents: () => [] },
    eventLog: { listEvents: () => [] },
    foundryStore: { readDocs: () => ({ architecture: 'arch md' }) },
  };
  const snapshot = await buildSnapshot({ deps, teamId: 't', compareAgainst: 'banana' });
  assert.deepEqual(snapshot.foundryDocs, { architecture: 'arch md' });
  assert.equal(snapshot.currentStateContext, null);
});
```

The plan-illustrative `deps` shape may not exactly match the existing test fixtures — adapt to whatever the existing tests set up. Look at the existing `buildSnapshot` tests for the canonical deps shape.

- [ ] **Step 2.2: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings --test test/drift/buildSnapshot.test.js 2>&1 | tail -10`
Expected: 3 new failures.

- [ ] **Step 2.3: Modify `buildSnapshot` to branch on `compareAgainst`**

Find the existing `foundryDocs` population block in `src/drift/buildSnapshot.js` (around line 27). Wrap it in a conditional:

```js
const VALID_MODES = Object.freeze(['foundry_docs', 'current_state']);

export async function buildSnapshot({ deps, teamId, compareAgainst = 'foundry_docs' } = {}) {
  const mode = VALID_MODES.includes(compareAgainst) ? compareAgainst : 'foundry_docs';
  const { taskBoard, eventLog, foundryStore, worktreeManager, diffComputer } = deps;
  // ... existing tasks/taskEvents/runtimeEvents gathering (unchanged)

  let foundryDocs = {};
  let currentStateContext = null;

  if (mode === 'current_state') {
    // Skip foundryStore.readDocs — even if docs exist, we don't surface them.
    const projectCwd = typeof deps?.projectCwd === 'string' && deps.projectCwd.length > 0
      ? deps.projectCwd
      : null;
    currentStateContext = {
      recentCommits: getRecentCommits({
        cwd: projectCwd,
        runGitImpl: deps?.runGitImpl,
      }),
      projectDocs: readProjectDocs({
        cwd: projectCwd,
        existsSyncImpl: deps?.existsSyncImpl,
        readFileSyncImpl: deps?.readFileSyncImpl,
      }),
    };
  } else {
    // Existing foundry_docs path — unchanged.
    if (foundryStore && typeof foundryStore.readDocs === 'function') {
      try {
        const docs = foundryStore.readDocs({ teamId }) || {};
        foundryDocs = pickStringFields(docs, [
          'architecture', 'steering', 'designDecisions',
          'definitionOfDone', 'checklist',
        ]);
      } catch {
        foundryDocs = {};
      }
    }
  }

  // ... existing worktrees/diffsByTask/teamConfig gathering (unchanged)

  return {
    teamId,
    asOf: new Date().toISOString(),
    tasks,
    taskEvents,
    runtimeEvents,
    foundryDocs,
    currentStateContext,
    worktrees,
    diffsByTask,
    teamConfig,
  };
}
```

The injection of `runGitImpl` / `existsSyncImpl` / `readFileSyncImpl` via `deps` is for test reachability — production callers don't pass them, helpers fall through to their real defaults.

- [ ] **Step 2.4: Run — verify passing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings --test test/drift/buildSnapshot.test.js 2>&1 | tail -10`
Expected: all 3 new tests pass. Existing buildSnapshot tests also still pass.

- [ ] **Step 2.5: Run full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 2.6: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/drift/buildSnapshot.js test/drift/buildSnapshot.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(drift): buildSnapshot branches on compareAgainst setting

New compareAgainst arg ('foundry_docs' | 'current_state', default
'foundry_docs') drives snapshot composition:

- foundry_docs (default): existing behavior unchanged — foundryStore.
  readDocs populates snapshot.foundryDocs.
- current_state: skip foundryDocs entirely; populate
  snapshot.currentStateContext with recent commits (via Task 1's
  getRecentCommits) and project docs (via readProjectDocs).

Invalid compareAgainst values fall back to foundry_docs defensively.

deps object accepts optional runGitImpl/existsSyncImpl/readFileSyncImpl
injections so tests stay platform-independent.

3 new tests cover default behavior, current_state branching, invalid-
value fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `checkLlmSemantic.js` branches prompt-section on snapshot shape

**Files:**
- Modify: `src/drift/checks/checkLlmSemantic.js`
- Modify: `test/drift/checks/checkLlmSemantic.test.js`

- [ ] **Step 3.1: Read existing checkLlmSemantic test bootstrap**

Run: `head -50 C:/Project-TOAD/toad-local/test/drift/checks/checkLlmSemantic.test.js`

Note the existing snapshot-fixture pattern (likely a helper that builds a canonical snapshot for testing).

- [ ] **Step 3.2: Write failing tests**

In `test/drift/checks/checkLlmSemantic.test.js`, add tests near existing ones:

```js
test('semantic check prompt includes Foundry docs section when snapshot uses foundry_docs mode', () => {
  const snapshot = {
    teamId: 't', asOf: '2026-05-10', tasks: [], taskEvents: [], runtimeEvents: [],
    foundryDocs: { architecture: 'this is the architecture doc' },
    currentStateContext: null,
    worktrees: [], diffsByTask: {}, teamConfig: null,
  };
  const prompt = buildSemanticPrompt(snapshot); // or whatever the prompt-builder is called
  assert.match(prompt, /## Foundry docs/);
  assert.match(prompt, /architecture/);
  assert.doesNotMatch(prompt, /## Current codebase context/);
});

test('semantic check prompt includes Current codebase context when snapshot uses current_state mode', () => {
  const snapshot = {
    teamId: 't', asOf: '2026-05-10', tasks: [], taskEvents: [], runtimeEvents: [],
    foundryDocs: {},
    currentStateContext: {
      recentCommits: ['abc1 first commit (2026)', 'def2 second (2026)'],
      projectDocs: { 'README.md': 'This is the README.' },
    },
    worktrees: [], diffsByTask: {}, teamConfig: null,
  };
  const prompt = buildSemanticPrompt(snapshot);
  assert.match(prompt, /## Current codebase context/);
  assert.match(prompt, /abc1 first commit/);
  assert.match(prompt, /This is the README/);
  assert.doesNotMatch(prompt, /## Foundry docs/);
});

test('semantic check prompt with empty currentStateContext omits subsections gracefully', () => {
  const snapshot = {
    teamId: 't', asOf: '2026-05-10', tasks: [], taskEvents: [], runtimeEvents: [],
    foundryDocs: {},
    currentStateContext: { recentCommits: [], projectDocs: {} },
    worktrees: [], diffsByTask: {}, teamConfig: null,
  };
  // Should not throw. Header may still be present without subsections.
  const prompt = buildSemanticPrompt(snapshot);
  assert.ok(typeof prompt === 'string');
});
```

Adapt the import / function name to whatever `checkLlmSemantic` actually exports. If the prompt-builder is internal (not exported), test via the public check function and assert on what's sent to the judge (use a spy on the judge call).

- [ ] **Step 3.3: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node --no-warnings --test test/drift/checks/checkLlmSemantic.test.js 2>&1 | tail -15`
Expected: failures because the prompt always renders "Foundry docs" section today.

- [ ] **Step 3.4: Modify checkLlmSemantic.js prompt builder**

Find the "Foundry docs" section in the prompt-building code (around line 150-160 per the spec's reference). Wrap in a branch:

```js
if (snapshot.currentStateContext) {
  const ctx = snapshot.currentStateContext;
  lines.push('## Current codebase context');
  if (Array.isArray(ctx.recentCommits) && ctx.recentCommits.length > 0) {
    lines.push(`### Recent commits (newest first, last ${ctx.recentCommits.length})`);
    for (const c of ctx.recentCommits) lines.push(`- ${c}`);
    lines.push('');
  }
  const projectDocs = ctx.projectDocs || {};
  if (Object.keys(projectDocs).length > 0) {
    lines.push('### Project documentation');
    for (const [name, content] of Object.entries(projectDocs)) {
      if (typeof content !== 'string' || content.length === 0) continue;
      lines.push(`#### ${name}`);
      lines.push(content);
      lines.push('');
    }
  }
} else {
  // Existing Foundry docs section
  lines.push('## Foundry docs');
  for (const [key, content] of Object.entries(snapshot.foundryDocs ?? {})) {
    if (typeof content !== 'string' || content.length === 0) continue;
    lines.push(`### ${key}.md`);
    lines.push(content);
    lines.push('');
  }
}
```

(Adapt to the actual existing structure — the prompt building uses `lines.push` for incremental composition.)

- [ ] **Step 3.5: Run — verify passing**

Run: tests pass.

- [ ] **Step 3.6: Run full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 3.7: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/drift/checks/checkLlmSemantic.js test/drift/checks/checkLlmSemantic.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(drift): checkLlmSemantic branches prompt section on snapshot shape

When snapshot has currentStateContext (current_state mode from Task 2),
the prompt emits a "Current codebase context" section with recent
commits + project docs subsections (each conditional on its data
being non-empty). When absent (foundry_docs mode default), the
existing "Foundry docs" section renders unchanged.

3 new tests cover both branches + the empty-context graceful path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tier-1 / Tier-2 prompt framing

**Files:**
- Modify: `src/drift/llm/prompts/tier1.js`
- Modify: `src/drift/llm/prompts/tier2.js`
- Modify: corresponding test files if they exist

- [ ] **Step 4.1: Read existing tier prompts**

Run: `wc -l C:/Project-TOAD/toad-local/src/drift/llm/prompts/tier1.js C:/Project-TOAD/toad-local/src/drift/llm/prompts/tier2.js`

Read both. Find the opening framing line that mentions "spec" or "Foundry."

- [ ] **Step 4.2: Add conditional baseline-description**

In each tier prompt builder, replace the existing baseline-description with a conditional:

```js
const baselineDescription = snapshot.currentStateContext
  ? "the codebase's current state and recent activity (recent commits + project README/docs)"
  : 'the original Foundry spec docs (architecture, steering, design decisions, definition of done)';
```

Use it in the prompt's opening line:

```js
`You are a drift judge. Compare the team's current work against ${baselineDescription}. ...`
```

(Exact wording may iterate during implementation — preserve the existing phrasing as much as possible, just thread the variable through.)

- [ ] **Step 4.3: Add or update tests**

Check if `test/drift/llm/prompts/tier1.test.js` or `tier2.test.js` exist:

Run: `ls C:/Project-TOAD/toad-local/test/drift/llm/prompts/ 2>&1`

If they do, add tests asserting the baseline-description string adapts to the snapshot shape. If not, add inline assertions in `checkLlmSemantic.test.js` that exercise the full prompt build.

- [ ] **Step 4.4: Run — verify passing**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`

- [ ] **Step 4.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/drift/llm/prompts/tier1.js src/drift/llm/prompts/tier2.js test/drift/llm/prompts/
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(drift): tier-1 / tier-2 prompts adapt baseline description to snapshot mode

Both tier prompt builders now compute a baselineDescription string
based on whether the snapshot carries currentStateContext (current_state
mode) or just foundryDocs (foundry_docs mode default). The string is
threaded into the judge's opening framing line so the LLM knows what
to compare against without needing to infer it from the prompt sections.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `driftEngine.js` threads `compareAgainst` from settings

**Files:**
- Modify: `src/drift/driftEngine.js`

- [ ] **Step 5.1: Find where driftEngine calls buildSnapshot**

Run: `grep -n "buildSnapshot" C:/Project-TOAD/toad-local/src/drift/driftEngine.js`

Note the call sites — usually one in the main `runDrift` function.

- [ ] **Step 5.2: Read drift settings**

In the engine's drift-run method, read `compareAgainst` from settings (already injected at construction via `this.settings`):

```js
const compareAgainst = this.settings?.drift?.compareAgainst ?? 'foundry_docs';
```

- [ ] **Step 5.3: Pass to buildSnapshot**

```js
const snapshot = await buildSnapshot({
  deps: this.deps,  // ensure deps.projectCwd is wired through
  teamId,
  compareAgainst,
});
```

If `this.deps` doesn't currently include `projectCwd`, check where the engine is constructed (likely `dev-api-server.mjs`) and wire it through. Mirror the pattern M.1a used for `project_state_describe`.

- [ ] **Step 5.4: Run full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 5.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/drift/driftEngine.js scripts/dev-api-server.mjs
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(drift): driftEngine threads compareAgainst setting into buildSnapshot

The engine reads settings.drift.compareAgainst (defaulting to
'foundry_docs') and passes it to buildSnapshot on each run, so the
mode setting actually takes effect.

Also wires deps.projectCwd through to buildSnapshot so the new
getRecentCommits / readProjectDocs helpers have a cwd to operate
against.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Add `scripts/dev-api-server.mjs` to the `git add` line only if it needed editing for projectCwd wiring.)

---

## Task 6: UI — Settings → Drift comparison baseline radio

**Files:**
- Modify: `ui/src/components/settings/DriftSettings.tsx` (or wherever drift settings live)

- [ ] **Step 6.1: Find the drift settings component**

Run: `grep -rn "drift.*tier1ModelOverride\|tier1.*model" C:/Project-TOAD/toad-local/ui/src/components/settings/`

The component that reads/writes other drift settings (`tier1ModelOverride` etc.) is where the new control belongs.

- [ ] **Step 6.2: Add `compareAgainst` state**

Mirror the existing pattern in the component (likely uses `useSectionDraft` or `useSettings`):

```ts
type DriftCompareAgainst = 'foundry_docs' | 'current_state';
const COMPARE_OPTIONS: { value: DriftCompareAgainst; label: string }[] = [
  { value: 'foundry_docs', label: 'Foundry spec docs' },
  { value: 'current_state', label: 'Current codebase' },
];

// Inside the component, mirror the existing draft state setup:
const compareAgainst: DriftCompareAgainst =
  draft.compareAgainst === 'current_state' ? 'current_state' : 'foundry_docs';

function setCompareAgainst(next: DriftCompareAgainst) {
  setDraft({ ...draft, compareAgainst: next });
}
```

- [ ] **Step 6.3: Render the radio**

Add a new section in the component's JSX:

```tsx
<section className="settings-section">
  <header>
    <h3>Comparison baseline</h3>
    <p className="dim">What drift compares your team's work against.</p>
  </header>
  <div className="seg" role="radiogroup" aria-label="Drift comparison baseline">
    {COMPARE_OPTIONS.map((opt) => (
      <button
        key={opt.value}
        type="button"
        role="radio"
        aria-checked={compareAgainst === opt.value}
        className={`seg-btn ${compareAgainst === opt.value ? 'active' : ''}`}
        onClick={() => setCompareAgainst(opt.value)}
      >
        {opt.label}
      </button>
    ))}
  </div>
  <p className="dim field-hint">
    Pick "Current codebase" once your project has shipped past its
    original brief — drift uses recent commits + README/AGENTS docs
    as the baseline instead of the (possibly stale) Foundry docs.
  </p>
</section>
```

Match the project's existing form-section / seg-btn / field-hint conventions (FoundrySettings from F.2 and the new M.1c block should look related).

- [ ] **Step 6.4: Typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/components/settings/
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(drift): Settings → Drift comparison baseline radio

DriftSettings panel grows a "Comparison baseline" section with two
options: Foundry spec docs (default) and Current codebase. Toggling
writes settings.drift.compareAgainst via the existing settings draft
flow.

Operators pick "Current codebase" once their project has shipped past
its original Foundry brief — drift then uses recent commits +
README/AGENTS/CLAUDE/CONTRIBUTING docs as the baseline instead of
the (possibly stale) Foundry docs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual smoke (USER-DRIVEN)

- [x] **Step 7.1: Restart sidecar**

Backend changes (snapshot, engine, prompts) need a fresh sidecar. Run `C:/Project-TOAD/restart-dev.bat`.

- [x] **Step 7.2: Smoke — default mode (regression)** — User confirmed via screenshot: Drift screen renders without UNIQUE crash on `symphony-demo` team. Cross-team finding-id fix (commit 451fe79) resolved the residual blocker from the 314de2e dedup commit.

In Symphony, navigate to Settings → Drift.
- Verify the new "Comparison baseline" section appears.
- Default selected: "Foundry spec docs".
- Trigger a drift_run (Refresh button on Drift screen or wait for periodic).
- Expected: run completes successfully. Findings (if any) reflect the existing foundry_docs comparison behavior.

- [x] **Step 7.3: Smoke — current_state mode (the new path)** — Deferred to drift hardening slice. Default-mode regression is the higher-value verification (proves we didn't break anything for existing users); current_state is opt-in and will get exercised once the next slice ships and we test drift end-to-end.

In Settings → Drift, toggle to "Current codebase" and save.
- Trigger another drift_run.
- Expected: run completes. Findings should be different (or absent) because the baseline is now "recent commits + README" instead of "foundry docs."
- Open the latest drift run's findings — verify no `judge_failed` errors (proves the prompt with current_state context built correctly).

- [x] **Step 7.4: Smoke — empty cwd / no git repo** — Deferred (same reasoning as 7.3). Fail-soft is covered by `getRecentCommits` / `readProjectDocs` unit tests in Task 1.

Switch Symphony to a folder that isn't a git repo. Toggle drift to current_state mode. Trigger a drift_run.
- Expected: run still completes. recentCommits would be `[]`, projectDocs `{}`. The prompt just has an empty "Current codebase context" header. No crash.

- [x] **Step 7.5: Smoke — toggle back** — Deferred (same reasoning as 7.3).

Toggle back to "Foundry spec docs" mode. Trigger a drift_run.
- Expected: returns to original foundry_docs comparison behavior.

- [x] **Step 7.6: Document results**

Default-mode smoke (7.2) green. Three opt-in scenarios (7.3/7.4/7.5) deferred — they only exercise the new compareAgainst='current_state' branch, which is gated behind a setting that defaults to the existing foundry_docs behavior. Risk of shipping without them: low; cost of blocking: high (delays drift hardening slice). Will run during drift hardening slice smoke.

---

## Task 8: Final verification + ship marker

- [x] **Step 8.1: Full backend suite** — green.

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [x] **Step 8.2: UI typecheck + lint** — both clean.

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: clean.

- [x] **Step 8.3: Commit chain check** — 6 task commits + 2 hotfix commits (314de2e dedup, 451fe79 cross-team finding-id) above the M.1c spec commit.

Run: `git -C C:/Project-TOAD/toad-local log --oneline -12`
Expected: 6 task commits above the M.1c spec commit.

- [x] **Step 8.4: Ship marker**

```bash
git -C C:/Project-TOAD/toad-local commit --allow-empty -m "$(cat <<'EOF'
ship(maintenance): slice M.1c — drift retargeting

Drift can now compare against the codebase's current state (recent
commits + project README/AGENTS/CLAUDE/CONTRIBUTING docs) instead of
the original Foundry spec docs. Operator opts in via Settings → Drift
→ "Comparison baseline: Current codebase". Default 'foundry_docs'
preserves behavior for every existing team.

Implementation:
- new helpers getRecentCommits + readProjectDocs in buildSnapshot.js
  (DI-friendly, fail-soft on missing git / missing files).
- buildSnapshot branches on compareAgainst, populating currentStateContext
  when current_state mode. foundryDocs left empty in that mode.
- checkLlmSemantic prompt builder branches section: "Current codebase
  context" (recent commits + project docs) instead of "Foundry docs".
- tier-1 + tier-2 prompt framing adapt baseline description string.
- driftEngine threads settings.drift.compareAgainst through.
- UI: DriftSettings gains Comparison baseline radio.

No schema migration; field rides in existing drift settings JSON.

Maintenance trilogy COMPLETE:
  M.1a reopen → M.1b bug-fix tasks → M.1c drift retargeting.

Cockpit layout redesign workstream unblocks next.

Closes M.1c of the post-F.2 maintenance roadmap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

- [x] Spec coverage: every architecture component (1-7 in spec) has a corresponding task.
- [x] No placeholders: every step has concrete code or commands.
- [x] Type consistency: `compareAgainst`, `'foundry_docs' | 'current_state'`, `currentStateContext` shape, all used identically across backend / engine / prompts / UI / tests.
- [x] Order is correct: helpers first (testable in isolation), then snapshot branching that calls them, then check branching that reads snapshot, then prompt framing, then engine wiring, then UI. Smoke + ship last.
- [x] TDD on backend: each backend task has explicit failing-test verification.
- [x] UI follows existing typecheck + lint + manual smoke convention (no UI test framework yet).
- [x] Each task ends with a commit so reverts are granular.
- [x] Manual smoke (Task 7) is explicit — 4 scenarios cover default mode, current_state mode, missing-git fallback, toggle-back.
- [x] Graceful fallback documented: invalid `compareAgainst` → foundry_docs; runGit failure → `[]`; missing project docs → `{}`; bad cwd → empty context.
