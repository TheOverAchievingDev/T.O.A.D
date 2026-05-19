import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveIdeSourceRoot } from './ideFileTools.js';
import { compareDiagnostics } from './diagnosticsToolRunner.js';
import * as pythonRunner from './python/pythonDiagnosticsRunner.js';
import * as jsRunner from './js/jsDiagnosticsRunner.js';

const PY_EXTS = ['.py'];
const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.cts', '.mts'];

function languageForExt(relativePath) {
  const lower = String(relativePath || '').toLowerCase();
  if (PY_EXTS.some((e) => lower.endsWith(e))) return 'python';
  if (JS_EXTS.some((e) => lower.endsWith(e))) return 'jsts';
  return null;
}

function detectProjectLanguages(rootPath) {
  const langs = [];
  // Python: any of the standard project/marker files at root, OR a root *.py,
  // OR src/ directory containing at least one *.py (mirrors pythonDiagnosticsRunner
  // which targets src/ as the mypy root).
  const PY_ROOT_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'tox.ini'];
  let hasPy = PY_ROOT_MARKERS.some((f) => existsSync(path.join(rootPath, f)));
  if (!hasPy) {
    try { hasPy = readdirSync(rootPath).some((n) => n.toLowerCase().endsWith('.py')); } catch {}
  }
  if (!hasPy) {
    const srcDir = path.join(rootPath, 'src');
    try {
      hasPy = readdirSync(srcDir).some((n) => n.toLowerCase().endsWith('.py'));
    } catch {}
  }
  if (hasPy) langs.push('python');
  if (existsSync(path.join(rootPath, 'package.json'))) langs.push('jsts');
  return langs;
}

function pick(impls, lang) {
  if (lang === 'python') {
    return {
      diagnostics: impls?.python?.runPythonDiagnostics ?? pythonRunner.runPythonDiagnostics,
      format: impls?.python?.formatPythonFile ?? pythonRunner.formatPythonFile,
      fixFile: impls?.python?.fixPythonFile ?? pythonRunner.fixPythonFile,
      fixProject: impls?.python?.fixPythonProject ?? pythonRunner.fixPythonProject,
    };
  }
  return {
    diagnostics: impls?.js?.runJsDiagnostics ?? jsRunner.runJsDiagnostics,
    format: impls?.js?.formatJsFile ?? jsRunner.formatJsFile,
    fixFile: impls?.js?.fixJsFile ?? jsRunner.fixJsFile,
    fixProject: impls?.js?.fixJsProject ?? jsRunner.fixJsProject,
  };
}

function emptyResult() {
  return { diagnostics: [], toolResults: [], generatedAt: new Date().toISOString() };
}

export async function routeDiagnostics(params, impls) {
  const { relativePath, scope } = params;
  const fileScoped = scope === 'file' || Boolean(relativePath);
  if (fileScoped) {
    const lang = languageForExt(relativePath);
    if (!lang) return { ...emptyResult(), toolResults: [{ tool: 'router', available: true, exitCode: 0, timedOut: false, durationMs: 0, message: `no diagnostics provider for ${path.extname(String(relativePath || ''))}` }] };
    return pick(impls, lang).diagnostics(params);
  }
  const root = resolveIdeSourceRoot({ projectCwd: params.projectCwd, taskBoard: params.taskBoard, teamId: params.teamId, source: params.source });
  const langs = detectProjectLanguages(root.rootPath);
  if (langs.length === 0) return emptyResult();
  const results = await Promise.all(langs.map((l) => pick(impls, l).diagnostics(params)));
  return {
    source: results[0]?.source,
    rootLabel: results[0]?.rootLabel,
    diagnostics: results.flatMap((r) => r.diagnostics ?? []).sort(compareDiagnostics),
    toolResults: results.flatMap((r) => r.toolResults ?? []),
    generatedAt: new Date().toISOString(),
  };
}

export function routeFormatFile(params, impls) {
  const lang = languageForExt(params.relativePath);
  if (!lang) throw new Error('ide_format_file: unsupported file type');
  return pick(impls, lang).format(params);
}

export function routeFixFile(params, impls) {
  const lang = languageForExt(params.relativePath);
  if (!lang) throw new Error('ide_fix_file: unsupported file type');
  return pick(impls, lang).fixFile(params);
}

export async function routeFixProject(params, impls) {
  const root = resolveIdeSourceRoot({ projectCwd: params.projectCwd, taskBoard: params.taskBoard, teamId: params.teamId, source: params.source });
  const langs = detectProjectLanguages(root.rootPath);
  if (langs.length === 0) return { changed: false, ...emptyResult() };
  const results = await Promise.all(langs.map((l) => pick(impls, l).fixProject(params)));
  return {
    changed: results.some((r) => r.changed),
    diagnostics: results.flatMap((r) => r.diagnostics ?? []).sort(compareDiagnostics),
    toolResults: results.flatMap((r) => r.toolResults ?? []),
    generatedAt: new Date().toISOString(),
  };
}
