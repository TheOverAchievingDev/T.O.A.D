import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot } from './buildSnapshot.js';
import { scoreFindings } from './scoreFindings.js';
import { DETERMINISTIC_CHECKS } from './checks/index.js';
import { kindForCheck } from './checks/checkKinds.js';
import { l3Gate, l3CacheKey, silentButSignificant, l3CheapEligible } from './llm/l3Gate.js';
import { buildL3Packet } from './llm/buildL3Packet.js';
import { isFileDeclaredByModule } from './spec/isFileDeclaredByModule.js';
import { countDeclaredChangedLines } from './llm/silentSignificance.js';
import { l3Judge as defaultL3Judge } from './llm/l3Judge.js';
import { resolveProvider } from './llm/providerResolver.js';
import { L3_PROMPT_TEMPLATE } from './llm/prompts/l3.js';

const DEFAULT_SETTINGS = Object.freeze({
  drift: Object.freeze({
    llmTierEnabled: true,
    // Periodic-trigger cooldown. The backend monitor (5min) AND the UI
    // poll (60s) both issue trigger:'periodic'. Without this, every
    // periodic call does a full whole-tree re-scan (buildSnapshot walks
    // the project) + a new persisted run — the 2026-05-15 usage spike.
    // 5min matches DriftMonitor's DEFAULT_INTERVAL_MS so the slowest
    // periodic caller sets the real cadence; manual + task_event bypass.
    periodicCooldownMs: 300_000,
    tier1ModelOverride: null,
    tier2ModelOverride: null,
    // L3 circuit breaker (design §3.4): max L3 spawns per team per
    // rolling hour. On trip the engine emits an observer-severity meta
    // and skips WITHOUT polluting the verdict cache.
    l3RateCapPerHour: 30,
    // L3 packet budget (design §4.1): assembled packet bytes over this
    // → buildL3Packet returns overBudget; engine emits meta + skips.
    l3PacketBudgetBytes: 32 * 1024,
    // L3 Slice B (design 2026-05-16 §5): silent-significance magnitude
    // floor. Always enforced (load-bearing, never disabled); a
    // configured value < 1 is clamped to 1 by meetsMagnitudeFloor.
    l3SilentMagnitudeFloor: 10,
  }),
});

/**
 * Slice-A L3 orchestrator for drift evaluation.
 *
 *   1. buildSnapshot(teamId)
 *   2. Run tier-1 deterministic checks (all tier: 1 — the registry is
 *      one set now; L3 is NOT a registry entry)
 *   3. L3 gate (scoped, task-boundary, ambiguity-gated): l3Gate decides
 *      skip | serve_cached(non-manual) | invoke. On invoke:
 *      buildL3Packet → temp-brief + HOME-isolated l3Judge (Haiku→Sonnet
 *      one self-escalation). Verdict cached per (team, ETag-key).
 *      Config observer-severity rate cap; over-budget → meta+skip;
 *      failure → meta-not-cached.
 *   4. Combine, score, persist, return DriftRunResult with `l3:{status}`
 *
 * Per-team mutex: only one runDrift({teamId}) is in flight at a time.
 * In-memory verdict cache + rate window: lost on sidecar restart
 * (acceptable per design — re-warms at the next boundary).
 *
 * Default `checks` is the deterministic registry (DETERMINISTIC_CHECKS,
 * an alias of ALL_CHECKS). Production wiring (scripts/dev-api-server.mjs)
 * passes ALL_CHECKS explicitly. Tests inject their own check list and
 * an `l3JudgeImpl` so no provider subprocess spawns.
 */
export class DriftEngine {
  #inflight = new Map();
  // teamId -> this.now() of the last COMPUTED+persisted run. In-memory
  // (lost on sidecar restart — acceptable; first periodic after a
  // restart simply recomputes). Drives the periodic-trigger cooldown.
  #lastRunAt = new Map();
  // teamId -> Map(l3CacheKey -> { findings, tier }). In-memory verdict
  // cache (ETag-style; key includes l3PromptHash so a prompt edit busts
  // it). Lost on restart — acceptable.
  #l3VerdictCache = new Map();
  // teamId -> number[] (this.now() timestamps of L3 spawns). Rolling
  // hour window for the §3.4 circuit breaker.
  #l3RateWindow = new Map();

  constructor({
    deps,
    store,
    checks = DETERMINISTIC_CHECKS,
    settings = DEFAULT_SETTINGS,
    now = Date.now,
    l3JudgeImpl = defaultL3Judge,
  } = {}) {
    if (!deps) throw new TypeError('DriftEngine: deps required');
    if (!store || typeof store.recordRun !== 'function') {
      throw new TypeError('DriftEngine: store with recordRun required');
    }
    this.deps = deps;
    this.store = store;
    this.checks = checks;
    this.settings = settings;
    this.now = now;
    // Injectable for tests; defaults to the real l3Judge. Threaded into
    // the L3 invoke path so no subprocess spawns under test.
    this.l3JudgeImpl = l3JudgeImpl || defaultL3Judge;
  }

  /**
   * boundaryTaskId/boundaryTo are populated iff the run is task-event-
   * or-manual-scoped; their absence signals "not a transition event"
   * (the gate treats a null boundaryTaskId as no_boundary_task → skip).
   */
  async runDrift({ teamId, trigger = 'manual', boundaryTaskId = null, boundaryTo = null } = {}) {
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new TypeError('runDrift: teamId required');
    }
    const existing = this.#inflight.get(teamId);
    if (existing) return existing;

    const promise = this.#runDriftInner({ teamId, trigger, boundaryTaskId, boundaryTo })
      .finally(() => this.#inflight.delete(teamId));
    this.#inflight.set(teamId, promise);
    return promise;
  }

  async #runDriftInner({ teamId, trigger, boundaryTaskId, boundaryTo }) {
    const runId = `run_${randomUUID()}`;

    // Early bail: if no team config exists for this teamId, drift has
    // nothing to evaluate. The 2026-05-15 regression had the UI cache
    // a stale teamId across a project switch — drift_run kept firing
    // against the prior project's team, which doesn't exist in the
    // new project's DB. Running checks anyway produces meaningless
    // "0 findings, healthy" results that mask the real issue.
    //
    // We check teamConfigRegistry directly rather than letting
    // buildSnapshot return an empty object so the failure mode is
    // explicit. Older deployments that don't wire teamConfigRegistry
    // into deps fall through to the existing behavior.
    if (this.deps?.teamConfigRegistry
        && typeof this.deps.teamConfigRegistry.getTeam === 'function'
        && this.deps.teamConfigRegistry.getTeam(teamId) === null) {
      return {
        runId,
        teamId,
        teamScore: 0,
        status: 'unknown',
        findings: [],
        reason: 'no_team_config',
        message: `Drift skipped: team "${teamId}" has no config (deleted, never created, or stale UI state after project switch).`,
        l3: { status: 'skipped:no_team_config' },
      };
    }

    const driftSettings = this.settings.drift ?? DEFAULT_SETTINGS.drift;

    // Periodic-trigger cooldown (the 2026-05-15 double-trigger fix).
    // The backend DriftMonitor (5min) AND the UI poll (60s) both issue
    // trigger:'periodic'. Without this guard every periodic call does a
    // full whole-tree re-scan (buildSnapshot walks the project tree:
    // scanConstitution + scanContracts) + a new persisted run. Only
    // `manual` (explicit operator intent) and `task_event` (real
    // lifecycle activity must surface immediately) force a fresh
    // compute; a `periodic` call within periodicCooldownMs of the last
    // computed run returns that run's persisted result unchanged.
    if (trigger === 'periodic') {
      const cooldownMs = typeof driftSettings.periodicCooldownMs === 'number'
        ? driftSettings.periodicCooldownMs
        : DEFAULT_SETTINGS.drift.periodicCooldownMs;
      const last = this.#lastRunAt.get(teamId);
      if (cooldownMs > 0 && last != null && (this.now() - last) < cooldownMs) {
        const cached = this.#cachedResult({ teamId });
        if (cached) return cached;
      }
    }

    // Step A: Read correction linkages BEFORE building snapshot / running checks.
    const linkages = (typeof this.store.getCorrectionLinkages === 'function')
      ? this.store.getCorrectionLinkages({ teamId })
      : new Map();

    const compareAgainst = driftSettings.compareAgainst ?? 'foundry_docs';
    const snapshot = await buildSnapshot({
      teamId,
      deps: this.deps,
      compareAgainst,
    });
    // Thread the boundary onto the snapshot so the packet builder /
    // gate have it alongside diffsByTask etc. (set before checks run).
    snapshot.boundaryTaskId = boundaryTaskId;
    snapshot.boundaryTo = boundaryTo;
    snapshot.l3SilentMagnitudeFloor =
      typeof driftSettings.l3SilentMagnitudeFloor === 'number'
        ? driftSettings.l3SilentMagnitudeFloor
        : DEFAULT_SETTINGS.drift.l3SilentMagnitudeFloor;
    const llmEnabled = driftSettings.llmTierEnabled !== false;

    // Run tier-1 deterministic checks (the registry is one set now).
    const tier1Checks = this.checks.filter((c) => c.tier === 1);

    const tier1Findings = [];
    const tier1Status = 'completed';
    for (const check of tier1Checks) {
      try {
        const out = (await check.fn({ snapshot, settings: this.settings })) || [];
        for (const f of out) {
          const stamped = { ...f, runId, teamId, kind: kindForCheck(f.checkName) };
          if (linkages.has(stamped.id)) stamped.correctionTaskId = linkages.get(stamped.id);
          tier1Findings.push(stamped);
        }
      } catch (err) {
        tier1Findings.push(this.#metaFinding(check.name, runId, teamId, err));
      }
    }
    void tier1Status;

    // ── L3: scoped, task-boundary, ambiguity-gated adjudication ──────
    let l3Findings = [];
    let l3Status = 'skipped:not_invoked';
    if (llmEnabled) {
      const taskFindings = tier1Findings.filter(
        (f) => f.taskId === boundaryTaskId
          || (f.taskId === null && f.needsSemanticReview === true),
      );
      const silentSignificant = l3CheapEligible({ trigger, boundaryTo, boundaryTaskId })
        ? silentButSignificant({ snapshot, boundaryTaskId })
        : false;
      const flaggedFindings = taskFindings.filter((f) => f.needsSemanticReview === true);
      const l1SignalKind = flaggedFindings.length > 0 ? 'flagged' : 'silent_significant';
      // Phase-1 gate (cacheHasKey:false): cheap steps 1–4 + manual.
      // Periodic/non-submission/not-ambiguous skip here WITHOUT paying
      // the cache-key hash (design §3 gate-ordering discipline).
      const gate1 = l3Gate({
        trigger, boundaryTo, boundaryTaskId,
        l1FindingsForTask: taskFindings,
        cacheHasKey: false,
        silentSignificant,
      });
      if (gate1.action === 'skip') {
        l3Status = `skipped:${gate1.reason}`;
      } else {
        const spec = snapshot.spec ?? null;
        const d = snapshot.diffsByTask?.[boundaryTaskId] || null;
        const diffFiles = d && Array.isArray(d.changedFiles)
          ? d.changedFiles.map((file) => ({ file, content: typeof d.diff === 'string' ? d.diff : '' }))
          : [];
        const key = l3CacheKey({ diffFiles, spec, l1Findings: taskFindings, promptTemplate: L3_PROMPT_TEMPLATE, l1SignalKind });
        const teamCache = this.#l3VerdictCache.get(teamId) || new Map();
        // Phase-2: authoritative serve_cached vs invoke. manual already
        // short-circuited to invoke/manual_bypass in gate1 (its
        // cacheHasKey is irrelevant) — reuse gate1, don't re-call.
        const decision = gate1.reason === 'manual_bypass'
          ? gate1
          : l3Gate({
              trigger, boundaryTo, boundaryTaskId,
              l1FindingsForTask: taskFindings,
              cacheHasKey: teamCache.has(key),
              silentSignificant,
            });
        if (decision.action === 'serve_cached') {
          const cached = teamCache.get(key);
          l3Findings = cached.findings;
          l3Status = `served_cached:${cached.tier}`;
        } else {
          // Circuit breaker (config-tunable; observer-severity on trip).
          const capPerHour = typeof driftSettings.l3RateCapPerHour === 'number' ? driftSettings.l3RateCapPerHour : 30;
          const windowMs = 60 * 60 * 1000;
          const nowTs = this.now();
          const win = (this.#l3RateWindow.get(teamId) || []).filter((t) => nowTs - t < windowMs);
          if (win.length >= capPerHour) {
            this.#l3RateWindow.set(teamId, win);
            l3Findings = [this.#l3Meta(runId, teamId, 'observer', 'rate_cap',
              `L3 rate cap hit (${capPerHour}/h) — investigate the drift system; deterministic L1 findings still apply`)];
            l3Status = 'skipped:rate_cap';
          } else {
            let l1Signal;
            if (l1SignalKind === 'flagged') {
              l1Signal = { kind: 'flagged', findings: flaggedFindings };
            } else {
              const dEntry = snapshot.diffsByTask?.[boundaryTaskId] ?? null;
              const required = snapshot.spec?.structure?.required;
              const moduleEntries = Array.isArray(required)
                ? required.filter((e) => e && e.kind === 'module' && typeof e.evidence === 'string')
                : [];
              const isDeclared = (p) => moduleEntries.some((m) => isFileDeclaredByModule(p, m).declared);
              const matched = (Array.isArray(dEntry?.changedFiles) ? dEntry.changedFiles : [])
                .filter((cf) => isDeclared(cf));
              const CAP = 20;
              const truncated = matched.length > CAP;
              const changedLines = countDeclaredChangedLines(
                typeof dEntry?.diff === 'string' ? dEntry.diff : '', isDeclared,
              );
              l1Signal = {
                kind: 'silent_significant',
                declaredFiles: matched.slice(0, CAP),
                declaredFilesTotal: matched.length,
                declaredFilesTruncated: truncated,
                changedLines,
                note: 'L1 raised no semantic-review flag. This diff modifies '
                  + `spec-declared module surface (listed) by ${changedLines} lines. `
                  + 'Adjudicate whether the change semantically drifts from spec.json '
                  + '— L1 is structurally blind to behavior change within declared '
                  + 'structure.'
                  + (truncated ? ` (showing ${CAP} of ${matched.length} modified declared files)` : ''),
              };
            }
            const built = buildL3Packet({
              snapshot, boundaryTaskId, l1Signal,
              budgetBytes: driftSettings.l3PacketBudgetBytes,
            });
            if (built.overBudget) {
              l3Findings = [this.#l3Meta(runId, teamId, 'info', 'over_budget',
                `L3 packet over budget for task ${boundaryTaskId} (${built.bytes}B, ${built.fileCount} files) — semantic adjudication skipped; deterministic L1 findings still apply`)];
              l3Status = 'skipped:over_budget';
            } else {
              // Temp brief + HOME-isolated spawn — reuse the proven
              // mechanics from the deleted checkLlmSemantic verbatim.
              const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-l3-'));
              const briefPath = path.join(dir, 'brief.md');
              let isolateHome = false;
              try {
                fs.writeFileSync(briefPath, built.packet, 'utf-8');
                const realCreds = path.join(os.homedir(), '.claude', '.credentials.json');
                if (fs.existsSync(realCreds)) {
                  const cdir = path.join(dir, '.claude');
                  fs.mkdirSync(cdir, { recursive: true });
                  fs.copyFileSync(realCreds, path.join(cdir, '.credentials.json'));
                  isolateHome = true;
                }
              } catch { /* fall back to inline */ }
              try {
                const provider = resolveProvider({ teamConfig: snapshot.teamConfig, settings: this.settings, tier: 1 });
                const verdict = await this.l3JudgeImpl({
                  packet: built.packet,
                  provider: { cli: provider.cli, tier1: provider.model,
                    tier2: resolveProvider({ teamConfig: snapshot.teamConfig, settings: this.settings, tier: 2 }).model },
                  briefPath, cwd: dir, isolateHome, timeoutMs: 30_000,
                });
                l3Findings = verdict.findings.map((f) => ({
                  id: `f_l3_${teamId}_${boundaryTaskId}_${f.title}`.slice(0, 200),
                  runId, teamId, taskId: boundaryTaskId,
                  category: f.category, severity: f.severity,
                  checkName: 'check_llm_semantic',
                  kind: kindForCheck('check_llm_semantic'),
                  title: f.title, evidence: f.evidence,
                  expected: f.expected, actual: f.actual,
                  recommendedCorrection: f.recommendedCorrection,
                  autoFixable: false,
                }));
                const emit = [...l3Findings];
                if (l1SignalKind === 'silent_significant' && l3Findings.length === 0) {
                  emit.push(this.#l3Meta(runId, teamId, 'observer', 'silent_clean',
                    `Silent-significance check ran on task ${boundaryTaskId} `
                    + `(modified ${l1Signal.declaredFilesTotal} declared file(s) `
                    + `by ${l1Signal.changedLines} lines): clean.`));
                }
                teamCache.set(key, { findings: l3Findings, tier: verdict.tier });
                this.#l3VerdictCache.set(teamId, teamCache);
                this.#l3RateWindow.set(teamId, [...win, nowTs]);
                l3Status = `completed:${verdict.tier}`;
                l3Findings = emit;
              } catch (err) {
                // Failure → non-blocking meta, NOT cached (transient → retry next boundary).
                l3Findings = [this.#l3Meta(runId, teamId, 'medium', 'judge_failed',
                  err && err.message ? err.message : String(err))];
                l3Status = 'failed';
                this.#l3RateWindow.set(teamId, [...win, nowTs]);
              } finally {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
              }
            }
          }
        }
      }
    } else {
      l3Status = 'skipped:disabled';
    }

    // Combine all findings (unfiltered, so UI can render correction-in-progress badges).
    // Dedupe by finding id — last-write-wins. The LLM judge sometimes
    // returns multiple findings that hash to the same id (same title),
    // and the underlying SqliteDriftStore uses finding_id as primary
    // key, so duplicates would crash the whole run with UNIQUE
    // constraint failed. Dedup here keeps the run atomic; L3 findings
    // (which run later) win over L1 dups because they're appended after.
    const findingsById = new Map();
    for (const f of [...tier1Findings, ...l3Findings]) {
      if (f && typeof f.id === 'string') findingsById.set(f.id, f);
    }
    const allFindings = Array.from(findingsById.values());

    // Step C: Score only the active (non-corrected) findings for the final result.
    const activeFindings = allFindings.filter(f => !f.correctionTaskId);
    const { teamScore, status, perTaskScores, categoryScores } = scoreFindings(activeFindings);

    // Persist unfiltered allFindings so the correction_task_id is stored and UI can badge them.
    this.store.recordRun({
      runId,
      teamId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      categoryScores,
      perTaskScores,
      trigger,
      findings: allFindings,
    });
    // Mark this team's last computed+persisted run for the
    // periodic-trigger cooldown (set AFTER a successful recordRun so a
    // failed/partial run doesn't suppress the next periodic retry).
    this.#lastRunAt.set(teamId, this.now());

    if (typeof this.store.reapResolvedCorrections === 'function') {
      this.store.reapResolvedCorrections({ teamId, taskBoard: this.deps?.taskBoard });
    }

    // Step E: Broker notification for gate-mode constitution findings.
    // Proactively push a message to the team so the lead agent is alerted
    // without needing to poll drift_run. Only fires for gate-mode findings
    // (observe-mode surfaces in the UI drift stream without blocking;
    // messaging on every observe hit would spam the inbox on every run).
    const gateFindings = allFindings.filter(
      (f) => f.constitutionMode === 'gate' && !f.correctionTaskId,
    );
    if (gateFindings.length > 0 && this.deps?.broker
        && typeof this.deps.broker.appendMessage === 'function') {
      const titles = gateFindings.slice(0, 5).map((f) => `• ${f.title}`).join('\n');
      const extra = gateFindings.length > 5 ? `\n\u2026and ${gateFindings.length - 5} more.` : '';
      const text = [
        `[drift] ${gateFindings.length} gate-mode constitution violation${gateFindings.length === 1 ? '' : 's'} detected`,
        'These will block merge_ready \u2192 done until resolved:\n' + titles + extra,
        'Run `drift_run` to see full findings, or use `drift_correction_create` to open a remediation task.',
      ].join('\n\n');
      try {
        this.deps.broker.appendMessage({
          teamId,
          idempotencyKey: `drift-gate-notify-${runId}`,
          from: { kind: 'system', id: 'drift-engine' },
          to: { kind: 'team', teamId },
          kind: 'system',
          text,
          taskRefs: [],
          metadata: { source: 'drift_gate_violation', runId, findingCount: gateFindings.length },
        });
      } catch {
        // Non-fatal — notification failure must never abort the drift run.
      }
    }
    const history = this.store.listScoreHistory({ teamId, limit: 30 })
      .map((h) => ({ runId: h.runId, teamScore: h.teamScore, createdAt: h.createdAt }));

    return {
      runId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      findings: allFindings,
      categoryScores,
      perTaskScores,
      history,
      trigger,
      l3: { status: l3Status },
    };
  }

  /**
   * Reconstruct the most recent persisted DriftRunResult for a team
   * from the store (no checks, no buildSnapshot, no LLM). Returns null
   * if nothing is persisted yet (→ caller falls through and computes).
   * Shape mirrors #runDriftInner's return so the UI/caller can't tell
   * a cached periodic tick from a fresh one beyond the `cached` flag
   * and L3 being honestly reported as skipped:cooldown.
   */
  #cachedResult({ teamId }) {
    if (typeof this.store.listScoreHistory !== 'function'
        || typeof this.store.listLatestFindings !== 'function') return null;
    const hist = this.store.listScoreHistory({ teamId, limit: 30 });
    if (!Array.isArray(hist) || hist.length === 0) return null;
    const latest = hist[0]; // listScoreHistory orders created_at DESC
    return {
      runId: latest.runId,
      asOf: latest.createdAt,
      teamScore: latest.teamScore,
      status: latest.status,
      findings: this.store.listLatestFindings({ teamId }),
      categoryScores: latest.categoryScores ?? {},
      perTaskScores: latest.perTaskScores ?? {},
      history: hist.map((h) => ({
        runId: h.runId, teamScore: h.teamScore, createdAt: h.createdAt,
      })),
      trigger: latest.trigger,
      cached: true,
      l3: { status: 'skipped:cooldown' },
    };
  }

  #l3Meta(runId, teamId, severity, code, detail) {
    return {
      id: `f_l3_${code}_${teamId}`, runId, teamId, taskId: null,
      category: 'risk', severity,
      checkName: 'check_llm_semantic', kind: 'drift',
      title: `L3 ${code.replace(/_/g, ' ')}`,
      evidence: [detail], expected: 'L3 adjudication available',
      actual: detail,
      recommendedCorrection: code === 'rate_cap'
        ? 'Investigate the drift trigger/cache/ambiguity predicate for a loop.'
        : code === 'silent_clean'
          ? 'Informational — the silent-significance net inspected this task and found no drift; no action required.'
          : 'Transient/infrastructure — usually clears next boundary.',
      autoFixable: false,
    };
  }

  #metaFinding(checkName, runId, teamId, err) {
    return {
      id: `f_check_error_${teamId}_${checkName}`,
      runId, teamId, taskId: null,
      category: 'risk', severity: 'medium',
      checkName,
      kind: kindForCheck(checkName),
      title: `Check ${checkName} threw during evaluation`,
      evidence: [String(err && err.message ? err.message : err)],
      expected: 'check returns DriftFinding[]',
      actual: 'check threw an exception',
      recommendedCorrection: `Inspect ${checkName}'s implementation against the snapshot it received.`,
      autoFixable: false,
    };
  }
}
