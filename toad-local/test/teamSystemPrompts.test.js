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

test('buildAgentSystemPrompt falls back gracefully on an unknown role', () => {
  const prompt = buildAgentSystemPrompt({
    teamId: 'orion',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [{ agentId: 'mystery', role: 'gardener' }],
    member: { agentId: 'mystery', role: 'gardener' },
    cwd: '.',
  });
  // Unknown role shouldn't blow up; it should produce a usable prompt that
  // still names the agent. This protects against config drift between UI
  // role lists and backend.
  assert.match(prompt, /mystery/);
});
