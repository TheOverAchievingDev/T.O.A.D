import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readIdeFile, resolveIdeSourceRoot } from '../ideFileTools.js';
import {
  runTool, summarizeToolResult, compareDiagnostics, resolveDiagnosticFileTarget,
} from '../diagnosticsToolRunner.js';
import { parseEslintJsonDiagnostics, parseTscDiagnostics } from './jsDiagnosticParsers.js';

const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.cts', '.mts'];
const DIAGNOSTICS_TIMEOUT_MS = 30_000;
const FILE_ACTION_TIMEOUT_MS = 15_000;
const PROJECT_FIX_TIMEOUT_MS = 60_000;

function localBin(rootPath, name) {
  const binDir = path.join(rootPath, 'node_modules', '.bin');
  const win = path.join(binDir, `${name}.cmd`);
  if (process.platform === 'win32' && existsSync(win)) return win;
  const unix = path.join(binDir, name);
  return existsSync(unix) ? unix : null;
}

function missingResult(tool) {
  return {
    tool, available: false, exitCode: null, timedOut: false, durationMs: 0,
    message: `${tool} is not installed in this project. Install the project's dev dependencies, then retry.`,
  };
}

export async function runJsDiagnostics({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, relativePath, scope = 'project', spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const fileScoped = scope === 'file' || Boolean(relativePath);
  const target = fileScoped
    ? resolveDiagnosticFileTarget(root.rootPath, relativePath, 'ide_diagnostics_run', JS_EXTS).commandTarget
    : '.';
  const [eslint, tsc] = await Promise.all([
    runEslint(root.rootPath, target, spawn),
    runTsc(root.rootPath, fileScoped ? target : null, spawn),
  ]);
  return {
    source: root.source,
    rootLabel: root.rootLabel,
    diagnostics: [...eslint.diagnostics, ...tsc.diagnostics].sort(compareDiagnostics),
    toolResults: [eslint.toolResult, tsc.toolResult],
    generatedAt: new Date().toISOString(),
  };
}

async function runEslint(rootPath, target, spawn) {
  const bin = localBin(rootPath, 'eslint');
  if (!bin) return { diagnostics: [], toolResult: missingResult('eslint') };
  const result = await runTool({
    tool: 'eslint', command: bin, args: ['--format', 'json', target], cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS, spawn, findingsExitCodes: new Set([0, 1]),
    isUnavailable: () => false,
  });
  return {
    diagnostics: result.available ? parseEslintJsonDiagnostics(result.stdout, { rootPath }) : [],
    toolResult: summarizeToolResult(result),
  };
}

async function runTsc(rootPath, fileTarget, spawn) {
  const bin = localBin(rootPath, 'tsc');
  if (!bin) return { diagnostics: [], toolResult: missingResult('tsc') };
  const hasTsconfig = existsSync(path.join(rootPath, 'tsconfig.json'));
  const args = ['--noEmit', '--pretty', 'false', ...(hasTsconfig ? ['-p', 'tsconfig.json'] : [])];
  const result = await runTool({
    tool: 'tsc', command: bin, args, cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS, spawn, findingsExitCodes: new Set([0, 1]),
    isUnavailable: () => false,
  });
  let diagnostics = result.available ? parseTscDiagnostics(result.stdout, { rootPath }) : [];
  if (fileTarget) diagnostics = diagnostics.filter((d) => d.path === fileTarget);
  return { diagnostics, toolResult: summarizeToolResult(result) };
}

export async function formatJsFile({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, relativePath, spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const target = resolveDiagnosticFileTarget(root.rootPath, relativePath, 'ide_format_file', JS_EXTS);
  const bin = localBin(root.rootPath, 'prettier');
  if (!bin) {
    return { changed: false, file: null, diagnostics: [], toolResults: [missingResult('prettier')], generatedAt: new Date().toISOString() };
  }
  const toolResult = await runTool({
    tool: 'prettier', command: bin, args: ['--write', target.commandTarget], cwd: root.rootPath,
    timeoutMs: FILE_ACTION_TIMEOUT_MS, spawn, findingsExitCodes: new Set([0]), isUnavailable: () => false,
  });
  if (!toolResult.available || !toolResult.ok) throw new Error(`ide_format_file: ${toolResult.message}`);
  const file = readIdeFile({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath });
  return { changed: true, file, diagnostics: [], toolResults: [summarizeToolResult(toolResult)], generatedAt: new Date().toISOString() };
}

async function eslintFix(rootPath, target, spawn, timeoutMs) {
  const bin = localBin(rootPath, 'eslint');
  if (!bin) throw new Error("ide_fix: eslint is not installed in this project. Install the project's dev dependencies, then retry.");
  const r = await runTool({
    tool: 'eslint', command: bin, args: ['--fix', target], cwd: rootPath,
    timeoutMs, spawn, findingsExitCodes: new Set([0, 1]),
    isUnavailable: () => false,
  });
  if (!r.available) throw new Error(`ide_fix: ${r.message}`);
  return summarizeToolResult(r);
}

export async function fixJsFile({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, relativePath, spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const target = resolveDiagnosticFileTarget(root.rootPath, relativePath, 'ide_fix_file', JS_EXTS);
  const toolResult = await eslintFix(root.rootPath, target.commandTarget, spawn, FILE_ACTION_TIMEOUT_MS);
  const diags = await runJsDiagnostics({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath, scope: 'file', spawn });
  const file = readIdeFile({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath });
  return { changed: true, file, diagnostics: diags.diagnostics, toolResults: [toolResult, ...diags.toolResults], generatedAt: new Date().toISOString() };
}

export async function fixJsProject({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const toolResult = await eslintFix(root.rootPath, '.', spawn, PROJECT_FIX_TIMEOUT_MS);
  const diags = await runJsDiagnostics({ projectCwd, taskBoard, teamId, source, scope: 'project', spawn });
  return { changed: true, diagnostics: diags.diagnostics, toolResults: [toolResult, ...diags.toolResults], generatedAt: new Date().toISOString() };
}
