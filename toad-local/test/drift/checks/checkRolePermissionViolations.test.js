import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRolePermissionViolations } from '../../../src/drift/checks/checkRolePermissionViolations.js';

function snap(runtimeEvents) {
  return {
    teamId: 'team-a', asOf: '2026-05-04T10:00:00Z',
    tasks: [], taskEvents: [], runtimeEvents,
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('one finding per tool_call_denied event', () => {
  const findings = checkRolePermissionViolations({
    snapshot: snap([
      { eventType: 'tool_call_denied', createdAt: '2026-05-04T09:01:00Z',
        payload: { agentId: 'dev-1', role: 'developer', toolName: 'task_delete', reason: 'role denied' } },
      { eventType: 'tool_call_denied', createdAt: '2026-05-04T09:02:00Z',
        payload: { agentId: 'dev-2', role: 'developer', toolName: 'team_delete', reason: 'role denied' } },
      { eventType: 'tool_call', createdAt: '2026-05-04T09:03:00Z',
        payload: { toolName: 'Bash' } },
    ]),
  });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'medium');
  assert.equal(findings[0].category, 'risk');
  assert.match(findings[0].evidence[0], /dev-1/);
  assert.match(findings[1].evidence[0], /dev-2/);
});

test('returns no findings when there are no denials', () => {
  const findings = checkRolePermissionViolations({ snapshot: snap([]) });
  assert.equal(findings.length, 0);
});
