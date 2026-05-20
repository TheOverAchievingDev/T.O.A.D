import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SettingsStore, resolveGlobalSettingsPath } from '../src/settings/settingsStore.js';

async function makeTmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-settings-'));
  return dir;
}

test('SettingsStore writes a section to global scope and reads it back', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-glob-'));
  const globalPath = path.join(tmpRoot, 'global.json');
  const store = new SettingsStore({ globalPath, projectCwd: null });

  await store.setSection({ scope: 'global', section: 'general', value: { theme: 'light', density: 'compact' } });

  const written = await store.readGlobalRaw();
  assert.deepEqual(written.general, { theme: 'light', density: 'compact' });

  const effective = await store.readEffective();
  assert.equal(effective.general.theme, 'light');
  assert.equal(effective._sources.general, 'global');
});

test('SettingsStore project values shallow-merge over globals per section', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-merge-'));
  const globalPath = path.join(tmpRoot, 'global.json');
  const projectCwd = await makeTmpProject();
  const store = new SettingsStore({ globalPath, projectCwd });

  await store.setSection({ scope: 'global', section: 'general', value: { theme: 'dark', density: 'comfy', locale: 'en-US' } });
  await store.setSection({ scope: 'project', section: 'general', value: { theme: 'light' } });

  const effective = await store.readEffective();
  assert.equal(effective.general.theme, 'light', 'project should override theme');
  assert.equal(effective.general.density, 'comfy', 'global density should pass through');
  assert.equal(effective.general.locale, 'en-US', 'global locale should pass through');
  assert.equal(effective._sources.general, 'project');
});

test('SettingsStore preserves untouched sections when writing one section', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-pres-'));
  const globalPath = path.join(tmpRoot, 'global.json');
  const store = new SettingsStore({ globalPath, projectCwd: null });

  await store.setSection({ scope: 'global', section: 'general', value: { theme: 'dark' } });
  await store.setSection({ scope: 'global', section: 'providers', value: { defaultProvider: 'anthropic' } });
  await store.setSection({ scope: 'global', section: 'general', value: { theme: 'light' } });

  const out = await store.readGlobalRaw();
  assert.equal(out.general.theme, 'light');
  assert.equal(out.providers.defaultProvider, 'anthropic');
});

test('SettingsStore returns empty effective when neither file exists', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-empty-'));
  const globalPath = path.join(tmpRoot, 'never-written.json');
  const store = new SettingsStore({ globalPath, projectCwd: null });
  const effective = await store.readEffective();
  // Only the synthetic _sources field should exist.
  assert.deepEqual(Object.keys(effective).filter((k) => k !== '_sources'), []);
});

test('SettingsStore readGlobalRaw recovers gracefully from malformed JSON', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-bad-'));
  const globalPath = path.join(tmpRoot, 'malformed.json');
  await fs.writeFile(globalPath, '{not valid json', 'utf8');
  const store = new SettingsStore({ globalPath, projectCwd: null });
  const out = await store.readGlobalRaw();
  assert.deepEqual(out, {}, 'should return empty object instead of throwing');
});

test('SettingsStore rejects non-object payloads', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-rej-'));
  const store = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: null });
  await assert.rejects(
    () => store.setSection({ scope: 'global', section: 'general', value: 'not-an-object' }),
    /value must be a plain object/,
  );
  await assert.rejects(
    () => store.setSection({ scope: 'invalid', section: 'general', value: {} }),
    /scope must be/,
  );
});

test('SettingsStore rejects project scope when no projectCwd was provided', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-noproj-'));
  const store = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: null });
  await assert.rejects(
    () => store.setSection({ scope: 'project', section: 'general', value: { theme: 'dark' } }),
    /requires projectCwd/,
  );
});

test('resolveGlobalSettingsPath honours TOAD_SETTINGS_PATH override', () => {
  const before = process.env.TOAD_SETTINGS_PATH;
  process.env.TOAD_SETTINGS_PATH = '/tmp/explicit-toad/settings.json';
  try {
    assert.equal(resolveGlobalSettingsPath(), '/tmp/explicit-toad/settings.json');
  } finally {
    if (before == null) delete process.env.TOAD_SETTINGS_PATH;
    else process.env.TOAD_SETTINGS_PATH = before;
  }
});

test('resolveGlobalSettingsPath returns a stable platform-specific default', () => {
  const before = process.env.TOAD_SETTINGS_PATH;
  delete process.env.TOAD_SETTINGS_PATH;
  try {
    const p = resolveGlobalSettingsPath();
    assert.equal(typeof p, 'string');
    assert.match(p, /toad[\\/]settings\.json$/);
  } finally {
    if (before != null) process.env.TOAD_SETTINGS_PATH = before;
  }
});
