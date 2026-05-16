import {
  readdirSync as realReaddirSync,
  statSync as realStatSync,
  readFileSync as realReadFileSync,
} from 'node:fs';
import { evalConstitutionRule } from './evalConstitutionRule.js';

/**
 * Apply spec.constitution.rules[] against the project tree.
 *
 * Feeds L1.3 (check_constitution), the generalization of the
 * hardcoded check_provider_logic_leakage prototype into spec-driven
 * rules. Unlike that prototype (diff-scoped), constitution rules are
 * STANDING INVARIANTS — "never `SeDebugPrivilege` anywhere" must catch
 * a violation even if it was committed before drift started watching.
 * So this is a bounded WHOLE-TREE scan, run in buildSnapshot so the
 * check stays a pure function over snapshot.constitutionHits.
 *
 * v1 detector types:
 *   grep           — regex over text-file contents; per-rule
 *                    exclude_paths globs suppress matches
 *   path_presence  — forbidden_paths globs that must NOT match an
 *                    existing file (e.g. "never commit target/, *.exe")
 * Any other detector type is recorded in `unsupportedRules` (honest
 * "not enforced" — never a silent pass), as is a rule whose regex
 * fails to compile.
 *
 * Bounded + fail-soft: ignores target/ node_modules/ .git/ .toad/
 * dist/ build/; depth + file-count + per-file-size caps; every fs
 * call is wrapped. Never throws.
 *
 * Returns:
 *   { hits: [{ ruleId, file, line, snippet }], unsupportedRules: string[],
 *     error: string|null, truncated: boolean }
 */
const DEFAULT_MAX_FILES = 4000;
const MAX_DEPTH = 24;
const MAX_FILE_BYTES = 512 * 1024; // skip files bigger than this (binaries/bundles)
const IGNORED_DIRS = new Set([
  'target', 'node_modules', '.git', '.toad', 'dist', 'build', '.next',
  'coverage', '.venv', '__pycache__', 'vendor',
]);
// Path-prefix exclusions (not just dir-name). docs/foundry/ is the
// rule-DEFINITION surface — spec.json + steering.md + design-
// decisions.md literally contain the forbidden tokens because they
// PROHIBIT them. Scanning the rulebook for violations of itself is a
// guaranteed false positive (the 2026-05-15 dogfood hit this: 3 of 5
// hit-files were the governance docs). The scanner must never read
// its own constitution.
const EXCLUDE_PATH_PREFIXES = ['docs/foundry'];

function isExcludedPath(rel) {
  for (const p of EXCLUDE_PATH_PREFIXES) {
    if (rel === p || rel.startsWith(`${p}/`)) return true;
  }
  return false;
}

// Heuristic: only grep files that are plausibly text. Anything else
// (images, compiled binaries) is skipped — a forbidden token can't
// meaningfully live there and scanning them wastes time.
const TEXT_EXT = /\.(rs|toml|js|jsx|ts|tsx|mjs|cjs|json|md|txt|py|go|java|kt|rb|c|h|cpp|hpp|cs|swift|sh|bat|ps1|yaml|yml|toml|cfg|ini|env|manifest|xml|html|css|sql|gradle|properties|lock)$/i;

export function scanConstitution({
  projectCwd,
  rules,
  maxFiles = DEFAULT_MAX_FILES,
  readdirSyncImpl = realReaddirSync,
  statSyncImpl = realStatSync,
  readFileSyncImpl = realReadFileSync,
} = {}) {
  const out = { hits: [], unsupportedRules: [], error: null, truncated: false };
  const ruleList = Array.isArray(rules) ? rules : [];
  if (ruleList.length === 0) return out;
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) return out;

  // Compile grep rules once; bucket path_presence + unsupported.
  const grepRules = [];
  const pathRules = [];
  for (const r of ruleList) {
    const t = r && r.detector && r.detector.type;
    if (t === 'grep') {
      try {
        new RegExp(r.detector.pattern); // validate pattern; evalConstitutionRule re-compiles per call
      } catch {
        out.unsupportedRules.push(r.id ?? '(unnamed)');
        continue;
      }
      grepRules.push(r);
    } else if (t === 'path_presence') {
      pathRules.push(r);
    } else {
      out.unsupportedRules.push(r && r.id ? r.id : '(unnamed)');
    }
  }

  const root = projectCwd.replace(/\\/g, '/').replace(/\/+$/, '');

  // Single bounded DFS walk. For each file: run path_presence globs +
  // (if text) grep rules.
  const stack = [{ abs: root, depth: 0 }];
  let scanned = 0;
  while (stack.length > 0) {
    if (scanned >= maxFiles) { out.truncated = true; break; }
    const { abs, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try { entries = readdirSyncImpl(abs); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const name of entries) {
      if (scanned >= maxFiles) { out.truncated = true; break; }
      if (IGNORED_DIRS.has(name)) continue;
      const childAbs = `${abs}/${name}`;
      let st;
      try { st = statSyncImpl(childAbs); } catch { continue; }
      const rel = childAbs.slice(root.length + 1);
      // Never scan the rule-definition surface (docs/foundry/**).
      if (isExcludedPath(rel)) continue;
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        stack.push({ abs: childAbs, depth: depth + 1 });
        continue;
      }
      if (!st || typeof st.isFile !== 'function' || !st.isFile()) continue;
      scanned += 1;

      // path_presence: any forbidden glob matching this file's path.
      for (const pr of pathRules) {
        const hits = evalConstitutionRule(pr, { path: rel, content: '' });
        if (hits === null) {
          out.unsupportedRules.push(pr.id ?? '(unnamed)');
        } else {
          for (const h of hits) {
            out.hits.push({ ruleId: pr.id ?? '(unnamed)', file: rel, line: h.line, snippet: h.snippet });
          }
        }
      }

      if (grepRules.length === 0) continue;
      if (!TEXT_EXT.test(name)) continue;
      if (typeof st.size === 'number' && st.size > MAX_FILE_BYTES) continue;
      let content;
      try { content = readFileSyncImpl(childAbs, 'utf-8'); } catch { continue; }
      if (typeof content !== 'string' || content.length === 0) continue;

      for (const g of grepRules) {
        const hits = evalConstitutionRule(g, { path: rel, content });
        if (hits === null) {
          // Bad regex or unsupported — already recorded in unsupportedRules at compile time;
          // skip silently here to avoid double-recording.
        } else {
          for (const h of hits) {
            out.hits.push({ ruleId: g.id ?? '(unnamed)', file: rel, line: h.line, snippet: h.snippet });
          }
        }
      }
    }
  }
  return out;
}
