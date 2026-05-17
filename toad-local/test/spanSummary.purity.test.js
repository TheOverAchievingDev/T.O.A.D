import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideSpansToSummarize } from '../src/runtime/spanSummary/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'spanSummary');

test('spanSummary module imports no node:/fs/path/os/child_process/react, no JSX, never touches process', () => {
  for (const f of ['decideSpansToSummarize.js', 'index.js']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports a node: builtin`);
    assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), `${f} imports a node core module`);
    assert.ok(!/from\s+['"]react/.test(src), `${f} imports react`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
    assert.ok(!/(return|=>)\s*<[A-Za-z]/.test(src) && !/<\/[A-Za-z]/.test(src), `${f} contains JSX`);
  }
});

test('decideSpansToSummarize is callable and total on garbage input', () => {
  assert.deepEqual(decideSpansToSummarize(null), []);
  assert.deepEqual(decideSpansToSummarize({ spans: 'nope', summarizedSpanIds: 7 }), []);
});
