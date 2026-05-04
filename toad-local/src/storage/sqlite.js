import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const currentDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(currentDir, 'schema.sql');

export function openToadDatabase(filePath = ':memory:') {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  // busy_timeout: when another writer holds the lock, retry for up to N ms
  // before erroring. Addresses `[LocalToadRuntime] adapter events loop
  // error: database is locked` under team_launch where 3+ claude processes
  // emit runtime events concurrently. Applies to memory dbs too — harmless
  // there, useful in shared-file connection scenarios.
  // NOTE: WAL journal_mode is intentionally NOT enabled. Earlier
  // experimentation with `PRAGMA journal_mode = WAL` introduced sporadic
  // ordering anomalies on Windows under node:sqlite (foundry message
  // role 0/1 flipping between user/assistant in test runs that pass in
  // isolation but fail when scheduled after another file-db test).
  // busy_timeout alone resolves our actual contention.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(readFileSync(schemaPath, 'utf8'));
  applyMigrations(db);
  return db;
}

/**
 * Idempotent column-add migrations for fields introduced after the initial
 * schema. SQLite's `CREATE TABLE IF NOT EXISTS` doesn't widen an existing
 * table, so each new column needs an `ALTER TABLE ADD COLUMN` that swallows
 * the duplicate-column error. Cheap to run on every open.
 */
function applyMigrations(db) {
  // §11 slice 1: link runtimes to their task.
  try { db.exec('ALTER TABLE runtime_instances ADD COLUMN task_id TEXT'); } catch {}
}

export function jsonStringify(value) {
  return JSON.stringify(value ?? {});
}

export function jsonParseObject(value, fallback = {}) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

