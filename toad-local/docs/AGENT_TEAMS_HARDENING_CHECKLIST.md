# Agent Teams UI Hardening / Reverse-Engineering Checklist (Final v2)

## Core Principle

Structured specs in.  
Deterministic state machine around them.  
Bounded loops.  
Isolated worktrees.  
Diffs + CI as truth.  
Tests as contract.  
Risk-tiered gates.  
Humans on escalation.

---

# Recommended Next Artifact: Bootstrap Spec First

## Recommendation

Create a **bootstrap spec** before creating a rigid task graph.

Reason: this project is being reverse-engineered, and some claimed features may not actually work. A task graph created too early may encode wrong assumptions about the codebase.

## Best sequence

```text
1. Bootstrap spec
2. Repo inspection / claim verification
3. Gap analysis against this checklist
4. Generate repo-specific task graph
5. Execute tasks phase by phase
```

## Bootstrap spec goal

**Harden `claude_agent_teams_ui` into a reliable multi-agent CLI orchestrator.**

The lead agent should:

- inspect the current implementation
- verify each claimed feature
- identify which features are real, partial, broken, or missing
- map findings to this checklist
- create implementation tasks from actual repo evidence
- prioritize core workflow reliability before cosmetic UI work
- enforce state machine, diffs, CI, role/tool authority, and auditability first

## Bootstrap spec constraints

The lead agent must not assume README claims are true.  
The lead agent must verify behavior from code, tests, scripts, and runnable flows.  
The lead agent must produce evidence for each finding.  
The lead agent must not start broad refactors until core workflow gaps are mapped.

---

# Truth Model

The system has multiple layers of truth:

```text
Task DB        = workflow truth
Git diff       = code-change truth
CI/test logs   = execution truth
Review results = quality judgment
Audit log      = replay/history truth
```

A task is only truly done when all relevant truth layers agree.

---

# Done Rule

A task is DONE only if:

- task contract is satisfied
- state transition is legal
- changed files are known
- diff exists and is within scope
- orchestrator-run CI/tests pass
- review has no blocking findings
- risk gates pass
- integration/merge status is known
- audit trail exists

---

# 1. Strict Task Contract / Schema

Every task must have a normalized schema.

Required fields:

- id
- title
- goal
- background/context
- status
- priority
- assigned role
- assigned agent
- parent task
- dependencies
- allowed files
- forbidden files
- acceptance criteria
- test commands
- expected deliverables
- risk level
- human approval requirement
- timestamps

Example fields:

```ts
type AgentTask = {
  id: string
  title: string
  goal: string
  background?: string

  status:
    | "backlog"
    | "ready"
    | "planned"
    | "in_progress"
    | "blocked"
    | "review"
    | "testing"
    | "merge_ready"
    | "done"
    | "rejected"

  priority: "low" | "medium" | "high" | "critical"

  assignedRole?: "lead" | "architect" | "developer" | "reviewer" | "tester"
  assignedAgentId?: string

  createdByAgentId?: string
  parentTaskId?: string
  dependencyTaskIds: string[]

  allowedFiles?: string[]
  forbiddenFiles?: string[]

  acceptanceCriteria: string[]
  testCommands: string[]

  expectedDeliverables: {
    codeChanges?: boolean
    tests?: boolean
    docs?: boolean
    investigationReport?: boolean
  }

  riskLevel: "low" | "medium" | "high"
  requiresHumanApproval: boolean

  plan?: AgentPlan
  implementationSummary?: string
  reviewSummary?: string
  testSummary?: string

  createdAt: string
  updatedAt: string
}
```

Enforcement:

- Cannot move to `ready` without goal, acceptance criteria, and test commands.
- Cannot move to `in_progress` without assignment.
- Cannot move to `review` without implementation summary and diff.
- Cannot move to `testing` without review approval.
- Cannot move to `merge_ready` without passing orchestrator-run checks.
- Cannot move to `done` without integration or explicit acceptance.

---

# 2. Plan-Before-Code Gate

Before editing files, a developer agent must submit a structured plan.

```ts
type AgentPlan = {
  taskId: string
  agentId: string
  summary: string
  filesExpectedToChange: string[]
  approach: string[]
  risks: string[]
  validationPlan: string[]
  requiresApproval: boolean
}
```

Rules:

- No implementation before plan exists.
- High-risk tasks require lead, architect, or human approval.
- If actual changed files differ from planned files, flag the task.
- Plan must be visible in the task detail view.

---

# 3. Deterministic State Machine

The orchestrator, not agents, owns task state transitions.

Example transition table:

```ts
const allowedTransitions = {
  backlog: ["ready", "rejected"],
  ready: ["planned", "blocked"],
  planned: ["in_progress", "blocked"],
  in_progress: ["review", "blocked"],
  review: ["testing", "in_progress", "rejected"],
  testing: ["merge_ready", "in_progress", "blocked"],
  merge_ready: ["done", "in_progress"],
  blocked: ["ready", "planned", "in_progress"],
  done: [],
  rejected: ["backlog"]
}
```

Rules:

- Invalid transitions are rejected.
- Every transition records actor, reason, timestamp, previous state, and next state.
- UI and backend must use the same transition logic.
- Agents can request transitions; the orchestrator decides.

---

# 4. Structured Message Board Events

The message board should be event-sourced and append-only.

Event types:

```ts
type BoardEventType =
  | "TASK_CREATED"
  | "TASK_ASSIGNED"
  | "PLAN_PROPOSED"
  | "PLAN_APPROVED"
  | "PLAN_REJECTED"
  | "WORK_STARTED"
  | "PATCH_READY"
  | "REVIEW_REQUESTED"
  | "REVIEW_APPROVED"
  | "REVIEW_REJECTED"
  | "TEST_REQUESTED"
  | "TEST_PASSED"
  | "TEST_FAILED"
  | "TASK_BLOCKED"
  | "TASK_UNBLOCKED"
  | "MERGE_READY"
  | "HUMAN_APPROVAL_REQUESTED"
  | "TASK_DONE"
```

Message schema:

```ts
type AgentBoardEvent = {
  id: string
  type: BoardEventType
  taskId?: string
  fromAgentId: string
  toAgentId?: string
  toRole?: string
  parentMessageId?: string
  content: string
  metadata?: Record<string, unknown>
  createdAt: string
}
```

Rules:

- All status changes create events.
- All agent handoffs create events.
- Structured events drive routing.
- Free text may exist only inside a body/content field.
- Message board is the audit/event log; task DB remains workflow source of truth.

---

# 5. Role Permissions / Authority Boundaries

Enforce role authority in code, not just prompts.

| Action | Lead | Architect | Developer | Reviewer | Tester | Human |
|---|---:|---:|---:|---:|---:|---:|
| Create task | yes | yes | limited | limited | limited | yes |
| Assign task | yes | no | no | no | no | yes |
| Approve plan | yes | yes | no | no | no | yes |
| Implement | no | limited | yes | no | no | yes |
| Review implementation | yes | yes | no self-review | yes | no | yes |
| Run tests | yes | no | yes | no | yes | yes |
| Mark merge-ready | yes | no | no | yes | yes | yes |
| Mark done | yes | no | no | no | no | yes/lead |

Rules:

- Same agent cannot implement and approve its own work.
- Developer cannot move a task directly to done.
- Tester cannot approve code review.
- Reviewer cannot bypass failed tests.
- Human approval required for high-risk actions.

---

# 6. Deterministic CI / Test Gates

Validation must be orchestrator-executed, not agent-claimed.

Project validation config:

```ts
type ProjectValidationConfig = {
  installCommand?: string
  lintCommand?: string
  typecheckCommand?: string
  testCommand?: string
  buildCommand?: string
  securityCommand?: string
}
```

Rules:

- Store every command run.
- Store exit code, stdout/stderr, duration, timestamp, and runner.
- Failed command blocks `merge_ready`.
- If no validation config exists, show warning.
- Agent claims never override orchestrator-run command results.

---

# 7. Real Changed-File and Diff Tracking

Each task needs task-scoped code truth.

```ts
type TaskChangeSet = {
  taskId: string
  baseRef: string
  headRef: string
  changedFiles: {
    path: string
    status: "added" | "modified" | "deleted" | "renamed"
    additions: number
    deletions: number
    diff?: string
  }[]
}
```

Rules:

- Every task has a base ref before work starts.
- Diff is computed from base ref to current worktree/branch.
- Review UI shows task-specific diffs only.
- Out-of-scope files are flagged.
- Empty diff with claimed completion is failure.
- Multiple tasks editing same files should create conflict warnings.

---

# 8. Branch / Worktree Enforcement

Support these strategies:

```ts
type BranchStrategy =
  | "single_branch"
  | "branch_per_task"
  | "worktree_per_agent"
  | "worktree_per_task"
```

Recommended default:

```text
worktree_per_task
```

Rules:

- System creates branches/worktrees; agents do not merely get prompted.
- Task stores branch and worktree path.
- Agent process launches inside assigned worktree.
- Agent cannot work outside assigned repo path.
- Merge conflict detection runs before `merge_ready`.

---

# 9. WIP Limits and Flow Control

Use stage-aware WIP limits, not just one global limit.

```ts
type TeamFlowConfig = {
  maxActiveTasks: number
  maxInProgress: number
  maxInReview: number
  maxInTesting: number
  maxTasksPerAgent: number
  maxReviewQueueSize: number
  maxTestingQueueSize: number
  allowParallelSameFileEdits: boolean
}
```

Rules:

- Block new implementation when review/testing queues are overloaded.
- Warn when multiple active tasks touch same files.
- Prevent infinite task creation by lead or agents.
- Prioritize bottleneck clearing.

---

# 10. Task Dependency Enforcement

Rules:

- Task with unresolved dependencies cannot enter `in_progress`.
- Dependent task auto-unblocks when dependencies complete.
- Circular dependencies are rejected.
- Dependency graph visible in UI.
- Parent task cannot complete while child tasks remain open.

---

# 11. Agent Session Lifecycle Tracking

Track every CLI agent process.

```ts
type AgentSession = {
  id: string
  agentId: string
  provider: "claude" | "codex" | "opencode" | "gemini" | "other"
  model?: string
  taskId?: string
  processId?: number
  cwd: string
  startedAt: string
  endedAt?: string
  status: "starting" | "running" | "completed" | "failed" | "killed"
  exitCode?: number
  logPath?: string
}
```

Rules:

- Every process maps to an agent and task.
- Killing/restarting process creates audit events.
- Logs are session-scoped and task-scoped.
- Failed process cannot silently mark task complete.

---

# 12. Provider Abstraction Layer

Different CLI agents need a common runtime interface.

```ts
interface AgentRuntimeProvider {
  id: string
  displayName: string

  detect(): Promise<ProviderDetectionResult>
  getCapabilities(): ProviderCapabilities

  buildCommand(input: AgentInvocation): Promise<CommandSpec>
  parseOutput(chunk: string): ProviderParsedEvent[]
  stop(sessionId: string): Promise<void>
}
```

Capabilities:

```ts
type ProviderCapabilities = {
  supportsTools: boolean
  supportsPlanMode: boolean
  supportsJsonOutput: boolean
  supportsResume: boolean
  supportsWorktreeCwd: boolean
  supportsApprovalMode: boolean
  supportsModelSelection: boolean
}
```

Rules:

- No provider-specific assumptions inside orchestration core.
- Provider output normalizes into shared event types.
- Provider failures normalize into common error types.
- Detection distinguishes unavailable, unauthenticated, rate-limited, and ready states.

---

# 13. Failure Detection

Detect more than loops.

Failure modes:

- false success
- scope drift
- spec misinterpretation
- conflicting parallel changes
- partial completion
- silent CLI failure
- overconfident review
- missing tests
- no-op diff
- repeated failed commands

Rules:

- Mark task blocked or needs-human when failure conditions trigger.
- Store evidence.
- Stop runaway work.
- Escalate after threshold.

Example conditions:

```text
FAIL or BLOCK if:
- changed files are outside allowedFiles
- diff is empty but task claims completion
- CI was not run but task claims done
- reviewer returns no findings or checklist on large diff
- repeated test failures exceed threshold
- agent exits nonzero
```

---

# 14. Risk / Safety Policies

Risk policy should trigger from files, commands, and task metadata.

High-risk areas:

- auth/security
- secrets
- database migrations
- payments/billing
- deployment scripts
- CI/CD config
- dependency upgrades
- package lockfiles
- destructive filesystem commands
- environment/config files

Rules:

- Risk policy configurable per project.
- High-risk changes require human approval.
- Agents can request approval, not bypass it.
- Destructive commands require confirmation or sandboxing.

---

# 15. Context Packs

Generate role-specific context.

```ts
type TaskContextPack = {
  task: AgentTask
  relevantFiles: string[]
  relevantSymbols?: string[]
  recentEvents: AgentBoardEvent[]
  repoInstructions?: string
  constraints: string[]
  validationCommands: string[]
  verifiedKnowledge?: string[]
}
```

Role context:

- Developer: task, relevant files, constraints, validation commands.
- Reviewer: task, plan, diff, acceptance criteria, standards.
- Tester: acceptance criteria, test commands, changed files.
- Lead: board summary, blockers, risks, flow state.
- Architect: design context, ADRs, boundaries, ambiguity questions.

Rules:

- No full repo dumping by default.
- No implicit cross-task memory.
- Include only validated durable knowledge.

---

# 16. Role-Specific Prompt Templates

Define templates for:

- lead
- architect
- developer
- reviewer
- tester
- integration/release agent

Each prompt must include:

- role
- task contract
- allowed tools
- forbidden tools
- current state
- context pack
- required output schema
- stop conditions

Reviewer prompt must check:

- spec compliance
- changed files within scope
- diff correctness
- test adequacy
- security/config risk
- maintainability
- edge cases
- blocking findings

Reject empty or generic reviews.

---

# 17. Review Artifacts

Reviews must be structured and enforceable.

```ts
type ReviewResult = {
  taskId: string
  reviewerAgentId: string
  verdict: "approved" | "changes_requested" | "rejected"
  findings: {
    severity: "nit" | "minor" | "major" | "blocking"
    file?: string
    line?: number
    message: string
    suggestedFix?: string
  }[]
  summary: string
  createdAt: string
}
```

Rules:

- Review result is stored separately from chat.
- Blocking findings prevent progress.
- Same agent cannot review own work.
- Large diffs require checklist completion.

---

# 18. Test Artifacts

Store structured test results.

```ts
type TestResult = {
  taskId: string
  testerAgentId?: string
  commands: {
    command: string
    exitCode: number
    stdoutPath?: string
    stderrPath?: string
    durationMs: number
  }[]
  verdict: "passed" | "failed" | "not_run"
  failureSummary?: string
  reproductionSteps?: string[]
}
```

Rules:

- Failed tests return task to `in_progress`.
- Passing orchestrator-run tests required for `merge_ready`.
- “Not run” must be explicit.
- Test logs must be preserved.

---

# 19. Merge / Integration Workflow

Steps:

1. Verify task diff.
2. Rebase/merge latest trunk.
3. Run validation commands.
4. Resolve conflicts.
5. Mark `merge_ready`.
6. Lead/human approves.
7. Apply/merge.
8. Mark `done`.

Rules:

- Done requires integration or explicit non-code acceptance.
- Merge failures reopen task.
- Integration logs are stored.
- UI distinguishes unmerged vs merged work.

---

# 20. Audit Trail and Replayability

Every meaningful action stores:

- actor
- role
- task
- event type
- old state
- new state
- command/session id
- timestamp
- raw provider output reference

Rules:

- Full replay should be possible.
- User can reconstruct why a task moved.
- No invisible state mutations.
- Export task history as JSON/Markdown.

---

# 21. Claim Verification Tests

Write tests for every advertised behavior.

Verify:

- agents can message each other
- agents can create tasks
- agents can assign/manage tasks
- agents can review tasks
- Kanban status updates correctly
- task-specific logs are isolated
- diffs are task-specific
- dependencies block execution
- worktree mode isolates agents
- providers are detected correctly
- approval modes actually block actions
- context recovery works

Rules:

- README claims are not accepted until tested.
- Each claim should be marked real, partial, broken, or missing.

---

# 22. Integration / E2E Test Harness

Required scenarios:

## Scenario A: Happy path
- Human creates feature request.
- Lead creates task.
- Developer plans.
- Plan approved.
- Developer implements.
- Reviewer approves.
- Tester validates.
- Task becomes merge-ready/done.

## Scenario B: Bad implementation
- Developer changes wrong file.
- Reviewer catches scope violation.
- Task returns to in-progress.

## Scenario C: Failing tests
- Developer creates broken implementation.
- Orchestrator-run test fails.
- Task returns to in-progress.

## Scenario D: Dependency blocking
- Task B depends on Task A.
- Task B cannot start until A is done.

## Scenario E: Self-review prevention
- Developer attempts to approve own task.
- System rejects action.

## Scenario F: Provider failure
- CLI exits nonzero.
- Task becomes blocked.
- Logs show failure.

---

# 23. UI Trust Indicators

Add board/task badges:

- no plan
- plan approved
- out-of-scope files changed
- review passed
- review blocked
- tests passed
- tests failed
- needs human approval
- merge conflict
- provider failed
- stuck task
- worktree dirty
- no validation configured
- no diff
- no CI proof

Goal: user can tell whether a task is genuinely safe or merely agent-claimed complete.

---

# 24. Configuration System

Suggested directory:

```text
.agent-teams/
  config.json
  workflow.json
  validation.json
  risk-policy.json
  tools.json
  budgets.json
  roles/
    lead.md
    architect.md
    developer.md
    reviewer.md
    tester.md
```

Example validation config:

```json
{
  "installCommand": "pnpm install",
  "lintCommand": "pnpm lint",
  "typecheckCommand": "pnpm typecheck",
  "testCommand": "pnpm test",
  "buildCommand": "pnpm build"
}
```

---

# 25. Diagnostics Panel

Diagnostics should verify current capabilities.

Checks:

- provider detected
- provider authenticated
- git repo detected
- worktree creation works
- validation commands configured
- task creation works
- message sending works
- agent session launch works
- session logs map to task
- task diff can be computed
- tests can be run
- invalid transitions are blocked
- human approval gate works
- role tool permissions enforced

Output format:

```text
PASS / FAIL / WARNING
Evidence
Suggested fix
```

---

# 26. Tool / MCP Authority by Role

Tool access is a stronger boundary than prompts.

Examples:

- Developer: read files, edit assigned files, run local tests.
- Reviewer: read files, read diffs, comment, request changes.
- Tester: run test commands, create test reports.
- Lead: create/assign tasks, approve transitions, manage WIP.
- Architect: create ADRs, answer design ambiguity, approve architecture.
- Human/Admin: merge, deploy, approve high-risk operations.

Rules:

- Developer should not have merge/deploy tools.
- Reviewer should not have write tools.
- Tester should not modify implementation files unless explicitly assigned.
- Risky tools require elevated permission.
- Tool permissions must be enforced by runtime, not prompt text.
- Every denied tool call should be logged.

---

# 27. Prompt Construction Standards

Role-specific prompts must be generated systematically.

Prompt inputs:

- role definition
- task contract
- current task state
- allowed tools
- forbidden tools
- relevant context pack
- project standards
- required output schema
- stop conditions
- known constraints

Reviewer prompt is highest leverage.

Reviewer must explicitly answer:

- Does the diff satisfy the spec?
- Are changes within scope?
- Are acceptance criteria covered?
- Are tests adequate?
- Are there security/config risks?
- Are there maintainability concerns?
- Are there blocking findings?

Rules:

- Reject generic approvals.
- Reject reviews that do not reference the diff.
- Reject reviews that do not reference acceptance criteria.
- Reject reviews with no checklist on large or risky changes.

---

# 28. Token / Cost Budgets

Track budgets separately from iteration limits.

Track per:

- task
- agent session
- role
- provider
- project

Budget fields:

```ts
type BudgetConfig = {
  maxTokensPerTask?: number
  maxTokensPerSession?: number
  maxCostPerTaskUsd?: number
  maxWallClockMs?: number
  maxIterations?: number
}
```

Rules:

- Budget exceeded means pause or escalate.
- Repeated retries require approval.
- UI should show estimated vs actual cost.
- Prevent silent token burn even if the agent is not looping.

---

# 29. Agent-Level Evaluation Suite

Before swapping providers/models, run role-specific evals.

Examples:

- Developer eval: implement small feature correctly.
- Reviewer eval: catch seeded bug and scope violation.
- Tester eval: write or validate failing acceptance test.
- Architect eval: detect poor boundary/design tradeoff.
- Lead eval: decompose feature into good tasks.

Rules:

- E2E tests validate the system.
- Role evals validate agent/provider quality.
- Provider changes require eval comparison.
- Store eval results by provider, model, role, and prompt version.

---

# 30. Knowledge Propagation

Agents discover durable repo knowledge. Capture it deliberately.

Examples:

- custom test runner
- non-standard build step
- generated files
- architectural convention
- flaky test workaround
- codegen requirement
- package manager convention
- naming convention

Knowledge types:

```ts
type ProjectKnowledge = {
  id: string
  scope: "project" | "directory" | "file" | "task"
  claim: string
  evidence: string[]
  status: "proposed" | "validated" | "rejected"
  discoveredByAgentId: string
  createdAt: string
}
```

Rules:

- Proposed knowledge is not automatically trusted.
- Validate before injecting into future context packs.
- Relevant validated knowledge should appear in future task contexts.
- Outdated knowledge should be invalidated when contradicted.

---

# 31. Conflict Resolution Protocol

Define explicit tie-break rules.

Examples:

- Reviewer vs developer: reviewer blocks unless lead overrides.
- Tester vs developer: orchestrator-run test result blocks unless test is invalidated.
- CI vs agent claim: CI wins.
- Architect vs lead: architect owns technical design; lead owns priority.
- Two reviewers disagree: escalate to lead or human.
- Human vs agent: human wins, but override is logged.

Rules:

- Every override requires reason.
- Override creates audit event.
- Repeated conflicts should trigger process review.
- No agent can silently override another role’s blocking decision.

---

# 32. Failure Recovery Semantics

Session tracking is not enough. Define recovery behavior.

Handle:

- agent crash
- CLI timeout
- partial file edits
- dirty worktree
- failed dependency install
- interrupted test run
- corrupt task state
- provider rate limit
- machine reboot
- duplicate retry

Recovery classification:

```ts
type RecoveryMode =
  | "resume"
  | "retry_idempotent_step"
  | "rollback_worktree"
  | "preserve_and_escalate"
  | "abandon_task_branch"
```

Rules:

- Detect resumable vs non-resumable failure.
- Preserve logs before cleanup.
- Snapshot dirty worktree before rollback.
- Retry only idempotent steps.
- Escalate when cleanup may destroy useful work.

---

# 33. Resume Protocol

Store enough state to resume safely.

Required resume state:

- task id
- last completed step
- current status
- assigned role/agent
- worktree path
- branch name
- base commit
- current head commit
- changed files
- last successful command
- last failed command
- pending transition
- active session id
- provider used
- prompt/context version

Resume must not duplicate:

- task creation
- branch creation
- already-applied patches
- already-recorded review artifacts
- already-recorded test artifacts
- already-sent state transition events

Rules:

- Resume should verify worktree and task DB agree.
- If repo state and task DB disagree, run reconciliation.
- If reconciliation fails, escalate.

---

# 34. Bootstrap Spec Template

Use this as the initial instruction to the team lead agent.

```md
# Bootstrap Spec: Harden claude_agent_teams_ui

## Mission

Inspect and harden this repository into a reliable multi-agent CLI orchestrator with role-based agents, structured task lifecycle, message-board coordination, deterministic gates, and verified claims.

## Do Not Assume

Do not assume README claims are implemented.
Do not assume UI behavior reflects backend enforcement.
Do not assume prompt instructions equal system guarantees.
Do not assume agent claims equal execution truth.

## Phase 1: Repo Inspection

Identify:
- app architecture
- storage model
- task model
- message model
- agent runtime model
- provider abstraction
- CLI launch mechanism
- git/worktree integration
- test/build commands
- existing tests
- claimed features

Output:
- current architecture summary
- evidence-backed feature inventory
- list of broken/partial/missing claims

## Phase 2: Gap Mapping

Map findings to checklist sections:
- task schema
- state machine
- events
- role/tool authority
- CI gates
- diff tracking
- worktree isolation
- WIP limits
- dependencies
- session tracking
- provider abstraction
- failure recovery
- diagnostics

Output:
- gap matrix
- severity per gap
- recommended implementation order

## Phase 3: Task Graph Generation

Create implementation tasks from actual repo findings.

Each task must include:
- goal
- scope
- allowed files
- acceptance criteria
- test commands
- risk level
- dependencies
- done condition

Prioritize:
1. state model
2. event/audit model
3. role/tool authority
4. provider/session tracking
5. diff/worktree truth
6. CI/test gates
7. review/test artifacts
8. diagnostics
9. UI trust indicators

## Phase 4: Execute Safely

For each task:
- create plan
- get required approval
- implement in isolated branch/worktree
- record diff
- run tests
- create review artifact
- create test artifact
- update audit trail

## Non-Goals Initially

Do not prioritize:
- cosmetic UI polish
- large rewrites
- speculative new features
- provider-specific hacks
- autonomous merge/deploy

## Final Done Criteria

The system is hardened only when:
- README claims are verified by tests or diagnostics
- task lifecycle is enforced by state machine
- role/tool permissions are enforced
- work is isolated per branch/worktree
- changed files are tracked per task
- CI/test results are orchestrator-run and stored
- reviews are structured and severity-tagged
- high-risk actions require approval
- failures can be resumed or recovered safely
- diagnostics show PASS/WARNING/FAIL with evidence
```

---

# 35. What Else Before Handing to Agents

Add these final instructions to reduce agent drift.

## Ask the CLI agent to produce three reports first

1. **Architecture report**
   - What exists?
   - Where is it implemented?
   - What is real vs claimed?

2. **Gap matrix**
   - Checklist item
   - current status
   - evidence
   - severity
   - proposed fix

3. **Execution plan**
   - task order
   - dependencies
   - risks
   - test strategy

## Require evidence

Every finding should cite:

- file path
- function/class/component
- test
- command output
- reproduction step

## Avoid premature implementation

Do not let the agent start coding before it has mapped the repo.

## Start with enforcement, not UI

Core priority:

```text
state machine > tool authority > session tracking > diff tracking > CI gates > diagnostics > UI polish
```

## Keep humans in the loop for high-risk changes

Especially:

- auth
- secrets
- migrations
- destructive filesystem actions
- dependency upgrades
- provider execution changes
- merge/deploy behavior

---

# Implementation Phases

## Phase 1: Make state reliable

1. Task schema
2. State machine
3. Structured events
4. Audit trail

## Phase 2: Make agents accountable

5. Role permissions
6. Tool authority
7. Plan-before-code
8. Session lifecycle tracking
9. Provider abstraction cleanup

## Phase 3: Make code changes trustworthy

10. Branch/worktree enforcement
11. Diff tracking
12. Review artifacts
13. Test artifacts
14. CI/test gates

## Phase 4: Make autonomy safe

15. WIP limits
16. Dependency enforcement
17. Risk policies
18. Failure detection
19. Recovery/resume protocol
20. Human approval gates

## Phase 5: Prove the claims

21. Diagnostics panel
22. Claim verification tests
23. E2E test harness
24. Agent-level evals
25. UI trust indicators

---

# Final Build Rule

Build against:

1. **This checklist** as the implementation spine.
2. **Spec-driven + TDD + trunk-based methodology** as the operating philosophy.
3. **Deterministic orchestration** as the system guarantee.
4. **Provider-agnostic role contracts** as the extensibility model.
5. **Diff + CI + audit trail** as the truth model.
