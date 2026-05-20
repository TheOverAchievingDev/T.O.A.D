// One isolated `claude --model haiku --print` turn whose ONLY purpose
// is to force the Claude CLI's own silent token refresh + rewrite of
// ~/.claude/.credentials.json. TOAD never parses a token or calls the
// OAuth endpoint. `ok` ≜ a turn COMPLETED (an exit was observed, not a
// timeout-kill) so the CLI had the opportunity to refresh.
//
// CLAUDE_ISOLATION_FLAGS is lifted VERBATIM from
// src/drift/llm/llmJudge.js (which does not export it). Keep it
// byte-identical to that source of truth.
// TODO(shared-helper): extract a single shared CLAUDE_ISOLATION_FLAGS
// (and a Windows-safe claude spawn helper) so refreshOnce + llmJudge
// stop duplicating it.
import { spawn as nodeSpawn } from 'node:child_process';

const CLAUDE_ISOLATION_FLAGS = Object.freeze([
  '--setting-sources', 'project,local',
  '--tools', 'Read',
  '--dangerously-skip-permissions',
]);

const REFRESH_PROMPT = 'ok'; // minimal one-token turn; output discarded
const DEFAULT_TIMEOUT_MS = 30_000;

// Definitive auth/credential rejection ONLY. Run-and-tighten against
// the real expired-token `claude --print` surface (spec §7); start
// strict — NEVER loosen so a transient error is mis-tagged authRejected.
const AUTH_REJECT_RE = /\b401\b|invalid authentication credentials|unauthorized|\/login\b/i;

export function defaultRefreshOnce({
  spawnImpl = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  command = 'claude',
} = {}) {
  return new Promise((resolve) => {
    let child;
    let stderrBuf = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      done({ ok: false, authRejected: false, timedOut: true });
      try { if (child) child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    try {
      child = spawnImpl(command, ['--model', 'haiku', '--print', ...CLAUDE_ISOLATION_FLAGS, REFRESH_PROMPT], { windowsHide: true });
    } catch {
      done({ ok: false, authRejected: false, timedOut: false }); // did-not-run
      return;
    }
    if (child && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (d) => { stderrBuf += String(d); });
    }
    if (child && typeof child.on === 'function') {
      child.on('error', () => done({ ok: false, authRejected: false, timedOut: false }));
      child.on('exit', (code) => {
        if (code === 0) { done({ ok: true, authRejected: false, timedOut: false }); return; }
        const authRejected = AUTH_REJECT_RE.test(stderrBuf);
        done({ ok: false, authRejected, timedOut: false });
      });
    }
  });
}
