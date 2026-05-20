import { readFileSync as realReadFileSync } from 'node:fs';

/**
 * Extract the set of DIRECT dependency names from a project's
 * dependency manifest, dispatched by language.
 *
 * Ruling #3 (schema doc §7): direct dependencies ONLY. Transitive
 * bans are unenforceable without a full dependency resolve and
 * produce false positives (a sanctioned dep legitimately pulling a
 * forbidden crate transitively is not the team's drift). So we parse
 * the manifest's own declared tables, never a lockfile.
 *
 * v1 supports the two ecosystems we can test deterministically with
 * zero new dependencies:
 *   - Node       (package.json — JSON, JSON.parse built in)
 *   - Rust       (Cargo.toml   — scoped line parser for [dependencies]
 *                 / [dev-dependencies] / [build-dependencies] /
 *                 [target.*.dependencies] tables; NOT a full TOML
 *                 parser, which would be a new dependency)
 *
 * Unsupported languages return a CLEAR error rather than a silent
 * empty set — an honest "we can't check this yet" beats a false
 * "no drift". The check turns that error into an info-level finding
 * so the operator knows dependency drift isn't covered for their
 * stack rather than assuming it passed.
 *
 * Never throws. Returns { deps: Set<string>|null, error: string|null }.
 *
 * @param {object} input
 * @param {string} input.manifestPath        absolute path to the manifest
 * @param {string} input.language            spec.stack.language
 * @param {Function} [input.readFileSyncImpl] injectable for tests
 */
export function parseManifestDeps({
  manifestPath,
  language,
  readFileSyncImpl = realReadFileSync,
} = {}) {
  const lang = typeof language === 'string' ? language.toLowerCase() : '';
  const isNode = lang === 'typescript' || lang === 'javascript' || lang === 'node';
  const isRust = lang === 'rust';

  if (!isNode && !isRust) {
    return {
      deps: null,
      error: `parseManifestDeps: language "${language}" unsupported in v1 `
        + `(supported: node/typescript/javascript, rust). Dependency drift `
        + `is not yet enforced for this stack.`,
    };
  }

  let raw;
  try {
    raw = readFileSyncImpl(manifestPath, 'utf-8');
  } catch (err) {
    return {
      deps: null,
      error: `manifest read failed (${manifestPath}): ${err && err.message ? err.message : err}`,
    };
  }

  if (isNode) return parsePackageJson(raw);
  return parseCargoToml(raw);
}

function parsePackageJson(raw) {
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return { deps: null, error: `package.json parse error: ${err && err.message ? err.message : err}` };
  }
  if (!pkg || typeof pkg !== 'object') {
    return { deps: null, error: 'package.json must be a JSON object' };
  }
  const deps = new Set();
  // Direct deps the team chose: runtime + dev. We intentionally
  // include devDependencies — a dev tool the spec didn't authorize
  // (a new test framework, a bundler swap) is real tech-stack drift.
  // peerDependencies / optionalDependencies are excluded: peers are
  // declared for consumers, optionals are explicitly may-not-be-there.
  for (const block of ['dependencies', 'devDependencies']) {
    const obj = pkg[block];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const name of Object.keys(obj)) deps.add(name);
    }
  }
  return { deps, error: null };
}

/**
 * Minimal Cargo.toml dependency-table scanner. NOT a TOML parser —
 * just enough to enumerate direct dependency keys without adding a
 * TOML library. Handles the forms Cargo actually emits:
 *
 *   [dependencies]
 *   serde = "1.0"
 *   eframe = { version = "0.27", features = ["wgpu"] }
 *   [dev-dependencies]
 *   tempfile = "3"
 *   [build-dependencies]
 *   cc = "1"
 *   [target.'cfg(windows)'.dependencies]
 *   winapi = "0.3"
 *
 * A dependency line is `key = …` at the top level of a *.dependencies
 * table. Keys inside an inline table value (`{ version = …, features
 * = […] }`) are NOT deps — only the line's leading key is. We detect
 * "inside an inline table" by tracking that the dep key is the first
 * token before the first `=` on a line that begins a table entry.
 */
function parseCargoToml(raw) {
  const deps = new Set();
  let inDepTable = false;
  const lines = String(raw).split(/\r?\n/);
  for (let line of lines) {
    // Strip full-line and trailing comments (TOML uses #). A # inside
    // a quoted string is rare in dep tables; acceptable for v1.
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith('[')) {
      // Section header. A dependency table is any header whose final
      // path segment is `dependencies`, `dev-dependencies`, or
      // `build-dependencies` — covers plain + target-specific forms.
      const header = trimmed.replace(/^\[+/, '').replace(/\]+$/, '').trim();
      const lastSeg = header.split('.').pop().trim();
      inDepTable =
        lastSeg === 'dependencies'
        || lastSeg === 'dev-dependencies'
        || lastSeg === 'build-dependencies';
      continue;
    }
    if (!inDepTable) continue;

    // Dep entry: `name = <anything>`. The name is everything before
    // the FIRST `=`, trimmed, quotes stripped. Inline-table interior
    // keys never reach here because they're on the same line AFTER
    // the first `=`, which we slice off.
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let name = trimmed.slice(0, eq).trim();
    name = name.replace(/^["']|["']$/g, '');
    if (name.length > 0) deps.add(name);
  }
  return { deps, error: null };
}
