import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readIdeFile, resolveIdeSourceRoot } from '../ideFileTools.js';
import {
  parseMypyDiagnostics,
  parseRuffJsonDiagnostics,
} from './pythonDiagnosticParsers.js';
import {
  runTool,
  summarizeToolResult,
  compareDiagnostics,
  resolveDiagnosticFileTarget,
} from '../diagnosticsToolRunner.js';

const DIAGNOSTICS_TIMEOUT_MS = 30_000;
const FILE_ACTION_TIMEOUT_MS = 15_000;
const PROJECT_FIX_TIMEOUT_MS = 60_000;

export async function runPythonDiagnostics({
  projectCwd,
  taskBoard,
  teamId,
  source = { kind: 'project' },
  relativePath,
  scope = 'project',
  spawn = defaultSpawn,
} = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const target = resolveDiagnosticTarget(root.rootPath, { relativePath, scope });
  const generatedAt = new Date().toISOString();

  const [ruff, mypy] = await Promise.all([
    runRuffDiagnostics({ rootPath: root.rootPath, targetPath: target.commandTarget, spawn }),
    runMypyDiagnostics({ rootPath: root.rootPath, targetPath: target.mypyTarget, spawn }),
  ]);

  return {
    source: root.source,
    rootLabel: root.rootLabel,
    diagnostics: [...ruff.diagnostics, ...mypy.diagnostics].sort(compareDiagnostics),
    toolResults: [ruff.toolResult, mypy.toolResult],
    generatedAt,
  };
}

export async function formatPythonFile({
  projectCwd,
  taskBoard,
  teamId,
  source = { kind: 'project' },
  relativePath,
  spawn = defaultSpawn,
} = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const target = resolvePythonFileTarget(root.rootPath, relativePath, 'ide_format_file');
  const pythonCommand = resolvePythonCommand(root.rootPath);
  const tool = 'ruff';
  const toolResult = await runTool({
    tool,
    command: pythonCommand,
    args: ['-m', 'ruff', 'format', target.commandTarget],
    cwd: root.rootPath,
    timeoutMs: FILE_ACTION_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0]),
    isUnavailable: ({ stderr }) => isPythonModuleMissing(stderr, tool),
    buildMessage: ({ tool: t, available, ok, exitCode, stdout, stderr }) =>
      toolMessage({ tool: t, available, ok, exitCode, stdout, stderr }),
  });
  assertToolSucceeded(toolResult, 'ide_format_file');

  const file = readIdeFile({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath });
  return {
    changed: true,
    file,
    diagnostics: [],
    toolResults: [toolResult],
    generatedAt: new Date().toISOString(),
  };
}

export async function fixPythonFile({
  projectCwd,
  taskBoard,
  teamId,
  source = { kind: 'project' },
  relativePath,
  spawn = defaultSpawn,
} = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const target = resolvePythonFileTarget(root.rootPath, relativePath, 'ide_fix_file');
  const pythonCommand = resolvePythonCommand(root.rootPath);
  const tool = 'ruff';
  const toolResult = await runTool({
    tool,
    command: pythonCommand,
    args: ['-m', 'ruff', 'check', '--fix', target.commandTarget],
    cwd: root.rootPath,
    timeoutMs: FILE_ACTION_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
    isUnavailable: ({ stderr }) => isPythonModuleMissing(stderr, tool),
    buildMessage: ({ tool: t, available, ok, exitCode, stdout, stderr }) =>
      toolMessage({ tool: t, available, ok, exitCode, stdout, stderr }),
  });
  assertToolSucceeded(toolResult, 'ide_fix_file');

  const diagnostics = await runPythonDiagnostics({
    projectCwd,
    taskBoard,
    teamId,
    source,
    relativePath: target.relativePath,
    scope: 'file',
    spawn,
  });
  const file = readIdeFile({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath });
  return {
    changed: true,
    file,
    diagnostics: diagnostics.diagnostics,
    toolResults: [toolResult, ...diagnostics.toolResults],
    generatedAt: new Date().toISOString(),
  };
}

export async function fixPythonProject({
  projectCwd,
  taskBoard,
  teamId,
  source = { kind: 'project' },
  spawn = defaultSpawn,
} = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const pythonCommand = resolvePythonCommand(root.rootPath);
  const tool = 'ruff';
  const toolResult = await runTool({
    tool,
    command: pythonCommand,
    args: ['-m', 'ruff', 'check', '--fix', '.'],
    cwd: root.rootPath,
    timeoutMs: PROJECT_FIX_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
    isUnavailable: ({ stderr }) => isPythonModuleMissing(stderr, tool),
    buildMessage: ({ tool: t, available, ok, exitCode, stdout, stderr }) =>
      toolMessage({ tool: t, available, ok, exitCode, stdout, stderr }),
  });
  assertToolSucceeded(toolResult, 'ide_fix_project');

  const diagnostics = await runPythonDiagnostics({ projectCwd, taskBoard, teamId, source, spawn });
  return {
    changed: true,
    diagnostics: diagnostics.diagnostics,
    toolResults: [toolResult, ...diagnostics.toolResults],
    generatedAt: new Date().toISOString(),
  };
}

async function runRuffDiagnostics({ rootPath, targetPath, spawn }) {
  const pythonCommand = resolvePythonCommand(rootPath);
  const tool = 'ruff';
  const result = await runTool({
    tool,
    command: pythonCommand,
    args: ['-m', 'ruff', 'check', '--output-format', 'json', targetPath],
    cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
    isUnavailable: ({ stderr }) => isPythonModuleMissing(stderr, tool),
    buildMessage: ({ tool: t, available, ok, exitCode, stdout, stderr }) =>
      toolMessage({ tool: t, available, ok, exitCode, stdout, stderr }),
  });
  return {
    diagnostics: result.available ? parseRuffJsonDiagnostics(result.stdout, { rootPath }) : [],
    toolResult: summarizeToolResult(result),
  };
}

async function runMypyDiagnostics({ rootPath, targetPath, spawn }) {
  const pythonCommand = resolvePythonCommand(rootPath);
  const tool = 'mypy';
  const result = await runTool({
    tool,
    command: pythonCommand,
    args: ['-m', 'mypy', targetPath],
    cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
    isUnavailable: ({ stderr }) => isPythonModuleMissing(stderr, tool),
    buildMessage: ({ tool: t, available, ok, exitCode, stdout, stderr }) =>
      toolMessage({ tool: t, available, ok, exitCode, stdout, stderr }),
  });
  return {
    diagnostics: result.available ? parseMypyDiagnostics(result.stdout, { rootPath }) : [],
    toolResult: summarizeToolResult(result),
  };
}

function resolveDiagnosticTarget(rootPath, { relativePath, scope }) {
  if (scope === 'file' || relativePath) {
    const target = resolvePythonFileTarget(rootPath, relativePath, 'ide_diagnostics_run');
    return {
      commandTarget: target.commandTarget,
      mypyTarget: target.commandTarget,
    };
  }

  return {
    commandTarget: '.',
    mypyTarget: existsSync(path.join(rootPath, 'src')) ? 'src' : '.',
  };
}

function resolvePythonCommand(rootPath) {
  const windowsVenvPython = path.join(rootPath, '.venv', 'Scripts', 'python.exe');
  if (existsSync(windowsVenvPython)) {
    return windowsVenvPython;
  }
  const posixVenvPython = path.join(rootPath, '.venv', 'bin', 'python');
  if (existsSync(posixVenvPython)) {
    return posixVenvPython;
  }
  return 'python';
}

function resolvePythonFileTarget(rootPath, relativePath, commandName) {
  return resolveDiagnosticFileTarget(rootPath, relativePath, commandName, ['.py']);
}

function assertToolSucceeded(toolResult, commandName) {
  if (!toolResult.available) {
    throw new Error(`${commandName}: ${toolResult.message}`);
  }
  if (!toolResult.ok) {
    throw new Error(`${commandName}: ${toolResult.message}`);
  }
}

function toolMessage({ tool, available, ok, exitCode, stdout, stderr }) {
  if (!available) {
    return `${tool} unavailable`;
  }
  if (ok) {
    const count = tool === 'ruff'
      ? safeJsonCount(stdout)
      : parseMypyDiagnostics(stdout, { rootPath: process.cwd() }).length;
    return `${count} diagnostics`;
  }
  const detail = (stderr || stdout || '').trim().split(/\r?\n/).find(Boolean);
  return detail ? `${tool} exited ${exitCode}: ${detail}` : `${tool} exited ${exitCode}`;
}

function safeJsonCount(stdout) {
  try {
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function isPythonModuleMissing(stderr, tool) {
  return new RegExp(`No module named ['"]?${tool}['"]?`, 'i').test(stderr || '');
}
