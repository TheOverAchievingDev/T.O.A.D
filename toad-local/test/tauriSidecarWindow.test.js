import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tauri sidecar Node process is launched without a visible Windows console', async () => {
  const source = await readFile(path.join(repoRoot, 'ui', 'src-tauri', 'src', 'main.rs'), 'utf8');

  assert.match(source, /CREATE_NO_WINDOW/);
  assert.match(source, /creation_flags\(CREATE_NO_WINDOW\)/);
});
