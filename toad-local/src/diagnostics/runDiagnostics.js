/**
 * System diagnostics — checklist §25.
 *
 * Re-runs the enforcement checks the orchestrator already depends on so an
 * operator can answer "is the system genuinely safe vs. agent-claimed safe?"
 * before launching a team. Pure: no mutation, no event emission. Tests inject
 * `spawnValidation` and a `teamConfigRegistry`; the runtime injects real ones
 * via `LocalToolFacade`.
 */

import { validateTaskStatusTransition } from '../task/taskLifecycle.js';
import { assertRoleCanCallTool } from '../security/roleAuthority.js';

const CLAUDE_VERSION_CMD = 'claude --version';
const CLAUDE_AUTH_CMD = 'claude auth status --json';

export function runDiagnostics({
  teamConfigRegistry = null,
  spawnValidation = null,
  dbPath = null,
} = {}) {
  const checks = [];

  checks.push(checkInvalidTransitionRejected());
  checks.push(checkLegalTransitionAllowed());
  checks.push(checkDeveloperCannotAgentLaunch());
  checks.push(checkUnknownRoleDenied());
  checks.push(checkValidationConfigured(teamConfigRegistry));

  const versionResult = safeSpawn(spawnValidation, CLAUDE_VERSION_CMD);
  checks.push(checkProviderDetected(versionResult));
  checks.push(checkProviderAuthenticated(versionResult, spawnValidation));

  checks.push(checkDbPathPersistent(dbPath));

  const summary = tally(checks);
  return { checks, summary };
}

function checkInvalidTransitionRejected() {
  const id = 'state_machine_invalid_transitions_rejected';
  const label = 'State machine rejects invalid transitions';
  try {
    const result = validateTaskStatusTransition({ from: 'done', to: 'in_progress' });
    if (result && result.ok === false) {
      return pass(id, label, { from: 'done', to: 'in_progress', reason: result.reason });
    }
    return fail(id, label, {
      observed: result,
      hint: 'state machine accepted an illegal transition',
    });
  } catch (err) {
    return fail(id, label, { error: err.message });
  }
}

function checkLegalTransitionAllowed() {
  const id = 'state_machine_legal_transitions_allowed';
  const label = 'State machine allows legal transitions';
  try {
    const result = validateTaskStatusTransition({ from: 'ready', to: 'planned' });
    if (result && result.ok === true) {
      return pass(id, label, { from: 'ready', to: 'planned' });
    }
    return fail(id, label, { observed: result });
  } catch (err) {
    return fail(id, label, { error: err.message });
  }
}

function checkDeveloperCannotAgentLaunch() {
  const id = 'role_authority_denies_developer_agent_launch';
  const label = 'Role authority denies developer → agent_launch';
  try {
    assertRoleCanCallTool({ role: 'developer', toolName: 'agent_launch' });
    return fail(id, label, {
      hint: 'developer role was allowed to call agent_launch — authority is not enforced',
    });
  } catch (err) {
    return pass(id, label, { observed: err.message });
  }
}

function checkUnknownRoleDenied() {
  const id = 'role_authority_unknown_role_denied';
  const label = 'Role authority denies unknown roles';
  try {
    assertRoleCanCallTool({ role: 'phantom', toolName: 'task_list' });
    return fail(id, label, { hint: 'unknown role passed authority check' });
  } catch (err) {
    return pass(id, label, { observed: err.message });
  }
}

function checkValidationConfigured(registry) {
  const id = 'validation_commands_configured';
  const label = 'Each registered team has validation commands wired';
  if (!registry || typeof registry.listTeams !== 'function') {
    return warning(id, label, {
      hint: 'no team config registry available; cannot verify validation wiring',
    });
  }
  const teams = registry.listTeams();
  if (teams.length === 0) {
    return warning(id, label, {
      hint: 'no teams registered yet — validation_run will have nothing to dispatch',
    });
  }
  const missing = teams.filter((t) => !t || !t.validation).map((t) => t && t.teamId).filter(Boolean);
  if (missing.length === 0) {
    return pass(id, label, { teamCount: teams.length });
  }
  return fail(id, label, {
    teams: missing,
    hint: 'these teams have no validation block — testing → merge_ready will never satisfy CI gates',
    suggestedFix: 'add a validation:{ testCommand, lintCommand, ... } object to each team config',
  });
}

function checkProviderDetected(versionResult) {
  const id = 'provider_claude_detected';
  const label = 'Claude CLI is on PATH';
  if (!versionResult) {
    return fail(id, label, {
      hint: 'no spawn function available; cannot probe claude --version',
      suggestedFix: 'install Claude Code so `claude` is callable from this shell',
    });
  }
  if (versionResult.exitCode === 0) {
    return pass(id, label, {
      version: truncate(versionResult.stdout, 200).trim(),
      durationMs: versionResult.durationMs,
    });
  }
  return fail(id, label, {
    exitCode: versionResult.exitCode,
    stderr: truncate(versionResult.stderr, 400),
    suggestedFix: 'install Claude Code so `claude` is callable from this shell',
  });
}

function checkProviderAuthenticated(versionResult, spawnValidation) {
  const id = 'provider_claude_authenticated';
  const label = 'Claude CLI is authenticated';
  if (!versionResult || versionResult.exitCode !== 0) {
    return warning(id, label, {
      hint: 'cannot verify auth — claude CLI is not detected',
    });
  }
  const authResult = safeSpawn(spawnValidation, CLAUDE_AUTH_CMD);
  if (!authResult) {
    return warning(id, label, { hint: 'no spawn function available' });
  }
  if (authResult.exitCode !== 0) {
    return warning(id, label, {
      exitCode: authResult.exitCode,
      stderr: truncate(authResult.stderr, 400),
      hint: 'claude auth status exited non-zero',
      suggestedFix: 'run `claude /login` to authenticate the CLI',
    });
  }
  let parsed = null;
  try {
    parsed = JSON.parse(authResult.stdout);
  } catch {
    return warning(id, label, {
      hint: 'auth status did not return JSON',
      stdoutSample: truncate(authResult.stdout, 200),
    });
  }
  if (parsed && parsed.loggedIn === true) {
    return pass(id, label, { user: parsed.user || null });
  }
  return warning(id, label, {
    parsed,
    hint: 'CLI reports not logged in',
    suggestedFix: 'run `claude /login` to authenticate the CLI',
  });
}

function checkDbPathPersistent(dbPath) {
  const id = 'dbpath_persistent';
  const label = 'SQLite database path is persistent';
  if (typeof dbPath !== 'string' || dbPath.length === 0) {
    return warning(id, label, {
      observed: dbPath,
      hint: 'no dbPath wired — runtime is using an unnamed in-memory db',
      suggestedFix: 'pass dbPath through LocalToadRuntime',
    });
  }
  if (dbPath === ':memory:') {
    return warning(id, label, {
      observed: ':memory:',
      hint: 'in-memory db — events, tasks, approvals will not survive restart',
      suggestedFix: 'use a real filesystem path like .toad/toad.db',
    });
  }
  return pass(id, label, { dbPath });
}

function safeSpawn(spawnFn, command) {
  if (typeof spawnFn !== 'function') return null;
  try {
    return spawnFn(command, {});
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: err.message, durationMs: 0 };
  }
}

function pass(id, label, evidence = {}) {
  return { id, label, status: 'pass', evidence };
}

function warning(id, label, evidence = {}) {
  const entry = { id, label, status: 'warning', evidence };
  if (typeof evidence.suggestedFix === 'string') entry.suggestedFix = evidence.suggestedFix;
  return entry;
}

function fail(id, label, evidence = {}) {
  const entry = { id, label, status: 'fail', evidence };
  if (typeof evidence.suggestedFix === 'string') entry.suggestedFix = evidence.suggestedFix;
  return entry;
}

function tally(checks) {
  const summary = { pass: 0, warning: 0, fail: 0 };
  for (const c of checks) {
    if (c.status === 'pass') summary.pass++;
    else if (c.status === 'warning') summary.warning++;
    else if (c.status === 'fail') summary.fail++;
  }
  return summary;
}

function truncate(value, max) {
  if (typeof value !== 'string') return '';
  return value.length <= max ? value : value.slice(0, max);
}
