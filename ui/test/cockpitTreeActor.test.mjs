import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-tree-actor-'));
  const source = path.resolve('ui/src/components/cockpit/cockpitTreeActor.ts');
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
  return {
    outDir,
    mod: await import(pathToFileURL(path.join(outDir, 'cockpitTreeActor.js')).href),
  };
}

test('resolveCockpitTreeActor uses the app actor before team name so project tree can load without a team config', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const actor = mod.resolveCockpitTreeActor({
      actor: { teamId: 'active-team', agentId: 'ui-client', role: 'human' },
      teamName: '',
    });

    assert.deepEqual(actor, {
      teamId: 'active-team',
      agentId: 'ui-client',
      agentName: 'ui',
      role: 'human',
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('resolveCockpitTreeActor falls back to team name and then system', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.resolveCockpitTreeActor({ teamName: 'team-a' }).teamId, 'team-a');
    assert.equal(mod.resolveCockpitTreeActor({ teamName: '' }).teamId, 'system');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('resolveCockpitTreeActor treats IDE calls as human operator actions', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const actor = mod.resolveCockpitTreeActor({
      actor: { teamId: 'team-a', agentId: 'dev-1', agentName: 'Dev', role: 'developer' },
      teamName: 'team-a',
    });

    assert.deepEqual(actor, {
      teamId: 'team-a',
      agentId: 'dev-1',
      agentName: 'Dev',
      role: 'human',
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
