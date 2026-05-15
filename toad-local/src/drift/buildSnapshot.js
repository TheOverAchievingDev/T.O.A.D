import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit as defaultRunGit } from '../git/runGit.js';
import { loadProjectSpec } from './spec/loadProjectSpec.js';
import { parseManifestDeps } from './spec/parseManifestDeps.js';

const COMMITS_DEFAULT = 30;
const DOC_CAP = 8 * 1024;
const PROJECT_DOC_CANDIDATES = Object.freeze([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
]);
const VALID_COMPARE_MODES = Object.freeze(['foundry_docs', 'current_state']);

/**
 * Fetch up to `count` recent commits via git log, formatted as
 * "shortSha shortMessage (isoAuthorDate)" strings. Fail-soft: returns []
 * on any failure (non-zero exit, throw, missing cwd) so callers don't
 * need to handle errors.
 *
 * Accepts an optional `runGitImpl` for testability — defaults to the
 * production `runGit` from `../git/runGit.js`.
 */
export function getRecentCommits({
  cwd,
  count = COMMITS_DEFAULT,
  runGitImpl = defaultRunGit,
} = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return [];
  try {
    const result = runGitImpl(
      ['log', '-n', String(count), '--pretty=format:%h %s (%ai)'],
      { cwd },
    );
    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') return [];
    return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read up to 4 canonical project docs (README, AGENTS, CLAUDE, CONTRIBUTING)
 * from `cwd`. Each file's content is capped at 8KB to keep the prompt
 * footprint bounded. Returns {} if cwd is invalid or no docs exist.
 *
 * Accepts `existsSyncImpl` / `readFileSyncImpl` overrides for testability.
 */
export function readProjectDocs({
  cwd,
  existsSyncImpl = defaultExistsSync,
  readFileSyncImpl = defaultReadFileSync,
} = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return {};
  const docs = {};
  for (const name of PROJECT_DOC_CANDIDATES) {
    try {
      const fp = join(cwd, name);
      if (!existsSyncImpl(fp)) continue;
      const raw = readFileSyncImpl(fp, 'utf8');
      if (typeof raw !== 'string') continue;
      docs[name] = raw.length > DOC_CAP ? raw.slice(0, DOC_CAP) : raw;
    } catch {
      // skip per-file failures; other candidates may still succeed
    }
  }
  return docs;
}

/**
 * Gather all inputs the deterministic checks need into a single snapshot.
 * The engine calls this once per run; checks read it without further I/O.
 *
 * Tolerates missing optional deps so `drift_run` can succeed even when the
 * worktree manager or foundry store isn't wired (e.g. very early projects
 * before the first Foundry session).
 */
export async function buildSnapshot({ teamId, deps = {}, compareAgainst = 'foundry_docs' } = {}) {
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

  // Defensive fallback: anything outside the allowed set reverts to foundry_docs.
  const mode = VALID_COMPARE_MODES.includes(compareAgainst) ? compareAgainst : 'foundry_docs';

  const tasks = safeArray(taskBoard.listTasks({ teamId }));
  const taskEvents = typeof taskBoard.listEvents === 'function'
    ? safeArray(taskBoard.listEvents({ teamId }))
    : [];
  const runtimeEvents = safeArray(eventLog.listEvents({ teamId }));

  let foundryDocs = {};
  let currentStateContext = null;

  if (mode === 'current_state') {
    // Skip foundryStore.readDocs — even if docs exist, we don't surface them.
    const projectCwd = typeof deps.projectCwd === 'string' && deps.projectCwd.length > 0
      ? deps.projectCwd
      : null;
    currentStateContext = {
      recentCommits: getRecentCommits({
        cwd: projectCwd,
        runGitImpl: deps.runGitImpl,
      }),
      projectDocs: readProjectDocs({
        cwd: projectCwd,
        existsSyncImpl: deps.existsSyncImpl,
        readFileSyncImpl: deps.readFileSyncImpl,
      }),
    };
  } else if (foundryStore && typeof foundryStore.readDocs === 'function') {
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

  // Layer-1 drift inputs. Pre-loaded HERE (not in the checks) so the
  // checks stay pure functions over the snapshot — same pattern as
  // every other check. loadProjectSpec + parseManifestDeps never
  // throw; they degrade to nulls + error strings the check turns
  // into honest meta-findings. See
  // docs/superpowers/specs/2026-05-15-spec-yaml-schema.md.
  const specProjectCwd = typeof deps.projectCwd === 'string' && deps.projectCwd.length > 0
    ? deps.projectCwd
    : null;
  const { spec, error: specError } = loadProjectSpec({
    projectCwd: specProjectCwd,
    existsSyncImpl: deps.existsSyncImpl,
    readFileSyncImpl: deps.readFileSyncImpl,
  });
  let manifestDeps = null;
  let manifestError = null;
  if (spec && spec.stack && typeof spec.stack.manifest === 'string' && specProjectCwd) {
    const manifestPath = join(specProjectCwd, spec.stack.manifest);
    const r = parseManifestDeps({
      manifestPath,
      language: spec.stack.language,
      readFileSyncImpl: deps.readFileSyncImpl,
    });
    manifestDeps = r.deps ? [...r.deps] : null;
    manifestError = r.error;
  }

  return {
    teamId,
    asOf: new Date().toISOString(),
    tasks,
    taskEvents,
    runtimeEvents,
    foundryDocs,
    currentStateContext,
    worktrees,
    diffsByTask,
    teamConfig,
    // Drift L1 inputs (consumed by checkDependencyDrift; future L1
    // checks read other spec sections off `spec`).
    projectCwd: specProjectCwd,
    spec,
    specError,
    manifestDeps,
    manifestError,
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
