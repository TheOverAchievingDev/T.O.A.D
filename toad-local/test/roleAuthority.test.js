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

test('developer can call task_plan_propose; architect / lead / human can approve/reject; developer cannot approve', () => {
  // Propose
  assertRoleCanCallTool({ role: 'developer', toolName: 'task_plan_propose' });
  assertRoleCanCallTool({ role: 'architect', toolName: 'task_plan_propose' });  // architect can revise as well
  assert.throws(
    () => assertRoleCanCallTool({ role: 'reviewer', toolName: 'task_plan_propose' }),
    /reviewer cannot call task_plan_propose/,
  );
  assert.throws(
    () => assertRoleCanCallTool({ role: 'tester', toolName: 'task_plan_propose' }),
    /tester cannot call task_plan_propose/,
  );

  // Approve / reject — restricted to architect / lead / human
  for (const role of ['architect', 'lead', 'human']) {
    assertRoleCanCallTool({ role, toolName: 'task_plan_approve' });
    assertRoleCanCallTool({ role, toolName: 'task_plan_reject' });
  }
  for (const role of ['developer', 'reviewer', 'tester']) {
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'task_plan_approve' }),
      new RegExp(`${role} cannot call task_plan_approve`),
    );
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'task_plan_reject' }),
      new RegExp(`${role} cannot call task_plan_reject`),
    );
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

test('roleAuthority allows drift_run for lead, architect, human, but denies developer', () => {
  // Allowed roles
  for (const role of ['lead', 'architect', 'human']) {
    assert.doesNotThrow(
      () => assertRoleCanCallTool({ role, toolName: 'drift_run' }),
      `${role} should be allowed`
    );
  }
  // Denied
  assert.throws(
    () => assertRoleCanCallTool({ role: 'developer', toolName: 'drift_run' }),
    /cannot call/i,
    'developer should be denied'
  );
});

test('roleAuthority: plugin_* tools allowed for lead/architect/human, denied for developer', () => {
  for (const tool of ['plugin_list_available', 'plugin_login', 'plugin_logout', 'plugin_resource_list']) {
    for (const role of ['lead', 'architect', 'human']) {
      assert.doesNotThrow(
        () => assertRoleCanCallTool({ role, toolName: tool }),
        `${role} should be allowed ${tool}`,
      );
    }
    if (tool === 'plugin_login' || tool === 'plugin_logout') {
      // Mutating plugin tools are NOT allowed for developer
      assert.throws(
        () => assertRoleCanCallTool({ role: 'developer', toolName: tool }),
        /cannot call|not allowed/i,
        `developer should be denied ${tool}`,
      );
    }
  }
});

test('roleAuthority: plugin_list_available + plugin_resource_list are read-only — allowed for developer too', () => {
  for (const tool of ['plugin_list_available', 'plugin_resource_list']) {
    assert.doesNotThrow(
      () => assertRoleCanCallTool({ role: 'developer', toolName: tool }),
      `developer should be allowed read-only ${tool}`,
    );
  }
});

test('roleAuthority: railway_run_migration allowed only for lead/human', () => {
  for (const role of ['lead', 'human']) {
    assert.doesNotThrow(() => assertRoleCanCallTool({ role, toolName: 'railway_run_migration' }));
  }
  for (const role of ['architect', 'developer', 'reviewer', 'tester']) {
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'railway_run_migration' }),
      /cannot call|not allowed/i,
    );
  }
});

test('roleAuthority: railway_get_connection_string allowed for developer (read for config)', () => {
  assert.doesNotThrow(() => assertRoleCanCallTool({ role: 'developer', toolName: 'railway_get_connection_string' }));
});

test('roleAuthority: drift_correction_create allowed for architect/lead/human, denied for developer/reviewer/tester', () => {
  for (const role of ['architect', 'lead', 'human']) {
    assert.doesNotThrow(
      () => assertRoleCanCallTool({ role, toolName: 'drift_correction_create' }),
      `${role} should be allowed drift_correction_create`,
    );
  }
  for (const role of ['developer', 'reviewer', 'tester']) {
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'drift_correction_create' }),
      /cannot call|not allowed/i,
      `${role} should be denied drift_correction_create`,
    );
  }
});

test('roleAuthority: ide tools are operator-only for Slice A and B', () => {
  for (const role of ['lead', 'human']) {
    assert.doesNotThrow(() => assertRoleCanCallTool({ role, toolName: 'ide_tree_list' }));
    assert.doesNotThrow(() => assertRoleCanCallTool({ role, toolName: 'ide_read_file' }));
    assert.doesNotThrow(() => assertRoleCanCallTool({ role, toolName: 'ide_write_file' }));
  }
  for (const role of ['architect', 'developer', 'reviewer', 'tester']) {
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'ide_tree_list' }),
      new RegExp(`${role} cannot call ide_tree_list`),
    );
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'ide_read_file' }),
      new RegExp(`${role} cannot call ide_read_file`),
    );
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'ide_write_file' }),
      new RegExp(`${role} cannot call ide_write_file`),
    );
  }
});
