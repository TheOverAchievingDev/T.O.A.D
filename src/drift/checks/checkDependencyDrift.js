import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_dependency_drift';

/**
 * Layer-1 drift check: do the project's DIRECT dependencies match
 * what spec.json authorizes?
 *
 * This is the first real code-vs-spec drift Symphony ships. It is a
 * PURE function over the snapshot — buildSnapshot pre-loads the spec
 * (loadProjectSpec) and the manifest's direct deps (parseManifestDeps)
 * and attaches them, so this check never touches disk, exactly like
 * every other check (cf. checkDoneWithoutMergeEvidence).
 *
 * Snapshot fields consumed:
 *   - spec          parsed spec.json object, or null
 *   - specError     string when spec.json existed but failed to parse
 *   - manifestDeps  array of direct dep names, or null
 *   - manifestError string when the manifest couldn't be parsed /
 *                   the language isn't supported yet
 *   - teamId        for stable finding ids
 *
 * Decisions baked in from the approved schema doc:
 *   - Ruling #3: direct deps only (manifestDeps is already
 *     direct-only; transitive bans are unenforceable).
 *   - Ruling #4 + §4b: findings from an unreviewed spec are clamped
 *     to `info` severity and tagged specReviewed:false so the UI +
 *     scorer can weight them provisional without re-parsing the spec.
 *   - Honest "not enforced": an unsupported language / unreadable
 *     manifest yields ONE info-level meta-finding rather than a
 *     silent pass that reads as "no drift".
 *
 * Categories: real dep violations → `architecture` (unauthorized
 * tech in the stack is an architectural concern). Meta-findings
 * (spec broken / not enforced) → `risk`, matching the convention
 * the LLM judge uses for its own meta-findings.
 */
export function checkDependencyDrift({ snapshot } = {}) {
  if (!snapshot) return [];
  const teamId = snapshot.teamId;

  // 1. Spec present but unparseable → the operator's contract is
  //    broken; surface it (info) so they fix spec.json. A merely
  //    ABSENT spec (no error) is not this check's concern — return [].
  if (!snapshot.spec) {
    if (typeof snapshot.specError === 'string' && snapshot.specError.length > 0) {
      return [metaFinding(teamId, 'spec-unparseable', {
        title: 'spec.json present but could not be parsed',
        expected: 'A valid spec.json so dependency drift can be enforced',
        actual: snapshot.specError,
        recommendedCorrection:
          'Fix docs/foundry/spec.json (or re-run foundry_extract_spec). '
          + 'Until it parses, dependency drift is not enforced.',
      })];
    }
    return [];
  }

  const spec = snapshot.spec;
  const depSpec = spec.dependencies;
  // Spec doesn't declare dependency constraints → nothing to check.
  if (!depSpec || typeof depSpec !== 'object') return [];

  const reviewed = spec.provenance?.reviewed === true;
  const provenance = {
    extractedBy: typeof spec.provenance?.extracted_by === 'string'
      ? spec.provenance.extracted_by : 'unknown',
    sourceDoc: Array.isArray(spec.provenance?.source_docs) && spec.provenance.source_docs.length > 0
      ? spec.provenance.source_docs[0]
      : 'docs/foundry/spec.json',
  };

  // 2. Manifest couldn't be parsed / language unsupported → honest
  //    "dependency drift NOT enforced for this stack" info finding.
  if (!Array.isArray(snapshot.manifestDeps)) {
    const detail = typeof snapshot.manifestError === 'string' && snapshot.manifestError.length > 0
      ? snapshot.manifestError
      : 'manifest could not be read';
    return [metaFinding(teamId, 'manifest-unenforced', {
      title: 'Dependency drift not enforced (manifest unparsed)',
      expected: `Parseable ${spec.stack?.manifest ?? 'dependency manifest'} so deps can be diffed against spec`,
      actual: `Not enforced: ${detail}`,
      recommendedCorrection:
        'Dependency drift currently supports Node (package.json) and '
        + 'Rust (Cargo.toml). Other stacks are uncovered until a parser lands.',
      provenance,
      reviewed,
    })];
  }

  const authorized = new Set(Array.isArray(depSpec.authorized) ? depSpec.authorized : []);
  const forbidden = new Set(Array.isArray(depSpec.forbidden) ? depSpec.forbidden : []);
  const enforceAuthorized = authorized.size > 0; // empty list = "not enumerated"

  const findings = [];
  for (const dep of snapshot.manifestDeps) {
    if (typeof dep !== 'string' || dep.length === 0) continue;
    if (forbidden.has(dep)) {
      findings.push(makeFinding(teamId, {
        salient: `forbidden:${dep}`,
        severity: clamp('critical', reviewed),
        title: `Forbidden dependency present: ${dep}`,
        expected: `${dep} is in spec.json dependencies.forbidden — it must not appear in the manifest`,
        actual: `${dep} is a direct dependency in ${spec.stack?.manifest ?? 'the manifest'}`,
        recommendedCorrection:
          `Remove ${dep}. If it is genuinely required, that is a spec change — `
          + `update docs/foundry/spec.json and the relevant ADR, don't silently add it.`,
        evidence: [
          `manifest direct dep: ${dep}`,
          `spec.json dependencies.forbidden includes: ${dep}`,
        ],
        reviewed, provenance,
      }));
      continue; // forbidden supersedes the unauthorized check
    }
    if (enforceAuthorized && !authorized.has(dep)) {
      findings.push(makeFinding(teamId, {
        salient: `unauthorized:${dep}`,
        severity: clamp('medium', reviewed),
        title: `Unauthorized dependency: ${dep}`,
        expected: `Only dependencies listed in spec.json dependencies.authorized`,
        actual: `${dep} is a direct dependency but not in the authorized list`,
        recommendedCorrection:
          `Either remove ${dep}, or — if it is intentional — add it to `
          + `docs/foundry/spec.json dependencies.authorized (a deliberate, `
          + `reviewable spec change, not a silent drift).`,
        evidence: [
          `manifest direct dep: ${dep}`,
          `spec.json dependencies.authorized (${authorized.size}): ${[...authorized].join(', ')}`,
        ],
        reviewed, provenance,
      }));
    }
  }
  return findings;
}

/** Severity clamp per ruling #4: unreviewed spec → everything info. */
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
    // §4b — carry the spec's reviewed-state forward so scoreFindings
    // + the UI weight provisional findings without re-parsing spec.json.
    specReviewed: reviewed === true,
    specProvenance: provenance,
  };
}

function metaFinding(teamId, salient, {
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
    severity: 'info', // meta-findings are always informational
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
