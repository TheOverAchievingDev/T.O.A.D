import { existsSync as defaultExistsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Resolve a CLI command name to an absolute path that Node's
 * child_process.spawn() can execute directly without `shell: true`.
 *
 * The issue: Node's spawn on Windows does NOT search PATHEXT. A bare
 * `spawn('codex', args)` only finds `codex.exe` — it cannot find
 * `codex.cmd` or `codex.bat` wrappers (which is how npm-installed
 * CLIs like Codex ship on Windows). Result: spawn ENOENT.
 *
 * The fix: walk PATH ourselves, try each Windows extension explicitly,
 * return the first hit. On non-Windows platforms, return the name
 * unchanged (Unix `spawn` handles PATH resolution correctly).
 *
 * If nothing is found, return the original name so spawn produces its
 * normal ENOENT — preserves the existing error-path coverage in tests.
 *
 * Dependencies are injectable for testing without filesystem access.
 *
 * @param {string} name — CLI name (e.g. 'codex', 'claude').
 * @param {object} [deps]
 * @param {string} [deps.platform]   — defaults to process.platform
 * @param {string} [deps.pathEnv]    — defaults to process.env.PATH
 * @param {(p: string) => boolean} [deps.existsSyncImpl] — defaults to fs.existsSync
 * @returns {string} resolved absolute path, or the original name as fallback.
 */
export function resolveCli(name, {
  platform = process.platform,
  pathEnv = process.env.PATH || '',
  existsSyncImpl = defaultExistsSync,
} = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('resolveCli: name is required');
  }
  if (platform !== 'win32') {
    return name;
  }

  // Windows: walk PATH, try .cmd / .exe / .bat in that order.
  // Order matters — npm-installed CLIs typically ship as `.cmd` wrappers,
  // installer-based binaries as `.exe`. Trying .cmd first lets Codex
  // (npm-installed) resolve before any unrelated codex.exe on PATH.
  const exts = ['.cmd', '.exe', '.bat'];
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSyncImpl(candidate)) {
        return candidate;
      }
    }
  }
  // Nothing matched — return name so spawn errors with ENOENT as usual.
  return name;
}
