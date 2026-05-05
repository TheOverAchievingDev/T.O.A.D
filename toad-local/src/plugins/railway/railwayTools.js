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

/**
 * Pull a single environment variable's value (default DATABASE_URL)
 * for a Railway service. Returns the plaintext value — agents see it
 * directly. The audit log + UI raw-event view get the value passed
 * through redactSecrets so the password never lands in SQLite.
 *
 * Slice 1 path-a: plaintext exposure is intentional but loud. Slice 2
 * adds the substitution pipeline (path-b) so even agents see opaque
 * references like {$secret: 'railway.svc_x.DATABASE_URL'}.
 */
export async function railwayGetConnectionString({
  teamId,
  resourceId,
  varName = 'DATABASE_URL',
  runRailwayCli,
} = {}) {
  if (!teamId) throw new TypeError('railwayGetConnectionString: teamId required');
  if (!resourceId) throw new TypeError('railwayGetConnectionString: resourceId required');

  const runner = runRailwayCli || (await import('./railwayCli.js')).runRailwayCli;

  // `railway variables get <NAME> --service <id>` prints the raw value.
  const result = await runner({
    args: ['variables', 'get', varName, '--service', resourceId],
  });
  if (result.exitCode !== 0) {
    throw new Error(`railway variables get failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }

  return {
    teamId,
    resourceId,
    varName,
    value: result.stdout.trim(),
  };
}

/**
 * Run a SQL migration against a Railway-provisioned database. The SQL
 * is piped via stdin to `railway run psql --service <id>`. Risk profile:
 * "high" — role-gated to lead/human only. Per-tool-call approval modal
 * is a slice-1.5 follow-up.
 *
 * Throws on empty SQL or CLI failure.
 */
export async function railwayRunMigration({
  teamId,
  resourceId,
  sql,
  runRailwayCli,
} = {}) {
  if (!teamId) throw new TypeError('railwayRunMigration: teamId required');
  if (!resourceId) throw new TypeError('railwayRunMigration: resourceId required');
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new TypeError('railwayRunMigration: sql required (non-empty)');
  }

  const runner = runRailwayCli || (await import('./railwayCli.js')).runRailwayCli;

  const result = await runner({
    args: ['run', '--service', resourceId, 'psql'],
    stdin: sql,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`railway migration failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return {
    teamId,
    resourceId,
    executed: true,
    output: result.stdout.trim(),
  };
}
