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

const SLICE_1_SUPPORTED_TYPES = new Set(['postgres']);

/**
 * Provision a database in Railway for the given team. Idempotent: if
 * the team already has a live database of the requested type, returns
 * the existing record with wasExisting:true and DOES NOT call the CLI.
 *
 * Slice 1 ships postgres only. Other types (redis, mongodb, mysql)
 * land in slice 1.5 by adding entries to SLICE_1_SUPPORTED_TYPES and
 * the type→CLI-arg mapping.
 *
 * Throws on CLI failure.
 */
export async function railwayProvisionDb({
  teamId,
  type = 'postgres',
  runRailwayCli,
  pluginResources,
} = {}) {
  if (!teamId) throw new TypeError('railwayProvisionDb: teamId required');
  if (!pluginResources) throw new TypeError('railwayProvisionDb: pluginResources required');
  if (!SLICE_1_SUPPORTED_TYPES.has(type)) {
    throw new Error(`railwayProvisionDb: type "${type}" not supported in slice 1 (postgres only)`);
  }

  // Idempotency: short-circuit if a live resource already exists.
  const existing = pluginResources.findLive({
    teamId, pluginId: 'railway', kind: type,
  });
  if (existing) {
    return { ...existing, wasExisting: true };
  }

  const runner = runRailwayCli || (await import('./railwayCli.js')).runRailwayCli;

  // `railway add --plugin postgresql --json` provisions a Postgres and
  // emits a JSON record on stdout. Slice 1 keys on the JSON output.
  const result = await runner({
    args: ['add', '--plugin', 'postgresql', '--json'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`railway add failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`railway add returned non-JSON stdout: ${result.stdout.slice(0, 200)}`);
  }
  const externalId = parsed.id ?? parsed.serviceId ?? parsed.service_id;
  if (!externalId) {
    throw new Error(`railway add returned no service id: ${JSON.stringify(parsed)}`);
  }

  const inserted = pluginResources.insert({
    teamId,
    pluginId: 'railway',
    kind: type,
    externalId,
    metadata: { railway: parsed },
  });
  return { ...inserted, wasExisting: false };
}
