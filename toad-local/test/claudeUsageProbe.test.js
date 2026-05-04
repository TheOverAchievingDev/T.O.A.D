import test from 'node:test';
import assert from 'node:assert/strict';

import { probeClaudeUsage } from '../src/providers/claudeUsageProbe.js';

/**
 * Build a fake pty that emits a canned panel. The probe waits for a
 * "prompt settle" period and then captures output for several seconds —
 * production values are tuned for the slow sidecar pty render, so for
 * tests we override both knobs to ~50ms to keep the suite fast.
 */
const FAST_TIMINGS = { promptSettleMs: 25, postSlashCaptureMs: 25 };

function fakePty(panelText) {
  return {
    spawn() {
      let dataCb = () => {};
      let exitCb = () => {};
      const proc = {
        onData(cb) { dataCb = cb; },
        onExit(cb) { exitCb = cb; },
        write() { /* noop — the panel is delivered up front */ },
        kill() { exitCb({ exitCode: 0, signal: null }); },
      };
      // Deliver the panel asynchronously so onData has been registered.
      queueMicrotask(() => dataCb(panelText));
      return proc;
    },
  };
}

test('probeClaudeUsage parses claude\'s real /usage panel layout', async () => {
  // Real claude /usage layout (ANSI stripped). Labels are one line, the
  // bar+percent another, the reset line another. This is the live
  // shape captured from the v2.1 CLI on 2026-05-03.
  const panel = [
    'Current session',
    '████████████░░░░░░░░  22% used',
    'Resets 12:50am (America/Denver)',
    '',
    'Current week (all models)',
    '████████████████████████████░░░░  65% used',
    'Resets May 7, 3pm (America/Denver)',
    '',
    'Current week (Sonnet only)',
    '░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  0% used',
  ].join('\n');

  const result = await probeClaudeUsage({ ptyImpl: fakePty(panel), timeoutMs: 12000, ...FAST_TIMINGS });

  assert.ok(result, 'parsed object returned');
  assert.ok(result.session, 'session window parsed');
  assert.equal(result.session.pctUsed, 22);
  assert.match(result.session.resetIn, /12:50am/);
  assert.ok(result.weekly, 'weekly window parsed');
  assert.equal(result.weekly.pctUsed, 65);
  assert.match(result.weekly.resetIn, /May 7/);
});

test('probeClaudeUsage parses an Opus-weekly variant on Max plans', async () => {
  const panel = [
    'Current session',
    '████████░░░░░░░░░░░░  8% used',
    'Resets 3:10pm',
    '',
    'Current week (all models)',
    '██████░░░░░░░░░░░░░░  22% used',
    'Resets May 8, 6pm',
    '',
    'Current week (Opus)',
    '████████████████░░░░  41% used',
    'Resets May 8, 6pm',
  ].join('\n');

  const result = await probeClaudeUsage({ ptyImpl: fakePty(panel), timeoutMs: 12000, ...FAST_TIMINGS });
  assert.ok(result, 'parsed object returned');
  assert.equal(result.session.pctUsed, 8);
  assert.equal(result.weekly.pctUsed, 22);
  assert.ok(result.opusWeekly, 'opus weekly recognized');
  assert.equal(result.opusWeekly.pctUsed, 41);
});

test('probeClaudeUsage returns null when no usage lines parse', async () => {
  // Sometimes claude prints just a banner + login prompt (e.g. when not
  // signed in) — the probe must NOT pretend it has data.
  const panel = 'Claude Code v2.1\nWelcome — sign in to continue\n';
  const result = await probeClaudeUsage({ ptyImpl: fakePty(panel), timeoutMs: 8000, ...FAST_TIMINGS });
  assert.equal(result, null);
});

test('probeClaudeUsage strips ANSI color codes before parsing', async () => {
  const panel = [
    '\x1b[1;36mCurrent session\x1b[0m',
    '\x1b[33m████\x1b[0m  17% used',
    'Resets \x1b[35m2:05am\x1b[0m',
  ].join('\n');
  const result = await probeClaudeUsage({ ptyImpl: fakePty(panel), timeoutMs: 12000, ...FAST_TIMINGS });
  assert.ok(result);
  assert.equal(result.session.pctUsed, 17);
  assert.match(result.session.resetIn, /2:05am/);
});

test('probeClaudeUsage returns null when spawn throws', async () => {
  const broken = { spawn() { throw new Error('claude not found'); } };
  const result = await probeClaudeUsage({ ptyImpl: broken, timeoutMs: 8000, ...FAST_TIMINGS });
  assert.equal(result, null);
});
