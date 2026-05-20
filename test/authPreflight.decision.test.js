import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeAuthPreflight } from '../src/runtime/authPreflight/index.js';
import { TOKEN_STATUS } from '../src/providers/providerAuth.js';

const FRESH = { tokenStatus: TOKEN_STATUS.FRESH };
const STALE = { tokenStatus: TOKEN_STATUS.STALE_REFRESHABLE, reason: 'stale' };
const DEAD = { tokenStatus: TOKEN_STATUS.UNRECOVERABLE, reason: 'no refresh' };
const T0 = 1_000_000;
function mk(overrides) {
  const calls = { refreshOnce: 0 };
  const base = {
    now: () => T0,
    relaunchState: new Map(),
    credsPath: '/creds',
    readCredsStatus: () => FRESH,
    refreshOnce: async () => { calls.refreshOnce += 1; return { ok: true, authRejected: false, timedOut: false }; },
    ...overrides,
  };
  return { base, calls };
}

test('fresh → proceed, refreshOnce NOT called', async () => {
  const { base, calls } = mk({ readCredsStatus: () => FRESH });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
  assert.equal(calls.refreshOnce, 0);
});

test('unrecoverable → block, refreshOnce NOT called', async () => {
  const { base, calls } = mk({ readCredsStatus: () => DEAD });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
  assert.equal(calls.refreshOnce, 0);
  assert.match(r.reason, /re-login|\/login/i);
});

test('stale → refresh → re-read fresh → proceed', async () => {
  let n = 0;
  const { base } = mk({ readCredsStatus: () => (n++ === 0 ? STALE : FRESH) });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
});

test('stale → refresh authRejected → block', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE,
    refreshOnce: async () => ({ ok: false, authRejected: true, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
});

test('stale → refresh, re-read unrecoverable → block', async () => {
  let n = 0;
  const { base } = mk({
    readCredsStatus: () => (n++ === 0 ? STALE : DEAD),
    refreshOnce: async () => ({ ok: true, authRejected: false, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
});

test('FINDING #1: refresh turn COMPLETED (ok:true) but still stale → BLOCK', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE,
    refreshOnce: async () => ({ ok: true, authRejected: false, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /re-login|\/login/i);
});

test('refresh did NOT complete (ok:false) and still stale → proceed+warn', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE,
    refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: false }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
  assert.equal(r.warn, true);
  assert.equal(r.tokenStatus, TOKEN_STATUS.STALE_REFRESHABLE);
});

test('timeout (timedOut:true ⇒ ok:false) and still stale → proceed+warn', async () => {
  const { base } = mk({
    readCredsStatus: () => STALE,
    refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: true }),
  });
  const r = await claudeAuthPreflight(base);
  assert.equal(r.decision, 'proceed');
  assert.equal(r.warn, true);
});

test('relaunch guard: prior proceed+warn for this credsPath within window → block, NO refreshOnce', async () => {
  const relaunchState = new Map();
  const { base, calls } = mk({ readCredsStatus: () => STALE, relaunchState, refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: false }) });
  const r1 = await claudeAuthPreflight(base);
  assert.equal(r1.decision, 'proceed');
  const before = calls.refreshOnce;
  const r2 = await claudeAuthPreflight({ ...base, now: () => T0 + 30_000 });
  assert.equal(r2.decision, 'block');
  assert.equal(calls.refreshOnce, before, 'guard short-circuits before calling refreshOnce');
});

test('relaunch guard expires: prior proceed+warn but now beyond window → not short-circuited', async () => {
  const relaunchState = new Map();
  const { base } = mk({ readCredsStatus: () => STALE, relaunchState, refreshOnce: async () => ({ ok: false, authRejected: false, timedOut: false }) });
  await claudeAuthPreflight(base);
  const r2 = await claudeAuthPreflight({ ...base, now: () => T0 + 120_000 });
  assert.equal(r2.decision, 'proceed');
});
