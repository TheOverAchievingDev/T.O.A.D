import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a bare CLI name to an absolute path on Windows.
 */
export function resolveCommandPath(command) {
  if (process.platform !== 'win32') return command;
  if (typeof command !== 'string' || command.length === 0) return command;
  if (command.includes('\\') || command.includes('/')) return command;
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
  const pathext = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.toLowerCase());
  for (const dir of dirs) {
    const cleanDir = dir.replace(/^"|"$/g, '');
    for (const ext of pathext) {
      const candidate = path.join(cleanDir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Run the vercel CLI with given args and return { stdout, stderr, exitCode }.
 * Supports log streaming via onLog callback for background jobs.
 */
export async function runVercelCli({
  args,
  cwd = process.cwd(),
  timeoutMs = 600_000,
  stdin = null,
  spawnImpl,
  onLog,
} = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('runVercelCli: args must be an array');
  }
  const spawnFn = spawnImpl || defaultSpawn;
  const cliPath = resolveCommandPath('vercel');
  const stdioConfig = stdin
    ? ['pipe', 'pipe', 'pipe']
    : ['ignore', 'pipe', 'pipe'];

  return await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(cliPath, args, { cwd, stdio: stdioConfig, env: { ...process.env, CI: '1' } });
    } catch (err) {
      reject(new Error(`vercel spawn failed: ${err && err.message ? err.message : err}`));
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`vercel timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on('data', (c) => {
        const chunk = c.toString();
        stdoutBuf += chunk;
        if (onLog) onLog(chunk);
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (c) => {
        const chunk = c.toString();
        stderrBuf += chunk;
        if (onLog) onLog(chunk);
      });
    }

    if (stdin && proc.stdin) {
      proc.stdin.on('error', () => { /* ignore */ });
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code });
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`vercel spawn error: ${err.message}`));
    });
  });
}
