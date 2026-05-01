import fs from 'node:fs';
import path from 'node:path';

/**
 * Modes that expand into concrete tool-name addRules.
 *
 * Legacy reference: TeamProvisioningService.ts L21264-L21287
 */
const SET_MODE_TOOLS = Object.freeze({
  acceptEdits: ['Edit', 'Write', 'NotebookEdit'],
  bypassPermissions: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Read', 'Grep', 'Glob'],
});

/**
 * Apply an array of `permission_suggestions` from a teammate permission request.
 *
 * Handles two suggestion types:
 * - `addRules`: adds specific tool names to the allow/deny list
 * - `setMode`: translates well-known modes into addRules
 *
 * All writes target `{projectCwd}/.claude/settings.local.json`.
 *
 * @param {{ projectCwd: string, suggestions: object[] }} input
 * @returns {Promise<{ applied: number }>}
 */
export async function applyPermissionSuggestions({ projectCwd, suggestions }) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return { applied: 0 };
  }

  const settingsPath = path.join(projectCwd, '.claude', 'settings.local.json');
  let totalApplied = 0;

  for (const suggestion of suggestions) {
    if (!suggestion || typeof suggestion !== 'object') continue;

    // setMode → translate to concrete tool names
    if (suggestion.type === 'setMode') {
      const mode = typeof suggestion.mode === 'string' ? suggestion.mode : '';
      const toolNames = SET_MODE_TOOLS[mode];
      if (toolNames && toolNames.length > 0) {
        const result = await addPermissionRules({ settingsPath, toolNames, behavior: 'allow' });
        totalApplied += result.added;
      }
      continue;
    }

    // addRules → add tool names to the settings file
    if (suggestion.type === 'addRules') {
      const rules = Array.isArray(suggestion.rules) ? suggestion.rules : [];
      const toolNames = rules
        .map((r) => (r && typeof r.toolName === 'string' ? r.toolName : null))
        .filter(Boolean);
      if (toolNames.length === 0) continue;

      const behavior = suggestion.behavior === 'deny' ? 'deny' : 'allow';
      const result = await addPermissionRules({ settingsPath, toolNames, behavior });
      totalApplied += result.added;
      continue;
    }

    // Unknown suggestion type — skip
  }

  return { applied: totalApplied };
}

/**
 * Add tool names to the `permissions.allow` (or `permissions.deny`) array
 * in a Claude settings file.
 *
 * Creates the file and parent directories if they don't exist.
 * Merges with existing entries — never overwrites unrelated keys.
 *
 * @param {{ settingsPath: string, toolNames: string[], behavior: string }} input
 * @returns {Promise<{ added: number }>}
 */
export async function addPermissionRules({ settingsPath, toolNames, behavior }) {
  const dir = path.dirname(settingsPath);
  await fs.promises.mkdir(dir, { recursive: true });

  // Read existing settings (or start fresh)
  let settings = {};
  try {
    const raw = await fs.promises.readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed;
    }
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  // Ensure permissions object
  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  const perms = settings.permissions;

  // Target array: allow or deny
  const key = behavior === 'deny' ? 'deny' : 'allow';
  if (!Array.isArray(perms[key])) {
    perms[key] = [];
  }
  const list = perms[key];

  // Add tool names not already present
  const existing = new Set(list);
  let added = 0;
  for (const name of toolNames) {
    if (!existing.has(name)) {
      list.push(name);
      added++;
    }
  }

  if (added === 0) return { added: 0 };

  // Write atomically via temp + rename
  const tmpPath = `${settingsPath}.tmp.${Date.now()}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  await fs.promises.rename(tmpPath, settingsPath);

  return { added };
}
