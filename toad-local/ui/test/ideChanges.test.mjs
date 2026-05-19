import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-ide-changes-'));
  const uiRoot = path.basename(process.cwd()).toLowerCase() === 'ui'
    ? process.cwd()
    : path.resolve('ui');
  const source = path.join(uiRoot, 'src/components/ideChanges.ts');
  const tsc = path.join(uiRoot, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [
    tsc, source,
    '--target', 'ES2022', '--module', 'ES2022',
    '--moduleResolution', 'Bundler', '--outDir', outDir, '--skipLibCheck',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(result.stderr || result.stdout || 'tsc failed');
  }
  return { outDir, mod: await import(pathToFileURL(path.join(outDir, 'ideChanges.js')).href) };
}

test('ideChanges helpers: glyph, count formatting, summary', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.statusGlyph('M'), 'M');
    assert.equal(mod.statusGlyph('?'), '?');
    assert.equal(mod.statusGlyph('Z'), 'Z'); // unknown \u2192 first char
    assert.equal(mod.statusGlyph(''), '\u2022'); // empty \u2192 bullet

    assert.equal(
      mod.formatChangeCounts({ relativePath: 'a', status: 'M', additions: 12, deletions: 3, binary: false }),
      '+12 \u22123', // "+12 \u22123" with U+2212 minus
    );
    assert.equal(
      mod.formatChangeCounts({ relativePath: 'a', status: '?', additions: null, deletions: null, binary: false }),
      '\u2014', // em dash
    );
    assert.equal(
      mod.formatChangeCounts({ relativePath: 'a', status: 'M', additions: null, deletions: null, binary: true }),
      'bin',
    );
    assert.equal(
      mod.formatChangeCounts({ relativePath: 'a', status: 'M', additions: 5, deletions: null, binary: false }),
      '+5 \u22120',
    );

    assert.equal(mod.summarizeChanges([{ relativePath: 'a' }, { relativePath: 'b' }]), 2);
    assert.equal(mod.summarizeChanges([]), 0);
    assert.equal(mod.summarizeChanges(undefined), 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
