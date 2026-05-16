import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRefreshOnce } from '../src/runtime/authPreflight/index.js';

function fakeSpawn({ code = 0, stderr = '', hang = false } = {}) {
  return () => {
    const listeners = {};
    const child = {
      stdout: { on() {} },
      stderr: { on(ev, cb) { if (ev === 'data' && stderr) cb(Buffer.from(stderr)); } },
      on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
      kill() { (listeners.exit || []).forEach((cb) => cb(137, 'SIGKILL')); },
    };
    if (!hang) { setImmediate(() => (listeners.exit || []).forEach((cb) => cb(code, null))); }
    return child;
  };
}

test('completed (exit 0) → ok:true, authRejected:false, timedOut:false', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ code: 0 }), timeoutMs: 1000 });
  assert.deepEqual(r, { ok: true, authRejected: false, timedOut: false });
});

test('definitive auth rejection (401/credential stderr) → authRejected:true, ok:false', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ code: 1, stderr: 'API Error: 401 Invalid authentication credentials' }), timeoutMs: 1000 });
  assert.equal(r.authRejected, true);
  assert.equal(r.ok, false);
});

test('non-auth non-zero exit → ok:false, authRejected:false (transient class)', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ code: 1, stderr: 'network unreachable' }), timeoutMs: 1000 });
  assert.deepEqual(r, { ok: false, authRejected: false, timedOut: false });
});

test('timeout → timedOut:true, ok:false', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
});

test('spawn throws → ok:false, authRejected:false (did-not-run)', async () => {
  const r = await defaultRefreshOnce({ spawnImpl: () => { throw new Error('ENOENT'); }, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: false, authRejected: false, timedOut: false });
});
