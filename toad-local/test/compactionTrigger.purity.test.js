import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { REASONS } from '../src/runtime/compactionTrigger/shouldCompact.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'compactionTrigger');

test('shouldCompact.js imports no node:* / fs / path / os / child_process and never touches process', () => {
  const src = readFileSync(join(dir, 'shouldCompact.js'), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(src), 'imports a node: builtin');
  assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), 'imports a node core module');
  assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), 'touches process');
});

test('REASONS is sealed — mutation throws (Node >=20 frozen semantics)', () => {
  assert.throws(() => { REASONS.NEW_ONE = 'x'; }, TypeError);
  assert.throws(() => { REASONS.BELOW_THRESHOLD = 'mutated'; }, TypeError);
});

test('REASONS has exactly the seven sealed members', () => {
  assert.deepEqual(
    [...Object.keys(REASONS)].sort(),
    ['BELOW_THRESHOLD', 'GATED_IN_FLIGHT', 'GIVING_UP_SURFACED', 'NO_SIGNAL', 'RETRY', 'SIGNAL_UNTRUSTWORTHY', 'THRESHOLD_CROSSED'].sort(),
  );
});

import { shouldCompact as sc2, REASONS as R2 } from '../src/runtime/compactionTrigger/index.js';
test('index.js re-exports shouldCompact + REASONS', () => {
  assert.equal(typeof sc2, 'function');
  assert.equal(R2.THRESHOLD_CROSSED, 'threshold-crossed');
});
