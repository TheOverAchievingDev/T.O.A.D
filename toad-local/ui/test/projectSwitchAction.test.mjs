import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-project-switch-'));
  const source = path.resolve('ui/src/components/projectSwitchAction.ts');
  const tsc = path.resolve('ui/node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [
    tsc,
    source,
    '--target', 'ES2022',
    '--module', 'ES2022',
    '--moduleResolution', 'Bundler',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(result.stderr || result.stdout || 'tsc failed');
  }
  return { outDir, mod: await import(pathToFileURL(path.join(outDir, 'projectSwitchAction.js')).href) };
}

function makeDeps(overrides = {}) {
  const calls = { switchToProjectPath: [], setActive: [], refresh: 0, errors: [] };
  const deps = {
    projects: [{ id: 'p_1', path: 'C:/a' }, { id: 'p_2', path: 'C:/b' }],
    switchToProjectPath: async (p) => { calls.switchToProjectPath.push(p); return { path: p, name: 'b' }; },
    setActive: (id) => { calls.setActive.push(id); },
    refreshAfterProjectSwitch: () => { calls.refresh += 1; },
    onError: (e) => { calls.errors.push(e); },
    ...overrides,
  };
  return { deps, calls };
}

test('unknown path: returns false and performs no switch side effects', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const { deps, calls } = makeDeps();
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/does-not-exist');
    assert.equal(ok, false);
    assert.deepEqual(calls.switchToProjectPath, []);
    assert.deepEqual(calls.setActive, []);
    assert.equal(calls.refresh, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('known path + successful switch: respawns sidecar, then setActive, then refresh', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const { deps, calls } = makeDeps();
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
    assert.equal(ok, true);
    assert.deepEqual(calls.switchToProjectPath, ['C:/b']);
    assert.deepEqual(calls.setActive, ['p_2']);
    assert.equal(calls.refresh, 1);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('switchToProjectPath returns null: no setActive, no refresh, returns false', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const { deps, calls } = makeDeps({ switchToProjectPath: async () => null });
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
    assert.equal(ok, false);
    assert.deepEqual(calls.setActive, []);
    assert.equal(calls.refresh, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('switchToProjectPath throws: onError called, returns false, no setActive/refresh', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const boom = new Error('switch_project failed');
    const { deps, calls } = makeDeps({ switchToProjectPath: async () => { throw boom; } });
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
    assert.equal(ok, false);
    assert.deepEqual(calls.setActive, []);
    assert.equal(calls.refresh, 0);
    assert.deepEqual(calls.errors, [boom]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
