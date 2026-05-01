import { SqliteBroker } from '../broker/sqliteBroker.js';
import { SqliteApprovalBroker } from '../approval/sqliteApprovalBroker.js';
import { DeliveryWorker } from '../delivery/deliveryWorker.js';
import { RuntimeDirectory } from '../delivery/runtimeDirectory.js';
import { LocalReadModel } from '../read/LocalReadModel.js';
import { CompactionHandler } from '../runtime/CompactionHandler.js';
import { RuntimeEventBus } from '../runtime/RuntimeEventBus.js';
import { RuntimeEventIngestor } from '../runtime/RuntimeEventIngestor.js';
import { RuntimeSupervisor } from '../runtime/RuntimeSupervisor.js';
import { SqliteRuntimeEventLog } from '../runtime/sqliteRuntimeEventLog.js';
import { SqliteRuntimeRegistry } from '../runtime/sqliteRuntimeRegistry.js';
import { SqliteTaskBoard } from '../task/sqliteTaskBoard.js';
import { SqliteTeamConfigRegistry } from '../team/sqliteTeamConfigRegistry.js';
import { LocalToolFacade } from '../tools/localToolFacade.js';
import { WorktreeManager } from '../task/worktreeManager.js';
import { checkForConflicts } from '../task/mergeChecker.js';
import { ApiServer } from '../transport/apiServer.js';
import { SideEffectLog } from '../delivery/sideEffectLog.js';
import { resolveApiToken } from '../runtime/resolveApiToken.js';

export class LocalToadRuntime {
  constructor({
    broker = null,
    taskBoard = null,
    approvalBroker = null,
    runtimeDirectory = new RuntimeDirectory(),
    runtimeRegistry = null,
    eventLog = null,
    teamConfigRegistry = null,
    adapters = new Map(),
    projectCwd = null,
    spawnProcess,
    createAdapter,
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
  } = {}) {
    this.broker = broker || new SqliteBroker({ filePath: dbPath });
    this.taskBoard = taskBoard || new SqliteTaskBoard({ filePath: dbPath });
    this.approvalBroker = approvalBroker || new SqliteApprovalBroker({ filePath: dbPath });
    this.runtimeDirectory = runtimeDirectory;
    this.runtimeRegistry = runtimeRegistry || new SqliteRuntimeRegistry({ filePath: dbPath });
    this.eventLog = eventLog || new SqliteRuntimeEventLog({ filePath: dbPath });
    this.teamConfigRegistry = teamConfigRegistry || new SqliteTeamConfigRegistry({ filePath: dbPath });
    this.adapters = adapters;
    this.projectCwd = projectCwd;
    this.dbPath = dbPath;
    this.sideEffectRetentionDays = sideEffectRetentionDays;
    this.supervisor =
      supervisor ||
      new RuntimeSupervisor({
        runtimeDirectory,
        runtimeRegistry: this.runtimeRegistry,
        ...(spawnProcess ? { spawnProcess } : {}),
        ...(createAdapter ? { createAdapter } : {}),
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
    this.toolFacade =
      toolFacade ||
      new LocalToolFacade({
        broker: this.broker,
        taskBoard: this.taskBoard,
        runtimeRegistry: this.runtimeRegistry,
        approvalBroker: this.approvalBroker,
        adapters,
        projectCwd,
        readModel: this.readModel,
        launchAgent: (input) => this.launchAgent(input),
        stopAgent: ({ runtimeId, signal } = {}) =>
          this.stopAgent(runtimeId, signal ? { signal } : undefined),
        teamConfigRegistry: this.teamConfigRegistry,
        dbPath,
        eventLog: this.eventLog,
        worktreeManager: this.worktreeManager,
        mergeChecker: this.mergeChecker,
      });
    const db = this.runtimeRegistry?.db || this.eventLog?.db || null;
    this.sideEffectLog = db ? new SideEffectLog(db) : null;
    this.compactionHandler = new CompactionHandler({ adapters, taskBoard: this.taskBoard, sideEffectLog: this.sideEffectLog });
    this.eventBus = new RuntimeEventBus();
    this.apiServer = new ApiServer({
      eventBus: this.eventBus,
      toolFacade: this.toolFacade,
      port,
      token: resolveApiToken({ explicit: apiToken, projectCwd }),
      allowedOrigins: parseAllowedOriginsEnv(process.env.TOAD_API_ALLOWED_ORIGINS),
    });
    this.eventIngestor =
      eventIngestor ||
      new RuntimeEventIngestor({
        broker: this.broker,
        eventLog: this.eventLog,
        toolFacade: this.toolFacade,
        approvalBroker: this.approvalBroker,
        adapters,
        runtimeRegistry: this.runtimeRegistry,
        compactionHandler: this.compactionHandler,
        eventBus: this.eventBus,
        sideEffectLog: this.sideEffectLog,
      });
  }

  async start() {
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
    const runtime = await this.supervisor.launchAgent(input);
    const adapter = this.supervisor.getAdapter(runtime.runtimeId);
    if (adapter) {
      this.adapters.set(runtime.runtimeId, adapter);
    }
    return runtime;
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

  listToolCalls(input) {
    return this.readModel.listToolCalls(input);
  }

  listApiRetries(input) {
    return this.readModel.listApiRetries(input);
  }

  async close() {
    await Promise.all(this.supervisor.listRuntimes().map((r) => this.stopAgent(r.runtimeId)));
    await this.apiServer.stop();
    this.adapters.clear();
    if (this.eventBus) this.eventBus.dispose();
    closeIfSupported(this.eventLog);
    closeIfSupported(this.runtimeRegistry);
    closeIfSupported(this.approvalBroker);
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

function parseRetentionDaysEnv(raw) {
  if (typeof raw !== 'string') return 7;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return 7;
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
