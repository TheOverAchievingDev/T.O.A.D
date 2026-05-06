import { runVercelCli as defaultRunner } from './vercelCli.js';

/**
 * Sync local development with Vercel (vercel link --yes).
 */
export async function vercelLink({ cwd, runVercelCli } = {}) {
  const runner = runVercelCli || defaultRunner;
  const result = await runner({ args: ['link', '--yes'], cwd });
  if (result.exitCode !== 0) {
    throw new Error(`vercel link failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { executed: true, output: result.stdout.trim() };
}

/**
 * Pull environment variables from Vercel (vercel env pull .env.local --yes).
 */
export async function vercelEnvPull({ cwd, runVercelCli } = {}) {
  const runner = runVercelCli || defaultRunner;
  const result = await runner({ args: ['env', 'pull', '.env.local', '--yes'], cwd });
  if (result.exitCode !== 0) {
    throw new Error(`vercel env pull failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { executed: true, output: result.stdout.trim() };
}

/**
 * Trigger a Vercel deployment. Returns the created job record immediately.
 * The deployment runs in the background.
 */
export async function vercelDeploy({
  teamId,
  prod = false,
  cwd,
  runVercelCli,
  pluginJobs,
} = {}) {
  if (!teamId) throw new TypeError('vercelDeploy: teamId required');
  if (!pluginJobs) throw new TypeError('vercelDeploy: pluginJobs required');

  const runner = runVercelCli || defaultRunner;
  const args = ['deploy'];
  if (prod) args.push('--prod');
  args.push('--format', 'json');

  const job = pluginJobs.create({
    teamId,
    pluginId: 'vercel',
    action: 'deploy',
    args: { prod },
  });

  // Background execution
  pluginJobs.executeJob({
    jobId: job.jobId,
    runner: (onLog) => runner({
      args,
      cwd,
      onLog,
      timeoutMs: 900_000, // 15 mins for deploys
    }),
  }).catch(() => {
    // Error logged to DB
  });

  return job;
}

/**
 * List Vercel deployments.
 */
export async function vercelList({ cwd, runVercelCli } = {}) {
  const runner = runVercelCli || defaultRunner;
  const result = await runner({ args: ['ls', '--format', 'json'], cwd });
  if (result.exitCode !== 0) {
    throw new Error(`vercel ls failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`vercel ls returned non-JSON: ${result.stdout.slice(0, 200)}`);
  }
}
