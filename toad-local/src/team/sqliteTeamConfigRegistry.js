import { openToadDatabase, jsonStringify, jsonParseObject } from '../storage/sqlite.js';
import { TeamConfig } from './teamConfig.js';

/**
 * SQLite-backed registry for team configurations.
 *
 * Mirrors the in-memory TeamConfigRegistry's API (registerTeam / getTeam /
 * listTeams) and adds deleteTeam plus close. registerTeam upserts on teamId
 * — matches the legacy app's "save and overwrite" pattern, lets operators
 * iterate on team config without a delete-then-recreate dance, and is the
 * shape the team_create MCP tool needs.
 */
export class SqliteTeamConfigRegistry {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  registerTeam(config) {
    if (!(config instanceof TeamConfig)) {
      throw new TypeError('config must be an instance of TeamConfig');
    }
    const now = new Date().toISOString();
    const json = jsonStringify(config.toJSON());
    this.db.prepare(`
      INSERT INTO team_configs (team_id, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(config.teamId, json, now, now);
  }

  getTeam(teamId) {
    if (typeof teamId !== 'string' || teamId.trim().length === 0) return null;
    const row = this.db
      .prepare(`SELECT config_json FROM team_configs WHERE team_id = ?`)
      .get(teamId.trim());
    if (!row) return null;
    return rowToConfig(row);
  }

  listTeams() {
    const rows = this.db
      .prepare(`SELECT config_json FROM team_configs ORDER BY team_id ASC`)
      .all();
    return rows.map(rowToConfig);
  }

  deleteTeam(teamId) {
    if (typeof teamId !== 'string' || teamId.trim().length === 0) return false;
    const result = this.db
      .prepare(`DELETE FROM team_configs WHERE team_id = ?`)
      .run(teamId.trim());
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}

function rowToConfig(row) {
  const raw = jsonParseObject(row.config_json, {});
  return new TeamConfig({
    teamId: raw.teamId,
    lead: raw.lead || {},
    teammates: Array.isArray(raw.teammates) ? raw.teammates : [],
    validation: raw.validation || null,
  });
}
