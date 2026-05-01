/**
 * Role-based authority for the local MCP tool surface.
 *
 * Implements §5 (role permissions) and §26 (tool / MCP authority by role) of
 * `docs/AGENT_TEAMS_HARDENING_CHECKLIST.md`. The orchestrator (not prompts)
 * decides which actor role can invoke which tool.
 *
 * `lead` and `human` use the `'*'` sentinel — wildcard access. The other four
 * roles get explicit allowlists derived from the §5 / §26 mapping; see
 * `docs/superpowers/plans/2026-04-30-role-authority.md` for the full table.
 *
 * `actor.role` is optional in the input; missing roles default to `human`
 * (permissive) so existing call sites continue to work without coordinated
 * role-tagging. A future tightening slice can flip the default once all
 * upstream callers (UI, agent prompts, smoke harness) opt in.
 */

const COMMON_READ_TOOLS = Object.freeze([
  'task_list',
  'task_comment',
  'message_send',
  'cross_team_messages',
  'agent_status',
  'team_list',
  'review_list',
  'approval_list',
  'runtime_events',
  'tool_activity',
  'health_status',
  'diagnostics_run',
  'task_history_export',
]);

export const ROLE_TOOLS = Object.freeze({
  lead: '*',
  architect: Object.freeze([
    ...COMMON_READ_TOOLS,
    'task_create',
    'task_update',
    'cross_team_send',
    'review_request',
    'review_decide',
    'task_plan_propose',
    'task_plan_approve',
    'task_plan_reject',
  ]),
  developer: Object.freeze([
    ...COMMON_READ_TOOLS,
    'task_update',
    'review_request',
    'runtime_send_input',
    'validation_run',
    'task_plan_propose',
  ]),
  reviewer: Object.freeze([
    ...COMMON_READ_TOOLS,
    'review_decide',
  ]),
  tester: Object.freeze([
    ...COMMON_READ_TOOLS,
    'task_update',
    'validation_run',
  ]),
  human: '*',
});

export const KNOWN_ROLES = Object.freeze(new Set(Object.keys(ROLE_TOOLS)));

/**
 * Throws when the role is not allowed to call the named tool. Treats missing /
 * empty role as `human` (full access) so legacy call sites that don't tag the
 * actor with a role keep working. Throws on unknown roles.
 */
export function assertRoleCanCallTool({ role, toolName } = {}) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new TypeError('toolName must be a non-empty string');
  }
  const effectiveRole = typeof role === 'string' && role.length > 0 ? role : 'human';
  if (!KNOWN_ROLES.has(effectiveRole)) {
    throw new Error(`role authority: unknown role: ${effectiveRole}`);
  }
  const allowed = ROLE_TOOLS[effectiveRole];
  if (allowed === '*') return;
  if (Array.isArray(allowed) && allowed.includes(toolName)) return;
  throw new Error(`role authority: ${effectiveRole} cannot call ${toolName}`);
}
