// T7 — Auth-preflight wiring integration tests for LocalToadRuntime.
// TDD discipline: this file was written BEFORE the wiring was added to
// LocalToadRuntime so the first run must fail (no preflight guard yet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';
import { claudeAuthPreflight } from '../src/runtime/authPreflight/index.js';
import { TOKEN_STATUS } from '../src/providers/providerAuth.js';

// ── Copied verbatim from test/localToadRuntime.test.js ──────────────────────
function createFakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = {
    writable: true,
    destroyed: false,
    writes: [],
    write(line, callback) {
      this.writes.push(line);
      callback();
    },
  };
  child.stdout = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killCalls.push(signal);
    child.emit('exit', 0, signal);
    return true;
  };
  return child;
}
// ── End copy ─────────────────────────────────────────────────────────────────

/**
 * Minimal fake supervisor that records launchAgent calls.
 * Returns { runtimeId } so the rest of LocalToadRuntime.launchAgent
 * doesn't throw (it calls supervisor.getAdapter after).
 */
function createFakeSupervisor() {
  const calls = [];
  return {
    launchAgent(input) {
      calls.push(input);
      return Promise.resolve({ runtimeId: input.runtimeId ?? 'runtime-fake-1' });
    },
    getAdapter(_runtimeId) {
      // Return null — no adapter; LocalToadRuntime.launchAgent guards `if (adapter)` before doing adapter work.
      return null;
    },
    stopAgent(_runtimeId) {
      return Promise.resolve({ runtimeId: _runtimeId });
    },
    listRuntimes() {
      return [];
    },
    calls,
  };
}

// ── (a) block case: command='claude', preflight → block ──────────────────────
test('launchAgent rejects when preflight blocks (claude command, projectCwd set)', async () => {
  const projectCwd = mkdtempSync(join(tmpdir(), 'toad-authpf-'));
  const supervisor = createFakeSupervisor();
  const child = createFakeChild();

  // Fake preflight that always blocks
  const claudeAuthPreflightImpl = async () => ({
    decision: 'block',
    tokenStatus: TOKEN_STATUS.UNRECOVERABLE,
    reason: 'Claude token expired and the automatic refresh did not succeed. Re-login: run `claude` in a terminal, then `/login`, and relaunch.',
  });
  // Fake readClaudeCredsStatus — should not be called (preflight is fully fake)
  const readClaudeCredsStatus = () => { throw new Error('should not call readClaudeCredsStatus in fake-preflight test'); };
  const refreshOnceImpl = async () => { throw new Error('should not call refreshOnceImpl in block test'); };

  const runtime = new LocalToadRuntime({
    projectCwd,
    supervisor,
    spawnProcess() { return child; },
    claudeAuthPreflightImpl,
    readClaudeCredsStatus,
    refreshOnceImpl,
  });

  try {
    await assert.rejects(
      () => runtime.launchAgent({
        teamId: 'team-a',
        agentId: 'lead',
        runtimeId: 'runtime-lead-1',
        command: 'claude',
      }),
      /re-login|\/login/i,
      'launchAgent must throw with the block reason',
    );

    assert.equal(supervisor.calls.length, 0, 'supervisor.launchAgent must NOT be called when preflight blocks');
  } finally {
    await runtime.close();
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── (b) proceed case: command='claude', preflight → proceed ──────────────────
test('launchAgent proceeds when preflight allows (claude command, projectCwd set)', async () => {
  const projectCwd = mkdtempSync(join(tmpdir(), 'toad-authpf-'));
  const supervisor = createFakeSupervisor();
  const child = createFakeChild();

  const claudeAuthPreflightImpl = async () => ({
    decision: 'proceed',
    tokenStatus: TOKEN_STATUS.FRESH,
  });
  const readClaudeCredsStatus = () => ({ tokenStatus: TOKEN_STATUS.FRESH });
  const refreshOnceImpl = async () => ({ ok: true, authRejected: false, timedOut: false });

  const runtime = new LocalToadRuntime({
    projectCwd,
    supervisor,
    spawnProcess() { return child; },
    claudeAuthPreflightImpl,
    readClaudeCredsStatus,
    refreshOnceImpl,
  });

  try {
    const result = await runtime.launchAgent({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      command: 'claude',
    });

    assert.equal(supervisor.calls.length, 1, 'supervisor.launchAgent must be called exactly once');
    assert.equal(result.runtimeId, 'runtime-lead-1');
  } finally {
    await runtime.close();
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── (c) non-claude command: preflight NEVER invoked ──────────────────────────
// SP1a: 'codex' is now a first-class Codex session path (see test/codex/localToadRuntime.codexLaunch.test.js); this test guards the preflight-skip + launchAgent invariant for the providers that STILL use the launchAgent path (gemini/opencode/generic).
test('launchAgent skips preflight entirely for non-claude (gemini) commands', async () => {
  const projectCwd = mkdtempSync(join(tmpdir(), 'toad-authpf-'));
  const supervisor = createFakeSupervisor();
  const child = createFakeChild();

  let preflightCalled = 0;
  const claudeAuthPreflightImpl = async () => {
    preflightCalled += 1;
    return { decision: 'block', tokenStatus: TOKEN_STATUS.UNRECOVERABLE, reason: 'should not reach here' };
  };
  const readClaudeCredsStatus = () => { throw new Error('should not be called'); };
  const refreshOnceImpl = async () => { throw new Error('should not be called'); };

  const runtime = new LocalToadRuntime({
    projectCwd,
    supervisor,
    spawnProcess() { return child; },
    claudeAuthPreflightImpl,
    readClaudeCredsStatus,
    refreshOnceImpl,
  });

  try {
    const result = await runtime.launchAgent({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-gemini-1',
      command: 'gemini',
    });

    assert.equal(preflightCalled, 0, 'preflight must not be invoked for non-claude commands');
    assert.equal(supervisor.calls.length, 1, 'supervisor.launchAgent must be called');
    assert.equal(result.runtimeId, 'runtime-gemini-1');
  } finally {
    await runtime.close();
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── (d) concurrent: mutex serializes, refreshOnce called exactly once ─────────
test('concurrent claude launches: refreshOnce called exactly once (mutex + re-read)', async () => {
  const projectCwd = mkdtempSync(join(tmpdir(), 'toad-authpf-'));
  const supervisor = createFakeSupervisor();
  const child = createFakeChild();

  // Real token status progression: stale → fresh after first refresh
  let refreshCount = 0;
  let readCount = 0;

  // readClaudeCredsStatus: returns stale until refresh has been called, then fresh.
  // This is a real function (not the preflight impl) that the REAL claudeAuthPreflight calls.
  const readClaudeCredsStatus = () => {
    readCount += 1;
    if (refreshCount === 0) {
      return { tokenStatus: TOKEN_STATUS.STALE_REFRESHABLE, reason: 'stale' };
    }
    return { tokenStatus: TOKEN_STATUS.FRESH };
  };

  const refreshOnceImpl = async () => {
    refreshCount += 1;
    // Simulate a short delay so the second launch actually queues behind the first
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, authRejected: false, timedOut: false };
  };

  // Use the REAL claudeAuthPreflight so the mutex+re-read behavior is genuinely exercised.
  const runtime = new LocalToadRuntime({
    projectCwd,
    supervisor,
    spawnProcess() { return child; },
    claudeAuthPreflightImpl: claudeAuthPreflight, // REAL implementation
    readClaudeCredsStatus,
    refreshOnceImpl,
  });

  const input = {
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  };

  try {
    // Fire both concurrently
    const [r1, r2] = await Promise.all([
      runtime.launchAgent({ ...input, runtimeId: 'runtime-lead-1' }),
      runtime.launchAgent({ ...input, runtimeId: 'runtime-lead-2' }),
    ]);

    assert.equal(refreshCount, 1, 'refreshOnce must be called exactly once across concurrent launches');
    assert.equal(supervisor.calls.length, 2, 'both launches must reach supervisor.launchAgent');

    // Both launches should have reached the supervisor
    const runtimeIds = supervisor.calls.map((c) => c.runtimeId);
    assert.ok(runtimeIds.includes('runtime-lead-1'), 'launch-1 must have reached supervisor');
    assert.ok(runtimeIds.includes('runtime-lead-2'), 'launch-2 must have reached supervisor');
  } finally {
    await runtime.close();
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
