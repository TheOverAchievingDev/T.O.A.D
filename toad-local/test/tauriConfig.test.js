import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tauri packaged CSP allows the local API, Tauri IPC, and bundled font fetches', async () => {
  const raw = await readFile(path.join(repoRoot, 'ui', 'src-tauri', 'tauri.conf.json'), 'utf8');
  const config = JSON.parse(raw);
  const csp = config.app.security.csp;

  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/);
  assert.match(csp, /connect-src[^;]*http:\/\/ipc\.localhost/);
  assert.match(csp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
});
