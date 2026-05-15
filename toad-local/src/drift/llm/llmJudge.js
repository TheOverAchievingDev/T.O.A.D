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
 * Two transport modes:
 *
 * 1. Inline (small prompts): the system prompt + user payload are
 *    combined and sent via stdin. Works fine for prompts up to ~20KB
 *    on the local Claude CLI, fails with "Prompt is too long" beyond
 *    that.
 *
 * 2. File (large prompts, briefPath set): we wrote the user payload
 *    to a markdown file on disk; the spawn stdin only carries a SHORT
 *    instruction telling the CLI to read that file via its Read tool.
 *    Total stdin = system prompt + ~200 byte read instruction (~2KB
 *    typical), well under any CLI limit. The model still consumes the
 *    file's tokens via Read but transport is unbounded.
 *
 * The file mode requires Read tool access:
 *   - Claude: add --dangerously-skip-permissions so Read auto-fires
 *     in --print mode (otherwise it'd block waiting for permission).
 *   - Codex: TUI permissions default permissive in exec mode.
 *   - Gemini: positional prompt mode + Read tool is enabled by default.
 *
 *   claude  --model <m> --print           [inline] / + --dangerously-skip-permissions [file]
 *   codex   exec --model <m> -            [inline + file both via stdin]
 *   gemini  -m <m> -p "<combined>"        [inline] / -p "<short>"     [file]
 *
 * Why stdin for claude/codex: a real drift prompt is system + tasks +
 * events + foundry/code-context. That easily hits 10–20KB on a live
 * project, blowing past Windows cmd.exe's ~8KB command-line cap when
 * passed positionally. stdin transport sidesteps that AND the shell:true
 * argv re-splitting hazard on .cmd wrappers (cmd.exe re-parses the args
 * string by whitespace, mangling multi-word prompts).
 */
/**
 * Flags that isolate a claude --print invocation from the operator's
 * local Claude Code environment. Reasoning (2026-05-15 prompt-cap
 * investigation):
 *
 * The operator's ~/.claude/settings.json typically enables many
 * plugins (we measured 21 on the bug-reporting user: feature-dev,
 * superpowers, vercel, figma, chrome-devtools-mcp, etc.). Each
 * plugin loads tool descriptions, skill definitions, and agent
 * prompts into every claude session's context. With effort=high
 * + alwaysThinking on top, the request can hit 50K+ overhead
 * tokens BEFORE Symphony's brief is added. Result: "Prompt is too
 * long" failures regardless of how tightly we cap our brief.
 *
 * `--setting-sources project,local` tells claude to skip the user
 * settings file (where the plugins live). Project/local sources
 * are empty because the judge runs in a tempdir cwd. Auth flows
 * through ~/.claude/.credentials.json which is unaffected by
 * setting-sources, so OAuth users keep working.
 *
 * `--tools "Read"` strips every tool except Read from the request.
 * The judge only needs Read to load the brief; Edit/Write/Bash/
 * Grep/Glob/NotebookEdit are dead weight that inflate the prompt.
 *
 * `--dangerously-skip-permissions` lets Read fire without an
 * interactive prompt in --print mode. The tempdir cwd bounds the
 * blast radius to the brief file itself.
 */
const CLAUDE_ISOLATION_FLAGS = Object.freeze([
  '--setting-sources', 'project,local',
  '--tools', 'Read',
  '--dangerously-skip-permissions',
]);

/**
 * For the inline transport path (brief-file write failed; fall back
 * to stdin). No Read tool is needed — the brief is already in stdin —
 * so we strip ALL tools. Skipping permissions becomes moot when no
 * tools are available, but we keep --setting-sources to stay
 * isolated from plugin overhead.
 */
const CLAUDE_INLINE_ISOLATION_FLAGS = Object.freeze([
  '--setting-sources', 'project,local',
  '--tools', '',
]);

function buildInvocation(cli, model, systemPrompt, userPayload, briefPath) {
  // When briefPath is set, we instruct the CLI to read the file via
  // its Read tool instead of inlining the payload. The stdin stays
  // tiny so even multi-MB briefs don't trip CLI prompt-length limits.
  if (briefPath) {
    const shortInstruction = [
      systemPrompt,
      '',
      `The full team-state brief is in this file: ${briefPath}`,
      '',
      'Read it with your Read tool, then output ONLY the JSON per the schema above.',
      'No prose. No markdown fences. The brief contains tasks, recent events, and the baseline docs you need to compare against.',
    ].join('\n');
    if (cli === 'claude') {
      return {
        args: ['--model', model, '--print', ...CLAUDE_ISOLATION_FLAGS],
        stdin: shortInstruction,
      };
    }
    if (cli === 'codex') {
      return { args: ['exec', '--model', model, '-'], stdin: shortInstruction };
    }
    if (cli === 'gemini') {
      return { args: ['-m', model, '-p', shortInstruction], stdin: null };
    }
    throw new TypeError(`llmJudge: unsupported cli "${cli}"`);
  }
  // Inline transport — original behavior, retained for small payloads
  // and as a backstop when the brief-file path can't be written.
  const combined = `${systemPrompt}\n\n${userPayload}`;
  if (cli === 'claude') {
    return {
      args: ['--model', model, '--print', ...CLAUDE_INLINE_ISOLATION_FLAGS],
      stdin: combined,
    };
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
  /**
   * Optional absolute path to a markdown file containing the team-state
   * brief. When set, the CLI is instructed to read this file via its
   * Read tool instead of receiving the payload on stdin. Removes any
   * prompt-length limit (was tripping at ~20KB with "Prompt is too
   * long" on real projects). Caller is responsible for writing the
   * file before the call and cleaning it up after.
   */
  briefPath = null,
  /**
   * Optional cwd for the CLI process. When briefPath is in use this
   * should usually be the directory containing the brief — bounds the
   * agent's blast radius if --dangerously-skip-permissions is set.
   */
  cwd = null,
  /**
   * When true AND cwd is set, the spawn's env is overridden so HOME
   * (and USERPROFILE on Windows) points at cwd. The caller is
   * responsible for having pre-populated cwd/.claude/.credentials.json
   * so claude can still authenticate. This isolates the judge from
   * the operator's `~/.claude/agents/` (auto-discovered agent prompts,
   * which on rich setups total 100+ KB and blow the prompt cap before
   * the brief is even read) and `~/.claude/CONSTITUTION.md`. Without
   * this flag the spawn inherits the real HOME and claude finds every
   * operator-installed agent/skill/plugin.
   */
  isolateHome = false,
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

  const { args, stdin: stdinPayload } = buildInvocation(cli, model, systemPrompt, userPayload, briefPath);

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

    const spawnOpts = { stdio, shell };
    if (typeof cwd === 'string' && cwd.length > 0) {
      // Bounds the agent's filesystem reach when running with
      // --dangerously-skip-permissions in file-input mode. Without
      // cwd, the spawn inherits the sidecar's working directory.
      spawnOpts.cwd = cwd;
    }
    if (isolateHome && typeof cwd === 'string' && cwd.length > 0) {
      // Override HOME (and USERPROFILE on Windows — claude reads
      // both depending on the code path) so the judge sees only the
      // .claude/.credentials.json we pre-populated. No agents, no
      // CONSTITUTION.md, no plugin caches. Drop CLAUDE_CODE_* env
      // vars too — those bypass settings.json and can re-introduce
      // the same overhead (e.g. CLAUDE_EFFORT=xhigh inflating the
      // thinking budget on every turn).
      const env = { ...process.env };
      env.HOME = cwd;
      env.USERPROFILE = cwd;
      // Strip CLAUDE_* env that could re-import operator preferences.
      // Keep ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — those are
      // auth fallbacks, fine to forward. Same for the BEDROCK /
      // VERTEX flags which select 3P providers.
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
    let proc;
    try {
      proc = spawnFn(resolved, args, spawnOpts);
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
