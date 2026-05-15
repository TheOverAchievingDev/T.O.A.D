import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Point the ledger at an isolated tempdir per test so the operator's
// real ~/.symphony/active-pids/ isn't touched. Set BEFORE the import.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-pid-ledger-test-'));
process.env.SYMPHONY_PID_LEDGER_DIR = TEST_DIR;

const { recordSpawn, removeSpawn, sweepZombies, listLedger } = await import('../src/runtime/spawnLedger.js');

function clearLedger() {
  // Wipe the dir between tests so each starts clean. The ledger
  // recreates it lazily on next recordSpawn.
  try {
    for (const f of fs.readdirSync(TEST_DIR)) {
      fs.unlinkSync(path.join(TEST_DIR, f));
    }
  } catch { /* ignore */ }
}

test('recordSpawn writes one JSON file per PID under the configured dir', () => {
  clearLedger();
  const ok = recordSpawn({ pid: 12345, command: '/usr/bin/claude', runtimeId: 'r-1', sessionId: 's-a' });
  assert.equal(ok, true);
  const entries = listLedger();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pid, 12345);
  assert.equal(entries[0].command, '/usr/bin/claude');
  assert.equal(entries[0].runtimeId, 'r-1');
  assert.equal(entries[0].sessionId, 's-a');
  assert.ok(entries[0].recordedAt);
});

test('removeSpawn deletes the matching entry', () => {
  clearLedger();
  recordSpawn({ pid: 100, command: 'claude', sessionId: 's-a' });
  recordSpawn({ pid: 200, command: 'claude', sessionId: 's-a' });
  assert.equal(listLedger().length, 2);
  removeSpawn(100);
  const remaining = listLedger();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].pid, 200);
});

test('removeSpawn on a missing entry is a no-op (idempotent)', () => {
  clearLedger();
  assert.equal(removeSpawn(99999), false);
});

test('recordSpawn rejects invalid PIDs (not a positive integer)', () => {
  clearLedger();
  assert.equal(recordSpawn({ pid: 0 }), false);
  assert.equal(recordSpawn({ pid: -5 }), false);
  assert.equal(recordSpawn({ pid: 'abc' }), false);
  assert.equal(recordSpawn({ pid: null }), false);
  assert.equal(recordSpawn({}), false);
  assert.equal(listLedger().length, 0);
});

test('sweepZombies leaves the current sidecar\'s session entries alone', () => {
  clearLedger();
  recordSpawn({ pid: 100, command: 'claude', sessionId: 'current' });
  recordSpawn({ pid: 200, command: 'claude', sessionId: 'old-session' });
  // PID 100 is "current sidecar's" — don't touch. PID 200 is from an
  // older session that died without cleaning up. We don't actually
  // kill anything here because we point at fake PIDs; we just verify
  // the current-session entry survives.
  sweepZombies({ currentSessionId: 'current' });
  const remaining = listLedger();
  // Current session entry stays; old session entry is gone (was dead /
  // got swept regardless).
  const pids = remaining.map((e) => e.pid).sort();
  assert.deepEqual(pids, [100]);
});

test('sweepZombies kills only ALIVE PIDs that don\'t belong to current session', async () => {
  clearLedger();
  // Spawn a real long-running child we can use as a "zombie": node sleep.
  // Using a forked node process keeps the test cross-platform.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000);'], {
    stdio: 'ignore', detached: false,
  });
  const livePid = child.pid;
  try {
    // Give the process a beat to actually be alive.
    await sleep(50);
    // Record TWO entries: one from a different session (should die),
    // one from current session (should survive).
    recordSpawn({ pid: livePid, command: process.execPath, sessionId: 'orphan-session' });
    recordSpawn({ pid: 999999, command: process.execPath, sessionId: 'current' }); // dead pid + current session
    const result = sweepZombies({ currentSessionId: 'current' });
    // livePid: killed. 999999: skipped (current session).
    assert.equal(result.killed, 1, `expected 1 kill, got ${result.killed}`);
    // Wait for OS to reap the child so the next test isn't racey.
    await new Promise((resolve) => {
      let resolved = false;
      child.once('exit', () => { resolved = true; resolve(); });
      // Belt + suspenders: if the exit event already fired before we
      // attached, the polling loop catches it.
      const t = setInterval(() => {
        try { process.kill(livePid, 0); }
        catch { clearInterval(t); if (!resolved) resolve(); }
      }, 20);
      setTimeout(() => { clearInterval(t); resolve(); }, 1000);
    });
    // The ledger entry for the killed pid should have been removed.
    const remainingPids = listLedger().map((e) => e.pid);
    assert.ok(!remainingPids.includes(livePid), 'killed PID should be removed from ledger');
    // The current-session entry stays.
    assert.ok(remainingPids.includes(999999), 'current-session entries are not swept');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
});

test('sweepZombies removes ledger entries for PIDs that are already dead', () => {
  clearLedger();
  // 999999 almost certainly isn't a live PID on any test machine.
  recordSpawn({ pid: 999999, command: 'claude', sessionId: 'old' });
  const result = sweepZombies({ currentSessionId: 'current' });
  assert.equal(result.killed, 0);
  assert.equal(result.notFound, 1);
  assert.equal(listLedger().length, 0, 'dead-PID entry should be cleaned up');
});

test('sweepZombies handles corrupt JSON entries gracefully (deletes them)', () => {
  clearLedger();
  fs.writeFileSync(path.join(TEST_DIR, '1234.json'), 'not-valid-json', 'utf-8');
  recordSpawn({ pid: 999998, command: 'claude', sessionId: 'old' });
  const result = sweepZombies({ currentSessionId: 'current' });
  // The corrupt entry was deleted but doesn't crash the sweep.
  const remaining = fs.readdirSync(TEST_DIR);
  assert.ok(!remaining.includes('1234.json'), 'corrupt entry should be deleted');
  // The other (dead) entry was swept normally.
  assert.equal(result.notFound, 1);
});

test('sweepZombies returns an empty result when the ledger dir is empty (first-boot case)', () => {
  clearLedger();
  const result = sweepZombies({ currentSessionId: 'current' });
  assert.equal(result.swept, 0);
  assert.equal(result.killed, 0);
  assert.equal(result.notFound, 0);
  assert.deepEqual(result.errors, []);
});
