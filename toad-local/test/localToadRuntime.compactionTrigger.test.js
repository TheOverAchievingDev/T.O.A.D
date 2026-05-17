import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

test('LocalToadRuntime constructs a CompactionTrigger and passes it to the ingestor', () => {
  const rt = new LocalToadRuntime();
  assert.ok(rt.compactionTrigger, 'compactionTrigger present');
  assert.equal(typeof rt.compactionTrigger.onTurnCompleted, 'function');
  assert.equal(typeof rt.compactionTrigger.onCompactBoundary, 'function');
  // Wired into the ingestor (same instance).
  assert.equal(rt.eventIngestor?.compactionTrigger, rt.compactionTrigger);
});
