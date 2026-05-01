import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics } from '../src/diagnostics/runDiagnostics.js';
import { TeamConfig, TeamConfigRegistry } from '../src/team/teamConfig.js';

function fakeSpawn(table) {
  return (command, _opts) => {
    for (const [match, result] of table) {
      if (command.includes(match)) return result;
    }
    return { exitCode: 127, stdout: '', stderr: 'unknown command', durationMs: 0 };
  };
}

function findCheck(report, id) {
  const hit = report.checks.find((c) => c.id === id);
  if (!hit) throw new Error(`expected check ${id} in report`);
  return hit;
}

test('runDiagnostics returns shape: { checks: [...], summary: { pass, warning, fail } }', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/foo.db',
  });
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.summary && typeof report.summary === 'object');
  assert.equal(typeof report.summary.pass, 'number');
  assert.equal(typeof report.summary.warning, 'number');
  assert.equal(typeof report.summary.fail, 'number');
  for (const c of report.checks) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.label, 'string');
    assert.ok(['pass', 'warning', 'fail'].includes(c.status), `bad status on ${c.id}: ${c.status}`);
  }
});

test('state machine self-check: invalid transition is rejected', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'state_machine_invalid_transitions_rejected');
  assert.equal(check.status, 'pass', `evidence: ${JSON.stringify(check.evidence)}`);
});

test('state machine self-check: legal transition is allowed', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'state_machine_legal_transitions_allowed');
  assert.equal(check.status, 'pass');
});

test('role authority self-check: developer cannot agent_launch', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'role_authority_denies_developer_agent_launch');
  assert.equal(check.status, 'pass');
});

test('role authority self-check: unknown role is denied', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'role_authority_unknown_role_denied');
  assert.equal(check.status, 'pass');
});

test('validation_commands_configured: warning when registry is empty', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'validation_commands_configured');
  assert.equal(check.status, 'warning');
});

test('validation_commands_configured: fail when a team has no validation', () => {
  const registry = new TeamConfigRegistry();
  registry.registerTeam(new TeamConfig({ teamId: 'has-validation', validation: { testCommand: 'npm test' } }));
  registry.registerTeam(new TeamConfig({ teamId: 'no-validation' }));
  const report = runDiagnostics({
    teamConfigRegistry: registry,
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'validation_commands_configured');
  assert.equal(check.status, 'fail');
  // Evidence should mention the offending team
  const evidence = JSON.stringify(check.evidence);
  assert.ok(evidence.includes('no-validation'), `expected offending team in evidence: ${evidence}`);
});

test('validation_commands_configured: pass when every team has validation', () => {
  const registry = new TeamConfigRegistry();
  registry.registerTeam(new TeamConfig({ teamId: 'a', validation: { testCommand: 'npm test' } }));
  registry.registerTeam(new TeamConfig({ teamId: 'b', validation: { lintCommand: 'eslint .' } }));
  const report = runDiagnostics({
    teamConfigRegistry: registry,
    spawnValidation: fakeSpawn([]),
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'validation_commands_configured');
  assert.equal(check.status, 'pass');
});

test('provider_claude_detected: pass when claude --version exits 0', () => {
  const spawn = fakeSpawn([
    ['claude --version', { exitCode: 0, stdout: '1.2.3\n', stderr: '', durationMs: 5 }],
  ]);
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: spawn,
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'provider_claude_detected');
  assert.equal(check.status, 'pass');
});

test('provider_claude_detected: fail when claude --version is missing', () => {
  const spawn = fakeSpawn([
    ['claude --version', { exitCode: 127, stdout: '', stderr: 'not found', durationMs: 0 }],
  ]);
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: spawn,
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'provider_claude_detected');
  assert.equal(check.status, 'fail');
  assert.ok(typeof check.suggestedFix === 'string' && check.suggestedFix.length > 0);
});

test('provider_claude_authenticated: pass on loggedIn:true JSON, with email/authMethod/subscriptionType in evidence', () => {
  const spawn = fakeSpawn([
    ['claude --version', { exitCode: 0, stdout: '1.2.3', stderr: '', durationMs: 1 }],
    ['auth status', {
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'kayden@example.com',
        subscriptionType: 'max',
      }),
      stderr: '',
      durationMs: 2,
    }],
  ]);
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: spawn,
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'provider_claude_authenticated');
  assert.equal(check.status, 'pass');
  assert.equal(check.evidence.email, 'kayden@example.com');
  assert.equal(check.evidence.authMethod, 'claude.ai');
  assert.equal(check.evidence.subscriptionType, 'max');
});

test('provider_claude_authenticated: still passes on a stripped-down loggedIn:true JSON (back-compat)', () => {
  const spawn = fakeSpawn([
    ['claude --version', { exitCode: 0, stdout: '1.2.3', stderr: '', durationMs: 1 }],
    ['auth status', { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '', durationMs: 2 }],
  ]);
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: spawn,
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'provider_claude_authenticated');
  assert.equal(check.status, 'pass');
  // Optional fields are absent (or null) but the check still passes
  assert.equal(check.evidence.email, null);
});

test('provider_claude_authenticated: warning when not authenticated', () => {
  const spawn = fakeSpawn([
    ['claude --version', { exitCode: 0, stdout: '1.2.3', stderr: '', durationMs: 1 }],
    ['auth status', { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '', durationMs: 2 }],
  ]);
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: spawn,
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'provider_claude_authenticated');
  assert.equal(check.status, 'warning');
});

test('provider_claude_authenticated: warning when claude binary itself is missing', () => {
  const spawn = fakeSpawn([
    ['claude --version', { exitCode: 127, stdout: '', stderr: 'not found', durationMs: 0 }],
  ]);
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: spawn,
    dbPath: '/tmp/x.db',
  });
  const check = findCheck(report, 'provider_claude_authenticated');
  assert.equal(check.status, 'warning');
});

test('dbpath_persistent: warning on null', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: null,
  });
  const check = findCheck(report, 'dbpath_persistent');
  assert.equal(check.status, 'warning');
});

test('dbpath_persistent: warning on :memory:', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: ':memory:',
  });
  const check = findCheck(report, 'dbpath_persistent');
  assert.equal(check.status, 'warning');
});

test('dbpath_persistent: pass on real path', () => {
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: 'C:/Project-TOAD/.toad/toad.db',
  });
  const check = findCheck(report, 'dbpath_persistent');
  assert.equal(check.status, 'pass');
});

test('summary tallies match per-check statuses', () => {
  const registry = new TeamConfigRegistry();
  registry.registerTeam(new TeamConfig({ teamId: 'good', validation: { testCommand: 'npm test' } }));
  const spawn = fakeSpawn([
    ['claude --version', { exitCode: 0, stdout: '1.2.3', stderr: '', durationMs: 1 }],
    ['auth status', { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '', durationMs: 1 }],
  ]);
  const report = runDiagnostics({
    teamConfigRegistry: registry,
    spawnValidation: spawn,
    dbPath: 'C:/Project-TOAD/.toad/toad.db',
  });
  let pass = 0, warning = 0, fail = 0;
  for (const c of report.checks) {
    if (c.status === 'pass') pass++;
    else if (c.status === 'warning') warning++;
    else if (c.status === 'fail') fail++;
  }
  assert.equal(report.summary.pass, pass);
  assert.equal(report.summary.warning, warning);
  assert.equal(report.summary.fail, fail);
});

test('stuck_runtimes_within_threshold: pass when no runtimes are stuck', () => {
  const fakeRegistry = { listRuntimes: () => [
    { runtimeId: 'r1', teamId: 't', agentId: 'a', status: 'running', startedAt: '2026-05-01T22:00:00.000Z' },
  ]};
  const fakeEventLog = { latestEventByRuntime: () => new Map([['r1', '2026-05-01T22:00:00.000Z']]) };
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/x.db',
    runtimeRegistry: fakeRegistry,
    eventLog: fakeEventLog,
    now: '2026-05-01T22:00:01.000Z',
  });
  const check = findCheck(report, 'stuck_runtimes_within_threshold');
  assert.equal(check.status, 'pass');
});

test('stuck_runtimes_within_threshold: warning when ≥1 runtime is stuck', () => {
  const fakeRegistry = { listRuntimes: () => [
    { runtimeId: 'r1', teamId: 't', agentId: 'a', status: 'running', taskId: 'task-stuck', startedAt: '2026-05-01T20:00:00.000Z' },
  ]};
  const fakeEventLog = { latestEventByRuntime: () => new Map([['r1', '2026-05-01T21:00:00.000Z']]) };
  const report = runDiagnostics({
    teamConfigRegistry: new TeamConfigRegistry(),
    spawnValidation: fakeSpawn([]),
    dbPath: '/x.db',
    runtimeRegistry: fakeRegistry,
    eventLog: fakeEventLog,
    now: '2026-05-01T22:00:00.000Z',
    stuckThresholdMs: 15 * 60_000,
  });
  const check = findCheck(report, 'stuck_runtimes_within_threshold');
  assert.equal(check.status, 'warning');
  assert.equal(check.evidence.stuckCount, 1);
  assert.equal(check.evidence.stuck[0].runtimeId, 'r1');
});
