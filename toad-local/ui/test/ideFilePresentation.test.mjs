import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-ide-presentation-'));
  const source = path.resolve('ui/src/components/ideFilePresentation.ts');
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
  return { outDir, mod: await import(pathToFileURL(path.join(outDir, 'ideFilePresentation.js')).href) };
}

test('languageForFile maps common Cursor/VS Code project files', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.languageForFile('src/app.py'), 'python');
    assert.equal(mod.languageForFile('Dockerfile'), 'dockerfile');
    assert.equal(mod.languageForFile('.env.local'), 'dotenv');
    assert.equal(mod.languageForFile('Makefile'), 'makefile');
    assert.equal(mod.languageForFile('README.mdx'), 'mdx');
    assert.equal(mod.languageForFile('unknown.custom'), 'plaintext');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('isEditableIdeFile recognizes text result shape only', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.isEditableIdeFile({ kind: 'text', editable: true, content: 'x' }), true);
    assert.equal(mod.isEditableIdeFile({ kind: 'unsupported', editable: false, reason: 'binary' }), false);
    assert.equal(mod.isEditableIdeFile({ content: 'legacy', editable: undefined }), true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('unsupportedReason provides stable panel copy', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.unsupportedReason({ reason: 'Binary file' }), 'Binary file');
    assert.match(mod.unsupportedReason({}), /cannot be edited/i);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
