import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCompact, REASONS } from '../src/runtime/compactionTrigger/shouldCompact.js';

const NOW = 1_000_000;
const COOLDOWN = 120_000;
// A fresh, un-armed runtime state.
const idle = () => ({ gateArmed: false, lastFireAt: 0, retriesRemaining: 0, cooldownMs: COOLDOWN });
// An armed state that fired `firedAgo` ms ago with `retries` budget left.
const armed = (firedAgo, retries) => ({ gateArmed: true, lastFireAt: NOW - firedAgo, retriesRemaining: retries, cooldownMs: COOLDOWN });

test('#1 stale signal → no fire (honest-degradation)', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: true, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.SIGNAL_UNTRUSTWORTHY });
});

test('#1 source:unknown (covers non-Claude via B degraded contract) → no fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'unknown' }, threshold: 0.7, state: idle(), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.SIGNAL_UNTRUSTWORTHY });
});

test('#2 missing/non-finite percentage → no fire (strict, no coercion)', () => {
  for (const p of [null, undefined, NaN, '0.9']) {
    const r = shouldCompact({ usage: { percentage: p, stale: false, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
    assert.deepEqual(r, { trigger: false, reason: REASONS.NO_SIGNAL }, `percentage=${String(p)}`);
  }
});

test('#3 gated and within cooldown → no fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'claude' }, threshold: 0.7, state: armed(10_000, 2), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.GATED_IN_FLIGHT });
});

test('#4 gated, cooldown elapsed, retries remaining → retry fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'claude' }, threshold: 0.7, state: armed(COOLDOWN + 1, 2), now: NOW });
  assert.deepEqual(r, { trigger: true, reason: REASONS.RETRY });
});

test('#5 gated, cooldown elapsed, retries exhausted → give-up (surfaced)', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'claude' }, threshold: 0.7, state: armed(COOLDOWN + 1, 0), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.GIVING_UP_SURFACED });
});

test('#6 not gated, at/over threshold → threshold-crossed fire', () => {
  assert.deepEqual(
    shouldCompact({ usage: { percentage: 0.70, stale: false, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW }),
    { trigger: true, reason: REASONS.THRESHOLD_CROSSED },
  );
  assert.deepEqual(
    shouldCompact({ usage: { percentage: 0.85, stale: false, source: 'anthropic' }, threshold: 0.7, state: idle(), now: NOW }),
    { trigger: true, reason: REASONS.THRESHOLD_CROSSED },
  );
});

test('#7 not gated, below threshold → no fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.69, stale: false, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.BELOW_THRESHOLD });
});

test('branch order: stale wins over an otherwise-fireable threshold cross', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: true, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
  assert.equal(r.reason, REASONS.SIGNAL_UNTRUSTWORTHY);
});
