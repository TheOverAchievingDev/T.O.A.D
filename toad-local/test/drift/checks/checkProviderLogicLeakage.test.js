import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderLogicLeakage } from '../../../src/drift/checks/checkProviderLogicLeakage.js';

function snap(diffs) {
  return {
    teamId: 'team-a', asOf: '2026-05-04T10:00:00Z',
    tasks: Object.keys(diffs).map((tid) => ({
      teamId: 'team-a', taskId: tid, status: 'in_progress',
      allowedFiles: [], forbiddenFiles: [],
    })),
    taskEvents: [], runtimeEvents: [],
    foundryDocs: {}, worktrees: [],
    diffsByTask: diffs,
  };
}

test('flags provider import inside src/team/**', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': {
        changedFiles: ['src/team/teamConfig.js'],
        fileContents: {
          'src/team/teamConfig.js': "import Anthropic from '@anthropic-ai/sdk';\nexport function x() {}\n",
        },
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'architecture');
  assert.equal(findings[0].severity, 'medium');
  assert.match(findings[0].actual, /@anthropic-ai/);
});

test('does NOT flag provider imports outside the protected paths', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': {
        changedFiles: ['src/providers/anthropicAdapter.js'],
        fileContents: {
          'src/providers/anthropicAdapter.js': "import Anthropic from '@anthropic-ai/sdk';",
        },
      },
    }),
  });
  assert.equal(findings.length, 0);
});

test('flags openai inside src/broker/**', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': {
        changedFiles: ['src/broker/inMemoryBroker.js'],
        fileContents: {
          'src/broker/inMemoryBroker.js': "import OpenAI from 'openai';",
        },
      },
    }),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].actual, /openai/);
});

test('skips files without contents (diff did not provide them)', () => {
  const findings = checkProviderLogicLeakage({
    snapshot: snap({
      'task-1': { changedFiles: ['src/team/teamConfig.js'] }, // no fileContents
    }),
  });
  assert.equal(findings.length, 0);
});
