import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSpans } from '../src/runtime/spanDetection/index.js';

const cases = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'spanDetection.input.json'), 'utf8'));

function caseByName(name) {
  const c = cases.find((x) => x.name === name);
  assert.ok(c, `fixture missing case: ${name}`);
  return c;
}

test('fixture cases collectively exercise every boundary reason + open + edges', () => {
  const reasons = new Set();
  let sawOpen = false;
  let sawTextOnly = false;
  let sawSingleOversized = false;
  for (const c of cases) {
    const spans = detectSpans(c.rows, c.config);
    for (const s of spans) {
      if (s.boundary) reasons.add(s.boundary.reason);
      if (s.closed === false) sawOpen = true;
      if (s.rowCount > 0 && s.rows.every((r) => r.kind === 'text')) sawTextOnly = true;
      if (s.rowCount === 1 && s.boundary && s.boundary.reason === 'size-cap') sawSingleOversized = true;
    }
  }
  for (const reason of ['system', 'agent-change', 'runtime-change', 'time-gap', 'size-cap']) {
    assert.ok(reasons.has(reason), `fixture never exercises boundary reason: ${reason}`);
  }
  assert.ok(sawOpen, 'fixture never produces a trailing OPEN span (closed:false)');
  assert.ok(sawTextOnly, 'fixture never produces a text-only span');
  assert.ok(sawSingleOversized, 'fixture never produces a single-oversized-row size-capped span');
});

test('empty case yields [] and all-system case yields []', () => {
  assert.deepEqual(detectSpans(caseByName('empty').rows), []);
  assert.deepEqual(detectSpans(caseByName('all-system').rows), []);
});
