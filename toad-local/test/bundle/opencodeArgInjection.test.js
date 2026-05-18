/**
 * BR5 — Important A6 (bundle whole-impl review): OpencodeExecAdapter threads
 * operator/model-selection-influenced --model/--agent/--variant VALUES into a
 * spawn that uses shell:true on Windows .cmd/.bat resolution. The flag names
 * were whitelisted but the values were not validated → a value containing
 * shell metacharacters is a CVE-2024-27980-class argument-injection vector.
 * Fix: strict allowlist on the values; drop anything that isn't a plain
 * model/agent identifier before it can reach a shell:true spawn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';

function argsOf(rawArgs) {
  const a = new OpencodeExecAdapter({
    runtimeId: 'r', teamId: 't', agentId: 'a', cwd: '/w', systemPrompt: 'p',
    args: rawArgs,
    spawnImpl: () => { throw new Error('not spawned in this test'); },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
  });
  return a.args;
}

test('legitimate model/agent/variant identifiers pass through', () => {
  assert.deepEqual(argsOf(['--model', 'deepseek/deepseek-v4']), ['--model', 'deepseek/deepseek-v4']);
  assert.deepEqual(argsOf(['--agent', 'anthropic:claude-3.5-sonnet']), ['--agent', 'anthropic:claude-3.5-sonnet']);
  assert.deepEqual(argsOf(['--model=openai/gpt-4o']), ['--model=openai/gpt-4o']);
  assert.deepEqual(argsOf(['--thinking']), ['--thinking']);
});

test('shell-metacharacter values are dropped, not passed to a shell:true spawn', () => {
  // Separate-value form
  assert.deepEqual(
    argsOf(['--model', 'x" & calc.exe']), [],
    'a model value with shell metacharacters must be dropped',
  );
  assert.deepEqual(
    argsOf(['--agent', 'a; rm -rf /']), [],
    'an agent value with a command separator must be dropped',
  );
  // --flag=value form
  assert.deepEqual(
    argsOf(['--model=$(whoami)']), [],
    'a substitution in the =value form must be dropped',
  );
  assert.deepEqual(
    argsOf(['--variant', 'v|nc evil 1']), [],
    'a pipe in a variant value must be dropped',
  );
});

test('a dropped value does not strand its consumed successor', () => {
  // The malicious model value is dropped but a following safe flag survives.
  assert.deepEqual(argsOf(['--model', 'bad val', '--thinking']), ['--thinking']);
});
