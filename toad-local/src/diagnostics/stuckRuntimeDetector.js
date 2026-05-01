/**
 * Stuck/zombie runtime detector — checklist §13 follow-up.
 *
 * Pure function. Given the running runtime registry and a per-runtime "last
 * event seen at" map, returns the runtimes whose silence has exceeded the
 * configured threshold. The detector does not stop, restart, or otherwise
 * mutate state — operator-driven recovery is a separate concern.
 *
 * A runtime with no events at all uses its `startedAt` as the reference. The
 * comparison is strict (`silentMs > thresholdMs`) so a runtime that ticked
 * exactly at the threshold is not flagged.
 *
 * The output is sorted most-stuck-first so a UI can show the worst offenders
 * at the top.
 */

export const DEFAULT_THRESHOLD_MS = 15 * 60_000;

export function detectStuckRuntimes({
  runtimes,
  latestEventByRuntime,
  now,
  thresholdMs = DEFAULT_THRESHOLD_MS,
} = {}) {
  if (!Array.isArray(runtimes) || runtimes.length === 0) return [];
  if (!latestEventByRuntime || typeof latestEventByRuntime.get !== 'function') {
    latestEventByRuntime = new Map();
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];

  const stuck = [];
  for (const r of runtimes) {
    if (!r || r.status !== 'running') continue;
    const ref = latestEventByRuntime.get(r.runtimeId) || r.startedAt;
    if (typeof ref !== 'string') continue;
    const refMs = Date.parse(ref);
    if (!Number.isFinite(refMs)) continue;
    const silentMs = nowMs - refMs;
    if (silentMs > thresholdMs) {
      stuck.push({
        runtimeId: r.runtimeId,
        teamId: r.teamId,
        agentId: r.agentId,
        taskId: r.taskId || null,
        lastEventAt: ref,
        silentMs,
        thresholdMs,
      });
    }
  }
  stuck.sort((a, b) => b.silentMs - a.silentMs);
  return stuck;
}
