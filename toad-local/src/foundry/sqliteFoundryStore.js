import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { openToadDatabase, jsonParseObject, jsonStringify } from '../storage/sqlite.js';

const SESSION_STATUSES = Object.freeze(['draft', 'ready', 'exported', 'archived']);
const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'system']);
const ARTIFACT_STATUSES = Object.freeze(['draft', 'approved', 'exported']);

export class SqliteFoundryStore {
  constructor({ filePath = ':memory:', db = null } = {}) {
    this.db = db || openToadDatabase(filePath);
  }

  createSession({
    sessionId = `foundry-${randomUUID()}`,
    title,
    projectPath = null,
    status = 'draft',
    metadata = {},
  } = {}) {
    const now = new Date().toISOString();
    const normalized = {
      sessionId: requireString(sessionId, 'sessionId'),
      title: requireString(title, 'title'),
      status: requireEnum(status, SESSION_STATUSES, 'status'),
      projectPath: typeof projectPath === 'string' && projectPath.trim().length > 0 ? projectPath.trim() : null,
      createdAt: now,
      updatedAt: now,
      metadata: normalizeObject(metadata),
    };
    this.db.prepare(`
      INSERT INTO foundry_sessions (
        session_id, title, status, project_path, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.sessionId,
      normalized.title,
      normalized.status,
      normalized.projectPath,
      normalized.createdAt,
      normalized.updatedAt,
      jsonStringify(normalized.metadata)
    );
    return normalized;
  }

  listSessions() {
    return this.db.prepare(`
      SELECT
        s.*,
        (SELECT COUNT(*) FROM foundry_messages m WHERE m.session_id = s.session_id) AS message_count,
        (SELECT COUNT(*) FROM foundry_artifacts a WHERE a.session_id = s.session_id) AS artifact_count
      FROM foundry_sessions s
      ORDER BY s.updated_at DESC
    `).all().map(rowToSessionSummary);
  }

  getSession(sessionId) {
    const row = this.db
      .prepare('SELECT * FROM foundry_sessions WHERE session_id = ?')
      .get(requireString(sessionId, 'sessionId'));
    if (!row) return null;
    const messages = this.db
      .prepare('SELECT * FROM foundry_messages WHERE session_id = ? ORDER BY created_at ASC, message_id ASC')
      .all(row.session_id)
      .map(rowToMessage);
    const artifacts = this.db
      .prepare('SELECT * FROM foundry_artifacts WHERE session_id = ? ORDER BY updated_at DESC, artifact_id ASC')
      .all(row.session_id)
      .map(rowToArtifact);
    return {
      session: rowToSession(row),
      messages,
      artifacts,
    };
  }

  addMessage({
    messageId = `foundry-msg-${randomUUID()}`,
    sessionId,
    role,
    text,
    metadata = {},
  } = {}) {
    const normalizedSessionId = requireString(sessionId, 'sessionId');
    this.#assertSessionExists(normalizedSessionId);
    const now = new Date().toISOString();
    const message = {
      messageId: requireString(messageId, 'messageId'),
      sessionId: normalizedSessionId,
      role: requireEnum(role, MESSAGE_ROLES, 'role'),
      text: requireString(text, 'text'),
      createdAt: now,
      metadata: normalizeObject(metadata),
    };
    this.db.prepare(`
      INSERT INTO foundry_messages (
        message_id, session_id, role, text, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      message.messageId,
      message.sessionId,
      message.role,
      message.text,
      message.createdAt,
      jsonStringify(message.metadata)
    );
    this.#touchSession(message.sessionId, now);
    return message;
  }

  upsertArtifact({
    artifactId = `foundry-artifact-${randomUUID()}`,
    sessionId,
    kind,
    title,
    content,
    targetPath = null,
    status = 'draft',
    metadata = {},
  } = {}) {
    const normalizedSessionId = requireString(sessionId, 'sessionId');
    this.#assertSessionExists(normalizedSessionId);
    const normalizedArtifactId = requireString(artifactId, 'artifactId');
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT version, created_at FROM foundry_artifacts WHERE artifact_id = ?')
      .get(normalizedArtifactId);
    const artifact = {
      artifactId: normalizedArtifactId,
      sessionId: normalizedSessionId,
      kind: requireString(kind, 'kind'),
      title: requireString(title, 'title'),
      content: typeof content === 'string' ? content : requireString(content, 'content'),
      targetPath: typeof targetPath === 'string' && targetPath.trim().length > 0 ? targetPath.trim() : null,
      version: existing ? Number(existing.version) + 1 : 1,
      status: requireEnum(status, ARTIFACT_STATUSES, 'status'),
      createdAt: existing?.created_at || now,
      updatedAt: now,
      metadata: normalizeObject(metadata),
    };
    this.db.prepare(`
      INSERT INTO foundry_artifacts (
        artifact_id, session_id, kind, title, content, target_path, version,
        status, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        session_id = excluded.session_id,
        kind = excluded.kind,
        title = excluded.title,
        content = excluded.content,
        target_path = excluded.target_path,
        version = excluded.version,
        status = excluded.status,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      artifact.artifactId,
      artifact.sessionId,
      artifact.kind,
      artifact.title,
      artifact.content,
      artifact.targetPath,
      artifact.version,
      artifact.status,
      artifact.createdAt,
      artifact.updatedAt,
      jsonStringify(artifact.metadata)
    );
    this.#touchSession(artifact.sessionId, now);
    return artifact;
  }

  exportArtifacts({ sessionId, rootDir, artifactIds = null } = {}) {
    const normalizedSessionId = requireString(sessionId, 'sessionId');
    this.#assertSessionExists(normalizedSessionId);
    const root = resolve(requireString(rootDir, 'rootDir'));
    const ids = Array.isArray(artifactIds)
      ? artifactIds.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
      : null;
    const artifacts = ids && ids.length > 0
      ? ids.map((id) => this.#getArtifactForSession(normalizedSessionId, id))
      : this.db
          .prepare('SELECT * FROM foundry_artifacts WHERE session_id = ? ORDER BY updated_at DESC')
          .all(normalizedSessionId)
          .map(rowToArtifact);
    const now = new Date().toISOString();
    const files = [];
    for (const artifact of artifacts) {
      const targetPath = requireString(artifact.targetPath, 'artifact.targetPath');
      const absolutePath = resolveInside(root, targetPath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, artifact.content, 'utf8');
      this.db
        .prepare('UPDATE foundry_artifacts SET status = ?, updated_at = ? WHERE artifact_id = ?')
        .run('exported', now, artifact.artifactId);
      files.push({
        artifactId: artifact.artifactId,
        targetPath,
        absolutePath,
      });
    }
    this.db
      .prepare('UPDATE foundry_sessions SET status = ?, updated_at = ? WHERE session_id = ?')
      .run('exported', now, normalizedSessionId);
    return { sessionId: normalizedSessionId, rootDir: root, files };
  }

  close() {
    this.db.close();
  }

  #getArtifactForSession(sessionId, artifactId) {
    const row = this.db
      .prepare('SELECT * FROM foundry_artifacts WHERE session_id = ? AND artifact_id = ?')
      .get(sessionId, artifactId);
    if (!row) throw new Error(`foundry artifact not found: ${artifactId}`);
    return rowToArtifact(row);
  }

  #assertSessionExists(sessionId) {
    const row = this.db
      .prepare('SELECT session_id FROM foundry_sessions WHERE session_id = ?')
      .get(sessionId);
    if (!row) throw new Error(`foundry session not found: ${sessionId}`);
  }

  #touchSession(sessionId, updatedAt) {
    this.db
      .prepare('UPDATE foundry_sessions SET updated_at = ? WHERE session_id = ?')
      .run(updatedAt, sessionId);
  }
}

function rowToSession(row) {
  return {
    sessionId: row.session_id,
    title: row.title,
    status: row.status,
    projectPath: row.project_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: jsonParseObject(row.metadata_json, {}),
  };
}

function rowToSessionSummary(row) {
  return {
    ...rowToSession(row),
    messageCount: Number(row.message_count || 0),
    artifactCount: Number(row.artifact_count || 0),
  };
}

function rowToMessage(row) {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
    metadata: jsonParseObject(row.metadata_json, {}),
  };
}

function rowToArtifact(row) {
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    targetPath: row.target_path || null,
    version: Number(row.version || 0),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: jsonParseObject(row.metadata_json, {}),
  };
}

function resolveInside(root, targetPath) {
  const dest = resolve(root, targetPath);
  const rel = relative(root, dest);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`targetPath escapes export root: ${targetPath}`);
  }
  return dest;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireEnum(value, values, label) {
  const normalized = requireString(value, label);
  if (!values.includes(normalized)) {
    throw new Error(`${label} must be one of: ${values.join(', ')}`);
  }
  return normalized;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
