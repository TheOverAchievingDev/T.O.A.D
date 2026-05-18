import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function loadModule() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-create-team-model-'));
  const source = path.resolve('ui/src/components/createTeamModelArgs.ts');
  const outDir = path.join(tmp, 'out');
  const tsc = spawnSync(
    process.execPath,
    [
      path.resolve('ui/node_modules/typescript/bin/tsc'),
      source,
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--outDir',
      outDir,
      '--skipLibCheck',
      '--strict',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  const mod = await import(pathToFileURL(path.join(outDir, 'createTeamModelArgs.js')).href);
  return { mod, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

test('modelArgsForProvider emits OpenCode --model args for explicit models only', async () => {
  const { mod, cleanup } = await loadModule();
  const { modelArgsForProvider } = mod;
  try {
  assert.deepEqual(modelArgsForProvider('opencode', 'deepseek/deepseek-v4-pro'), ['--model', 'deepseek/deepseek-v4-pro']);
  assert.deepEqual(modelArgsForProvider('opencode', 'Default'), []);
  assert.deepEqual(modelArgsForProvider('anthropic', 'Sonnet 4.6'), []);
  } finally {
    await cleanup();
  }
});

test('mergeDynamicProviderModels replaces OpenCode models with Default plus dynamic ids', async () => {
  const { mod, cleanup } = await loadModule();
  const { mergeDynamicProviderModels } = mod;
  try {
  const providers = [
    { id: 'anthropic', label: 'Anthropic', models: ['Default', 'Sonnet'] },
    { id: 'opencode', label: 'OpenCode', models: ['Default', 'Old'] },
  ];

  const merged = mergeDynamicProviderModels(providers, 'opencode', ['opencode/free', 'deepseek/pro']);

  assert.deepEqual(merged.find((p) => p.id === 'opencode')?.models, ['Default', 'opencode/free', 'deepseek/pro']);
  assert.deepEqual(merged.find((p) => p.id === 'anthropic')?.models, ['Default', 'Sonnet']);
  } finally {
    await cleanup();
  }
});
