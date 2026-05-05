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
  'message_list',
  'cross_team_messages',
  'agent_status',
  'team_list',
  'review_list',
  'approval_list',
  'runtime_events',
  'runtime_list',
  'usage_summary',
  'tool_activity',
  'health_status',
  'diagnostics_run',
  'task_history_export',
  'stuck_runtime_list',
  'settings_get',
  'github_status',
  'github_get_repository',
  'github_get_branch_protection',
  'github_origin_remote',
  'risk_policy_get',
  'risk_policy_preview',
  'provider_auth_status',
  'audit_log_query',
  'foundry_session_list',
  'foundry_session_get',
  'plugin_list_available',
  'plugin_resource_list',
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
    'drift_run',
    'foundry_session_create',
    'foundry_message_add',
    'foundry_chat_turn',
    'foundry_artifact_upsert',
    'foundry_artifact_generate',
    'foundry_artifact_export',
    'foundry_project_materialize',
    'foundry_project_seed_tasks',
    'plugin_login',
    'plugin_logout',
    'railway_link',
    'railway_provision_db',
    'railway_get_connection_string',
    'drift_correction_create',
  ]),
  developer: Object.freeze([
    ...COMMON_READ_TOOLS,
    'task_update',
    'review_request',
    'runtime_send_input',
    'validation_run',
    'task_plan_propose',
    'railway_get_connection_string',
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
