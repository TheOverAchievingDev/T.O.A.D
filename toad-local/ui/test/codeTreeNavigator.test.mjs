import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('codeTreeNavigator builds nested folders and filters with expanded ancestors', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-code-tree-test-'));
  try {
    const source = path.resolve('src/components/codeTreeNavigator.ts');
    const outDir = path.join(tmp, 'out');
    const tsc = spawnSync(
      process.execPath,
      [
        path.resolve('node_modules/typescript/bin/tsc'),
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

    const mod = await import(pathToFileURL(path.join(outDir, 'codeTreeNavigator.js')).href);
    const tree = mod.buildCodeTree([
      { path: 'src/components/CodeScreen.tsx', name: 'CodeScreen.tsx', kind: 'file', sizeBytes: 100 },
      { path: 'src/components', name: 'components', kind: 'directory' },
      { path: 'README.md', name: 'README.md', kind: 'file', sizeBytes: 10 },
      { path: 'src', name: 'src', kind: 'directory' },
      { path: 'src/api/client.ts', name: 'client.ts', kind: 'file', sizeBytes: 20 },
      { path: 'src/api', name: 'api', kind: 'directory' },
    ]);

    assert.deepEqual(tree.map((node) => node.path), ['src', 'README.md']);
    assert.deepEqual(tree[0].children.map((node) => node.path), ['src/api', 'src/components']);
    assert.equal(tree[0].children[1].children[0].path, 'src/components/CodeScreen.tsx');

    const visible = mod.flattenVisibleCodeTree(tree, new Set(['src', 'src/components']));
    assert.deepEqual(visible.map((node) => [node.depth, node.path]), [
      [0, 'src'],
      [1, 'src/api'],
      [1, 'src/components'],
      [2, 'src/components/CodeScreen.tsx'],
      [0, 'README.md'],
    ]);

    const filtered = mod.filterCodeTree(tree, 'code screen');
    assert.deepEqual(filtered.expandedPaths, ['src', 'src/components']);
    assert.deepEqual(mod.flattenVisibleCodeTree(filtered.nodes, new Set(filtered.expandedPaths)).map((node) => node.path), [
      'src',
      'src/components',
      'src/components/CodeScreen.tsx',
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
