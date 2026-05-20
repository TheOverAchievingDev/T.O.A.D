# Beast Mode Parallel Team Design

Date: 2026-05-17

## Purpose

Beast Mode is an opt-in team template for large projects where a frontier model should plan and orchestrate while several cheaper, specialized, or broader-context CLI agents implement independent slices in parallel.

The goal is not to replace Symphony's existing team orchestration. It is to give that orchestration a stronger default for high-throughput projects: one strong lead, one required architect, multiple developer workers, reviewer and tester gates, and per-task worktree isolation.

## Chosen Approach

Use a Beast Mode team preset with an advanced editor.

The default roster is:

- `lead`: frontier planner and integrator.
- `architect`: required decomposition agent.
- `dev-1`, `dev-2`, `dev-3`: parallel implementation agents.
- `reviewer`: reviews task diffs before merge.
- `tester`: runs validation and edge probes.

The user can edit the developer count, provider, CLI command, model/profile, cost cap, and max parallelism before launch. OpenCode is treated as a bridge provider: Symphony still launches CLI agents, and each OpenCode member can point at a configured local or API model profile such as Qwen, DeepSeek, or other models the operator has configured.

## Workflow

1. User selects Beast Mode in the Create Team flow.
2. Symphony prefills the default roster.
3. User optionally adjusts the roster in the advanced editor.
4. Lead reads Foundry docs and creates the top-level task map.
5. Architect produces a machine-readable parallelization plan.
6. Lead converts the plan into scoped Symphony tasks.
7. Each developer receives at most one runnable implementation task at a time.
8. Every developer task runs in its own task worktree.
9. Reviewer checks task diffs.
10. Tester runs required validation.
11. Lead integrates accepted diffs in the architect-defined merge order.

Developer agents must not start implementation work until the architect plan exists and the lead has turned the plan into scoped tasks.

## Data Model

Beast Mode should extend the existing team config rather than create a separate team type.

Add team-level metadata:

- `teamMode`: `standard | beast`
- `beastConfig.defaultDevCount`
- `beastConfig.maxParallelDevs`
- `beastConfig.requireArchitectPlan`
- `beastConfig.worktreePolicy`: initially `per_task`
- `beastConfig.integrationPolicy`: initially `lead_ordered`
- `beastConfig.githubMirror`: `off | issues | issues_and_prs`

Add or formalize member metadata:

- `providerId`
- `command`
- `model` or `profile`
- `role`
- `parallelSlot` for developer workers

Store the architect output as a durable artifact, not only as chat text:

```json
{
  "planId": "ap-001",
  "teamId": "team-alpha",
  "slices": [
    {
      "id": "slice-ui-flow",
      "title": "Build flow canvas UI",
      "assignedRole": "developer",
      "allowedPaths": ["ui/src/components/...", "ui/src/styles/..."],
      "blockedPaths": [],
      "dependsOn": [],
      "validation": ["npm run typecheck", "npm test"],
      "mergeOrder": 2,
      "conflictRisk": "medium",
      "preferredAgent": "dev-1"
    }
  ]
}
```

Tasks created from this plan should carry:

- `workSliceId`
- `allowedPaths`
- `blockedPaths`
- `dependsOn`
- `mergeOrder`
- `conflictRisk`
- `architectPlanId`

## UI

Beast Mode belongs in the existing Create Team modal.

Create Team changes:

- Add a `Standard` / `Beast` mode selector.
- When `Beast` is selected, prefill the default roster.
- Add an advanced section for developer count, provider/model/profile, max parallelism, GitHub mirroring, and caps.
- Show unavailable providers before launch when auth or CLI detection fails.

Cockpit changes:

- Show a Beast Mode badge when active.
- Add a pipeline indicator: `Architect planning`, `Tasks scoped`, `Devs running`, `Review`, `Validation`, `Integrating`.
- In Flow view, show developer fan-out from the architect or lead plan into parallel task worktrees.
- In Inspector, show assigned developer, worktree path, allowed paths, dependency blockers, validation status, and merge order.

## Guardrails

Beast Mode v1 has these hard rules:

- Architect gate: developer agents cannot receive implementation tasks until a valid architect plan artifact exists.
- One task, one developer, one worktree.
- Scoped writes: task execution inherits `allowedPaths` and `blockedPaths` from the architect plan.
- No Symphony repo work: existing repo-isolation guardrails still apply.
- Merge order: lead integrates completed work according to `mergeOrder`.
- Conflict prevention: slices with overlapping write scopes cannot run in parallel unless the user explicitly overrides.
- Review required: implementation cannot move to merge-ready without reviewer approval.
- Validation required: tester or validation worker must run required checks before done.
- Provider role policy: lead and architect default to frontier providers; developer workers may use OpenCode profiles, Codex, Claude, or other CLI-backed providers; Gemini remains suited to research, testing, summarizing, and large-context work unless policy is changed.
- Cost and concurrency cap: default to three parallel developers and make the cap visible.

Failure behavior:

- If the architect plan fails, stop before developer launch and surface the failure.
- If a provider is missing or unauthenticated, mark the role unavailable and let the user swap provider/profile.
- If a worktree cannot be created, do not fall back to shared-folder coding.
- If validation fails, return the task to the assigned developer or let the lead reassign it.
- If merge conflicts occur, the lead creates a conflict-resolution task instead of silently merging.

## GitHub Integration

GitHub integration is optional and should mirror Symphony state, not replace it.

Recommended mapping:

- Foundry project or epic -> GitHub parent issue.
- Symphony tasks -> GitHub sub-issues.
- Task worktrees -> task branches.
- Accepted task results -> pull requests when `githubMirror` is `issues_and_prs`.

Symphony remains the source of truth for assignment, runtime state, worktrees, drift findings, validation gates, and merge readiness.

## Testing Strategy

Unit tests:

- Beast team template produces the expected default roster.
- Advanced edits preserve provider/model/profile choices.
- Architect plan validation rejects missing slices, duplicate slice IDs, missing allowed paths, invalid dependency references, and overlapping parallel write scopes.
- Task creation from an architect plan copies scope, dependency, validation, and merge-order metadata.
- Scheduler refuses to assign developer implementation tasks before the architect plan exists.

Integration tests:

- Beast Mode launch creates lead and architect first, waits for architect plan, then launches or activates developer tasks.
- Each developer task gets a distinct task worktree.
- Failed worktree creation blocks task assignment.
- Overlapping slices are serialized or blocked unless explicitly overridden.
- Reviewer and tester gates are required before merge-ready.

UI tests:

- Create Team toggles between Standard and Beast modes.
- Beast preset renders the default roster.
- Advanced editor can add/remove developer slots and change provider/profile.
- Cockpit shows Beast Mode pipeline state and per-task worktree metadata.

## Open Questions Deferred From V1

- Dynamic scheduler that chooses developer count based on task count, provider availability, and cost caps.
- Tournament mode where multiple models attempt the same task and the lead selects the best result.
- Full GitHub Projects synchronization.
- Automatic provider benchmarking to choose which OpenCode profile gets which slice.
