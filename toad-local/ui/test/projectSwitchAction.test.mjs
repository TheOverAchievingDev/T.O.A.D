import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// The helper source is identical across every test, so compile it
// exactly once (before hook) and tear the temp dir down once (after
// hook) rather than re-spawning tsc per test.
let outDir;
let mod;

before(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-project-switch-'));
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
  mod = await import(pathToFileURL(path.join(outDir, 'projectSwitchAction.js')).href);
});

after(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function makeDeps(overrides = {}) {
  const calls = { switchToProjectPath: [], setActive: [], refresh: 0, errors: [], order: [] };
  const deps = {
    projects: [{ id: 'p_1', path: 'C:/a' }, { id: 'p_2', path: 'C:/b' }],
    switchToProjectPath: async (p) => {
      calls.switchToProjectPath.push(p);
      calls.order.push('switch');
      return { path: p, name: 'b' };
    },
    setActive: (id) => { calls.setActive.push(id); calls.order.push('setActive'); },
    refreshAfterProjectSwitch: () => { calls.refresh += 1; calls.order.push('refresh'); },
    onError: (e) => { calls.errors.push(e); },
    ...overrides,
  };
  return { deps, calls };
}

test('unknown path: returns false and performs no switch side effects', async () => {
  const { deps, calls } = makeDeps();
  const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/does-not-exist');
  assert.equal(ok, false);
  assert.deepEqual(calls.switchToProjectPath, []);
  assert.deepEqual(calls.setActive, []);
  assert.equal(calls.refresh, 0);
});

test('known path + successful switch: respawns sidecar, then setActive, then refresh', async () => {
  const { deps, calls } = makeDeps();
  const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
  assert.equal(ok, true);
  assert.deepEqual(calls.switchToProjectPath, ['C:/b']);
  assert.deepEqual(calls.setActive, ['p_2']);
  assert.equal(calls.refresh, 1);
  assert.deepEqual(calls.order, ['switch', 'setActive', 'refresh']);
});

test('switchToProjectPath returns null: no setActive, no refresh, returns false', async () => {
  const { deps, calls } = makeDeps({ switchToProjectPath: async () => null });
  const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
  assert.equal(ok, false);
  assert.deepEqual(calls.setActive, []);
  assert.equal(calls.refresh, 0);
});

test('switchToProjectPath throws: onError called, returns false, no setActive/refresh', async () => {
  const boom = new Error('switch_project failed');
  const { deps, calls } = makeDeps({ switchToProjectPath: async () => { throw boom; } });
  const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
  assert.equal(ok, false);
  assert.deepEqual(calls.setActive, []);
  assert.equal(calls.refresh, 0);
  assert.deepEqual(calls.errors, [boom]);
});

test('switchToProjectPath throws with no onError provided: resolves false, does not throw', async () => {
  const { deps, calls } = makeDeps({
    switchToProjectPath: async () => { throw new Error('switch_project failed'); },
  });
  delete deps.onError;
  const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
  assert.equal(ok, false);
  assert.deepEqual(calls.setActive, []);
  assert.equal(calls.refresh, 0);
});
