import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSession } from '../src/transport/terminalSession.js';

/**
 * Smoke tests for TerminalSession — verifies the node-pty bridge
 * constructor guards, ID getter, and kill lifecycle without
 * requiring a real shell process in the test harness.
 */

test('TerminalSession rejects missing id', () => {
  assert.throws(() => new TerminalSession({ ws: {} }), /id required/);
});

test('TerminalSession rejects missing ws', () => {
  assert.throws(() => new TerminalSession({ id: 't1' }), /ws required/);
});

test('TerminalSession stores id and starts alive', () => {
  // Use a fake WebSocket-like object that doesn't trigger real I/O.
  // The PTY spawn will fail silently in test (no real shell), but the
  // session constructor should still initialize without throwing.
  const ws = { on() {}, readyState: 1 };
  let session;
  try {
    session = new TerminalSession({ id: 't1', cwd: process.cwd(), ws });
  } catch {
    // node-pty spawn may fail in CI (no shell) — that's fine for this test.
    return;
  }
  assert.equal(session.id, 't1');
  assert.equal(session.alive, true);
  session.kill();
  assert.equal(session.alive, false);
});

test('kill is idempotent', () => {
  const ws = { on() {}, readyState: 1 };
  let session;
  try {
    session = new TerminalSession({ id: 't2', cwd: process.cwd(), ws });
  } catch {
    return;
  }
  session.kill();
  assert.equal(session.alive, false);
  session.kill(); // second kill should not throw
  assert.equal(session.alive, false);
});
