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
 * Validate that a (projectCwd, installDir) pair is safe to launch agents
 * into. Throws with a precise reason otherwise.
 *
 * Per PROJECT.md §4: agents must never see Symphony's own folder. The
 * only way that holds is if the workspace and install dir are wholly
 * disjoint paths. This is the hard-refusal gate — called from
 * #teamLaunch before any spawn, and from any code path that derives an
 * agent cwd.
 *
 * Rules (any failure aborts the launch):
 *   - projectCwd must be a non-empty absolute path.
 *   - installDir must be a non-empty absolute path.
 *   - projectCwd must not equal installDir.
 *   - projectCwd must not be inside installDir.
 *   - installDir must not be inside projectCwd.
 *
 * Path comparison normalizes to forward slashes + case-insensitive on
 * Windows (filesystem semantics) and case-sensitive on POSIX.
 *
 * @param {object} input
 * @param {string} input.projectCwd
 * @param {string} input.installDir
 * @param {string} [input.platform]   — process.platform override for testing.
 * @returns {void}                    — throws on violation.
 */
export function assertWorkspaceIsolated({ projectCwd, installDir, platform = process.platform } = {}) {
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) {
    throw new Error(
      'agent isolation: projectCwd is missing — refusing to launch any agent. '
      + 'Pick a workspace folder via the project picker before launching a team.',
    );
  }
  if (typeof installDir !== 'string' || installDir.length === 0) {
    throw new Error(
      'agent isolation: installDir is missing — refusing to launch any agent. '
      + 'The sidecar could not resolve Symphony\'s own install dir; this is a setup bug.',
    );
  }

  // Use `path.resolve` to absolutize + normalize. If the input is already
  // absolute, resolve is a no-op for the value itself.
  // (Imported at top of file as `path`.)
  // eslint-disable-next-line global-require
  const ws = normalizeForCompare(path.resolve(projectCwd), platform);
  const inst = normalizeForCompare(path.resolve(installDir), platform);

  if (!path.isAbsolute(projectCwd)) {
    throw new Error(
      `agent isolation: projectCwd must be an absolute path, got "${projectCwd}". `
      + 'Refusing to launch.',
    );
  }
  if (!path.isAbsolute(installDir)) {
    throw new Error(
      `agent isolation: installDir must be an absolute path, got "${installDir}". `
      + 'Refusing to launch.',
    );
  }

  if (ws === inst) {
    throw new Error(
      `agent isolation: projectCwd (${projectCwd}) equals Symphony's install dir. `
      + 'Refusing to launch any agent — the agent would see Symphony\'s own source. '
      + 'Pick a different workspace folder via the project picker.',
    );
  }
  if (isInside(ws, inst)) {
    throw new Error(
      `agent isolation: projectCwd (${projectCwd}) is inside Symphony's install dir (${installDir}). `
      + 'Refusing to launch — the workspace must be entirely outside Symphony\'s folder. '
      + 'Pick a workspace folder that is not a subdirectory of Symphony.',
    );
  }
  if (isInside(inst, ws)) {
    throw new Error(
      `agent isolation: Symphony's install dir (${installDir}) is inside projectCwd (${projectCwd}). `
      + 'Refusing to launch — the workspace must not contain Symphony\'s folder. '
      + 'Move your Symphony install outside the workspace, or pick a narrower workspace.',
    );
  }
}

/**
 * Lower-cases the path on Windows (filesystem is case-insensitive) and
 * leaves it untouched on POSIX (where casing matters). Also converts
 * backslashes to forward slashes so comparisons are robust to separator
 * style.
 */
function normalizeForCompare(value, platform) {
  const slashed = String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Returns true when `child` is a strict descendant of `parent`. Both
 * must be pre-normalized via normalizeForCompare.
 *
 * "Strict" means: equality is NOT a descendant relationship — the caller
 * checks equality separately so the error message can be different.
 */
function isInside(child, parent) {
  if (child === parent) return false;
  return child.startsWith(parent + '/');
}

/**
 * Build a scrubbed environment for agent child processes — strip every
 * env var that leaks Symphony's install path or sidecar-specific state.
 * Pass the result as the spawn's `env` (not merged with process.env).
 *
 * Why: child processes inherit env from their parent by default, and
 * `process.env` in the sidecar contains:
 *   - TOAD_PROJECT_CWD / TOAD_INSTALL_DIR / TOAD_DB_PATH / TOAD_API_PORT
 *   - SYMPHONY_* counterparts
 *   - PWD / INIT_CWD (point to the sidecar's launch dir = install dir)
 *   - npm_* (npm injects ~20 vars revealing the package layout)
 *
 * Any of these in the agent's env teaches it where Symphony lives — even
 * if the agent's cwd is correctly set to the workspace.
 *
 * What survives: a small allow-list of vars the CLI / OS needs to
 * function (PATH for binary resolution, HOME for config files, locale,
 * temp dirs, terminal info), plus anything the caller explicitly added
 * via `input.env` (intentional pass-through).
 *
 * @param {object} input
 * @param {NodeJS.ProcessEnv} input.parentEnv — typically process.env
 * @param {Record<string, string>} [input.additions] — caller-supplied vars (override allow-list)
 * @param {string} [input.platform]
 * @returns {Record<string, string>}
 */
export function buildScrubbedAgentEnv({ parentEnv = {}, additions = {}, platform = process.platform } = {}) {
  // Vars that are safe AND necessary for the CLI to work. Anything not
  // in this list is dropped.
  const COMMON_ALLOW = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    // Provider auth tokens — the CLI reads these to authenticate. Without
    // them the agent boots unauthenticated and can't function.
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    // Color / TTY hints. Optional but harmless.
    'NO_COLOR',
    'FORCE_COLOR',
    'COLORTERM',
  ];
  const WIN_ALLOW = [
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'USERNAME',
    'COMPUTERNAME',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'COMMONPROGRAMW6432',
    'SYSTEMDRIVE',
    'HOMEDRIVE',
    'HOMEPATH',
    'PUBLIC',
    'ALLUSERSPROFILE',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'NUMBER_OF_PROCESSORS',
    'OS',
  ];
  const POSIX_ALLOW = [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE',
    'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'SSH_AUTH_SOCK',
  ];
  const allow = new Set([
    ...COMMON_ALLOW,
    ...(platform === 'win32' ? WIN_ALLOW : POSIX_ALLOW),
  ]);

  const scrubbed = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value !== 'string') continue;
    // Allow-list (case-sensitive on POSIX, case-insensitive on Windows
    // because env keys are case-insensitive there).
    const lookup = platform === 'win32' ? key.toUpperCase() : key;
    const allowedAsIs = allow.has(key);
    const allowedCaseFold = platform === 'win32' && allow.has(lookup);
    if (!allowedAsIs && !allowedCaseFold) continue;
    scrubbed[key] = value;
  }
  // Caller-supplied additions override the allow-list. This is the
  // explicit-intent escape hatch — e.g. a teammate config that sets
  // CLAUDE_CONFIG_DIR to override claude's discovery, or a test that
  // injects PWD=$tmp on purpose.
  for (const [key, value] of Object.entries(additions || {})) {
    if (typeof value === 'string') scrubbed[key] = value;
  }
  return scrubbed;
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
