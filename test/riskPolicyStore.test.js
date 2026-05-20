import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RiskPolicyStore } from '../src/policy/riskPolicyStore.js';

async function makeProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'toad-rpol-'));
}

test('RiskPolicyStore.read returns empty + exists=false when file missing', async () => {
  const projectCwd = await makeProject();
  const store = new RiskPolicyStore({ projectCwd });
  const out = await store.read();
  assert.deepEqual(out.rules, []);
  assert.deepEqual(out.commandRules, []);
  assert.equal(out.exists, false);
  assert.equal(out.malformed, false);
  assert.match(out.path, /\.toad[\\/]risk-policy\.json$/);
});

test('RiskPolicyStore.write persists a valid policy and read brings it back', async () => {
  const projectCwd = await makeProject();
  const store = new RiskPolicyStore({ projectCwd });
  await store.write({
    rules: [
      { pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true },
      { pattern: 'package.json', riskLevel: 'medium' },
    ],
    commandRules: [
      { pattern: 'rm -rf', riskLevel: 'high', requiresHumanApproval: true },
    ],
  });

  const out = await store.read();
  assert.equal(out.rules.length, 2);
  assert.equal(out.commandRules.length, 1);
  assert.equal(out.rules[0].pattern, '.env*');
  assert.equal(out.rules[0].requiresHumanApproval, true);
  assert.equal(out.commandRules[0].pattern, 'rm -rf');
});

test('RiskPolicyStore.write rejects rule with no riskLevel and no gate', async () => {
  const projectCwd = await makeProject();
  const store = new RiskPolicyStore({ projectCwd });
  await assert.rejects(
    () => store.write({ rules: [{ pattern: 'foo.ts' }] }),
    /must set at least riskLevel or requiresHumanApproval/,
  );
});

test('RiskPolicyStore.write rejects bad riskLevel', async () => {
  const projectCwd = await makeProject();
  const store = new RiskPolicyStore({ projectCwd });
  await assert.rejects(
    () => store.write({ rules: [{ pattern: 'foo.ts', riskLevel: 'critic' }] }),
    /riskLevel must be one of/,
  );
});

test('RiskPolicyStore.write rejects empty pattern', async () => {
  const projectCwd = await makeProject();
  const store = new RiskPolicyStore({ projectCwd });
  await assert.rejects(
    () => store.write({ rules: [{ pattern: '', riskLevel: 'low' }] }),
    /pattern must be a non-empty string/,
  );
});

test('RiskPolicyStore.read flags malformed JSON without throwing', async () => {
  const projectCwd = await makeProject();
  const store = new RiskPolicyStore({ projectCwd });
  await fs.mkdir(path.join(projectCwd, '.toad'), { recursive: true });
  await fs.writeFile(path.join(projectCwd, '.toad', 'risk-policy.json'), '{not json', 'utf8');
  const out = await store.read();
  assert.equal(out.exists, true);
  assert.equal(out.malformed, true);
  assert.deepEqual(out.rules, []);
});

test('RiskPolicyStore omits empty rule arrays from the on-disk JSON', async () => {
  const projectCwd = await makeProject();
  const store = new RiskPolicyStore({ projectCwd });
  await store.write({ rules: [{ pattern: 'a', riskLevel: 'low' }] });
  const raw = await fs.readFile(store.getPath(), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(Array.isArray(parsed.rules), true);
  assert.equal('commandRules' in parsed, false, 'empty commandRules should not be persisted');
});
