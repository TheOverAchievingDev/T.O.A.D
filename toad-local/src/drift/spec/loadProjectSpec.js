import { existsSync as realExistsSync, readFileSync as realReadFileSync } from 'node:fs';

/**
 * Load + validate the machine-checkable project spec.
 *
 * Per the approved schema (docs/superpowers/specs/
 * 2026-05-15-spec-yaml-schema.md §0): the canonical artifact is
 * `docs/foundry/spec.json` — JSON, not YAML, because the project has
 * exactly one runtime dependency and Node has no built-in YAML parser.
 * The drift system must not be the thing that bloats the dependency
 * tree it polices.
 *
 * This is the single read-path every Layer-1 check funnels through
 * (via buildSnapshot, which attaches the parsed spec to the snapshot
 * so checks stay pure functions). It NEVER throws — a missing or
 * malformed spec degrades to `{ spec: null, error }` so a drift run
 * continues. Absence of a spec is NOT a finding from this loader; the
 * check decides what "no spec" means for it (L1.1: nothing to compare
 * against → no findings).
 *
 * @param {object} input
 * @param {string} input.projectCwd          workspace root
 * @param {Function} [input.existsSyncImpl]  injectable for tests
 * @param {Function} [input.readFileSyncImpl] injectable for tests
 * @returns {{ spec: object|null, error: string|null }}
 */
const SUPPORTED_VERSIONS = new Set([1]);

export function loadProjectSpec({
  projectCwd,
  existsSyncImpl = realExistsSync,
  readFileSyncImpl = realReadFileSync,
} = {}) {
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) {
    return { spec: null, error: null };
  }
  // Normalize separators so the probe path is deterministic across
  // platforms (tests assert the exact joined path; Windows callers
  // pass backslashes).
  const root = projectCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const specPath = `${root}/docs/foundry/spec.json`;

  let exists;
  try {
    exists = existsSyncImpl(specPath);
  } catch {
    // A broken existsSync (permission, etc.) is treated as "no spec"
    // — degrade, never throw out of a drift run.
    return { spec: null, error: null };
  }
  if (!exists) return { spec: null, error: null };

  let raw;
  try {
    raw = readFileSyncImpl(specPath, 'utf-8');
  } catch (err) {
    return { spec: null, error: `spec.json read failed: ${err && err.message ? err.message : err}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { spec: null, error: `spec.json parse error: ${err && err.message ? err.message : err}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { spec: null, error: 'spec.json must be a JSON object at the top level' };
  }
  if (!SUPPORTED_VERSIONS.has(parsed.version)) {
    return {
      spec: null,
      error: `spec.json version ${JSON.stringify(parsed.version)} is unsupported `
        + `(supported: ${[...SUPPORTED_VERSIONS].join(', ')})`,
    };
  }

  return { spec: parsed, error: null };
}
