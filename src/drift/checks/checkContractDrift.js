import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_contract_drift';

/**
 * L1.4a — contract drift, PRESENCE only. The LAST Layer-1
 * deterministic check (reviewer order: dependency → structural →
 * constitution → contract).
 *
 * Pure function over the snapshot. buildSnapshot pre-runs
 * scanContracts and attaches snapshot.contractScan, so this check
 * never touches the filesystem — same discipline as L1.1–L1.3.
 *
 * §4a fence (DO NOT "improve" this into a type validator): a declared
 * contract is satisfied iff a function with its identifier is DEFINED
 * somewhere in the source. Arity comparison is L1.4b (split off for
 * the same wolf-cry reason L1.2 was split a/b). Type correctness is
 * the compiler's job (validation_run) and is NEVER in scope.
 *
 *   declared contract fn exists            → no finding
 *   declared contract has NO definition    → high (architecture):
 *                                            the spec promises an
 *                                            inter-component API that
 *                                            does not exist
 *   spec unreviewed (ruling #4)            → severity clamped to info
 *   scan error (unsupported language)      → ONE info risk meta
 *                                            (honest "not enforced",
 *                                            never per-contract spam)
 *   web/endpoint contracts declared        → ONE info risk meta
 *                                            (route-registration drift
 *                                            is a later slice)
 *   scan truncated (file-cap hit)          → SUPPRESS missing→high,
 *                                            ONE info meta (a possibly-
 *                                            incomplete walk must not
 *                                            wolf-cry "no impl")
 *
 * §4b: every finding carries specReviewed + specProvenance so the
 * scorer / UI / L3 gate weight it without re-parsing spec.json.
 */
export function checkContractDrift({ snapshot } = {}) {
  if (!snapshot || !snapshot.spec) return [];
  const teamId = snapshot.teamId;
  const spec = snapshot.spec;
  const contracts = Array.isArray(spec.contracts) ? spec.contracts : [];
  if (contracts.length === 0) return [];

  const scan = snapshot.contractScan && typeof snapshot.contractScan === 'object'
    ? snapshot.contractScan
    : null;

  const reviewed = spec.provenance?.reviewed === true;
  const provenance = {
    extractedBy: typeof spec.provenance?.extracted_by === 'string'
      ? spec.provenance.extracted_by : 'unknown',
    sourceDoc: Array.isArray(spec.provenance?.source_docs) && spec.provenance.source_docs.length > 0
      ? spec.provenance.source_docs[0]
      : 'docs/foundry/spec.json',
  };

  // No scan attached at all → honest "not enforced" rather than a
  // silent pass (buildSnapshot degraded; mirror L1.1's missing-input
  // meta discipline).
  if (!scan) {
    return [meta(teamId, 'contract-scan-absent', {
      title: 'Contract presence drift not enforced (no scan result)',
      expected: 'buildSnapshot attaches snapshot.contractScan for the declared contracts',
      actual: 'No contract scan was produced this run — contract presence is not being checked.',
      recommendedCorrection:
        'This is informational. If it persists, the contract scanner '
        + 'failed to run (check buildSnapshot wiring); no contract is '
        + 'being flagged either way.',
      provenance, reviewed,
    })];
  }

  // Unsupported language / scanner error → one honest info meta.
  if (typeof scan.error === 'string' && scan.error.length > 0) {
    return [meta(teamId, 'contract-scan-error', {
      title: 'Contract presence drift not enforced',
      expected: 'Declared contracts verified for presence against the source tree',
      actual: scan.error,
      recommendedCorrection:
        'Contract presence is enforced for supported languages only. '
        + 'No contract is flagged as missing on an unscannable tree '
        + '(honest by design — it will not wolf-cry).',
      provenance, reviewed,
    })];
  }

  const findings = [];
  const webIds = Array.isArray(scan.webContractIds) ? scan.webContractIds : [];
  const missing = Array.isArray(scan.missing) ? scan.missing : [];

  if (scan.truncated === true) {
    // A walk that hit the file cap may not have reached a contract's
    // real definition — flagging "no impl" here would be a false
    // positive. Suppress, disclose honestly.
    findings.push(meta(teamId, 'contract-scan-truncated', {
      title: 'Contract presence scan incomplete (file cap hit)',
      expected: 'The whole source tree walked for declared-contract definitions',
      actual:
        'The contract scan hit its file-count cap before finishing, so '
        + 'presence results may be incomplete. Not flagging any contract '
        + 'as missing to avoid a false positive.',
      recommendedCorrection:
        'If the repository is genuinely this large, raise the scan cap; '
        + 'otherwise no action — this run simply did not assert presence.',
      provenance, reviewed,
    }));
  } else {
    // ROADMAP-AWARE split (the 2026-05-15 Reaper dogfood lesson — same
    // class as L1.2a's). A missing contract fn is only CONTRACT drift
    // when its owning module is PRESENT (component exists, promised API
    // gone/renamed). If the owning module is itself absent — or we
    // cannot confirm it is present — that is STRUCTURAL drift
    // (check_structural_declared_absent owns it, roadmap-aware).
    // Flagging it HIGH here too would double-count AND wolf-cry every
    // greenfield project where nothing is built yet.
    const presence = snapshot.structurePresence && typeof snapshot.structurePresence === 'object'
      ? snapshot.structurePresence
      : null;
    const byId = new Map();
    for (const c of contracts) {
      if (c && typeof c.id === 'string') byId.set(c.id, c);
    }
    const deferred = [];
    for (const id of missing) {
      const contract = byId.get(id);
      // Ownership: explicit `callee` (reviewer doctrine — explicit over
      // inferred), else derive by stripping the last ".<fn>" segment.
      const ownerModule = contract && typeof contract.callee === 'string' && contract.callee.length > 0
        ? contract.callee
        : (id.includes('.') ? id.replace(/\.[^.]+$/, '') : null);
      const ownerPresent = presence && ownerModule != null
        && presence[ownerModule] === true;
      if (!ownerPresent) { deferred.push(id); continue; }
      findings.push(makeFinding(teamId, {
        salient: `missing:${id}`,
        severity: clamp('high', reviewed),
        title: `Declared contract "${id}" has no implementation`,
        expected:
          `spec.json contracts declares "${id}" and its owning module `
          + `"${ownerModule}" is present — a function with that `
          + 'identifier should be defined in the source',
        actual:
          `Module "${ownerModule}" exists but no definition for contract `
          + `"${id}" was found anywhere in the scanned source tree `
          + '(presence check; call sites do not count).',
        recommendedCorrection:
          `Either implement "${id}" in "${ownerModule}" (the `
          + 'inter-component API the spec promises) or remove/rename the '
          + 'contract in spec.json if the identifier changed.',
        evidence: [
          `spec declares contract: ${id} (owning module "${ownerModule}" present)`,
          'no matching function definition in source (L1.4a presence)',
        ],
        reviewed, provenance,
      }));
    }
    if (deferred.length > 0) {
      findings.push(meta(teamId, 'contract-owner-absent', {
        title: 'Declared contracts whose owning module is not built yet',
        expected:
          'Each declared contract has an implementation once its owning '
          + 'module exists',
        actual:
          `${deferred.length} declared contract${deferred.length === 1 ? '' : 's'} `
          + `(${deferred.join(', ')}) ${deferred.length === 1 ? 'has' : 'have'} no `
          + 'implementation, but the owning module is absent or '
          + 'unconfirmed — this is structural/roadmap state, not '
          + 'contract drift.',
        recommendedCorrection:
          'Not flagged as contract drift to avoid double-counting and '
          + 'greenfield wolf-cry — check_structural_declared_absent '
          + '(L1.2a) tracks unbuilt declared modules roadmap-aware. '
          + 'Contract drift fires here once the module is present but '
          + 'its promised API is missing.',
        provenance, reviewed,
      }));
    }

    // L1.4b — arity. found:true already proves an implementation
    // exists, so a confident declared≠found arg-count is unambiguous
    // genuine drift: medium (the fn is there, just shaped differently
    // — less severe than wholly-missing high). EITHER arity null means
    // scanContracts wasn't sure (generics/self/closures/multiline/JS
    // destructuring) → presence-only, never wolf-cry. §4a: arg COUNT
    // only; types are the compiler's job (validation_run).
    for (const res of (Array.isArray(scan.results) ? scan.results : [])) {
      if (!res || res.found !== true) continue;
      const da = res.declaredArity;
      const fa = res.foundArity;
      if (typeof da !== 'number' || typeof fa !== 'number') continue;
      if (da === fa) continue;
      findings.push(makeFinding(teamId, {
        salient: `arity:${res.id}`,
        severity: clamp('medium', reviewed),
        title: `Declared contract "${res.id}" implemented with a different argument count`,
        expected:
          `spec.json declares "${res.id}" taking ${da} argument`
          + `${da === 1 ? '' : 's'}`,
        actual:
          `The implementation of "${res.id}" takes ${fa} argument`
          + `${fa === 1 ? '' : 's'} (declared ${da}, found ${fa}). `
          + 'Presence + arity only — argument/return TYPES are the '
          + "compiler's job (§4a), never drift's.",
        recommendedCorrection:
          `Reconcile the contract: update spec.json's signature for `
          + `"${res.id}" to match the code, or fix the implementation's `
          + 'parameter list to honor the declared contract.',
        evidence: [
          `spec declares contract: ${res.id} (arity ${da})`,
          `implementation found with arity ${fa}`,
        ],
        reviewed, provenance,
      }));
    }
  }

  if (webIds.length > 0) {
    findings.push(meta(teamId, 'contract-web-deferred', {
      title: 'Web/endpoint contract drift not enforced (v1 covers internal calls)',
      expected: 'Declared endpoints verified against registered routes',
      actual:
        `${webIds.length} web/endpoint contract${webIds.length === 1 ? '' : 's'} `
        + `declared (${webIds.join(', ')}); route-registration enumeration `
        + 'is a later slice.',
      recommendedCorrection:
        'Internal-call contract presence is enforced now; endpoint route '
        + 'drift lands in a follow-up. No action needed.',
      provenance, reviewed,
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
