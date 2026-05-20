import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLE_GUIDANCE,
  buildLeadSystemPrompt,
  buildTeammateSystemPrompt,
  buildAgentSystemPrompt,
} from '../src/team/teamSystemPrompts.js';

test('ROLE_GUIDANCE has an entry for every supported role including lead', () => {
  // These are the roles the UI's CreateTeamModal allows. If you add a role
  // there, add a matching guidance string here so the agent knows what it's
  // expected to do — otherwise it falls back to a generic "follow lead's
  // instructions" line.
  for (const role of ['lead', 'developer', 'reviewer', 'researcher', 'debugger', 'qa', 'architect', 'designer']) {
    assert.equal(typeof ROLE_GUIDANCE[role], 'string', `missing role guidance for ${role}`);
    assert.ok(ROLE_GUIDANCE[role].length > 0, `empty role guidance for ${role}`);
  }
});

test('architect guidance includes spec grounding, ADR format, dependency ordering, and explicit boundary with developer', () => {
  const guidance = ROLE_GUIDANCE.architect;
  assert.match(guidance, /SPEC GROUNDING/i, 'must include spec grounding section');
  assert.match(guidance, /TASK DECOMPOSITION/i, 'must include task decomposition section');
  assert.match(guidance, /DEPENDENCY ORDERING/i, 'must include dependency ordering section');
  assert.match(guidance, /INTERFACE CONTRACTS/i, 'must include interface contracts section');
  assert.match(guidance, /ADR MANAGEMENT/i, 'must include ADR management section');
  assert.match(guidance, /LIVING TASK BREAKDOWN/i, 'must include living task breakdown section');
  assert.match(guidance, /SPEC COVERAGE AUDIT/i, 'must include spec coverage audit section');
  assert.match(guidance, /BOUNDARY/i, 'must include boundary section');
  assert.match(guidance, /QUALITY GATES FOR YOUR OUTPUT/i, 'must include quality gates section');
  assert.match(guidance, /delivers.*tokens|delivers tokens|tokens from spec\.json/i, 'must reference delivers tokens');
  assert.match(guidance, /dependencyTaskIds|dependency.*task|circular.*depend/i, 'must reference dependency ordering');
  assert.match(guidance, /do not write implementation code|you are the architect.*not the developer/i, 'must enforce architect/developer boundary');
  assert.match(guidance, /ADR.*structure|Status.*proposed.*accepted.*superseded/i, 'must define ADR format');
  assert.match(guidance, /alternatives considered/i, 'must require alternatives in designs');
  assert.match(guidance, /requiresHumanApproval/i, 'must reference human approval for high-risk tasks');
  assert.match(guidance, /acceptanceCriteria/i, 'must reference acceptance criteria');
});

test('qaqa guidance includes validation workflow, test planning, flake detection, and structured reporting', () => {
  const guidance = ROLE_GUIDANCE.qa;
  assert.match(guidance, /VALIDATION WORKFLOW/i, 'must include validation workflow section');
  assert.match(guidance, /HAPPY PATH/i, 'must reference happy path testing');
  assert.match(guidance, /EDGE CASES/i, 'must reference edge case testing');
  assert.match(guidance, /ERROR PATHS/i, 'must reference error path testing');
  assert.match(guidance, /REGRESSION/i, 'must reference regression testing');
  assert.match(guidance, /FLAKE DETECTION/i, 'must include flake detection section');
  assert.match(guidance, /VERDICT.*PASS.*FAIL/i, 'must require final verdict with PASS/FAIL');
  assert.match(guidance, /last line of defense/i, 'must define tester as last quality gate');
  assert.match(guidance, /do not.*fix.*report/i, 'must enforce test-dont-fix boundary');
  assert.match(guidance, /only mark.*passed.*actually passed/i, 'must enforce honest pass/fail reporting');
  assert.match(guidance, /trust but verify/i, 'must enforce trust-but-verify');
});

test('debugger guidance includes reproduce-first rule, root cause classification, evidence gathering, and confidence levels', () => {
  const guidance = ROLE_GUIDANCE.debugger;
  assert.match(guidance, /DIAGNOSIS WORKFLOW/i, 'must include diagnosis workflow section');
  assert.match(guidance, /REPRODUCE/i, 'must include reproduce-first step');
  assert.match(guidance, /ISOLATE/i, 'must include isolate step');
  assert.match(guidance, /ROOT CAUSE/i, 'must include root cause step');
  assert.match(guidance, /NULL.*UNDEFINED/i, 'must classify null/undefined failures');
  assert.match(guidance, /TYPE MISMATCH/i, 'must classify type mismatch failures');
  assert.match(guidance, /RACE CONDITION/i, 'must classify race condition failures');
  assert.match(guidance, /EVIDENCE/i, 'must include evidence gathering section');
  assert.match(guidance, /CONFIDENCE.*high.*medium.*low/i, 'must require confidence level in reports');
  assert.match(guidance, /do NOT fix.*code/i, 'must enforce diagnose-dont-fix boundary');
  assert.match(guidance, /PROPOSED FIX.*concrete.*minimal/i, 'must require concrete proposed fix');
  assert.match(guidance, /cannot reproduce.*say so/i, 'must require honesty about non-reproducible failures');
});

test('researcher guidance includes investigation workflow, search patterns, uncertainty marking, and stop rules', () => {
  const guidance = ROLE_GUIDANCE.researcher;
  assert.match(guidance, /INVESTIGATION WORKFLOW/i, 'must include investigation workflow section');
  assert.match(guidance, /SCOPE/i, 'must include scope step');
  assert.match(guidance, /SEARCH/i, 'must include search step');
  assert.match(guidance, /ANALYZE/i, 'must include analyze step');
  assert.match(guidance, /VERIFY/i, 'must include verify step');
  assert.match(guidance, /REPORT/i, 'must include report step');
  assert.match(guidance, /LOW CONFIDENCE/i, 'must mark low-confidence findings');
  assert.match(guidance, /do not deep.*dive/i, 'must include stop-when-answered rule');
  assert.match(guidance, /could not find/i, 'must require explicit not-found reporting');
  assert.match(guidance, /file path.*line number/i, 'must require file paths with line numbers');
});

test('designer guidance includes structured design proposal, state definitions, accessibility baseline, and implement-dont-design boundary', () => {
  const guidance = ROLE_GUIDANCE.designer;
  assert.match(guidance, /DESIGN WORKFLOW/i, 'must include design workflow section');
  assert.match(guidance, /RECOMMENDED DESIGN/i, 'must include recommended design section');
  assert.match(guidance, /ALTERNATIVE/i, 'must require alternative design');
  assert.match(guidance, /ACCESSIBILITY/i, 'must include accessibility section');
  assert.match(guidance, /empty.*loading.*success.*error/i, 'must require state definitions');
  assert.match(guidance, /consistency first/i, 'must enforce consistency-first rule');
  assert.match(guidance, /do not implement/i, 'must enforce design-dont-implement boundary');
  assert.match(guidance, /reuse.*before.*create/i, 'must enforce reuse-before-create');
  assert.match(guidance, /keyboard.*only/i, 'must reference keyboard accessibility');
  assert.match(guidance, /screen reader/i, 'must reference screen reader accessibility');
  assert.match(guidance, /color contrast/i, 'must reference color contrast');
});

test('role-specific guidance reflects the role', () => {
  // Spot-check that a couple of role strings actually mention work the role
  // would do — guards against an empty-string regression.
  assert.match(ROLE_GUIDANCE.developer, /implement|code|build/i);
  assert.match(ROLE_GUIDANCE.qa, /test|validation|quality/i);
  assert.match(ROLE_GUIDANCE.architect, /design|structure|system/i);
  assert.match(ROLE_GUIDANCE.reviewer, /review|critique|feedback/i);
});

test('lead and teammate prompts reference foundry steering / DoD / ADR docs at boot', () => {
  // After the kiro-style upgrade, every agent's system prompt should
  // surface the project-wide steering doc, the Definition of Done, and
  // the design-decisions log so they cite-rather-than-relitigate locked
  // choices. Without these references the foundry docs we materialize
  // are just files nobody reads.
  const team = {
    teamId: 't',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [{ agentId: 'alice', role: 'developer' }],
    cwd: '.',
  };
  const leadPrompt = buildLeadSystemPrompt(team);
  const matePrompt = buildTeammateSystemPrompt({
    teamId: team.teamId,
    member: team.teammates[0],
    leadId: team.lead.agentId,
    teammates: team.teammates,
    cwd: team.cwd,
  });
  for (const p of [leadPrompt, matePrompt]) {
    assert.match(p, /docs\/foundry\/steering\.md/);
    assert.match(p, /docs\/foundry\/definition-of-done\.md/);
    assert.match(p, /docs\/foundry\/design-decisions\.md/);
  }
});

test('buildLeadSystemPrompt names the team, lists teammates with their roles, and references MCP tools', () => {
  const prompt = buildLeadSystemPrompt({
    teamId: 'orion',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [
      { agentId: 'alice', role: 'developer' },
      { agentId: 'bob', role: 'qa' },
    ],
    cwd: 'C:/code/proj',
  });
  assert.match(prompt, /orion/);
  assert.match(prompt, /alice/);
  assert.match(prompt, /developer/);
  assert.match(prompt, /bob/);
  assert.match(prompt, /qa/i);
  assert.match(prompt, /C:\/code\/proj/);
  // The lead must know it can route work via message_send, since that is
  // how teammates actually receive instructions through our DeliveryWorker.
  assert.match(prompt, /message_send/);
  // The lead must understand its identity, otherwise it has no reason to
  // orchestrate at all.
  assert.match(prompt, /lead/i);
});

test('buildLeadSystemPrompt handles solo (no teammates) without crashing', () => {
  const prompt = buildLeadSystemPrompt({
    teamId: 'solo',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [],
    cwd: 'C:/code/proj',
  });
  assert.match(prompt, /solo/);
  // Should explicitly say there are no teammates so the lead doesn't
  // hallucinate fictional ones.
  assert.match(prompt, /no teammates|solo|alone/i);
});

test('buildTeammateSystemPrompt identifies the agent + role + lead and tells it to wait for instructions', () => {
  const prompt = buildTeammateSystemPrompt({
    teamId: 'orion',
    member: { agentId: 'alice', role: 'developer' },
    leadId: 'lead',
    teammates: [
      { agentId: 'alice', role: 'developer' },
      { agentId: 'bob', role: 'qa' },
    ],
    cwd: 'C:/code/proj',
  });
  assert.match(prompt, /alice/);
  assert.match(prompt, /developer/);
  assert.match(prompt, /lead/);
  assert.match(prompt, /orion/);
  // Teammates should know to wait — they don't initiate work in our model,
  // the lead does. Without this, agents start doing whatever they want at
  // boot.
  assert.match(prompt, /wait|until|when.*assigned|when.*lead/i);
});

test('buildTeammateSystemPrompt includes role-specific guidance', () => {
  const dev = buildTeammateSystemPrompt({
    teamId: 't', member: { agentId: 'a', role: 'developer' }, leadId: 'lead', teammates: [], cwd: '.',
  });
  const qa = buildTeammateSystemPrompt({
    teamId: 't', member: { agentId: 'a', role: 'qa' }, leadId: 'lead', teammates: [], cwd: '.',
  });
  // The two should differ — otherwise role-specific guidance isn't actually
  // being applied.
  assert.notEqual(dev, qa);
  assert.match(dev, /implement|code|build/i);
  assert.match(qa, /test|validation|quality/i);
});

test('buildAgentSystemPrompt routes lead vs teammate based on role', () => {
  const team = {
    teamId: 'orion',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [{ agentId: 'alice', role: 'developer' }],
    cwd: '.',
  };
  const leadPrompt = buildAgentSystemPrompt({ ...team, member: team.lead });
  const matePrompt = buildAgentSystemPrompt({ ...team, member: team.teammates[0] });
  // Lead prompt should NOT tell the lead to wait for the lead — that's
  // a teammate-only instruction. Both should still mention the team and
  // teammates so the orchestration vocabulary is shared.
  assert.match(leadPrompt, /you are the lead/i);
  assert.match(matePrompt, /you are alice/i);
  // Lead should know how to route work; teammates should know how to
  // report back. Both mention message_send because everyone uses the
  // same MCP tool to talk.
  assert.match(leadPrompt, /message_send/);
  assert.match(matePrompt, /message_send/);
});

test('lead guidance includes task-type conditional language for bug vs feature', () => {
  const guidance = ROLE_GUIDANCE.lead;
  // Some signal of task-type-awareness in the lead's instructions.
  assert.match(guidance, /\btype\b.*(feature|bug)|bug.*task|feature.*task/i);
  assert.match(guidance, /skip planning|investigation|reproduce/i, 'lead should know to direct bug tasks to investigation');
});

test('developer guidance includes full implementation workflow, code quality rules, git hygiene, and structured reporting', () => {
  const guidance = ROLE_GUIDANCE.developer;
  assert.match(guidance, /IMPLEMENTATION WORKFLOW/i, 'must include implementation workflow section');
  assert.match(guidance, /READ.*before.*writ/i, 'must include read-before-write step');
  assert.match(guidance, /SELF[- ]VALIDATE/i, 'must include self-validation step');
  assert.match(guidance, /GIT HYGIENE/i, 'must include git hygiene section');
  assert.match(guidance, /REPORT/i, 'must include structured reporting section');
  assert.match(guidance, /REVIEW LOOP/i, 'must include review loop from implementer POV');
  assert.match(guidance, /CODE QUALITY RULES/i, 'must include code quality rules');
  assert.match(guidance, /BLOCKED OR STUCK/i, 'must include blocked/stuck escalation');
  assert.match(guidance, /never.*git add.*-A/i, 'must forbid git add -A');
  assert.match(guidance, /never.*console\.log/i, 'must forbid console.log in shipping code');
  assert.match(guidance, /no.*empty.*catch/i, 'must forbid empty catch blocks');
  assert.match(guidance, /DoD.*CHECKLIST/i, 'must reference DoD checklist in report format');
  assert.match(guidance, /do not report.*until.*pass/i, 'must enforce validation-before-report');
  assert.match(guidance, /FILES CHANGED/i, 'must require file list in reports');
  assert.match(guidance, /not.*design.*architect/i, 'must enforce architect/developer boundary');
});

test('lead guidance includes orchestration playbook, lifecycle management, delegation matrix, escalation rules, and review routing', () => {
  const guidance = ROLE_GUIDANCE.lead;
  assert.match(guidance, /ORCHESTRATION PLAYBOOK/i, 'must include orchestration playbook');
  assert.match(guidance, /ASSESS/i, 'must include assess step');
  assert.match(guidance, /ASSIGN/i, 'must include assign step');
  assert.match(guidance, /PARALLELISM/i, 'must include parallelism rules');
  assert.match(guidance, /MONITOR/i, 'must include monitoring/stall detection');
  assert.match(guidance, /QUALITY GATE/i, 'must include quality gate section');
  assert.match(guidance, /TASK LIFECYCLE MANAGEMENT/i, 'must include lifecycle management');
  assert.match(guidance, /DELEGATION RULES/i, 'must include delegation rules');
  assert.match(guidance, /ESCALATION/i, 'must include escalation triggers');
  assert.match(guidance, /CONFLICT RESOLUTION/i, 'must include conflict resolution');
  assert.match(guidance, /REVIEW ROUTING/i, 'must include review routing');
  assert.match(guidance, /INTEGRATION WORKFLOW/i, 'must include integration workflow');
  assert.match(guidance, /COMMUNICATION CADENCE/i, 'must include communication cadence');
  assert.match(guidance, /DRIVE/i, 'must include initiative/autonomy mandate');
  assert.match(guidance, /silent.*lead.*broken/i, 'must include silent-lead-is-broken rule');
  assert.match(guidance, /do.*not.*bypass.*gate/i, 'must forbid bypassing quality gates');
  assert.match(guidance, /at most.*3.*concurrently/i, 'must set parallelism cap');
  assert.match(guidance, /silent.*10.*minute/i, 'must define stall detection threshold');
  assert.match(guidance, /architect.*final say.*WHAT/i, 'must define architect authority scope');
  assert.match(guidance, /developer.*final say.*HOW/i, 'must define developer authority scope');
});

test('developer guidance directs bug tasks to skip plan_propose and reproduce first', () => {
  const guidance = ROLE_GUIDANCE.developer;
  assert.match(guidance, /type/i);
  assert.match(guidance, /bug|reproduce/i);
  assert.match(guidance, /plan_propose|planning/i, 'should still mention plan_propose for feature tasks');
});

test('debugger guidance distinguishes bug tasks from feature work', () => {
  const guidance = ROLE_GUIDANCE.debugger;
  assert.match(guidance, /bug|reproduce|root.cause/i);
});

test('reviewer guidance includes mandatory review loop, code quality rubric, and structured feedback', () => {
  const guidance = ROLE_GUIDANCE.reviewer;
  assert.match(guidance, /BLOCKERS/i, 'must include BLOCKERS section');
  assert.match(guidance, /SUGGESTIONS/i, 'must include SUGGESTIONS section');
  assert.match(guidance, /NITS/i, 'must include NITS section');
  assert.match(guidance, /DRY|YAGNI/i, 'must reference DRY/YAGNI principle');
  assert.match(guidance, /isolation.*boundar/i, 'must reference isolation and boundaries');
  assert.match(guidance, /follow.*existing.*pattern/i, 'must reference following existing patterns');
  assert.match(guidance, /verify.*don.*assume/i, 'must reference verify-don\'t-assume');
  assert.match(guidance, /review loop/i, 'must describe mandatory re-review loop');
  assert.match(guidance, /APPROVED|CHANGES_REQUESTED/i, 'must describe clear outcome format');
  assert.match(guidance, /console\.log/i, 'must flag console.log as code hygiene concern');
  assert.match(guidance, /empty.*catch/i, 'must flag empty catch blocks');
  assert.match(guidance, /no.*close enough/i, 'must forbid close-enough approvals');
});

test('buildLeadSystemPrompt appends systemPromptAppend at the end', () => {
  const prompt = buildLeadSystemPrompt({
    teamId: 't',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [{ agentId: 'alice', role: 'developer' }],
    cwd: '.',
    systemPromptAppend: 'Custom skill: use Rust for all performance-critical paths.',
  });
  assert.match(prompt, /ADDITIONAL INSTRUCTIONS/);
  assert.match(prompt, /Custom skill: use Rust/);
  // The append should come AFTER the core lead guidance
  const appendIdx = prompt.indexOf('ADDITIONAL INSTRUCTIONS');
  const leadIdx = prompt.indexOf('You are the lead');
  assert.ok(appendIdx > leadIdx, 'systemPromptAppend must appear after the core prompt');
});

test('buildTeammateSystemPrompt appends systemPromptAppend at the end', () => {
  const prompt = buildTeammateSystemPrompt({
    teamId: 't',
    member: { agentId: 'alice', role: 'developer' },
    leadId: 'lead',
    teammates: [{ agentId: 'alice', role: 'developer' }],
    cwd: '.',
    systemPromptAppend: 'Custom skill: always add JSDoc comments to public APIs.',
  });
  assert.match(prompt, /ADDITIONAL INSTRUCTIONS/);
  assert.match(prompt, /always add JSDoc comments/);
  // Must still contain role guidance (the developer instructions)
  assert.match(prompt, /implement|code|build/i);
});

test('systemPromptAppend is omitted when empty', () => {
  const prompt = buildLeadSystemPrompt({
    teamId: 't',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [],
    cwd: '.',
    systemPromptAppend: '',
  });
  assert.ok(!prompt.includes('ADDITIONAL INSTRUCTIONS'), 'empty string must not inject ADDITIONAL INSTRUCTIONS header');
});

test('buildAgentSystemPrompt threads systemPromptAppend from member config', () => {
  const team = {
    teamId: 'orion',
    lead: { agentId: 'lead', role: 'lead', systemPromptAppend: 'Lead custom skill.' },
    teammates: [{ agentId: 'alice', role: 'developer', systemPromptAppend: 'Dev custom skill.' }],
    cwd: '.',
  };
  const leadPrompt = buildAgentSystemPrompt({ ...team, member: team.lead });
  const matePrompt = buildAgentSystemPrompt({ ...team, member: team.teammates[0] });
  assert.match(leadPrompt, /Lead custom skill/);
  assert.match(matePrompt, /Dev custom skill/);
  // Lead should NOT leak dev's custom skill
  assert.ok(!leadPrompt.includes('Dev custom skill'), 'lead prompt must not contain dev custom skill');
  assert.ok(!matePrompt.includes('Lead custom skill'), 'dev prompt must not contain lead custom skill');
});

test('buildAgentSystemPrompt fallback on unknown role still threads systemPromptAppend', () => {
  const prompt = buildAgentSystemPrompt({
    teamId: 'orion',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [{ agentId: 'mystery', role: 'gardener', systemPromptAppend: 'Gardener instructions.' }],
    member: { agentId: 'mystery', role: 'gardener', systemPromptAppend: 'Gardener instructions.' },
    cwd: '.',
  });
  assert.match(prompt, /mystery/);
  assert.match(prompt, /Gardener instructions/);
  assert.match(prompt, /ADDITIONAL INSTRUCTIONS/);
});
