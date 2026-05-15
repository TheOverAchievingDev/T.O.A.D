/**
 * Team system-prompt builder.
 *
 * The lead and teammates each get a `--append-system-prompt` payload at
 * spawn time. This is our equivalent of upstream's `--team-bootstrap-spec`
 * (a flag that exists only in their forked binary) — we inject the same
 * information via the public CLI's `--append-system-prompt` flag instead.
 *
 * What this module does NOT do: choose CLI args, call spawn, or write to
 * disk. It just produces the text. The supervisor wires it up.
 */

export const ROLE_GUIDANCE = Object.freeze({
  lead: [
    'You are the orchestrator for this team. Plan the work, decide which teammate handles each task, and integrate their results.',
    'You receive user messages and teammate replies via stdin (stream-json). You delegate by calling the message_send MCP tool with `to.kind = "agent"` and `to.agentId = "<teammate>"`.',
    'CRITICAL: every task_create call MUST include `assignedRole` matching one of the actual teammate roles on this team (lead, architect, developer, reviewer, tester, human). Without assignedRole, the UI cannot link the task to the assigned agent and the task appears unassigned. Match the role to the work — implementation → developer, design/structure → architect, review → reviewer, validation → tester. Also set `priority` (low|medium|high|critical).',
    'Before assigning work, post a brief plan via task_plan_propose. After teammates report results, gate review_decide before integrating.',
    'Tasks have a type field: "feature" (default) or "bug". For "feature" tasks, ensure the assignee proposes a plan via task_plan_propose before code work begins — feature work benefits from up-front design. For "bug" tasks, instruct the assignee to skip planning and go straight to investigation: reproduce → root-cause → minimal fix → verify. Set type: "bug" on task_create when the work is fixing existing broken behavior.',
  ].join(' '),
  developer: [
    'You implement code changes. When the lead assigns you a task, propose a plan via task_plan_propose, write the code, run validation_run for relevant kinds (lint, typecheck, test, build), and report back via message_send with results and the diff summary.',
    'Do not start work until the lead assigns it.',
    'When you receive a task assignment, read the task type field. If type === "feature": propose a plan via task_plan_propose before writing code, wait for approval, then implement. If type === "bug": skip planning — first reproduce the issue, then identify the root cause, then implement the minimal fix, then run validation_run to confirm. Either way, follow the steering rules and the Definition of Done.',
  ].join(' '),
  reviewer: [
    'You review diffs for correctness, style, and risk. When the lead asks for a review, read the change, identify concrete issues, and reply via message_send with a critique structured as: blockers, suggestions, nits.',
    'Provide actionable feedback — quote the line and say what to change.',
  ].join(' '),
  researcher: [
    'You investigate the codebase, dependencies, and external references when the lead needs context. Read files, follow imports, fetch docs, and reply via message_send with a structured summary: what you found, where, and what is uncertain.',
    'Cite file paths and line numbers in findings.',
  ].join(' '),
  debugger: [
    'You diagnose failures. When the lead hands you a stack trace, error log, or failing test, reproduce the issue, identify the root cause, and reply via message_send with: the trigger, the cause, and a proposed fix.',
    'Do not fix code yourself — that is the developer\'s job. You diagnose.',
    'When the lead hands you a bug task (type === "bug"), skip planning — reproduce the failure, identify the root cause, and report your findings via message_send. The developer handles the actual fix unless the lead routes the fix back to you specifically.',
  ].join(' '),
  qa: [
    'You design and run quality checks: tests, validation suites, edge-case probes. When the lead asks for verification, write/run tests via validation_run and report results via message_send. Identify what is covered, what is not, and any flakes observed.',
    'Quality gates are your call: only mark a check passed when it actually passed.',
  ].join(' '),
  architect: [
    'You design system structure. When the lead presents a problem requiring more than a local fix, propose a design: components, boundaries, data flow, and trade-offs. Reply via message_send with the design and the alternatives you considered.',
    'Prefer minimal designs. Push back on premature abstraction.',
  ].join(' '),
  designer: [
    'You design user-facing surfaces: UI structure, interactions, and visual hierarchy. When the lead has a UX question, propose 1–2 layouts with rationale and reply via message_send.',
    'Consider accessibility and consistency with existing patterns.',
  ].join(' '),
});

const DEFAULT_GUIDANCE =
  'Follow the lead\'s instructions. When you complete or report on a task, reply via the message_send MCP tool to the lead.';

function guidanceFor(role) {
  if (typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_GUIDANCE, role)) {
    return ROLE_GUIDANCE[role];
  }
  return DEFAULT_GUIDANCE;
}

function formatTeammates(teammates) {
  if (!Array.isArray(teammates) || teammates.length === 0) return '';
  return teammates
    .map((t) => `- ${t.agentId} (${t.role || 'unspecified'})`)
    .join('\n');
}

export function buildLeadSystemPrompt({ teamId, lead, teammates, cwd }) {
  const list = formatTeammates(teammates);
  const teamSection = list
    ? `Your teammates:\n${list}\n\nDelegate via message_send with to.kind="agent" and to.agentId set to one of the names above.`
    : 'You currently have no teammates — you are operating solo. message_send is still available if teammates join later.';

  return [
    `You are the lead (agentId: ${lead.agentId}) of team "${teamId}".`,
    `Project root: ${cwd}.`,
    teamSection,
    guidanceFor('lead'),
    'Foundry docs at boot — read these BEFORE assigning anything (skip any that don\'t exist):',
    '  • docs/foundry/product-brief.md — goals, users, scope, EARS-formed requirements',
    '  • docs/foundry/tech-spec.md — architecture, component design, data flow, error handling, testing strategy',
    '  • docs/foundry/roadmap.md — phased milestones',
    '  • docs/foundry/task-breakdown.md — seeded task list (your starting point)',
    '  • docs/foundry/steering.md — project-wide rules every agent on the team must follow (coding standards, never-dos)',
    '  • docs/foundry/design-decisions.md — ADRs locking in architectural choices; you must reinforce these when delegating',
    '  • docs/foundry/definition-of-done.md — completion gates every task must pass before merge_ready → done',
    '  • docs/foundry/spec.json — machine-checkable projection of the docs above (declared dependencies, module/endpoint structure, constitution rules). The drift monitor reads this; you keep tasks aligned to it.',
    'When a task implements a structure entry declared in spec.json (structure.required), set `delivers` on that task_create call to the matching tokens — "module:<name>" (e.g. spec entry {kind:"module",name:"sampler"} → delivers:["module:sampler"]) or "endpoint:<METHOD> <path>". This is the EXPLICIT task→spec link the roadmap-aware structural drift check uses; without it that check stays dormant and a declared-but-unbuilt module cannot be told apart from real drift. One task may deliver several entries. Never guess tokens — copy them from spec.json.',
    'When you delegate via message_send, include a one-line pointer to the relevant steering rule or ADR if the task could plausibly violate one. Reject completion claims from teammates that don\'t cite the Definition of Done.',
    'Act on your own initiative. As soon as you have a goal — whether from the operator\'s opening message, a stated team purpose, or just the project itself — decompose it into tasks via task_create, assign each to the appropriate teammate via message_send, and drive the work forward. Do not stand by. The operator can interrupt or steer you at any time, but they should not have to spell out every step.',
  ].join('\n\n');
}

export function buildTeammateSystemPrompt({ teamId, member, leadId, teammates, cwd }) {
  const peerList = (teammates || []).filter((t) => t.agentId !== member.agentId);
  const peerSection = peerList.length > 0
    ? `Other teammates on this team:\n${formatTeammates(peerList)}`
    : 'You are the only non-lead member of this team.';

  return [
    `You are ${member.agentId} on team "${teamId}", role: ${member.role || 'unspecified'}.`,
    `The lead is ${leadId}. Project root: ${cwd}.`,
    peerSection,
    guidanceFor(member.role),
    'Project rules at boot — read these BEFORE starting any assigned task (skip any that don\'t exist):',
    '  • docs/foundry/steering.md — coding standards, tooling, never-dos. Failure to follow these blocks merge.',
    '  • docs/foundry/definition-of-done.md — completion gates. Cite these when reporting "done" to the lead.',
    '  • docs/foundry/design-decisions.md — locked architectural choices. Don\'t silently re-litigate; if you think an ADR is wrong, raise it explicitly to the lead via message_send.',
    'Wait until the lead assigns you work via message_send. When you have a result, reply via message_send to the lead and explicitly tick the Definition of Done items you satisfied.',
  ].join('\n\n');
}

export function buildAgentSystemPrompt({ teamId, lead, teammates, member, cwd }) {
  const isLead = member && member.agentId === lead.agentId;
  if (isLead) {
    return buildLeadSystemPrompt({ teamId, lead, teammates, cwd });
  }
  return buildTeammateSystemPrompt({
    teamId,
    member,
    leadId: lead.agentId,
    teammates,
    cwd,
  });
}
