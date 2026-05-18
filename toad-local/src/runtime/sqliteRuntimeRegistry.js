import { jsonParseObject, jsonStringify, openToadDatabase } from '../storage/sqlite.js';

export class SqliteRuntimeRegistry {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  close() {
    this.db.close();
  }

  upsertRuntime(input) {
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const providerId = requireString(input.providerId, 'providerId');
    const command = requireString(input.command, 'command');
    const deliveryMode = requireString(input.deliveryMode, 'deliveryMode');
    const status = requireString(input.status, 'status');
    const startedAt = input.startedAt || new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const env = input.env && typeof input.env === 'object' ? { ...input.env } : {};

    const taskId = typeof input.taskId === 'string' && input.taskId.length > 0 ? input.taskId : null;

    this.#ensureTeam(teamId);
    this.db.prepare(
      `
        INSERT INTO runtime_instances (
          runtime_id,
          team_id,
          agent_id,
          provider_id,
          command,
          args_json,
          cwd,
          env_json,
          delivery_mode,
          pid,
          status,
          started_at,
          updated_at,
          stopped_at,
          exit_code,
          signal,
          task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
        ON CONFLICT(runtime_id)
        DO UPDATE SET
          team_id = excluded.team_id,
          agent_id = excluded.agent_id,
          provider_id = excluded.provider_id,
          command = excluded.command,
          args_json = excluded.args_json,
          cwd = excluded.cwd,
          env_json = excluded.env_json,
          delivery_mode = excluded.delivery_mode,
          pid = excluded.pid,
          status = excluded.status,
          updated_at = excluded.updated_at,
          stopped_at = NULL,
          exit_code = NULL,
          signal = NULL,
          task_id = excluded.task_id
      `
    ).run(
      runtimeId,
      teamId,
      agentId,
      providerId,
      command,
      jsonStringify(args),
      input.cwd || null,
      jsonStringify(env),
      deliveryMode,
      typeof input.pid === 'number' ? input.pid : null,
      status,
      startedAt,
      updatedAt,
      taskId
    );

    return this.getRuntime(runtimeId);
  }

  getRuntime(runtimeId) {
    const row = this.db
      .prepare('SELECT * FROM runtime_instances WHERE runtime_id = ?')
      .get(requireString(runtimeId, 'runtimeId'));
    return row ? this.#rowToRuntime(row) : null;
  }

  listRuntimes({ teamId = null } = {}) {
    const rows = teamId
      ? this.db
          .prepare(
            'SELECT * FROM runtime_instances WHERE team_id = ? ORDER BY started_at ASC, runtime_id ASC'
          )
          .all(teamId)
      : this.db
          .prepare('SELECT * FROM runtime_instances ORDER BY started_at ASC, runtime_id ASC')
          .all();
    return rows.map((row) => this.#rowToRuntime(row));
  }

  registerDeliveryMode(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const deliveryMode = requireString(input.deliveryMode, 'deliveryMode');
    const metadata = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {};

    if (!this.getRuntime(runtimeId)) {
      throw new Error(`unknown runtime: ${runtimeId}`);
    }
    this.#ensureTeam(teamId);
    this.db.prepare(
      `
        INSERT INTO agent_delivery_modes (
          team_id,
          agent_id,
          runtime_id,
          delivery_mode,
          metadata_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(team_id, agent_id)
        DO UPDATE SET
          runtime_id = excluded.runtime_id,
          delivery_mode = excluded.delivery_mode,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `
    ).run(teamId, agentId, runtimeId, deliveryMode, jsonStringify(metadata), new Date().toISOString());

    return this.#getDeliveryMode(teamId, agentId);
  }

  unregisterDeliveryMode(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const result = this.db
      .prepare('DELETE FROM agent_delivery_modes WHERE team_id = ? AND agent_id = ?')
      .run(teamId, agentId);
    return result.changes > 0;
  }

  listDeliveryModes({ teamId = null } = {}) {
    const rows = teamId
      ? this.db
          .prepare(
            'SELECT * FROM agent_delivery_modes WHERE team_id = ? ORDER BY team_id ASC, agent_id ASC'
          )
          .all(teamId)
      : this.db
          .prepare('SELECT * FROM agent_delivery_modes ORDER BY team_id ASC, agent_id ASC')
          .all();
    return rows.map((row) => this.#rowToDeliveryMode(row));
  }

  hydrateRuntimeDirectory(directory) {
    if (!directory || typeof directory.registerAgent !== 'function') {
      throw new TypeError('directory with registerAgent() is required');
    }
    for (const mode of this.listDeliveryModes()) {
      directory.registerAgent(mode);
    }
    return directory;
  }

  /**
   * Boot-time sweep: mark every runtime row whose status is still in a
   * "live" state (running / starting / live) as stopped. This is the
   * recovery path for ungraceful sidecar shutdowns where child claude
   * processes died but the SQL row never got the markRuntimeStopped()
   * write, leaving zombie rows that the UI surfaces as "running" on the
   * next boot. Already-terminal statuses (stopped, error, exited) are
   * preserved — overwriting them with 'stopped' would lose information.
   *
   * Returns the PIDs of any reconciled rows so the caller can kill the
   * orphaned child processes on Windows (where children don't die with
   * the parent sidecar by default). Without that kill, those claude.exe
   * processes outlive the sidecar that spawned them but we can't talk
   * to them — their stdin pipe handles died with the old sidecar.
   *
   * Idempotent: returning reconciled=0 means nothing to do.
   * Returns: { reconciled: number, orphanedPids: number[] }
   */
  reconcileOrphans() {
    const stoppedAt = new Date().toISOString();
    const updatedAt = stoppedAt;
    // Collect PIDs of soon-to-be-reconciled rows BEFORE updating, since
    // the PID column doesn't get cleared (so we could read it after, but
    // doing it before is cleaner and avoids a re-query).
    const aboutToReconcile = this.db
      .prepare("SELECT pid FROM runtime_instances WHERE status IN ('running', 'starting', 'live') AND pid IS NOT NULL")
      .all();
    const orphanedPids = aboutToReconcile
      .map((row) => row.pid)
      .filter((pid) => typeof pid === 'number' && Number.isFinite(pid) && pid > 0);

    const result = this.db.prepare(
      `
        UPDATE runtime_instances
        SET status = 'stopped', stopped_at = ?, updated_at = ?
        WHERE status IN ('running', 'starting', 'live')
      `
    ).run(stoppedAt, updatedAt);
    // Wipe delivery modes for any rows we just marked stopped — adapter is
    // dead, so the cached binding is bogus and would mislead callers.
    if (result.changes > 0) {
      this.db.prepare(
        `
          DELETE FROM agent_delivery_modes
          WHERE runtime_id IN (
            SELECT runtime_id FROM runtime_instances WHERE status = 'stopped' AND stopped_at = ?
          )
        `
      ).run(stoppedAt);
    }
    return { reconciled: result.changes, orphanedPids };
  }

  markRuntimeStopped({
    runtimeId,
    status = 'stopped',
    exitCode = null,
    signal = null,
    stoppedAt = new Date().toISOString(),
  }) {
    const id = requireString(runtimeId, 'runtimeId');
    if (!this.getRuntime(id)) {
      throw new Error(`unknown runtime: ${id}`);
    }
    const updatedAt = new Date().toISOString();
    this.db.prepare(
      `
        UPDATE runtime_instances
        SET status = ?,
            stopped_at = ?,
            updated_at = ?,
            exit_code = ?,
            signal = ?
        WHERE runtime_id = ?
      `
    ).run(
      requireString(status, 'status'),
      stoppedAt,
      updatedAt,
      typeof exitCode === 'number' ? exitCode : null,
      typeof signal === 'string' ? signal : null,
      id
    );
    this.db.prepare('DELETE FROM agent_delivery_modes WHERE runtime_id = ?').run(id);
    return this.getRuntime(id);
  }

  setRuntimeCliSessionId({ runtimeId, cliSessionId }) {
    const id = requireString(runtimeId, 'runtimeId');
    if (!this.getRuntime(id)) {
      throw new Error(`unknown runtime: ${id}`);
    }
    const value = typeof cliSessionId === 'string' && cliSessionId.length > 0 ? cliSessionId : null;
    this.db.prepare(
      'UPDATE runtime_instances SET cli_session_id = ?, updated_at = ? WHERE runtime_id = ?'
    ).run(value, new Date().toISOString(), id);
    return this.getRuntime(id);
  }

  #ensureTeam(teamId) {
    this.db.prepare(
      `
        INSERT INTO teams (team_id, display_name, created_at)
        VALUES (?, NULL, ?)
        ON CONFLICT(team_id) DO NOTHING
      `
    ).run(teamId, new Date().toISOString());
  }

  #rowToRuntime(row) {
    return {
      runtimeId: row.runtime_id,
      teamId: row.team_id,
      agentId: row.agent_id,
      providerId: row.provider_id,
      command: row.command,
      args: jsonParseArray(row.args_json),
      cwd: row.cwd,
      env: jsonParseObject(row.env_json),
      deliveryMode: row.delivery_mode,
      pid: row.pid,
      status: row.status,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      stoppedAt: row.stopped_at,
      exitCode: row.exit_code,
      signal: row.signal,
      taskId: row.task_id || null,
      cliSessionId: row.cli_session_id || null,
    };
  }

  #getDeliveryMode(teamId, agentId) {
    const row = this.db
      .prepare('SELECT * FROM agent_delivery_modes WHERE team_id = ? AND agent_id = ?')
      .get(teamId, agentId);
    return row ? this.#rowToDeliveryMode(row) : null;
  }

  #rowToDeliveryMode(row) {
    return {
      teamId: row.team_id,
      agentId: row.agent_id,
      runtimeId: row.runtime_id,
      deliveryMode: row.delivery_mode,
      metadata: jsonParseObject(row.metadata_json),
      updatedAt: row.updated_at,
    };
  }
}

function jsonParseArray(value) {
  const parsed = jsonParseObject(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
