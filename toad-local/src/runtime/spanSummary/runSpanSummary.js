// The ONLY IO seam (Readability Layer-2 P3b-1). A one-shot provider-CLI
// spawn that MIRRORS drift's llmJudge spawn discipline
// (src/drift/llm/llmJudge.js, inline mode) for PLAIN-TEXT output.
// It does NOT import llmJudge (drift byte-untouched) and NEVER throws —
// every failure mode returns { ok:false, reason } where reason is a
// member of the sealed SUMMARY_FAIL_REASONS.
import { spawn as defaultSpawn } from 'node:child_process';
import { resolveCli as defaultResolveCli } from '../../foundry/providers/resolveCli.js';
import { extractSummaryText } from './extractSummaryText.js';

export const SUMMARY_FAIL_REASONS = Object.freeze(
  new Set(['spawn_failed', 'timeout', 'empty_output', 'cli_unresolved'])
);

function defaultNeedsShell(resolved) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
}

function buildInvocation(cli, model, systemPrompt, userPayload) {
  const combined = `${systemPrompt}\n\n${userPayload}`;
  if (cli === 'claude') {
    return {
      args: ['--model', model, '--print', '--setting-sources', 'project,local', '--tools', ''],
      stdin: combined,
    };
  }
  if (cli === 'codex') {
    return { args: ['exec', '--model', model, '-'], stdin: combined };
  }
  if (cli === 'gemini') {
    return { args: ['-m', model, '-p', combined], stdin: null };
  }
  return null;
}

export async function runSpanSummary({
  systemPrompt,
  userPayload,
  cli,
  model,
  cwd = null,
  isolateHome = false,
  timeoutMs = 30_000,
  spawnImpl,
  resolveCliImpl,
  needsShellImpl,
} = {}) {
  if (typeof cli !== 'string' || cli.length === 0) return { ok: false, reason: 'cli_unresolved' };
  if (typeof model !== 'string' || model.length === 0) return { ok: false, reason: 'cli_unresolved' };

  const inv = buildInvocation(cli, model, String(systemPrompt ?? ''), String(userPayload ?? ''));
  if (!inv) return { ok: false, reason: 'cli_unresolved' };

  const spawnFn = spawnImpl || defaultSpawn;
  const resolveCliFn = resolveCliImpl || defaultResolveCli;
  const needsShellFn = needsShellImpl || defaultNeedsShell;

  let resolved;
  try {
    resolved = resolveCliFn(cli);
  } catch {
    return { ok: false, reason: 'cli_unresolved' };
  }
  if (typeof resolved !== 'string' || resolved.length === 0) {
    return { ok: false, reason: 'cli_unresolved' };
  }
  let shell;
  try {
    shell = needsShellFn(resolved);
  } catch {
    shell = false;
  }

  const { args, stdin: stdinPayload } = inv;

  return await new Promise((resolveOuter) => {
    const stdio = stdinPayload !== null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const spawnOpts = { stdio, shell };
    if (typeof cwd === 'string' && cwd.length > 0) {
      spawnOpts.cwd = cwd;
    }
    if (isolateHome && typeof cwd === 'string' && cwd.length > 0) {
      const env = { ...process.env };
      env.HOME = cwd;
      env.USERPROFILE = cwd;
      for (const key of Object.keys(env)) {
        if (
          key.startsWith('CLAUDE_') &&
          key !== 'CLAUDE_CODE_USE_BEDROCK' &&
          key !== 'CLAUDE_CODE_USE_VERTEX'
        ) {
          delete env[key];
        }
      }
      spawnOpts.env = env;
    }

    let settled = false;
    const done = (r) => { if (settled) return; settled = true; resolveOuter(r); };

    let proc;
    try {
      proc = spawnFn(resolved, args, spawnOpts);
    } catch {
      done({ ok: false, reason: 'spawn_failed' });
      return;
    }

    if (stdinPayload !== null && proc.stdin) {
      try {
        proc.stdin.write(stdinPayload);
        proc.stdin.end();
      } catch {
        /* the exit/error handler below surfaces the real failure */
      }
    }

    let stdoutBuf = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      done({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    if (proc.stdout) proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) { done({ ok: false, reason: 'spawn_failed' }); return; }
      const t = extractSummaryText(stdoutBuf);
      done(typeof t === 'string' && t.length > 0
        ? { ok: true, summaryText: t }
        : { ok: false, reason: 'empty_output' });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      done({ ok: false, reason: 'spawn_failed' });
    });
  });
}
