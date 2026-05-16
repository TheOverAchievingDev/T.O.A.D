import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_constitution';

/**
 * L1.3 — constitution drift. Generalizes the hardcoded
 * check_provider_logic_leakage prototype into spec-driven rules:
 * spec.constitution.rules[] each declare a detector (grep /
 * path_presence), a severity, and a mode (observe | gate).
 *
 * Pure function over the snapshot. buildSnapshot runs the bounded
 * WHOLE-TREE scan (scanConstitution) — whole-tree, NOT diff-scoped,
 * because constitution rules are standing invariants (a pre-existing
 * `SeDebugPrivilege` must be caught even if it never appeared in a
 * watched task diff). This check just shapes the precomputed hits
 * into DriftFindings.
 *
 * Severity is the RULE's declared severity, not a constant — a
 * "secrets in logs" rule is critical, a style rule is low. Ruling #4
 * still applies: an unreviewed spec clamps every severity to info and
 * tags specReviewed:false.
 *
 * `constitutionMode` is carried onto every finding (the rule's
 * observe|gate). L1.3 itself only OBSERVES — it produces the finding.
 * The gate enforcement (block the merge at the merge_ready→done
 * constitution gate, shipped) consumes `constitutionMode:'gate'`
 * findings; carrying the mode here means the gate needs zero changes
 * to this check. Gating policy is independent of review state, so the
 * mode is carried even when severity is clamped to info.
 *
 * Honest degradation, consistent with L1.1/L1.2:
 *   - no spec / no constitution.rules        → []
 *   - rules present, zero hits               → [] (clean)
 *   - unsupported detector types             → ONE aggregate info meta
 *   - scanner errored                        → ONE info meta
 * never a silent pass that reads as "no drift".
 */
export function checkConstitution({ snapshot } = {}) {
  if (!snapshot || !snapshot.spec) return [];
  const teamId = snapshot.teamId;
  const spec = snapshot.spec;
  const rules = spec.constitution && Array.isArray(spec.constitution.rules)
    ? spec.constitution.rules
    : null;
  if (rules === null || rules.length === 0) return [];

  const reviewed = spec.provenance?.reviewed === true;
  const provenance = {
    extractedBy: typeof spec.provenance?.extracted_by === 'string'
      ? spec.provenance.extracted_by : 'unknown',
    sourceDoc: Array.isArray(spec.provenance?.source_docs) && spec.provenance.source_docs.length > 0
      ? spec.provenance.source_docs[0]
      : 'docs/foundry/spec.json',
  };

  const ruleById = new Map();
  for (const r of rules) {
    if (r && typeof r.id === 'string' && r.id.length > 0) ruleById.set(r.id, r);
  }

  const findings = [];

  // Scanner error → one honest info meta.
  if (typeof snapshot.constitutionError === 'string' && snapshot.constitutionError.length > 0) {
    findings.push(meta(teamId, 'scan-error', {
      title: 'Constitution scan errored (not enforced this run)',
      expected: 'Constitution rules evaluated against the project tree',
      actual: `Scan error: ${snapshot.constitutionError}`,
      recommendedCorrection: 'Transient — usually resolves next run. Persistent errors: check filesystem permissions on the workspace.',
      provenance, reviewed,
    }));
  }

  // Unsupported detector types → one aggregate honest info meta.
  const unsupported = Array.isArray(snapshot.constitutionUnsupported)
    ? snapshot.constitutionUnsupported.filter((x) => typeof x === 'string' && x.length > 0)
    : [];
  if (unsupported.length > 0) {
    findings.push(meta(teamId, 'unsupported-detectors', {
      title: 'Some constitution rules use detector types not enforced in v1',
      expected: 'Every constitution rule evaluated',
      actual:
        `Not enforced (grep + path_presence only in v1): ${unsupported.join(', ')}`,
      recommendedCorrection:
        'Re-express these rules as grep/path_presence detectors, or '
        + 'leave them for a later detector-type slice. They are NOT '
        + 'silently passing — this note is the honest signal.',
      provenance, reviewed,
    }));
  }

  const hits = Array.isArray(snapshot.constitutionHits) ? snapshot.constitutionHits : [];
  for (const hit of hits) {
    if (!hit || typeof hit.ruleId !== 'string') continue;
    const rule = ruleById.get(hit.ruleId);
    if (!rule) continue; // scanner/spec mismatch — ignore defensively
    const ruleSeverity = typeof rule.severity === 'string' ? rule.severity : 'medium';
    const mode = rule.mode === 'gate' ? 'gate' : 'observe';
    const loc = hit.line && hit.line > 0 ? `${hit.file}:${hit.line}` : hit.file;
    findings.push({
      id: stableFindingId({
        teamId, checkName: CHECK_NAME, category: 'risk',
        taskId: null, salient: `${hit.ruleId}:${loc}`,
      }),
      runId: '',
      teamId,
      taskId: null,
      category: 'risk',
      severity: reviewed ? ruleSeverity : 'info',
      checkName: CHECK_NAME,
      title: `Constitution rule violated: ${rule.id}${rule.description ? ` — ${rule.description}` : ''}`,
      evidence: [
        `${loc}: ${hit.snippet ?? '(match)'}`,
        rule.source ? `rule source: ${rule.source}` : `rule: ${rule.id}`,
      ],
      expected: rule.description
        ? `Constitution: ${rule.description}`
        : `Constitution rule ${rule.id} holds across the codebase`,
      actual: `${loc}: ${hit.snippet ?? '(match)'}`,
      recommendedCorrection:
        `Fix the violation at ${loc}. If the rule itself is wrong, that `
        + `is a deliberate spec change — update spec.json constitution `
        + `(and the steering doc it came from), don't silently work `
        + `around it.`,
      autoFixable: false,
      specReviewed: reviewed === true,
      specProvenance: provenance,
      // Carried for the merge-gate consumer. observe = flag only
      // (findings surface in the drift stream; broker notification deferred);
      // gate = block at merge_ready→done constitution gate when this
      // violation is diff-introduced.
      ...(mode === 'observe' ? { needsSemanticReview: true } : {}),
      constitutionMode: mode,
    });
  }

  return findings;
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
    constitutionMode: 'observe',
  };
}
