import { runEasCli as defaultRunner } from './easCli.js';

/**
 * Get EAS project info. Returns { projectId, owner, name, ... }.
 */
export async function easProjectInfo({ cwd, runEasCli } = {}) {
  const runner = runEasCli || defaultRunner;
  const result = await runner({ args: ['project:info', '--json'], cwd });
  if (result.exitCode !== 0) {
    throw new Error(`eas project:info failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`eas project:info returned non-JSON: ${result.stdout.slice(0, 200)}`);
  }
}

/**
 * Trigger an EAS build. Returns the created job record immediately.
 * The build runs in the background.
 */
export async function easBuild({
  teamId,
  platform, // 'android' | 'ios' | 'all'
  profile = 'production',
  cwd,
  runEasCli,
  pluginJobs,
} = {}) {
  if (!teamId) throw new TypeError('easBuild: teamId required');
  if (!platform) throw new TypeError('easBuild: platform required');
  if (!pluginJobs) throw new TypeError('easBuild: pluginJobs required');

  const runner = runEasCli || defaultRunner;
  const job = pluginJobs.create({
    teamId,
    pluginId: 'eas',
    action: 'build',
    args: { platform, profile },
  });

  // Background execution
  pluginJobs.executeJob({
    jobId: job.jobId,
    runner: (onLog) => runner({
      args: ['build', '--platform', platform, '--profile', profile, '--json', '--non-interactive'],
      cwd,
      onLog,
      timeoutMs: 1_800_000, // 30 mins for builds
    }),
  }).catch(() => {
    // Error is already handled/logged by executeJob to the DB.
  });

  return job;
}

/**
 * Trigger an EAS update (OTA). Returns the created job record immediately.
 * The update runs in the background.
 */
export async function easUpdate({
  teamId,
  branch,
  message,
  cwd,
  runEasCli,
  pluginJobs,
} = {}) {
  if (!teamId) throw new TypeError('easUpdate: teamId required');
  if (!branch) throw new TypeError('easUpdate: branch required');
  if (!message) throw new TypeError('easUpdate: message required');
  if (!pluginJobs) throw new TypeError('easUpdate: pluginJobs required');

  const runner = runEasCli || defaultRunner;
  const job = pluginJobs.create({
    teamId,
    pluginId: 'eas',
    action: 'update',
    args: { branch, message },
  });

  // Background execution
  pluginJobs.executeJob({
    jobId: job.jobId,
    runner: (onLog) => runner({
      args: ['update', '--branch', branch, '--message', message, '--json', '--non-interactive'],
      cwd,
      onLog,
      timeoutMs: 600_000, // 10 mins for updates
    }),
  }).catch(() => {
    // Error handled by executeJob
  });

  return job;
}
