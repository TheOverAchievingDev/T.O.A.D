/**
 * L3 Slice B predicate internals (design 2026-05-16-l3-slice-b).
 * silentButSignificant = touchesDeclaredSurface AND meetsMagnitudeFloor
 * — a pure, findings-free diff×spec predicate. "Silent" is emergent
 * from l3Gate's `flagged || silentSignificant` composition, NOT a
 * clause here. Cost discipline IS this predicate's tightness.
 */
import { isFileDeclaredByModule } from '../spec/isFileDeclaredByModule.js';

/** Some changed file resolves to some structure.required module. */
export function touchesDeclaredSurface(changedFiles, moduleEntries) {
  if (!Array.isArray(changedFiles) || !Array.isArray(moduleEntries)) return false;
  return changedFiles.some(
    (cf) => moduleEntries.some((m) => isFileDeclaredByModule(cf, m).declared),
  );
}

/**
 * Changed source lines attributed to declared files only. Excludes:
 * structural diff lines (+++/---/@@/diff --git/index/mode/rename/
 * similarity); whitespace-only added/removed lines (after stripping
 * the single leading +/-); binary-file sections (no +/- content → 0).
 * Comment-only lines are deliberately COUNTED (ruled tradeoff —
 * excluding them needs per-language syntax awareness; cheap, Haiku
 * resolves the FP). `isDeclaredFile(path)` is a caller predicate
 * (post-image path, b/-stripped). Single source of truth: both
 * meetsMagnitudeFloor and the engine's silent_significant.changedLines
 * call this — never re-implement the loop.
 */
export function countDeclaredChangedLines(diffBody, isDeclaredFile) {
  if (typeof diffBody !== 'string' || diffBody.length === 0) return 0;
  let declared = false;
  let count = 0;
  for (const line of diffBody.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      // git C-quotes paths with spaces/special chars: `+++ "b/a b.rs"`.
      // Strip the surrounding quotes (+ the \" \\ escapes git adds
      // inside them) before the b/ strip, else the path silently
      // never matches declared evidence and the count zeroes out.
      const unq = p.length >= 2 && p.startsWith('"') && p.endsWith('"')
        ? p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        : p;
      const file = unq === '/dev/null' ? null : unq.replace(/^b\//, '');
      declared = file ? isDeclaredFile(file) === true : false;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@')
        || line.startsWith('diff --git') || line.startsWith('index ')
        || line.startsWith('new file mode') || line.startsWith('deleted file mode')
        || line.startsWith('rename ') || line.startsWith('similarity ')
        || line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      continue;
    }
    if (!declared) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      if (line.slice(1).trim().length === 0) continue; // whitespace-only
      count += 1;                                       // comments INCLUDED
    }
  }
  return count;
}

/**
 * Floor: non-finite → 10; < 1 → clamped to 1 (the floor can never be
 * disabled — load-bearing, design §5).
 */
export function meetsMagnitudeFloor(diffBody, isDeclaredFile, floorRaw) {
  const floor = Math.max(
    1, Number.isFinite(floorRaw) ? Math.trunc(floorRaw) : 10,
  );
  return countDeclaredChangedLines(diffBody, isDeclaredFile) >= floor;
}

/**
 * Slice B predicate. Pure, findings-free. The magnitude floor rides
 * on the snapshot (`snapshot.l3SilentMagnitudeFloor`, engine-attached
 * alongside boundaryTaskId/boundaryTo) so the signature stays
 * `{ snapshot, boundaryTaskId }` per design §2. All malformed/absent
 * input → false (failure mode = do not fire L3).
 */
export function silentButSignificant({ snapshot, boundaryTaskId } = {}) {
  const required = snapshot?.spec?.structure?.required;
  const moduleEntries = Array.isArray(required)
    ? required.filter((e) => e && e.kind === 'module' && typeof e.evidence === 'string')
    : [];
  if (moduleEntries.length === 0) return false;
  const d = snapshot?.diffsByTask?.[boundaryTaskId] ?? null;
  if (!d || d.error || !Array.isArray(d.changedFiles) || d.changedFiles.length === 0) return false;
  if (typeof d.diff !== 'string' || d.diff.length === 0) return false;
  if (!touchesDeclaredSurface(d.changedFiles, moduleEntries)) return false;
  const isDeclaredFile = (p) => moduleEntries.some((m) => isFileDeclaredByModule(p, m).declared);
  // snapshot.l3SilentMagnitudeFloor is attached by the engine
  // (driftEngine #runDriftInner, alongside boundaryTaskId/boundaryTo).
  // Undefined here ⇒ meetsMagnitudeFloor applies the default 10 by
  // design — do not "fix" callers to pass it; the engine owns it.
  return meetsMagnitudeFloor(d.diff, isDeclaredFile, snapshot.l3SilentMagnitudeFloor);
}
