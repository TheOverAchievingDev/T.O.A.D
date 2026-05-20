// The orchestrator (Readability Layer-2 P3b-1). All IO injected (the
// P3a reads/write, the runner, the limiter). Honest degradation: never
// persists a junk/empty summary; a failed span stays pending (the next
// run retries; P3a appendSummary first-write-wins makes that idempotent).
// NEVER throws — per-span failure is isolated into the report.
import { buildSummaryPrompt } from './buildSummaryPrompt.js';
import { resolveSummaryRoute } from './resolveSummaryRoute.js';

export async function summarizePendingSpans({
  teamId,
  listAwaiting,
  appendSummary,
  leadProviderId,
  settings,
  limiter,
  runImpl,
  cwd = undefined,
  isolateHome = false,
} = {}) {
  const report = { summarized: [], degraded: [], skippedRateLimited: 0 };
  if (typeof listAwaiting !== 'function' || typeof appendSummary !== 'function' || typeof runImpl !== 'function') {
    return report;
  }
  let spans;
  try {
    spans = listAwaiting({ teamId });
  } catch {
    return report;
  }
  if (!Array.isArray(spans)) return report;

  const sm = settings && typeof settings === 'object' ? settings.summarizer : null;
  const maxPerRun =
    sm && typeof sm === 'object' && typeof sm.maxPerRun === 'number'
      && Number.isFinite(sm.maxPerRun) && sm.maxPerRun > 0
      ? sm.maxPerRun
      : 10;
  const timeoutMs =
    sm && typeof sm === 'object' && typeof sm.timeoutMs === 'number'
      && Number.isFinite(sm.timeoutMs) && sm.timeoutMs > 0
      ? sm.timeoutMs
      : undefined;
  const capped = spans.slice(0, maxPerRun);
  const route = resolveSummaryRoute({ leadProviderId, settings });

  for (let i = 0; i < capped.length; i++) {
    const span = capped[i];
    if (!span || typeof span !== 'object') continue;
    if (!limiter || typeof limiter.tryAcquire !== 'function' || !limiter.tryAcquire(teamId)) {
      report.skippedRateLimited = capped.length - i;
      break;
    }
    const { systemPrompt, userPayload } = buildSummaryPrompt(span);
    let r;
    try {
      r = await runImpl({
        systemPrompt, userPayload, cli: route.cli, model: route.model,
        cwd, isolateHome, timeoutMs,
      });
    } catch {
      r = { ok: false, reason: 'spawn_failed' };
    }
    if (r && r.ok === true && typeof r.summaryText === 'string' && r.summaryText.length > 0) {
      try {
        appendSummary({
          spanId: span.spanId,
          teamId: span.teamId,
          runtimeId: span.runtimeId,
          agentId: span.agentId,
          sessionId: span.sessionId,
          summaryText: r.summaryText,
          model: route.model,
          cli: route.cli,
          spanStartedAt: span.startedAt,
          spanEndedAt: span.endedAt,
          rowCount: span.rowCount,
          tokens: span.tokens,
        });
        report.summarized.push({ spanId: span.spanId, model: route.model, cli: route.cli });
      } catch {
        report.degraded.push({ spanId: span.spanId, reason: 'persist_failed' });
      }
    } else {
      const reason = (r && r.reason) || (r && r.ok === true ? 'empty_output' : 'spawn_failed');
      report.degraded.push({ spanId: span.spanId, reason });
    }
  }
  return report;
}
