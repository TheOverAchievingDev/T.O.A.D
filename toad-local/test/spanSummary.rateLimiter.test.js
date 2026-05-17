import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';

test('allows up to maxPerHour within the rolling hour, then blocks', () => {
  let t = 1_000_000;
  const rl = new SummaryRateLimiter({ maxPerHour: 3, now: () => t });
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-a'), false); // 4th in the window
});

test('a blocked (false) attempt does NOT consume a slot — eviction frees it', () => {
  let t = 0;
  const rl = new SummaryRateLimiter({ maxPerHour: 1, now: () => t });
  assert.equal(rl.tryAcquire('team-a'), true);   // t=0 recorded
  t = 1000;
  assert.equal(rl.tryAcquire('team-a'), false);  // within hour, blocked, NOT recorded
  t = 3_600_001;                                  // first slot now older than 1h
  assert.equal(rl.tryAcquire('team-a'), true);    // evicted → free again (proves false didn't record)
});

test('per-team isolation', () => {
  let t = 0;
  const rl = new SummaryRateLimiter({ maxPerHour: 1, now: () => t });
  assert.equal(rl.tryAcquire('team-a'), true);
  assert.equal(rl.tryAcquire('team-b'), true);   // separate window
  assert.equal(rl.tryAcquire('team-a'), false);
});

test('defaults: maxPerHour=20, now=Date.now (smoke)', () => {
  const rl = new SummaryRateLimiter();
  for (let i = 0; i < 20; i++) assert.equal(rl.tryAcquire('t'), true);
  assert.equal(rl.tryAcquire('t'), false);
});
