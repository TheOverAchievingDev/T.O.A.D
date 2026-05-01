import { spawnSync } from 'node:child_process';
import { COMMANDS, commandRequiresIdempotency } from '../commands/command-contract.js';
import { MESSAGE_KINDS } from '../protocol/envelopes.js';
import {
  TASK_EVENT_TYPES,
  TASK_RISK_LEVELS,
  TASK_STATUS,
} from '../task/inMemoryTaskBoard.js';
import { applyPermissionSuggestions } from '../runtime/claudeSettingsWriter.js';
import { formatCrossTeamText, CROSS_TEAM_SOURCE, CROSS_TEAM_SENT_SOURCE } from '../protocol/crossTeam.js';
import { TeamConfig } from '../team/teamConfig.js';
import { validateTaskStatusTransition } from '../task/taskLifecycle.js';
import { assertRoleCanCallTool } from '../security/roleAuthority.js';
import { runDiagnostics } from '../diagnostics/runDiagnostics.js';
import { classify as classifyRisk } from '../policy/riskClassifier.js';
import { computeDiff as defaultComputeDiff } from '../task/diffComputer.js';

export class LocalToolFacade {
  constructor({ broker, taskBoard, runtimeRegistry = null, approvalBroker = null, adapters = null, projectCwd = null, readModel = null, launchAgent = null, stopAgent = null, teamConfigRegistry = null, spawnValidation = null, dbPath = null, eventLog = null, worktreeManager = null, diffComputer = null, mergeChecker = null, riskPolicy = null }) {
    if (!broker) throw new TypeError('broker is required');
    if (!taskBoard) throw new TypeError('taskBoard is required');
    this.broker = broker;
    this.taskBoard = taskBoard;
    this.runtimeRegistry = runtimeRegistry;
    this.approvalBroker = approvalBroker;
    this.adapters = adapters;
    this.projectCwd = projectCwd;
    this.readModel = readModel;
    this.launchAgent = typeof launchAgent === 'function' ? launchAgent : null;
    this.stopAgent = typeof stopAgent === 'function' ? stopAgent : null;
    this.teamConfigRegistry = teamConfigRegistry;
    this.spawnValidation = typeof spawnValidation === 'function' ? spawnValidation : defaultSpawnValidation;
    this.dbPath = typeof dbPath === 'string' && dbPath.length > 0 ? dbPath : null;
    this.eventLog = eventLog && typeof eventLog.appendEvent === 'function' ? eventLog : null;
    this.worktreeManager = worktreeManager && typeof worktreeManager.createForTask === 'function' ? worktreeManager : null;
    this.diffComputer = diffComputer && typeof diffComputer.computeDiff === 'function'
      ? diffComputer
      : { computeDiff: defaultComputeDiff };
    this.mergeChecker = mergeChecker && typeof mergeChecker.checkForConflicts === 'function' ? mergeChecker : null;
    // §14: project-local risk policy. Null = no auto-classification (back-compat).
    this.riskPolicy = riskPolicy && Array.isArray(riskPolicy.rules) ? riskPolicy : null;
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
      case COMMANDS.TASK_CREATE:
        return this.#taskCreate(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_COMMENT:
        return this.#taskComment(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_UPDATE:
        return this.#taskUpdate(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_REQUEST:
        return this.#reviewRequest(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_DECIDE:
        return this.#reviewDecide(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_LIST:
        return this.#reviewList(actor);
      case COMMANDS.TASK_LIST:
        return this.taskBoard.listTasks({ teamId: actor.teamId });
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
      default:
        throw new Error(`unsupported command: ${commandName}`);
    }
  }

  #messageSend(actor, idempotencyKey, args) {
    return this.broker.appendMessage({
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
        const classification = classifyRisk({
          files: payload.files,
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
        .map((f) => ({ file: f.file, comment: f.comment }));
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
    const tasks = this.taskBoard.listTasks({ teamId: actor.teamId }) || [];
    return tasks.filter((t) => t && t.review && t.review.state === 'requested');
  }

  #agentStatus(actor, args) {
    if (!this.runtimeRegistry) return [];
    if (typeof args.runtimeId === 'string' && args.runtimeId.trim()) {
      const runtime = this.runtimeRegistry.getRuntime?.(args.runtimeId.trim()) || null;
      return runtime && runtime.teamId === actor.teamId ? runtime : null;
    }
    if (typeof this.runtimeRegistry.listRuntimes !== 'function') return [];
    return this.runtimeRegistry.listRuntimes({ teamId: actor.teamId });
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
    if (!this.readModel || typeof this.readModel.listApprovals !== 'function') return [];
    return this.readModel.listApprovals({ teamId: actor.teamId });
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
    if (!this.readModel || typeof this.readModel.listToolCalls !== 'function') return [];
    return this.readModel.listToolCalls({
      teamId: actor.teamId,
      runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
    });
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
    if (!this.readModel || typeof this.readModel.listRuntimeAudit !== 'function') return [];
    return this.readModel.listRuntimeAudit({
      teamId: actor.teamId,
      runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
    });
  }

  #crossTeamMessages(actor, args) {
    if (!this.readModel || typeof this.readModel.listCrossTeamMessages !== 'function') return [];
    return this.readModel.listCrossTeamMessages({
      teamId: actor.teamId,
      limit: Number.isInteger(args.limit) ? args.limit : null,
    });
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
    for (const member of members) {
      const runtimeId = `runtime-${teamId}-${member.agentId}`;
      const existing = this.runtimeRegistry?.getRuntime?.(runtimeId);
      if (existing && existing.status === 'running') {
        results.push({ runtimeId, agentId: member.agentId, status: 'already_running' });
        continue;
      }
      try {
        const launchInput = {
          teamId,
          agentId: member.agentId,
          runtimeId,
          command: member.command,
        };
        if (Array.isArray(member.args) && member.args.length > 0) launchInput.args = member.args;
        if (typeof member.cwd === 'string' && member.cwd.length > 0) launchInput.cwd = member.cwd;
        if (member.env && typeof member.env === 'object' && Object.keys(member.env).length > 0) launchInput.env = member.env;
        if (typeof member.providerId === 'string' && member.providerId.length > 0) launchInput.providerId = member.providerId;
        if (typeof member.role === 'string' && member.role.length > 0) launchInput.role = member.role;
        if (typeof member.skipPermissions === 'boolean') launchInput.skipPermissions = member.skipPermissions;
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
  return payload;
}

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
