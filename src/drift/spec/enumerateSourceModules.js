import {
  readdirSync as realReaddirSync,
  statSync as realStatSync,
} from 'node:fs';

/**
 * Enumerate CANDIDATE PRODUCT MODULES under <projectCwd>/src.
 *
 * Feeds L1.2b (check_structural_undeclared_present): "is there source
 * the spec never sanctioned?" — the scope-creep / undocumented-surface
 * drift class. To answer that we need the set of source modules that
 * SHOULD have a spec entry. The exclusions below ARE the wolf-cry
 * guard: entrypoints (main/lib/index), module-declaration files
 * (mod.rs), build scripts, type declarations, and test files are NOT
 * "modules the spec must declare" — flagging them would be exactly
 * the false-positive noise the whole drift rebuild exists to avoid.
 *
 * Language-aware, mirroring L1.1's stack dispatch. v1 supports the two
 * ecosystems we can test deterministically (node/typescript, rust);
 * an unsupported language returns a clear error (honest "not enforced"
 * beats a false "no drift"), exactly like parseManifestDeps.
 *
 * Never throws. Returns:
 *   { modules: string[] | null, error: string | null, truncated: bool }
 * `modules` are project-relative POSIX paths. A missing src/ is an
 * empty list, NOT an error (no source yet is normal early-build).
 * The walk is depth + count capped so a pathological repo can't hang
 * a drift run; truncated=true signals the cap was hit.
 */
const DEFAULT_MAX_FILES = 5000;
const MAX_DEPTH = 24;

export function enumerateSourceModules({
  projectCwd,
  language,
  moduleRoot,
  maxFiles = DEFAULT_MAX_FILES,
  readdirSyncImpl = realReaddirSync,
  statSyncImpl = realStatSync,
} = {}) {
  const lang = typeof language === 'string' ? language.toLowerCase() : '';
  const isNode = lang === 'typescript' || lang === 'javascript' || lang === 'node';
  const isRust = lang === 'rust';
  if (!isNode && !isRust) {
    return {
      modules: null,
      error: `enumerateSourceModules: language "${language}" unsupported in v1 `
        + `(supported: node/typescript/javascript, rust). Undeclared-present `
        + `structural drift is not yet enforced for this stack.`,
      truncated: false,
    };
  }
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) {
    return { modules: [], error: null, truncated: false };
  }

  const root = projectCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const srcAbs = `${root}/src`;
  const rootNorm = typeof moduleRoot === 'string'
    ? moduleRoot.replace(/\\/g, '/').replace(/^\.\//, '')
    : '';

  const isCandidate = isRust ? rustCandidate : nodeCandidate;

  const modules = [];
  let truncated = false;

  // Iterative DFS with explicit stack — avoids recursion-depth blowups
  // and lets us hard-cap files. fail-soft on every fs call.
  const stack = [{ abs: srcAbs, depth: 0 }];
  while (stack.length > 0) {
    if (modules.length >= maxFiles) { truncated = true; break; }
    const { abs, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try {
      entries = readdirSyncImpl(abs);
    } catch {
      // Missing src/ at the root, or an unreadable subdir → skip.
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const name of entries) {
      if (modules.length >= maxFiles) { truncated = true; break; }
      const childAbs = `${abs}/${name}`;
      let st;
      try {
        st = statSyncImpl(childAbs);
      } catch {
        continue;
      }
      const relPath = childAbs.slice(root.length + 1); // strip "<root>/"
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        stack.push({ abs: childAbs, depth: depth + 1 });
        continue;
      }
      if (st && typeof st.isFile === 'function' && st.isFile()) {
        if (relPath === rootNorm) continue; // entrypoint, never a "module"
        if (isCandidate(relPath, name)) modules.push(relPath);
      }
    }
  }
  return { modules, error: null, truncated };
}

function rustCandidate(relPath, name) {
  if (!name.endsWith('.rs')) return false;
  // Crate roots + module-decl + build scripts are not product modules.
  if (name === 'main.rs' || name === 'lib.rs' || name === 'mod.rs' || name === 'build.rs') {
    return false;
  }
  // Test files / test trees aren't product surface.
  if (relPath.includes('/tests/') || name.endsWith('_test.rs') || name === 'tests.rs') {
    return false;
  }
  return true;
}

const NODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
function nodeCandidate(relPath, name) {
  if (!NODE_EXT.test(name)) return false;
  if (name.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[a-z]+$/.test(name)) return false;
  // index.* are barrels/entrypoints, not modules to declare.
  if (/^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) return false;
  if (relPath.includes('/__tests__/') || relPath.includes('/tests/')) return false;
  return true;
}
