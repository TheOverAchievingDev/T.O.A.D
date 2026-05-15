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

test('llmJudge file-input mode composes a short stdin referencing the brief path (not the full inline payload)', async () => {
  // Regression: real-world drift runs hit "Prompt is too long" when
  // the user payload (recent runtime events + foundry docs) exceeded
  // the Claude CLI's stdin prompt limit (~20KB). The file-input mode
  // sidesteps this — only a short read instruction goes via stdin.
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  const longPayload = 'A'.repeat(100_000); // 100KB — would blow the CLI limit inline.
  await llmJudge({
    cli: 'claude',
    model: 'haiku',
    systemPrompt: 'system schema text',
    userPayload: longPayload,
    briefPath: 'C:\\Users\\op\\AppData\\Local\\Temp\\symphony-drift-abc\\brief.md',
    cwd: 'C:\\Users\\op\\AppData\\Local\\Temp\\symphony-drift-abc',
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude.exe',
    needsShellImpl: () => false,
  });
  const stdinText = calls[0].stdinChunks.join('');
  // The 100KB user payload must NOT appear inline anywhere.
  assert.ok(!stdinText.includes(longPayload), 'inline payload must not be sent via stdin in file mode');
  // The system prompt + the read instruction DO appear.
  assert.match(stdinText, /system schema text/);
  assert.match(stdinText, /Read it with your Read tool/);
  assert.match(stdinText, /brief\.md/);
  assert.ok(stdinText.length < 5000, `short instruction stdin should be small, got ${stdinText.length} chars`);
});

test('llmJudge file-input mode adds --dangerously-skip-permissions for claude (Read tool would hang in --print otherwise)', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    briefPath: '/tmp/x/brief.md', cwd: '/tmp/x',
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  assert.ok(
    calls[0].args.includes('--dangerously-skip-permissions'),
    'claude file-input mode must enable skip-permissions so Read auto-fires',
  );
});

test('llmJudge inline mode does NOT add --dangerously-skip-permissions (no Read tool needed)', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    // no briefPath → inline transport
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  assert.ok(
    !calls[0].args.includes('--dangerously-skip-permissions'),
    'inline mode should not need skip-permissions — payload is in stdin, no Read tool used',
  );
});

test('llmJudge file-input mode passes --setting-sources project,local to skip operator plugins (2026-05-15 prompt-cap fix)', async () => {
  // Real-world cause of the user-reported "Prompt is too long" loop:
  // the operator's ~/.claude/settings.json had 21 plugins enabled,
  // each contributing tool descriptions / skill prompts to every
  // claude --print request. The total pre-brief overhead was 50K+
  // tokens, blowing the prompt cap regardless of how tight we trimmed
  // Symphony's own brief. Solution: tell claude to skip the user
  // setting source. Project/local sources are empty (judge runs in
  // a tempdir), so this effectively isolates the judge from operator
  // plugins. Auth (~/.claude/.credentials.json) is unaffected.
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    briefPath: '/tmp/x/brief.md', cwd: '/tmp/x',
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  const args = calls[0].args;
  const sourceIdx = args.indexOf('--setting-sources');
  assert.ok(sourceIdx >= 0, 'claude judge spawn must include --setting-sources');
  assert.equal(args[sourceIdx + 1], 'project,local', 'judge must skip the user setting source (plugins live there)');
});

test('llmJudge file-input mode passes --tools "Read" to keep only the tool needed for the brief', async () => {
  // The judge writes findings to stdout; it never needs Edit/Write/
  // Bash/Grep/Glob/NotebookEdit. Each unused tool description still
  // costs tokens in the prompt — explicitly limiting to Read trims
  // ~10K+ tokens of dead weight per invocation.
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    briefPath: '/tmp/x/brief.md', cwd: '/tmp/x',
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  const args = calls[0].args;
  const toolsIdx = args.indexOf('--tools');
  assert.ok(toolsIdx >= 0, 'claude judge spawn must include --tools');
  assert.equal(args[toolsIdx + 1], 'Read', 'file-input judge keeps only Read tool');
});

test('llmJudge inline mode passes --tools "" to disable ALL tools (payload is already in stdin)', async () => {
  // Inline mode = the brief is in stdin, so the judge never needs to
  // read anything from disk. Disabling all tools strips even more
  // overhead than file mode's Read-only path.
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  const args = calls[0].args;
  const toolsIdx = args.indexOf('--tools');
  assert.ok(toolsIdx >= 0, 'inline judge spawn must include --tools');
  assert.equal(args[toolsIdx + 1], '', 'inline judge disables all tools (brief is in stdin)');
  // setting-sources isolation applies in inline mode too — plugin
  // overhead from the operator's user settings is unrelated to
  // transport mode.
  const sourceIdx = args.indexOf('--setting-sources');
  assert.ok(sourceIdx >= 0);
  assert.equal(args[sourceIdx + 1], 'project,local');
});

test('llmJudge passes cwd to spawn when supplied (bounds the file-input agent\'s filesystem reach)', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    briefPath: '/sym/drift-x/brief.md',
    cwd: '/sym/drift-x',
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  assert.equal(calls[0].opts.cwd, '/sym/drift-x');
});

test('llmJudge omits cwd from spawn options when not supplied (inherits parent cwd as before)', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  assert.equal(calls[0].opts.cwd, undefined);
});

test('llmJudge isolateHome overrides HOME + USERPROFILE in spawn env (2026-05-15 ~/.claude/agents/ isolation)', async () => {
  // The 2026-05-15 cascade: operators with rich Claude Code setups
  // have 100+ KB of agent prompts auto-discovered from
  // ~/.claude/agents/. --setting-sources doesn't gate that. Only way
  // to keep the judge from seeing them is to point claude at a fake
  // home with just credentials. Caller pre-populates the cwd dir with
  // .claude/.credentials.json; we set HOME/USERPROFILE to that dir.
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    briefPath: '/tmp/drift-x/brief.md',
    cwd: '/tmp/drift-x',
    isolateHome: true,
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  const env = calls[0].opts.env;
  assert.ok(env, 'spawn env must be provided when isolating home');
  assert.equal(env.HOME, '/tmp/drift-x');
  assert.equal(env.USERPROFILE, '/tmp/drift-x');
});

test('llmJudge isolateHome strips CLAUDE_* env vars except provider selection (BEDROCK/VERTEX preserved)', async () => {
  // CLAUDE_EFFORT=xhigh and similar env vars BYPASS settings.json
  // and re-introduce the operator's effort/thinking config even after
  // we redirect HOME. Strip every CLAUDE_* var except the two that
  // select third-party Anthropic providers (Bedrock/Vertex) — those
  // are auth-routing, not preference, and stripping them would break
  // operators on AWS/GCP-routed Claude.
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  // Inject operator-style env vars before the spawn.
  const originalEnv = { ...process.env };
  process.env.CLAUDE_EFFORT = 'xhigh';
  process.env.CLAUDE_CODE_DISABLE_CRON = '';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
  try {
    await llmJudge({
      cli: 'claude', model: 'haiku',
      systemPrompt: 's', userPayload: 'u',
      briefPath: '/tmp/drift-x/brief.md',
      cwd: '/tmp/drift-x',
      isolateHome: true,
      timeoutMs: 5000,
      spawnImpl: fn,
      resolveCliImpl: () => 'claude',
      needsShellImpl: () => false,
    });
  } finally {
    // Restore the test env.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
  const env = calls[0].opts.env;
  assert.equal(env.CLAUDE_EFFORT, undefined, 'CLAUDE_EFFORT must be stripped (bypass for effortLevel)');
  assert.equal(env.CLAUDE_CODE_DISABLE_CRON, undefined, 'generic CLAUDE_CODE_* vars stripped');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1', 'BEDROCK selector preserved');
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, '1', 'VERTEX selector preserved');
  // Non-CLAUDE auth vars survive too.
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fake');
});

test('llmJudge isolateHome is a no-op when cwd is not provided (safety check)', async () => {
  // Without cwd, overriding HOME would point claude at the SIDECAR's
  // cwd which doesn't have the pre-populated credentials — claude
  // would fail to auth. Refuse the override silently and let the
  // spawn inherit the real environment.
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    // no cwd
    isolateHome: true,
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  // env override only fires when cwd is set; without it, the spawn
  // inherits process.env as before (no opts.env override).
  assert.equal(calls[0].opts.env, undefined);
});

test('llmJudge does NOT override env when isolateHome is false (default behavior preserved)', async () => {
  const stdout = JSON.stringify({ findings: [] });
  const { fn, calls } = recordingSpawn(stdout);
  await llmJudge({
    cli: 'claude', model: 'haiku',
    systemPrompt: 's', userPayload: 'u',
    briefPath: '/tmp/drift-x/brief.md',
    cwd: '/tmp/drift-x',
    // isolateHome NOT set — defaults to false
    timeoutMs: 5000,
    spawnImpl: fn,
    resolveCliImpl: () => 'claude',
    needsShellImpl: () => false,
  });
  assert.equal(calls[0].opts.env, undefined, 'env should be inherited when not isolating');
});
