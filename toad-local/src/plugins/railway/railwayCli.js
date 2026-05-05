import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a bare CLI name to an absolute path on Windows by walking
 * PATH × PATHEXT. Mirrors the helper in claudeUsageProbe.js — Node's
 * spawn doesn't apply PATHEXT for `.cmd` shims by default.
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
 * Run the railway CLI with given args and return { stdout, stderr,
 * exitCode }. Throws on spawn failure or timeout.
 *
 * Tests inject a fake `spawnImpl` to avoid hitting the real CLI.
 */
export async function runRailwayCli({
  args,
  cwd = process.cwd(),
  timeoutMs = 30_000,
  spawnImpl,
} = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('runRailwayCli: args must be an array');
  }
  const spawnFn = spawnImpl || defaultSpawn;
  const cliPath = resolveCommandPath('railway');

  return await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(cliPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`railway spawn failed: ${err && err.message ? err.message : err}`));
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`railway timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    if (proc.stderr) proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });

    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code });
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`railway spawn error: ${err.message}`));
    });
  });
}
