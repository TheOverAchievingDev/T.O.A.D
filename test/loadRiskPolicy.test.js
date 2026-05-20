import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRiskPolicy } from '../src/policy/loadRiskPolicy.js';

function withTmpProject(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-risk-policy-'));
  try {
    testFn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadRiskPolicy returns null when projectCwd is missing', () => {
  assert.equal(loadRiskPolicy({ projectCwd: '' }), null);
  assert.equal(loadRiskPolicy({}), null);
  assert.equal(loadRiskPolicy(), null);
});

test('loadRiskPolicy returns null when .toad/risk-policy.json does not exist', () => {
  withTmpProject((dir) => {
    assert.equal(loadRiskPolicy({ projectCwd: dir }), null);
  });
});

test('loadRiskPolicy reads + parses a valid policy and returns { rules, path }', () => {
  withTmpProject((dir) => {
    mkdirSync(join(dir, '.toad'), { recursive: true });
    writeFileSync(join(dir, '.toad', 'risk-policy.json'), JSON.stringify({
      rules: [
        { pattern: 'src/secrets/**', riskLevel: 'critical', requiresHumanApproval: true },
        { pattern: 'package.json', riskLevel: 'medium' },
      ],
    }));
    const policy = loadRiskPolicy({ projectCwd: dir });
    assert.ok(policy);
    assert.equal(policy.rules.length, 2);
    assert.equal(policy.rules[0].pattern, 'src/secrets/**');
    assert.equal(policy.rules[0].riskLevel, 'critical');
    assert.equal(policy.path, join(dir, '.toad', 'risk-policy.json'));
  });
});

test('loadRiskPolicy returns null on malformed JSON (no throw)', () => {
  withTmpProject((dir) => {
    mkdirSync(join(dir, '.toad'), { recursive: true });
    writeFileSync(join(dir, '.toad', 'risk-policy.json'), '{ this is not json }');
    assert.equal(loadRiskPolicy({ projectCwd: dir }), null);
  });
});

test('loadRiskPolicy treats missing rules array as empty (active-but-no-rules)', () => {
  withTmpProject((dir) => {
    mkdirSync(join(dir, '.toad'), { recursive: true });
    writeFileSync(join(dir, '.toad', 'risk-policy.json'), JSON.stringify({}));
    const policy = loadRiskPolicy({ projectCwd: dir });
    assert.ok(policy);
    assert.deepEqual(policy.rules, []);
  });
});
