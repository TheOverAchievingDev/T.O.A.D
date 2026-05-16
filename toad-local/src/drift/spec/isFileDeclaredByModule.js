/**
 * Single source of truth for "is this file part of this declared
 * module?" — extracted verbatim from L1.2
 * (checkStructuralUndeclaredPresent) so L1.2 and L3 Slice B's
 * touchesDeclaredSurface cannot diverge (design
 * 2026-05-16-l3-slice-b §4; lockstep test in
 * silentSignificance.test.js). Behavior is IDENTICAL to L1.2's prior
 * inline rule: a file is declared by a module iff it equals the
 * module's normalized `evidence` path, OR it lives under that
 * module's directory promotion (declared `src/sampler.rs` also covers
 * `src/sampler/core.rs` once the module promotes file→dir). The
 * "strip the LAST extension" stem rule and the lack of " or "-splitting
 * are pre-existing L1.2 behavior, preserved exactly — a pure refactor
 * never "fixes" behavior.
 */
export function normalizeRepoPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Both `changedFile` and `moduleEntry.evidence` are normalized
 * internally (normalizeRepoPath) — callers need NOT pre-normalize,
 * and this internal normalization is load-bearing for callers (L3
 * Slice B) that pass raw repo-relative paths. Do not remove it.
 */
export function isFileDeclaredByModule(changedFile, moduleEntry) {
  const none = { declared: false, matchKind: 'none' };
  if (typeof changedFile !== 'string' || changedFile.length === 0) return none;
  if (!moduleEntry || moduleEntry.kind !== 'module'
      || typeof moduleEntry.evidence !== 'string') return none;
  const ev = normalizeRepoPath(moduleEntry.evidence);
  const dot = ev.lastIndexOf('.');
  const slash = ev.lastIndexOf('/');
  const stem = dot > slash ? ev.slice(0, dot) : ev;
  const promotionPrefix = `${stem}/`;
  const src = normalizeRepoPath(changedFile);
  if (src === ev) return { declared: true, matchKind: 'exact_evidence_path' };
  if (src.startsWith(promotionPrefix)) {
    return { declared: true, matchKind: 'under_module_directory' };
  }
  return none;
}
