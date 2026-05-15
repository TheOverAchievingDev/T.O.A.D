import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';
import { FoundryRuntime } from '../src/foundry/foundryRuntime.js';
import { SqliteDriftStore } from '../src/drift/driftStore.js';
import { DriftEngine } from '../src/drift/driftEngine.js';
import { ALL_CHECKS } from '../src/drift/checks/index.js';
import { SqlitePluginJobs } from '../src/plugins/pluginJobs.js';
import { SqlitePluginResources } from '../src/plugins/pluginResources.js';
import { DriftMonitor } from '../src/drift/driftMonitor.js';
import { sweepZombies } from '../src/runtime/spawnLedger.js';

// Project resolution:
//   - TOAD_PROJECT_CWD env (set by the Tauri shell when the user picks a
//     folder) wins. An empty string is meaningful — it means "the user
//     hasn't picked a project yet" and we start in degraded "no project
//     loaded" mode.
//   - When the env var is *unset* (e.g. running `npm run api:dev` directly
//     from a development checkout), fall back to process.cwd() so
//     contributors can keep working without the Tauri shell.
const envCwd = process.env.TOAD_PROJECT_CWD;
const projectCwd =
  typeof envCwd === 'string'
    ? (envCwd.length > 0 ? envCwd : null)
    : process.cwd();
const dbPath =
  process.env.TOAD_DB_PATH ||
  (projectCwd ? join(projectCwd, '.toad', 'toad.db') : ':memory:');

// Symphony's own install dir — `toad-local/` when running this script from
// the dev checkout, or the bundled app resources dir in a packaged build.
// Derived from this file's own URL: `<installDir>/scripts/dev-api-server.mjs`
// → resolve('..') from the script's dir gives us `<installDir>`.
//
// Threaded to LocalToadRuntime so team_launch can write deny rules naming
// this dir into the workspace's `.claude/settings.local.json` (PROJECT.md §4).
// TOAD_INSTALL_DIR env var overrides for non-standard layouts (e.g. CI).
const installDir =
  (typeof process.env.TOAD_INSTALL_DIR === 'string' && process.env.TOAD_INSTALL_DIR.length > 0)
    ? process.env.TOAD_INSTALL_DIR
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const runtime = new LocalToadRuntime({ projectCwd, dbPath, installDir });

// §-drift wiring — Task 16:
// LocalToadRuntime constructs db / taskBoard / eventLog / foundryStore /
// worktreeManager / runtimeRegistry internally, so we reach into the
// already-built instance to assemble the drift store + engine + monitor.
// The facade reads `driftEngine` lazily at command-dispatch time, so
// late-injecting it onto runtime.toolFacade is sufficient for drift_run
// to work in production.
const driftDb =
  runtime.runtimeRegistry?.db ||
  runtime.eventLog?.db ||
  runtime.taskBoard?.db ||
  null;
let driftMonitor = null;
let foundryRuntime = null;
if (driftDb) {
  const driftStore = new SqliteDriftStore({ db: driftDb });
  // Read drift settings from the project's settings store at startup.
  // readEffective() is async, so we await it once here and pass the
  // resolved snapshot to the engine. Falls back to engine's DEFAULT_SETTINGS
  // when the store is unavailable or read fails.
  let driftSettings;
  if (typeof runtime.settingsStore?.readEffective === 'function') {
    try {
      const all = await runtime.settingsStore.readEffective();
      driftSettings = all && typeof all === 'object' ? all : undefined;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[drift] settingsStore.readEffective failed:', err && err.message ? err.message : err);
      driftSettings = undefined;
    }
  }

  const driftEngine = new DriftEngine({
    deps: {
      taskBoard: runtime.taskBoard,
      eventLog: runtime.eventLog,
      foundryStore: runtime.foundryStore,
      worktreeManager: runtime.worktreeManager,
      teamConfigRegistry: runtime.teamConfigRegistry,
      // projectCwd lets buildSnapshot's getRecentCommits / readProjectDocs
      // operate against the actual project tree when compareAgainst is
      // 'current_state'. Null in :memory: mode (no project linked).
      projectCwd,
      // diffComputer not constructed in LocalToadRuntime — buildSnapshot
      // tolerates missing optional deps.
    },
    store: driftStore,
    // Slice 2: opt INTO the LLM tier by passing ALL_CHECKS (deterministic
    // + LLM tier-1 + LLM tier-2). Engine's default is DETERMINISTIC_CHECKS,
    // so unit tests stay isolated from real CLI spawns.
    checks: ALL_CHECKS,
    settings: driftSettings,
  });
  if (runtime.toolFacade) {
    runtime.toolFacade.driftEngine = driftEngine;
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const foundryInstructionsPath = join(
    __dirname, '..', 'src', 'foundry', 'foundryInstructions.txt',
  );
  foundryRuntime = new FoundryRuntime({
    instructionsPath: foundryInstructionsPath,
    projectCwdResolver: () => runtime.toolFacade?.projectCwd || process.cwd(),
  });
  if (runtime.toolFacade) {
    runtime.toolFacade.foundryRuntime = foundryRuntime;
  }

  driftMonitor = new DriftMonitor({
    engine: driftEngine,
    listLiveTeams: () => {
      const runtimes = runtime.runtimeRegistry?.listRuntimes?.() ?? [];
      const liveTeams = new Set(
        runtimes
          .filter((r) => r && (r.status === 'running' || r.status === 'live' || r.status === 'starting'))
          .map((r) => r.teamId)
          .filter((tid) => typeof tid === 'string' && tid.length > 0)
      );
      return Array.from(liveTeams);
    },
  });
  driftMonitor.start();
  // Off-cycle drift triggers on lifecycle transitions. taskBoard now
  // exposes a subscribe(fn) API (added alongside this wiring) — every
  // successful appendEvent fires registered subscribers with the event
  // payload. DriftMonitor.notifyTaskEvent only acts on
  // task.status_changed → review/testing/merge_ready/done; everything
  // else is a no-op, so the subscription is cheap.
  if (typeof runtime.taskBoard?.subscribe === 'function') {
    runtime.taskBoard.subscribe((event) => {
      driftMonitor.notifyTaskEvent({
        teamId: event.teamId,
        eventType: event.eventType,
        payload: event.payload,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[drift] notifyTaskEvent failed', err && err.message ? err.message : err);
      });
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn('[drift] taskBoard does not support subscribe() — only the 60s tick will drive drift');
  }
} else {
  // eslint-disable-next-line no-console
  console.warn('[drift] no SQLite handle available on runtime — drift engine disabled');
}

let pluginJobs = null;
let pluginResources = null;
if (driftDb) {
  pluginJobs = new SqlitePluginJobs({ db: driftDb });
  pluginResources = new SqlitePluginResources({ db: driftDb });
}

if (runtime.toolFacade) {
  runtime.toolFacade.pluginJobs = pluginJobs;
  runtime.toolFacade.pluginResources = pluginResources;
}

await runtime.start();

// Cross-project zombie sweep. Each Symphony spawn records its PID in
// ~/.symphony/active-pids/. On every sidecar boot, we kill any PIDs
// still alive that don't belong to the current sidecar session —
// catches the case where a previous sidecar was killed without clean
// shutdown (Tauri project-switch respawn, taskkill on the API window,
// crash). Without this, claude.exe processes accumulate across project
// switches because each project's runtime_instances table only knows
// about its own spawns. Operator reported 15 stranded claude.exe
// processes on 2026-05-15 — this sweep is the antidote.
//
// Runs AFTER runtime.start() (which does per-project reconcileOrphans)
// so the in-DB orphan path still handles same-project crash recovery
// and we layer the cross-project sweep on top.
try {
  const swept = sweepZombies({ currentSessionId: runtime.supervisor?.sessionId });
  if (swept.killed > 0 || swept.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[runtime] zombie sweep: killed ${swept.killed}, not-found ${swept.notFound}, errors ${swept.errors.length}`,
    );
    for (const err of swept.errors) {
      // eslint-disable-next-line no-console
      console.warn(`[runtime] zombie sweep: ${err}`);
    }
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn(`[runtime] zombie sweep failed: ${err?.message || err}`);
}

const port = process.env.TOAD_API_PORT || '3001';
console.log(`Symphony AI API listening on http://127.0.0.1:${port}`);
if (projectCwd) {
  console.log(`Symphony AI project at ${projectCwd}`);
} else {
  console.log('Symphony AI running with no project loaded — pick a folder in the UI to begin.');
}
console.log(`Symphony AI database at ${dbPath}`);
console.log(`Symphony AI install dir at ${installDir} (agents denied access via .claude/settings.local.json on team_launch)`);

async function shutdown() {
  if (driftMonitor && typeof driftMonitor.stop === 'function') {
    driftMonitor.stop();
  }
  await runtime.close();
  process.exit(0);
}

const closeFoundryRuntime = () => { try { if (foundryRuntime) void foundryRuntime.closeAll(); } catch { /* best effort */ } };
process.on('SIGINT', shutdown);
process.on('SIGINT', closeFoundryRuntime);
process.on('SIGTERM', shutdown);
process.on('SIGTERM', closeFoundryRuntime);
process.on('exit', closeFoundryRuntime);

process.stdin.resume();
