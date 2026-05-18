// SP1a Stage 2 — the {get,set,clear} session-id store CodexExecAdapter
// uses for first-turn-vs-resume dispatch, backed by the runtime
// registry's nullable cli_session_id column. Total / never-throws:
// session persistence is best-effort continuity, never a turn-blocker
// (a failed read just degrades to a fresh first turn).
export function makeRuntimeRegistrySessionStore(registry) {
  return {
    get(runtimeId) {
      try {
        const row = registry.getRuntime(runtimeId);
        return row && typeof row.cliSessionId === 'string' && row.cliSessionId.length > 0
          ? row.cliSessionId
          : null;
      } catch {
        return null;
      }
    },
    set(runtimeId, cliSessionId) {
      try { registry.setRuntimeCliSessionId({ runtimeId, cliSessionId }); } catch { /* best effort */ }
    },
    clear(runtimeId) {
      try { registry.setRuntimeCliSessionId({ runtimeId, cliSessionId: null }); } catch { /* best effort */ }
    },
  };
}
