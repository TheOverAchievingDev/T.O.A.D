import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { readIdeFile, resolveIdeSourceRoot } from '../ideFileTools.js';
import {
  parseMypyDiagnostics,
  parseRuffJsonDiagnostics,
} from './pythonDiagnosticParsers.js';

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
  const toolResult = await runTool({
    tool: 'ruff',
    command: pythonCommand,
    args: ['-m', 'ruff', 'format', target.commandTarget],
    cwd: root.rootPath,
    timeoutMs: FILE_ACTION_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0]),
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
  const toolResult = await runTool({
    tool: 'ruff',
    command: pythonCommand,
    args: ['-m', 'ruff', 'check', '--fix', target.commandTarget],
    cwd: root.rootPath,
    timeoutMs: FILE_ACTION_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
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
  const toolResult = await runTool({
    tool: 'ruff',
    command: pythonCommand,
    args: ['-m', 'ruff', 'check', '--fix', '.'],
    cwd: root.rootPath,
    timeoutMs: PROJECT_FIX_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
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
  const result = await runTool({
    tool: 'ruff',
    command: pythonCommand,
    args: ['-m', 'ruff', 'check', '--output-format', 'json', targetPath],
    cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
  });
  return {
    diagnostics: result.available ? parseRuffJsonDiagnostics(result.stdout, { rootPath }) : [],
    toolResult: summarizeToolResult(result),
  };
}

async function runMypyDiagnostics({ rootPath, targetPath, spawn }) {
  const pythonCommand = resolvePythonCommand(rootPath);
  const result = await runTool({
    tool: 'mypy',
    command: pythonCommand,
    args: ['-m', 'mypy', targetPath],
    cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
    spawn,
    findingsExitCodes: new Set([0, 1]),
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
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, absolutePath);
  if (isOutsideRoot(relativeToRoot)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  if (!relativeToRoot.toLowerCase().endsWith('.py')) {
    throw new Error(`${commandName}: unsupported file type`);
  }
  let stats;
  let realRootPath;
  let realTargetPath;
  try {
    stats = statSync(absolutePath);
    realRootPath = realpathSync(rootPath);
    realTargetPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`${commandName}: ${error?.message || 'filesystem error'}`);
  }
  const realRelativeToRoot = path.relative(realRootPath, realTargetPath);
  if (isOutsideRoot(realRelativeToRoot)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  if (!stats.isFile()) {
    throw new Error(`${commandName}: not a file`);
  }
  return {
    absolutePath: realTargetPath,
    relativePath: toPosixPath(relativeToRoot),
    commandTarget: toPosixPath(relativeToRoot),
  };
}

async function runTool({ tool, command, args, cwd, timeoutMs, spawn, findingsExitCodes }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        tool,
        command,
        args,
        cwd,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill?.('SIGTERM');
      } catch {}
      finish({
        available: true,
        exitCode: null,
        timedOut: true,
        ok: false,
        message: `${tool} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    } catch (error) {
      finish({
        available: false,
        exitCode: null,
        timedOut: false,
        ok: false,
        message: `${tool} unavailable: ${error?.message || 'spawn failed'}`,
      });
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({
        available: false,
        exitCode: null,
        timedOut,
        ok: false,
        message: `${tool} unavailable: ${error?.message || 'spawn failed'}`,
      });
    });
    child.on('close', (exitCode) => {
      const available = !isPythonModuleMissing(stderr, tool);
      const ok = available && findingsExitCodes.has(exitCode);
      finish({
        available,
        exitCode,
        timedOut,
        ok,
        message: toolMessage({ tool, available, ok, exitCode, stdout, stderr }),
      });
    });
  });
}

function assertToolSucceeded(toolResult, commandName) {
  if (!toolResult.available) {
    throw new Error(`${commandName}: ${toolResult.message}`);
  }
  if (!toolResult.ok) {
    throw new Error(`${commandName}: ${toolResult.message}`);
  }
}

function summarizeToolResult(result) {
  return {
    tool: result.tool,
    available: result.available,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    message: result.message,
  };
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

function compareDiagnostics(a, b) {
  return a.path.localeCompare(b.path)
    || a.line - b.line
    || a.column - b.column
    || a.source.localeCompare(b.source);
}

function isOutsideRoot(relativePath) {
  return relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}
