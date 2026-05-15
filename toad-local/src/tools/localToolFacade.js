import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { COMMANDS, commandRequiresIdempotency } from '../commands/command-contract.js';
import { MESSAGE_KINDS } from '../protocol/envelopes.js';
import {
  TASK_EVENT_TYPES,
  TASK_RISK_LEVELS,
  TASK_STATUS,
  TASK_TYPES,
} from '../task/inMemoryTaskBoard.js';
import { applyPermissionSuggestions, writeWorkspaceIsolationSettings, assertWorkspaceIsolated } from '../runtime/claudeSettingsWriter.js';
import { formatCrossTeamText, CROSS_TEAM_SOURCE, CROSS_TEAM_SENT_SOURCE } from '../protocol/crossTeam.js';
import { TeamConfig } from '../team/teamConfig.js';
import { PROVIDER_COMMANDS, commandForProvider } from '../team/providerCommands.js';
import { buildAgentSystemPrompt } from '../team/teamSystemPrompts.js';
import { probeClaudeUsage } from '../providers/claudeUsageProbe.js';
import { validateTaskStatusTransition } from '../task/taskLifecycle.js';
import { assertRoleCanCallTool } from '../security/roleAuthority.js';
import { runDiagnostics } from '../diagnostics/runDiagnostics.js';
import { detectStuckRuntimes, DEFAULT_THRESHOLD_MS as STUCK_DEFAULT_THRESHOLD_MS } from '../diagnostics/stuckRuntimeDetector.js';
import { classify as classifyRisk } from '../policy/riskClassifier.js';
import {
  requestDeviceCode as githubRequestDeviceCode,
  exchangeDeviceCode as githubExchangeDeviceCode,
  verifyPersonalAccessToken as githubVerifyPat,
  getCurrentUser as githubGetCurrentUser,
} from '../github/githubAuth.js';
import { BUILT_IN_GITHUB_CLIENT_ID } from '../github/githubAppDefaults.js';
import {
  getRepository as githubGetRepository,
  getBranchProtection as githubGetBranchProtection,
  createPullRequest as githubCreatePullRequest,
  createRepository as githubCreateRepository,
} from '../github/githubApi.js';
import { parseGithubRemote } from '../task/remoteMergePolicy.js';
import { runGit as defaultRunGit } from '../git/runGit.js';
import {
  getAuthStatus as providerGetAuthStatus,
  triggerAuthLogin as providerTriggerAuthLogin,
  triggerAuthLogout as providerTriggerAuthLogout,
  SUPPORTED_PROVIDERS,
} from '../providers/providerAuth.js';
import { PLUGIN_COMMANDS, SUPPORTED_PLUGINS } from '../plugins/pluginRegistry.js';
import {
  getAuthStatus as pluginGetAuthStatus,
  triggerAuthLogin as pluginTriggerLogin,
  triggerAuthLogout as pluginTriggerLogout,
} from '../plugins/pluginAuth.js';
import {
  railwayLink as defaultRailwayLink,
  railwayProvisionDb as defaultRailwayProvisionDb,
  railwayGetConnectionString as defaultRailwayGetConnectionString,
  railwayRunMigration as defaultRailwayRunMigration,
} from '../plugins/railway/railwayTools.js';
import {
  easProjectInfo as defaultEasProjectInfo,
  easBuild as defaultEasBuild,
  easUpdate as defaultEasUpdate,
} from '../plugins/eas/easTools.js';
import {
  vercelLink as defaultVercelLink,
  vercelEnvPull as defaultVercelEnvPull,
  vercelDeploy as defaultVercelDeploy,
  vercelList as defaultVercelList,
} from '../plugins/vercel/vercelTools.js';

// §17: review-feedback severity scale, ordered low → high blocking weight.
export const REVIEW_FEEDBACK_SEVERITIES = Object.freeze(['nit', 'minor', 'major', 'blocking']);
import { computeDiff as defaultComputeDiff } from '../task/diffComputer.js';
import { createDriftCorrection } from '../drift/driftCorrection.js';
import { listIdeTree, readIdeFile, writeIdeFile } from '../ide/ideFileTools.js';
import {
  getIdeStatus,
  getIdeDiff,
  createIdeCheckpoint,
  applyIdePatch,
  searchIdeFiles,
} from '../ide/ideGitTools.js';

export class LocalToolFacade {
  // 90s TTL cache for the claude /usage pty probe. We don't store this
  // in SQLite because plan-quota changes faster than session boundaries
  // and a missed update is harmless (next poll catches it).
  #claudeQuotaCache = null;
  #claudeQuotaInflight = null;

  constructor({ broker, taskBoard, runtimeRegistry = null, approvalBroker = null, adapters = null, projectCwd = null, installDir = null, readModel = null, launchAgent = null, stopAgent = null, teamConfigRegistry = null, foundryStore = null, foundryRuntime = null, spawnValidation = null, dbPath = null, eventLog = null, worktreeManager = null, diffComputer = null, mergeChecker = null, mergeIntegrator = null, remoteMergePolicy = null, riskPolicy = null, settingsStore = null, riskPolicyStore = null, githubFetch = null, githubClientId = null, providerAuthSpawn = null, providerAuthSpawnSync = null, providerAuthReadFile = null, providerAuthStat = null, claudeUsageProbe = null, driftEngine = null, runGit = null, deliveryWorker = null, pluginAuthReadFile = null, pluginAuthStat = null, pluginAuthSpawn = null, pluginAuthSpawnSync = null, pluginResources = null, pluginJobs = null, railwayToolImpls = null, easToolImpls = null, vercelToolImpls = null }) {
    if (!broker) throw new TypeError('broker is required');
    if (!taskBoard) throw new TypeError('taskBoard is required');
    this.broker = broker;
    this.taskBoard = taskBoard;
    this.runtimeRegistry = runtimeRegistry;
    // DeliveryWorker: optional. When configured, message_send fires the
    // worker after appending to the broker so the recipient runtime
    // actually receives the payload via stdin (sendTurn). Without this
    // wiring, lead → teammate messages get persisted but never delivered,
    // so teammates sit idle even though the lead is "talking" to them.
    this.deliveryWorker =
      deliveryWorker && typeof deliveryWorker.deliverMessage === 'function'
        ? deliveryWorker
        : null;
    this.approvalBroker = approvalBroker;
    this.adapters = adapters;
    this.projectCwd = projectCwd;
    // Symphony's install dir — needed for the team_launch isolation pass
    // that writes deny rules naming Symphony's own source as off-limits to
    // spawned agents. See PROJECT.md §4 and #teamLaunch below.
    this.installDir = typeof installDir === 'string' && installDir.length > 0 ? installDir : null;
    this.readModel = readModel;
    this.launchAgent = typeof launchAgent === 'function' ? launchAgent : null;
    this.stopAgent = typeof stopAgent === 'function' ? stopAgent : null;
    this.teamConfigRegistry = teamConfigRegistry;
    this.foundryStore = foundryStore && typeof foundryStore.createSession === 'function' ? foundryStore : null;
    this.foundryRuntime = foundryRuntime && typeof foundryRuntime.send === 'function'
      ? foundryRuntime
      : null;
    this.spawnValidation = typeof spawnValidation === 'function' ? spawnValidation : defaultSpawnValidation;
    this.dbPath = typeof dbPath === 'string' && dbPath.length > 0 ? dbPath : null;
    this.eventLog = eventLog && typeof eventLog.appendEvent === 'function' ? eventLog : null;
    this.worktreeManager = worktreeManager && typeof worktreeManager.createForTask === 'function' ? worktreeManager : null;
    this.diffComputer = diffComputer && typeof diffComputer.computeDiff === 'function'
      ? diffComputer
      : { computeDiff: defaultComputeDiff };
    this.mergeChecker = mergeChecker && typeof mergeChecker.checkForConflicts === 'function' ? mergeChecker : null;
    // §19 slice 2: integration step. Null = no actual merge (back-compat).
    this.mergeIntegrator = mergeIntegrator && typeof mergeIntegrator.integrate === 'function' ? mergeIntegrator : null;
    // §19 follow-up: remote merge policy (branch protection check). Null =
    // no remote check (back-compat). When set, the merge_ready → done
    // transition awaits `evaluate({ baseBranch, taskBranch })` and refuses
    // when the verdict's `allow` is false.
    this.remoteMergePolicy =
      remoteMergePolicy && typeof remoteMergePolicy.evaluate === 'function' ? remoteMergePolicy : null;
    // §14: project-local risk policy. Null = no auto-classification (back-compat).
    // Accepts policies with either `rules` (file matching), `commandRules`
    // (Bash command matching, §14 follow-up), or both.
    // §3 settings store. Null = no settings persistence available — get/set
    // commands return errors when called.
    this.settingsStore = settingsStore && typeof settingsStore.readEffective === 'function' ? settingsStore : null;
    this.riskPolicyStore = riskPolicyStore && typeof riskPolicyStore.read === 'function' ? riskPolicyStore : null;
    // §3c GitHub auth. `githubFetch` injectable so tests don't hit the network;
    // production callers leave it null and we fall back to globalThis.fetch.
    this.githubFetch = typeof githubFetch === 'function' ? githubFetch : null;
    this.githubClientId =
      typeof githubClientId === 'string' && githubClientId.length > 0
        ? githubClientId
        : (process.env.TOAD_GITHUB_CLIENT_ID || null);
    // §3c.2 Provider plan-auth. Injectable so tests don't actually fork.
    this.providerAuthSpawn = typeof providerAuthSpawn === 'function' ? providerAuthSpawn : null;
    this.providerAuthSpawnSync = typeof providerAuthSpawnSync === 'function' ? providerAuthSpawnSync : null;
    // File-based auth detection for codex/gemini (and now anthropic too)
    // — injectable so tests can simulate signed-in / signed-out without
    // touching the operator's real ~/.codex / ~/.gemini directories.
    this.providerAuthReadFile = typeof providerAuthReadFile === 'function' ? providerAuthReadFile : null;
    this.providerAuthStat = typeof providerAuthStat === 'function' ? providerAuthStat : null;
    // Override the live claude /usage pty probe in tests. Production
    // leaves this null and we fall back to the imported probeClaudeUsage.
    this.claudeUsageProbe = typeof claudeUsageProbe === 'function' ? claudeUsageProbe : null;
    // Plugin auth / resource injectable overrides (same pattern as providerAuth).
    this.pluginAuthReadFile = typeof pluginAuthReadFile === 'function' ? pluginAuthReadFile : null;
    this.pluginAuthStat = typeof pluginAuthStat === 'function' ? pluginAuthStat : null;
    this.pluginAuthSpawn = typeof pluginAuthSpawn === 'function' ? pluginAuthSpawn : null;
    this.pluginAuthSpawnSync = typeof pluginAuthSpawnSync === 'function' ? pluginAuthSpawnSync : null;
    this.pluginResources = pluginResources && typeof pluginResources.listForTeam === 'function'
      ? pluginResources : null;
    this.pluginJobs = pluginJobs && typeof pluginJobs.create === 'function'
      ? pluginJobs : null;
    this.railwayToolImpls = railwayToolImpls && typeof railwayToolImpls === 'object'
      ? railwayToolImpls : null;
    this.easToolImpls = easToolImpls && typeof easToolImpls === 'object'
      ? easToolImpls : null;
    this.vercelToolImpls = vercelToolImpls && typeof vercelToolImpls === 'object'
      ? vercelToolImpls : null;
    this.driftEngine = driftEngine && typeof driftEngine.runDrift === 'function' ? driftEngine : null;
    // git invoker for tools that need to read the project's git state
    // (e.g. github_origin_remote). Injectable so tests don't shell out.
    this.runGit = typeof runGit === 'function' ? runGit : defaultRunGit;
    this.riskPolicy =
      riskPolicy && (Array.isArray(riskPolicy.rules) || Array.isArray(riskPolicy.commandRules))
        ? riskPolicy
        : null;
  }

  execute(command) {
    const commandName = requireString(command.commandName, 'commandName');
    if (commandRequiresIdempotency(commandName)) {
      requireString(command.idempotencyKey, 'idempotencyKey');
    }
    const actor = normalizeActor(command.actor);
    try {
      assertRoleCanCallTool({ role: actor.role, toolName: commandName });
    } catch (err) {
      this.#emitToolCallDenied(actor, commandName, err);
      throw err;
    }
    const args = command.args && typeof command.args === 'object' ? command.args : {};

    switch (commandName) {
      case COMMANDS.MESSAGE_SEND:
        return this.#messageSend(actor, command.idempotencyKey, args);
      case COMMANDS.MESSAGE_LIST:
        return this.#messageList(actor, args);
      case COMMANDS.TASK_CREATE:
        return this.#taskCreate(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_COMMENT:
        return this.#taskComment(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_UPDATE:
        // When a remote-merge-policy gate is configured, route through the
        // async wrapper that pre-resolves the GitHub branch-protection
        // verdict before delegating to the synchronous #taskUpdate. When no
        // policy is configured, dispatch sync — preserves the historic
        // sync behavior every existing test depends on.
        if (this.remoteMergePolicy) {
          return this.#taskUpdateWithPolicyGate(actor, command.idempotencyKey, args);
        }
        return this.#taskUpdate(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_REQUEST:
        return this.#reviewRequest(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_DECIDE:
        return this.#reviewDecide(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_LIST:
        return this.#reviewList(actor);
      case COMMANDS.TASK_LIST:
        // Wrap the raw array in `{ tasks: [...] }` so MCP clients that
        // require structuredContent to be an object (Claude Code's MCP
        // client treats top-level arrays as schema mismatches) don't
        // reject the response. UI's useToadData accepts both shapes.
        return { tasks: this.taskBoard.listTasks({ teamId: actor.teamId }) };
      case COMMANDS.AGENT_STATUS:
        return this.#agentStatus(actor, args);
      case COMMANDS.APPROVAL_LIST:
        return this.#approvalList(actor);
      case COMMANDS.APPROVAL_RESPOND:
        return this.#approvalRespond(actor, command.idempotencyKey, args);
      case COMMANDS.TOOL_ACTIVITY:
        return this.#toolActivity(actor, args);
      case COMMANDS.HEALTH_STATUS:
        return this.#healthStatus(actor, args);
      case COMMANDS.IDE_TREE_LIST:
        return this.#ideTreeList(actor, args);
      case COMMANDS.IDE_READ_FILE:
        return this.#ideReadFile(actor, args);
      case COMMANDS.IDE_WRITE_FILE:
        return this.#ideWriteFile(actor, args);
      case COMMANDS.IDE_GET_STATUS:
        return this.#ideGetStatus(actor, args);
      case COMMANDS.IDE_GET_DIFF:
        return this.#ideGetDiff(actor, args);
      case COMMANDS.IDE_CHECKPOINT_TASK:
        return this.#ideCheckpointTask(actor, args);
      case COMMANDS.IDE_APPLY_PATCH:
        return this.#ideApplyPatch(actor, args);
      case COMMANDS.IDE_SEARCH_FILES:
        return this.#ideSearchFiles(actor, args);
      case COMMANDS.RUNTIME_LIST:
        return this.#runtimeList(actor, args);
      case COMMANDS.USAGE_SUMMARY:
        return this.#usageSummary(actor, args);
      case COMMANDS.RUNTIME_EVENTS:
        return this.#runtimeEvents(actor, args);
      case COMMANDS.CROSS_TEAM_MESSAGES:
        return this.#crossTeamMessages(actor, args);
      case COMMANDS.CROSS_TEAM_SEND:
        return this.#crossTeamSend(actor, command.idempotencyKey, args);
      case COMMANDS.AGENT_LAUNCH:
        return this.#agentLaunch(actor, args);
      case COMMANDS.AGENT_STOP:
        return this.#agentStop(actor, args);
      case COMMANDS.AGENT_SWAP_PROVIDER:
        return this.#agentSwapProvider(actor, args);
      case COMMANDS.TEAM_CREATE:
        return this.#teamCreate(actor, args);
      case COMMANDS.TEAM_LIST:
        return this.#teamList(actor);
      case COMMANDS.TEAM_DELETE:
        return this.#teamDelete(actor, args);
      case COMMANDS.TEAM_LAUNCH:
        return this.#teamLaunch(actor, args);
      case COMMANDS.TEAM_STOP:
        return this.#teamStop(actor, args);
      case COMMANDS.RUNTIME_SEND_INPUT:
        return this.#runtimeSendInput(actor, args);
      case COMMANDS.VALIDATION_RUN:
        return this.#validationRun(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_PLAN_PROPOSE:
        return this.#taskPlanPropose(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_PLAN_APPROVE:
        return this.#taskPlanDecide(actor, command.idempotencyKey, args, 'approved');
      case COMMANDS.TASK_PLAN_REJECT:
        return this.#taskPlanDecide(actor, command.idempotencyKey, args, 'rejected');
      case COMMANDS.DIAGNOSTICS_RUN:
        return this.#diagnosticsRun();
      case COMMANDS.TASK_HISTORY_EXPORT:
        return this.#taskHistoryExport(actor, args);
      case COMMANDS.TASK_HUMAN_APPROVE:
        return this.#humanApprove(actor, command.idempotencyKey, args);
      case COMMANDS.STUCK_RUNTIME_LIST:
        return this.#stuckRuntimeList(actor, args);
      case COMMANDS.SETTINGS_GET:
        return this.#settingsGet(args);
      case COMMANDS.SETTINGS_SET:
        return this.#settingsSet(args);
      case COMMANDS.GITHUB_DEVICE_START:
        return this.#githubDeviceStart(args);
      case COMMANDS.GITHUB_DEVICE_POLL:
        return this.#githubDevicePoll(args);
      case COMMANDS.GITHUB_PAT_VERIFY:
        return this.#githubPatVerify(args);
      case COMMANDS.GITHUB_DISCONNECT:
        return this.#githubDisconnect();
      case COMMANDS.GITHUB_STATUS:
        return this.#githubStatus();
      case COMMANDS.GITHUB_GET_REPOSITORY:
        return this.#githubGetRepository(args);
      case COMMANDS.GITHUB_GET_BRANCH_PROTECTION:
        return this.#githubGetBranchProtection(args);
      case COMMANDS.GITHUB_CREATE_PULL_REQUEST:
        return this.#githubCreatePullRequest(args);
      case COMMANDS.GITHUB_ORIGIN_REMOTE:
        return this.#githubOriginRemote();
      case COMMANDS.RISK_POLICY_GET:
        return this.#riskPolicyGet();
      case COMMANDS.RISK_POLICY_SET:
        return this.#riskPolicySet(args);
      case COMMANDS.RISK_POLICY_PREVIEW:
        return this.#riskPolicyPreview(args);
      case COMMANDS.PROVIDER_AUTH_STATUS:
        return this.#providerAuthStatus(args);
      case COMMANDS.PROVIDER_AUTH_LOGIN:
        return this.#providerAuthLogin(args);
      case COMMANDS.PROVIDER_AUTH_LOGOUT:
        return this.#providerAuthLogout(args);
      case COMMANDS.PLUGIN_LIST_AVAILABLE:
        return this.#pluginListAvailable(actor, args);
      case COMMANDS.PLUGIN_LOGIN:
        return this.#pluginLogin(actor, args);
      case COMMANDS.PLUGIN_LOGOUT:
        return this.#pluginLogout(actor, args);
      case COMMANDS.PLUGIN_RESOURCE_LIST:
        return this.#pluginResourceList(actor, args);
      case COMMANDS.RAILWAY_LINK:
        return this.#railwayLink(actor, args);
      case COMMANDS.RAILWAY_PROVISION_DB:
        return this.#railwayProvisionDb(actor, args);
      case COMMANDS.RAILWAY_GET_CONNECTION_STRING:
        return this.#railwayGetConnectionString(actor, args);
      case COMMANDS.RAILWAY_RUN_MIGRATION:
        return this.#railwayRunMigration(actor, args);
      case COMMANDS.EAS_PROJECT_INFO:
        return this.#easProjectInfo(actor, args);
      case COMMANDS.EAS_BUILD:
        return this.#easBuild(actor, args);
      case COMMANDS.EAS_UPDATE:
        return this.#easUpdate(actor, args);
      case COMMANDS.VERCEL_LINK:
        return this.#vercelLink(actor, args);
      case COMMANDS.VERCEL_ENV_PULL:
        return this.#vercelEnvPull(actor, args);
      case COMMANDS.VERCEL_DEPLOY:
        return this.#vercelDeploy(actor, args);
      case COMMANDS.VERCEL_LS:
        return this.#vercelList(actor, args);
      case COMMANDS.PLUGIN_JOB_GET:
        return this.#pluginJobGet(actor, args);
      case COMMANDS.PLUGIN_JOB_LIST:
        return this.#pluginJobList(actor, args);
      case COMMANDS.AUDIT_LOG_QUERY:
        return this.#auditLogQuery(actor, args);
      case COMMANDS.FOUNDRY_SESSION_CREATE:
        return this.#foundrySessionCreate(args);
      case COMMANDS.FOUNDRY_SESSION_LIST:
        return this.#foundrySessionList();
      case COMMANDS.FOUNDRY_SESSION_GET:
        return this.#foundrySessionGet(args);
      case COMMANDS.FOUNDRY_MESSAGE_ADD:
        return this.#foundryMessageAdd(args);
      case COMMANDS.FOUNDRY_CHAT_TURN:
        return this.#foundryChatTurn(args);
      case COMMANDS.FOUNDRY_ARTIFACT_UPSERT:
        return this.#foundryArtifactUpsert(args);
      case COMMANDS.FOUNDRY_ARTIFACT_GENERATE:
        return this.#foundryArtifactGenerate(args);
      case COMMANDS.FOUNDRY_ARTIFACT_EXPORT:
        return this.#foundryArtifactExport(args);
      case COMMANDS.FOUNDRY_PROJECT_MATERIALIZE:
        return this.#foundryProjectMaterialize(actor, command.idempotencyKey, args);
      case COMMANDS.FOUNDRY_PROJECT_SEED_TASKS:
        return this.#foundryProjectSeedTasks(actor, command.idempotencyKey, args);
      case COMMANDS.GIT_INIT_LOCAL:
        return this.#gitInitLocal(args);
      case COMMANDS.GIT_SET_REMOTE:
        return this.#gitSetRemote(args);
      case COMMANDS.GITHUB_CREATE_REPOSITORY:
        return this.#githubCreateRepository(args);
      case COMMANDS.DRIFT_RUN:
        return this.#driftRun(actor, args);
      case COMMANDS.DRIFT_CORRECTION_CREATE:
        return this.#driftCorrectionCreate(actor, command.idempotencyKey, args);
      case COMMANDS.PROJECT_STATE_DESCRIBE:
        return this.#projectStateDescribe(args);
      default:
        throw new Error(`unsupported command: ${commandName}`);
    }
  }

  async #messageSend(actor, idempotencyKey, args) {
    const result = this.broker.appendMessage({
      teamId: actor.teamId,
      idempotencyKey,
      from: { kind: 'agent', id: actor.agentId },
      to: normalizeMessageRecipient(actor.teamId, args.to),
      kind: args.kind || MESSAGE_KINDS.REPLY,
      text: requireString(args.text, 'args.text'),
      taskRefs: Array.isArray(args.taskRefs) ? args.taskRefs : [],
      metadata: args.metadata || {},
      replyToMessageId: args.replyToMessageId || null,
      conversationId: args.conversationId,
    });
    // Trigger delivery to the recipient runtime's stdin via the
    // DeliveryWorker. Skipped when no worker is configured (tests, smoke
    // runs) or when the message was a duplicate (broker dedup hit). Errors
    // are surfaced on the response but do NOT throw — the message is
    // already persisted, and the operator will see the delivery failure
    // status without losing the broker write.
    let delivery = null;
    if (this.deliveryWorker && result.inserted && result.message?.messageId) {
      try {
        delivery = await this.deliveryWorker.deliverMessage(result.message.messageId);
      } catch (err) {
        delivery = {
          status: 'failed',
          responseState: 'delivery_failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { ...result, delivery };
  }

  /**
   * message_list — return messages for the current team. The UI's
   * AgentInbox uses this to populate the Messages tab. Optionally filter
   * by `agentId` (returns only messages where the agent is sender or
   * recipient).
   *
   * Args: { teamId?: string, agentId?: string, limit?: number }.
   * Returns: { messages: Message[] } — wrapped to match runtime_list /
   *   task_list shape so MCP clients accept structuredContent as object.
   */
  #messageList(actor, args) {
    if (!this.broker || typeof this.broker.listMessages !== 'function') {
      return { messages: [] };
    }
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId
      : actor.teamId;
    const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 200;
    const all = this.broker.listMessages({ teamId, limit });
    const filterAgent = typeof args?.agentId === 'string' && args.agentId.length > 0 ? args.agentId : null;
    const messages = filterAgent
      ? all.filter((m) => {
          const fromMatches = m.from?.kind === 'agent' && m.from?.id === filterAgent;
          const toMatches = m.to?.kind === 'agent' && m.to?.agentId === filterAgent;
          return fromMatches || toMatches;
        })
      : all;
    return { messages };
  }

  #ideTreeList(actor, args) {
    return listIdeTree({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
      maxEntries: typeof args.maxEntries === 'number' ? args.maxEntries : undefined,
    });
  }

  #ideReadFile(actor, args) {
    return readIdeFile({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
      relativePath: requireString(args.relativePath, 'args.relativePath'),
    });
  }

  #ideWriteFile(actor, args) {
    if (typeof args.content !== 'string') {
      throw new TypeError('args.content must be a string');
    }
    return writeIdeFile({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
      relativePath: requireString(args.relativePath, 'args.relativePath'),
      content: args.content,
      expectedSha256: typeof args.expectedSha256 === 'string' ? args.expectedSha256 : undefined,
    });
  }

  #ideGetStatus(actor, args) {
    return getIdeStatus({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
    });
  }

  #ideGetDiff(actor, args) {
    return getIdeDiff({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
      relativePath: args.relativePath,
    });
  }

  #ideCheckpointTask(actor, args) {
    return createIdeCheckpoint({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
      message: args.message,
    });
  }

  #ideApplyPatch(actor, args) {
    return applyIdePatch({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
      patchContent: args.patchContent,
      reverse: args.reverse,
    });
  }

  #ideSearchFiles(actor, args) {
    return searchIdeFiles({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
      query: args.query,
    });
  }

  #taskCreate(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: actor.agentId,
      payload: {
        subject: requireString(args.subject, 'args.subject'),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        ...(typeof args.ownerId === 'string' ? { ownerId: args.ownerId } : {}),
        status: args.status || TASK_STATUS.PENDING,
        // §8 slice 4: optional explicit baseRef / baseBranch.
        ...(typeof args.baseRef === 'string' && args.baseRef.length > 0 ? { baseRef: args.baseRef } : {}),
        ...(typeof args.baseBranch === 'string' && args.baseBranch.length > 0 ? { baseBranch: args.baseBranch } : {}),
        ...normalizeTaskRiskContractArgs(args),
      },
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #taskComment(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.COMMENT_ADDED,
      actorId: actor.agentId,
      payload: {
        text: requireString(args.text, 'args.text'),
        ...(typeof args.commentId === 'string' ? { commentId: args.commentId } : {}),
      },
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  /**
   * Async pre-flight for task_update when a remote-merge-policy gate is
   * configured. Peeks at the current task to decide whether the upcoming
   * transition needs a branch-protection check; if not, falls through to
   * the sync handler immediately. If yes, awaits the verdict, throws when
   * it refuses, and otherwise threads the verdict into the sync handler
   * via an internal args field so the integration event can record *why*
   * we proceeded.
   */
  async #taskUpdateWithPolicyGate(actor, idempotencyKey, args) {
    const taskId = typeof args?.taskId === 'string' ? args.taskId : null;
    const current = taskId ? this.taskBoard.getTask({ teamId: actor.teamId, taskId }) : null;
    const wt = current?.worktree;
    const isFinishingMerge =
      current?.status === 'merge_ready' &&
      args?.status === 'done' &&
      typeof current?.baseBranch === 'string' &&
      current.baseBranch.length > 0 &&
      wt &&
      wt.status === 'created' &&
      typeof wt.branch === 'string' &&
      wt.branch.length > 0;
    if (!isFinishingMerge) {
      return this.#taskUpdate(actor, idempotencyKey, args);
    }
    let verdict;
    try {
      verdict = await this.remoteMergePolicy.evaluate({
        baseBranch: current.baseBranch,
        taskBranch: wt.branch,
      });
    } catch (err) {
      // Defensive — the contract is "always returns a verdict", but if the
      // collaborator throws we treat as advisory failure: allow the merge
      // and record the reason in the event payload.
      verdict = {
        allow: true,
        reason: `policy_evaluate_threw:${err && err.message ? err.message : 'unknown'}`,
      };
    }
    if (verdict && verdict.allow === false) {
      throw new Error(
        `task_update: merge_ready → done blocked by branch protection: ${verdict.reason}. ` +
        `Open a pull request via github_create_pull_request from "${wt.branch}" into "${current.baseBranch}".`,
      );
    }
    return this.#taskUpdate(actor, idempotencyKey, { ...args, __remotePolicyVerdict: verdict });
  }

  #taskUpdate(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    if (typeof args.ownerId === 'string') {
      this.taskBoard.appendEvent({
        teamId: actor.teamId,
        taskId,
        idempotencyKey: `${idempotencyKey}:owner`,
        eventType: TASK_EVENT_TYPES.ASSIGNED,
        actorId: actor.agentId,
        payload: { ownerId: args.ownerId },
      });
    }
    if (typeof args.status === 'string') {
      const current = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
      const fromStatus = current?.status ?? null;
      const validation = validateTaskStatusTransition({ from: fromStatus, to: args.status, role: actor.role });
      if (!validation.ok) {
        throw new Error(`task_update: ${validation.reason}`);
      }
      // CI gate: testing → merge_ready requires a passing test verdict.
      // Implements the gate half of checklist §6 + §18 ("failed command blocks merge_ready").
      if (fromStatus === 'testing' && args.status === 'merge_ready') {
        const latestTest = current?.latestValidation?.test;
        if (!latestTest || latestTest.verdict !== 'passed') {
          const detail = latestTest ? `latest: ${latestTest.verdict}` : 'no test run';
          throw new Error(
            `task_update: testing → merge_ready requires a passing test verdict (${detail})`,
          );
        }
      }
      // Plan-before-code gate: ready → planned requires an approved plan.
      // Implements checklist §2 ("no implementation before plan exists").
      if (fromStatus === 'ready' && args.status === 'planned') {
        const planState = current?.plan?.state || 'none';
        if (planState !== 'approved') {
          throw new Error(
            `task_update: ready → planned requires an approved plan (current: ${planState})`,
          );
        }
      }
      // Merge gate (§19 slice 1): merge_ready → done requires a clean merge
      // verdict from the orchestrator. The check runs against the task's
      // worktree branch vs. its baseRef. Only fires when the task has a
      // created worktree AND a mergeChecker is configured — non-git
      // workspaces and bare-test setups bypass the gate.
      if (fromStatus === 'merge_ready' && args.status === 'done' && this.mergeChecker) {
        const wt = current?.worktree;
        if (wt && wt.status === 'created' && wt.path && wt.baseRef) {
          let verdict;
          try {
            verdict = this.mergeChecker.checkForConflicts({ worktreePath: wt.path, baseRef: wt.baseRef });
          } catch (err) {
            verdict = { status: 'error', error: err && err.message ? err.message : String(err) };
          }
          if (verdict.status === 'conflict') {
            const fileList = Array.isArray(verdict.files) && verdict.files.length > 0
              ? verdict.files.join(', ')
              : '<unknown files>';
            throw new Error(
              `task_update: merge_ready → done blocked by merge conflict in: ${fileList}`,
            );
          }
          if (verdict.status === 'error') {
            throw new Error(
              `task_update: merge_ready → done blocked: ${verdict.error || 'merge check failed'}`,
            );
          }
        }
      }
      // Human-approval gate (§14): merge_ready → done is blocked when the
      // task has requiresHumanApproval=true and no HUMAN_APPROVED event has
      // landed. Either the operator set the flag at task_create OR the
      // risk classifier elevated it during review_request.
      if (fromStatus === 'merge_ready' && args.status === 'done') {
        if (current?.requiresHumanApproval === true && current?.humanApproval?.approved !== true) {
          throw new Error(
            `task_update: merge_ready → done blocked by human-approval gate (riskLevel: ${current.riskLevel || 'unspecified'}). Run task_human_approve before transitioning.`,
          );
        }
      }
      // Integration step (§19 slice 2): after the conflict gate (slice 1) and
      // human-approval gate (§14), perform the actual merge into baseBranch.
      // Non-destructive: merge-tree → commit-tree → update-ref. No HEAD change,
      // no working-directory mutation. Only fires when configured AND the task
      // has a created worktree AND a baseBranch is set; otherwise records a
      // 'skipped' integration event and lets the lifecycle continue.
      if (fromStatus === 'merge_ready' && args.status === 'done' && this.mergeIntegrator) {
        const wt = current?.worktree;
        if (wt && wt.status === 'created' && typeof wt.branch === 'string' && wt.branch.length > 0) {
          let result;
          // §19 follow-up: when remoteMergePolicy is configured, the verdict
          // is pre-resolved by #taskUpdateWithPolicyGate (async dispatcher
          // wrapper) and passed in via this internal args field. Keeping
          // #taskUpdate synchronous avoids touching ~200 existing test sites
          // that don't await the call.
          const remotePolicyVerdict = args.__remotePolicyVerdict || null;
          if (typeof current?.baseBranch !== 'string' || current.baseBranch.length === 0) {
            result = { status: 'skipped', reason: 'no_base_branch' };
          } else {
            try {
              result = this.mergeIntegrator.integrate({
                projectCwd: this.projectCwd,
                taskBranch: wt.branch,
                baseBranch: current.baseBranch,
                taskSubject: current.subject,
              });
            } catch (err) {
              result = { status: 'error', reason: 'integrator_threw', stderr: err && err.message ? err.message : String(err) };
            }
          }
          if (result.status === 'error') {
            throw new Error(
              `task_update: merge_ready → done blocked by integration: ${result.reason}${result.stderr ? ' — ' + result.stderr : ''}`,
            );
          }
          // Enrich the integration record with the policy verdict so the
          // event + projection capture *why* we proceeded (unprotected,
          // protected-but-pr-not-required, protection_check_failed, etc.).
          if (remotePolicyVerdict && (result.status === 'merged' || result.status === 'skipped')) {
            result = { ...result, remotePolicy: { reason: remotePolicyVerdict.reason } };
          }
          // Append INTEGRATION_MERGED event (success OR best-effort skip)
          try {
            this.taskBoard.appendEvent({
              teamId: actor.teamId,
              taskId,
              idempotencyKey: `${idempotencyKey}:integration`,
              eventType: TASK_EVENT_TYPES.INTEGRATION_MERGED,
              actorId: actor.agentId,
              payload: result,
            });
          } catch {
            // best-effort — projection is informational
          }
        }
      }
      const payload = { status: args.status, from: fromStatus };
      if (typeof args.reason === 'string' && args.reason.length > 0) payload.reason = args.reason;
      this.taskBoard.appendEvent({
        teamId: actor.teamId,
        taskId,
        idempotencyKey: `${idempotencyKey}:status`,
        eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
        actorId: actor.agentId,
        payload,
      });
      // Worktree-per-task (§8): when a task moves to `planned`, ask the
      // configured manager to create an isolated worktree on a task-scoped
      // branch. Best-effort — a missing or broken manager must not block
      // the state transition; the event is still recorded.
      if (args.status === 'planned' && this.worktreeManager) {
        const existing = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
        if (!existing?.worktree || existing.worktree.status !== 'created') {
          this.#triggerWorktreeCreation(actor, idempotencyKey, taskId);
        }
      }
      // Worktree-per-task (§8 slice 3): when a task transitions to `done`,
      // remove the worktree. The branch is preserved so merge history stays
      // reachable. `rejected` does NOT auto-remove — operator triages WIP.
      if (args.status === 'done' && this.worktreeManager) {
        const existing = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
        if (existing?.worktree?.status === 'created') {
          this.#triggerWorktreeRemoval(actor, idempotencyKey, taskId);
        }
      }
    }
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #triggerWorktreeCreation(actor, idempotencyKey, taskId) {
    let result;
    // §8 slice 4: forward task.baseRef (operator-supplied at creation) so the
    // manager can pin the worktree to a specific commit instead of always
    // taking HEAD-at-planning. Undefined when the task didn't capture one.
    const taskNow = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
    const explicitBaseRef = typeof taskNow?.baseRef === 'string' && taskNow.baseRef.length > 0
      ? taskNow.baseRef
      : undefined;
    try {
      result = this.worktreeManager.createForTask({
        teamId: actor.teamId,
        taskId,
        ...(explicitBaseRef ? { baseRef: explicitBaseRef } : {}),
      });
    } catch (err) {
      result = {
        status: 'skipped',
        reason: 'manager_threw',
        stderr: err && err.message ? err.message : String(err),
      };
    }
    try {
      this.taskBoard.appendEvent({
        teamId: actor.teamId,
        taskId,
        idempotencyKey: `${idempotencyKey}:worktree`,
        eventType: TASK_EVENT_TYPES.WORKTREE_CREATED,
        actorId: actor.agentId,
        payload: result,
      });
    } catch {
      // best-effort — projection skip is acceptable, transition already landed
    }
  }

  #triggerWorktreeRemoval(actor, idempotencyKey, taskId) {
    let result;
    try {
      result = this.worktreeManager.removeForTask({ teamId: actor.teamId, taskId });
    } catch (err) {
      result = {
        status: 'skipped',
        reason: 'manager_threw',
        stderr: err && err.message ? err.message : String(err),
      };
    }
    try {
      this.taskBoard.appendEvent({
        teamId: actor.teamId,
        taskId,
        idempotencyKey: `${idempotencyKey}:worktree_remove`,
        eventType: TASK_EVENT_TYPES.WORKTREE_REMOVED,
        actorId: actor.agentId,
        payload: result,
      });
    } catch {
      // best-effort
    }
  }

  #reviewRequest(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const payload = {};
    if (typeof args.reviewerId === 'string' && args.reviewerId.length > 0) payload.reviewerId = args.reviewerId;
    if (typeof args.summary === 'string' && args.summary.length > 0) payload.summary = args.summary;
    if (typeof args.diff === 'string' && args.diff.length > 0) payload.diff = args.diff;
    if (Array.isArray(args.files)) {
      const cleaned = args.files.filter((f) => typeof f === 'string' && f.length > 0);
      if (cleaned.length > 0) payload.files = cleaned;
    }
    // §7 finished: when caller didn't supply diff/files AND the task has an
    // active worktree, ask the orchestrator to compute the real diff against
    // the base ref. Operator-supplied diff always wins (covers cases like
    // squash-rebase summaries the orchestrator can't reconstruct).
    const taskBeforeReview = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
    let computedRan = false;
    if (!payload.diff && !payload.files) {
      const wt = taskBeforeReview?.worktree;
      if (wt && wt.status === 'created' && wt.path && wt.baseRef) {
        let computed;
        try {
          computed = this.diffComputer.computeDiff({ worktreePath: wt.path, baseRef: wt.baseRef });
        } catch (err) {
          computed = { diff: null, files: [], error: err && err.message ? err.message : String(err) };
        }
        if (computed && typeof computed.diff === 'string') {
          payload.diff = computed.diff;
          computedRan = true;
        }
        if (computed && Array.isArray(computed.files) && computed.files.length > 0) {
          payload.files = computed.files;
        }
      }
    }
    // §13 partial: no-op diff detector. If the orchestrator successfully ran
    // the diff but it found no changed files, surface `noOpDiff: true` so the
    // reviewer can ask "did you actually do the work?". Reviewer-informational
    // (a verify-only task may legitimately produce no diff). Always defined as
    // a boolean so projection consumers don't have to handle undefined.
    payload.noOpDiff = computedRan && (!Array.isArray(payload.files) || payload.files.length === 0);
    // §13 partial: scope-drift detection. Compare the actual changed files
    // against the plan's filesExpectedToChange. Files outside the plan are
    // flagged for the reviewer. Empty plan list (or no plan) → no flagging,
    // no false positives. Reviewer ultimately decides what to do with drift.
    if (Array.isArray(payload.files) && payload.files.length > 0) {
      enforceReviewFileContract(taskBeforeReview, payload.files);
      const expected = Array.isArray(taskBeforeReview?.plan?.filesExpectedToChange)
        ? taskBeforeReview.plan.filesExpectedToChange
        : [];
      if (expected.length > 0) {
        const drift = payload.files.filter((file) => !matchesAny(file, expected));
        if (drift.length > 0) payload.scopeDrift = drift;
      }
      // §14: configurable risk-policy classifier. Apply against the changed
      // files; if the result elevates riskLevel or flips requiresHumanApproval,
      // emit a RISK_CLASSIFIED event BEFORE the REVIEW_REQUESTED event so the
      // projection sees the elevated values when downstream consumers read.
      // Classifier never demotes — operator-supplied baselines are preserved.
      if (this.riskPolicy) {
        // §14 follow-up: also pull Bash commands the agent ran on this task
        // out of runtime_events so the classifier can match commandRules.
        // Best-effort: missing event log = file-only classification.
        let commands = [];
        if (this.eventLog && typeof this.eventLog.listEventsByTask === 'function') {
          try {
            const runtimeEvents = this.eventLog.listEventsByTask({ teamId: actor.teamId, taskId });
            commands = extractBashCommands(runtimeEvents);
          } catch {
            // ignore; commandRules just won't fire
          }
        }
        const classification = classifyRisk({
          files: payload.files,
          commands,
          policy: this.riskPolicy,
          currentRiskLevel: taskBeforeReview?.riskLevel ?? null,
          currentRequiresHumanApproval: taskBeforeReview?.requiresHumanApproval === true,
        });
        const elevatedLevel = classification.riskLevel !== (taskBeforeReview?.riskLevel ?? null);
        const elevatedFlag = classification.requiresHumanApproval !== (taskBeforeReview?.requiresHumanApproval === true);
        if (elevatedLevel || elevatedFlag) {
          this.taskBoard.appendEvent({
            teamId: actor.teamId,
            taskId,
            idempotencyKey: `${idempotencyKey}:risk_classified`,
            eventType: TASK_EVENT_TYPES.RISK_CLASSIFIED,
            actorId: actor.agentId,
            payload: {
              riskLevel: classification.riskLevel,
              requiresHumanApproval: classification.requiresHumanApproval,
              matchedRules: classification.matchedRules,
              source: 'risk_policy',
            },
          });
        }
      }
    }
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED,
      actorId: actor.agentId,
      payload,
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #reviewDecide(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const decision = requireString(args.decision, 'args.decision');
    if (decision !== 'approved' && decision !== 'changes_requested') {
      throw new Error(`unsupported review decision: ${decision}`);
    }
    // Self-review prevention (checklist §17): the agent that requested
    // the review cannot also decide it. Applies regardless of role.
    const currentTask = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
    if (currentTask?.review?.requestedBy && currentTask.review.requestedBy === actor.agentId) {
      throw new Error('review_decide: same agent cannot review own work');
    }
    const payload = { decision };
    if (typeof args.reason === 'string' && args.reason.length > 0) payload.reason = args.reason;
    if (Array.isArray(args.feedback)) {
      const cleaned = args.feedback
        .filter((f) => f && typeof f.file === 'string' && typeof f.comment === 'string')
        .map((f) => {
          const item = { file: f.file, comment: f.comment };
          // §17: optional severity tag — nit / minor / major / blocking.
          // Unknown values are dropped (no validation throw — better to keep
          // the comment than reject the whole review on a typo).
          if (typeof f.severity === 'string' && REVIEW_FEEDBACK_SEVERITIES.includes(f.severity)) {
            item.severity = f.severity;
          }
          return item;
        });
      if (cleaned.length > 0) payload.feedback = cleaned;
    }
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.REVIEW_DECIDED,
      actorId: actor.agentId,
      payload,
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #reviewList(actor) {
    // Wrap as `{ tasks }` for MCP structuredContent compatibility — see
    // task_list dispatch (L220) and #agentStatus for precedent. Key matches
    // task_list because these are filtered task projections.
    const tasks = this.taskBoard.listTasks({ teamId: actor.teamId }) || [];
    return { tasks: tasks.filter((t) => t && t.review && t.review.state === 'requested') };
  }

  #agentStatus(actor, args) {
    // Wrap returns in a record (`{ runtimes }` / `{ runtime }`) so MCP clients
    // that require structuredContent to be an object (Claude Code's MCP client
    // rejects top-level arrays/null as schema mismatches) accept the response.
    // Same precedent as task_list (L220) and #runtimeList (L1615).
    if (!this.runtimeRegistry) return { runtimes: [] };
    if (typeof args.runtimeId === 'string' && args.runtimeId.trim()) {
      const runtime = this.runtimeRegistry.getRuntime?.(args.runtimeId.trim()) || null;
      return { runtime: runtime && runtime.teamId === actor.teamId ? runtime : null };
    }
    if (typeof this.runtimeRegistry.listRuntimes !== 'function') return { runtimes: [] };
    return { runtimes: this.runtimeRegistry.listRuntimes({ teamId: actor.teamId }) };
  }

  #approvalRespond(actor, idempotencyKey, args) {
    if (!this.approvalBroker || typeof this.approvalBroker.respondApproval !== 'function') {
      throw new Error('approval broker is not configured');
    }
    const approvalId = requireString(args.approvalId, 'args.approvalId');
    const decision = requireString(args.decision, 'args.decision');
    const reason = typeof args.reason === 'string' ? args.reason : '';
    const previousApproval =
      typeof this.approvalBroker.getApproval === 'function'
        ? this.approvalBroker.getApproval(approvalId)
        : null;
    const approval = this.approvalBroker.respondApproval({
      approvalId,
      idempotencyKey,
      actor,
      decision,
      reason,
    });
    const isTeammate =
      approval?.metadata?.source === 'teammate' &&
      Array.isArray(approval?.metadata?.permissionSuggestions);

    // For teammate permissions, apply settings-file changes instead of (or in addition to)
    // sending control_response. The settings change is the primary mechanism; the
    // control_response is belt-and-suspenders that may unblock the current waiting prompt.
    let settingsResult = null;
    if (isTeammate && decision === 'approved') {
      settingsResult = this.#applyTeammatePermissionSuggestions(approval);
    }

    // If the approval has already been delivered to the adapter, do not send it again.
    // This provides durable exactly-once delivery semantics across process restarts.
    const runtimeResponse = this.#sendApprovalResponseToRuntime({
      approval,
      decision,
      reason,
      shouldSend: !approval.delivery,
    });

    const result = { ...approval };
    if (runtimeResponse) result.runtimeResponse = runtimeResponse;
    if (settingsResult) result.settingsResult = settingsResult;
    return result;
  }

  #approvalList(actor) {
    // Wrap as `{ approvals }` for MCP structuredContent compatibility.
    if (!this.readModel || typeof this.readModel.listApprovals !== 'function') {
      return { approvals: [] };
    }
    return { approvals: this.readModel.listApprovals({ teamId: actor.teamId }) };
  }

  #sendApprovalResponseToRuntime({ approval, decision, reason, shouldSend }) {
    if (!shouldSend) return null;
    const runtimeId =
      approval && typeof approval.runtimeId === 'string' && approval.runtimeId.trim()
        ? approval.runtimeId.trim()
        : null;
    if (!runtimeId) return null;
    const adapter = this.adapters?.get?.(runtimeId);
    if (!adapter || typeof adapter.approve !== 'function') return null;
    
    const response = adapter.approve({
      approvalId: requireString(approval.approvalId, 'approval.approvalId'),
      decision,
      reason,
    });
    
    // Mark as durably delivered so we don't send it again on idempotency retry
    if (this.approvalBroker && typeof this.approvalBroker.markApprovalDelivered === 'function') {
      this.approvalBroker.markApprovalDelivered({
        approvalId: approval.approvalId,
        runtimeId,
      });
    }
    
    return response;
  }

  #applyTeammatePermissionSuggestions(approval) {
    const suggestions = approval?.metadata?.permissionSuggestions;
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
    if (!this.projectCwd) return null;
    // Fire-and-forget async write — we return a promise the caller can await if needed
    return applyPermissionSuggestions({
      projectCwd: this.projectCwd,
      suggestions,
    });
  }

  #toolActivity(actor, args) {
    // Wrap as `{ toolCalls }` for MCP structuredContent compatibility.
    if (!this.readModel || typeof this.readModel.listToolCalls !== 'function') {
      return { toolCalls: [] };
    }
    return {
      toolCalls: this.readModel.listToolCalls({
        teamId: actor.teamId,
        runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
      }),
    };
  }

  #healthStatus(actor, args) {
    if (!this.readModel || typeof this.readModel.listApiRetries !== 'function') {
      return { retries: [], summary: { total: 0, rateLimited: 0, serverErrors: 0 } };
    }
    const retries = this.readModel.listApiRetries({
      teamId: actor.teamId,
      runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
    });
    const rateLimited = retries.filter((r) => r.error === 'rate_limit').length;
    const serverErrors = retries.filter((r) => r.errorStatus >= 500).length;
    return {
      retries,
      summary: { total: retries.length, rateLimited, serverErrors },
    };
  }

  #runtimeEvents(actor, args) {
    // Wrap as `{ events }` for MCP structuredContent compatibility.
    if (!this.readModel || typeof this.readModel.listRuntimeAudit !== 'function') {
      return { events: [] };
    }
    return {
      events: this.readModel.listRuntimeAudit({
        teamId: actor.teamId,
        runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
      }),
    };
  }

  #crossTeamMessages(actor, args) {
    // Wrap as `{ messages }` for MCP structuredContent compatibility — matches
    // #messageList shape (which already wraps).
    if (!this.readModel || typeof this.readModel.listCrossTeamMessages !== 'function') {
      return { messages: [] };
    }
    return {
      messages: this.readModel.listCrossTeamMessages({
        teamId: actor.teamId,
        limit: Number.isInteger(args.limit) ? args.limit : null,
      }),
    };
  }

  #crossTeamSend(actor, idempotencyKey, args) {
    const targetTeamId = requireString(args.targetTeamId, 'args.targetTeamId');
    const text = requireString(args.text, 'args.text');
    const targetAgentId = typeof args.targetAgentId === 'string' ? args.targetAgentId.trim() || 'lead' : 'lead';
    const chainDepth = typeof args.chainDepth === 'number' ? args.chainDepth : 0;
    const conversationId = typeof args.conversationId === 'string' ? args.conversationId : undefined;
    const replyToConversationId = typeof args.replyToConversationId === 'string' ? args.replyToConversationId : undefined;

    const from = `${actor.teamId}.${actor.agentId}`;
    const formattedText = formatCrossTeamText(from, chainDepth, text, {
      conversationId,
      replyToConversationId,
    });

    // Write incoming message to target team's inbox
    const incoming = this.broker.appendMessage({
      teamId: targetTeamId,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:incoming` : undefined,
      from: { kind: 'agent', id: actor.agentId, teamId: actor.teamId },
      to: { kind: 'agent', teamId: targetTeamId, agentId: targetAgentId },
      text: formattedText,
      kind: 'instruction',
      metadata: { source: CROSS_TEAM_SOURCE, chainDepth, conversationId, replyToConversationId },
    });

    // Write sent-copy to sender team's inbox
    this.broker.appendMessage({
      teamId: actor.teamId,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:sent` : undefined,
      from: { kind: 'agent', id: actor.agentId, teamId: actor.teamId },
      to: { kind: 'agent', teamId: targetTeamId, agentId: targetAgentId },
      text: formattedText,
      kind: 'instruction',
      metadata: { source: CROSS_TEAM_SENT_SOURCE, chainDepth, conversationId, replyToConversationId },
    });

    return { ok: true, messageId: incoming.messageId, targetTeamId, targetAgentId };
  }

  async #agentLaunch(actor, args) {
    if (!this.launchAgent) {
      throw new Error('agent_launch is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const agentId = requireString(args.agentId, 'args.agentId');
    const runtimeId = requireString(args.runtimeId, 'args.runtimeId');
    const command = requireString(args.command, 'args.command');
    const input = {
      teamId,
      agentId,
      runtimeId,
      command,
    };
    if (Array.isArray(args.args)) input.args = args.args.map(String);
    if (typeof args.cwd === 'string' && args.cwd.length > 0) input.cwd = args.cwd;
    if (args.env && typeof args.env === 'object' && !Array.isArray(args.env)) input.env = args.env;
    if (typeof args.providerId === 'string' && args.providerId.length > 0) input.providerId = args.providerId;
    if (typeof args.role === 'string' && args.role.length > 0) input.role = args.role;
    if (typeof args.skipPermissions === 'boolean') input.skipPermissions = args.skipPermissions;
    if (typeof args.prompt === 'string' && args.prompt.length > 0) input.prompt = args.prompt;

    // §8 slice 2: enforce worktree cwd when args.taskId points to a task with
    // a created worktree. Caller can either omit cwd (we auto-set) or pass the
    // exact worktree path. Mismatch is a hard error so a rogue agent can't
    // operate outside its task isolation.
    if (typeof args.taskId === 'string' && args.taskId.length > 0) {
      const task = this.taskBoard.getTask({ teamId, taskId: args.taskId });
      const wtPath = task?.worktree?.status === 'created' ? task.worktree.path : null;
      if (wtPath) {
        if (input.cwd && input.cwd !== wtPath) {
          throw new Error(
            `agent_launch: cwd ${input.cwd} must match task worktree ${wtPath} for task ${args.taskId}`,
          );
        }
        input.cwd = wtPath;
      }
      input.taskId = args.taskId;
    }

    return this.launchAgent(input);
  }

  async #agentStop(actor, args) {
    if (!this.stopAgent) {
      throw new Error('agent_stop is not configured on this facade');
    }
    const runtimeId = requireString(args.runtimeId, 'args.runtimeId');
    const input = { runtimeId };
    if (typeof args.signal === 'string' && args.signal.length > 0) input.signal = args.signal;
    return this.stopAgent(input);
  }

  /**
   * agent_swap_provider — swap a single agent's provider mid-team.
   *
   * The agent's process is stopped, the team config is updated with
   * the new providerId + corresponding CLI command, and team_launch
   * relaunches the (now-stopped) target with the new provider while
   * leaving the rest of the team alive (team_launch skips members
   * with a live adapter). The same runtimeId is reused so prior
   * runtime_events + message_send history stay attached.
   *
   * After the relaunch, posts a system message to the lead so it can
   * adjust delegations if needed ("the developer is now on Codex,
   * was Claude — continuing prior task").
   *
   * Args:
   *   - teamId      string  Required. Existing team.
   *   - agentId     string  Required. Lead or teammate agentId.
   *   - providerId  string  Required. 'anthropic' | 'openai' | 'gemini' | 'opencode'.
   *
   * Returns:
   *   { teamId, agentId, previousProviderId, providerId, command, relaunched }
   */
  async #agentSwapProvider(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('agent_swap_provider: teamConfigRegistry is not configured');
    }
    if (!this.launchAgent) {
      throw new Error('agent_swap_provider: launchAgent is not configured');
    }
    if (!this.stopAgent) {
      throw new Error('agent_swap_provider: stopAgent is not configured');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const agentId = requireString(args.agentId, 'args.agentId');
    const providerId = requireString(args.providerId, 'args.providerId');

    // Provider → CLI command mapping lives in src/team/providerCommands.js
    // so team_create's normalizeMember and this swap path share a single
    // source of truth. Throwing on unknown providers (rather than silently
    // falling through to 'claude') prevents the operator from being stuck
    // with a wrong-binary agent that spawns and immediately ENOENTs.
    const command = commandForProvider(providerId);
    if (!command) {
      const known = Object.keys(PROVIDER_COMMANDS).join(', ');
      throw new Error(
        `agent_swap_provider: unknown providerId "${providerId}". Known: ${known}.`,
      );
    }

    const config = this.teamConfigRegistry.getTeam(teamId);
    if (!config) {
      throw new Error(`agent_swap_provider: no config for teamId ${teamId}`);
    }

    // Locate the target member (lead OR one of teammates) and capture
    // the previous providerId for the lead-notification message below.
    const isLead = config.lead?.agentId === agentId;
    let previousProviderId;
    if (isLead) {
      previousProviderId = config.lead.providerId || null;
    } else {
      const teammate = (config.teammates || []).find((m) => m && m.agentId === agentId);
      if (!teammate) {
        throw new Error(
          `agent_swap_provider: no member with agentId "${agentId}" in team "${teamId}"`,
        );
      }
      previousProviderId = teammate.providerId || null;
    }

    if (previousProviderId === providerId) {
      // Idempotent no-op — operator double-clicked or the UI sent the
      // same provider twice. Don't churn the agent for no reason.
      return {
        teamId,
        agentId,
        previousProviderId,
        providerId,
        command,
        relaunched: false,
      };
    }

    // Build the updated TeamConfig. The original is immutable from
    // outside (we don't have a setter on TeamConfig), so we re-construct
    // from its toJSON snapshot with the target member's fields swapped.
    const snapshot = typeof config.toJSON === 'function'
      ? config.toJSON()
      : { teamId: config.teamId, lead: config.lead, teammates: config.teammates };
    const nextLead = isLead
      ? { ...snapshot.lead, providerId, command }
      : snapshot.lead;
    const nextTeammates = isLead
      ? snapshot.teammates
      : snapshot.teammates.map((m) =>
        m && m.agentId === agentId ? { ...m, providerId, command } : m,
      );
    const updated = new TeamConfig({
      teamId: snapshot.teamId,
      lead: nextLead,
      teammates: nextTeammates,
      validation: snapshot.validation,
    });
    this.teamConfigRegistry.registerTeam(updated);

    // Stop the target agent if it's running so the relaunch below
    // picks it up. Look up the runtime by the derived runtimeId
    // (`runtime-<teamId>-<agentId>`), which matches what team_launch
    // uses to compose member runtimeIds.
    const runtimeId = `runtime-${teamId}-${agentId}`;
    let wasRunning = false;
    if (this.runtimeRegistry && typeof this.runtimeRegistry.getRuntime === 'function') {
      const existing = this.runtimeRegistry.getRuntime(runtimeId);
      if (existing && existing.status === 'running') {
        wasRunning = true;
        try {
          await this.stopAgent({ runtimeId, signal: 'SIGTERM' });
        } catch (err) {
          // Stop failure shouldn't block the swap — the previous binary
          // might already be wedged. Log and proceed; team_launch's
          // stale-row cleanup will catch the dangling registry row.
          // eslint-disable-next-line no-console
          console.warn(
            `[agent_swap_provider] stopAgent(${runtimeId}) failed: ${err?.message || err}`,
          );
        }
      }
    }

    // Relaunch via team_launch — it only spawns members whose adapter
    // isn't live, so the rest of the team is untouched. The target
    // (just stopped, or never started) spawns with the new command +
    // providerId pulled from the updated team config.
    let relaunched = false;
    try {
      await this.#teamLaunch(actor, { teamId });
      relaunched = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agent_swap_provider] team_launch after swap failed: ${err?.message || err}`,
      );
    }

    // Notify the lead. Skip when the swapped agent IS the lead (no one
    // to tell) and when broker/launchAgent are missing in test harness.
    if (!isLead && this.broker && typeof this.broker.appendMessage === 'function') {
      try {
        const previousBrand = previousProviderId || 'unknown';
        const text = [
          `[system] ${agentId} is now running on ${providerId} (was ${previousBrand}).`,
          wasRunning
            ? 'Their prior process was stopped and relaunched; runtime history is preserved.'
            : 'They were not running at swap time; new provider takes effect on next launch.',
          'Continue delegating as normal — Symphony handles the protocol switch transparently.',
        ].join(' ');
        this.broker.appendMessage({
          teamId,
          fromAgentId: 'symphony',
          toAgentId: config.lead.agentId,
          kind: MESSAGE_KINDS.SYSTEM,
          body: { text },
          idempotencyKey: `agent-swap-notify-${teamId}-${agentId}-${Date.now()}`,
        });
      } catch (err) {
        // Notification failure is non-fatal — swap already happened.
        // eslint-disable-next-line no-console
        console.warn(
          `[agent_swap_provider] lead notification failed: ${err?.message || err}`,
        );
      }
    }

    return {
      teamId,
      agentId,
      previousProviderId,
      providerId,
      command,
      relaunched,
      wasRunning,
    };
  }

  #teamCreate(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    const config = new TeamConfig({
      teamId: requireString(args.teamId, 'args.teamId'),
      lead: args.lead || {},
      teammates: Array.isArray(args.teammates) ? args.teammates : [],
      validation: args.validation || null,
    });
    this.teamConfigRegistry.registerTeam(config);
    return config.toJSON ? config.toJSON() : { teamId: config.teamId, lead: config.lead, teammates: config.teammates };
  }

  #teamList(actor) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    return this.teamConfigRegistry.listTeams().map((c) =>
      c.toJSON ? c.toJSON() : { teamId: c.teamId, lead: c.lead, teammates: c.teammates },
    );
  }

  #teamDelete(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const deleted = this.teamConfigRegistry.deleteTeam(teamId);
    return { teamId, deleted };
  }

  async #teamLaunch(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    if (!this.launchAgent) {
      throw new Error('launchAgent is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const config = this.teamConfigRegistry.getTeam(teamId);
    if (!config) {
      throw new Error(`team_launch: no config for teamId ${teamId}`);
    }
    const members = [config.lead, ...config.teammates];
    const results = [];

    // PROJECT.md §4 — agent isolation contract: HARD REFUSAL gate.
    //
    // Before any agent in this team spawns, prove the workspace is safe:
    //   1. projectCwd must be set (we have a workspace).
    //   2. installDir must be set (we know where Symphony lives).
    //   3. The two paths must be disjoint — neither equal nor nested.
    //
    // If any of those fail, refuse to launch with a clear error. Silently
    // continuing has caused agents to spawn inside Symphony's own folder
    // (and read its source) — never again. The defaults that get the
    // sidecar here in an unsafe state are bugs (env var misset, picker
    // skipped, install layout broken), and the operator needs to know.
    //
    // Test-mode carve-out: when BOTH projectCwd and installDir are unset
    // we're in a unit-test harness with a fake launchAgent — there's
    // nothing real to refuse, and forcing every test to thread both
    // values through would be noise. The carve-out only triggers when
    // the facade is fully unconfigured; production (dev-api-server.mjs)
    // always sets installDir, so the carve-out can never silently fire
    // there.
    //
    // The deny-rule writer that follows is defense in depth — it only
    // helps if `--dangerously-skip-permissions` honors deny patterns
    // (empirical, see §4 outcomes 1/2/3). The hard refusal above is the
    // primary guarantee: agents simply don't get to spawn when the
    // workspace can see Symphony.
    const isolationConfigured =
      (typeof this.projectCwd === 'string' && this.projectCwd.length > 0)
      || (typeof this.installDir === 'string' && this.installDir.length > 0);
    if (isolationConfigured) {
      assertWorkspaceIsolated({
        projectCwd: this.projectCwd,
        installDir: this.installDir,
      });

      // Defense in depth: write `permissions.deny` rules into the workspace's
      // `.claude/settings.local.json` so Claude Code's native CLI tools
      // refuse to touch Symphony's source if they ever try. Idempotent on
      // repeat launches (Stop + Resume).
      try {
        await writeWorkspaceIsolationSettings({
          projectCwd: this.projectCwd,
          installDir: this.installDir,
        });
      } catch (err) {
        // Best-effort at this point — the assertion above already proved
        // the workspace is safe. A write failure means the secondary
        // defense isn't in place, but the primary (correct cwd, scrubbed
        // env, validated workspace) still holds.
        // eslint-disable-next-line no-console
        console.warn(
          `[team_launch] writeWorkspaceIsolationSettings failed: ${err?.message || err}`,
        );
      }
    }

    // Pull the project root so the system prompt can tell agents where the
    // code they're working on actually lives. Falls back to '.' if no cwd
    // was set on the lead — agents will still boot, just without a path.
    //
    // Bug 2 from 2026-05-12 triage: if config.lead.cwd is RELATIVE
    // (e.g. '.' or '..' — the symphony-demo seed stores '.'), resolve
    // it against the sidecar's projectCwd. Otherwise the agent's
    // system prompt shows "Project root: ." which is meaningless after
    // the agent's process forks into its own cwd, and the spawn
    // inherits a path that doesn't necessarily match what the operator
    // expected. resolveTeamCwd is also used below for member.cwd on the
    // spawn input so both sources get the same treatment.
    const rawTeamCwd = (typeof config.lead?.cwd === 'string' && config.lead.cwd.length > 0)
      ? config.lead.cwd
      : '.';
    const teamCwd = resolveAgainstProjectRoot(rawTeamCwd, this.projectCwd);
    for (const member of members) {
      const runtimeId = `runtime-${teamId}-${member.agentId}`;
      const existing = this.runtimeRegistry?.getRuntime?.(runtimeId);
      if (existing && existing.status === 'running') {
        const hasLiveAdapter = this.adapters && typeof this.adapters.has === 'function' && this.adapters.has(runtimeId);
        if (hasLiveAdapter) {
          results.push({ runtimeId, agentId: member.agentId, status: 'already_running' });
          continue;
        }
        // Stale-runtime cleanup (Bug 4 from 2026-05-12 triage). The registry
        // row says `running` but no in-process adapter exists, which means
        // the sidecar restarted while the row was alive — and the old
        // child process is gone. Leaving the row marked `running` keeps
        // the §13 stuck-runtime monitor flagging it, which surfaces as
        // "stuck runtime" toasts in the UI right when the operator clicks
        // Resume team. Mark it stopped before we re-spawn so the monitor
        // sees a clean slate.
        if (typeof this.runtimeRegistry?.markRuntimeStopped === 'function') {
          try {
            this.runtimeRegistry.markRuntimeStopped({
              runtimeId,
              status: 'stopped',
              exitCode: null,
              signal: null,
              stoppedAt: new Date().toISOString(),
            });
          } catch {
            // Best-effort — re-spawn proceeds either way. A failure to
            // clear the registry row only means we'll briefly see a
            // duplicate stuck-runtime toast; not worth blocking launch.
          }
        }
      }
      try {
        const launchInput = {
          teamId,
          agentId: member.agentId,
          runtimeId,
          command: member.command,
        };
        if (Array.isArray(member.args) && member.args.length > 0) launchInput.args = member.args;
        // Bug 2 — apply the same resolveAgainstProjectRoot to the
        // spawn's cwd as we did to teamCwd above. The spawn's working
        // directory determines where the child agent process actually
        // runs; an absolute path is the only way to guarantee it
        // matches what the system prompt advertises.
        if (typeof member.cwd === 'string' && member.cwd.length > 0) {
          launchInput.cwd = resolveAgainstProjectRoot(member.cwd, this.projectCwd);
        } else if (teamCwd && teamCwd !== '.') {
          // No member-specific cwd — inherit the resolved teamCwd so
          // every agent in the team sees the same project root.
          launchInput.cwd = teamCwd;
        }
        if (member.env && typeof member.env === 'object' && Object.keys(member.env).length > 0) launchInput.env = member.env;
        if (typeof member.providerId === 'string' && member.providerId.length > 0) launchInput.providerId = member.providerId;
        if (typeof member.role === 'string' && member.role.length > 0) launchInput.role = member.role;
        if (typeof member.skipPermissions === 'boolean') launchInput.skipPermissions = member.skipPermissions;
        // Pass the launch prompt through (foundry materialize sets this on
        // the lead so the team starts knowing about the project docs).
        // LocalToadRuntime.launchAgent forwards it to the adapter as the
        // first turn after spawn — see launchAgent.
        // If both prompt and promptPath are empty (user left the
        // leadPrompt textarea blank and didn't point to a file), the
        // agent boots and stays idle until the human sends the first
        // message — this matches upstream's behavior with
        // `--team-bootstrap-user-prompt-file` being optional.
        if (typeof member.prompt === 'string' && member.prompt.length > 0) launchInput.prompt = member.prompt;
        if (typeof member.promptPath === 'string' && member.promptPath.length > 0) launchInput.promptPath = member.promptPath;
        // Each member boots with a role-aware system prompt: lead gets the
        // orchestrator manifest (teammates + tools), teammates get their
        // role guidance + the lead's name. This is our equivalent of
        // upstream's --team-bootstrap-spec — same idea, public CLI flag.
        // Skipped when the team config supplied a literal --append-system-prompt
        // in member.args (handled inside LocalToadRuntime so we don't
        // double-check here).
        launchInput.systemPrompt = buildAgentSystemPrompt({
          teamId: config.teamId,
          lead: config.lead,
          teammates: config.teammates,
          member,
          cwd: teamCwd,
        });
        // The lead needs a stdin kickoff to actually start generating —
        // claude's stream-json mode only produces output in response to
        // stdin user messages, so even with a full system prompt it sits
        // silent until something arrives. Teammates intentionally stay
        // quiet: they only act on lead-issued message_send turns, not on
        // boot. If the user/foundry already supplied a real prompt, that
        // wins (the kickoff would be redundant).
        const isLead = member.agentId === config.lead.agentId;
        const hasUserPrompt = (typeof member.prompt === 'string' && member.prompt.length > 0)
          || (typeof member.promptPath === 'string' && member.promptPath.length > 0);
        if (isLead && !hasUserPrompt) {
          launchInput.prompt = [
            'Boot complete. Your team manifest is loaded in the system prompt above — including who you are, your teammates, and the project root.',
            'Briefly tell the operator you are online, then start orchestrating: inspect the project (Read/Bash as needed), identify the most useful work, create concrete tasks via task_create, and assign each to the right teammate via message_send. Do not wait for the operator to spell out the work — drive it forward yourself. The operator can interrupt or redirect you any time.',
          ].join('\n\n');
        }
        const runtime = await this.launchAgent(launchInput);
        results.push({ runtimeId, agentId: member.agentId, status: runtime?.status || 'starting' });
      } catch (err) {
        results.push({
          runtimeId,
          agentId: member.agentId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { teamId, members: results };
  }

  #taskPlanPropose(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const payload = {};
    if (typeof args.summary === 'string' && args.summary.length > 0) payload.summary = args.summary;
    if (Array.isArray(args.filesExpectedToChange)) {
      payload.filesExpectedToChange = args.filesExpectedToChange.filter(
        (f) => typeof f === 'string' && f.length > 0,
      );
    }
    if (Array.isArray(args.approach)) payload.approach = args.approach.filter((s) => typeof s === 'string');
    if (Array.isArray(args.risks)) payload.risks = args.risks.filter((s) => typeof s === 'string');
    if (Array.isArray(args.validationPlan)) payload.validationPlan = args.validationPlan.filter((s) => typeof s === 'string');
    if (typeof args.requiresApproval === 'boolean') payload.requiresApproval = args.requiresApproval;
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.PLAN_PROPOSED,
      actorId: actor.agentId,
      payload,
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #taskPlanDecide(actor, idempotencyKey, args, decision) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const current = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
    if (current?.plan?.proposedBy && current.plan.proposedBy === actor.agentId) {
      throw new Error(
        decision === 'approved'
          ? 'task_plan_approve: same agent cannot approve own plan'
          : 'task_plan_reject: same agent cannot reject own plan',
      );
    }
    const payload = {};
    if (typeof args.reason === 'string' && args.reason.length > 0) payload.reason = args.reason;
    const eventType = decision === 'approved' ? TASK_EVENT_TYPES.PLAN_APPROVED : TASK_EVENT_TYPES.PLAN_REJECTED;
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType,
      actorId: actor.agentId,
      payload,
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  async #validationRun(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const kind = requireString(args.kind, 'args.kind');
    const validKinds = ['install', 'lint', 'typecheck', 'test', 'build', 'security'];
    if (!validKinds.includes(kind)) {
      throw new Error(`validation_run: unknown kind "${kind}"`);
    }
    // Idempotency pre-flight: if an event with this idempotencyKey already
    // exists, return its payload without re-running the spawn. The taskBoard
    // would dedup the appendEvent anyway, but doing it here prevents the
    // wasted spawn (and avoids returning a fresh-spawn payload that doesn't
    // match the persisted event).
    if (idempotencyKey) {
      const existingTask = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
      const cached = Array.isArray(existingTask?.history)
        ? existingTask.history.find((e) => e?.idempotencyKey === idempotencyKey
            && e?.eventType === TASK_EVENT_TYPES.VALIDATION_RUN)
        : null;
      if (cached) return cached.payload;
    }
    // Resolve the command: explicit override → team config → null
    let command = typeof args.command === 'string' && args.command.length > 0 ? args.command : null;
    if (!command && this.teamConfigRegistry) {
      const team = this.teamConfigRegistry.getTeam?.(actor.teamId);
      const key = `${kind}Command`;
      const fromConfig = team?.validation?.[key];
      if (typeof fromConfig === 'string' && fromConfig.length > 0) command = fromConfig;
    }
    let payload;
    if (!command) {
      // Not configured and no override — explicit "not_run" record per checklist §18
      payload = {
        kind,
        command: null,
        exitCode: null,
        durationMs: 0,
        verdict: 'not_run',
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    } else {
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
        ? args.cwd
        : (this.projectCwd || process.cwd());
      const result = await this.spawnValidation(command, { cwd });
      const stdoutText = typeof result.stdout === 'string' ? result.stdout : '';
      const stderrText = typeof result.stderr === 'string' ? result.stderr : '';
      payload = {
        kind,
        command,
        exitCode: Number.isFinite(result.exitCode) ? result.exitCode : null,
        durationMs: Number.isFinite(result.durationMs) ? result.durationMs : 0,
        verdict: result.exitCode === 0 ? 'passed' : 'failed',
        stdout: truncate(stdoutText, 4096),
        stderr: truncate(stderrText, 4096),
        stdoutTruncated: stdoutText.length > 4096,
        stderrTruncated: stderrText.length > 4096,
      };
    }
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
      actorId: actor.agentId,
      payload,
    });
    return payload;
  }

  async #runtimeSendInput(actor, args) {
    const runtimeId = requireString(args.runtimeId, 'args.runtimeId');
    const text = requireString(args.text, 'args.text');
    const adapter = this.adapters?.get?.(runtimeId);
    if (!adapter || typeof adapter.sendTurn !== 'function') {
      throw new Error(`runtime_send_input: no adapter for runtime ${runtimeId}`);
    }
    return adapter.sendTurn({ message: { text } });
  }

  async #teamStop(actor, args) {
    if (!this.runtimeRegistry || typeof this.runtimeRegistry.listRuntimes !== 'function') {
      throw new Error('runtimeRegistry is not configured on this facade');
    }
    if (!this.stopAgent) {
      throw new Error('stopAgent is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const signal = typeof args.signal === 'string' && args.signal.length > 0 ? args.signal : null;
    const runtimes = this.runtimeRegistry.listRuntimes({ teamId })
      .filter((r) => r && r.status === 'running');
    const results = [];
    for (const r of runtimes) {
      try {
        const stopInput = { runtimeId: r.runtimeId };
        if (signal) stopInput.signal = signal;
        const stopped = await this.stopAgent(stopInput);
        results.push({ runtimeId: r.runtimeId, agentId: r.agentId, status: stopped?.status || 'stopped' });
      } catch (err) {
        results.push({
          runtimeId: r.runtimeId,
          agentId: r.agentId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { teamId, members: results };
  }

  #diagnosticsRun() {
    return runDiagnostics({
      teamConfigRegistry: this.teamConfigRegistry,
      spawnValidation: this.spawnValidation,
      dbPath: this.dbPath,
      runtimeRegistry: this.runtimeRegistry,
      eventLog: this.eventLog,
    });
  }

  /**
   * §20: structured audit export for a single task. Returns the current
   * projection plus every stored event the orchestrator can correlate to it.
   *
   *   task           — projection (current state, with all derived fields)
   *   taskEvents     — chronological task_events for this task (CREATED,
   *                    STATUS_CHANGED, COMMENT_ADDED, REVIEW_*, VALIDATION_RUN,
   *                    PLAN_*, WORKTREE_*) sourced from the task board
   *   runtimeEvents  — runtime_events whose runtime is pinned to this task
   *                    (via §11 runtime_instances.task_id), or [] when no
   *                    eventLog with listEventsByTask() is configured
   *
   * Read-only; available to every role via COMMON_READ_TOOLS.
   */
  #taskHistoryExport(actor, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const task = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
    const taskEvents = typeof this.taskBoard.listEvents === 'function'
      ? this.taskBoard.listEvents({ teamId: actor.teamId, taskId })
      : [];
    const runtimeEvents = this.eventLog && typeof this.eventLog.listEventsByTask === 'function'
      ? this.eventLog.listEventsByTask({ teamId: actor.teamId, taskId })
      : [];
    return { task, taskEvents, runtimeEvents };
  }

  /**
   * §14: human approval signal. Emits TASK_HUMAN_APPROVED. Restricted to
   * `lead` and `human` via roleAuthority (the four other roles are not in
   * the explicit allowlist and the wildcard catches lead+human).
   */
  #humanApprove(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const reason = typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : null;
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.HUMAN_APPROVED,
      actorId: actor.agentId,
      payload: reason ? { reason } : {},
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  /**
   * §13 follow-up: list runtimes whose `runtime_events` stream has been
   * silent past the inactivity threshold. Pulls running runtimes from the
   * registry, looks up the latest event timestamp per runtime via the
   * event log's SQL aggregation, then runs the pure detector.
   *
   * Args: { thresholdMs?: number }. Default 15 minutes.
   * Returns: [{ runtimeId, taskId, teamId, agentId, lastEventAt, silentMs, thresholdMs }]
   * Read-only; available to every role via COMMON_READ_TOOLS.
   */
  /**
   * runtime_list — return active and recently-stopped runtimes for a team.
   * The UI's useToadData hook calls this on every load to populate the
   * agent panel. Without it, the side panel renders every agent as idle
   * even when claude.exe processes are alive and orchestrating.
   *
   * Args: { teamId?: string }. Falls back to actor.teamId.
   * Returns: { runtimes: Runtime[] } where each Runtime has runtimeId, agentId,
   *   status, pid, startedAt, etc. — same shape returned by
   *   SqliteRuntimeRegistry.listRuntimes().
   */
  #runtimeList(actor, args) {
    if (!this.runtimeRegistry || typeof this.runtimeRegistry.listRuntimes !== 'function') {
      return { runtimes: [] };
    }
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId
      : actor.teamId;
    const runtimes = this.runtimeRegistry.listRuntimes({ teamId });
    if (!Array.isArray(runtimes) || runtimes.length === 0) return { runtimes: [] };

    // Enrich each runtime with derivable stats. Real CPU/memory sampling
    // would need a per-pid lib (pidusage) — left as 0 for now and the UI
    // hides those columns when 0. Uptime + req count + token totals are
    // cheap to compute from data we already have.
    const now = Date.now();
    const events = this.eventLog && typeof this.eventLog.listEvents === 'function'
      ? this.eventLog.listEvents({ teamId })
      : [];
    const reqsByRuntime = new Map();
    let lastEventByRuntime = new Map();
    // Per-runtime token + cost totals. The Cockpit inspector's "Used
    // X / 200,000" meter reads tokensIn + tokensOut on each runtime row.
    // Without this aggregation the meter is always 0 even when an agent
    // has been talking — that's the bug the user hit on the live screen.
    const tokensByRuntime = new Map();
    // Per-runtime model identity. Claude's stream-json frames carry the
    // model that handled the turn on both the `assistant` frame
    // (`message.model`) and the terminal `result` frame (`model`).
    // We capture the latest non-empty model per runtime so the
    // Inspector's "Provider / model" row reads e.g.
    // "Claude / claude-sonnet-4-20250514" instead of "claude / unknown".
    // "Latest wins" so a provider swap to codex shows the new model on
    // the very next turn without staleness.
    const modelByRuntime = new Map();
    const recordModel = (runtimeId, candidate, createdAt) => {
      if (typeof runtimeId !== 'string' || runtimeId.length === 0) return;
      if (typeof candidate !== 'string' || candidate.length === 0) return;
      const prev = modelByRuntime.get(runtimeId);
      if (!prev || (createdAt && prev.at && createdAt >= prev.at) || !prev.at) {
        modelByRuntime.set(runtimeId, { model: candidate, at: createdAt || null });
      }
    };
    for (const e of events) {
      if (e.eventType === 'tool_use') {
        reqsByRuntime.set(e.runtimeId, (reqsByRuntime.get(e.runtimeId) || 0) + 1);
      }
      if (e.createdAt) {
        const prev = lastEventByRuntime.get(e.runtimeId);
        if (!prev || prev < e.createdAt) lastEventByRuntime.set(e.runtimeId, e.createdAt);
      }
      const raw = e.payload?.raw;
      // Model — pluck from any frame that carries it. Assistant frames
      // expose `message.model`, result frames expose top-level `model`.
      // Both providers (Claude / Codex / Gemini) follow the same
      // convention in their stream-json output.
      if (raw && typeof raw === 'object') {
        if (typeof raw.model === 'string') recordModel(e.runtimeId, raw.model, e.createdAt);
        const inner = raw.message && typeof raw.message === 'object' ? raw.message : null;
        if (inner && typeof inner.model === 'string') recordModel(e.runtimeId, inner.model, e.createdAt);
      }
      // Token + cost: same filter as project_state_describe — only
      // turn_completed events with payload.raw.type === 'result' carry
      // the usage block from the stream-json result frame.
      if (e.eventType === 'turn_completed') {
        if (raw && raw.type === 'result' && typeof e.runtimeId === 'string' && e.runtimeId.length > 0) {
          let bucket = tokensByRuntime.get(e.runtimeId);
          if (!bucket) {
            bucket = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
            tokensByRuntime.set(e.runtimeId, bucket);
          }
          const u = raw.usage;
          if (u && typeof u === 'object') {
            if (typeof u.input_tokens === 'number') bucket.tokensIn += u.input_tokens;
            if (typeof u.output_tokens === 'number') bucket.tokensOut += u.output_tokens;
          }
          if (typeof raw.total_cost_usd === 'number') bucket.costUsd += raw.total_cost_usd;
        }
      }
    }

    const enriched = runtimes.map((r) => {
      const startedMs = r.startedAt ? Date.parse(r.startedAt) : NaN;
      const stoppedMs = r.stoppedAt ? Date.parse(r.stoppedAt) : NaN;
      const endMs = Number.isFinite(stoppedMs) ? stoppedMs : now;
      const uptimeSec = Number.isFinite(startedMs) ? Math.max(0, Math.floor((endMs - startedMs) / 1000)) : 0;
      const hh = String(Math.floor(uptimeSec / 3600)).padStart(2, '0');
      const mm = String(Math.floor((uptimeSec % 3600) / 60)).padStart(2, '0');
      const ss = String(uptimeSec % 60).padStart(2, '0');
      const tokens = tokensByRuntime.get(r.runtimeId) || { tokensIn: 0, tokensOut: 0, costUsd: 0 };
      const modelEntry = modelByRuntime.get(r.runtimeId);
      return {
        ...r,
        uptime: `${hh}:${mm}:${ss}`,
        reqs: reqsByRuntime.get(r.runtimeId) || 0,
        lastEventAt: lastEventByRuntime.get(r.runtimeId) || null,
        tokensIn: tokens.tokensIn,
        tokensOut: tokens.tokensOut,
        costUsd: tokens.costUsd,
        // Latest model the runtime has used. Empty string when the agent
        // hasn't completed a turn yet; the UI falls back to the friendly
        // provider name in that case.
        model: modelEntry?.model || '',
      };
    });
    return { runtimes: enriched };
  }

  /**
   * usage_summary — surface the operator's spend + plan tier in one call.
   * The UI's top-bar chip uses this to show "Max plan · $1.50 · 5/5 runtimes"
   * without polling 3 separate endpoints.
   *
   * Plan tier comes from `claude auth status --json` via the existing
   * providerAuth helper. Token and cost totals are aggregated from
   * runtime_events.turn_completed payloads (the stream-json `result` event
   * carries `total_cost_usd` and `usage`).
   *
   * Returns:
   *   {
   *     plan: { tier, loggedIn, provider },
   *     totals: { tokensIn, tokensOut, costUsd },
   *     runtimes: { live, total },
   *   }
   *
   * Note: this is best-effort + non-authoritative. Real plan-quota %s
   * (5h / weekly with reset countdowns) live behind claude's interactive
   * /usage slash command — would require node-pty to scrape, queued as a
   * follow-up.
   */
  async #driftRun(actor, args) {
    if (!this.driftEngine) {
      throw new Error('drift engine not configured for this facade');
    }
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId
      : actor.teamId;
    const trigger = ['manual', 'periodic', 'task_event'].includes(args?.trigger)
      ? args.trigger
      : 'manual';
    return this.driftEngine.runDrift({ teamId, trigger });
  }

  async #driftCorrectionCreate(actor, idempotencyKey, args) {
    const driftStore = this.driftEngine?.store ?? null;
    if (!driftStore) {
      throw new Error('drift_correction_create: driftStore not configured for this facade (driftEngine missing or has no .store)');
    }
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId
      : actor.teamId;
    // driftCorrection.js expects taskBoard.create({teamId, subject, description, riskLevel, source})
    // returning {taskId, ...}. Adapt InMemoryTaskBoard's appendEvent API.
    const rawBoard = this.taskBoard;
    const taskBoardAdapter = {
      create({ teamId: tId, subject, description, riskLevel, source }) {
        const taskId = randomUUID();
        rawBoard.appendEvent({
          teamId: tId,
          taskId,
          idempotencyKey,                    // FORWARD the caller's key
          eventType: TASK_EVENT_TYPES.CREATED,
          actorId: 'drift_correction',
          payload: { subject, description: description || '', riskLevel, source },
        });
        return { taskId, teamId: tId, subject, description, riskLevel, source };
      },
    };
    return createDriftCorrection({
      teamId,
      findingIds: args?.findingIds,
      subject: args?.subject,
      description: args?.description,
      riskLevel: args?.riskLevel,
      taskBoard: taskBoardAdapter,
      driftStore,
    });
  }

  async #usageSummary(_actor, _args) {
    // Plan tier — graceful fallback when claude isn't installed/signed in.
    const plan = { tier: 'unknown', loggedIn: false, provider: 'claude' };
    // Use the injected spawn (test override) or the real spawnSync. The
    // facade constructor used to default this to null which silently
    // skipped the auth probe in production — confirmed regression.
    const spawnSyncImpl = this.providerAuthSpawnSync || spawnSync;
    if (spawnSyncImpl) {
      try {
        const result = spawnSyncImpl('claude', ['auth', 'status', '--json'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });
        if (result && result.status === 0 && typeof result.stdout === 'string') {
          const parsed = JSON.parse(result.stdout);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.subscriptionType === 'string') plan.tier = parsed.subscriptionType;
            if (parsed.loggedIn === true) plan.loggedIn = true;
          }
        }
      } catch {
        // Leave defaults — UI renders "unknown plan".
      }
    }

    // Plan-quota %s — only available via claude's interactive /usage
    // slash command, which requires a pty session. We cache for 90s
    // because spawning claude takes ~2s and quotas don't change quickly.
    // Probe runs in parallel with the rest of the aggregation below.
    const quotaPromise = this.#getCachedClaudeQuota();

    // Aggregate token + cost totals from turn_completed events. We sum
    // ALL events the event log has (not filtered by team) so the chip
    // shows the operator their cumulative spend across every team they've
    // ever launched in this project.
    //
    // Bucket by provider too, so the Plan Usage panel can show
    // "Symphony has used X tokens / $Y of <provider>" — the only
    // honest usage signal we have for Codex/Gemini, which lack a
    // `--usage` equivalent (Claude's `/usage` probe handles plan
    // quotas separately above). For Claude this Symphony-side number
    // complements the plan probe ("project spend" vs "plan budget").
    //
    // Provider attribution: each runtime_event carries the runtimeId
    // it was emitted on. We map runtimeId → team_id → team config →
    // member.providerId (the lead OR a teammate, depending on which
    // agent ran the turn). This is cached in a Map for O(1) lookups
    // across the event loop, which can be O(thousands) on long teams.
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    const providerUsage = new Map();
    const ensureBucket = (providerId) => {
      let b = providerUsage.get(providerId);
      if (!b) {
        b = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
        providerUsage.set(providerId, b);
      }
      return b;
    };
    // Pre-build runtimeId → providerId. Reads every team config once.
    // Quietly skips runtimes whose team config has been deleted (rare
    // but possible after team_delete); their tokens roll into the
    // aggregate-only `totals` and don't get a per-provider home.
    const runtimeProvider = new Map();
    if (
      this.runtimeRegistry && typeof this.runtimeRegistry.listRuntimes === 'function'
      && this.teamConfigRegistry && typeof this.teamConfigRegistry.getTeam === 'function'
    ) {
      try {
        const allRuntimes = this.runtimeRegistry.listRuntimes();
        const teamCache = new Map();
        for (const rt of allRuntimes) {
          if (!rt?.runtimeId || !rt?.teamId || !rt?.agentId) continue;
          let team = teamCache.get(rt.teamId);
          if (team === undefined) {
            team = this.teamConfigRegistry.getTeam(rt.teamId) || null;
            teamCache.set(rt.teamId, team);
          }
          if (!team) continue;
          const members = [team.lead, ...(Array.isArray(team.teammates) ? team.teammates : [])];
          const member = members.find((m) => m && m.agentId === rt.agentId);
          if (member && typeof member.providerId === 'string' && member.providerId.length > 0) {
            runtimeProvider.set(rt.runtimeId, member.providerId);
          }
        }
      } catch {
        // Best-effort — leave runtimeProvider empty so the loop below
        // just skips per-provider attribution.
      }
    }
    if (this.eventLog && typeof this.eventLog.listEvents === 'function') {
      try {
        const events = this.eventLog.listEvents({});
        for (const e of events) {
          if (e.eventType !== 'turn_completed') continue;
          const raw = e.payload?.raw;
          if (!raw || raw.type !== 'result') continue;
          let evCost = 0;
          let evIn = 0;
          let evOut = 0;
          if (typeof raw.total_cost_usd === 'number') evCost = raw.total_cost_usd;
          const u = raw.usage;
          if (u && typeof u === 'object') {
            if (typeof u.input_tokens === 'number') evIn = u.input_tokens;
            if (typeof u.output_tokens === 'number') evOut = u.output_tokens;
          }
          tokensIn += evIn;
          tokensOut += evOut;
          costUsd += evCost;
          const providerId = runtimeProvider.get(e.runtimeId);
          if (providerId) {
            const bucket = ensureBucket(providerId);
            bucket.tokensIn += evIn;
            bucket.tokensOut += evOut;
            bucket.costUsd += evCost;
          }
        }
      } catch {
        // Aggregation failed — return zeros instead of throwing.
      }
    }

    // Runtime tally — live vs total across all teams.
    let live = 0;
    let total = 0;
    if (this.runtimeRegistry && typeof this.runtimeRegistry.listRuntimes === 'function') {
      try {
        const runtimes = this.runtimeRegistry.listRuntimes();
        total = runtimes.length;
        live = runtimes.filter((r) => r.status === 'running' || r.status === 'live' || r.status === 'starting').length;
      } catch {
        // Leave at 0.
      }
    }

    // Await the quota probe (fired earlier in parallel). Null when the
    // probe couldn't get a usable response — UI renders quota chips as
    // "—" in that case rather than fabricating numbers.
    const quota = await quotaPromise;

    // Per-provider auth + quota breakdown. Operators want to see plan
    // status across every CLI runtime they might use — not just whichever
    // happens to be the "active" one. anthropic gets the live quota
    // probe; codex + gemini have no equivalent /usage panel so quota is
    // null (UI renders "no quota probe available").
    const providerEntries = [
      { providerId: 'anthropic', label: 'Anthropic Claude' },
      { providerId: 'openai', label: 'OpenAI Codex' },
      { providerId: 'gemini', label: 'Google Gemini' },
    ];
    const providers = providerEntries.map((entry) => {
      let authStatus = null;
      try {
        authStatus = providerGetAuthStatus({
          providerId: entry.providerId,
          spawnSyncImpl: this.providerAuthSpawnSync,
          readFileImpl: this.providerAuthReadFile,
          statImpl: this.providerAuthStat,
        });
      } catch {
        // Leave authStatus null — the entry below will show "unknown".
      }
      const signedIn = authStatus && authStatus.signedIn === true;
      // Only anthropic has a real plan-quota probe (claude `/usage`).
      // Codex + Gemini CLIs don't expose plan limits — but Symphony
      // knows what IT has spent via the per-provider event aggregation
      // computed above, and that's the honest signal we can show for
      // those providers (and a useful complement for Claude too).
      const providerQuota = entry.providerId === 'anthropic' ? quota : null;
      const symphonyUsage = providerUsage.get(entry.providerId) || { tokensIn: 0, tokensOut: 0, costUsd: 0 };
      return {
        providerId: entry.providerId,
        label: entry.label,
        signedIn: signedIn || false,
        plan: authStatus?.plan ?? authStatus?.subscriptionType ?? null,
        user: authStatus?.user ?? null,
        reason: !signedIn ? (authStatus?.reason ?? null) : null,
        quota: providerQuota,
        symphonyUsage,
      };
    });

    return {
      plan,
      quota, // { session: {pctUsed, resetIn, label}, weekly: {...}, opusWeekly: {...} } | null
      providers,
      totals: { tokensIn, tokensOut, costUsd },
      runtimes: { live, total },
    };
  }

  /**
   * 90-second cache around probeClaudeUsage. The pty probe takes ~5s
   * (spawn + settle + capture + quit), so we don't want to run it on
   * every UI poll. 90s gives the chip near-real-time feel without
   * hammering claude.
   */
  async #getCachedClaudeQuota() {
    const now = Date.now();
    if (this.#claudeQuotaCache && (now - this.#claudeQuotaCache.at) < 90_000) {
      return this.#claudeQuotaCache.value;
    }
    if (this.#claudeQuotaInflight) {
      // Another caller is already probing — share their result.
      return this.#claudeQuotaInflight;
    }
    const probeImpl = this.claudeUsageProbe || probeClaudeUsage;
    this.#claudeQuotaInflight = (async () => {
      try {
        const result = await probeImpl({});
        this.#claudeQuotaCache = { at: Date.now(), value: result };
        return result;
      } catch {
        this.#claudeQuotaCache = { at: Date.now(), value: null };
        return null;
      } finally {
        this.#claudeQuotaInflight = null;
      }
    })();
    return this.#claudeQuotaInflight;
  }

  #stuckRuntimeList(actor, args) {
    // Wrap return in `{ runtimes }` for MCP structuredContent compatibility —
    // see #agentStatus and #runtimeList for precedent.
    if (!this.runtimeRegistry || typeof this.runtimeRegistry.listRuntimes !== 'function') {
      return { runtimes: [] };
    }
    const runtimes = this.runtimeRegistry.listRuntimes({ teamId: actor.teamId });
    const latestEventByRuntime = this.eventLog && typeof this.eventLog.latestEventByRuntime === 'function'
      ? this.eventLog.latestEventByRuntime({ teamId: actor.teamId })
      : new Map();
    const thresholdMs = Number.isFinite(args?.thresholdMs) && args.thresholdMs > 0
      ? args.thresholdMs
      : STUCK_DEFAULT_THRESHOLD_MS;
    return {
      runtimes: detectStuckRuntimes({
        runtimes,
        latestEventByRuntime,
        now: typeof args?.now === 'string' ? args.now : new Date().toISOString(),
        thresholdMs,
      }),
    };
  }

  /**
   * §3 settings_get. Returns the merged effective settings (global ⊕ project)
   * with a `_sources` map indicating which file each section came from.
   * Optional `args.scope` ('global' | 'project') returns the raw single-tier
   * file instead — useful for editors that want to know exactly what to write.
   */
  async #settingsGet(args) {
    if (!this.settingsStore) {
      throw new Error('settings_get: no settings store configured');
    }
    if (args?.scope === 'global') {
      return { settings: await this.settingsStore.readGlobalRaw(), scope: 'global' };
    }
    if (args?.scope === 'project') {
      return { settings: await this.settingsStore.readProjectRaw(), scope: 'project' };
    }
    return {
      settings: await this.settingsStore.readEffective(),
      scope: 'effective',
      paths: {
        global: this.settingsStore.getGlobalPath(),
        project: this.settingsStore.getProjectPath(),
      },
    };
  }

  /**
   * §3 settings_set. Updates one section (top-level key) at the chosen scope.
   * args: { scope: 'global' | 'project', section: string, value: object }
   */
  async #settingsSet(args) {
    if (!this.settingsStore) {
      throw new Error('settings_set: no settings store configured');
    }
    const scope = args?.scope;
    const section = args?.section;
    const value = args?.value;
    if (scope !== 'global' && scope !== 'project') {
      throw new Error(`settings_set: scope must be 'global' or 'project'`);
    }
    if (typeof section !== 'string' || section.length === 0) {
      throw new Error('settings_set: section must be a non-empty string');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('settings_set: value must be a plain object');
    }
    const written = await this.settingsStore.setSection({ scope, section, value });
    return { scope, section, value: written };
  }

  // ---- §3c GitHub auth ----------------------------------------------------

  /** Resolve the OAuth client_id with this precedence (first non-empty wins):
   *    1. constructor arg / TOAD_GITHUB_CLIENT_ID env var (this.githubClientId)
   *    2. settings.github.clientId (user-pasted via UI)
   *    3. BUILT_IN_GITHUB_CLIENT_ID (project-shipped default — empty by
   *       default; the project maintainer fills it in to ship a one-click
   *       experience, the same way gh CLI ships a public client_id).
   */
  async #resolveGithubClientId() {
    if (this.githubClientId) return this.githubClientId;
    if (this.settingsStore) {
      const merged = await this.settingsStore.readEffective();
      const fromSettings = merged?.github?.clientId;
      if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
    }
    if (typeof BUILT_IN_GITHUB_CLIENT_ID === 'string' && BUILT_IN_GITHUB_CLIENT_ID.length > 0) {
      return BUILT_IN_GITHUB_CLIENT_ID;
    }
    return null;
  }

  async #githubDeviceStart(args) {
    const clientId = (typeof args?.clientId === 'string' && args.clientId.length > 0)
      ? args.clientId
      : await this.#resolveGithubClientId();
    if (!clientId) {
      throw new Error('github_device_start: no OAuth client_id configured (set TOAD_GITHUB_CLIENT_ID or settings.github.clientId)');
    }
    const scopes = Array.isArray(args?.scopes) && args.scopes.length > 0 ? args.scopes : undefined;
    return githubRequestDeviceCode({ clientId, scopes, fetchImpl: this.githubFetch });
  }

  async #githubDevicePoll(args) {
    const deviceCode = requireString(args?.deviceCode, 'args.deviceCode');
    const clientId = (typeof args?.clientId === 'string' && args.clientId.length > 0)
      ? args.clientId
      : await this.#resolveGithubClientId();
    if (!clientId) {
      throw new Error('github_device_poll: no OAuth client_id configured');
    }
    const result = await githubExchangeDeviceCode({ clientId, deviceCode, fetchImpl: this.githubFetch });
    if (result.status === 'granted') {
      const verified = await githubGetCurrentUser({ token: result.accessToken, fetchImpl: this.githubFetch });
      if (verified.ok) {
        await this.#persistGithubCreds({
          source: 'device',
          accessToken: result.accessToken,
          tokenType: result.tokenType,
          scopes: verified.scopes.length ? verified.scopes : result.scopes,
          user: verified.user,
        });
        return { status: 'granted', user: verified.user, scopes: verified.scopes };
      }
      // Token is somehow invalid right after issuance — surface as a soft error.
      return { status: 'pending', reason: 'token_validation_failed' };
    }
    return result;
  }

  async #githubPatVerify(args) {
    const token = requireString(args?.token, 'args.token');
    const verified = await githubVerifyPat({ token, fetchImpl: this.githubFetch });
    if (!verified.ok) {
      return { status: 'rejected', httpStatus: verified.status ?? null };
    }
    await this.#persistGithubCreds({
      source: 'pat',
      accessToken: token,
      tokenType: 'token',
      scopes: verified.scopes,
      user: verified.user,
    });
    return { status: 'verified', user: verified.user, scopes: verified.scopes };
  }

  async #githubDisconnect() {
    if (!this.settingsStore) {
      throw new Error('github_disconnect: no settings store configured');
    }
    // Preserve clientId if set; clear creds.
    const merged = await this.settingsStore.readEffective();
    const next = { ...(merged?.github && typeof merged.github === 'object' ? merged.github : {}) };
    delete next.accessToken;
    delete next.tokenType;
    delete next.scopes;
    delete next.user;
    delete next.source;
    delete next.connectedAt;
    delete next._sources; // strip synthetic key if it leaked in
    await this.settingsStore.setSection({ scope: 'global', section: 'github', value: next });
    return { status: 'disconnected' };
  }

  async #githubStatus() {
    if (!this.settingsStore) {
      return { status: 'no-settings-store' };
    }
    const merged = await this.settingsStore.readEffective();
    const gh = merged?.github;
    const hasBuiltIn =
      typeof BUILT_IN_GITHUB_CLIENT_ID === 'string' && BUILT_IN_GITHUB_CLIENT_ID.length > 0;
    if (!gh || typeof gh !== 'object' || !gh.accessToken) {
      return {
        status: 'disconnected',
        clientIdConfigured: !!(this.githubClientId || gh?.clientId || hasBuiltIn),
        clientIdSource: this.githubClientId ? 'env' : (gh?.clientId ? 'settings' : (hasBuiltIn ? 'built-in' : null)),
      };
    }
    return {
      status: 'connected',
      source: gh.source || 'unknown',
      user: gh.user ?? null,
      scopes: Array.isArray(gh.scopes) ? gh.scopes : [],
      connectedAt: gh.connectedAt ?? null,
      clientIdConfigured: !!(this.githubClientId || gh.clientId || hasBuiltIn),
    };
  }

  /**
   * Resolve the stored GitHub access token (from device flow or PAT verify).
   * Returns null when nothing is connected, so handlers can surface a
   * caller-friendly "not connected" error.
   */
  async #resolveGithubToken() {
    if (!this.settingsStore) return null;
    const merged = await this.settingsStore.readEffective();
    const gh = merged?.github;
    if (!gh || typeof gh !== 'object') return null;
    return typeof gh.accessToken === 'string' && gh.accessToken.length > 0
      ? gh.accessToken
      : null;
  }

  async #githubGetRepository(args) {
    const owner = requireString(args?.owner, 'args.owner');
    const repo = requireString(args?.repo, 'args.repo');
    const token = await this.#resolveGithubToken();
    if (!token) {
      throw new Error('github_get_repository: GitHub is not connected — sign in via Settings → GitHub first');
    }
    return githubGetRepository({ token, owner, repo, fetchImpl: this.githubFetch });
  }

  async #githubGetBranchProtection(args) {
    const owner = requireString(args?.owner, 'args.owner');
    const repo = requireString(args?.repo, 'args.repo');
    const branch = requireString(args?.branch, 'args.branch');
    const token = await this.#resolveGithubToken();
    if (!token) {
      throw new Error('github_get_branch_protection: GitHub is not connected — sign in via Settings → GitHub first');
    }
    return githubGetBranchProtection({ token, owner, repo, branch, fetchImpl: this.githubFetch });
  }

  /**
   * Read `git remote get-url origin` and return the parsed `{ owner, repo }`
   * so the UI can wire an "Open PR" button without asking the user to type
   * the repo coordinates. Returns soft `{ ok: false, reason }` for
   * "no_origin_remote", "origin_not_github", or "no_project_cwd" — these
   * are normal states (e.g. fresh checkout, GitLab project) and shouldn't
   * surface as exceptions in the UI.
   */
  #githubOriginRemote() {
    if (typeof this.projectCwd !== 'string' || this.projectCwd.length === 0) {
      return { ok: false, reason: 'no_project_cwd' };
    }
    let result;
    try {
      result = this.runGit(['remote', 'get-url', 'origin'], { cwd: this.projectCwd });
    } catch {
      return { ok: false, reason: 'no_origin_remote' };
    }
    if (!result || result.exitCode !== 0) {
      return { ok: false, reason: 'no_origin_remote' };
    }
    const parsed = parseGithubRemote((result.stdout || '').trim());
    if (!parsed) {
      return { ok: false, reason: 'origin_not_github' };
    }
    return { ok: true, owner: parsed.owner, repo: parsed.repo };
  }

  async #githubCreatePullRequest(args) {
    const owner = requireString(args?.owner, 'args.owner');
    const repo = requireString(args?.repo, 'args.repo');
    const head = requireString(args?.head, 'args.head');
    const base = requireString(args?.base, 'args.base');
    const title = requireString(args?.title, 'args.title');
    const token = await this.#resolveGithubToken();
    if (!token) {
      throw new Error('github_create_pull_request: GitHub is not connected — sign in via Settings → GitHub first');
    }
    const body = typeof args?.body === 'string' ? args.body : null;
    const draft = args?.draft === true;
    return githubCreatePullRequest({
      token, owner, repo, head, base, title, body, draft,
      fetchImpl: this.githubFetch,
    });
  }

  /**
   * Create a new repository on GitHub under the authenticated user. Used
   * by the new-project flow when the user wants to push their fresh
   * Foundry-materialized project to a GitHub remote.
   */
  async #githubCreateRepository(args) {
    const name = requireString(args?.name, 'args.name');
    const token = await this.#resolveGithubToken();
    if (!token) {
      throw new Error('github_create_repository: GitHub is not connected — sign in via Settings → GitHub first');
    }
    const description = typeof args?.description === 'string' ? args.description : null;
    const isPrivate = args?.private === undefined ? true : args.private === true;
    const autoInit = args?.autoInit === true;
    return githubCreateRepository({
      token, name, description, private: isPrivate, autoInit,
      fetchImpl: this.githubFetch,
    });
  }

  /**
   * Run `git init` in projectCwd. Idempotent — if `.git` already exists
   * (the directory is already a git repo), returns `{ ok: true,
   * alreadyInitialized: true }` without re-initializing.
   */
  #gitInitLocal(args) {
    const cwd = (typeof args?.cwd === 'string' && args.cwd.trim().length > 0)
      ? args.cwd.trim()
      : this.projectCwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('git_init_local: no project root configured (cwd or projectCwd required)');
    }
    // Check if `.git` already exists by running `rev-parse --is-inside-work-tree`.
    const probe = this.runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
    if (probe && probe.exitCode === 0 && /true/i.test(String(probe.stdout || '').trim())) {
      return { ok: true, alreadyInitialized: true, cwd };
    }
    const initialBranch = (typeof args?.initialBranch === 'string' && args.initialBranch.trim().length > 0)
      ? args.initialBranch.trim()
      : 'main';
    const result = this.runGit(['init', '--initial-branch', initialBranch], { cwd });
    if (!result || result.exitCode !== 0) {
      return {
        ok: false,
        cwd,
        reason: result?.stderr ? String(result.stderr).slice(0, 400) : 'git init failed',
      };
    }
    return { ok: true, alreadyInitialized: false, cwd, initialBranch };
  }

  /**
   * Set / replace a git remote URL. Defaults to `origin`. Used after
   * `github_create_repository` to wire the freshly-created GitHub repo as
   * the local repo's origin.
   */
  #gitSetRemote(args) {
    const cwd = (typeof args?.cwd === 'string' && args.cwd.trim().length > 0)
      ? args.cwd.trim()
      : this.projectCwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('git_set_remote: no project root configured');
    }
    const name = (typeof args?.name === 'string' && args.name.trim().length > 0) ? args.name.trim() : 'origin';
    const url = requireString(args?.url, 'args.url');
    // Try `remote add` first; if it errors with "remote already exists",
    // fall back to `remote set-url`.
    const addResult = this.runGit(['remote', 'add', name, url], { cwd });
    if (addResult && addResult.exitCode === 0) {
      return { ok: true, name, url, mode: 'added' };
    }
    const setResult = this.runGit(['remote', 'set-url', name, url], { cwd });
    if (setResult && setResult.exitCode === 0) {
      return { ok: true, name, url, mode: 'updated' };
    }
    return {
      ok: false,
      name,
      url,
      reason: setResult?.stderr ? String(setResult.stderr).slice(0, 400) : 'git remote set-url failed',
    };
  }

  // ---- §3d Risk-policy editor --------------------------------------------

  async #riskPolicyGet() {
    if (!this.riskPolicyStore) {
      throw new Error('risk_policy_get: no risk-policy store configured (project must be set)');
    }
    return this.riskPolicyStore.read();
  }

  async #riskPolicySet(args) {
    if (!this.riskPolicyStore) {
      throw new Error('risk_policy_set: no risk-policy store configured');
    }
    const rules = Array.isArray(args?.rules) ? args.rules : [];
    const commandRules = Array.isArray(args?.commandRules) ? args.commandRules : [];
    const written = await this.riskPolicyStore.write({ rules, commandRules });
    return written;
  }

  /**
   * Run the proposed (or current) policy against a list of files + commands
   * and return what the §14 classifier would decide. Used by the editor's
   * live preview pane.
   */
  async #riskPolicyPreview(args) {
    const files = Array.isArray(args?.files) ? args.files.map(String) : [];
    const commands = Array.isArray(args?.commands) ? args.commands.map(String) : [];
    let policy;
    if (args?.policy && typeof args.policy === 'object') {
      policy = {
        rules: Array.isArray(args.policy.rules) ? args.policy.rules : [],
        commandRules: Array.isArray(args.policy.commandRules) ? args.policy.commandRules : [],
      };
    } else if (this.riskPolicyStore) {
      const current = await this.riskPolicyStore.read();
      policy = { rules: current.rules, commandRules: current.commandRules };
    } else {
      policy = { rules: [], commandRules: [] };
    }
    return classifyRisk({ files, commands, policy });
  }

  // ---- §3c.2 Provider plan-auth ------------------------------------------

  #providerAuthStatus(args) {
    const providerId = requireString(args?.providerId, 'args.providerId');
    return providerGetAuthStatus({
      providerId,
      spawnSyncImpl: this.providerAuthSpawnSync,
    });
  }

  #providerAuthLogin(args) {
    const providerId = requireString(args?.providerId, 'args.providerId');
    return providerTriggerAuthLogin({
      providerId,
      spawnImpl: this.providerAuthSpawn,
    });
  }

  #providerAuthLogout(args) {
    const providerId = requireString(args?.providerId, 'args.providerId');
    return providerTriggerAuthLogout({
      providerId,
      spawnSyncImpl: this.providerAuthSpawnSync,
    });
  }

  // ---- Plugins -------------------------------------------------------------

  async #pluginListAvailable(_actor, _args) {
    const plugins = SUPPORTED_PLUGINS.map((pluginId) => {
      const cfg = PLUGIN_COMMANDS[pluginId];
      const status = pluginGetAuthStatus({
        pluginId,
        readFileImpl: this.pluginAuthReadFile,
        statImpl: this.pluginAuthStat,
      });
      return {
        pluginId,
        label: cfg?.label ?? pluginId,
        supported: cfg?.supported === true,
        signedIn: status.signedIn === true,
        reason: status.reason ?? null,
        user: status.user ?? null,
      };
    });
    return { plugins };
  }

  #pluginLogin(_actor, args) {
    const pluginId = requireString(args?.pluginId, 'args.pluginId');
    return pluginTriggerLogin({
      pluginId,
      spawnImpl: this.pluginAuthSpawn,
    });
  }

  #pluginLogout(_actor, args) {
    const pluginId = requireString(args?.pluginId, 'args.pluginId');
    return pluginTriggerLogout({
      pluginId,
      spawnSyncImpl: this.pluginAuthSpawnSync,
    });
  }

  #pluginResourceList(actor, args) {
    if (!this.pluginResources) {
      return { resources: [] };
    }
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId
      : actor.teamId;
    const resources = this.pluginResources.listForTeam({ teamId });
    return { resources };
  }

  // ---- Railway tools -------------------------------------------------------

  async #railwayLink(actor, args) {
    const impl = this.railwayToolImpls?.link || defaultRailwayLink;
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    return impl({
      teamId,
      projectId: args?.projectId,
    });
  }

  async #railwayProvisionDb(actor, args) {
    if (!this.pluginResources) {
      throw new Error('railway_provision_db: pluginResources not configured for this facade');
    }
    const impl = this.railwayToolImpls?.provisionDb || defaultRailwayProvisionDb;
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    return impl({
      teamId,
      type: args?.type ?? 'postgres',
      pluginResources: this.pluginResources,
    });
  }

  async #railwayGetConnectionString(actor, args) {
    const impl = this.railwayToolImpls?.getConnectionString || defaultRailwayGetConnectionString;
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    return impl({
      teamId,
      resourceId: requireString(args?.resourceId, 'args.resourceId'),
      varName: args?.varName,
    });
  }

  async #railwayRunMigration(actor, args) {
    const impl = this.railwayToolImpls?.runMigration || defaultRailwayRunMigration;
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    return impl({
      teamId,
      resourceId: requireString(args?.resourceId, 'args.resourceId'),
      sql: requireString(args?.sql, 'args.sql'),
    });
  }

  // ---- EAS tools -----------------------------------------------------------

  async #easProjectInfo(_actor, args) {
    const impl = this.easToolImpls?.projectInfo || defaultEasProjectInfo;
    return impl({
      cwd: args?.cwd || this.projectCwd || process.cwd(),
      runEasCli: this.easToolImpls?.runEasCli,
    });
  }

  async #easBuild(actor, args) {
    if (!this.pluginJobs) {
      throw new Error('eas_build: pluginJobs not configured for this facade');
    }
    const impl = this.easToolImpls?.build || defaultEasBuild;
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    return impl({
      teamId,
      platform: requireString(args?.platform, 'args.platform'),
      profile: args?.profile || 'production',
      cwd: args?.cwd || this.projectCwd || process.cwd(),
      runEasCli: this.easToolImpls?.runEasCli,
      pluginJobs: this.pluginJobs,
    });
  }

  async #easUpdate(actor, args) {
    if (!this.pluginJobs) {
      throw new Error('eas_update: pluginJobs not configured for this facade');
    }
    const impl = this.easToolImpls?.update || defaultEasUpdate;
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    return impl({
      teamId,
      branch: requireString(args?.branch, 'args.branch'),
      message: requireString(args?.message, 'args.message'),
      cwd: args?.cwd || this.projectCwd || process.cwd(),
      runEasCli: this.easToolImpls?.runEasCli,
      pluginJobs: this.pluginJobs,
    });
  }

  // ---- Plugin Jobs ---------------------------------------------------------

  #pluginJobGet(_actor, args) {
    if (!this.pluginJobs) {
      throw new Error('plugin_job_get: pluginJobs not configured for this facade');
    }
    const jobId = requireString(args?.jobId, 'args.jobId');
    const job = this.pluginJobs.get({ jobId });
    if (!job) throw new Error(`plugin job not found: ${jobId}`);
    return job;
  }

  #pluginJobList(actor, args) {
    if (!this.pluginJobs) {
      throw new Error('plugin_job_list: pluginJobs not configured for this facade');
    }
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    const state = args?.state;
    const limit = Number.isInteger(args?.limit) ? args.limit : 100;
    const jobs = this.pluginJobs.list({ teamId, state, limit });
    return { jobs };
  }

  // ---- Vercel tools --------------------------------------------------------

  async #vercelLink(_actor, args) {
    const impl = this.vercelToolImpls?.link || defaultVercelLink;
    return impl({
      cwd: args?.cwd || this.projectCwd || process.cwd(),
      runVercelCli: this.vercelToolImpls?.runVercelCli,
    });
  }

  async #vercelEnvPull(_actor, args) {
    const impl = this.vercelToolImpls?.envPull || defaultVercelEnvPull;
    return impl({
      cwd: args?.cwd || this.projectCwd || process.cwd(),
      runVercelCli: this.vercelToolImpls?.runVercelCli,
    });
  }

  async #vercelDeploy(actor, args) {
    if (!this.pluginJobs) {
      throw new Error('vercel_deploy: pluginJobs not configured for this facade');
    }
    const impl = this.vercelToolImpls?.deploy || defaultVercelDeploy;
    const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
      ? args.teamId : actor.teamId;
    return impl({
      teamId,
      prod: args?.prod === true,
      cwd: args?.cwd || this.projectCwd || process.cwd(),
      runVercelCli: this.vercelToolImpls?.runVercelCli,
      pluginJobs: this.pluginJobs,
    });
  }

  async #vercelList(_actor, args) {
    const impl = this.vercelToolImpls?.ls || defaultVercelList;
    return impl({
      cwd: args?.cwd || this.projectCwd || process.cwd(),
      runVercelCli: this.vercelToolImpls?.runVercelCli,
    });
  }

  // ---- Foundry -------------------------------------------------------------

  #foundrySessionCreate(args) {
    const store = this.#requireFoundryStore();
    const provider = typeof args?.provider === 'string' && args.provider.length > 0
      ? args.provider
      : 'anthropic';
    return store.createSession({
      sessionId: typeof args?.sessionId === 'string' ? args.sessionId : undefined,
      title: requireString(args?.title, 'args.title'),
      projectPath: typeof args?.projectPath === 'string' ? args.projectPath : this.projectCwd,
      metadata: args?.metadata && typeof args.metadata === 'object' ? args.metadata : {},
      provider,
    });
  }

  #foundrySessionList() {
    return this.#requireFoundryStore().listSessions();
  }

  #foundrySessionGet(args) {
    const session = this.#requireFoundryStore().getSession(requireString(args?.sessionId, 'args.sessionId'));
    if (!session) throw new Error(`foundry session not found: ${args.sessionId}`);
    return session;
  }

  #foundryMessageAdd(args) {
    const store = this.#requireFoundryStore();
    return store.addMessage({
      messageId: typeof args?.messageId === 'string' ? args.messageId : undefined,
      sessionId: requireString(args?.sessionId, 'args.sessionId'),
      role: typeof args?.role === 'string' ? args.role : 'user',
      text: requireString(args?.text, 'args.text'),
      metadata: args?.metadata && typeof args.metadata === 'object' ? args.metadata : {},
    });
  }

  async #foundryChatTurn(args) {
    const store = this.#requireFoundryStore();
    const sessionId = requireString(args?.sessionId, 'args.sessionId');
    const text = requireString(args?.text, 'args.text');
    const snapshot = store.getSession(sessionId);
    if (!snapshot) throw new Error(`foundry session not found: ${sessionId}`);
    if (!this.foundryRuntime) {
      throw new Error('foundry_chat_turn: foundryRuntime not configured for this facade');
    }

    const user = store.addMessage({
      sessionId,
      role: 'user',
      text,
      metadata: { source: 'foundry_chat_turn' },
    });

    const response = await this.foundryRuntime.send({
      foundrySessionId: sessionId,
      text,
      cliSessionId: snapshot.session?.cliSessionId ?? null,
      provider: snapshot.session?.provider ?? 'anthropic',
    });

    // First turn: persist the new CLI session UUID so subsequent turns can find it.
    if (!snapshot.session?.cliSessionId && response.sessionUuid) {
      store.setCliSessionId({ sessionId, cliSessionId: response.sessionUuid });
    }

    const assistant = store.addMessage({
      sessionId,
      role: 'assistant',
      text: response.text,
      metadata: {
        source: 'claude_cli_subprocess',
        sessionUuid: response.sessionUuid,
        model: response.model,
        eventCount: response.eventCount,
      },
    });

    return {
      sessionId,
      user,
      assistant,
      sessionUuid: response.sessionUuid,
      model: response.model,
    };
  }

  #foundryArtifactUpsert(args) {
    const store = this.#requireFoundryStore();
    return store.upsertArtifact({
      artifactId: typeof args?.artifactId === 'string' ? args.artifactId : undefined,
      sessionId: requireString(args?.sessionId, 'args.sessionId'),
      kind: requireString(args?.kind, 'args.kind'),
      title: requireString(args?.title, 'args.title'),
      content: typeof args?.content === 'string' ? args.content : requireString(args?.content, 'args.content'),
      targetPath: typeof args?.targetPath === 'string' ? args.targetPath : null,
      status: typeof args?.status === 'string' ? args.status : 'draft',
      metadata: args?.metadata && typeof args.metadata === 'object' ? args.metadata : {},
    });
  }

  #foundryArtifactGenerate(args) {
    const store = this.#requireFoundryStore();
    const sessionId = requireString(args?.sessionId, 'args.sessionId');
    const snapshot = store.getSession(sessionId);
    if (!snapshot) throw new Error(`foundry session not found: ${sessionId}`);
    const artifacts = buildFoundryArtifacts(snapshot).map((artifact) =>
      store.upsertArtifact({
        artifactId: `${sessionId}-${artifact.kind}`,
        sessionId,
        ...artifact,
      })
    );
    return {
      sessionId,
      artifacts,
    };
  }

  #foundryArtifactExport(args) {
    const rootDir = typeof args?.rootDir === 'string' && args.rootDir.trim().length > 0
      ? args.rootDir
      : this.projectCwd;
    if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
      throw new Error('foundry_artifact_export: no project root configured');
    }
    return this.#requireFoundryStore().exportArtifacts({
      sessionId: requireString(args?.sessionId, 'args.sessionId'),
      rootDir,
      artifactIds: Array.isArray(args?.artifactIds) ? args.artifactIds : null,
    });
  }

  #foundryProjectMaterialize(actor, idempotencyKey, args) {
    const store = this.#requireFoundryStore();
    const mode = args?.mode === 'plan' ? 'plan' : 'apply';
    if (mode === 'apply' && !this.teamConfigRegistry) {
      throw new Error('foundry_project_materialize: teamConfigRegistry is not configured');
    }
    const sessionId = requireString(args?.sessionId, 'args.sessionId');
    const rootDir = typeof args?.rootDir === 'string' && args.rootDir.trim().length > 0
      ? args.rootDir.trim()
      : this.projectCwd;
    if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
      throw new Error('foundry_project_materialize: no project root configured');
    }

    let snapshot = store.getSession(sessionId);
    if (!snapshot) throw new Error(`foundry session not found: ${sessionId}`);
    if (snapshot.artifacts.length === 0) {
      this.#foundryArtifactGenerate({ sessionId });
      snapshot = store.getSession(sessionId);
    }

    const teamId = typeof args?.teamId === 'string' && args.teamId.trim().length > 0
      ? args.teamId.trim()
      : slugifyTeamId(snapshot.session.title);
    const cwd = typeof args?.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : rootDir;
    const exported = this.#foundryArtifactExport({ sessionId, rootDir });
    snapshot = store.getSession(sessionId);
    const taskSpecs = buildFoundryTaskSpecs(snapshot);
    const leadPrompt = buildFoundryLeadPrompt(snapshot);

    // Plan mode: export docs + return suggested team/tasks WITHOUT creating
    // the team or tasks. The UI uses this to seed the CreateTeamModal so
    // the user can craft the team before launch. Apply mode (default,
    // back-compat) creates everything end-to-end.
    if (mode === 'plan') {
      return {
        sessionId,
        mode: 'plan',
        teamId,
        files: exported.files,
        suggestedTeam: {
          teamId,
          cwd,
          leadPrompt,
          lead: { agentId: 'lead', role: 'lead', providerId: 'anthropic', skipPermissions: true },
          teammates: [
            { agentId: 'architect', role: 'architect', providerId: 'anthropic', skipPermissions: true },
            { agentId: 'developer', role: 'developer', providerId: 'anthropic', skipPermissions: true },
            { agentId: 'reviewer', role: 'reviewer', providerId: 'anthropic', skipPermissions: true },
            { agentId: 'tester', role: 'tester', providerId: 'anthropic', skipPermissions: true },
          ],
        },
        suggestedTasks: taskSpecs,
      };
    }

    const team = this.#teamCreate(actor, {
      teamId,
      lead: {
        agentId: 'lead',
        role: 'lead',
        providerId: 'anthropic',
        cwd,
        skipPermissions: true,
        prompt: leadPrompt,
      },
      teammates: [
        { agentId: 'architect', role: 'architect', providerId: 'anthropic', cwd, skipPermissions: true },
        { agentId: 'developer', role: 'developer', providerId: 'anthropic', cwd, skipPermissions: true },
        { agentId: 'reviewer', role: 'reviewer', providerId: 'anthropic', cwd, skipPermissions: true },
        { agentId: 'tester', role: 'tester', providerId: 'anthropic', cwd, skipPermissions: true },
      ],
      validation: args?.validation && typeof args.validation === 'object' ? args.validation : null,
    });

    const tasks = taskSpecs.map((spec, index) => this.#taskCreate(
      { ...actor, teamId },
      `${idempotencyKey}:task:${spec.taskId}`,
      {
        taskId: spec.taskId,
        subject: spec.subject,
        description: spec.description,
        assignedRole: spec.assignedRole,
        priority: index === 0 ? 'high' : 'medium',
        expectedDeliverables: spec.expectedDeliverables,
        acceptanceCriteria: spec.acceptanceCriteria,
        delivers: spec.delivers,
      },
    ));

    return {
      sessionId,
      mode: 'apply',
      teamId,
      team,
      files: exported.files,
      tasks,
    };
  }

  /**
   * Seed starter tasks from a Foundry session into a real team that was
   * created via CreateTeamModal (rather than via materialize's auto-create
   * path). Used by the UI flow:
   *   Foundry → materialize(mode='plan') → CreateTeamModal → team_create →
   *   foundry_project_seed_tasks → workspace.
   */
  #foundryProjectSeedTasks(actor, idempotencyKey, args) {
    const store = this.#requireFoundryStore();
    const sessionId = requireString(args?.sessionId, 'args.sessionId');
    const teamId = requireString(args?.teamId, 'args.teamId');
    const snapshot = store.getSession(sessionId);
    if (!snapshot) throw new Error(`foundry session not found: ${sessionId}`);
    if (snapshot.artifacts.length === 0) {
      throw new Error('foundry_project_seed_tasks: session has no artifacts — generate them first');
    }
    const taskSpecs = buildFoundryTaskSpecs(snapshot);
    const tasks = taskSpecs.map((spec, index) => this.#taskCreate(
      { ...actor, teamId },
      `${idempotencyKey}:task:${spec.taskId}`,
      {
        taskId: spec.taskId,
        subject: spec.subject,
        description: spec.description,
        assignedRole: spec.assignedRole,
        priority: index === 0 ? 'high' : 'medium',
        expectedDeliverables: spec.expectedDeliverables,
        acceptanceCriteria: spec.acceptanceCriteria,
        delivers: spec.delivers,
      },
    ));
    return { sessionId, teamId, tasks };
  }

  #requireFoundryStore() {
    if (!this.foundryStore) {
      throw new Error('foundry store is not configured');
    }
    return this.foundryStore;
  }

  // ---- M.1a: project_state_describe ----------------------------------------

  /**
   * Read-only inspection of the loaded project. Used by the UI on app mount
   * to decide whether to route to Cockpit (existing team — reopen flow) or
   * Foundry (no team yet — discovery flow). See
   * `docs/specs/2026-05-10-maintenance-mode-m1a-reopen-design.md` §1.
   *
   * Returns one of three states:
   *   - 'fresh'          — no team configs AND no foundry sessions.
   *   - 'half_foundried' — foundry sessions exist but no team configs yet.
   *   - 'has_team'       — at least one team config exists. Includes a
   *                        `reopenContext` block with the most-recently-
   *                        touched team's last activity (last task, last
   *                        drift run, last commit, isRunning).
   *
   * Every external call is wrapped defensively — the handler never throws,
   * even on corrupted state. UI routing must always get a valid response.
   */
  async #projectStateDescribe(_args) {
    const teamConfigs = this.#countTeamConfigs();
    const foundrySessions = this.#countFoundrySessions();
    if (teamConfigs === 0 && foundrySessions === 0) {
      return { state: 'fresh', teamConfigs, foundrySessions };
    }
    if (teamConfigs === 0) {
      return { state: 'half_foundried', teamConfigs, foundrySessions };
    }
    return {
      state: 'has_team',
      teamConfigs,
      foundrySessions,
      reopenContext: await this.#buildReopenContext(),
    };
  }

  #countTeamConfigs() {
    if (!this.teamConfigRegistry || typeof this.teamConfigRegistry.listTeams !== 'function') {
      return 0;
    }
    try {
      return this.teamConfigRegistry.listTeams().length;
    } catch {
      return 0;
    }
  }

  #countFoundrySessions() {
    const store = this.foundryStore;
    if (!store || typeof store.listSessions !== 'function') return 0;
    try {
      return store.listSessions().length;
    } catch {
      return 0;
    }
  }

  async #buildReopenContext() {
    const team = this.#pickMostRecentTeam();
    if (!team) {
      // Defensive: caller already verified teamConfigs > 0. Hitting this
      // branch means corrupted state or a race — return a stub so routing
      // doesn't break.
      return { teamId: 'unknown', teamName: 'unknown', isRunning: false, lastActiveAt: null };
    }
    const lastTask = this.#getLastTouchedTask(team.teamId);
    const lastDrift = this.#getLastDriftRun(team.teamId);
    const lastCommit = await this.#getLastCommitSafely();
    const isRunning = this.#isAnyRuntimeRunning(team.teamId);

    return {
      teamId: team.teamId,
      teamName: team.displayName || team.teamId,
      isRunning,
      lastActiveAt: lastTask?.createdAt ?? null,
      lastTask: lastTask
        ? { taskId: lastTask.taskId, subject: lastTask.subject, status: lastTask.status }
        : undefined,
      lastDriftScore: lastDrift
        ? {
            teamScore: lastDrift.teamScore,
            status: lastDrift.status,
            runId: lastDrift.runId,
            createdAt: lastDrift.createdAt,
          }
        : undefined,
      lastCommit: lastCommit || undefined,
    };
  }

  /**
   * Picks the team with the most-recent task_event. Ties (or teams that
   * have never seen a task event) are broken by team_configs.created_at
   * ascending — i.e. the oldest team wins. Returns null when there are no
   * configured teams, or when the registry has no `.db` to query.
   *
   * Note: `team_configs` has no display_name column. We project it as the
   * teamId; the `teams` table's display_name is auto-populated as NULL in
   * most cases (each store INSERT-ON-CONFLICT-NOTHING with NULL), so it
   * isn't a reliable name source either.
   */
  #pickMostRecentTeam() {
    const db = this.teamConfigRegistry?.db || this.taskBoard?.db || null;
    if (!db) {
      // Fall back to the in-memory registry's listTeams() — only one
      // configured team in that case, so picking the first is correct.
      try {
        const list = this.teamConfigRegistry?.listTeams?.() ?? [];
        const first = list[0];
        return first ? { teamId: first.teamId, displayName: first.teamId } : null;
      } catch {
        return null;
      }
    }
    try {
      const row = db.prepare(`
        SELECT tc.team_id AS teamId,
               MAX(te.created_at) AS lastEventAt,
               tc.created_at AS teamCreatedAt
        FROM team_configs tc
        LEFT JOIN task_events te ON te.team_id = tc.team_id
        GROUP BY tc.team_id
        ORDER BY (lastEventAt IS NULL) ASC, lastEventAt DESC, teamCreatedAt ASC
        LIMIT 1
      `).get();
      if (!row) return null;
      return { teamId: row.teamId, displayName: row.teamId };
    } catch {
      return null;
    }
  }

  /**
   * Returns the most-recently-touched task for `teamId`, or null on any
   * error / no events. Folds task_events into a task projection so the
   * returned `status` reflects the cumulative state, not just the latest
   * event type.
   */
  #getLastTouchedTask(teamId) {
    if (!this.taskBoard || typeof this.taskBoard.listEvents !== 'function') return null;
    try {
      const events = this.taskBoard.listEvents({ teamId });
      if (!events || events.length === 0) return null;
      // Find the newest event with a non-empty taskId.
      const sorted = [...events].sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt))
      );
      const newest = sorted.find((e) => typeof e.taskId === 'string' && e.taskId.length > 0);
      if (!newest) return null;
      const task = typeof this.taskBoard.getTask === 'function'
        ? this.taskBoard.getTask({ teamId, taskId: newest.taskId })
        : null;
      if (!task) return null;
      return {
        taskId: task.taskId,
        subject: task.subject,
        status: task.status,
        createdAt: newest.createdAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns the most-recent drift run for `teamId`, or null on any error /
   * no history. The drift store lives at `this.driftEngine?.store` (same
   * path drift_correction_create uses).
   */
  #getLastDriftRun(teamId) {
    const driftStore = this.driftEngine?.store ?? null;
    if (!driftStore || typeof driftStore.listScoreHistory !== 'function') return null;
    try {
      const history = driftStore.listScoreHistory({ teamId, limit: 1 });
      if (!history || history.length === 0) return null;
      const row = history[0];
      return {
        teamScore: row.teamScore,
        status: row.status,
        runId: row.runId,
        createdAt: row.createdAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Best-effort `git log -1` against the project cwd. Returns null on any
   * failure (no git binary, not a git repo, malformed output). Never
   * throws — git issues must NOT block the routing decision.
   *
   * Async only because the spec calls out an async signature; the
   * underlying runGit is sync (spawnSync).
   */
  async #getLastCommitSafely() {
    if (typeof this.projectCwd !== 'string' || this.projectCwd.length === 0) return null;
    if (typeof this.runGit !== 'function') return null;
    try {
      const result = this.runGit(
        ['log', '-1', '--pretty=format:%H%n%s%n%aI'],
        { cwd: this.projectCwd },
      );
      if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') return null;
      const lines = result.stdout.split('\n');
      if (lines.length < 2) return null;
      const sha = lines[0].trim();
      const message = lines[1].trim();
      if (!sha || !message) return null;
      return {
        sha,
        message,
        authoredAt: (lines[2] || '').trim() || null,
      };
    } catch {
      return null;
    }
  }

  /**
   * True iff any runtime row for `teamId` is in 'running' status. Returns
   * false on any error so a flaky registry doesn't flip Cockpit into the
   * paused/running state inadvertently.
   */
  #isAnyRuntimeRunning(teamId) {
    const reg = this.runtimeRegistry;
    if (!reg || typeof reg.listRuntimes !== 'function') return false;
    try {
      const runtimes = reg.listRuntimes({ teamId }) || [];
      return runtimes.some((r) => r && r.status === 'running');
    } catch {
      return false;
    }
  }

  /**
   * §20 audit-log query. Merges task events + runtime events for the actor's
   * team, optionally filtering to events after a timestamp, and returns them
   * sorted by createdAt desc with a hard cap. Read-only; available to every
   * role via COMMON_READ_TOOLS.
   *
   * Returns: { events: [...], hasMore: boolean, cap: number, sinceMs: number | null }
   * Each event carries a `_source: 'task' | 'runtime'` tag so the UI can
   * style them differently.
   */
  #auditLogQuery(actor, args) {
    const teamId = actor.teamId;
    const limit = Math.max(1, Math.min(1000, Number.isInteger(args?.limit) ? args.limit : 200));
    const sinceMs = Number.isFinite(Number(args?.sinceMs)) && Number(args.sinceMs) > 0
      ? Number(args.sinceMs)
      : null;

    const taskEvents = (this.taskBoard && typeof this.taskBoard.listEvents === 'function')
      ? this.taskBoard.listEvents({ teamId })
      : [];
    const runtimeEvents = (this.eventLog && typeof this.eventLog.listEvents === 'function')
      ? this.eventLog.listEvents({ teamId })
      : [];

    const tagged = [];
    for (const e of taskEvents) {
      const at = Date.parse(e.createdAt ?? '');
      if (sinceMs && Number.isFinite(at) && at < sinceMs) continue;
      tagged.push({ ...e, _source: 'task' });
    }
    for (const e of runtimeEvents) {
      const at = Date.parse(e.createdAt ?? '');
      if (sinceMs && Number.isFinite(at) && at < sinceMs) continue;
      tagged.push({ ...e, _source: 'runtime' });
    }

    tagged.sort((a, b) => {
      const aMs = Date.parse(a.createdAt ?? '');
      const bMs = Date.parse(b.createdAt ?? '');
      if (!Number.isFinite(aMs)) return 1;
      if (!Number.isFinite(bMs)) return -1;
      return bMs - aMs;
    });

    const hasMore = tagged.length > limit;
    return {
      events: tagged.slice(0, limit),
      hasMore,
      cap: limit,
      sinceMs,
    };
  }

  /**
   * Persist GitHub credentials. Merges into existing github section so we
   * don't blow away `clientId` or other unrelated fields.
   */
  async #persistGithubCreds({ source, accessToken, tokenType, scopes, user }) {
    if (!this.settingsStore) {
      throw new Error('cannot persist GitHub creds: no settings store configured');
    }
    const merged = await this.settingsStore.readEffective();
    const existing = (merged?.github && typeof merged.github === 'object') ? { ...merged.github } : {};
    delete existing._sources;
    const next = {
      ...existing,
      source,
      accessToken,
      tokenType,
      scopes: Array.isArray(scopes) ? scopes : [],
      user,
      connectedAt: new Date().toISOString(),
    };
    await this.settingsStore.setSection({ scope: 'global', section: 'github', value: next });
  }

  #emitToolCallDenied(actor, commandName, err) {
    if (!this.eventLog) return;
    // Best-effort audit. The original error always re-throws; a broken event log
    // must not mask the role-authority denial.
    try {
      this.eventLog.appendEvent({
        runtimeId: `facade:${actor.agentId}`,
        teamId: actor.teamId,
        agentId: actor.agentId,
        eventType: 'tool_call_denied',
        payload: {
          commandName,
          role: typeof actor.role === 'string' ? actor.role : null,
          reason: err && typeof err.message === 'string' ? err.message : String(err),
        },
      });
    } catch {
      // swallow — the role-authority error is what the caller needs to see
    }
  }
}

/**
 * Extract `===DOC: kind===` blocks from the most recent assistant message
 * that contained a particular kind. The chat prompt instructs the model
 * to emit all four blocks every time it drafts/revises, so we only need
 * to find the LATEST occurrence per kind.
 *
 * Returns a map of kind → content. Missing kinds aren't in the map; the
 * caller falls back to the template skeleton for those.
 */
function parseDocBlocksFromTranscript(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const result = new Map();
  // Walk newest → oldest so the first hit per kind wins.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const text = typeof message.text === 'string' ? message.text : '';
    if (!text.includes('===DOC:')) continue;
    // Match ===DOC: <kind>=== ... ===END DOC===  (kind is one or more
    // alphanumeric/underscore chars; content is everything up to the next
    // ===END DOC===, non-greedy, dotall semantics via [\s\S]).
    const re = /===DOC:\s*([a-zA-Z0-9_]+)\s*===\s*([\s\S]*?)\s*===END\s+DOC===/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const kind = match[1].trim().toLowerCase();
      const content = match[2].trim();
      if (!result.has(kind) && content.length > 0) {
        result.set(kind, content);
      }
    }
  }
  return result;
}

function buildFoundryArtifacts(snapshot) {
  const title = snapshot.session.title;
  // Prefer ===DOC=== blocks the chat actually drafted. Falls back to the
  // skeleton templates below for any kind the chat hasn't emitted yet.
  const parsed = parseDocBlocksFromTranscript(snapshot);
  const sourceNotes = snapshot.messages
    .filter((message) => message.role === 'user')
    .map((message) => `- ${message.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n') || '- No operator notes captured yet.';
  const brief = [
    `# ${title} Product Brief`,
    '',
    '## Problem',
    'Capture the operator goals from the Foundry conversation and turn them into buildable software requirements.',
    '',
    '## Source Notes',
    sourceNotes,
    '',
    '## Users',
    '- Primary operators who need the finished workflow.',
    '- Team members who will build, review, and validate the system in TOAD.',
    '',
    '## Success Criteria',
    '- The core user workflow is clear enough to turn into TOAD tasks.',
    '- Data entities and integrations are named before implementation starts.',
    '- Acceptance criteria are testable by a reviewer.',
  ].join('\n');
  const techSpec = [
    `# ${title} Technical Spec`,
    '',
    '## Architecture',
    '- Use the existing app stack unless the team explicitly approves a change.',
    '- Keep backend state changes behind typed service/tool boundaries.',
    '- Keep frontend screens data-driven and free of mock production state.',
    '',
    '## Data Model',
    '- Convert the source notes into concrete entities, relationships, and lifecycle states.',
    '- Keep audit fields on records that affect orchestration, billing, or approvals.',
    '',
    '## API Surface',
    '- Define read commands for listing/detail views.',
    '- Define mutating commands with idempotency keys.',
    '- Route agent and UI access through the same enforcement layer.',
    '',
    '## Validation',
    '- Add unit tests for state changes.',
    '- Add integration coverage for repo-file or external side effects.',
    '- Run typecheck and build before review.',
  ].join('\n');
  const roadmap = [
    `# ${title} Roadmap`,
    '',
    '## Phase 1 - Clarify',
    '- Finalize entities, user roles, and acceptance criteria.',
    '- Identify high-risk files, integrations, and permissions.',
    '',
    '## Phase 2 - Foundation',
    '- Add persistence and command/tool coverage.',
    '- Build the first usable UI path against live data.',
    '',
    '## Phase 3 - Execution',
    '- Break the work into TOAD tasks with owners and validation commands.',
    '- Drive implementation through plan, review, testing, and merge gates.',
    '',
    '## Phase 4 - Hardening',
    '- Add edge-case tests, risk policy checks, and operational documentation.',
  ].join('\n');
  const prisma = [
    '// Draft Prisma schema generated by TOAD Foundry.',
    '// Replace placeholder fields after the data model is finalized.',
    '',
    'model ProjectPlan {',
    '  id        String   @id @default(cuid())',
    '  title     String',
    '  status    String   @default("draft")',
    '  createdAt DateTime @default(now())',
    '  updatedAt DateTime @updatedAt',
    '  items     ProjectPlanItem[]',
    '}',
    '',
    'model ProjectPlanItem {',
    '  id            String      @id @default(cuid())',
    '  projectPlanId String',
    '  projectPlan   ProjectPlan @relation(fields: [projectPlanId], references: [id])',
    '  kind          String',
    '  title         String',
    '  status        String      @default("pending")',
    '  notes         String?',
    '  createdAt     DateTime    @default(now())',
    '  updatedAt     DateTime    @updatedAt',
    '}',
  ].join('\n');
  const tasks = [
    `# ${title} TOAD Task Breakdown`,
    '',
    '## Task 1 - Requirements contract',
    '- Deliverable: product brief and acceptance criteria.',
    '- Acceptance: reviewers can map each requirement to a user workflow.',
    '',
    '## Task 2 - Data model',
    '- Deliverable: finalized schema and migration plan.',
    '- Acceptance: relationships, lifecycle states, and audit fields are explicit.',
    '',
    '## Task 3 - Backend tools',
    '- Deliverable: read/mutating commands behind the enforcement layer.',
    '- Acceptance: idempotent mutations and tests cover expected failures.',
    '',
    '## Task 4 - Frontend workflow',
    '- Deliverable: UI against live API data.',
    '- Acceptance: empty, loading, success, and error states are usable.',
    '',
    '## Task 5 - Validation and handoff',
    '- Deliverable: test results, build output, and handoff notes.',
    '- Acceptance: team can continue without relying on chat history.',
  ].join('\n');

  // The chat prompt emits four DOC kinds: brief, tech_spec, roadmap, tasks.
  // Map each to our internal artifact kind/title/path. Use the parsed
  // content when available, otherwise fall back to the skeleton template
  // (which prevents an empty/unusable export when the model hasn't
  // drafted yet).
  const briefContent = parsed.get('brief') ?? brief;
  const techSpecContent = parsed.get('tech_spec') ?? parsed.get('techspec') ?? techSpec;
  const roadmapContent = parsed.get('roadmap') ?? roadmap;
  const tasksContent = parsed.get('tasks') ?? parsed.get('task_breakdown') ?? tasks;

  const out = [
    {
      kind: 'product_brief',
      title: 'Product Brief',
      content: briefContent,
      targetPath: 'docs/foundry/product-brief.md',
    },
    {
      kind: 'tech_spec',
      title: 'Technical Spec',
      content: techSpecContent,
      targetPath: 'docs/foundry/tech-spec.md',
    },
    {
      kind: 'roadmap',
      title: 'Roadmap',
      content: roadmapContent,
      targetPath: 'docs/foundry/roadmap.md',
    },
    {
      kind: 'task_breakdown',
      title: 'Task Breakdown',
      content: tasksContent,
      targetPath: 'docs/foundry/task-breakdown.md',
    },
  ];

  // Round-2 (kiro-style) artifacts — only emit when the chat actually
  // produced them. Steering / DoD / ADRs are optional in the sense that
  // we don't synthesize a skeleton if the chat hasn't drafted yet (the
  // skeleton would be project-agnostic boilerplate that misleads the
  // team lead). When the chat catches up, the materialize re-runs and
  // these blocks land.
  const steeringContent = parsed.get('steering');
  if (steeringContent) {
    out.push({
      kind: 'steering',
      title: 'Team Steering',
      content: steeringContent,
      targetPath: 'docs/foundry/steering.md',
    });
  }
  const designDecisionsContent = parsed.get('design_decisions') ?? parsed.get('decisions') ?? parsed.get('adr');
  if (designDecisionsContent) {
    out.push({
      kind: 'design_decisions',
      title: 'Design Decisions',
      content: designDecisionsContent,
      targetPath: 'docs/foundry/design-decisions.md',
    });
  }
  const dodContent = parsed.get('definition_of_done') ?? parsed.get('done') ?? parsed.get('dod');
  if (dodContent) {
    out.push({
      kind: 'definition_of_done',
      title: 'Definition of Done',
      content: dodContent,
      targetPath: 'docs/foundry/definition-of-done.md',
    });
  }

  // Only include the Prisma schema draft when the operator explicitly
  // emitted a `===DOC: prisma_schema===` block in chat. The skeleton
  // template was speculative noise for projects that don't even use a
  // DB — drop it from the default set.
  const prismaContent = parsed.get('prisma_schema') ?? parsed.get('prisma');
  if (prismaContent) {
    out.push({
      kind: 'prisma_schema',
      title: 'Prisma Schema Draft',
      content: prismaContent,
      targetPath: 'docs/foundry/prisma-schema.prisma',
    });
  }

  // Machine-checkable spec — the Layer-1 drift contract. Emitted as
  // docs/foundry/spec.json (NOT .yaml — see the schema design doc §0:
  // the project has exactly one runtime dep and no built-in YAML
  // parser; the drift system must not bloat the dep tree it polices).
  //
  // The Foundry planner is instructed to emit a `===DOC: spec===`
  // block whose body is the JSON document. We strip a leading/trailing
  // markdown code fence if the model wrapped it (```json … ```), so
  // the written file is pure parseable JSON. We deliberately do NOT
  // validate the JSON here — loadProjectSpec at drift time is the
  // single validation point, and an unparseable spec degrades to an
  // honest info-level meta-finding rather than blocking materialize.
  const specContent = parsed.get('spec') ?? parsed.get('spec_json') ?? parsed.get('spec_yaml');
  if (specContent) {
    out.push({
      kind: 'spec_json',
      title: 'Machine-checkable spec',
      content: stripCodeFence(specContent),
      targetPath: 'docs/foundry/spec.json',
    });
  }

  return out;
}

/**
 * Strip a single leading/trailing markdown code fence if present.
 * Foundry chat output for the spec block is JSON; models frequently
 * wrap structured payloads in ```json … ``` even when asked not to.
 * Leaving the fence in would make docs/foundry/spec.json fail
 * JSON.parse and dump the operator straight into the "spec.json
 * present but unparseable" meta-finding on the very first drift run.
 */
export function stripCodeFence(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json|jsonc)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : trimmed).trim();
}

function buildFoundryLeadPrompt(snapshot) {
  const title = snapshot?.session?.title || 'Symphony AI project';
  const artifacts = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
  const docs = artifacts
    .filter((artifact) => typeof artifact.targetPath === 'string' && artifact.targetPath.length > 0)
    .map((artifact) => `- ${artifact.title} → ${artifact.targetPath}`)
    .join('\n');

  return [
    `You are the team lead for the Symphony AI project "${title}".`,

    'Onboarding sequence (do this BEFORE assigning any task):',
    '1. Read every Foundry doc listed below — these are the source of truth for goals, scope, architecture, and acceptance criteria.',
    '2. Cross-check the auto-seeded task list against the docs. Use task_update / task_create to fix anything that\'s missing, miss-scoped, or out of order.',
    '3. For each task, follow the lifecycle: ready → planned (via task_plan_propose + task_plan_approve) → in_progress → testing → merge_ready → done. Do NOT let a teammate skip the plan stage.',

    docs
      ? `Foundry docs (relative to the project root — read each one before planning):\n${docs}`
      : 'No Foundry docs were exported yet — surface this to the human before starting work.',

    'Delegation rules:',
    '- Only assign tasks to teammates whose role matches the work (architect for design, developer for implementation, reviewer for code review, tester for validation).',
    '- Each task you assign must have an approved plan and explicit acceptance criteria the assignee can verify against.',
    '- If acceptance criteria are vague or missing in the Foundry docs, ask the human via cross_team_send before assigning.',

    'Quality gates:',
    '- testing → merge_ready requires a passing validation_run.',
    '- merge_ready → done requires (a) a passing review_decide AND (b) any task tagged requiresHumanApproval must have task_human_approve before merging.',
    '- If branch protection is configured on the remote (github_get_branch_protection), open a PR via github_create_pull_request instead of local-merging.',

    'Stay focused on the Foundry-defined scope. If a teammate proposes work outside the docs, ask the human first.',
  ].join('\n\n');
}

function buildFoundryTaskSpecs(snapshot) {
  const artifacts = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
  const taskArtifact = artifacts.find((artifact) => artifact.kind === 'task_breakdown')
    || artifacts.find((artifact) => /task/i.test(artifact.title || ''));
  const parsed = taskArtifact ? parseTaskBreakdownArtifact(taskArtifact) : [];
  const specs = parsed.length > 0 ? parsed : buildFallbackTaskSpecs(artifacts);
  return specs.map((spec, index) => ({
    taskId: `T-${String(index + 1).padStart(3, '0')}`,
    subject: spec.subject,
    description: spec.description,
    assignedRole: inferAssignedRole(spec.subject, spec.description),
    expectedDeliverables: spec.expectedDeliverables,
    acceptanceCriteria: spec.acceptanceCriteria,
    delivers: spec.delivers,
  }));
}

function parseTaskBreakdownArtifact(artifact) {
  const lines = String(artifact.content || '').replace(/\r\n/g, '\n').split('\n');
  const tasks = [];
  let current = null;
  for (const line of lines) {
    // Match: "## Task 3 — subject" / "## Task 3 - subject" / "## Task 3: subject"
    // or any other H2 heading. Handles hyphen, en-dash, em-dash, colon.
    const heading = /^##\s+Task\s+\d+\s*[-–—:]\s*(.+)$/i.exec(line.trim())
      || /^##\s+(.+)$/i.exec(line.trim());
    if (heading) {
      if (current) tasks.push(current);
      current = { subject: heading[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) tasks.push(current);
  return tasks
    .map((task) => taskFromLines(task.subject, task.lines, artifact.targetPath))
    .filter((task) => task.subject.length > 0);
}

function taskFromLines(subject, lines, targetPath) {
  const bodyLines = lines.map((line) => line.trim()).filter(Boolean);
  const expectedDeliverables = [];
  const acceptanceCriteria = [];
  // L1.2a: explicit task→spec-module link. `Delivers:` carries
  // comma-separated structure tokens ("module:<name>" /
  // "endpoint:<METHOD> <path>") copied from spec.json — distinct from
  // the free-text `Deliverable:` marker. Drives roadmap-aware
  // structural drift; never inferred from the subject.
  const delivers = [];
  for (const line of bodyLines) {
    const cleaned = line.replace(/^[-*]\s*/, '');
    const deliverable = /^Deliverable:\s*(.+)$/i.exec(cleaned);
    const acceptance = /^Acceptance:\s*(.+)$/i.exec(cleaned);
    const deliversLine = /^Delivers:\s*(.+)$/i.exec(cleaned);
    if (deliverable) expectedDeliverables.push(deliverable[1].trim());
    if (acceptance) acceptanceCriteria.push(acceptance[1].trim());
    if (deliversLine) {
      for (const tok of deliversLine[1].split(',')) {
        const t = tok.trim();
        if (t.length > 0) delivers.push(t);
      }
    }
  }
  const sourceLine = targetPath ? `Source: ${targetPath}` : null;
  return {
    subject: cleanTaskSubject(subject),
    description: [sourceLine, ...bodyLines].filter(Boolean).join('\n'),
    expectedDeliverables,
    acceptanceCriteria,
    delivers,
  };
}

function buildFallbackTaskSpecs(artifacts) {
  const docs = artifacts
    .filter((artifact) => typeof artifact.targetPath === 'string' && artifact.targetPath.length > 0)
    .map((artifact) => `- ${artifact.title}: ${artifact.targetPath}`)
    .join('\n');
  return [
    {
      subject: 'Review Foundry docs and finalize implementation plan',
      description: [
        'Source: Foundry generated artifacts',
        docs,
        'Turn the exported docs into an approved TOAD task plan before implementation starts.',
      ].filter(Boolean).join('\n'),
      expectedDeliverables: ['Approved implementation plan'],
      acceptanceCriteria: ['Team can map each planned task to a Foundry artifact'],
      delivers: [],
    },
  ];
}

function cleanTaskSubject(subject) {
  return String(subject || '')
    .replace(/^Task\s+\d+\s*[-:]\s*/i, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function inferAssignedRole(subject, description) {
  const text = `${subject} ${description}`.toLowerCase();
  if (/test|validation|qa|acceptance|handoff/.test(text)) return 'tester';
  if (/review|security|risk/.test(text)) return 'reviewer';
  if (/requirement|brief|roadmap|spec|architecture|contract/.test(text)) return 'architect';
  return 'developer';
}

function slugifyTeamId(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'foundry-project';
}

function truncate(value, max) {
  if (typeof value !== 'string') return '';
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Tiny path-matcher for §13 scope-drift detection. Supports:
 *   - exact match: "src/parser.js" matches "src/parser.js"
 *   - directory recursive: "src/parser/**" matches "src/parser/x" and
 *     "src/parser/sub/y" (anything under src/parser/)
 *   - directory prefix: "src/parser/" matches anything under src/parser/
 *
 * Patterns and paths are case-sensitive. No globstar in the middle of a
 * pattern (e.g. "src/**\/test.js"); add later if a slice needs it.
 */
/**
 * §14 follow-up: pull shell commands the agent ran out of `runtime_events`.
 * Looks for `tool_use` events on Bash-shaped tools (`Bash` or any MCP-wrapped
 * shell) and extracts the `input.command` string. Used to feed
 * `policy.commandRules` into the risk classifier at review_request time.
 */
function extractBashCommands(events) {
  if (!Array.isArray(events)) return [];
  const SHELL_TOOL_NAMES = new Set(['Bash']);
  const commands = [];
  for (const e of events) {
    if (!e || e.eventType !== 'tool_use') continue;
    const p = e.payload || {};
    const tool = typeof p.toolName === 'string' ? p.toolName : null;
    if (!tool) continue;
    const isShell = SHELL_TOOL_NAMES.has(tool) || /Bash/i.test(tool);
    if (!isShell) continue;
    const input = p.input && typeof p.input === 'object' ? p.input : {};
    const command = typeof input.command === 'string' ? input.command : null;
    if (command && command.length > 0) commands.push(command);
  }
  return commands;
}

function matchesAny(file, patterns) {
  if (typeof file !== 'string') return false;
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) continue;
    if (file === p) return true;
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3);
      if (prefix.length === 0) return true; // "/**" matches everything
      if (file === prefix) return true;
      if (file.startsWith(prefix + '/')) return true;
    } else if (p.endsWith('/')) {
      if (file.startsWith(p)) return true;
    }
  }
  return false;
}

function enforceReviewFileContract(task, files) {
  if (!task || !Array.isArray(files) || files.length === 0) return;
  const forbidden = Array.isArray(task.forbiddenFiles) ? task.forbiddenFiles : [];
  if (forbidden.length > 0) {
    const violations = files.filter((file) => matchesAny(file, forbidden));
    if (violations.length > 0) {
      throw new Error(`review_request: changed files include forbidden paths: ${violations.join(', ')}`);
    }
  }
  const allowed = Array.isArray(task.allowedFiles) ? task.allowedFiles : [];
  if (allowed.length > 0) {
    const violations = files.filter((file) => !matchesAny(file, allowed));
    if (violations.length > 0) {
      throw new Error(`review_request: changed files outside allowedFiles: ${violations.join(', ')}`);
    }
  }
}

function defaultSpawnValidation(command, { cwd } = {}) {
  // Returns { exitCode, stdout, stderr, durationMs }. Sync via spawnSync because
  // validation runs are blocking by intent — the caller awaits the result. Tests
  // pass their own spawn fn through the LocalToolFacade `spawnValidation` option.
  const start = Date.now();
  const result = spawnSync(command, {
    cwd: cwd || process.cwd(),
    shell: true,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: typeof result.status === 'number' ? result.status : -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    durationMs: Date.now() - start,
  };
}

function normalizeTaskRiskContractArgs(args) {
  const payload = {};
  const allowedFiles = normalizeStringList(args.allowedFiles);
  if (allowedFiles) payload.allowedFiles = allowedFiles;
  const forbiddenFiles = normalizeStringList(args.forbiddenFiles);
  if (forbiddenFiles) payload.forbiddenFiles = forbiddenFiles;
  const acceptanceCriteria = normalizeStringList(args.acceptanceCriteria);
  if (acceptanceCriteria) payload.acceptanceCriteria = acceptanceCriteria;
  if (typeof args.riskLevel === 'string' && args.riskLevel.trim().length > 0) {
    const riskLevel = args.riskLevel.trim();
    if (!TASK_RISK_LEVELS.includes(riskLevel)) {
      throw new Error(`task_create: unsupported riskLevel ${riskLevel}`);
    }
    payload.riskLevel = riskLevel;
  }
  if (typeof args.requiresHumanApproval === 'boolean') {
    payload.requiresHumanApproval = args.requiresHumanApproval;
  }
  // §1 follow-up: priority + assignedRole + testCommands + expectedDeliverables
  // + dependencyTaskIds. All optional. priority + assignedRole validate against
  // enums; the others are sanitized string lists.
  if (typeof args.priority === 'string' && args.priority.trim().length > 0) {
    const priority = args.priority.trim();
    if (!TASK_PRIORITY_LEVELS.includes(priority)) {
      throw new Error(`task_create: unsupported priority ${priority}`);
    }
    payload.priority = priority;
  }
  if (typeof args.assignedRole === 'string' && args.assignedRole.trim().length > 0) {
    const assignedRole = args.assignedRole.trim();
    if (!TASK_ASSIGNED_ROLES.includes(assignedRole)) {
      throw new Error(`task_create: unsupported assignedRole ${assignedRole}`);
    }
    payload.assignedRole = assignedRole;
  }
  // M.1b: optional task type ('feature' | 'bug'). Omit when absent so the
  // projection defaults kick in (back-compat with legacy callers that pre-date
  // this slice). Validate against the enum for defense-in-depth alongside the
  // MCP schema check.
  if (typeof args.type === 'string' && args.type.trim().length > 0) {
    const type = args.type.trim();
    if (!TASK_TYPES.includes(type)) {
      throw new Error(`task_create: unsupported type ${type}`);
    }
    payload.type = type;
  }
  const testCommands = normalizeStringList(args.testCommands);
  if (testCommands) payload.testCommands = testCommands;
  const expectedDeliverables = normalizeStringList(args.expectedDeliverables);
  if (expectedDeliverables) payload.expectedDeliverables = expectedDeliverables;
  const dependencyTaskIds = normalizeStringList(args.dependencyTaskIds);
  if (dependencyTaskIds) payload.dependencyTaskIds = dependencyTaskIds;
  // L1.2a structural-drift roadmap link. Explicit task→spec-module
  // tokens ("module:<name>" / "endpoint:<method> <path>"). Sanitized
  // as a plain string list — the consumer (checkStructuralDeclaredAbsent)
  // matches tokens exactly and fails GENTLY on a malformed token (a
  // non-matching delivers entry degrades to the "no delivery task"
  // low finding, never a false high/critical), so strict format
  // validation here would be YAGNI.
  const delivers = normalizeStringList(args.delivers);
  if (delivers) payload.delivers = delivers;
  return payload;
}

export const TASK_PRIORITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'urgent']);
export const TASK_ASSIGNED_ROLES = Object.freeze(['lead', 'architect', 'developer', 'reviewer', 'tester', 'human']);

function normalizeStringList(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('actor is required');
  }
  const normalized = {
    teamId: requireString(actor.teamId, 'actor.teamId'),
    agentId: requireString(actor.agentId, 'actor.agentId'),
  };
  if (typeof actor.role === 'string' && actor.role.length > 0) {
    normalized.role = actor.role;
  }
  return normalized;
}

function normalizeMessageRecipient(teamId, recipient) {
  if (!recipient || typeof recipient !== 'object') {
    throw new TypeError('args.to is required');
  }
  const kind = requireString(recipient.kind, 'args.to.kind');
  if (kind === 'user' || kind === 'system') return { kind };
  if (kind === 'team') return { kind, teamId: recipient.teamId || teamId };
  if (kind === 'agent') {
    return {
      kind,
      teamId: recipient.teamId || teamId,
      agentId: requireString(recipient.agentId, 'args.to.agentId'),
    };
  }
  throw new Error(`unsupported recipient kind: ${kind}`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Bug 2 (2026-05-12 triage) helper. Some team configs were created
 * with relative `cwd` values — most notably the symphony-demo seed
 * which stores `cwd: '.'`. When that lands in the agent's system
 * prompt or the spawn's working directory, the agent ends up
 * pointing at whatever the sidecar's current dir happens to be
 * (typically toad-local) rather than the project the user picked.
 *
 * If `cwd` is absolute, returns it unchanged.
 * If `cwd` is relative AND projectCwd is set, returns the absolute
 *   path produced by resolving cwd against projectCwd.
 * If `cwd` is relative AND projectCwd is unset, returns the original
 *   cwd unchanged (caller decides whether to error or accept).
 * If `cwd` is empty/non-string, returns it as-is.
 */
function resolveAgainstProjectRoot(cwd, projectCwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return cwd;
  if (path.isAbsolute(cwd)) return cwd;
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) return cwd;
  return path.resolve(projectCwd, cwd);
}
