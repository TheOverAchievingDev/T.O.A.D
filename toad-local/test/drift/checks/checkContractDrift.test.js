import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContractDrift } from '../../../src/drift/checks/checkContractDrift.js';

// L1.4a — contract drift, PRESENCE only. Pure over the snapshot
// (buildSnapshot pre-runs scanContracts → snapshot.contractScan, and
// already computes snapshot.structurePresence for L1.2a).
//
// §4a fence: presence only, NEVER type correctness (compiler's job).
//
// ROADMAP-AWARE (the 2026-05-15 Reaper dogfood lesson — same class as
// L1.2a's): a declared contract fn that is absent is only CONTRACT
// drift when its owning MODULE is present (the component exists but
// its promised API is gone/renamed). If the owning module is itself
// absent, that is STRUCTURAL drift (check_structural_declared_absent
// owns it, roadmap-aware) — flagging it here too would double-count
// AND wolf-cry every greenfield project. Defer via one honest meta.
//
//   contract fn present                               → no finding
//   fn absent, owning module PRESENT                  → high (real drift)
//   fn absent, owning module ABSENT/undeterminable    → ONE info meta
//   spec unreviewed (ruling #4)                        → clamp to info
//   scan error (unsupported language)                  → ONE info meta
//   web/endpoint contracts                             → ONE info meta
//   scan truncated (file cap)                          → suppress, meta

function snap(overrides = {}) {
  return {
    teamId: 'team-reaper',
    spec: {
      version: 1,
      stack: { language: 'rust', manifest: 'Cargo.toml' },
      structure: {
        required: [
          { kind: 'module', name: 'killer', evidence: 'src/killer.rs' },
          { kind: 'module', name: 'safety', evidence: 'src/safety.rs' },
        ],
      },
      contracts: [
        { id: 'killer.kill', signature: 'fn kill(pids: &[u32]) -> KillReport' },
        { id: 'safety.is_protected', signature: 'fn is_protected(row: &ProcessRow) -> Option<ProtectedReason>' },
      ],
      provenance: { reviewed: true, extracted_by: 'hand', source_docs: ['docs/foundry/tech-spec.md'] },
    },
    // Owning modules PRESENT — so a missing fn is genuine contract drift.
    structurePresence: { killer: true, safety: true },
    contractScan: {
      results: [
        { id: 'killer.kill', identifier: 'kill', found: true },
        { id: 'safety.is_protected', identifier: 'is_protected', found: true },
      ],
      missing: [],
      webContractIds: [],
      unsupported: [],
      error: null,
      truncated: false,
    },
    ...overrides,
  };
}

test('all declared contracts present in source → no findings', () => {
  assert.deepEqual(checkContractDrift({ snapshot: snap() }), []);
});

test('fn absent but owning module PRESENT → one high architecture finding', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      structurePresence: { killer: true, safety: true },
      contractScan: {
        results: [
          { id: 'killer.kill', identifier: 'kill', found: true },
          { id: 'safety.is_protected', identifier: 'is_protected', found: false },
        ],
        missing: ['safety.is_protected'],
        webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.severity, 'high');
  assert.equal(f.category, 'architecture');
  assert.equal(f.checkName, 'check_contract_drift');
  assert.match(f.title, /safety\.is_protected/);
  assert.equal(f.specReviewed, true);
  assert.equal(f.specProvenance.sourceDoc, 'docs/foundry/tech-spec.md');
});

test('fn absent AND owning module ABSENT → one honest info meta, NOT high (defer to L1.2a, no greenfield wolf-cry)', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      structurePresence: { killer: false, safety: false }, // greenfield Reaper
      contractScan: {
        results: [
          { id: 'killer.kill', identifier: 'kill', found: false },
          { id: 'safety.is_protected', identifier: 'is_protected', found: false },
        ],
        missing: ['killer.kill', 'safety.is_protected'],
        webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  });
  assert.equal(findings.length, 1, 'two unbuilt modules → ONE aggregate meta, not two highs');
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].category, 'risk');
  assert.match(findings[0].actual, /killer\.kill/);
  assert.match(findings[0].actual, /safety\.is_protected/);
  assert.match(findings[0].recommendedCorrection, /structural|check_structural_declared_absent/i);
});

test('mixed: module-present fn missing → high; module-absent fn missing → folded into the meta', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      structurePresence: { killer: true, safety: false },
      contractScan: {
        results: [
          { id: 'killer.kill', identifier: 'kill', found: false },         // module present → high
          { id: 'safety.is_protected', identifier: 'is_protected', found: false }, // module absent → meta
        ],
        missing: ['killer.kill', 'safety.is_protected'],
        webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  });
  const tags = findings.map((f) => `${f.category}:${f.severity}`).sort();
  assert.deepEqual(tags, ['architecture:high', 'risk:info']);
  const high = findings.find((f) => f.severity === 'high');
  assert.match(high.title, /killer\.kill/);
});

test('explicit `callee` overrides id-derivation for ownership', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      // id says "api.login" but callee says the auth module owns it
      spec: {
        version: 1,
        stack: { language: 'rust' },
        structure: { required: [{ kind: 'module', name: 'auth', evidence: 'src/auth.rs' }] },
        contracts: [{ id: 'api.login', callee: 'auth', signature: 'fn login(c: Creds) -> Session' }],
        provenance: { reviewed: true, extracted_by: 'h', source_docs: ['docs/foundry/tech-spec.md'] },
      },
      structurePresence: { auth: true }, // auth module present → real drift
      contractScan: {
        results: [{ id: 'api.login', identifier: 'login', found: false }],
        missing: ['api.login'],
        webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].title, /api\.login/);
});

test('undeterminable ownership (no structurePresence) → honest meta, never high', () => {
  const s = snap({
    structurePresence: undefined,
    contractScan: {
      results: [{ id: 'killer.kill', identifier: 'kill', found: false }],
      missing: ['killer.kill'],
      webContractIds: [], unsupported: [], error: null, truncated: false,
    },
  });
  const findings = checkContractDrift({ snapshot: s });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].category, 'risk');
});

test('unreviewed spec clamps the genuine-drift finding to info (ruling #4)', () => {
  const s = snap({
    structurePresence: { killer: true },
    contractScan: {
      results: [{ id: 'killer.kill', identifier: 'kill', found: false }],
      missing: ['killer.kill'],
      webContractIds: [], unsupported: [], error: null, truncated: false,
    },
  });
  s.spec.provenance.reviewed = false;
  const findings = checkContractDrift({ snapshot: s });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].specReviewed, false);
});

test('scan error (unsupported language) → one honest info meta, NOT per-contract drift', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      contractScan: {
        results: [], missing: [], webContractIds: [], unsupported: [],
        error: 'unsupported language for contract presence scan: haskell',
        truncated: false,
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].category, 'risk');
  assert.match(findings[0].actual, /unsupported language/i);
});

test('web/endpoint contracts → one honest info meta (route drift is a later slice)', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      contractScan: {
        results: [{ id: 'killer.kill', identifier: 'kill', found: true }],
        missing: [],
        webContractIds: ['auth.login', 'h.health'],
        unsupported: [], error: null, truncated: false,
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].category, 'risk');
  assert.match(findings[0].actual, /endpoint|later slice/i);
});

test('truncated scan suppresses missing→high and emits one honest incomplete meta', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      structurePresence: { killer: true },
      contractScan: {
        results: [{ id: 'killer.kill', identifier: 'kill', found: false }],
        missing: ['killer.kill'],
        webContractIds: [], unsupported: [],
        error: null, truncated: true,
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].category, 'risk');
  assert.match(findings[0].actual, /incomplete|cap|truncat/i);
});

// ── L1.4b: arity-mismatch findings ─────────────────────────────────
// found:true proves an implementation exists, so an arity mismatch is
// unambiguous genuine drift (the fn is there but shaped differently
// from the spec) — medium, less severe than wholly-missing high.
// Either arity null → NO arity finding (presence-only, never wolf-cry).

test('found + arity mismatch (both numeric) → one medium architecture finding', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      contractScan: {
        results: [
          { id: 'killer.kill', identifier: 'kill', found: true, declaredArity: 1, foundArity: 2 },
          { id: 'safety.is_protected', identifier: 'is_protected', found: true, declaredArity: 1, foundArity: 1 },
        ],
        missing: [], webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  });
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.severity, 'medium');
  assert.equal(f.category, 'architecture');
  assert.equal(f.checkName, 'check_contract_drift');
  assert.match(f.title, /killer\.kill/);
  assert.match(f.actual, /1.*2|declared 1|found 2/);
});

test('found + arity equal → no finding', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      contractScan: {
        results: [{ id: 'killer.kill', identifier: 'kill', found: true, declaredArity: 2, foundArity: 2 }],
        missing: [], webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  });
  assert.deepEqual(findings, []);
});

test('found + arity ambiguous (a null) → NO arity finding (presence-only, no wolf-cry)', () => {
  for (const [d, f] of [[1, null], [null, 2], [null, null]]) {
    const findings = checkContractDrift({
      snapshot: snap({
        contractScan: {
          results: [{ id: 'killer.kill', identifier: 'kill', found: true, declaredArity: d, foundArity: f }],
          missing: [], webContractIds: [], unsupported: [], error: null, truncated: false,
        },
      }),
    });
    assert.deepEqual(findings, [], `declared=${d} found=${f} must not flag`);
  }
});

test('arity mismatch on an unreviewed spec is clamped to info (ruling #4)', () => {
  const s = snap({
    contractScan: {
      results: [{ id: 'killer.kill', identifier: 'kill', found: true, declaredArity: 1, foundArity: 3 }],
      missing: [], webContractIds: [], unsupported: [], error: null, truncated: false,
    },
  });
  s.spec.provenance.reviewed = false;
  const findings = checkContractDrift({ snapshot: s });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].specReviewed, false);
});

test('missing (high) and arity-mismatch (medium) coexist independently', () => {
  const findings = checkContractDrift({
    snapshot: snap({
      structurePresence: { killer: true, safety: true },
      contractScan: {
        results: [
          { id: 'killer.kill', identifier: 'kill', found: false, declaredArity: 1, foundArity: null },
          { id: 'safety.is_protected', identifier: 'is_protected', found: true, declaredArity: 1, foundArity: 2 },
        ],
        missing: ['killer.kill'], webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  });
  const tags = findings.map((x) => `${x.severity}`).sort();
  assert.deepEqual(tags, ['high', 'medium']);
});

test('no spec / no contracts declared → no findings, no walk side effects', () => {
  assert.deepEqual(checkContractDrift({ snapshot: { teamId: 't' } }), []);
  assert.deepEqual(
    checkContractDrift({ snapshot: { teamId: 't', spec: { version: 1 } } }),
    [],
  );
  assert.deepEqual(
    checkContractDrift({ snapshot: { teamId: 't', spec: { version: 1, contracts: [] } } }),
    [],
  );
});

test('stable finding id is deterministic across runs for the same missing contract', () => {
  const mk = () => checkContractDrift({
    snapshot: snap({
      structurePresence: { killer: true },
      contractScan: {
        results: [{ id: 'killer.kill', identifier: 'kill', found: false }],
        missing: ['killer.kill'],
        webContractIds: [], unsupported: [], error: null, truncated: false,
      },
    }),
  })[0].id;
  assert.equal(mk(), mk());
});
