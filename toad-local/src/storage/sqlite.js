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

