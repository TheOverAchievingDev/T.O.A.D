# Maintenance Mode Slice M.1c — Drift Retargeting — Design

**Date:** 2026-05-10
**Slice:** M.1c of the post-F.2 Maintenance roadmap. Final slice of the maintenance trilogy: M.1a (reopen project) → M.1b (bug-fix task type) → **M.1c (drift retargeting)**.

---

## Goal

Let drift compare against the codebase's **current state** (recent git history + project README/docs) instead of the **original Foundry spec docs**, controlled by a new per-team drift setting `drift.compareAgainst: 'foundry_docs' | 'current_state'`. Default value `'foundry_docs'` preserves current behavior for every existing team.

For projects past their first shipped version (maintenance phase), foundry docs are stale or missing — the spec-mismatch findings drift produces against them are noise at best, wrong at worst. Comparing against current state ("recent commits + README/AGENTS/CLAUDE/CONTRIBUTING docs") gives drift a sensible baseline that reflects what the codebase actually IS today.

## Non-goals

- **Auto-default for reopened-via-M.1a teams** — every team defaults to `'foundry_docs'`. Future polish slice can wire M.1a's reopen flow to default reopened teams to `'current_state'` when shipped commits exist past the original Foundry export.
- **Per-task baseline override** — all drift runs for a team use the same baseline. Per-task overrides (e.g., bug tasks always use current_state) feel like over-engineering — defer until usage data justifies it.
- **Richer commit metadata** (full bodies, author, file list per commit). Just `sha + shortMessage + date` for now. Token budget matters.
- **Beyond-canon project docs** (e.g., `docs/architecture.md`, ADRs). The 4 canonical filenames (`README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) cover the common case. Expanding is a polish slice.
- **Custom commit count.** Hardcoded `30`. Configurable via drift settings is a polish slice if usage shows demand.
- **Streaming git log / docs reads.** Synchronous one-shot reads. The data fits comfortably under 50KB total per drift run.

---

## Architecture

Three surgical changes, all scoped to the drift module:

1. **`buildSnapshot.js`** branches on `compareAgainst`. When `'current_state'`: skip `foundryStore.readDocs()`, instead pull recent git log (30 commits via existing `runGit` helper) + read up to 4 canonical project docs (8KB cap each). Result lands on snapshot as `currentStateContext`.

2. **`checkLlmSemantic.js`** branches prompt-building on snapshot shape. When `currentStateContext` is present, emit a "Current codebase context" section (recent commits + project docs) instead of the existing "Foundry docs" section.

3. **Tier-1 and tier-2 prompt framing** gains a conditional baseline description: `"the codebase's current state"` vs `"the original Foundry spec docs"`.

UI: `Settings → Drift` grows a "Comparison baseline" radio with the two options.

```
                ┌──────────────────────────────────────┐
                │ Settings → Drift                      │
                │ Comparison baseline:                  │
                │  ○ Foundry spec docs (default)        │
                │  ○ Current codebase                   │
                └──────────────────┬───────────────────┘
                                   │ writes drift.compareAgainst
                                   ▼
                ┌──────────────────────────────────────┐
                │ settings store (per-team JSON)        │
                │ drift: {                              │
                │   compareAgainst: 'current_state',    │
                │   tier1ModelOverride: '...',          │
                │   ...                                 │
                │ }                                     │
                └──────────────────┬───────────────────┘
                                   │ read by driftEngine
                                   ▼
                ┌──────────────────────────────────────┐
                │ buildSnapshot({ compareAgainst })     │
                │ branch:                               │
                │   foundry_docs  → existing path       │
                │   current_state → new path:           │
                │     - runGit(['log', '-n', '30'])     │
                │     - read project docs (capped)      │
                │     - foundryDocs left as {}          │
                └──────────────────┬───────────────────┘
                                   ▼
                ┌──────────────────────────────────────┐
                │ checkLlmSemantic.js                   │
                │ branch on snapshot.currentStateContext│
                │   present  → "Current codebase ctx"   │
                │   absent   → "Foundry docs"           │
                │ + prompt framing line adapts          │
                └──────────────────────────────────────┘
```

No schema migration. No new tables. Drift settings already serialize as JSON in the settings store; the new field appears alongside existing tunables.

## Components

### 1. Drift settings — `drift.compareAgainst` field

New field. Lives in the same drift settings object as `tier1ModelOverride`, `tier2ModelOverride`, etc.

```ts
type DriftCompareAgainst = 'foundry_docs' | 'current_state';
// default: 'foundry_docs'
```

Read by `driftEngine.js` at run time. Persisted via the existing settings store API (`useSettings` on UI side, `settingsStore.readEffective()` on backend). No code change to the settings layer itself — JSON shape just gains the field.

### 2. `buildSnapshot.js` — branching snapshot construction

The function gains an optional `compareAgainst` arg (default `'foundry_docs'`). Internal logic branches:

```js
export async function buildSnapshot({ deps, teamId, compareAgainst = 'foundry_docs' } = {}) {
  const { taskBoard, eventLog, foundryStore, worktreeManager, diffComputer } = deps;
  const projectCwd = deps?.projectCwd || process.cwd();
  // ... existing tasks / taskEvents / runtimeEvents / worktrees / diffsByTask gathering

  let foundryDocs = {};
  let currentStateContext = null;

  if (compareAgainst === 'current_state') {
    currentStateContext = {
      recentCommits: getRecentCommits({ cwd: projectCwd, count: 30 }),
      projectDocs: readProjectDocs(projectCwd),
    };
    // foundryDocs stays {} — even if foundryStore has docs, we don't surface them
  } else {
    // existing foundry_docs path
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

`currentStateContext` is `null` (or absent) in the `foundry_docs` path — downstream checks can use `snapshot.currentStateContext != null` as a clean discriminator.

### 3. `getRecentCommits` helper

In `buildSnapshot.js` (or a local helper module if the file gets too crowded):

```js
function getRecentCommits({ cwd, count = 30 }) {
  if (!cwd) return [];
  try {
    const result = runGit(
      ['log', '-n', String(count), '--pretty=format:%h %s (%ai)'],
      { cwd },
    );
    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') return [];
    return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
```

Uses the existing `src/git/runGit.js`. Returns `[]` on any failure — never throws.

### 4. `readProjectDocs` helper

```js
function readProjectDocs(cwd) {
  if (!cwd) return {};
  const CANDIDATES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'];
  const CAP = 8 * 1024;
  const docs = {};
  for (const name of CANDIDATES) {
    try {
      const fp = join(cwd, name);
      if (!existsSync(fp)) continue;
      const raw = readFileSync(fp, 'utf8');
      docs[name] = raw.length > CAP ? raw.slice(0, CAP) : raw;
    } catch {
      // skip per-file failures, don't fail the whole read
    }
  }
  return docs;
}
```

Returns `{}` if cwd missing or no files exist. Best-effort.

### 5. `checkLlmSemantic.js` — branching prompt section

Find the current "Foundry docs" section (around `snapshot.foundryDocs` iteration). Replace with a branch:

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
  // Existing Foundry docs section — unchanged
  lines.push('## Foundry docs');
  for (const [key, content] of Object.entries(snapshot.foundryDocs ?? {})) {
    if (typeof content !== 'string' || content.length === 0) continue;
    lines.push(`### ${key}.md`);
    lines.push(content);
    lines.push('');
  }
}
```

### 6. Tier-1 and Tier-2 prompt framing

Both prompts open with an instruction line that anchors on "compare against the original spec." Gains a conditional:

```js
// in tier1.js / tier2.js prompt builders
const baselineDescription = snapshot.currentStateContext
  ? "the codebase's current state and recent activity (recent commits + project README/docs)"
  : 'the original Foundry spec docs (architecture, steering, design decisions, definition of done)';

const prompt = `You are a drift judge. Compare the team's current work against ${baselineDescription}. ...`;
```

Same change to both tier files. Exact prompt rewrites can iterate during implementation — the conditional + the baseline-description string are the contract.

### 7. `driftEngine.js` — thread the setting through

Wherever `buildSnapshot` is called in driftEngine, read `compareAgainst` from settings and pass it:

```js
const snapshot = await buildSnapshot({
  deps: this.deps,
  teamId,
  compareAgainst: this.settings?.drift?.compareAgainst ?? 'foundry_docs',
});
```

If the driftEngine doesn't currently receive `projectCwd` via `deps`, wire it through so `buildSnapshot` can pass it to `getRecentCommits` and `readProjectDocs`. Check how M.1a's `project_state_describe` handler resolves `this.projectCwd` — same pattern likely applies.

### 8. UI — Settings → Drift

The Drift settings panel gains a Comparison baseline section. If `DriftSettings.tsx` (or equivalent) already exists, add a section. If not, find where drift-related settings live (search `drift.tier1ModelOverride` in `ui/src/components/settings/`).

```tsx
<section className="settings-section">
  <header>
    <h3>Comparison baseline</h3>
    <p className="dim">What drift compares your team's work against.</p>
  </header>
  <div className="seg" role="radiogroup" aria-label="Drift comparison baseline">
    <button
      type="button"
      role="radio"
      aria-checked={compareAgainst === 'foundry_docs'}
      className={`seg-btn ${compareAgainst === 'foundry_docs' ? 'active' : ''}`}
      onClick={() => setCompareAgainst('foundry_docs')}
    >
      Foundry spec docs
    </button>
    <button
      type="button"
      role="radio"
      aria-checked={compareAgainst === 'current_state'}
      className={`seg-btn ${compareAgainst === 'current_state' ? 'active' : ''}`}
      onClick={() => setCompareAgainst('current_state')}
    >
      Current codebase
    </button>
  </div>
  <p className="dim field-hint">
    Pick "Current codebase" once your project has shipped past its
    original brief — drift uses recent commits + README/AGENTS/CLAUDE
    docs as the baseline instead of the (possibly stale) Foundry docs.
  </p>
</section>
```

State + persistence via the existing settings hook (`useSectionDraft`, `useSettings`, or whatever pattern lives next door — match it).

---

## Data flow — example

```
Operator opens Settings → Drift on a maintenance-phase team
  └─> sees "Comparison baseline" radio with Foundry spec docs (default)
        └─> clicks "Current codebase", clicks Save
              └─> settings store persists drift.compareAgainst = 'current_state'
                    └─> drift_run trigger (manual or periodic)
                          └─> driftEngine reads compareAgainst from settings
                                └─> buildSnapshot(..., compareAgainst: 'current_state')
                                      └─> runGit(['log', '-n', '30', '--pretty...']) → 30 commits parsed
                                            └─> readProjectDocs(cwd) → { 'README.md': '...', 'AGENTS.md': '...' }
                                                  └─> snapshot.currentStateContext populated, foundryDocs={}
                                                        └─> checkLlmSemantic renders prompt with
                                                            "## Current codebase context" section
                                                              └─> tier-1 prompt baseline = "current state"
                                                                    └─> LLM judges against current codebase
                                                                          └─> findings reflect drift vs current,
                                                                              not stale Foundry brief
```

## Error handling

- **`runGit` fails** (no git repo, git not installed): `getRecentCommits` returns `[]`. The "Recent commits" subsection is omitted from the prompt. Other context (project docs) still surfaces.
- **All project docs missing**: `readProjectDocs` returns `{}`. The "Project documentation" subsection is omitted. Recent commits alone are still useful.
- **Both empty**: snapshot still has `currentStateContext: { recentCommits: [], projectDocs: {} }`. The check's prompt gets a "Current codebase context" header but no content under it. LLM judge gets the framing change but no actual baseline — likely produces few findings, which is acceptable (no false-positive spec-drift noise).
- **Drift settings read fails**: `driftEngine` defaults to `'foundry_docs'` — preserves existing behavior.
- **`compareAgainst` is an invalid value**: `buildSnapshot` treats anything other than `'current_state'` as `'foundry_docs'` (defensive default).

## Testing

Backend (TDD):

- `test/drift/buildSnapshot.test.js`:
  - `compareAgainst: 'foundry_docs'` (default) → snapshot has `foundryDocs` populated, `currentStateContext` is null/absent.
  - `compareAgainst: 'current_state'` → snapshot has `currentStateContext.recentCommits` (mock runGit) + `currentStateContext.projectDocs` (mock fs), `foundryDocs` is `{}`.
  - `runGit` returns non-zero exit code → `recentCommits` is `[]`, doesn't throw.
  - `runGit` throws → `recentCommits` is `[]`, doesn't throw.
  - Project docs: only README.md exists → `projectDocs` has just that key.
  - Project doc exceeds 8KB cap → content truncated to 8KB.
  - No project docs exist → `projectDocs` is `{}`.
  - `cwd` is null → `recentCommits: [], projectDocs: {}`.
  - `compareAgainst: 'banana'` (invalid) → falls back to `'foundry_docs'` path.

- `test/drift/checks/checkLlmSemantic.test.js`:
  - Snapshot with `currentStateContext` → prompt includes "Current codebase context" section + does NOT include "Foundry docs" section.
  - Snapshot with `foundryDocs` only (no `currentStateContext`) → prompt includes "Foundry docs" section.
  - Snapshot with empty `currentStateContext` (no commits, no docs) → "Current codebase context" header present but no sub-content; doesn't crash.
  - Snapshot's tier-1 prompt framing line uses "current state" baseline language vs "Foundry spec docs" language depending on context shape.

UI (typecheck + lint + manual smoke):

- Manual smoke:
  - Open Settings → Drift, see the new "Comparison baseline" section.
  - Default selected option is "Foundry spec docs."
  - Toggle to "Current codebase," save.
  - Trigger a drift_run (Refresh button on Drift screen or wait for periodic).
  - Run completes — no errors. Findings may differ from foundry_docs mode but the run itself succeeds.
  - Toggle back to "Foundry spec docs," save, run again — behavior returns to existing default.

## What this slice does NOT change

- **The drift findings schema, severity levels, or category enums** — unchanged.
- **The drift score formula** — unchanged. Compare-against-X is an input change, not a scoring change.
- **The driftMonitor's periodic polling interval** — unchanged.
- **Drift findings storage** (`drift_findings`, `drift_score_history` tables) — no schema migration.
- **Deterministic check behavior** (`checkInvalidTransitions`, `checkOutOfScopeFiles`, etc.) — those checks don't use `foundryDocs` today. Unchanged.
- **Drift correction flow** (M.1.* slices already shipped) — unchanged.

## What this slice unblocks

- **Polish: auto-default for reopened teams.** M.1a's reopen flow can wire `compareAgainst: 'current_state'` for teams that have shipped commits past the original Foundry export. ~10 LOC change in `project_state_describe` flow.
- **Polish: per-task baseline override.** If usage shows demand, individual tasks could override the team's drift baseline.
- **Polish: richer commit context.** Include file lists, author names, full bodies if token budget allows.
- **Polish: configurable commit count.** Add to drift settings.

---

## References

- M.1a spec: `docs/specs/2026-05-10-maintenance-mode-m1a-reopen-design.md` (reopen flow)
- M.1b spec: `docs/specs/2026-05-10-maintenance-mode-m1b-bug-fix-task-type-design.md` (bug-fix task type)
- FUTURE-IDEAS.md "Maintenance mode" entry — "Diff-against-current-state drift — not against the original spec"
- `src/drift/buildSnapshot.js` — snapshot composition
- `src/drift/checks/checkLlmSemantic.js` — semantic LLM check
- `src/drift/driftEngine.js` — engine orchestration
- `src/drift/llm/prompts/tier1.js` and `tier2.js` — LLM prompt builders
- `src/git/runGit.js` — git invocation helper (already used by M.1a)
- `src/drift/llm/providerResolver.js` — drift provider selection (reference for settings-style code in the drift namespace)
