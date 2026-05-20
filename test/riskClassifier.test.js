import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, RISK_LEVEL_ORDER, classifyToolCall } from '../src/policy/riskClassifier.js';

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

// --- §14 follow-up: command rules ---

test('classify processes policy.commandRules against the commands argument', () => {
  const r = classify({
    commands: ['rm -rf /tmp/foo'],
    policy: {
      commandRules: [
        { pattern: 'rm -rf*', riskLevel: 'critical', requiresHumanApproval: true },
      ],
    },
  });
  assert.equal(r.riskLevel, 'critical');
  assert.equal(r.requiresHumanApproval, true);
  assert.equal(r.matchedRules.length, 1);
});

test('classify command pattern: prefix glob with trailing *', () => {
  const policy = { commandRules: [{ pattern: 'aws s3 *', riskLevel: 'high', requiresHumanApproval: true }] };
  assert.equal(classify({ commands: ['aws s3 cp foo.txt s3://bucket'], policy }).riskLevel, 'high');
  assert.equal(classify({ commands: ['ls'], policy }).riskLevel, null);
});

test('classify command pattern: substring fallback when no glob marker', () => {
  const policy = { commandRules: [{ pattern: 'curl', riskLevel: 'medium' }] };
  assert.equal(classify({ commands: ['curl https://example.com'], policy }).riskLevel, 'medium');
  // Substring inside a longer command also matches
  assert.equal(classify({ commands: ['echo hello | curl --data-binary @-'], policy }).riskLevel, 'medium');
  // Unrelated command doesn't match
  assert.equal(classify({ commands: ['ls'], policy }).riskLevel, null);
});

test('classify combines file and command matches into matchedRules', () => {
  const r = classify({
    files: ['.env.production'],
    commands: ['rm -rf node_modules'],
    policy: {
      rules: [{ pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true }],
      commandRules: [{ pattern: 'rm -rf*', riskLevel: 'high' }],
    },
  });
  assert.equal(r.riskLevel, 'critical'); // critical wins over high
  assert.equal(r.requiresHumanApproval, true);
  assert.equal(r.matchedRules.length, 2);
});

test('classify: no commandRules + commands provided is a noop', () => {
  const r = classify({
    commands: ['rm -rf everything'],
    policy: { rules: [] }, // no commandRules
  });
  assert.equal(r.riskLevel, null);
  assert.equal(r.matchedRules.length, 0);
});

test('classify: missing commands array is fine (back-compat for callers that only pass files)', () => {
  const r = classify({
    files: ['src/foo.js'],
    policy: {
      rules: [{ pattern: 'src/**', riskLevel: 'low' }],
      commandRules: [{ pattern: 'rm*', riskLevel: 'critical' }],
    },
  });
  assert.equal(r.riskLevel, 'low');
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

test('classifyToolCall: railway_provision_db → medium', () => {
  const v = classifyToolCall({ toolName: 'railway_provision_db' });
  assert.equal(v.riskLevel, 'medium');
});

test('classifyToolCall: railway_run_migration → high', () => {
  const v = classifyToolCall({ toolName: 'railway_run_migration' });
  assert.equal(v.riskLevel, 'high');
});

test('classifyToolCall: railway_link → low', () => {
  const v = classifyToolCall({ toolName: 'railway_link' });
  assert.equal(v.riskLevel, 'low');
});

test('classifyToolCall: unknown tool → null (defer to default)', () => {
  const v = classifyToolCall({ toolName: 'something_unknown' });
  assert.equal(v.riskLevel, null);
});
