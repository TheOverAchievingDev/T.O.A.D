import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

/**
 * §3 Settings storage. Two-tier layout:
 *
 *   GLOBAL:  %APPDATA%/toad/settings.json   (Windows)
 *            ~/.config/toad/settings.json   (Unix)
 *   PROJECT: <projectCwd>/.toad/settings.json
 *
 * Project values override global values key-by-key (shallow merge by section).
 * Sections are namespaced top-level keys: { general, providers, github,
 * workspace, risk, mcp, notifications, advanced }. Each section is an object;
 * unknown sections are preserved as-is (forward-compatible).
 *
 * The store is intentionally tiny — no schema validation here. Callers
 * (toolFacade) validate args; UI re-validates on read. This keeps the store
 * a dumb persistence layer, easy to swap later (sqlite, encrypted, etc).
 */

export class SettingsStore {
  #globalPath;
  #projectPath;

  constructor({ globalPath, projectCwd } = {}) {
    this.#globalPath = globalPath || resolveGlobalSettingsPath();
    this.#projectPath = projectCwd
      ? path.join(projectCwd, '.toad', 'settings.json')
      : null;
  }

  getGlobalPath() {
    return this.#globalPath;
  }

  getProjectPath() {
    return this.#projectPath;
  }

  /**
   * Read the merged effective settings. Result includes a `_sources` field
   * indicating where each top-level section came from ('global' | 'project' |
   * 'default'), so the UI can show "this value comes from the project file".
   */
  async readEffective() {
    const [global, project] = await Promise.all([
      this.#readJsonFile(this.#globalPath),
      this.#projectPath ? this.#readJsonFile(this.#projectPath) : Promise.resolve(null),
    ]);

    const merged = mergeSettings(global, project);
    return {
      ...merged,
      _sources: collectSources(global, project),
    };
  }

  /** Read raw global settings, never the project overrides. */
  async readGlobalRaw() {
    const out = await this.#readJsonFile(this.#globalPath);
    return out ?? {};
  }

  /** Read raw project settings, never global. Returns {} when missing. */
  async readProjectRaw() {
    if (!this.#projectPath) return {};
    const out = await this.#readJsonFile(this.#projectPath);
    return out ?? {};
  }

  /**
   * Update one section (top-level key). `scope` chooses which file to write to.
   * Existing sections in the same file are preserved.
   */
  async setSection({ scope, section, value }) {
    if (scope !== 'global' && scope !== 'project') {
      throw new Error(`scope must be 'global' or 'project' (got ${scope})`);
    }
    if (!isPlainObject(value)) {
      throw new Error('value must be a plain object');
    }
    const target = scope === 'global' ? this.#globalPath : this.#projectPath;
    if (!target) {
      throw new Error("project scope requires projectCwd; got none");
    }

    const existing = (await this.#readJsonFile(target)) ?? {};
    const next = { ...existing, [section]: value };
    await this.#writeJsonFile(target, next);
    return next[section];
  }

  /** Replace the whole file at the given scope. Use carefully. */
  async writeAll({ scope, payload }) {
    if (scope !== 'global' && scope !== 'project') {
      throw new Error(`scope must be 'global' or 'project'`);
    }
    if (!isPlainObject(payload)) {
      throw new Error('payload must be a plain object');
    }
    const target = scope === 'global' ? this.#globalPath : this.#projectPath;
    if (!target) {
      throw new Error("project scope requires projectCwd; got none");
    }
    await this.#writeJsonFile(target, payload);
  }

  async #readJsonFile(filePath) {
    if (!filePath) return null;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) return null;
      return parsed;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      // Malformed JSON: don't blow up the whole UI. Surface via the merged shape.
      return null;
    }
  }

  async #writeJsonFile(filePath, payload) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  }
}

export function resolveGlobalSettingsPath() {
  if (process.env.TOAD_SETTINGS_PATH) {
    return process.env.TOAD_SETTINGS_PATH;
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'toad', 'settings.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'toad', 'settings.json');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeSettings(global, project) {
  const out = {};
  if (global && isPlainObject(global)) {
    for (const [k, v] of Object.entries(global)) {
      out[k] = v;
    }
  }
  if (project && isPlainObject(project)) {
    for (const [k, v] of Object.entries(project)) {
      // Sections (objects) shallow-merge global ⊆ project. Non-object scalars
      // get replaced wholesale.
      if (isPlainObject(v) && isPlainObject(out[k])) {
        out[k] = { ...out[k], ...v };
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

function collectSources(global, project) {
  const sources = {};
  if (global && isPlainObject(global)) {
    for (const k of Object.keys(global)) sources[k] = 'global';
  }
  if (project && isPlainObject(project)) {
    for (const k of Object.keys(project)) sources[k] = 'project';
  }
  return sources;
}
