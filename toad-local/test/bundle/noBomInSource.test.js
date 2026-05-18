// BR3 — B2 (bundle whole-impl review): a UTF-8 BOM (EF BB BF) was accidentally
// injected at the start of src/drift/driftEngine.js. Node strips a leading BOM
// for ESM so it ran, but a BOM breaks byte-level tooling, diffs, and some
// bundlers/linters. This guard rejects a leading BOM in any .js file under
// src (recursively) so the accident can't recur.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no src/**/*.js file starts with a UTF-8 BOM', () => {
  const files = jsFiles(SRC);
  assert.ok(files.length > 100, `sanity: expected to scan many source files, scanned ${files.length}`);
  const offenders = files.filter((f) => {
    const b = readFileSync(f);
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  }).map((f) => path.relative(SRC, f));
  assert.deepEqual(offenders, [], `files with a leading UTF-8 BOM: ${offenders.join(', ')}`);
});
