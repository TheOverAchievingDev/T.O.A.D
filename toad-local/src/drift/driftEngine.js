import { randomUUID } from 'node:crypto';
import { buildSnapshot } from './buildSnapshot.js';
import { scoreFindings } from './scoreFindings.js';
import { DETERMINISTIC_CHECKS } from './checks/index.js';

/**
 * Orchestrator for slice-1 drift evaluation.
 *
 *   1. buildSnapshot(teamId)
 *   2. run every registered check, collect findings
 *   3. stamp each finding with runId + teamId + scoreFindings()
 *   4. driftStore.recordRun (deletes prior, inserts new, prunes history)
 *   5. return DriftRunResult with last 30 history rows for the sparkline
 *
 * Per-team mutex: only one runDrift({teamId}) is in flight at a time.
 * Overlapping callers share the in-flight Promise (no double work).
 */
export class DriftEngine {
  #inflight = new Map(); // teamId -> Promise<DriftRunResult>

  constructor({ deps, store, checks = DETERMINISTIC_CHECKS } = {}) {
    if (!deps) throw new TypeError('DriftEngine: deps required');
    if (!store || typeof store.recordRun !== 'function') {
      throw new TypeError('DriftEngine: store with recordRun required');
    }
    this.deps = deps;
    this.store = store;
    this.checks = checks;
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
    const snapshot = await buildSnapshot({ teamId, deps: this.deps });

    const findings = [];
    for (const check of this.checks) {
      try {
        const out = (await check.fn({ snapshot })) || [];
        for (const f of out) {
          findings.push({
            ...f,
            runId,
            teamId,
          });
        }
      } catch (err) {
        findings.push({
          id: `f_check_error_${teamId}_${check.name}`,
          runId,
          teamId,
          taskId: null,
          category: 'risk',
          severity: 'medium',
          checkName: check.name,
          title: `Check ${check.name} threw during evaluation`,
          evidence: [String(err && err.message ? err.message : err)],
          expected: 'check returns DriftFinding[]',
          actual: 'check threw an exception',
          recommendedCorrection: `Inspect ${check.name}'s implementation against the snapshot it received.`,
          autoFixable: false,
        });
      }
    }

    const { teamScore, status, perTaskScores, categoryScores } = scoreFindings(findings);

    this.store.recordRun({
      runId,
      teamId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      categoryScores,
      perTaskScores,
      trigger,
      findings,
    });

    const history = this.store.listScoreHistory({ teamId, limit: 30 })
      .map((h) => ({ runId: h.runId, teamScore: h.teamScore, createdAt: h.createdAt }));

    return {
      runId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      findings,
      categoryScores,
      perTaskScores,
      history,
      trigger,
    };
  }
}
