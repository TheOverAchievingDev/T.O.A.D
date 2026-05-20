const TEXT_EXT = /\.(rs|toml|js|jsx|ts|tsx|mjs|cjs|json|md|txt|py|go|java|kt|rb|c|h|cpp|hpp|cs|swift|sh|bat|ps1|yaml|yml|cfg|ini|env|manifest|xml|html|css|sql|gradle|properties|lock)$/i;

/**
 * Single source of truth for "should a detector scan this file?".
 * Both scanConstitution (whole-tree) and constitutionMergeGate
 * (diff-scoped) route binary decisions through this — the stricter
 * check is used everywhere; the two paths cannot drift.
 *
 * @param {string} path  repo-relative path
 * @param {{runGit?:Function, projectCwd?:string}} [opts]
 *   when runGit+projectCwd are given, `git check-attr binary` can
 *   force a non-text verdict for generated/vendored blobs.
 * @returns {boolean}
 */
export function isTextFile(path, { runGit = null, projectCwd = null } = {}) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (!TEXT_EXT.test(path)) return false;
  if (typeof runGit === 'function' && typeof projectCwd === 'string') {
    try {
      const r = runGit(['check-attr', 'binary', '--', path], { cwd: projectCwd });
      if (r && r.exitCode === 0 && /:\s*binary:\s*set\b/.test(String(r.stdout || ''))) {
        return false;
      }
    } catch { /* check-attr unavailable → fall back to extension verdict */ }
  }
  return true;
}
