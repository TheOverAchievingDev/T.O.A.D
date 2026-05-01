import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_TOOLS, KNOWN_ROLES, assertRoleCanCallTool } from '../src/security/roleAuthority.js';

test('KNOWN_ROLES covers the six roles from checklist §5', () => {
  assert.deepEqual(
    [...KNOWN_ROLES].sort(),
    ['architect', 'developer', 'human', 'lead', 'reviewer', 'tester'].sort(),
  );
});

test('lead and human are wildcard roles (full access)', () => {
  assert.equal(ROLE_TOOLS.lead, '*');
  assert.equal(ROLE_TOOLS.human, '*');
});

test('developer cannot call agent_launch / team_create / approval_respond / review_decide', () => {
  for (const tool of ['agent_launch', 'team_create', 'approval_respond', 'review_decide']) {
    assert.throws(
      () => assertRoleCanCallTool({ role: 'developer', toolName: tool }),
      /role authority: developer cannot call/,
      `expected developer to be denied ${tool}`,
    );
  }
});

test('reviewer cannot call review_request, agent_launch, or task_update', () => {
  for (const tool of ['review_request', 'agent_launch', 'task_update']) {
    assert.throws(
      () => assertRoleCanCallTool({ role: 'reviewer', toolName: tool }),
      /role authority: reviewer cannot call/,
    );
  }
});

test('tester cannot call review_decide, agent_launch, or team_create', () => {
  for (const tool of ['review_decide', 'agent_launch', 'team_create']) {
    assert.throws(
      () => assertRoleCanCallTool({ role: 'tester', toolName: tool }),
      /role authority: tester cannot call/,
    );
  }
});

test('lead can call any tool', () => {
  for (const tool of ['agent_launch', 'team_delete', 'review_decide', 'task_create', 'task_list']) {
    // Should not throw
    assertRoleCanCallTool({ role: 'lead', toolName: tool });
  }
});

test('human (operator) can call any tool', () => {
  for (const tool of ['agent_launch', 'team_delete', 'approval_respond', 'task_create']) {
    assertRoleCanCallTool({ role: 'human', toolName: tool });
  }
});

test('missing role defaults to human (permissive) for backward compatibility', () => {
  // No role provided — should not throw
  assertRoleCanCallTool({ role: undefined, toolName: 'agent_launch' });
  assertRoleCanCallTool({ role: null, toolName: 'team_create' });
  assertRoleCanCallTool({ role: '', toolName: 'approval_respond' });
});

test('unknown role denies everything', () => {
  assert.throws(
    () => assertRoleCanCallTool({ role: 'phantom', toolName: 'task_list' }),
    /unknown role: phantom/,
  );
});

test('developer can still call task_update, task_comment, message_send, review_request', () => {
  for (const tool of ['task_update', 'task_comment', 'message_send', 'review_request', 'task_list']) {
    assertRoleCanCallTool({ role: 'developer', toolName: tool });
  }
});

test('reviewer can call review_decide, review_list, task_comment', () => {
  for (const tool of ['review_decide', 'review_list', 'task_comment']) {
    assertRoleCanCallTool({ role: 'reviewer', toolName: tool });
  }
});

test('developer and tester can call validation_run; reviewer and architect cannot', () => {
  assertRoleCanCallTool({ role: 'developer', toolName: 'validation_run' });
  assertRoleCanCallTool({ role: 'tester', toolName: 'validation_run' });
  assertRoleCanCallTool({ role: 'lead', toolName: 'validation_run' });
  assertRoleCanCallTool({ role: 'human', toolName: 'validation_run' });
  assert.throws(
    () => assertRoleCanCallTool({ role: 'reviewer', toolName: 'validation_run' }),
    /reviewer cannot call validation_run/,
  );
  assert.throws(
    () => assertRoleCanCallTool({ role: 'architect', toolName: 'validation_run' }),
    /architect cannot call validation_run/,
  );
});
