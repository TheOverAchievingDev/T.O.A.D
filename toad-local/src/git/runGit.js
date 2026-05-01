import { spawnSync } from 'node:child_process';

/**
 * Synchronous git command wrapper. Returns `{ exitCode, stdout, stderr }`
 * with stdout/stderr coerced to strings. Exit code is `-1` when the spawn
 * call itself throws (e.g. git binary missing).
 *
 * Tests inject `spawn` to avoid running real git. Production callers leave
 * it out and get `child_process.spawnSync`.
 */
export function runGit(args, { cwd, spawn = defaultSpawn } = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('args must be an array');
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('cwd must be a non-empty string');
  }
  let result;
  try {
    result = spawn('git', args, { cwd, encoding: 'utf8' });
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: err && err.message ? err.message : String(err) };
  }
  if (!result || typeof result !== 'object') {
    return { exitCode: -1, stdout: '', stderr: 'spawn returned no result' };
  }
  const exitCode = typeof result.status === 'number' ? result.status : -1;
  const stdout = stringify(result.stdout);
  const stderr = stringify(result.stderr);
  return { exitCode, stdout, stderr };
}

function defaultSpawn(file, args, opts) {
  return spawnSync(file, args, { ...opts, encoding: 'utf8' });
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value === undefined || value === null) return '';
  return String(value);
}
