import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { COMMANDS } from '../src/commands/command-contract.js';
import { runPythonDiagnostics } from '../src/ide/python/pythonDiagnosticsRunner.js';

test('LocalToolFacade ide_diagnostics_run returns Ruff and Mypy diagnostics', async (t) => {
  const projectCwd = makeProject(t);
  const facade = makeFacade(projectCwd, {
    runPythonDiagnostics: async () => ({
      diagnostics: [
        {
          source: 'ruff',
          code: 'F401',
          severity: 'warning',
          message: 'unused import',
          path: 'src/app.py',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 10,
          fixable: true,
        },
      ],
      toolResults: [
        { tool: 'ruff', available: true, exitCode: 1, timedOut: false, durationMs: 10, message: '1 diagnostics' },
        { tool: 'mypy', available: true, exitCode: 0, timedOut: false, durationMs: 10, message: '0 diagnostics' },
      ],
      generatedAt: '2026-05-18T00:00:00.000Z',
    }),
  });

  const result = await facade.execute({
    commandName: COMMANDS.IDE_DIAGNOSTICS_RUN,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' }, scope: 'project' },
  });

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].source, 'ruff');
  assert.equal(result.toolResults[0].tool, 'ruff');
});

test('LocalToolFacade ide_format_file refreshes formatted Python file content', async (t) => {
  const projectCwd = makeProject(t);
  const filePath = path.join(projectCwd, 'src', 'app.py');
  const facade = makeFacade(projectCwd, {
    formatPythonFile: async ({ relativePath }) => {
      writeFileSync(path.join(projectCwd, relativePath), 'print("formatted")\n');
      return {
        changed: true,
        file: {
          kind: 'text',
          relativePath,
          content: readFileSync(filePath, 'utf8'),
          encoding: 'utf8',
        },
        diagnostics: [],
        toolResults: [{ tool: 'ruff', available: true, exitCode: 0, timedOut: false, durationMs: 5, message: '0 diagnostics' }],
      };
    },
  });

  const result = await facade.execute({
    commandName: COMMANDS.IDE_FORMAT_FILE,
    idempotencyKey: 'format-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' }, relativePath: 'src/app.py' },
  });

  assert.equal(result.file.content, 'print("formatted")\n');
});

test('LocalToolFacade ide_fix_file rejects unsupported paths through runner', async (t) => {
  const projectCwd = makeProject(t);
  const facade = makeFacade(projectCwd);

  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.IDE_FIX_FILE,
      idempotencyKey: 'fix-1',
      actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
      args: { source: { kind: 'project' }, relativePath: 'README.md' },
    }),
    /unsupported file type/,
  );
});

test('LocalToolFacade ide_diagnostics_run can surface unavailable tools without throwing', async (t) => {
  const projectCwd = makeProject(t);
  const facade = makeFacade(projectCwd, {
    runPythonDiagnostics: async () => ({
      diagnostics: [],
      toolResults: [
        { tool: 'ruff', available: false, exitCode: null, timedOut: false, durationMs: 3, message: 'ruff unavailable' },
      ],
      generatedAt: '2026-05-18T00:00:00.000Z',
    }),
  });

  const result = await facade.execute({
    commandName: COMMANDS.IDE_DIAGNOSTICS_RUN,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' } },
  });

  assert.equal(result.toolResults[0].available, false);
});

test('runPythonDiagnostics invokes Python module tools, not the Node executable', async (t) => {
  const projectCwd = makeProject(t);
  const calls = [];
  const result = await runPythonDiagnostics({
    projectCwd,
    taskBoard: new InMemoryTaskBoard(),
    teamId: 'team-a',
    source: { kind: 'project' },
    spawn: (command, args) => {
      calls.push({ command, args });
      return fakeChildProcess({
        stdout: args.includes('ruff')
          ? JSON.stringify([
              {
                filename: 'src/app.py',
                code: 'F401',
                message: 'unused import',
                location: { row: 1, column: 1 },
              },
            ])
          : '',
        exitCode: args.includes('ruff') ? 1 : 0,
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'python');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-m', 'ruff', 'check']);
  assert.equal(calls[1].command, 'python');
  assert.deepEqual(calls[1].args.slice(0, 2), ['-m', 'mypy']);
  assert.equal(result.diagnostics.length, 1);
});

function makeFacade(projectCwd, pythonIdeTools = null) {
  return new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    projectCwd,
    pythonIdeTools,
  });
}

function makeProject(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'toad-python-ide-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'app.py'), 'import os\n');
  writeFileSync(path.join(root, 'README.md'), '# Test\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeChildProcess({ stdout = '', stderr = '', exitCode = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
}
