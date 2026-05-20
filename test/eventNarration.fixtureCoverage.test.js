import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fx = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eventNarration.events.json'), 'utf8'));

test('fixture covers every normalized event type + an mcp__ tool', () => {
  const types = new Set(fx.map((e) => e.type));
  for (const t of ['tool_use', 'assistant_text', 'turn_completed', 'turn_failed', 'compact_boundary', 'api_retry', 'approval_request', 'runtime_event']) {
    assert.ok(types.has(t), `fixture missing event type: ${t}`);
  }
  assert.ok(fx.some((e) => e.type === 'tool_use' && typeof e.toolName === 'string' && e.toolName.startsWith('mcp__')),
    'fixture missing an mcp__-prefixed tool_use');
});
