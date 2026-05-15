import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_structural_declared_absent';

/**
 * L1.2a — declared-but-absent structural drift, ROADMAP-AWARE.
 *
 * Reviewer ruling (Option 4, slice a): the two directions of
 * structural drift are asymmetric and are separate checks.
 *
 *   - THIS check (L1.2a): "did the team deliver what the spec
 *     declared?" — a PROGRESS question. Needs roadmap awareness:
 *     a declared module absent from source is NOT drift while its
 *     delivery task is still in-flight; it IS drift once that task
 *     is done/merged and the module still isn't there.
 *   - L1.2b (separate slice): "is there source the spec never
 *     sanctioned?" — a SCOPE question, no roadmap awareness.
 *
 * Pure function over the snapshot. buildSnapshot pre-resolves which
 * declared module evidence-paths exist on disk
 * (snapshot.structurePresence: name → bool), so this check never
 * touches the filesystem — same purity discipline as L1.1.
 *
 * Severity matrix:
 *   present in source                                    → no finding
 *   absent, NO task delivers it                          → low
 *   absent, delivering task pending/in_progress          → no finding (in-flight)
 *   absent, delivering task done (no merge evidence)      → high
 *   absent, delivering task merged                       → critical
 *
 * Wolf-cry avoidance: the task→module link is an EXPLICIT
 * `task.delivers` array (e.g. ["module:sampler"]) — never inferred
 * from task titles (the reviewer was emphatic: inference's ~20%
 * miss rate compounds badly when it drives automated severity).
 * When NO task carries `delivers` at all (the field hasn't been
 * adopted yet — Reaper today), we emit ONE info `risk` meta-finding
 * ("not enforced — add delivers"), NOT one low finding per absent
 * module. This mirrors L1.1's "manifest unparsed → one honest info
 * meta-finding" degradation: honest beats both silent-pass and spam.
 *
 * Ruling #4 / §4b: unreviewed spec clamps every severity to info and
 * tags specReviewed:false + specProvenance so scoreFindings + the UI
 * weight provisional findings without re-parsing spec.json.
 *
 * v1 scope: `kind: module` entries only. `kind: endpoint` needs route
 * enumeration (later). If the spec declares ONLY endpoints, we emit a
 * single honest info note rather than silently passing.
 */
export function checkStructuralDeclaredAbsent({ snapshot } = {}) {
  if (!snapshot || !snapshot.spec) return [];
  const teamId = snapshot.teamId;
  const spec = snapshot.spec;
  const required = spec.structure && Array.isArray(spec.structure.required)
    ? spec.structure.required
    : [];
  if (required.length === 0) return [];

  const moduleEntries = required.filter((e) => e && e.kind === 'module');
  const endpointEntries = required.filter((e) => e && e.kind === 'endpoint');

  const reviewed = spec.provenance?.reviewed === true;
  const provenance = {
    extractedBy: typeof spec.provenance?.extracted_by === 'string'
      ? spec.provenance.extracted_by : 'unknown',
    sourceDoc: Array.isArray(spec.provenance?.source_docs) && spec.provenance.source_docs.length > 0
      ? spec.provenance.source_docs[0]
      : 'docs/foundry/spec.json',
  };

  // Spec declares only endpoints → honest "not implemented in v1" note.
  if (moduleEntries.length === 0 && endpointEntries.length > 0) {
    return [meta(teamId, 'endpoint-structural-v2', {
      title: 'Endpoint structural drift not enforced (v1 covers modules only)',
      expected: 'Declared endpoints verified against registered routes',
      actual: `${endpointEntries.length} endpoint entr${endpointEntries.length === 1 ? 'y' : 'ies'} declared; route enumeration is a later slice`,
      recommendedCorrection:
        'Module structural drift is enforced now; endpoint route '
        + 'enumeration lands in a follow-up. No action needed.',
      provenance, reviewed,
    })];
  }
  if (moduleEntries.length === 0) return [];

  const presence = snapshot.structurePresence && typeof snapshot.structurePresence === 'object'
    ? snapshot.structurePresence
    : {};

  // Build the explicit task→delivers index. `delivers` entries look
  // like "module:<name>" / "endpoint:<method> <path>".
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const taskEvents = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const anyDelivers = tasks.some((t) => Array.isArray(t?.delivers) && t.delivers.length > 0);

  // Field not adopted anywhere → one honest "not enforced" meta-finding.
  if (!anyDelivers) {
    return [meta(teamId, 'delivers-unadopted', {
      title: 'Structural drift (declared-absent) not enforced',
      expected:
        'Tasks declare which module/endpoint they deliver via an '
        + 'explicit `delivers` field so absence can be judged against '
        + 'delivery progress',
      actual:
        'No task carries a `delivers` field — cannot distinguish '
        + '"not built yet" from "delivered task but module missing". '
        + 'Roadmap-aware structural drift is dormant until adopted.',
      recommendedCorrection:
        'Add `delivers: ["module:<name>"]` to tasks (Foundry '
        + 'task-breakdown generation + task_create). Until then this '
        + 'check stays informational by design — it will not wolf-cry '
        + 'on every unbuilt module.',
      provenance, reviewed,
    })];
  }

  const mergedEventTaskIds = new Set(
    taskEvents
      .filter((e) => e && e.eventType === 'task.integration_merged' && e.taskId)
      .map((e) => e.taskId),
  );

  const findings = [];
  for (const entry of moduleEntries) {
    const name = entry.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    // Present in source → delivered, no finding.
    if (presence[name] === true) continue;

    const deliveringTasks = tasks.filter(
      (t) => Array.isArray(t?.delivers) && t.delivers.includes(`module:${name}`),
    );

    if (deliveringTasks.length === 0) {
      // Declared, absent, nobody assigned to build it → planning gap.
      findings.push(makeFinding(teamId, {
        salient: `unmapped:${name}`,
        severity: clamp('low', reviewed),
        title: `Declared module "${name}" has no delivery task`,
        expected: `spec.json structure.required declares module "${name}" — a task should deliver it`,
        actual: `Module "${name}" is absent from source (expected ${entry.evidence ?? 'a source module'}) and no task declares delivers:["module:${name}"]`,
        recommendedCorrection:
          `Either create a task that delivers "${name}" (and set its `
          + `delivers field), or remove the module from spec.json if it `
          + `was over-declared.`,
        evidence: [
          `spec declares module: ${name} (evidence: ${entry.evidence ?? 'n/a'})`,
          'no task delivers it; not present in source',
        ],
        reviewed, provenance,
      }));
      continue;
    }

    // Is any delivering task "done" / "merged"? Mirror
    // checkDoneWithoutMergeEvidence's determination for consistency.
    let worst = null; // 'high' (done) | 'critical' (merged)
    let worstTaskId = null;
    for (const t of deliveringTasks) {
      const isDone = t.status === 'done' || t.status === 'completed';
      if (!isDone) continue; // pending/in_progress → in-flight, not drift
      const isMerged =
        (t.integration && typeof t.integration === 'object')
        || mergedEventTaskIds.has(t.taskId);
      if (isMerged) { worst = 'critical'; worstTaskId = t.taskId; break; }
      if (worst !== 'critical') { worst = 'high'; worstTaskId = t.taskId; }
    }
    if (!worst) continue; // all delivering tasks still in-flight

    findings.push(makeFinding(teamId, {
      salient: `absent:${name}:${worst}`,
      severity: clamp(worst, reviewed),
      title: `Module "${name}" missing though delivery task is ${worst === 'critical' ? 'merged' : 'done'}`,
      expected: `Module "${name}" present in source (${entry.evidence ?? 'declared path'}) once its delivery task closed`,
      actual: `Task ${worstTaskId} is ${worst === 'critical' ? 'merged' : 'done'} but module "${name}" is still absent from source`,
      recommendedCorrection:
        `Investigate task ${worstTaskId}: was "${name}" actually built? `
        + `Either the task was closed prematurely (reopen it) or the `
        + `module landed under a path the spec's evidence pointer `
        + `doesn't match (fix the spec or the code).`,
      evidence: [
        `spec declares module: ${name} (evidence: ${entry.evidence ?? 'n/a'})`,
        `delivering task ${worstTaskId} status indicates ${worst === 'critical' ? 'merged' : 'done'}`,
        'module not present in source',
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
