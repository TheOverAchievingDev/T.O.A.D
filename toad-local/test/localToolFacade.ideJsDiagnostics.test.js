import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { COMMANDS } from '../src/commands/command-contract.js';

function makeFacade(projectCwd, jsIdeTools, pythonIdeTools) {
  return new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard: new InMemoryTaskBoard(), projectCwd, jsIdeTools, pythonIdeTools });
}
function proj(markers) {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-facjs-'));
  if (markers.includes('js')) writeFileSync(path.join(dir, 'package.json'), '{}');
  if (markers.includes('py')) writeFileSync(path.join(dir, 'pyproject.toml'), '[tool]\n');
  return dir;
}

test('ide_diagnostics_run routes a JS project to the JS runner', async (t) => {
  const dir = proj(['js']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facade = makeFacade(dir, { runJsDiagnostics: async () => ({ diagnostics: [{ source: 'eslint', code: null, severity: 'error', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'eslint', available: true, exitCode: 1, timedOut: false, durationMs: 1, message: '1' }], generatedAt: 't' }) });
  const r = await facade.execute({ commandName: COMMANDS.IDE_DIAGNOSTICS_RUN, actor: { teamId: 'team-a', agentId: 'operator', role: 'human' }, args: { source: { kind: 'project' }, scope: 'project' } });
  assert.equal(r.diagnostics[0].source, 'eslint');
});

test('polyglot project scope returns both sources', async (t) => {
  const dir = proj(['js', 'py']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facade = makeFacade(dir,
    { runJsDiagnostics: async () => ({ diagnostics: [{ source: 'eslint', code: null, severity: 'error', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'eslint', available: true, exitCode: 1, timedOut: false, durationMs: 1, message: '1' }], generatedAt: 't' }) },
    { runPythonDiagnostics: async () => ({ diagnostics: [{ source: 'ruff', code: null, severity: 'warning', message: 'm', path: 'a.py', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'ruff', available: true, exitCode: 1, timedOut: false, durationMs: 1, message: '1' }], generatedAt: 't' }) });
  const r = await facade.execute({ commandName: COMMANDS.IDE_DIAGNOSTICS_RUN, actor: { teamId: 'team-a', agentId: 'operator', role: 'human' }, args: { source: { kind: 'project' }, scope: 'project' } });
  assert.deepEqual([...new Set(r.diagnostics.map((d) => d.source))].sort(), ['eslint', 'ruff']);
});
