import { spawn as defaultSpawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Language-agnostic shared infrastructure for IDE diagnostic tool runners.
 * Provides spawn/timeout/path-target utilities reused by Python, JS/TS, and
 * future language runners.
 */

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function isOutsideRoot(relativePath) {
  return relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Diagnostic sorting
// ---------------------------------------------------------------------------

export function compareDiagnostics(a, b) {
  return a.path.localeCompare(b.path)
    || a.line - b.line
    || a.column - b.column
    || a.source.localeCompare(b.source);
}

// ---------------------------------------------------------------------------
// File target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve and validate a relative file path against a root directory.
 *
 * @param {string} rootPath - Absolute path to the source root.
 * @param {string} relativePath - Caller-supplied relative path.
 * @param {string} commandName - Command name used in error messages.
 * @param {string[]} allowedExtensions - e.g. ['.py'] or ['.ts', '.tsx']
 * @returns {{ absolutePath: string, relativePath: string, commandTarget: string }}
 */
export function resolveDiagnosticFileTarget(rootPath, relativePath, commandName, allowedExtensions) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, absolutePath);
  if (isOutsideRoot(relativeToRoot)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  if (!allowedExtensions.some((ext) => relativeToRoot.toLowerCase().endsWith(ext))) {
    throw new Error(`${commandName}: unsupported file type`);
  }
  let stats;
  let realRootPath;
  let realTargetPath;
  try {
    stats = statSync(absolutePath);
    realRootPath = realpathSync(rootPath);
    realTargetPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`${commandName}: ${error?.message || 'filesystem error'}`);
  }
  const realRelativeToRoot = path.relative(realRootPath, realTargetPath);
  if (isOutsideRoot(realRelativeToRoot)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  if (!stats.isFile()) {
    throw new Error(`${commandName}: not a file`);
  }
  return {
    absolutePath: realTargetPath,
    relativePath: toPosixPath(relativeToRoot),
    commandTarget: toPosixPath(relativeToRoot),
  };
}

// ---------------------------------------------------------------------------
// Tool result summarization
// ---------------------------------------------------------------------------

export function summarizeToolResult(result) {
  return {
    tool: result.tool,
    available: result.available,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    message: result.message,
  };
}

// ---------------------------------------------------------------------------
// Spawn/timeout runner
// ---------------------------------------------------------------------------

/**
 * Run a CLI diagnostic tool as a child process with timeout, capturing
 * stdout/stderr.
 *
 * @param {object} opts
 * @param {string} opts.tool - Display name for error messages / result.
 * @param {string} opts.command - Executable path or name.
 * @param {string[]} opts.args - Argument list.
 * @param {string} opts.cwd - Working directory.
 * @param {number} opts.timeoutMs - Kill timeout in milliseconds.
 * @param {Function} [opts.spawn] - Injected spawn (defaults to node:child_process spawn).
 * @param {Set<number>} opts.findingsExitCodes - Exit codes that mean "ran successfully".
 * @param {(ctx: {stderr: string, exitCode: number|null}) => boolean} [opts.isUnavailable]
 *   Predicate that returns true when the tool is not installed/available.
 *   Default: always returns false (tool is assumed available if it exits).
 * @param {(ctx: {tool:string, available:boolean, ok:boolean, exitCode:number|null,
 *              stdout:string, stderr:string}) => string} [opts.buildMessage]
 *   Build the human-readable result message.
 *   Default: simple generic message.
 * @returns {Promise<object>} Resolved result object.
 */
export async function runTool({
  tool,
  command,
  args,
  cwd,
  timeoutMs,
  spawn = defaultSpawn,
  findingsExitCodes,
  isUnavailable = () => false,
  buildMessage = ({ tool: t, available, ok, exitCode }) =>
    available
      ? (ok ? `${t} ran` : `${t} exited ${exitCode}`)
      : `${t} unavailable`,
}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        tool,
        command,
        args,
        cwd,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill?.('SIGTERM');
      } catch {}
      finish({
        available: true,
        exitCode: null,
        timedOut: true,
        ok: false,
        message: `${tool} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    } catch (error) {
      finish({
        available: false,
        exitCode: null,
        timedOut: false,
        ok: false,
        message: `${tool} unavailable: ${error?.message || 'spawn failed'}`,
      });
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({
        available: false,
        exitCode: null,
        timedOut,
        ok: false,
        message: `${tool} unavailable: ${error?.message || 'spawn failed'}`,
      });
    });
    child.on('close', (exitCode) => {
      const available = !isUnavailable({ stderr, exitCode });
      const ok = available && findingsExitCodes.has(exitCode);
      finish({
        available,
        exitCode,
        timedOut,
        ok,
        message: buildMessage({ tool, available, ok, exitCode, stdout, stderr }),
      });
    });
  });
}
