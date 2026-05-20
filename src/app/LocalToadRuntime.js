import { SqliteBroker } from '../broker/sqliteBroker.js';
import { SqliteApprovalBroker } from '../approval/sqliteApprovalBroker.js';
import { DeliveryWorker } from '../delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../delivery/runtimeDirectory.js';
import { LocalReadModel } from '../read/LocalReadModel.js';
import { CompactionHandler } from '../runtime/CompactionHandler.js';
import { CompactionTrigger, resolveThresholdFromSettings } from '../runtime/compactionTrigger/index.js';
import { getContextUsage } from '../runtime/contextUsage/index.js';
import { RuntimeEventBus } from '../runtime/RuntimeEventBus.js';
import { RuntimeEventIngestor } from '../runtime/RuntimeEventIngestor.js';
import { RuntimeSupervisor, resolveWindowsCommand } from '../runtime/RuntimeSupervisor.js';
import { SqliteRuntimeEventLog } from '../runtime/sqliteRuntimeEventLog.js';
import { SqliteNarrationStore } from '../runtime/sqliteNarrationStore.js';
import { SqliteSpanSummaryStore } from '../runtime/sqliteSpanSummaryStore.js';
import { SqliteRuntimeRegistry } from '../runtime/sqliteRuntimeRegistry.js';
import { SqliteTaskBoard } from '../task/sqliteTaskBoard.js';
import { SqliteTeamConfigRegistry } from '../team/sqliteTeamConfigRegistry.js';
import { SqlitePluginJobs } from '../plugins/pluginJobs.js';
import { LocalToolFacade } from '../tools/localToolFacade.js';
import { WorktreeManager } from '../task/worktreeManager.js';
import { checkForConflicts } from '../task/mergeChecker.js';
import { integrate as integrateMerge } from '../task/mergeIntegrator.js';
import { buildRemoteMergePolicy } from '../task/buildRemoteMergePolicy.js';
import { ApiServer } from '../transport/apiServer.js';
import { SideEffectLog } from '../delivery/sideEffectLog.js';
import { resolveApiToken } from '../runtime/resolveApiToken.js';
import { shouldInjectToadMcpConfig, withClaudeMcpPermissions, writeToadMcpConfig } from '../mcp/toadMcpConfig.js';
import { buildScrubbedAgentEnv, assertWorkspaceIsolated } from '../runtime/claudeSettingsWriter.js';
import { loadRiskPolicy } from '../policy/loadRiskPolicy.js';
import { RiskPolicyStore } from '../policy/riskPolicyStore.js';
import { SettingsStore } from '../settings/settingsStore.js';
import { StuckRuntimeMonitor } from '../diagnostics/stuckRuntimeMonitor.js';
import { SqliteFoundryStore } from '../foundry/sqliteFoundryStore.js';
import { claudeAuthPreflight, defaultRefreshOnce } from '../runtime/authPreflight/index.js';
import { readClaudeCredsStatusForPreflight } from '../providers/providerAuth.js';
import { probeClaudeUsage } from '../providers/claudeUsageProbe.js';
import { probeCodexUsage } from '../providers/codexUsageProbe.js';
import { probeGeminiUsage } from '../providers/geminiUsageProbe.js';
import { providerForCommand } from '../team/providerCommands.js';
import { getAuthStatus as defaultGetAuthStatus } from '../providers/providerAuth.js';
import { createAdapterForProvider } from '../runtime/adapterForProvider.js';
import { makeRuntimeRegistrySessionStore } from '../runtime/codex/runtimeRegistrySessionStore.js';
import { writeCodexProjectConfig, writeAgentsMd } from '../mcp/codexMcpConfig.js';
import { writeGeminiProjectConfig, writeGeminiMd } from '../mcp/geminiMcpConfig.js';
import { writeOpencodeProjectConfig, writeOpencodeInstructions } from '../mcp/opencodeMcpConfig.js';
import { computeUndeliveredSessionMessages } from '../runtime/codex/reconcileSessionInboxes.js';
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Returns true when `command` names the Claude CLI binary (bare name or full
 * path), tolerating Windows `.cmd`/`.exe`/`.bat` extensions.
 */
function isClaudeCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  const base = command.split(/[\\/]/).pop().toLowerCase();
  return base === 'claude' || base === 'claude.cmd' || base === 'claude.exe' || base === 'claude.bat';
}

function requireLaunchCwd(input) {
  return (input && typeof input.cwd === 'string' && input.cwd.length > 0) ? input.cwd : process.cwd();
}

/** Global foundry DB lives in the user's home directory, NOT inside any
 *  project. Foundry chat sessions need to outlive `switch_project` calls
 *  so the user can plan a project in Foundry, then materialize it into a
 *  newly-picked folder without losing their session. */
function defaultFoundryDbPath() {
  const envOverride = process.env.SYMPHONY_FOUNDRY_DB_PATH || process.env.TOAD_FOUNDRY_DB_PATH;
  if (typeof envOverride === 'string' && envOverride.length > 0) return envOverride;
  return path.join(os.homedir(), '.symphony', 'foundry.db');
}

export class LocalToadRuntime {
  // Auth-preflight private state (T7). Declared here so the JS engine
  // recognises them as private fields before the constructor body runs.
  #authPreflightEnabled = false;
  #authPreflightMutex = Promise.resolve();
  #authRelaunchState = new Map();

  constructor({
    broker = null,
    taskBoard = null,
    approvalBroker = null,
    runtimeDirectory = new RuntimeDirectory(),
    runtimeRegistry = null,
    eventLog = null,
    narrationStore = null,
    spanSummaryStore = null,
    teamConfigRegistry = null,
    foundryStore = null,
    adapters = new Map(),
    projectCwd = null,
    /**
     * Symphony's own install directory — `toad-local/` when running from a
     * dev checkout, or the bundled app resources dir in a packaged build.
     * Used by the team_launch flow to write `permissions.deny` rules into
     * `{projectCwd}/.claude/settings.local.json` so spawned agents can't
     * Read/Edit/Write/Grep/Glob/Bash their way into Symphony's own source.
     *
     * Per PROJECT.md §4: the agent isolation contract. Native CLI tools
     * stay enabled (with --dangerously-skip-permissions for autonomy);
     * we constrain them via deny patterns naming forbidden paths.
     *
     * When null, the team_launch flow skips isolation rule writing — this
     * keeps unit tests with no install context clean.
     */
    installDir = null,
    spawnProcess,
    createAdapter,
    getCodexAuthStatusImpl,
    getProviderAuthStatusImpl,
    supervisor = null,
    deliveryWorker = null,
    toolFacade = null,
    worktreeManager = null,
    mergeChecker = null,
    eventIngestor = null,
    readModel = null,
    port = process.env.TOAD_API_PORT ? parseInt(process.env.TOAD_API_PORT, 10) : 3001,
    sideEffectRetentionDays = parseRetentionDaysEnv(process.env.TOAD_SIDE_EFFECT_RETENTION_DAYS),
    dbPath = ':memory:',
    apiToken = null,
    uiStaticDir = process.env.TOAD_UI_STATIC_DIR ?? null,
    githubFetch = null,
    githubClientId = null,
    providerAuthSpawn = null,
    providerAuthSpawnSync = null,
    providerAuthReadFile = null,
    providerAuthStat = null,
    // Auth-preflight injectable deps (T7). Real defaults wired lazily
    // (see #resolveRefreshOnce) so hermetic tests never touch real I/O.
    // The creds reader is readClaudeCredsStatusForPreflight (NOT raw
    // getAuthStatus): it normalizes getAuthStatus's tokenStatus-less
    // early-returns (ENOENT / unreadable / unparseable creds) to
    // UNRECOVERABLE so the pure core fails closed instead of pointlessly
    // spawning `claude --print` and proceeding+warn on a doomed state.
    claudeAuthPreflightImpl = claudeAuthPreflight,
    refreshOnceImpl = null,
    readClaudeCredsStatus = () => readClaudeCredsStatusForPreflight(),
    stuckMonitor = null,
    stuckMonitorIntervalMs = parseIntervalEnv(process.env.TOAD_STUCK_MONITOR_INTERVAL_MS),
    stuckMonitorThresholdMs = parseIntervalEnv(process.env.TOAD_STUCK_MONITOR_THRESHOLD_MS),
    codexTurnTimeoutMs = undefined,
  } = {}) {
    this.broker = broker || new SqliteBroker({ filePath: dbPath });
    this.taskBoard = taskBoard || new SqliteTaskBoard({ filePath: dbPath });
    this.approvalBroker = approvalBroker || new SqliteApprovalBroker({ filePath: dbPath });
    this.runtimeDirectory = runtimeDirectory;
    this.runtimeRegistry = runtimeRegistry || new SqliteRuntimeRegistry({ filePath: dbPath });
    this.eventLog = eventLog || new SqliteRuntimeEventLog({ filePath: dbPath });
    this.narrationStore = narrationStore || new SqliteNarrationStore({ filePath: dbPath });
    this.spanSummaryStore = spanSummaryStore || new SqliteSpanSummaryStore({ filePath: dbPath });
    this.teamConfigRegistry = teamConfigRegistry || new SqliteTeamConfigRegistry({ filePath: dbPath });
    this.pluginJobs = new SqlitePluginJobs({ filePath: dbPath });
    // Foundry sessions are global (live in ~/.symphony/foundry.db) so they
    // survive `switch_project` calls — the user can plan a project in
    // Foundry, then materialize it into a freshly-picked folder.
    this.foundryStore = foundryStore || new SqliteFoundryStore({ filePath: defaultFoundryDbPath() });
    this.adapters = adapters;
    this.projectCwd = projectCwd;
    this.installDir = installDir;
    // Auth-preflight deps (T7). Stored here so tests can inject fakes;
    // the real defaults are never constructed in hermetic test suites.
    this.claudeAuthPreflightImpl = claudeAuthPreflightImpl;
    this.refreshOnceImpl = refreshOnceImpl;
    this.readClaudeCredsStatus = readClaudeCredsStatus;
    this.getCodexAuthStatusImpl = typeof getCodexAuthStatusImpl === 'function'
      ? getCodexAuthStatusImpl
      : ((opts) => defaultGetAuthStatus(opts));
    this.getProviderAuthStatusImpl = typeof getProviderAuthStatusImpl === 'function'
      ? getProviderAuthStatusImpl
      : ((opts) => defaultGetAuthStatus(opts));
    // CONTROLLER-RATIFIED (T7 grounding, §8d — hermetic-test +
    // inert/over-gate epicenter). `#authPreflightEnabled` is true iff
    // projectCwd is a non-empty string — the VERBATIM enable idiom
    // every other production-only collaborator in this file already
    // uses (worktreeManager / mergeChecker / mergeIntegrator /
    // riskPolicy / remoteMergePolicy / riskPolicyStore). Rationale:
    //   • Non-inert in production — EVERY real agent-launch path sets
    //     projectCwd: scripts/dev-api-server.mjs ({projectCwd,
    //     installDir}) and src/mcp/stdioRuntime.js createMcpRuntimeFromEnv
    //     ({projectCwd: TOAD_PROJECT_CWD}). Spec §4.3's "run preflight
    //     for every anthropic/claude launch" is fully preserved (in
    //     production projectCwd is always set) — spec-faithful.
    //   • Hermetic for the existing suite — test/localToadRuntime.test.js
    //     constructs WITHOUT projectCwd and launches command:'claude'
    //     12/12 times; this gate makes it a true no-op (no real
    //     getAuthStatus / no real `claude --print` in unit tests).
    this.#authPreflightEnabled = typeof projectCwd === 'string' && projectCwd.length > 0;
    // Serialize all Claude preflights in-process: concurrent team
    // launches must not race `claude --print` on the single
    // ~/.claude/.credentials.json (partial read / duplicate refresh).
    // The second waiter re-reads status first, so a burst refreshes
    // at most once. (Design §4.3.)
    this.#authPreflightMutex = Promise.resolve();
    this.#authRelaunchState = new Map();
    this.dbPath = dbPath;
    this.sideEffectRetentionDays = sideEffectRetentionDays;
    this.codexTurnTimeoutMs = Number.isFinite(codexTurnTimeoutMs) && codexTurnTimeoutMs > 0
      ? codexTurnTimeoutMs
      : undefined; // undefined ⇒ adapter's 30-min default
    this.supervisor =
      supervisor ||
      new RuntimeSupervisor({
        runtimeDirectory,
        runtimeRegistry: this.runtimeRegistry,
        ...(spawnProcess ? { spawnProcess } : {}),
        createAdapter: createAdapter || ((adapterArgs) => createAdapterForProvider({
          ...adapterArgs,
          sessionStore: this.runtimeRegistry
            ? makeRuntimeRegistrySessionStore(this.runtimeRegistry)
            : undefined,
          turnTimeoutMs: this.codexTurnTimeoutMs,
        })),
      });
    this.deliveryWorker =
      deliveryWorker ||
      new DeliveryWorker({
        broker: this.broker,
        runtimeDirectory,
        adapters,
      });
    this.readModel =
      readModel ||
      new LocalReadModel({
        broker: this.broker,
        taskBoard: this.taskBoard,
        runtimeRegistry: this.runtimeRegistry,
        eventLog: this.eventLog,
        narrationStore: this.narrationStore,
        spanSummaryStore: this.spanSummaryStore,
        approvalBroker: this.approvalBroker,
      });
    // Worktree manager: only enabled when projectCwd is set so tests with
    // ephemeral cwds can opt in explicitly.
    this.worktreeManager =
      worktreeManager
      || (typeof projectCwd === 'string' && projectCwd.length > 0
        ? new WorktreeManager({ projectCwd })
        : null);
    // Merge checker: paired with worktree manager. Same enable rule.
    this.mergeChecker =
      mergeChecker
      || (typeof projectCwd === 'string' && projectCwd.length > 0
        ? { checkForConflicts }
        : null);
    // Merge integrator (§19 slice 2): performs the real merge on done.
    // Same enable rule — needs projectCwd to know which repo to integrate in.
    this.mergeIntegrator =
      typeof projectCwd === 'string' && projectCwd.length > 0
        ? { integrate: (input) => integrateMerge({ ...input, projectCwd }) }
        : null;
    // §14: load `.toad/risk-policy.json` once at construction. Null when
    // missing/unparseable — the facade's classifier hook is a no-op in that
    // case (back-compat for projects that never opt in).
    this.riskPolicy =
      typeof projectCwd === 'string' && projectCwd.length > 0
        ? loadRiskPolicy({ projectCwd })
        : null;
    this.settingsStore = new SettingsStore({ projectCwd });
    // §19 follow-up: branch-protection gate. When projectCwd is set we wire
    // the policy collaborator together — the facade calls `evaluate()` on
    // merge_ready → done. The collaborator always returns an `{ allow,
    // reason }` verdict (never throws), and short-circuits to allow when
    // origin isn't on github.com or no token is stored.
    this.remoteMergePolicy =
      typeof projectCwd === 'string' && projectCwd.length > 0
        ? buildRemoteMergePolicy({
            projectCwd,
            settingsStore: this.settingsStore,
            githubFetch,
          })
        : null;
    this.riskPolicyStore =
      typeof projectCwd === 'string' && projectCwd.length > 0
        ? new RiskPolicyStore({ projectCwd })
        : null;
    this.toolFacade =
      toolFacade ||
      new LocalToolFacade({
        broker: this.broker,
        taskBoard: this.taskBoard,
        runtimeRegistry: this.runtimeRegistry,
        approvalBroker: this.approvalBroker,
        deliveryWorker: this.deliveryWorker,
        adapters,
        projectCwd,
        installDir,
        readModel: this.readModel,
        launchAgent: (input) => this.launchAgent(input),
        stopAgent: ({ runtimeId, signal } = {}) =>
          this.stopAgent(runtimeId, signal ? { signal } : undefined),
        teamConfigRegistry: this.teamConfigRegistry,
        pluginJobs: this.pluginJobs,
        foundryStore: this.foundryStore,
        dbPath,
        eventLog: this.eventLog,
        worktreeManager: this.worktreeManager,
        mergeChecker: this.mergeChecker,
        mergeIntegrator: this.mergeIntegrator,
        remoteMergePolicy: this.remoteMergePolicy,
        riskPolicy: this.riskPolicy,
        settingsStore: this.settingsStore,
        riskPolicyStore: this.riskPolicyStore,
        githubFetch,
        githubClientId,
        providerAuthSpawn,
        providerAuthSpawnSync,
        providerAuthReadFile,
        providerAuthStat,
        claudeUsageProbe: probeClaudeUsage,
        codexUsageProbe: probeCodexUsage,
      });
    const db = this.runtimeRegistry?.db || this.eventLog?.db || null;
    this.sideEffectLog = db ? new SideEffectLog(db) : null;
    this.compactionHandler = new CompactionHandler({ adapters, taskBoard: this.taskBoard, sideEffectLog: this.sideEffectLog });
    this.eventBus = new RuntimeEventBus();
    this.compactionTrigger = new CompactionTrigger({
      adapters,
      sideEffectLog: this.sideEffectLog,
      eventBus: this.eventBus,
      getContextUsage: (agentId, opts) => getContextUsage(agentId, {
        ...opts,
        runtimeRegistry: this.runtimeRegistry,
        eventLog: this.eventLog,
      }),
      getThreshold: (providerId) => resolveThresholdFromSettings(this.settingsStore, providerId),
    });
    this.apiServer = new ApiServer({
      eventBus: this.eventBus,
      toolFacade: this.toolFacade,
      port,
      token: resolveApiToken({ explicit: apiToken, projectCwd }),
      allowedOrigins: parseAllowedOriginsEnv(process.env.TOAD_API_ALLOWED_ORIGINS),
      staticDir: uiStaticDir,
    });
    // §13 monitor: periodic detection that lifts the read-only `stuck_runtime_list`
    // tool into a push signal via the SSE bus. The UI's useEventToasts hook
    // turns those into toasts. Constructed only when we have a registry +
    // event log; otherwise we'd be running detection over nothing.
    this.stuckRuntimeMonitor =
      stuckMonitor
      ?? (this.runtimeRegistry && this.eventLog
        ? new StuckRuntimeMonitor({
            runtimeRegistry: this.runtimeRegistry,
            eventLog: this.eventLog,
            eventBus: this.eventBus,
            supervisor: this.supervisor,
            ...(stuckMonitorIntervalMs != null ? { intervalMs: stuckMonitorIntervalMs } : {}),
            ...(stuckMonitorThresholdMs != null ? { thresholdMs: stuckMonitorThresholdMs } : {}),
          })
        : null);
    this.eventIngestor =
      eventIngestor ||
      new RuntimeEventIngestor({
        broker: this.broker,
        eventLog: this.eventLog,
        narrationStore: this.narrationStore,
        toolFacade: this.toolFacade,
        approvalBroker: this.approvalBroker,
        adapters,
        runtimeRegistry: this.runtimeRegistry,
        compactionHandler: this.compactionHandler,
        compactionTrigger: this.compactionTrigger,
        eventBus: this.eventBus,
        sideEffectLog: this.sideEffectLog,
      });
  }

  async start() {
    // Boot-time orphan sweep — see SqliteRuntimeRegistry.reconcileOrphans.
    // Runs before anything else so a stale "running" row from the prior
    // sidecar lifetime cannot accidentally satisfy a launch-already-running
    // check or surface to the UI as live.
    if (this.runtimeRegistry && typeof this.runtimeRegistry.reconcileOrphans === 'function') {
      const orphans = this.runtimeRegistry.reconcileOrphans();
      if (orphans.reconciled > 0) {
        // eslint-disable-next-line no-console
        console.log(`[runtime] reconciled ${orphans.reconciled} orphan runtime row(s) on boot`);
      }
      // Kill orphan child processes from the prior sidecar lifetime. On
      // Windows, child claude.exe processes don't die with their parent
      // sidecar — they hold open stdin pipes whose write-ends died with
      // the sidecar, so the new sidecar can't talk to them. Killing them
      // forces the operator to re-launch in this sidecar's lifetime, which
      // is the only path that produces working stdin delivery.
      // process.kill on Windows ignores the signal name and uses
      // TerminateProcess, which is what we want for unresponsive orphans.
      if (Array.isArray(orphans.orphanedPids) && orphans.orphanedPids.length > 0) {
        let killed = 0;
        for (const pid of orphans.orphanedPids) {
          try {
            process.kill(pid, 'SIGKILL');
            killed += 1;
          } catch (err) {
            // ESRCH = process already gone, which is fine. Anything else
            // (EPERM, etc.) we log but don't fail boot over.
            if (err && err.code !== 'ESRCH') {
              // eslint-disable-next-line no-console
              console.warn(`[runtime] could not kill orphan pid ${pid}: ${err.message || err}`);
            }
          }
        }
        if (killed > 0) {
          // eslint-disable-next-line no-console
          console.log(`[runtime] killed ${killed} orphan child process(es) from prior sidecar lifetime`);
        }
      }
    }
    const replay = this.replayPendingSideEffects();
    if (replay.dropped > 0) {
      this.eventBus.emit('runtime_event', {
        type: 'side_effects_dropped_on_restart',
        count: replay.dropped,
        createdAt: new Date().toISOString(),
      });
    }
    const prune = this.pruneSideEffectLog();
    if (prune.deleted > 0) {
      this.eventBus.emit('runtime_event', {
        type: 'side_effects_pruned',
        count: prune.deleted,
        createdAt: new Date().toISOString(),
      });
      const vacuum = this.vacuumDatabase();
      if (vacuum.vacuumed) {
        this.eventBus.emit('runtime_event', {
          type: 'database_vacuumed',
          deleted: prune.deleted,
          freelistBefore: vacuum.freelistBefore,
          freelistAfter: vacuum.freelistAfter,
          createdAt: new Date().toISOString(),
        });
      }
    }
    await this.apiServer.start();
    if (this.stuckRuntimeMonitor && typeof this.stuckRuntimeMonitor.start === 'function') {
      this.stuckRuntimeMonitor.start();
    }
    // Hydrate the in-memory runtime directory from the SQLite-persisted
    // agent_delivery_modes table. Without this, the directory is empty on
    // every fresh runtime construction (including the per-agent MCP child
    // runtimes), and DeliveryWorker.resolve() falls through to offline_queue
    // for every agent → message_send between agents never reaches stdin.
    if (
      this.runtimeRegistry
      && typeof this.runtimeRegistry.hydrateRuntimeDirectory === 'function'
      && this.runtimeDirectory
      && typeof this.runtimeDirectory.registerAgent === 'function'
    ) {
      try {
        this.runtimeRegistry.hydrateRuntimeDirectory(this.runtimeDirectory);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[runtime] hydrateRuntimeDirectory failed: ${err?.message || err}`);
      }
    }
    // Boot reconciliation — re-deliver any session_turn inbox messages that
    // were never delivered (no committed attempt) before the previous restart.
    // Uses DeliveryWorker.deliverMessage which is idempotent: beginDeliveryAttempt
    // early-returns an already-committed attempt without re-sending.
    await this.#reconcileSessionInboxes();
    // Delivery retry sweep — only in the MAIN sidecar, not the per-agent
    // MCP children. Each MCP child has its own LocalToadRuntime with empty
    // adapters/directory, so when an agent calls message_send via MCP the
    // delivery falls through to offline_queue. The main sidecar holds the
    // live adapters; this sweep rescues queued messages and delivers them
    // for real every 500ms.
    // Detection: MCP children get TOAD_AGENT_ID set by the spawning code
    // (see toadMcpConfig.js). The main sidecar (dev-api-server.mjs) does
    // not. Skipping in MCP children avoids hammering the broker N×.
    const isMcpChild = typeof process.env.TOAD_AGENT_ID === 'string' && process.env.TOAD_AGENT_ID.length > 0;
    if (!isMcpChild && this.broker && this.deliveryWorker
        && typeof this.broker.listMessagesNeedingDelivery === 'function') {
      const tick = async () => {
        try {
          const pending = this.broker.listMessagesNeedingDelivery({ limit: 50 });
          for (const m of pending) {
            try {
              await this.deliveryWorker.deliverMessage(m.messageId);
            } catch (err) {
              // Single-message failure shouldn't kill the sweep — log and
              // continue. The retry will pick it up on the next tick.
              // eslint-disable-next-line no-console
              console.warn(`[delivery-retry] ${m.messageId}: ${err?.message || err}`);
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[delivery-retry] sweep failed: ${err?.message || err}`);
        }
      };
      this.deliveryRetryTimer = setInterval(tick, 500);
      // First tick immediately so a freshly-launched team doesn't have to
      // wait 500ms for its first inter-agent message to flow.
      tick();
    }
  }

  replayPendingSideEffects() {
    if (!this.sideEffectLog) return { dropped: 0 };
    const pending = this.sideEffectLog.getPending();
    for (const record of pending) {
      this.sideEffectLog.markFailed(record.idempotencyKey);
    }
    return { dropped: pending.length };
  }

  pruneSideEffectLog({ olderThan } = {}) {
    if (!this.sideEffectLog) return { deleted: 0 };
    const cutoff = olderThan instanceof Date && !Number.isNaN(olderThan.getTime())
      ? olderThan
      : new Date(Date.now() - this.sideEffectRetentionDays * 86_400_000);
    return { deleted: this.sideEffectLog.pruneOlderThan(cutoff) };
  }

  vacuumDatabase() {
    if (this.dbPath === ':memory:') return { vacuumed: false, reason: 'in_memory' };
    const db = this.runtimeRegistry?.db || this.eventLog?.db || this.approvalBroker?.db || null;
    if (!db) return { vacuumed: false, reason: 'no_db_handle' };
    const freelistBefore = db.prepare('PRAGMA freelist_count').get().freelist_count;
    db.exec('VACUUM');
    const freelistAfter = db.prepare('PRAGMA freelist_count').get().freelist_count;
    return { vacuumed: true, reason: 'success', freelistBefore, freelistAfter };
  }

  async launchAgent(input) {
    // PROJECT.md §4 — every spawn passes the isolation gate.
    //
    // Two enforcement points here:
    //
    //   (1) When the runtime is configured with both projectCwd AND
    //       installDir, we assert they are isolated AND require the
    //       caller to pass an explicit cwd. Without cwd, the child
    //       process would inherit the sidecar's process.cwd() — which
    //       on a dev checkout IS Symphony's install dir, leaking the
    //       very thing this contract forbids.
    //
    //   (2) Env scrubbing always happens (defense in depth). The
    //       sidecar's process.env contains breadcrumbs to Symphony:
    //       PWD, INIT_CWD, TOAD_*, npm_* — any of these in the agent's
    //       env teaches it where Symphony lives. We forward only a
    //       known-safe allow-list plus the caller's explicit input.env.
    //
    // Tests that construct LocalToadRuntime without projectCwd/installDir
    // skip the (1) checks; they still get env scrubbing for free.
    const isolated =
      typeof this.projectCwd === 'string' && this.projectCwd.length > 0
      && typeof this.installDir === 'string' && this.installDir.length > 0;
    if (isolated) {
      assertWorkspaceIsolated({
        projectCwd: this.projectCwd,
        installDir: this.installDir,
      });
      if (typeof input?.cwd !== 'string' || input.cwd.length === 0) {
        throw new Error(
          'launchAgent: cwd is required when projectCwd + installDir are configured. '
          + 'Without an explicit cwd the child process inherits the sidecar\'s working '
          + 'directory — which IS Symphony\'s install dir on a dev checkout, leaking '
          + 'the very thing the §4 isolation contract forbids. Pass input.cwd = the '
          + 'workspace path.',
        );
      }
    }
    const scrubbedInput = {
      ...input,
      env: buildScrubbedAgentEnv({
        parentEnv: process.env,
        additions: (input && typeof input.env === 'object') ? input.env : {},
      }),
    };
    let runtime;
    // RATIFIED hardening: prefer the authoritative providerId the
    // caller already supplies (localToolFacade sets input.providerId);
    // fall back to exact-match command derivation only when absent.
    // Closes the documented "Codex command → Claude adapter" foot-gun
    // for the realistic (UI/team_launch) path. Residual: a launch with
    // NO providerId AND a non-canonical command still command-derives
    // (Stage-2 / provider-plumbing hardens dispatch fully).
    const __isCodexLaunch = (input && input.providerId === 'openai')
      || (providerForCommand(input && input.command) === 'openai');
    const __isGeminiLaunch = (input && input.providerId === 'gemini')
      || (providerForCommand(input && input.command) === 'gemini');
    const __isOpencodeLaunch = (input && input.providerId === 'opencode')
      || (providerForCommand(input && input.command) === 'opencode');
    if (__isCodexLaunch) {
      runtime = await this.#prepareCodexRuntime(scrubbedInput);
    } else if (__isGeminiLaunch) {
      runtime = await this.#prepareGeminiRuntime(scrubbedInput);
    } else if (__isOpencodeLaunch) {
      runtime = await this.#prepareOpencodeRuntime(scrubbedInput);
    } else {
      const launchInput = this.#withToadMcpConfig(scrubbedInput);
      if (this.#authPreflightEnabled && isClaudeCommand(input && input.command)) {
        // CONTROLLER-RATIFIED (T7 grounding, §8d — hermetic-test +
        // inert/over-gate epicenter). `#authPreflightEnabled` is true iff
        // projectCwd is a non-empty string — the VERBATIM enable idiom
        // every other production-only collaborator in this file already
        // uses (worktreeManager / mergeChecker / mergeIntegrator /
        // riskPolicy / remoteMergePolicy / riskPolicyStore). Rationale:
        //   • Non-inert in production — EVERY real agent-launch path sets
        //     projectCwd: scripts/dev-api-server.mjs ({projectCwd,
        //     installDir}) and src/mcp/stdioRuntime.js createMcpRuntimeFromEnv
        //     ({projectCwd: TOAD_PROJECT_CWD}). Spec §4.3's "run preflight
        //     for every anthropic/claude launch" is fully preserved (in
        //     production projectCwd is always set) — spec-faithful.
        //   • Hermetic for the existing suite — test/localToadRuntime.test.js
        //     constructs WITHOUT projectCwd and launches command:'claude'
        //     12/12 times; this gate makes it a true no-op (no real
        //     getAuthStatus / no real `claude --print` in unit tests).
        // Serialize all Claude preflights in-process: concurrent team
        // launches must not race `claude --print` on the single
        // ~/.claude/.credentials.json (partial read / duplicate refresh).
        // The second waiter re-reads status first, so a burst refreshes
        // at most once. (Design §4.3.)
        const credsPath = '~/.claude/.credentials.json';
        const runPreflight = async () => this.claudeAuthPreflightImpl({
          readCredsStatus: this.readClaudeCredsStatus,
          refreshOnce: this.#resolveRefreshOnce(),
          now: () => Date.now(),
          relaunchState: this.#authRelaunchState,
          credsPath,
        });
        const gate = this.#authPreflightMutex.then(runPreflight, runPreflight);
        // Keep the chain alive regardless of this gate's outcome.
        this.#authPreflightMutex = gate.then(() => {}, () => {});
        const verdict = await gate;
        if (verdict.decision === 'block') {
          throw new Error(verdict.reason);
        }
        // proceed (with or without warn): the still-stale creds mean the
        // next provider_auth_status poll already reports stale via Layer
        // A — no extra marker plumbing (design §4.3/§5).
      }
      runtime = await this.supervisor.launchAgent(launchInput);
    }
    const adapter = this.supervisor.getAdapter(runtime.runtimeId);
    if (adapter) {
      this.adapters.set(runtime.runtimeId, adapter);
      // Auto-consume the adapter's stream-json events into the ingestor so
      // they reach runtime_events + the SSE bus without the caller wiring it
      // up. Without this, an agent runs and accepts input but its responses
      // are lost. Errors in the consumer loop are logged and swallowed —
      // they must not crash the runtime, and they should not propagate up
      // to the caller of launchAgent.
      if (typeof adapter.events === 'function') {
        Promise.resolve()
          .then(() => this.eventIngestor.ingestFrom(adapter.events()))
          .catch((err) => {
            // Don't throw — adapter event stream errors are non-fatal at the
            // runtime level. The supervisor still owns process lifecycle.
            // eslint-disable-next-line no-console
            console.error(`[LocalToadRuntime] adapter events loop error for ${runtime.runtimeId}:`, err?.message || err);
          });
      }
      // Deliver the launch prompt as the first user turn. Without this the
      // agent process spawns and just sits idle — the foundry-derived lead
      // prompt only gets stored on the team config, never spoken.
      // Prompt delivery is part of launch: if it cannot be written, fail
      // the launch instead of leaving a "running" runtime that has no work.
      //
      // Source priority: promptPath > inline prompt > default greeting.
      // promptPath wins because the file is the most-recently-edited source
      // of truth (mirrors upstream's --team-bootstrap-user-prompt-file).
      let explicitPrompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
      const promptPath = typeof input?.promptPath === 'string' ? input.promptPath.trim() : '';
      if (promptPath.length > 0) {
        try {
          const fileContent = fs.readFileSync(promptPath, 'utf8');
          if (typeof fileContent === 'string' && fileContent.trim().length > 0) {
            explicitPrompt = fileContent.trim();
            // eslint-disable-next-line no-console
            console.log(`[runtime] loaded launch prompt from ${promptPath} (${explicitPrompt.length} chars)`);
          }
        } catch (err) {
          // Don't fail the launch — fall back to inline prompt or idle.
          // eslint-disable-next-line no-console
          console.warn(`[runtime] could not read promptPath ${promptPath}: ${err?.message || err}`);
        }
      }
      // Default greeting: only fired when team_launch explicitly requests
      // it (sendDefaultGreetingIfMissing=true). We don't auto-greet for
      // every launchAgent caller because tests + non-team launch paths
      // need the agent to stay quiet until they explicitly send work.
      const wantDefaultGreeting = input?.sendDefaultGreetingIfMissing === true;
      let prompt = explicitPrompt;
      if (prompt.length === 0 && wantDefaultGreeting) {
        const role = typeof input?.role === 'string' && input.role.length > 0 ? input.role : 'agent';
        const agentId = typeof input?.agentId === 'string' && input.agentId.length > 0 ? input.agentId : 'agent';
        prompt = [
          `You are the ${role} (id: ${agentId}) for a Symphony AI team.`,
          'Briefly introduce yourself in one sentence so the human knows you\'re online, then wait for instructions.',
          'When you receive a task or message, follow the Symphony AI lifecycle: propose a plan via task_plan_propose before implementation, run validation_run before review, gate review_decide before merging.',
        ].join('\n\n');
      }
      if (prompt.length > 0 && typeof adapter.sendTurn === 'function') {
        const promptKind = explicitPrompt.length > 0 ? 'launch' : 'default-greeting';
        // eslint-disable-next-line no-console
        console.log(`[runtime] sending ${promptKind} prompt to ${runtime.runtimeId} (${prompt.length} chars)`);
        try {
          await adapter.sendTurn({ message: { text: prompt } });
          // eslint-disable-next-line no-console
          console.log(`[runtime] ${promptKind} prompt delivered to ${runtime.runtimeId}`);
        } catch (err) {
          this.adapters.delete(runtime.runtimeId);
          try {
            await this.supervisor.stopAgent(runtime.runtimeId, { signal: 'SIGTERM' });
          } catch {
            // Best effort cleanup. The important part is surfacing the prompt
            // delivery failure to the launch caller.
          }
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`launch prompt delivery failed for ${runtime.runtimeId}: ${message}`);
        }
      } else if (explicitPrompt.length === 0) {
        // eslint-disable-next-line no-console
        console.log(`[runtime] no launch prompt configured for ${runtime.runtimeId}`);
      }
    }
    return runtime;
  }

  /**
   * Returns the refreshOnce function to pass to claudeAuthPreflight.
   * When a fake was injected via the constructor (refreshOnceImpl), uses it
   * directly — keeps hermetic tests fast and spawn-free.
   * Otherwise builds the real defaultRefreshOnce lazily with a Windows-safe
   * command resolution so `claude` → `claude.cmd` on win32. Lazy
   * construction means real spawn setup never runs during test construction.
   */
  #resolveRefreshOnce() {
    if (this.refreshOnceImpl != null) {
      return this.refreshOnceImpl;
    }
    // Build the real default lazily here, never in the constructor.
    const safeCommand = resolveWindowsCommand('claude');
    return () => defaultRefreshOnce({ spawnImpl: nodeSpawn, command: safeCommand });
  }

  async #prepareCodexRuntime(input) {
    // §4 isolation + env-scrub already applied by launchAgent before
    // this point. Codex file-based auth preflight — fail fast, never a
    // doomed silent spawn (the auth-no-creds lesson, per-provider).
    const auth = await this.getCodexAuthStatusImpl({ providerId: 'openai' });
    if (!auth || auth.signedIn !== true) {
      throw new Error(
        `Codex not authenticated — run \`codex login\`.${auth && auth.reason ? ` (${auth.reason})` : ''}`,
      );
    }
    const cwd = requireLaunchCwd(input);
    writeCodexProjectConfig({
      projectCwd: cwd,
      dbPath: this.dbPath,
      teamId: input.teamId,
      agentId: input.agentId,
      role: resolveLaunchRole(input),
      taskId: input.taskId,
      runtimeId: input.runtimeId,
    });
    if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim().length > 0) {
      writeAgentsMd({ projectCwd: cwd, content: input.systemPrompt });
    }
    return this.supervisor.registerSessionAgent({
      providerId: input.providerId || 'openai',
      teamId: input.teamId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      command: input.command,
      cwd,
      systemPrompt: input.systemPrompt,
      taskId: input.taskId,
      restartPolicy: input.restartPolicy,
    });
  }

  async #prepareGeminiRuntime(input) {
    const auth = await this.getProviderAuthStatusImpl({ providerId: 'gemini' });
    if (!auth || auth.signedIn !== true) {
      throw new Error(
        `Gemini not authenticated - run \`gemini auth login\`.${auth && auth.reason ? ` (${auth.reason})` : ''}`,
      );
    }
    const cwd = requireLaunchCwd(input);
    writeGeminiProjectConfig({
      projectCwd: cwd,
      dbPath: this.dbPath,
      teamId: input.teamId,
      agentId: input.agentId,
      role: resolveLaunchRole(input),
      taskId: input.taskId,
      runtimeId: input.runtimeId,
    });
    if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim().length > 0) {
      writeGeminiMd({ projectCwd: cwd, content: input.systemPrompt });
    }
    return this.supervisor.registerSessionAgent({
      providerId: input.providerId || 'gemini',
      teamId: input.teamId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      command: input.command,
      cwd,
      systemPrompt: input.systemPrompt,
      taskId: input.taskId,
      restartPolicy: input.restartPolicy,
    });
  }

  async #prepareOpencodeRuntime(input) {
    const auth = await this.getProviderAuthStatusImpl({ providerId: 'opencode' });
    if (!auth || auth.signedIn !== true) {
      throw new Error(
        `OpenCode not authenticated - run \`opencode providers login\` or configure provider credentials.${auth && auth.reason ? ` (${auth.reason})` : ''}`,
      );
    }
    const cwd = requireLaunchCwd(input);
    writeOpencodeProjectConfig({
      projectCwd: cwd,
      dbPath: this.dbPath,
      teamId: input.teamId,
      agentId: input.agentId,
      role: resolveLaunchRole(input),
      taskId: input.taskId,
      runtimeId: input.runtimeId,
    });
    if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim().length > 0) {
      writeOpencodeInstructions({ projectCwd: cwd, content: input.systemPrompt });
    }
    return this.supervisor.registerSessionAgent({
      providerId: input.providerId || 'opencode',
      teamId: input.teamId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      command: input.command,
      args: input.args,
      cwd,
      systemPrompt: input.systemPrompt,
      taskId: input.taskId,
      restartPolicy: input.restartPolicy,
    });
  }

  async #reconcileSessionInboxes() {
    if (!this.runtimeRegistry || !this.broker || !this.deliveryWorker) return;
    // W3: a `delivering` session attempt means the process died mid-turn —
    // on restart it is undelivered again. Reset stale in-flight claims so the
    // boot re-drive / sweep can recover them (no message lost on crash).
    if (typeof this.broker.resetStaleSessionInFlight === 'function') {
      try { this.broker.resetStaleSessionInFlight(); } catch { /* best effort */ }
    }
    const runtimes = this.runtimeRegistry.listRuntimes({});
    const isCommitted = (messageId) => {
      try {
        return typeof this.broker.hasCommittedRuntimeDelivery === 'function'
          && this.broker.hasCommittedRuntimeDelivery(messageId) === true;
      } catch { return false; }
    };
    const pending = computeUndeliveredSessionMessages({
      runtimes,
      listInbox: ({ teamId, agentId }) => this.broker.listInbox({ teamId, recipient: { kind: 'agent', teamId, agentId } }),
      isCommitted,
    });
    for (const p of pending) {
      try { await this.deliveryWorker.deliverMessage(p.messageId); } catch { /* idempotent retry on next boot */ }
    }
  }

  #withToadMcpConfig(input) {
    const args = Array.isArray(input?.args) ? input.args.map(String) : [];
    if (!shouldInjectToadMcpConfig({
      command: input?.command,
      args,
      dbPath: this.dbPath,
      projectCwd: this.projectCwd,
    })) {
      return input;
    }

    const mcpConfigPath = writeToadMcpConfig({
      projectCwd: this.projectCwd,
      dbPath: this.dbPath,
      teamId: input.teamId,
      agentId: input.agentId,
      role: resolveLaunchRole(input),
      taskId: input.taskId,
      runtimeId: input.runtimeId,
    });

    // Claude CLI's headless stream-json mode for the
    // ClaudeStreamJsonAdapter. We deliberately omit `--print` here:
    //   - `--print` makes the CLI exit after one turn (it expects an
    //     EOF on stdin, processes, prints, and quits — that's
    //     single-shot mode the smoke test uses).
    //   - For long-running multi-turn agents we keep stdin open across
    //     turns. `--input-format stream-json --output-format stream-json
    //     --verbose` puts Claude into the streaming loop without
    //     forcing it to exit.
    // Idempotent — duplicates are stripped.
    const streamJsonFlags = ['--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    const merged = [...args, '--mcp-config', mcpConfigPath];

    // Per-agent system prompt: when team_launch attaches a `systemPrompt` to
    // launchInput, append it as `--append-system-prompt <text>` so claude
    // boots already knowing it's a team lead/teammate, who its peers are,
    // and how the message_send rails work. Bare launchAgent callers (tests,
    // single-agent diagnostics) leave systemPrompt unset and get no flag.
    // Skipped if the caller already supplied --append-system-prompt or
    // --system-prompt — we don't want to clobber explicit operator intent.
    const callerHasSystemPromptFlag =
      args.includes('--append-system-prompt') || args.includes('--system-prompt');
    if (
      typeof input?.systemPrompt === 'string' &&
      input.systemPrompt.trim().length > 0 &&
      !callerHasSystemPromptFlag
    ) {
      merged.push('--append-system-prompt', input.systemPrompt);
    }
    const ensureFlag = (flag, value) => {
      if (merged.includes(flag)) return;
      merged.push(flag);
      if (value !== undefined) merged.push(value);
    };
    // Process the streamJsonFlags as flag/value pairs (flag arg = no value).
    for (let i = 0; i < streamJsonFlags.length; i += 1) {
      const flag = streamJsonFlags[i];
      const next = streamJsonFlags[i + 1];
      const isFlagWithValue = typeof next === 'string' && !next.startsWith('--');
      if (isFlagWithValue) {
        ensureFlag(flag, next);
        i += 1;
      } else {
        ensureFlag(flag);
      }
    }

    return {
      ...input,
      args: withClaudeMcpPermissions(merged, {
        skipPermissions: input.skipPermissions,
      }),
    };
  }

  async stopAgent(runtimeId, options) {
    const runtime = await this.supervisor.stopAgent(runtimeId, options);
    this.adapters.delete(runtime.runtimeId);
    return runtime;
  }

  async sendMessage(input) {
    const result = this.broker.appendMessage(input);
    const delivery = await this.deliveryWorker.deliverMessage(result.message.messageId);
    return {
      inserted: result.inserted,
      message: result.message,
      delivery,
    };
  }

  async ingestRuntimeEvent(event) {
    return this.eventIngestor.ingest(event);
  }

  async ingestRuntimeEvents(events) {
    return this.eventIngestor.ingestFrom(events);
  }

  getTeamOverview(input) {
    return this.readModel.getTeamOverview(input);
  }

  listTeamChat(input) {
    return this.readModel.listTeamChat(input);
  }

  listTaskBoard(input) {
    return this.readModel.listTaskBoard(input);
  }

  listRuntimeProcesses(input) {
    return this.readModel.listRuntimeProcesses(input);
  }

  listRuntimeAudit(input) {
    return this.readModel.listRuntimeAudit(input);
  }

  listNarratedTimeline(input) {
    return this.readModel.listNarratedTimeline(input);
  }

  listSpans(input) {
    return this.readModel.listSpans(input);
  }

  listSpanSummaries(input) {
    return this.readModel.listSpanSummaries(input);
  }

  listSpansAwaitingSummary(input) {
    return this.readModel.listSpansAwaitingSummary(input);
  }

  listToolCalls(input) {
    return this.readModel.listToolCalls(input);
  }

  listApiRetries(input) {
    return this.readModel.listApiRetries(input);
  }

  async close() {
    if (this.deliveryRetryTimer) {
      clearInterval(this.deliveryRetryTimer);
      this.deliveryRetryTimer = null;
    }
    if (this.stuckRuntimeMonitor && typeof this.stuckRuntimeMonitor.stop === 'function') {
      this.stuckRuntimeMonitor.stop();
    }
    await Promise.all(this.supervisor.listRuntimes().map((r) => this.stopAgent(r.runtimeId)));
    await this.apiServer.stop();
    this.adapters.clear();
    if (this.eventBus) this.eventBus.dispose();
    closeIfSupported(this.eventLog);
    closeIfSupported(this.narrationStore);
    closeIfSupported(this.spanSummaryStore);
    closeIfSupported(this.pluginJobs);
    closeIfSupported(this.runtimeRegistry);

    closeIfSupported(this.approvalBroker);
    closeIfSupported(this.foundryStore);
    closeIfSupported(this.teamConfigRegistry);
    closeIfSupported(this.taskBoard);
    closeIfSupported(this.broker);
  }
}

function closeIfSupported(component) {
  if (component && typeof component.close === 'function') {
    component.close();
  }
}

function resolveLaunchRole(input = {}) {
  if (typeof input.role === 'string' && input.role.trim().length > 0) {
    return input.role.trim();
  }
  return input.agentId === 'lead' ? 'lead' : 'developer';
}

function parseRetentionDaysEnv(raw) {
  if (typeof raw !== 'string') return 7;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return 7;
  return parsed;
}

function parseIntervalEnv(raw) {
  if (typeof raw !== 'string') return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseAllowedOriginsEnv(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === '*') return '*';
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
