import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeRows } from '../scripts/captureTimelineCompositionGolden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.input.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.golden.json'), 'utf8'));

test('baseline locked: pristine capture is deterministic and equals the committed golden', () => {
  assert.deepEqual(computeRows(cases), golden);
});
