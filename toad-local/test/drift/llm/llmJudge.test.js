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
function fakeSpawn(stdout, { exitCode = 0, exitDelayMs = 5, stderr = '' } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.kill = () => proc.emit('exit', null, 'SIGKILL');
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', exitCode, null);
    }, exitDelayMs);
    return proc;
  };
}

/**
 * Recording fake spawn that captures the args + stdin writes so tests
 * can assert on transport details (which arg the resolved CLI was, what
 * went into stdin, what spawn options were used).
 */
function recordingSpawn(stdout, { exitCode = 0 } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const stdinChunks = [];
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = {
      write: (chunk) => { stdinChunks.push(String(chunk)); },
      end: () => {},
    };
    proc.kill = () => proc.emit('exit', null, 'SIGKILL');
    calls.push({ cmd, args, opts, stdinChunks });
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('exit', exitCode, null);
    }, 1);
    return proc;
  };
  return { fn, calls };
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

// ---------------------------------------------------------------------------
// F.2-style Windows hardening:
//   1. resolveCliImpl is consulted to find the real executable on Windows
//      (PATHEXT search for .cmd/.bat wrappers)
//   2. shell:true is set conditionally for .cmd/.bat resolutions
//   3. Prompt goes via stdin (not argv) to dodge cmd.exe's ~8KB cap and
//      shell:true argv re-splitting for claude + codex
//   4. stderr is captured and included in the failure error message so
//      judge_failed meta-findings are diagnosable instead of opaque
// ---------------------------------------------------------------------------

test('llmJudge resolves the CLI name via resolveCliImpl before spawning', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn: spawnFn, calls } = recordingSpawn(stdout);
  const resolveCalls = [];
  await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
    spawnImpl: spawnFn,
    resolveCliImpl: (name) => { resolveCalls.push(name); return '/fake/path/claude'; },
  });
  assert.deepEqual(resolveCalls, ['claude']);
  assert.equal(calls[0].cmd, '/fake/path/claude');
});

test('llmJudge writes the combined prompt to stdin for claude (not argv)', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn: spawnFn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 'SYS-PROMPT',
    userPayload: 'USER-PAYLOAD',
    timeoutMs: 5000,
    spawnImpl: spawnFn,
    resolveCliImpl: () => 'claude',
  });
  const combined = 'SYS-PROMPT\n\nUSER-PAYLOAD';
  assert.equal(calls[0].stdinChunks.join(''), combined);
  // The combined prompt must NOT appear as an argv positional anymore.
  assert.ok(
    !calls[0].args.includes(combined),
    `argv should not carry the prompt; got args=${JSON.stringify(calls[0].args)}`,
  );
});

test('llmJudge writes the combined prompt to stdin for codex with `-` sentinel', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn: spawnFn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'codex', model: 'gpt-5',
    systemPrompt: 'SYS', userPayload: 'USR', timeoutMs: 5000,
    spawnImpl: spawnFn,
    resolveCliImpl: () => 'codex',
  });
  assert.equal(calls[0].stdinChunks.join(''), 'SYS\n\nUSR');
  assert.ok(calls[0].args.includes('-'),
    `codex argv should carry the '-' stdin sentinel; got ${JSON.stringify(calls[0].args)}`);
});

test('llmJudge sets shell:true when needsShellImpl says so (.cmd wrapper)', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn: spawnFn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
    spawnImpl: spawnFn,
    resolveCliImpl: () => 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd',
    needsShellImpl: (resolved) => /\.(cmd|bat)$/i.test(resolved),
  });
  assert.equal(calls[0].opts?.shell, true);
});

test('llmJudge does NOT set shell:true for a plain .exe resolution', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn: spawnFn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
    spawnImpl: spawnFn,
    resolveCliImpl: () => 'C:\\Program Files\\Anthropic\\claude.exe',
    needsShellImpl: (resolved) => /\.(cmd|bat)$/i.test(resolved),
  });
  assert.notEqual(calls[0].opts?.shell, true);
});

test('llmJudge includes stderr in the spawn_failed error on non-zero exit', async () => {
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: fakeSpawn('', { exitCode: 2, stderr: 'auth required: log in via `claude login`' }),
    }),
    (err) => {
      assert.match(err.message, /spawn_failed/);
      assert.match(err.message, /auth required/);
      assert.match(err.message, /claude login/);
      return true;
    },
  );
});

test('llmJudge falls back to stdout in the spawn_failed error when stderr is empty (Claude writes errors to stdout)', async () => {
  // Regression for the 2026-05-14 drift LLM judge silent-failure bug:
  // Claude CLI writes "There's an issue with the selected model (X).
  // It may not exist…" to STDOUT (not stderr) before exiting 1. The
  // prior implementation only included stderr in the error, so the
  // drift meta-finding read "exit code 1" with no diagnosable detail.
  // Now stdout content surfaces as the error detail when stderr is
  // empty.
  const claudeStdoutOnError = "There's an issue with the selected model (haiku-4.5). It may not exist or you may not have access to it. Run --model to pick a different model.";
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku-4.5',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: fakeSpawn(claudeStdoutOnError, { exitCode: 1, stderr: '' }),
    }),
    (err) => {
      assert.match(err.message, /spawn_failed: exit code 1/);
      assert.match(err.message, /issue with the selected model/);
      assert.match(err.message, /haiku-4\.5/);
      return true;
    },
  );
});

test('llmJudge prefers stderr over stdout when both are populated on non-zero exit', async () => {
  // Belt-and-suspenders: if a future CLI version writes to BOTH
  // streams on error, stderr is the canonical channel and should win.
  // The stdout-fallback path only activates when stderr is empty.
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: () => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write() {}, end() {} };
        proc.kill = () => proc.emit('exit', null, 'SIGKILL');
        setTimeout(() => {
          proc.stdout.emit('data', Buffer.from('stdout banner that should NOT win'));
          proc.stderr.emit('data', Buffer.from('the real stderr error'));
          proc.emit('exit', 3, null);
        }, 1);
        return proc;
      },
    }),
    (err) => {
      assert.match(err.message, /the real stderr error/);
      assert.doesNotMatch(err.message, /stdout banner/);
      return true;
    },
  );
});

test('llmJudge truncates very long stdout-fallback error detail to keep finding rows readable', async () => {
  // A pathological CLI dump (e.g. a full python traceback on stdout)
  // shouldn't bloat the drift finding's `actual` column to 50KB. The
  // truncation cap keeps the surface readable while preserving enough
  // to diagnose.
  const giantStdoutDump = 'X'.repeat(2000);
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: fakeSpawn(giantStdoutDump, { exitCode: 1, stderr: '' }),
    }),
    (err) => {
      assert.match(err.message, /\(truncated\)/);
      assert.ok(err.message.length < 700, `error should be truncated but was ${err.message.length} chars`);
      return true;
    },
  );
});
