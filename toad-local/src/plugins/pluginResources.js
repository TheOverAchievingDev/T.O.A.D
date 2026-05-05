import { randomUUID } from 'node:crypto';
import { openToadDatabase, jsonParseObject } from '../storage/sqlite.js';

/**
 * SQLite-backed provisioned-resource tracker. Used immediately by
 * Railway's idempotency check (findLive is a single index lookup
 * thanks to the partial index in schema.sql) and by the team-delete
 * warning flow.
 */
export class SqlitePluginResources {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  insert({ teamId, pluginId, kind, externalId, metadata, resourceId,
           now = new Date().toISOString() }) {
    const id = resourceId || `res_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO plugin_resources
        (resource_id, team_id, plugin_id, kind, external_id,
         metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, teamId, pluginId, kind, externalId, JSON.stringify(metadata ?? {}), now);
    return this.get({ resourceId: id });
  }

  /** Single live resource per (team, plugin, kind). Used for idempotency. */
  findLive({ teamId, pluginId, kind }) {
    const row = this.db.prepare(
      `SELECT * FROM plugin_resources
       WHERE team_id = ? AND plugin_id = ? AND kind = ?
         AND deprovisioned_at IS NULL
       LIMIT 1`
    ).get(teamId, pluginId, kind);
    return row ? rowToResource(row) : null;
  }

  listForTeam({ teamId, includeDeprovisioned = false } = {}) {
    if (!teamId) return [];
    const where = includeDeprovisioned
      ? 'WHERE team_id = ?'
      : 'WHERE team_id = ? AND deprovisioned_at IS NULL';
    const rows = this.db.prepare(
      `SELECT * FROM plugin_resources ${where}
       ORDER BY created_at DESC, resource_id DESC`
    ).all(teamId);
    return rows.map(rowToResource);
  }

  get({ resourceId }) {
    const row = this.db.prepare(
      'SELECT * FROM plugin_resources WHERE resource_id = ?'
    ).get(resourceId);
    return row ? rowToResource(row) : null;
  }

  markDeprovisioned({ resourceId, now = new Date().toISOString() }) {
    this.db.prepare(
      'UPDATE plugin_resources SET deprovisioned_at = ? WHERE resource_id = ?'
    ).run(now, resourceId);
    return this.get({ resourceId });
  }
}

function rowToResource(r) {
  return {
    resourceId: r.resource_id,
    teamId: r.team_id,
    pluginId: r.plugin_id,
    kind: r.kind,
    externalId: r.external_id,
    metadata: jsonParseObject(r.metadata_json, {}),
    createdAt: r.created_at,
    deprovisionedAt: r.deprovisioned_at,
  };
}
