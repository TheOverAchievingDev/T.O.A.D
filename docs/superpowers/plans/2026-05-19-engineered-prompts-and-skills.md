# Engineered Team Prompts & Foundry-Generated Skill Files

**Status**: In progress  
**Branch**: `main` (working tree, uncommitted)  
**Started**: 2026-05-19

## Summary

Two-phase enhancement to the agent engineering surface:

1. **Phase 1 (COMPLETE)**: Rewrite thin team prompts (reviewer, architect) with concrete, enforceable rubrics. Add `systemPromptAppend` injection mechanism to TeamConfig.
2. **Phase 2 (IN PROGRESS)**: Have Foundry auto-generate per-role skill files during materialization. During `team_launch`, auto-read and inject them via `systemPromptAppend`.

---

## Phase 1 — Completed Changes

### 1a. Reviewer prompt rewritten (`src/team/teamSystemPrompts.js:27-50`)

**Before**: 2 sentences ("review diffs for correctness, style, and risk... blockers, suggestions, nits")

**After**: 10-section structured rubric covering:
- BLOCKERS (must fix, cite line + what + required change)
- SUGGESTIONS (should fix, cite violated convention)
- NITS (optional polish)
- DRY/YAGNI enforcement (no duplication, no speculative abstractions)
- Isolation & boundaries (single responsibility, backward-compatible changes)
- Follow existing patterns (ES modules, Object.freeze, guard clauses, DI seams)
- Code hygiene (no console.log in prod, no commented-out code, clean git)
- Scope isolation (FOR-me byte-unchanged, no cross-persona contamination)
- Error handling (no empty catch blocks — block-worthy)
- Testability (injected deps replaceable, verify tests pass)
- Verify, don't assume (no "looks correct" approvals)
- Review loop (mandatory re-review until all BLOCKERS resolved)
- Outcome (APPROVED or CHANGES_REQUESTED with cited unresolved items)

### 1b. Architect prompt rewritten (`src/team/teamSystemPrompts.js:56-100`)

**Before**: 5 sentences ("decompose roadmap into tasks... write ADRs... bridge Foundry and execution")

**After**: 10-section structured guide covering:
- Spec grounding (read all 7 foundry docs + spec.json BEFORE creating tasks)
- Task decomposition (rigid per-task schema with subject, delivers tokens, dependencyTaskIds, riskLevel, acceptanceCriteria)
- Dependency ordering (DAG enforcement, no cycles, flag chains >3 as high-risk)
- Interface contracts (define module boundaries before implementation tasks)
- ADR management (structured template: Status/Context/Decision/Consequences/Alternatives)
- Living task breakdown (keep task-breakdown.md in sync)
- Spec coverage audit (verify every spec.json structure entry has a delivering task, run drift_run)
- Design proposals (structured: problem → architecture → alternatives → recommendation)
- Boundary (architect designs, does not implement — find issue → create task for developer)
- Quality gates (self-audit before claiming done)

### 1c. `systemPromptAppend` injection mechanism

**Files changed**: `src/team/teamConfig.js`, `src/team/teamSystemPrompts.js`

New field on TeamConfig members: `systemPromptAppend` (string, default `''`). Threaded through `buildAgentSystemPrompt` → `buildLeadSystemPrompt` / `buildTeammateSystemPrompt`. Appended as `ADDITIONAL INSTRUCTIONS:\n<content>` at end of system prompt. Round-trips through `toJSON()` for SQLite persistence.

### 1d. Tests updated

- `test/teamSystemPrompts.test.js`: 7 new tests (reviewer rubric assertions, architect section assertions, systemPromptAppend injection for lead/teammate/unknown roles, empty omit)
- `test/teamConfig.test.js`: 2 new tests (systemPromptAppend defaults, round-trip persistence)

---

## Phase 2 — Plan (NOT YET IMPLEMENTED)

### Goal

When Foundry materializes a project (`foundry_project_materialize`), auto-generate per-role skill files at `docs/foundry/skills/{role}.md` (lead.md, architect.md, developer.md, reviewer.md, tester.md). During `team_launch`, auto-read and inject these files via `systemPromptAppend` if the member doesn't already have one configured.

### Why

Current review rubric says "follow existing patterns" and "match the surrounding codebase" but team agents don't know what stack the project uses. Foundry already knows the stack from `tech_spec.md`. These skill files make "follow existing patterns" actionable by providing stack-specific rules.

Example: A React project's `reviewer.md` would include "verify hooks rules, no direct DOM mutation, proper key usage" while a C# WPF project's `reviewer.md` would include "verify MVVM pattern, no business logic in code-behind, `TreatWarningsAsErrors` on all csproj."

### Implementation Steps

#### Step 1: Add skills doc format to Foundry instructions

File: `src/foundry/foundryInstructions.txt`

Add a `===DOC: skills===` block format that produces per-role project-specific instructions. The block content uses `## role_name` headings to delimit per-role sections.

```
===DOC: skills===
# <Project Name> — Per-Role Skill Files

## lead
<Project-specific orchestration rules, quality gates, and the Foundry doc map>

## architect
<Stack-specific ADR standards, component boundaries from tech_spec, spec.json structure to enforce>

## developer
<Stack patterns, file conventions, testing commands, build steps from steering.md>

## reviewer
<Stack-specific review checklist: framework rules, pattern enforcement, security checks, scope isolation>

## tester
<Test framework commands, coverage targets from definition-of-done.md, validation_run kinds>
===END DOC===
```

#### Step 2: Add `skills` artifact to `buildFoundryArtifacts`

File: `src/tools/localToolFacade.js`, function `buildFoundryArtifacts()`

Parse `===DOC: skills===` from the Foundry transcript (already handled by `parseDocBlocksFromTranscript`). Add as an optional artifact (like steering/dod/adrs — only emit when the chat produced it).

#### Step 3: Split skills into per-role files during export/materialize

File: `src/tools/localToolFacade.js`, `#foundryArtifactExport()` or `#foundryProjectMaterialize()`

When a `skills` artifact is present, parse its `## role_name` sections and write individual files:
- `docs/foundry/skills/lead.md`
- `docs/foundry/skills/architect.md`
- `docs/foundry/skills/developer.md`
- `docs/foundry/skills/reviewer.md`
- `docs/foundry/skills/tester.md`

#### Step 4: Auto-inject during team_launch

File: `src/tools/localToolFacade.js`, `#teamLaunch()`

Before building the system prompt for each member, check:
1. Does the member already have a non-empty `systemPromptAppend`? If so, skip (operator explicitly configured it).
2. Does `docs/foundry/skills/{role}.md` exist? If so, read its content and set it as `systemPromptAppend` on the `launchInput`.

This keeps the injection transparent — no TeamConfig persistence change needed.

#### Step 5: Tests

- `test/teamSystemPrompts.test.js`: Verify skill file content appears in system prompts when present
- `test/foundryArtifacts.test.js`: Verify skills artifact parsing and file splitting
- `test/localToolFacade.test.js`: Verify team_launch auto-injects skill files

### Design Decisions

1. **Auto-read vs manual config**: Auto-read from `docs/foundry/skills/` is preferred because it requires zero operator action. Files generated by Foundry during materialize are automatically picked up on next launch.

2. **Per-role granularity**: Skill files are split per role so each agent only sees their own instructions. A reviewer doesn't need to see the developer's build commands.

3. **Optional — never blocks launch**: If the skills directory or a specific role file doesn't exist, team_launch proceeds without it. Skill files are an enhancement, not a requirement.

4. **Foundry generates — operator can edit**: The files are plain markdown in the workspace. Operators can edit them post-generation to tune agent behavior.

---

## Files Modified So Far

| File | Changes |
|---|---|
| `src/team/teamSystemPrompts.js` | Rewritten reviewer + architect ROLE_GUIDANCE. Added `systemPromptAppend` threading through all prompt builders. |
| `src/team/teamConfig.js` | Added `systemPromptAppend` field to `normalizeMember`. |
| `test/teamSystemPrompts.test.js` | Added 7 tests for new prompts and skill injection. |
| `test/teamConfig.test.js` | Added 2 tests for systemPromptAppend defaults and round-trip. |

## Files TO BE Modified (Phase 2)

| File | Purpose |
|---|---|
| `src/foundry/foundryInstructions.txt` | Add `===DOC: skills===` block format |
| `src/tools/localToolFacade.js` | Handle skills artifact, split into per-role files, auto-inject on team_launch |
| `test/teamSystemPrompts.test.js` | Verify auto-injection path |
| `test/localToolFacade.test.js` | Verify team_launch auto-reads skill files |

