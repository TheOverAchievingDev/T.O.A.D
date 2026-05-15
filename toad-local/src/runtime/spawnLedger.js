import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cross-project PID ledger for Symphony-spawned child processes.
 *
 * Why this exists: each Symphony project has its own SQLite DB and its
 * own runtime_instances table. When the operator switches projects,
 * Tauri kills the old sidecar (Windows child.kill() = TerminateProcess,
 * which does NOT cascade to grandchildren) and spawns a new sidecar
 * against a different DB. The new DB doesn't know about Project A's
 * spawned claude.exe processes, so its reconcileOrphans-on-boot can't
 * touch them. Across a handful of project switches you accumulate
 * tens of stranded claude.exe processes — each holding a live Claude
 * session, each potentially making keep-alive pings against the
 * operator's plan quota.
 *
 * The fix: every spawn records its PID in a SHARED location any
 * Symphony sidecar can read, regardless of which project it's
 * tied to. The next sidecar boot (any project) sweeps the ledger
 * and kills any still-alive Symphony-spawned PIDs that no current
 * sidecar owns. Cross-project orphans get caught the next time
 * the operator opens Symphony.
 *
 * Storage: per-PID JSON files under `~/.symphony/active-pids/`.
 * One file per spawned process. File-per-PID rather than a single
 * shared JSON avoids race conditions when multiple sidecars run
 * simultaneously (e.g. during HMR reloads) — each spawn creates a
 * fresh file, each stop deletes a single file, no read-modify-write.
 *
 * Failure mode: every operation is best-effort. The ledger is a
 * cleanup hint, not a source of truth. If the FS write fails, the
 * spawn proceeds anyway; if a kill fails the entry stays and the
 * next sweep tries again. The OS-level invariant (claude.exe is
 * just a normal process whose parent died) holds regardless.
 */

const LEDGER_DIR = process.env.SYMPHONY_PID_LEDGER_DIR
  || path.join(os.homedir(), '.symphony', 'active-pids');

function ensureDir() {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Record that we just spawned a process. Best-effort — the spawn
 * succeeded regardless of whether we managed to write the ledger.
 *
 * @param {object} input
 * @param {number} input.pid           — OS process id (required).
 * @param {string} input.command       — resolved command path (informational).
 * @param {string} [input.runtimeId]   — Symphony runtime id, for diagnostics.
 * @param {string} [input.sessionId]   — sidecar session id (so a future
 *                                       sweep can prefer killing pids from
 *                                       other sessions vs the current one).
 */
export function recordSpawn({ pid, command, runtimeId = null, sessionId = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!ensureDir()) return false;
  const entry = {
    pid,
    command: typeof command === 'string' ? command : '',
    runtimeId,
    sessionId,
    recordedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(
      path.join(LEDGER_DIR, `${pid}.json`),
      JSON.stringify(entry, null, 2),
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the ledger entry for a PID. Called on graceful stop or
 * after we observe an exit. If the entry doesn't exist (already
 * removed, or never recorded), this is a no-op.
 */
export function removeSpawn(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    fs.unlinkSync(path.join(LEDGER_DIR, `${pid}.json`));
    return true;
  } catch {
    // ENOENT is the common case; other errors are best-effort.
    return false;
  }
}

/**
 * Check whether a PID is still alive without disturbing it.
 *
 * On POSIX, signal 0 is the canonical "does this PID exist?" probe.
 * On Windows, Node's process.kill with signal 0 behaves the same way
 * (returns true if the PID can be opened with PROCESS_QUERY_INFORMATION).
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH (process not found) is the common dead case. EPERM means
    // it's alive but we lack permission to signal it — treat that as
    // alive so we attempt the actual kill (which may also fail).
    return err && err.code === 'EPERM';
  }
}

/**
 * Sweep the ledger: read every entry, kill any whose PID is still
 * alive AND is not in our current session, then delete the entry.
 *
 * @param {object} [input]
 * @param {string} [input.currentSessionId] — if set, entries with this
 *                                            sessionId are LEFT ALONE
 *                                            (they belong to the calling
 *                                            sidecar and are tracked by
 *                                            it via the supervisor map).
 *                                            On first boot, pass nothing
 *                                            and everything gets swept.
 * @returns {{ swept: number, killed: number, notFound: number, errors: string[] }}
 */
export function sweepZombies({ currentSessionId = null } = {}) {
  const result = { swept: 0, killed: 0, notFound: 0, errors: [] };
  let entries = [];
  try {
    entries = fs.readdirSync(LEDGER_DIR).filter((name) => name.endsWith('.json'));
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      result.errors.push(`readdir failed: ${err.message || err}`);
    }
    return result;
  }
  for (const file of entries) {
    const filePath = path.join(LEDGER_DIR, file);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // Corrupt entry — delete it and move on.
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      continue;
    }
    // Skip entries that belong to the current sidecar session — they
    // represent runtimes the calling sidecar OWNS and shouldn't kill
    // out from under itself.
    if (currentSessionId && entry.sessionId === currentSessionId) continue;
    result.swept += 1;
    if (typeof entry.pid !== 'number' || entry.pid <= 0) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      continue;
    }
    if (!isAlive(entry.pid)) {
      result.notFound += 1;
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      continue;
    }
    // Live PID we don't own. Kill it.
    try {
      process.kill(entry.pid, 'SIGKILL');
      result.killed += 1;
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    } catch (err) {
      // ESRCH between isAlive check and kill — fine, treat as not-found.
      if (err && err.code === 'ESRCH') {
        result.notFound += 1;
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      } else {
        result.errors.push(`kill ${entry.pid} failed: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }
  return result;
}

/**
 * List ledger entries — exposed for diagnostics + tests, not used at
 * runtime by the spawn / stop paths.
 */
export function listLedger() {
  let entries = [];
  try {
    entries = fs.readdirSync(LEDGER_DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const file of entries) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, file), 'utf-8')));
    } catch {
      // skip corrupt
    }
  }
  return out;
}
