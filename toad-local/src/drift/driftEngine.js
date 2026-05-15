import { randomUUID } from 'node:crypto';
import { buildSnapshot } from './buildSnapshot.js';
import { scoreFindings } from './scoreFindings.js';
import { DETERMINISTIC_CHECKS } from './checks/index.js';
import { escalationGate } from './llm/escalationGate.js';

const DEFAULT_SETTINGS = Object.freeze({
  drift: Object.freeze({
    llmTierEnabled: true,
    escalationThreshold: 41,
    tier2CooldownMs: 300_000,
    tier2ScoreDelta: 10,
    tier1ModelOverride: null,
    tier2ModelOverride: null,
  }),
});

/**
 * Slice-2 orchestrator for drift evaluation.
 *
 *   1. buildSnapshot(teamId)
 *   2. Run tier-1 checks (deterministic + LLM tier 1 if enabled)
 *   3. Score tier-1 findings
 *   4. escalationGate decides whether to run tier 2
 *      - Skip if score below threshold OR cooldown active OR no material change
 *      - Escalate otherwise
 *   5. If escalate: run tier-2 checks; on failure record the failure but
 *      still update cooldown so we don't hammer a failing CLI
 *   6. Combine, score, persist, return DriftRunResult with `llm: {tier1, tier2}`
 *
 * Per-team mutex: only one runDrift({teamId}) is in flight at a time.
 * In-memory cooldown state: lost on sidecar restart (acceptable per spec
 * §4.3 — heuristic re-warms in <60s).
 *
 * Default `checks` is the slice-1 deterministic registry. Production
 * wiring (scripts/dev-api-server.mjs) opts into the slice-2 LLM tier
 * by passing `checks: ALL_CHECKS` from `./checks/index.js`. Tests that
 * want the LLM tier active inject their own check list.
 */
export class DriftEngine {
  #inflight = new Map();
  #tier2Cooldown = new Map(); // teamId -> { lastRunAt, lastScore }

  constructor({
    deps,
    store,
    checks = DETERMINISTIC_CHECKS,
    settings = DEFAULT_SETTINGS,
    now = Date.now,
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
  }

  async runDrift({ teamId, trigger = 'manual' } = {}) {
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new TypeError('runDrift: teamId required');
    }
    const existing = this.#inflight.get(teamId);
    if (existing) return existing;

    const promise = this.#runDriftInner({ teamId, trigger })
      .finally(() => this.#inflight.delete(teamId));
    this.#inflight.set(teamId, promise);
    return promise;
  }

  async #runDriftInner({ teamId, trigger }) {
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
        tier1Status: 'skipped:no_team_config',
        tier2Status: 'skipped:no_team_config',
      };
    }

    // Step A: Read correction linkages BEFORE building snapshot / running checks.
    const linkages = (typeof this.store.getCorrectionLinkages === 'function')
      ? this.store.getCorrectionLinkages({ teamId })
      : new Map();

    const driftSettings = this.settings.drift ?? DEFAULT_SETTINGS.drift;
    const compareAgainst = driftSettings.compareAgainst ?? 'foundry_docs';
    const snapshot = await buildSnapshot({
      teamId,
      deps: this.deps,
      compareAgainst,
    });
    const llmEnabled = driftSettings.llmTierEnabled !== false;

    // Partition checks by tier.
    const tier1Checks = this.checks.filter((c) => c.tier === 1);
    const tier2Checks = this.checks.filter((c) => c.tier === 2);

    // Run tier 1 (deterministic + LLM tier 1 if enabled).
    const tier1Findings = [];
    let tier1Status = 'completed';
    for (const check of tier1Checks) {
      // Skip LLM checks if the tier is disabled in settings.
      if (!llmEnabled && check.name.startsWith('check_llm_')) continue;
      try {
        const out = (await check.fn({ snapshot, settings: this.settings })) || [];
        for (const f of out) {
          const stamped = { ...f, runId, teamId };
          if (linkages.has(stamped.id)) stamped.correctionTaskId = linkages.get(stamped.id);
          tier1Findings.push(stamped);
        }
      } catch (err) {
        tier1Findings.push(this.#metaFinding(check.name, runId, teamId, err));
      }
    }

    // Score tier 1 to decide on escalation (filter out findings already being corrected).
    const tier1Score = scoreFindings(tier1Findings.filter(f => !f.correctionTaskId)).teamScore;

    // Decide tier 2.
    let tier2Findings = [];
    let tier2Status = 'skipped:below_threshold';

    if (!llmEnabled) {
      tier1Status = 'skipped:disabled';
      tier2Status = 'skipped:disabled';
    } else if (tier2Checks.length > 0) {
      const cooldown = this.#tier2Cooldown.get(teamId) ?? null;
      const verdict = escalationGate({
        tier1Score,
        threshold: driftSettings.escalationThreshold,
        cooldownMs: driftSettings.tier2CooldownMs,
        scoreDelta: driftSettings.tier2ScoreDelta,
        lastT2RunAt: cooldown?.lastRunAt ?? null,
        lastT2Score: cooldown?.lastScore ?? null,
        now: this.now(),
      });
      if (verdict.escalate) {
        try {
          for (const check of tier2Checks) {
            const out = (await check.fn({
              snapshot,
              settings: this.settings,
              tier1Findings,
            })) || [];
            for (const f of out) {
              const stamped = { ...f, runId, teamId };
              if (linkages.has(stamped.id)) stamped.correctionTaskId = linkages.get(stamped.id);
              tier2Findings.push(stamped);
            }
          }
          tier2Status = 'completed';
          this.#tier2Cooldown.set(teamId, {
            lastRunAt: this.now(),
            lastScore: tier1Score,
          });
        } catch (err) {
          tier2Status = { failed: err && err.message ? err.message : String(err) };
          // Still update cooldown so we don't hammer a failing CLI.
          this.#tier2Cooldown.set(teamId, {
            lastRunAt: this.now(),
            lastScore: tier1Score,
          });
        }
      } else if (verdict.reason === 'cooldown' || verdict.reason === 'no_material_change') {
        tier2Status = 'skipped:cooldown';
      } else {
        // verdict.reason === 'below_threshold' (or invalid_score, etc)
        tier2Status = 'skipped:below_threshold';
      }
    }

    // Combine all findings (unfiltered, so UI can render correction-in-progress badges).
    // Dedupe by finding id — last-write-wins. The LLM judge sometimes
    // returns multiple findings that hash to the same stableFindingId
    // (same checkName + category + taskId + title), and the underlying
    // SqliteDriftStore uses finding_id as primary key, so duplicates
    // would crash the whole run with UNIQUE constraint failed. Dedup
    // here keeps the run atomic; tier-2 findings (which run later) win
    // over tier-1 dups because they're appended after.
    const findingsById = new Map();
    for (const f of [...tier1Findings, ...tier2Findings]) {
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

    // Step D: Reap resolved corrections after persisting.
    if (typeof this.store.reapResolvedCorrections === 'function') {
      this.store.reapResolvedCorrections({ teamId, taskBoard: this.deps?.taskBoard });
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
      llm: {
        tier1: tier1Status,
        tier2: tier2Status,
      },
    };
  }

  #metaFinding(checkName, runId, teamId, err) {
    return {
      id: `f_check_error_${teamId}_${checkName}`,
      runId, teamId, taskId: null,
      category: 'risk', severity: 'medium',
      checkName,
      title: `Check ${checkName} threw during evaluation`,
      evidence: [String(err && err.message ? err.message : err)],
      expected: 'check returns DriftFinding[]',
      actual: 'check threw an exception',
      recommendedCorrection: `Inspect ${checkName}'s implementation against the snapshot it received.`,
      autoFixable: false,
    };
  }
}
