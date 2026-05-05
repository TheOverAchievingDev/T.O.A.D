import { runRailwayCli as defaultRunner } from './railwayCli.js';

/**
 * Link a team's worktree to a Railway project. If projectId is supplied,
 * link to that existing project. Otherwise create a new one.
 *
 * Returns { linked: true, projectId } on success. Throws on CLI failure.
 *
 * Idempotency note: the railway CLI itself handles "already linked"
 * gracefully (re-linking is a no-op), so we don't track link state
 * in plugin_resources — only provisioned databases / services land
 * in that table.
 */
export async function railwayLink({ teamId, projectId, cwd, runRailwayCli } = {}) {
  if (!teamId) throw new TypeError('railwayLink: teamId required');
  const runner = runRailwayCli || defaultRunner;
  const args = projectId
    ? ['link', '--project-id', projectId, '--yes']
    : ['link', '--yes'];
  const result = await runner({ args, cwd });
  if (result.exitCode !== 0) {
    throw new Error(`railway link failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return {
    linked: true,
    projectId: projectId ?? null,
    teamId,
  };
}
