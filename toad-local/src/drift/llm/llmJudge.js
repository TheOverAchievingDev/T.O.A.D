import { spawn as defaultSpawn } from 'node:child_process';
import { resolveCli as defaultResolveCli } from '../../foundry/providers/resolveCli.js';

const ALLOWED_CATEGORIES = new Set([
  'architecture', 'checklist', 'slice_scope', 'test_truth', 'risk',
]);
const ALLOWED_SEVERITIES = new Set([
  'info', 'low', 'medium', 'high', 'critical',
]);
const REQUIRED_STRING_FIELDS = ['title', 'expected', 'actual', 'recommendedCorrection'];

/**
 * Default shell decision. Node 16+ no longer auto-shells .cmd/.bat on
 * Windows (CVE-2024-27980) — spawn() returns EINVAL on direct invocation
 * of a .cmd wrapper, which is how npm-installed CLIs (claude, codex)
 * typically ship. shell:true is the documented opt-in.
 *
 * For .exe binaries (the typical installer path) this is a passthrough
 * and we avoid the cmd.exe-via-shell argv re-splitting hazard.
 */
function defaultNeedsShell(resolved) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
}

/**
 * Build the (args, stdinPayload) pair each provider's CLI expects for a
 * one-shot prompt run.
 *
 *   claude  --model <m> --print           [prompt via stdin]
 *   codex   exec --model <m> -            [prompt via stdin; '-' sentinel]
 *   gemini  -m <m> -p "<combined>"        [prompt as positional — see note]
 *
 * Why stdin for claude/codex: a real drift prompt is system + tasks +
 * events + foundry/code-context. That easily hits 10–20KB on a live
 * project, blowing past Windows cmd.exe's ~8KB command-line cap when
 * passed positionally. stdin transport sidesteps that AND the shell:true
 * argv re-splitting hazard on .cmd wrappers (cmd.exe re-parses the args
 * string by whitespace, mangling multi-word prompts).
 *
 * Why gemini stays positional: Gemini CLI's stdin support hasn't been
 * empirically verified in this codebase yet. Drift judge defaults to
 * the team's lead provider (claude/codex/gemini), so leaving gemini's
 * existing behavior intact keeps the change low-risk. Long-prompt
 * Windows users on Gemini will still hit ENAMETOOLONG; that gets
 * addressed when Gemini support gets serious attention (see
 * FUTURE-IDEAS Foundry F.2.5 entry).
 */
function buildInvocation(cli, model, combined) {
  if (cli === 'claude') {
    return { args: ['--model', model, '--print'], stdin: combined };
  }
  if (cli === 'codex') {
    return { args: ['exec', '--model', model, '-'], stdin: combined };
  }
  if (cli === 'gemini') {
    return { args: ['-m', model, '-p', combined], stdin: null };
  }
  throw new TypeError(`llmJudge: unsupported cli "${cli}"`);
}

/**
 * Pick the most useful error string from captured stderr + stdout.
 *
 * Most well-behaved CLIs write errors to stderr — that's where we
 * look first. But Claude CLI writes user-facing errors like "model
 * X does not exist" to stdout (along with the exit-1 signal). When
 * stderr is empty AND stdout has content AND the process exited
 * non-zero, that stdout content IS the error and the operator needs
 * to see it. Without this fallback, the drift judge's meta-finding
 * read "judge threw: llmJudge: spawn_failed: exit code 1" — totally
 * undiagnosable for "I picked an invalid model name."
 *
 * Truncated to 500 chars so the error string stays readable when a
 * provider dumps a giant traceback. The full output is still on the
 * sidecar log; this is the breadcrumb that gets surfaced into the
 * drift finding row.
 */
function pickErrorDetail(stderrBuf, stdoutBuf) {
  const stderr = (stderrBuf || '').trim();
  if (stderr.length > 0) return truncateForError(stderr);
  const stdout = (stdoutBuf || '').trim();
  if (stdout.length > 0) return truncateForError(stdout);
  return '';
}

function truncateForError(text) {
  const max = 500;
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

/**
 * Strip leading/trailing markdown code fences. Handles:
 *   ```json\n{...}\n```
 *   ```\n{...}\n```
 *   {...}                         (no fences)
 */
function stripFences(text) {
  const trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const match = trimmed.match(fenceRe);
  return match ? match[1].trim() : trimmed;
}

/**
 * Validate one finding against the expected schema. Returns the
 * normalized finding when valid, null when malformed.
 */
function validateFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!ALLOWED_CATEGORIES.has(raw.category)) return null;
  if (!ALLOWED_SEVERITIES.has(raw.severity)) return null;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) return null;
  }
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.filter((e) => typeof e === 'string')
    : [];
  return {
    category: raw.category,
    severity: raw.severity,
    title: raw.title,
    expected: raw.expected,
    actual: raw.actual,
    evidence,
    recommendedCorrection: raw.recommendedCorrection,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : null,
  };
}

/**
 * Spawn the team's CLI in one-shot mode, send the combined prompt,
 * collect stdout, parse JSON, validate findings, return.
 *
 * Throws on spawn failure, timeout, non-zero exit, or unparseable
 * response. The thrown error includes captured stderr so the engine's
 * judge_failed meta-finding is diagnosable (auth required, model
 * unavailable, rate-limited, etc.) instead of opaque.
 *
 * Engine catches and emits a meta-finding describing the failure (so
 * the run continues).
 */
export async function llmJudge({
  cli,
  model,
  systemPrompt,
  userPayload,
  timeoutMs = 30_000,
  spawnImpl,
  resolveCliImpl,
  needsShellImpl,
} = {}) {
  if (typeof cli !== 'string' || cli.length === 0) {
    throw new TypeError('llmJudge: cli is required');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('llmJudge: model is required');
  }

  const spawnFn = spawnImpl || defaultSpawn;
  const resolveCliFn = resolveCliImpl || defaultResolveCli;
  const needsShellFn = needsShellImpl || defaultNeedsShell;

  const combined = `${systemPrompt}\n\n${userPayload}`;
  const { args, stdin: stdinPayload } = buildInvocation(cli, model, combined);

  // resolveCli walks Windows PATHEXT (.cmd/.exe/.bat) since Node's spawn
  // doesn't honor it; passthrough on Unix and as a fallback when nothing
  // matches (so ENOENT still surfaces normally for "not installed").
  const resolved = resolveCliFn(cli);
  const shell = needsShellFn(resolved);

  const result = await new Promise((resolve, reject) => {
    // stdio: piped stdin only when we'll actually write to it. Avoids
    // leaking an open FD when the provider takes the prompt positionally.
    const stdio = stdinPayload !== null
      ? ['pipe', 'pipe', 'pipe']
      : ['ignore', 'pipe', 'pipe'];

    let proc;
    try {
      proc = spawnFn(resolved, args, { stdio, shell });
    } catch (err) {
      reject(new Error(`llmJudge: spawn_failed: ${err && err.message ? err.message : err}`));
      return;
    }

    if (stdinPayload !== null && proc.stdin) {
      try {
        proc.stdin.write(stdinPayload);
        proc.stdin.end();
      } catch (err) {
        // Defensive — if stdin write fails (process already exited), the
        // exit handler below will surface the real failure with stderr.
        // Swallow here so we don't double-throw.
        // eslint-disable-next-line no-console
        console.warn('llmJudge: stdin write failed (continuing):', err && err.message ? err.message : err);
      }
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`llmJudge: timeout after ${timeoutMs}ms${stderrBuf ? `: ${stderrBuf.trim()}` : ''}`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
    }
    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = pickErrorDetail(stderrBuf, stdoutBuf);
        reject(new Error(
          detail
            ? `llmJudge: spawn_failed: exit code ${code}: ${detail}`
            : `llmJudge: spawn_failed: exit code ${code}`
        ));
        return;
      }
      resolve(stdoutBuf);
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      const detail = pickErrorDetail(stderrBuf, stdoutBuf);
      reject(new Error(
        detail
          ? `llmJudge: spawn_failed: ${err.message}: ${detail}`
          : `llmJudge: spawn_failed: ${err.message}`
      ));
    });
  });

  // Parse the response.
  const cleaned = stripFences(result);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('llmJudge: invalid_response: not valid JSON');
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new Error('llmJudge: invalid_response: missing findings array');
  }

  const findings = [];
  for (const raw of parsed.findings) {
    const validated = validateFinding(raw);
    if (validated) findings.push(validated);
    // Drop malformed silently; engine logs total count after the call.
  }

  return {
    findings,
    rawText: result,
    tokensUsed: null, // CLI providers don't expose token counts on stdout
  };
}
