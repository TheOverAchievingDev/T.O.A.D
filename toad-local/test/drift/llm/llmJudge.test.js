import test from 'node:test';
import assert from 'node:assert/strict';
import { llmJudge } from '../../../src/drift/llm/llmJudge.js';
import { EventEmitter } from 'node:events';

/**
 * Build a fake spawn that emits a canned stdout string and exits 0.
 * The real spawn returns a ChildProcess with stdout/stderr streams +
 * an 'exit' event — we simulate just enough of that surface for the
 * judge to consume.
 */
function fakeSpawn(stdout, { exitCode = 0, exitDelayMs = 5 } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.kill = () => proc.emit('exit', null, 'SIGKILL');
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('exit', exitCode, null);
    }, exitDelayMs);
    return proc;
  };
}

test('llmJudge parses well-formed JSON response into findings', async () => {
  const stdout = JSON.stringify({
    findings: [
      {
        category: 'architecture',
        severity: 'medium',
        title: 'Plan diverges from steering',
        expected: 'Use Postgres per ADR-002',
        actual: 'Plan calls for SQLite',
        evidence: ['plan: "use SQLite for simplicity"', 'ADR-002 mandates Postgres'],
        recommendedCorrection: 'Update plan to use Postgres',
        taskId: 'task-1',
      },
    ],
  });

  const result = await llmJudge({
    cli: 'claude',
    model: 'haiku-4.5',
    systemPrompt: 'system',
    userPayload: 'user',
    timeoutMs: 5000,
    spawnImpl: fakeSpawn(stdout),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'architecture');
  assert.equal(result.findings[0].taskId, 'task-1');
  assert.equal(result.rawText, stdout);
});

test('llmJudge strips markdown code fences if model wraps JSON', async () => {
  const stdout = '```json\n' + JSON.stringify({ findings: [] }) + '\n```';
  const result = await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
    spawnImpl: fakeSpawn(stdout),
  });
  assert.deepEqual(result.findings, []);
});

test('llmJudge drops malformed findings, keeps valid ones', async () => {
  const stdout = JSON.stringify({
    findings: [
      // valid
      {
        category: 'risk', severity: 'low', title: 'OK',
        expected: 'e', actual: 'a', evidence: ['ev'],
        recommendedCorrection: 'r',
      },
      // malformed: invalid category
      {
        category: 'bogus', severity: 'low', title: 'Bad',
        expected: 'e', actual: 'a', evidence: [],
        recommendedCorrection: 'r',
      },
      // malformed: missing required field (title)
      {
        category: 'risk', severity: 'low',
        expected: 'e', actual: 'a', evidence: [],
        recommendedCorrection: 'r',
      },
    ],
  });
  const result = await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
    spawnImpl: fakeSpawn(stdout),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'OK');
});

test('llmJudge throws on completely unparseable response', async () => {
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku-4.5',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: fakeSpawn('not json at all'),
    }),
    /invalid_response/,
  );
});

test('llmJudge throws timeout when CLI never exits', async () => {
  // never-exiting fake
  const neverExits = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.kill = () => proc.emit('exit', null, 'SIGKILL');
    return proc;
  };
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku-4.5',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 100,
      spawnImpl: neverExits,
    }),
    /timeout/,
  );
});

test('llmJudge throws on non-zero exit', async () => {
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku-4.5',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: fakeSpawn('', { exitCode: 1 }),
    }),
    /spawn_failed/,
  );
});
