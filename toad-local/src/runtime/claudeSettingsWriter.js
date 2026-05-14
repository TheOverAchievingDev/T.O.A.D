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
 * Path-shaped tools whose permission rules can include glob patterns.
 * For each, Claude Code accepts rules like `<Tool>(<pattern>)` where
 * pattern is a glob the tool's primary path argument is matched against.
 *
 * Bash is included because deny patterns like `Bash(* /forbidden/**)`
 * block commands whose argv mentions a forbidden path. The match is
 * best-effort — a determined agent could pipe through shell features
 * that the matcher doesn't catch — but it raises the floor.
 */
const PATH_AWARE_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'Bash']);

/**
 * Always-deny system paths. Independent of workspace location. These
 * are paths no agent should ever need to read or write, regardless
 * of OS or project. Caller passes platform-appropriate paths from
 * `defaultSystemDenyPaths()`.
 */
function defaultSystemDenyPaths(platform = process.platform) {
  if (platform === 'win32') {
    return [
      'C:/Windows/**',
      'C:/Program Files/**',
      'C:/Program Files (x86)/**',
      'C:/ProgramData/**',
    ];
  }
  // POSIX
  return [
    '/etc/**',
    '/sys/**',
    '/proc/**',
    '/root/**',
    '/usr/local/etc/**',
  ];
}

/**
 * Normalize a path for use inside a Claude Code permission glob.
 * Converts backslashes to forward slashes so Windows paths still
 * match. Trailing slash removed; we append the `**` ourselves.
 */
function normalizeForPattern(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Build the array of permission deny rules that enforce the §4
 * agent isolation contract.
 *
 * Per PROJECT.md §4: agents must never access files outside the
 * workspace. The CLI's native tools stay enabled (their absence
 * would cripple the dev/lead/etc roles); we constrain them via
 * `permissions.deny` patterns that name specific outside-the-
 * workspace paths to block.
 *
 * @param {object} input
 * @param {string} input.projectCwd      — the workspace's absolute path. NOT denied (agents work here).
 * @param {string} input.installDir      — Symphony's own install dir (toad-local). Denied for every path-aware tool.
 * @param {string[]} [input.extraDeny]   — additional absolute paths to deny (e.g. parent home, .ssh).
 * @param {string} [input.platform]      — process.platform override for testing.
 * @returns {string[]} flat list of rule strings ready to merge into permissions.deny.
 */
export function buildWorkspaceIsolationRules({
  projectCwd,
  installDir,
  extraDeny = [],
  platform = process.platform,
} = {}) {
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) {
    throw new TypeError('buildWorkspaceIsolationRules: projectCwd required');
  }
  if (typeof installDir !== 'string' || installDir.length === 0) {
    throw new TypeError('buildWorkspaceIsolationRules: installDir required');
  }

  // De-dupe and normalize. installDir is always denied. extraDeny is
  // user-supplied (sometimes nothing). System paths are added unconditionally.
  const denyPaths = new Set();
  denyPaths.add(normalizeForPattern(installDir));
  for (const extra of extraDeny) {
    if (typeof extra === 'string' && extra.length > 0) {
      denyPaths.add(normalizeForPattern(extra));
    }
  }

  // The workspace itself must NEVER appear in the deny list — that would
  // block all in-workspace work. Defensive check in case a caller passes
  // projectCwd by accident.
  const workspaceNormalized = normalizeForPattern(projectCwd);
  denyPaths.delete(workspaceNormalized);

  const rules = [];
  // Workspace-relative deny rules — per tool, one rule per path
  // (allows the agent's native tools but blocks them from naming
  // forbidden absolute paths).
  for (const denyPath of denyPaths) {
    if (!denyPath) continue;
    for (const tool of PATH_AWARE_TOOLS) {
      rules.push(`${tool}(${denyPath}/**)`);
    }
  }
  // System paths — denied unconditionally regardless of workspace.
  for (const sysPath of defaultSystemDenyPaths(platform)) {
    for (const tool of PATH_AWARE_TOOLS) {
      rules.push(`${tool}(${sysPath})`);
    }
  }

  return rules;
}

/**
 * Write workspace isolation rules into the project's
 * `.claude/settings.local.json`. Merges with existing rules so
 * caller-applied allow/deny entries are preserved.
 *
 * Per PROJECT.md §4: this is invoked at team_launch time (and
 * idempotent on repeat invocations — only adds missing rules).
 *
 * @param {object} input
 * @param {string} input.projectCwd
 * @param {string} input.installDir
 * @param {string[]} [input.extraDeny]
 * @param {string} [input.platform]
 * @returns {Promise<{ added: number, rules: string[] }>}
 */
export async function writeWorkspaceIsolationSettings({
  projectCwd,
  installDir,
  extraDeny,
  platform,
} = {}) {
  const rules = buildWorkspaceIsolationRules({ projectCwd, installDir, extraDeny, platform });
  if (rules.length === 0) return { added: 0, rules: [] };

  const settingsPath = path.join(projectCwd, '.claude', 'settings.local.json');
  const result = await addPermissionRules({
    settingsPath,
    toolNames: rules, // misnamed param — these are rule strings now, but the writer doesn't care
    behavior: 'deny',
  });
  return { added: result.added, rules };
}

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
