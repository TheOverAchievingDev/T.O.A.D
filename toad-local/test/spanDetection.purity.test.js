import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSpans, SPAN_BOUNDARY_REASONS, DEFAULT_SPAN_CONFIG } from '../src/runtime/spanDetection/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'spanDetection');

test('spanDetection module imports no node:/fs/path/os/child_process/react, no JSX, never touches process', () => {
  for (const f of ['detectSpans.js', 'index.js']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports a node: builtin`);
    assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), `${f} imports a node core module`);
    assert.ok(!/from\s+['"]react/.test(src), `${f} imports react`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
    // JSX element syntax guard (the P2a-ratified form: tolerates JSDoc generics like Array<object>)
    assert.ok(!/(return|=>)\s*<[A-Za-z]/.test(src) && !/<\/[A-Za-z]/.test(src), `${f} contains JSX`);
  }
});

test('SPAN_BOUNDARY_REASONS is sealed (mutators throw; has/iteration work)', () => {
  assert.throws(() => SPAN_BOUNDARY_REASONS.add('x'), /sealed/);
  assert.throws(() => SPAN_BOUNDARY_REASONS.delete('system'), /sealed/);
  assert.throws(() => SPAN_BOUNDARY_REASONS.clear(), /sealed/);
  assert.ok(SPAN_BOUNDARY_REASONS.has('system'));
  assert.equal([...SPAN_BOUNDARY_REASONS].length, 5);
});

test('every boundary.reason detectSpans can emit is a member of SPAN_BOUNDARY_REASONS', () => {
  // Drive each reason and assert the emitted reason is in the sealed set.
  const r = (o) => ({ narrationId: o.n, runtimeId: o.rt ?? 'rt-1', teamId: 't', agentId: o.a ?? 'a1',
    sessionId: null, eventId: null, eventType: o.kind === 'system' ? 'turn_completed' : 'tool_use',
    createdAt: o.at ?? '2026-05-16T00:00:00.000Z', line: '', kind: o.kind ?? 'tool', tokens: o.tok ?? null });
  const reasons = new Set();
  for (const span of detectSpans([r({ n: '1' }), r({ n: '2', kind: 'system' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', a: 'a1' }), r({ n: '2', a: 'a2' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', rt: 'rt-1' }), r({ n: '2', rt: 'rt-2' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', at: '2026-05-16T00:00:00.000Z' }), r({ n: '2', at: '2026-05-16T01:00:00.000Z' })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const span of detectSpans([r({ n: '1', tok: 1e9 })])) if (span.boundary) reasons.add(span.boundary.reason);
  for (const reason of reasons) assert.ok(SPAN_BOUNDARY_REASONS.has(reason), `unknown reason: ${reason}`);
  assert.ok(reasons.has('size-cap') && reasons.has('system') && reasons.has('agent-change'));
});

test('DEFAULT_SPAN_CONFIG is frozen with the documented defaults', () => {
  assert.ok(Object.isFrozen(DEFAULT_SPAN_CONFIG));
  assert.deepEqual({ ...DEFAULT_SPAN_CONFIG }, { gapMs: 300000, maxRows: 40, maxTokens: 6000 });
});
