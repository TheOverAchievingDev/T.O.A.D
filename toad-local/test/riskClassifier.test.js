import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, RISK_LEVEL_ORDER } from '../src/policy/riskClassifier.js';

test('RISK_LEVEL_ORDER is the canonical low→critical ordering', () => {
  assert.deepEqual(RISK_LEVEL_ORDER, ['low', 'medium', 'high', 'critical']);
});

test('classify returns baseline when no policy or no rules', () => {
  const r = classify({ files: ['src/foo.js'], policy: null });
  assert.equal(r.riskLevel, null);
  assert.equal(r.requiresHumanApproval, false);
  assert.deepEqual(r.matchedRules, []);

  const r2 = classify({ files: ['src/foo.js'], policy: { rules: [] } });
  assert.equal(r2.riskLevel, null);
  assert.deepEqual(r2.matchedRules, []);
});

test('classify preserves baseline riskLevel + requiresHumanApproval when no rule matches', () => {
  const r = classify({
    files: ['README.md'],
    policy: { rules: [{ pattern: 'src/secrets/**', riskLevel: 'critical' }] },
    currentRiskLevel: 'medium',
    currentRequiresHumanApproval: true,
  });
  assert.equal(r.riskLevel, 'medium');
  assert.equal(r.requiresHumanApproval, true);
  assert.deepEqual(r.matchedRules, []);
});

test('classify elevates riskLevel when a rule matches a file', () => {
  const r = classify({
    files: ['src/secrets/db.json'],
    policy: { rules: [{ pattern: 'src/secrets/**', riskLevel: 'critical' }] },
    currentRiskLevel: 'low',
  });
  assert.equal(r.riskLevel, 'critical');
  assert.equal(r.matchedRules.length, 1);
  assert.equal(r.matchedRules[0].pattern, 'src/secrets/**');
});

test('classify never DEMOTES — baseline higher than rule keeps baseline', () => {
  const r = classify({
    files: ['package.json'],
    policy: { rules: [{ pattern: 'package.json', riskLevel: 'medium' }] },
    currentRiskLevel: 'critical',
  });
  assert.equal(r.riskLevel, 'critical');
});

test('classify picks the HIGHEST level when multiple rules match', () => {
  const r = classify({
    files: ['src/migrations/0042_add_user_table.sql'],
    policy: {
      rules: [
        { pattern: 'src/**', riskLevel: 'low' },
        { pattern: 'src/migrations/**', riskLevel: 'high' },
        { pattern: '**/*.sql', riskLevel: 'medium' },
      ],
    },
  });
  assert.equal(r.riskLevel, 'high');
  assert.equal(r.matchedRules.length, 3);
});

test('classify flips requiresHumanApproval when ANY matching rule says so', () => {
  const r = classify({
    files: ['src/foo.js', '.env.production'],
    policy: {
      rules: [
        { pattern: 'src/**', riskLevel: 'low' },
        { pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true },
      ],
    },
    currentRequiresHumanApproval: false,
  });
  assert.equal(r.requiresHumanApproval, true);
  assert.equal(r.riskLevel, 'critical');
});

test('classify keeps requiresHumanApproval=true when baseline already set, even without rule match', () => {
  const r = classify({
    files: ['README.md'],
    policy: { rules: [{ pattern: 'src/secrets/**', requiresHumanApproval: true }] },
    currentRequiresHumanApproval: true,
  });
  assert.equal(r.requiresHumanApproval, true);
});

test('classify supports exact, **, and trailing-slash directory patterns', () => {
  const policy = {
    rules: [
      { pattern: 'package.json', riskLevel: 'medium' },           // exact
      { pattern: 'config/', riskLevel: 'high' },                  // dir prefix
      { pattern: 'src/secrets/**', riskLevel: 'critical' },       // recursive glob
    ],
  };
  assert.equal(classify({ files: ['package.json'], policy }).riskLevel, 'medium');
  assert.equal(classify({ files: ['config/db.yaml'], policy }).riskLevel, 'high');
  assert.equal(classify({ files: ['src/secrets/sub/key.pem'], policy }).riskLevel, 'critical');
  // Exact match doesn't flow into descendants
  assert.equal(classify({ files: ['package.json.bak'], policy }).riskLevel, null);
});

test('classify is robust to malformed rule entries (skipped, not crashing)', () => {
  const r = classify({
    files: ['src/foo.js'],
    policy: {
      rules: [
        null,
        {},
        { pattern: '' },
        { pattern: 'src/**', riskLevel: 'high' },
        { pattern: 'src/**', riskLevel: 'banana' }, // bogus level — skipped
      ],
    },
  });
  assert.equal(r.riskLevel, 'high');
  assert.equal(r.matchedRules.length, 1);
});
