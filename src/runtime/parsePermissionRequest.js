/**
 * Parses a teammate `permission_request` JSON message.
 *
 * Teammate runtimes (Claude Code) send permission requests through the inbox
 * messaging protocol as JSON text with `type: 'permission_request'`.
 *
 * Returns a normalized object or `null` if the text is not a valid
 * permission_request payload.
 *
 * Legacy reference: claude_agent_teams_ui-main/src/shared/utils/inboxNoise.ts
 */
export function parsePermissionRequest(text) {
  const parsed = parseJsonObject(text);
  if (!parsed || parsed.type !== 'permission_request') return null;

  const requestId = nonEmptyString(parsed.request_id);
  const agentId = nonEmptyString(parsed.agent_id);
  const toolName = nonEmptyString(parsed.tool_name);

  if (!requestId || !agentId || !toolName) return null;

  return {
    requestId,
    agentId,
    toolName,
    toolUseId: nonEmptyString(parsed.tool_use_id) || '',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    input:
      parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
        ? { ...parsed.input }
        : {},
    permissionSuggestions: Array.isArray(parsed.permission_suggestions)
      ? parsed.permission_suggestions
      : [],
  };
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // not valid JSON
  }
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
