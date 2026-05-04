import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_role_permission_violations';
const CATEGORY = 'risk';

/**
 * Counts tool_call_denied events and emits one finding per denial. Severity
 * is medium per the spec — denials are already prevented by roleAuthority,
 * but a denial means an agent attempted something it shouldn't, which is a
 * drift signal worth surfacing.
 */
export function checkRolePermissionViolations({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : [];
  const findings = [];
  for (const e of events) {
    if (e.eventType !== 'tool_call_denied') continue;
    const agentId = e.payload?.agentId ?? 'unknown';
    const role = e.payload?.role ?? 'unknown';
    const toolName = e.payload?.toolName ?? 'unknown';
    const reason = e.payload?.reason ?? 'role denied';
    findings.push({
      id: stableFindingId({
        checkName: CHECK_NAME, category: CATEGORY, taskId: null,
        salient: `${agentId}|${toolName}|${e.createdAt}`,
      }),
      runId: '',
      teamId: snapshot.teamId,
      taskId: null,
      category: CATEGORY,
      severity: 'medium',
      checkName: CHECK_NAME,
      title: `Agent ${agentId} (${role}) was denied ${toolName}`,
      evidence: [`agent ${agentId} (${role}) attempted ${toolName} at ${e.createdAt} — ${reason}`],
      expected: `${role} only calls tools in its allowed set (see ROLE_TOOLS in roleAuthority.js)`,
      actual: `${role} attempted ${toolName}`,
      recommendedCorrection: `Investigate why ${agentId} reached for ${toolName}; either expand the role or correct the agent's instruction.`,
      autoFixable: false,
    });
  }
  return findings;
}
