import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_structural_undeclared_present';

/**
 * L1.2b — undeclared-but-present structural drift. The SCOPE question.
 *
 * Reviewer ruling: the two directions of structural drift are
 * asymmetric. L1.2a ("declared but absent") is a PROGRESS question
 * needing roadmap awareness. THIS check ("present but undeclared") is
 * a SCOPE question — there is never a legitimate lifecycle state
 * where unsanctioned surface area is fine, so it has NO roadmap
 * awareness and a CONSISTENT severity. It is the higher-severity
 * drift class: scope creep, undocumented APIs, and security holes
 * (a stray `src/sneaky_telemetry.rs`) slip in exactly here.
 *
 * Pure function over the snapshot. buildSnapshot supplies
 * snapshot.sourceModules via enumerateSourceModules (entrypoints /
 * mod.rs / build scripts / *.d.ts / test files already excluded —
 * those exclusions are the wolf-cry guard, not this check's job).
 *
 * Honest degradation, consistent with L1.1:
 *   - spec/structure absent                    → []   (can't judge scope)
 *   - structure declares NO module entries     → one info meta
 *       (empty declared set = "not enumerated", NOT "nothing
 *        sanctioned" — flagging every file here would be the exact
 *        wolf-cry the rebuild exists to avoid; same principle as
 *        L1.1's empty-authorized → only-forbidden)
 *   - sourceModules null (unsupported stack)    → one info meta
 *   - sourceModules []  (no source yet)         → []
 *
 * Coverage: a source path is "declared" if it equals a declared
 * `evidence` path, OR it lives under that module's directory
 * promotion (declared `src/sampler.rs` also covers
 * `src/sampler/core.rs` once the team promotes the module from a
 * single file to a directory — that is not drift).
 *
 * Ruling #4 / §4b: unreviewed spec clamps severity to info and tags
 * specReviewed:false + specProvenance.
 */
export function checkStructuralUndeclaredPresent({ snapshot } = {}) {
  if (!snapshot || !snapshot.spec) return [];
  const teamId = snapshot.teamId;
  const spec = snapshot.spec;
  const required = spec.structure && Array.isArray(spec.structure.required)
    ? spec.structure.required
    : null;
  if (required === null) return [];

  const reviewed = spec.provenance?.reviewed === true;
  const provenance = {
    extractedBy: typeof spec.provenance?.extracted_by === 'string'
      ? spec.provenance.extracted_by : 'unknown',
    sourceDoc: Array.isArray(spec.provenance?.source_docs) && spec.provenance.source_docs.length > 0
      ? spec.provenance.source_docs[0]
      : 'docs/foundry/spec.json',
  };

  const moduleEntries = required.filter((e) => e && e.kind === 'module' && typeof e.evidence === 'string');

  if (moduleEntries.length === 0) {
    return [meta(teamId, 'structure-not-enumerated', {
      title: 'Undeclared-present structural drift not enforced (structure not enumerated)',
      expected: 'spec.json structure.required enumerates the sanctioned module set',
      actual:
        'No module entries declared — an empty declared set means '
        + '"not enumerated", not "nothing is sanctioned". Flagging '
        + 'every source file here would be a false-positive storm, so '
        + 'this check stays informational until the structure is '
        + 'enumerated.',
      recommendedCorrection:
        'Populate spec.json structure.required with the modules '
        + 'tech-spec.md declares (Foundry emits this; foundry_extract_spec '
        + 'bootstraps existing projects).',
      provenance, reviewed,
    })];
  }

  if (!Array.isArray(snapshot.sourceModules)) {
    return [meta(teamId, 'sourcemodules-unenforced', {
      title: 'Undeclared-present structural drift not enforced for this stack',
      expected: 'Source modules enumerable for the project language',
      actual:
        `Not enforced: ${typeof snapshot.sourceModulesError === 'string' && snapshot.sourceModulesError.length > 0
          ? snapshot.sourceModulesError
          : 'source enumeration unavailable for this stack'}`,
      recommendedCorrection:
        'Undeclared-present drift currently supports Node and Rust '
        + 'source trees. Other stacks are uncovered until an enumerator '
        + 'lands.',
      provenance, reviewed,
    })];
  }
  if (snapshot.sourceModules.length === 0) return [];

  // Normalize declared evidence paths + precompute their directory
  // "promotion prefixes" (src/sampler.rs → src/sampler/).
  const declared = [];
  for (const e of moduleEntries) {
    const ev = e.evidence.replace(/\\/g, '/').replace(/^\.\//, '');
    const dot = ev.lastIndexOf('.');
    const slash = ev.lastIndexOf('/');
    const stem = dot > slash ? ev.slice(0, dot) : ev; // strip extension
    declared.push({ exact: ev, promotionPrefix: `${stem}/` });
  }

  const findings = [];
  for (const srcRaw of snapshot.sourceModules) {
    if (typeof srcRaw !== 'string' || srcRaw.length === 0) continue;
    const src = srcRaw.replace(/\\/g, '/').replace(/^\.\//, '');
    const covered = declared.some(
      (d) => src === d.exact || src.startsWith(d.promotionPrefix),
    );
    if (covered) continue;
    findings.push(makeFinding(teamId, {
      salient: `undeclared:${src}`,
      severity: clamp('high', reviewed),
      title: `Undeclared source module: ${src}`,
      expected: 'Every product source module has a matching spec.json structure.required entry',
      actual: `${src} exists in source but is not declared in spec.json — unsanctioned surface area`,
      recommendedCorrection:
        `Either declare "${src}" in spec.json structure.required (a `
        + `deliberate, reviewable spec change), or remove it if it is `
        + `scope creep / left-over experiment. Unsanctioned modules are `
        + `how undocumented APIs and security holes slip in.`,
      evidence: [
        `source module present: ${src}`,
        `declared evidence paths: ${declared.map((d) => d.exact).join(', ')}`,
      ],
      reviewed, provenance,
    }));
  }
  return findings;
}

function clamp(severity, reviewed) {
  return reviewed ? severity : 'info';
}

function makeFinding(teamId, {
  salient, severity, title, expected, actual, recommendedCorrection, evidence,
  reviewed, provenance,
}) {
  return {
    id: stableFindingId({
      teamId, checkName: CHECK_NAME, category: 'architecture',
      taskId: null, salient,
    }),
    runId: '',
    teamId,
    taskId: null,
    category: 'architecture',
    severity,
    checkName: CHECK_NAME,
    title,
    evidence: Array.isArray(evidence) ? evidence : [],
    expected,
    actual,
    recommendedCorrection,
    autoFixable: false,
    specReviewed: reviewed === true,
    specProvenance: provenance,
  };
}

function meta(teamId, salient, {
  title, expected, actual, recommendedCorrection, provenance, reviewed,
}) {
  return {
    id: stableFindingId({
      teamId, checkName: CHECK_NAME, category: 'risk',
      taskId: null, salient,
    }),
    runId: '',
    teamId,
    taskId: null,
    category: 'risk',
    severity: 'info',
    checkName: CHECK_NAME,
    title,
    evidence: [actual],
    expected,
    actual,
    recommendedCorrection,
    autoFixable: false,
    specReviewed: reviewed === true,
    specProvenance: provenance ?? { extractedBy: 'unknown', sourceDoc: 'docs/foundry/spec.json' },
  };
}
