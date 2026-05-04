import { spawn as defaultSpawn } from 'node:child_process';

const ALLOWED_CATEGORIES = new Set([
  'architecture', 'checklist', 'slice_scope', 'test_truth', 'risk',
]);
const ALLOWED_SEVERITIES = new Set([
  'info', 'low', 'medium', 'high', 'critical',
]);
const REQUIRED_STRING_FIELDS = ['title', 'expected', 'actual', 'recommendedCorrection'];

/**
 * Build the argv each provider's CLI expects for a one-shot prompt run.
 *
 *   claude  --model <model> --print "<combined>"
 *   codex   exec --model <model> "<combined>"
 *   gemini  -m <model> -p "<combined>"
 *
 * The "combined" string is "<system>\n\n<user>" — most CLIs don't expose
 * a separate system-prompt flag in one-shot mode, so we paste the
 * system prompt as the first paragraph of the user prompt. The model
 * still treats the leading instructions as governing.
 */
function argsFor(cli, model, combined) {
  if (cli === 'claude') return ['--model', model, '--print', combined];
  if (cli === 'codex') return ['exec', '--model', model, combined];
  if (cli === 'gemini') return ['-m', model, '-p', combined];
  throw new TypeError(`llmJudge: unsupported cli "${cli}"`);
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
 * response. Engine catches and emits a meta-finding describing the
 * failure (so the run continues).
 */
export async function llmJudge({
  cli,
  model,
  systemPrompt,
  userPayload,
  timeoutMs = 30_000,
  spawnImpl,
} = {}) {
  if (typeof cli !== 'string' || cli.length === 0) {
    throw new TypeError('llmJudge: cli is required');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('llmJudge: model is required');
  }

  const spawnFn = spawnImpl || defaultSpawn;
  const combined = `${systemPrompt}\n\n${userPayload}`;
  const args = argsFor(cli, model, combined);

  const result = await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`llmJudge: spawn_failed: ${err && err.message ? err.message : err}`));
      return;
    }

    let stdoutBuf = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`llmJudge: timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
    }
    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`llmJudge: spawn_failed: exit code ${code}`));
        return;
      }
      resolve(stdoutBuf);
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`llmJudge: spawn_failed: ${err.message}`));
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
