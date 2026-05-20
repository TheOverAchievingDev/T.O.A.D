import test from 'node:test';
import assert from 'node:assert/strict';
import { L3_PROMPT_TEMPLATE, buildL3SystemPrompt } from '../../../../src/drift/llm/prompts/l3.js';

test('template is a stable non-empty constant string (hashed into the cache key)', () => {
  assert.equal(typeof L3_PROMPT_TEMPLATE, 'string');
  assert.ok(L3_PROMPT_TEMPLATE.length > 100);
});

test('prompt is a scoped adjudicator, not a whole-team scanner', () => {
  const p = buildL3SystemPrompt();
  assert.match(p, /adjudicat|is this (a )?genuine|verdict/i);
  assert.match(p, /"verdict"\s*:\s*"drift"\|"clean"|verdict.*drift.*clean/i);
  assert.match(p, /"confidence"\s*:\s*"high"\|"low"|confidence.*high.*low/i);
  assert.doesNotMatch(p, /scan the team|foundry docs|whole.*brief/i);
});
