/**
 * Gather all inputs the deterministic checks need into a single snapshot.
 * The engine calls this once per run; checks read it without further I/O.
 *
 * Tolerates missing optional deps so `drift_run` can succeed even when the
 * worktree manager or foundry store isn't wired (e.g. very early projects
 * before the first Foundry session).
 */
export async function buildSnapshot({ teamId, deps = {} } = {}) {
  if (typeof teamId !== 'string' || teamId.length === 0) {
    throw new TypeError('buildSnapshot: teamId required');
  }
  const { taskBoard, eventLog, foundryStore, worktreeManager, diffComputer } = deps;
  if (!taskBoard || typeof taskBoard.listTasks !== 'function') {
    throw new TypeError('buildSnapshot: deps.taskBoard with listTasks required');
  }
  if (!eventLog || typeof eventLog.listEvents !== 'function') {
    throw new TypeError('buildSnapshot: deps.eventLog with listEvents required');
  }

  const tasks = safeArray(taskBoard.listTasks({ teamId }));
  const taskEvents = typeof taskBoard.listEvents === 'function'
    ? safeArray(taskBoard.listEvents({ teamId }))
    : [];
  const runtimeEvents = safeArray(eventLog.listEvents({ teamId }));

  let foundryDocs = {};
  if (foundryStore && typeof foundryStore.readDocs === 'function') {
    try {
      const docs = foundryStore.readDocs({ teamId }) || {};
      foundryDocs = pickStringFields(docs, [
        'architecture', 'steering', 'designDecisions',
        'definitionOfDone', 'checklist',
      ]);
    } catch {
      foundryDocs = {};
    }
  }

  let worktrees = [];
  if (worktreeManager && typeof worktreeManager.listWorktrees === 'function') {
    try {
      worktrees = safeArray(worktreeManager.listWorktrees({ teamId }));
    } catch {
      worktrees = [];
    }
  }

  let teamConfig = null;
  if (deps.teamConfigRegistry && typeof deps.teamConfigRegistry.getTeam === 'function') {
    try {
      teamConfig = deps.teamConfigRegistry.getTeam({ teamId }) || null;
    } catch {
      teamConfig = null;
    }
  }

  const diffsByTask = {};
  if (diffComputer && typeof diffComputer.computeDiff === 'function') {
    for (const wt of worktrees) {
      if (!wt || typeof wt.path !== 'string' || typeof wt.taskId !== 'string') continue;
      try {
        const result = diffComputer.computeDiff({
          worktreePath: wt.path,
          baseRef: wt.baseRef ?? 'main',
        });
        diffsByTask[wt.taskId] = {
          changedFiles: Array.isArray(result?.files) ? result.files : [],
          diff: result?.diff ?? null,
          error: result?.error ?? null,
        };
      } catch {
        // skip — the check that needs the diff will treat it as empty
      }
    }
  }

  return {
    teamId,
    asOf: new Date().toISOString(),
    tasks,
    taskEvents,
    runtimeEvents,
    foundryDocs,
    worktrees,
    diffsByTask,
    teamConfig,
  };
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function pickStringFields(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].length > 0) out[k] = obj[k];
  }
  return out;
}
