import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_SENTINEL, buildProbeInstruction, evaluateFirstTurnProbe } from '../../src/runtime/firstTurnMcpProbe.js';

test('buildProbeInstruction names the grounded read-only TOAD tool and the exact sentinel', () => {
  const s = buildProbeInstruction();
  assert.equal(typeof s, 'string');
  assert.ok(s.includes(PROBE_SENTINEL), 'instruction must contain the sentinel token');
  assert.ok(/<TOOLNAME>/.test(s) === false, 'no placeholder');
  assert.ok(s.includes('agent_status'), 'instruction references the grounded tool name');
});

test('evaluateFirstTurnProbe satisfied iff an assistant_text contains the sentinel', () => {
  const base = { runtimeId: 'r', teamId: 't', agentId: 'a' };
  assert.equal(evaluateFirstTurnProbe([{ ...base, type: 'assistant_text', text: `hi ${PROBE_SENTINEL} done` }]).satisfied, true);
  assert.equal(evaluateFirstTurnProbe([{ ...base, type: 'assistant_text', text: 'no token here' }]).satisfied, false);
  assert.equal(evaluateFirstTurnProbe([{ ...base, type: 'tool_use', toolName: 'x' }]).satisfied, false);
  assert.equal(evaluateFirstTurnProbe([]).satisfied, false);
});

test('evaluateFirstTurnProbe is total — never throws on garbage', () => {
  for (const bad of [null, undefined, 42, 'x', [null], [{}], [{ type: 'assistant_text' }], { not: 'array' }]) {
    assert.doesNotThrow(() => evaluateFirstTurnProbe(bad));
    assert.equal(evaluateFirstTurnProbe(bad).satisfied, false);
  }
});

test('evaluateFirstTurnProbe only matches sentinel within a single event', () => {
  const base = { runtimeId: 'r', teamId: 't', agentId: 'a' };
  assert.equal(evaluateFirstTurnProbe([
    { ...base, type: 'assistant_text', text: 'part1 no token' },
    { ...base, type: 'assistant_text', text: 'part2 no token' },
  ]).satisfied, false);
  assert.equal(evaluateFirstTurnProbe([
    { ...base, type: 'assistant_text', text: 'no token' },
    { ...base, type: 'assistant_text', text: `has ${PROBE_SENTINEL}` },
  ]).satisfied, true);
});
