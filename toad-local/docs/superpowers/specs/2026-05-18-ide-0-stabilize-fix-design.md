# IDE-0 — Stabilize & Fix the WITH me IDE — Design

**Status:** Approved (brainstorm 2026-05-18). First sub-project of the
"Make WITH me a real IDE" program.

**Program context:** Symphony has two intentional product flavors.
**FOR me** — the vibe-coder path: the user prompts Foundry, an agent
team builds, the user watches (`CockpitForMe`). **WITH me** — the dev
path: the user spawns CLI-provider agent teams, runs functions, creates
tasks, and edits code in an in-app IDE (`CockpitWithMe`). The IDE work
in this program is **exclusively** about the WITH me flavor. FOR me is
working as designed and is out of scope for the entire program.

The program decomposes into: **IDE-0** (this doc — stabilize + fix),
then **IDE-1** (JS/TS + ESLint diagnostics), then **IDE-2** (per-file
changed-lines / diff panel). Each is its own brainstorm → spec → plan →
subagent-driven cycle.

## 1. Problem

The WITH me IDE is already built and renders correctly: a project file
tree, a Monaco editor with tabs / Save / Revert / View Diff, a TEAM
rail, and a TERMINAL / PROBLEMS / OUTPUT / VALIDATIONS bottom panel.
Two real defects remain:

1. **The WITH me file tree does not follow a project switch made from
   the titlebar project dropdown.** `App.tsx`'s `onSelectProject`
   handler (the dropdown in the Titlebar project pill) only calls
   `projectRegistry.setActive(found.id)`. The running backend sidecar
   keeps serving files from its boot-pinned `projectCwd`, so
   `ide_tree_list` returns the *old* project's tree even though the UI
   "active project" changed. The Project Picker, Add-Project, and Code
   screen paths already do the correct thing (`switchToProjectPath()`
   → sidecar respawn → `refreshAfterProjectSwitch()`); the titlebar
   dropdown is the one entrypoint that was never wired through it.

2. **The entire WITH me IDE implementation is uncommitted/untracked
   and at risk of loss.** A prior parallel agent implemented two plans
   (`docs/superpowers/plans/2026-05-18-ide-file-compatibility.md` and
   `…-python-ide-diagnostics.md`) — file classification, broad language
   support, unsupported-file panels, Ruff/Mypy diagnostics, the
   Problems panel, Monaco squiggles, and format/fix actions — but never
   committed it, never marked the plan checkboxes complete, and never
   wired its test suites into the root gate. The work is verified at
   the unit level (suites green: `ideFileClassification` 9/9,
   `ideFileTools.compatibility` integrated, `idePythonDiagnosticParsers`
   + `localToolFacade.idePythonDiagnostics` 10/10, `roleAuthority` +
   `localMcpToolDefinitions` 39/39, UI `ideFilePresentation` +
   `ideDiagnostics` + `cockpitTreeActor` 8/8) but is not durable.

## 2. Goal

Make the WITH me IDE **safe and project-aware**: commit the
verified-but-uncommitted WITH me IDE work (and wire its suites into the
root gate), and fix project switching so the WITH me file tree and
editor follow the active project from the titlebar dropdown — the same
way they already do from the Project Picker. **FOR me, the
`FOR me / WITH me` persona pill, `developerMode`, `CockpitScreenV2`
routing, `useTweaks`, and overall UI structure are not touched.**

A surfacing/discoverability change was considered and **explicitly
rejected**: the persona pill already exists, is labelled, and is where
the user expects it; FOR me is the correct default for the vibe-coder
flavor; and rewiring the persona/`developerMode` machinery would be a
UI rewrite that risks FOR me. IDE-0 changes no defaults and adds no
tweak.

## 3. Scope

### 3.1 In scope

**B. Project-switch fix (one handler).** Change `App.tsx`'s
`onSelectProject` so that selecting a project from the titlebar
dropdown goes through the *existing* `switchToProjectPath()` +
`refreshAfterProjectSwitch()` sequence already used by
`openRegisteredProject`/`pickProjectFolder`. This makes one broken
affordance behave like the already-correct ones. It is a behavior fix
to a shared handler, not new UI: FOR me's markup and flow are
unchanged; FOR me merely also gets a project switch that actually
works. WITH me's tree/editor already key on the active project id, so
once the sidecar respawns they refresh with no further change.

**C. Verify + commit the WITH me IDE work.** Run the two plans' suites
red→green (already green) and UI `typecheck`/`build`, mark the two
plans' checkboxes complete, commit the WITH me IDE file-set, and wire
its 4 suites into `scripts/test-suites.txt`.

### 3.2 Out of scope / explicitly NOT touched

`CockpitForMe.tsx` and the entire FOR me flow; the `FOR me / WITH me`
persona pill; `developerMode`; `CockpitScreenV2` routing; `useTweaks`;
any new tweak or changed default; any layout/visual redesign; JS/TS or
ESLint diagnostics (IDE-1); the per-file changed-lines/diff panel
(IDE-2); any new editor feature (autocomplete, multi-cursor, etc.);
Claude/runtime adapter code.

## 4. Commit hygiene (design constraint)

The working tree is dirty with multiple unrelated workstreams. IDE-0
commits **only** the WITH me IDE file-set and must never `git add -A`.
The file-set is the union of the two IDE plans' File Maps. Constraints
the implementation must honor:

- **Source of truth:** the two plans' File Structure / File Map
  sections enumerate the IDE files. Stage exactly those, plus the 2 IDE
  spec docs, the 2 IDE plan docs (checkboxes marked complete), and this
  spec.
- **Build-required dependencies are included even if not enumerated:**
  e.g. `ui/src/components/cockpit/cockpitTreeActor.ts` +
  `ui/test/cockpitTreeActor.test.mjs` — `CockpitWithMe` imports
  `resolveCockpitTreeActor`; committing the IDE without it breaks the
  UI build. Any such direct dependency of the committed IDE files is
  in-set.
- **Known NON-IDE files that must stay unstaged:**
  `ui/src/components/PlanUsagePanel.tsx` and
  `src/providers/geminiUsageProbe.js` (a separate usage-probe
  workstream), plus anything else not traceable to the IDE plans.
- **`App.tsx` mixed-diff hazard:** `App.tsx` already carries a small
  uncommitted change from another workstream *and* will receive IDE-0's
  `onSelectProject` fix. The implementation must stage **only** the
  `onSelectProject` hunk (hunk-level staging), leaving any unrelated
  pre-existing `App.tsx` lines unstaged. If the pre-existing change
  turns out to be IDE-related on inspection, that is a judgement the
  implementer records — it is not assumed either way.
- **Per-file verification, not assumption:** before staging any
  tracked-modified file (e.g. `src/tools/localToolFacade.js`,
  `src/mcp/localToolDefinitions.js`, `src/commands/command-contract.js`,
  `src/security/roleAuthority.js`, `src/app/LocalToadRuntime.js`,
  `src/ide/ideFileTools.js`, `ui/src/components/ideSource.ts`,
  `ui/src/components/codeTreeNavigator.ts`,
  `ui/src/styles/app-shell.css`, `ui/src/styles/cockpit.css`,
  `test/localMcpToolDefinitions.test.js`, `test/roleAuthority.test.js`),
  the implementer inspects its diff and confirms it is IDE work before
  staging. Files already committed on `main` (e.g. `CockpitWithMe.tsx`
  if git shows it unmodified) are left as-is.
- **Commit convention:** commit directly to `main` (project
  convention), `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths,
  `git -c commit.gpgsign=false`, trailer
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
  Logical commits (e.g. one for file-compat, one for python-diagnostics,
  one for the project-switch fix + gate wiring) rather than one mega
  commit, so history stays attributable.

## 5. Components touched

- `ui/src/App.tsx` — `onSelectProject` body only (route through
  `switchToProjectPath` + `refreshAfterProjectSwitch`). No other change.
- `scripts/test-suites.txt` — append the 4 IDE suites
  (`test/ideFileClassification.test.js`,
  `test/ideFileTools.compatibility.test.js`,
  `test/idePythonDiagnosticParsers.test.js`,
  `test/localToolFacade.idePythonDiagnostics.test.js`) on a single
  line, **no newline before `&&`** (prior gate-format regression).
- `git` — the scoped commit(s) of the WITH me IDE file-set + the 2
  plans (checkboxes complete) + the 2 IDE specs + this spec.

No component is added or restructured. One existing handler is
corrected; verified work is made durable.

## 6. Data flow (project switch, after fix)

Titlebar project dropdown select → `switchToProjectPath(path)` → Tauri
`invoke('switch_project')` respawns the sidecar against the new cwd →
`projectRegistry.setActive` + `refreshAfterProjectSwitch()` clears then
repopulates team-scoped state → the active project id changes →
`CockpitWithMe`'s existing tree-load effect refires →
`ide_tree_list` now resolves `resolveIdeSourceRoot` against the **new**
`projectCwd` → file tree + editor source reflect the new project. No
WITH me component code changes; it already reacts to the active project
id and the post-switch refresh.

## 7. Error handling

- Project switch reuses the existing `refreshAfterProjectSwitch`
  clear-then-repopulate logic and `switchToProjectPath`'s
  browser/Tauri fallback — no new error paths introduced. Switch
  failures surface exactly as they already do for the Project Picker
  path (the existing `console.error('switch_project failed')`).
- A project with Ruff/Mypy uninstalled is **not** an error: the
  committed diagnostics code already returns `available:false` tool
  results and the Problems panel renders the actionable
  "install dev dependencies" message. IDE-0 verifies that message
  appears; it does not change diagnostics behavior.

## 8. Testing strategy

- **TDD for the one code change:** an `App`-level test asserting that
  `onSelectProject` invokes `switchToProjectPath` +
  `refreshAfterProjectSwitch` (mocked) rather than only
  `projectRegistry.setActive`. Red before the fix, green after.
- **Regression / durability gate:** the 4 IDE suites stay green and are
  wired into `scripts/test-suites.txt`; the full root gate runs green
  (EXIT 0, 0 fail, the new suites observed running); UI
  `npm run typecheck` and `npm run build` exit 0. If the pre-existing
  `SummaryStatus.quota` typecheck error is still present it is reported
  separately and **not** silently edited (per the python-diagnostics
  plan's standing instruction).
- **Out-of-scope diff is empty:** `CockpitForMe.tsx`, the persona pill,
  `developerMode`, `CockpitScreenV2`, `useTweaks` are byte-unchanged
  across the IDE-0 commits; `PlanUsagePanel.tsx` /
  `geminiUsageProbe.js` remain unstaged.
- **Manual smoke:** in WITH me, switch projects via the titlebar
  dropdown → file tree + open editor follow the new project; FOR me is
  visually and behaviorally identical to before; PROBLEMS either
  populates for the active Python project or shows the actionable
  Ruff/Mypy-missing message.

## 9. Honest residuals

- "Lint / PROBLEMS not populating" observed in the running app is most
  likely Ruff/Mypy not installed in that project's virtualenv, not a
  code defect. IDE-0 only confirms the actionable message renders.
  Real lint coverage for the user's own JS/TS code is **IDE-1**, not
  IDE-0.
- IDE-0 makes the existing WITH me IDE durable and project-aware; it
  does not add IDE capabilities. The editor-feature gap the user
  observed is addressed by IDE-1 (diagnostics/auto-fix for JS/TS) and
  IDE-2 (changed-files panel), each its own cycle.
