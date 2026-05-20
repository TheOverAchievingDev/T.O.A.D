import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSummaryText } from '../src/runtime/spanSummary/index.js';

test('plain text passes through trimmed', () => {
  assert.equal(extractSummaryText('  The agent read a.js and ran tests.  '), 'The agent read a.js and ran tests.');
});

test('strips a single wrapping code fence (```lang and bare ```)', () => {
  assert.equal(extractSummaryText('```\nThe agent edited config.\n```'), 'The agent edited config.');
  assert.equal(extractSummaryText('```text\nDid a thing.\n```'), 'Did a thing.');
});

test('strips a single leading Summary: label (case-insensitive)', () => {
  assert.equal(extractSummaryText('Summary: agent fixed the bug.'), 'agent fixed the bug.');
  assert.equal(extractSummaryText('summary:   trimmed too'), 'trimmed too');
});

test('collapses 3+ newlines to one blank line', () => {
  assert.equal(extractSummaryText('line one\n\n\n\nline two'), 'line one\n\nline two');
});

test('empty / whitespace / non-string → null (never persist junk)', () => {
  assert.equal(extractSummaryText('   '), null);
  assert.equal(extractSummaryText(''), null);
  assert.equal(extractSummaryText('```\n\n```'), null);
  assert.equal(extractSummaryText(null), null);
  assert.equal(extractSummaryText(42), null);
  assert.equal(extractSummaryText(undefined), null);
});

test('hard-caps at 600 chars', () => {
  const out = extractSummaryText('x'.repeat(5000));
  assert.equal(out.length, 600);
});
