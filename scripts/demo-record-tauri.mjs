#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  assertSafeDemoWorkspace,
  buildFakeRuntimeLaunch,
  buildFfmpegRecorderArgs,
  buildTauriLaunchEnv,
  loadScenario,
  parseCliArgs,
  scenarioMembers,
} from './demoVideoTools.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SCENARIO = path.join(REPO_ROOT, 'demo', 'scenarios', 'family-meal-planner.json');
const API_BASE = 'http://127.0.0.1:3001';
const CDP_URL = 'http://127.0.0.1:9223';
const ACTOR = { teamId: 'family-meal-planner', agentId: 'demo-director', role: 'human' };

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const scenarioPath = path.resolve(stringArg(args.scenario, DEFAULT_SCENARIO));
  const scenario = await loadScenario(scenarioPath);
  const workspacePath = assertSafeDemoWorkspace(
    stringArg(args.workspace, scenario.workspace?.defaultRoot || 'C:\\SymphonyDemo\\family-meal-planner'),
  );
  const outputPath = path.resolve(stringArg(
    args.output,
    path.join(REPO_ROOT, 'demo', 'out', `${scenario.project.slug}.mp4`),
  ));
  const noRecord = args['no-record'] === true;
  const keepOpen = args['keep-open'] === true;
  const keepActiveProject = args['keep-active-project'] === true;
  const useExistingApi = args['use-existing-api'] === true;
  const appPath = path.resolve(stringArg(args.app, resolveDefaultAppPath()));

  if (!existsSync(appPath)) {
    throw new Error(`Tauri app executable not found: ${appPath}. Build it with "cd ui && npm run tauri:build" or pass --app.`);
  }

  if (!useExistingApi && await isPortOpen('127.0.0.1', 3001)) {
    throw new Error(
      'Port 3001 is already in use. Close Symphony AI first, or rerun with --use-existing-api if that sidecar already points at the demo workspace.',
    );
  }

  await prepareWorkspace({ scenario, workspacePath });
  const activeProject = getActiveProjectFile();
  const backupPath = `${activeProject}.demo-backup`;
  await backupActiveProject(activeProject, backupPath);
  await mkdir(path.dirname(activeProject), { recursive: true });
  await writeFile(activeProject, workspacePath, 'utf8');

  const processes = [];
  let browser = null;
  let recorder = null;

  const cleanup = async () => {
    if (!keepActiveProject) await restoreActiveProject(activeProject, backupPath);
    if (browser) await browser.close().catch(() => {});
    if (recorder) await stopRecorder(recorder).catch(() => {});
    if (!keepOpen) {
      for (const child of processes.reverse()) killTree(child);
    }
  };

  process.on('SIGINT', () => {
    cleanup().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    cleanup().finally(() => process.exit(143));
  });

  try {
    console.log(`Preparing demo workspace: ${workspacePath}`);
    console.log(`Launching Tauri app: ${appPath}`);
    const app = spawn(appPath, [], {
      cwd: path.dirname(appPath),
      detached: false,
      stdio: 'ignore',
      env: buildTauriLaunchEnv({ workspacePath }),
      windowsHide: false,
    });
    processes.push(app);

    await waitForApi();
    console.log('Sidecar API is ready.');

    await seedSidecar({ scenario, scenarioPath, workspacePath });
    console.log('Demo data seeded.');

    browser = await connectToTauri();
    const page = await firstPage(browser);
    await preparePage(page);

    if (!noRecord) {
      recorder = await startRecorder(outputPath, stringArg(args['record-title'], 'Symphony AI'));
      console.log(`Recording to ${outputPath}`);
    } else {
      console.log('Dry run mode: --no-record set, skipping ffmpeg capture.');
    }

    await runScenes(page, scenario);
    console.log('Demo scene pass complete.');

    if (!keepOpen) {
      await stopDemoRuntimes(scenario);
    }
  } finally {
    await cleanup();
  }
}

async function prepareWorkspace({ scenario, workspacePath }) {
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(workspacePath, { recursive: true });
  await mkdir(path.join(workspacePath, '.toad'), { recursive: true });
  await mkdir(path.join(workspacePath, 'src'), { recursive: true });

  for (const file of scenario.seedFiles || []) {
    const target = safeWorkspaceJoin(workspacePath, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content || '', 'utf8');
  }
}

async function seedSidecar({ scenario, scenarioPath, workspacePath }) {
  const teamId = scenario.team.teamId;
  const actor = { ...ACTOR, teamId };
  const api = (method, apiArgs, key = null) => apiCall({ actor, method, args: apiArgs, idempotencyKey: key });

  await api('foundry_session_create', {
    sessionId: scenario.foundry.sessionId,
    title: scenario.foundry.title,
    projectPath: workspacePath,
    metadata: { demo: true, idea: scenario.project.idea },
    provider: scenario.foundry.provider || 'anthropic',
  }, `demo-foundry-session-${scenario.foundry.sessionId}`);

  for (let index = 0; index < scenario.foundry.messages.length; index += 1) {
    const message = scenario.foundry.messages[index];
    await api('foundry_message_add', {
      sessionId: scenario.foundry.sessionId,
      messageId: `demo-foundry-message-${index + 1}`,
      role: message.role,
      text: message.text,
      metadata: { demo: true },
    }, `demo-foundry-message-${index + 1}`);
  }

  for (let index = 0; index < scenario.foundry.artifacts.length; index += 1) {
    const artifact = scenario.foundry.artifacts[index];
    await api('foundry_artifact_upsert', {
      artifactId: `${scenario.foundry.sessionId}-${artifact.kind}`,
      sessionId: scenario.foundry.sessionId,
      kind: artifact.kind,
      title: artifact.title,
      content: artifact.content,
      targetPath: artifact.targetPath,
      status: artifact.status || 'approved',
      metadata: { demo: true },
    }, `demo-foundry-artifact-${index + 1}`);
  }
  await api('foundry_artifact_export', {
    sessionId: scenario.foundry.sessionId,
    rootDir: workspacePath,
  }, `demo-foundry-export-${scenario.foundry.sessionId}`);

  const lead = scenario.team.lead;
  const teammates = scenario.team.members.filter((member) => member.agentId !== lead.agentId);
  await api('team_create', {
    teamId,
    lead: {
      agentId: lead.agentId,
      role: lead.role,
      providerId: lead.providerId,
      model: lead.model,
      cwd: workspacePath,
      prompt: `Use the Foundry docs in ${workspacePath}\\docs\\foundry to coordinate the demo build.`,
      skipPermissions: true,
    },
    teammates: teammates.map((member) => ({
      agentId: member.agentId,
      role: member.role,
      providerId: member.providerId,
      model: member.model,
      cwd: workspacePath,
      skipPermissions: true,
    })),
    validation: scenario.team.validation || null,
  }, `demo-team-${teamId}`);

  for (const task of scenario.tasks) {
    await api('task_create', {
      taskId: task.taskId,
      subject: task.subject,
      description: task.description,
      ownerId: task.ownerId,
      status: task.status,
      allowedFiles: task.allowedFiles,
      acceptanceCriteria: task.acceptanceCriteria,
    }, `demo-task-${task.taskId}`);
    if (task.reviewSummary || task.diff || task.files) {
      await api('review_request', {
        taskId: task.taskId,
        summary: task.reviewSummary || `Demo review for ${task.subject}`,
        diff: task.diff,
        files: task.files,
      }, `demo-review-${task.taskId}`).catch((err) => console.warn(`review_request failed for ${task.taskId}: ${err.message}`));
    }
    if (task.validation) {
      await api('validation_run', {
        taskId: task.taskId,
        kind: task.validation.kind || 'test',
        command: task.validation.command,
        cwd: workspacePath,
      }, `demo-validation-${task.taskId}`).catch((err) => console.warn(`validation_run failed for ${task.taskId}: ${err.message}`));
    }
    await api('task_comment', {
      taskId: task.taskId,
      text: `${task.ownerId || 'team'} is working from the Foundry spec for ${scenario.project.name}.`,
    }, `demo-comment-${task.taskId}`).catch(() => {});
  }

  for (const member of scenarioMembers(scenario)) {
    const launch = buildFakeRuntimeLaunch({
      repoRoot: REPO_ROOT,
      scenarioPath,
      workspacePath,
      teamId,
      member,
    });
    await api('agent_launch', launch, `demo-launch-${launch.runtimeId}`);
    await patchRuntimeProvider({
      dbPath: path.join(workspacePath, '.toad', 'toad.db'),
      runtimeId: launch.runtimeId,
      providerId: member.providerId,
    });
  }

  await api('drift_run', { teamId, trigger: 'demo' }, `demo-drift-${teamId}`).catch((err) => {
    console.warn(`drift_run skipped: ${err.message}`);
  });
}

async function apiCall({ actor, method, args, idempotencyKey = null }) {
  const body = { actor, method, args: args || {} };
  if (idempotencyKey) body.idempotencyKey = idempotencyKey;
  const res = await fetch(`${API_BASE}/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.result;
}

async function waitForApi(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await apiCall({
        actor: ACTOR,
        method: 'team_list',
        args: {},
      });
      return;
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for sidecar API at ${API_BASE}. Last error: ${lastErr?.message || 'none'}`);
}

async function connectToTauri(timeoutMs = 45_000) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (err) {
    throw new Error(`Playwright is required to drive the Tauri demo: ${err.message}`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await playwright.chromium.connectOverCDP(CDP_URL);
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  throw new Error(
    `Could not connect to Tauri WebView2 CDP at ${CDP_URL}. ` +
    `The app must be launched with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223. ` +
    `Last error: ${lastErr?.message || 'none'}`,
  );
}

async function firstPage(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => !candidate.url().startsWith('devtools://')) || pages[0];
    if (page) return page;
    await sleep(300);
  }
  throw new Error('Tauri WebView connected, but no page was exposed over CDP.');
}

async function preparePage(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.warn(`[ui] ${msg.text()}`);
  });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => {
    localStorage.setItem('toad.tweaks', JSON.stringify({
      screen: 'cockpit',
      theme: 'dark',
      layout: 'flow',
    }));
  }).catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForSelector('.titlebar, .empty-state, [role="dialog"], .modal', { timeout: 30_000 }).catch(() => {});
}

async function runScenes(page, scenario) {
  for (const scene of scenario.scenes || []) {
    console.log(`Scene: ${scene.name}`);
    await navigateTo(page, scene.navTitle || scene.name);
    await sleep(800);
    await moveMouseAcross(page);
    await sleep(Number(scene.durationMs) || 8000);
  }
}

async function navigateTo(page, title) {
  if (!title) return;
  const selectors = [
    `button[title="${cssEscape(title)}"]`,
    `[title="${cssEscape(title)}"]`,
  ];
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    if (await target.count().catch(() => 0)) {
      await target.click({ timeout: 3000 }).catch(() => {});
      return;
    }
  }
  await page.getByText(title, { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
}

async function moveMouseAcross(page) {
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(viewport.width * 0.28, viewport.height * 0.3, { steps: 12 }).catch(() => {});
  await page.mouse.move(viewport.width * 0.58, viewport.height * 0.48, { steps: 16 }).catch(() => {});
  await page.mouse.move(viewport.width * 0.82, viewport.height * 0.32, { steps: 14 }).catch(() => {});
}

async function startRecorder(outputPath, windowTitle) {
  if (!await commandExists('ffmpeg')) {
    throw new Error(
      'ffmpeg is not on PATH. Install ffmpeg to record MP4 output, or run this script with --no-record for a seeded dry run.',
    );
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = buildFfmpegRecorderArgs({ outputPath, windowTitle });
  const child = spawn('ffmpeg', args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr?.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line.includes('gdigrab') || line.includes('Output') || line.includes('error')) {
      console.warn(`[ffmpeg] ${line}`);
    }
  });
  await sleep(1500);
  if (child.exitCode != null) {
    throw new Error(`ffmpeg exited before recording could start (exit ${child.exitCode})`);
  }
  return child;
}

async function stopRecorder(child) {
  if (!child || child.killed) return;
  child.stdin?.write('q');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(4000).then(() => killTree(child)),
  ]);
}

async function stopDemoRuntimes(scenario) {
  const teamId = scenario.team.teamId;
  const actor = { ...ACTOR, teamId };
  for (const member of scenarioMembers(scenario)) {
    const runtimeId = `runtime-${teamId}-${member.agentId}`;
    await apiCall({
      actor,
      method: 'agent_stop',
      args: { runtimeId },
      idempotencyKey: `demo-stop-${runtimeId}`,
    }).catch(() => {});
  }
}

async function patchRuntimeProvider({ dbPath, runtimeId, providerId }) {
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE runtime_instances SET provider_id = ?, updated_at = ? WHERE runtime_id = ?')
      .run(providerId, new Date().toISOString(), runtimeId);
  } finally {
    db.close();
  }
}

async function backupActiveProject(activeProject, backupPath) {
  await rm(backupPath, { force: true }).catch(() => {});
  if (existsSync(activeProject)) {
    await mkdir(path.dirname(backupPath), { recursive: true });
    await copyFile(activeProject, backupPath);
  }
}

async function restoreActiveProject(activeProject, backupPath) {
  if (existsSync(backupPath)) {
    await mkdir(path.dirname(activeProject), { recursive: true });
    await copyFile(backupPath, activeProject);
    await rm(backupPath, { force: true }).catch(() => {});
  } else {
    await rm(activeProject, { force: true }).catch(() => {});
  }
}

function getActiveProjectFile() {
  if (process.platform === 'win32') {
    const root = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(root, 'ai.toad.desktop', 'active-project.txt');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ai.toad.desktop', 'active-project.txt');
  }
  return path.join(os.homedir(), '.config', 'ai.toad.desktop', 'active-project.txt');
}

function resolveDefaultAppPath() {
  const release = path.join(REPO_ROOT, 'ui', 'src-tauri', 'target', 'release', 'toad-desktop.exe');
  if (existsSync(release)) return release;
  const debug = path.join(REPO_ROOT, 'ui', 'src-tauri', 'target', 'debug', 'toad-desktop.exe');
  if (existsSync(debug)) return debug;
  return release;
}

function safeWorkspaceJoin(workspacePath, relativePath) {
  const target = path.resolve(workspacePath, relativePath);
  const root = path.resolve(workspacePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to write outside demo workspace: ${relativePath}`);
  }
  return target;
}

async function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 750 });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('exit', (code) => resolve(code === 0));
    child.once('error', () => resolve(false));
  });
}

function killTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    // best effort
  }
}

function stringArg(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
