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
  buildDemoScreenshotManifest,
  buildFakeRuntimeLaunch,
  buildTauriLaunchEnv,
  loadScenario,
  parseCliArgs,
  scenarioMembers,
  screenshotFileName,
} from './demoVideoTools.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SCENARIO = path.join(REPO_ROOT, 'demo', 'scenarios', 'family-meal-planner.json');
const API_BASE = 'http://127.0.0.1:3001';
const CDP_URL = 'http://127.0.0.1:9223';
const ACTOR = { teamId: 'family-meal-planner', agentId: 'screenshot-director', role: 'human' };

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const scenarioPath = path.resolve(stringArg(args.scenario, DEFAULT_SCENARIO));
  const scenario = await loadScenario(scenarioPath);
  const workspacePath = assertSafeDemoWorkspace(
    stringArg(args.workspace, scenario.workspace?.defaultRoot || 'C:\\SymphonyDemo\\family-meal-planner'),
  );
  const outDir = path.resolve(stringArg(
    args.out,
    path.join(REPO_ROOT, 'demo', 'screenshots', `${scenario.project.slug}-${timestampSlug()}`),
  ));
  const appPath = path.resolve(stringArg(args.app, resolveDefaultAppPath()));
  const keepOpen = args['keep-open'] === true;
  const keepActiveProject = args['keep-active-project'] === true;
  const fullPage = args['full-page'] === true;
  const only = typeof args.only === 'string'
    ? new Set(args.only.split(',').map((item) => item.trim()).filter(Boolean))
    : null;

  if (!existsSync(appPath)) {
    throw new Error(`Tauri app executable not found: ${appPath}. Build it with "cd ui && npm run tauri:build" or pass --app.`);
  }
  if (await isPortOpen('127.0.0.1', 3001)) {
    throw new Error('Port 3001 is already in use. Close Symphony AI before running the screenshot capture.');
  }

  await prepareWorkspace({ scenario, workspacePath });
  await mkdir(outDir, { recursive: true });

  const activeProject = getActiveProjectFile();
  const backupPath = `${activeProject}.demo-screenshots-backup`;
  await backupActiveProject(activeProject, backupPath);
  await mkdir(path.dirname(activeProject), { recursive: true });
  await writeFile(activeProject, workspacePath, 'utf8');

  const processes = [];
  let browser = null;

  const cleanup = async () => {
    if (!keepActiveProject) await restoreActiveProject(activeProject, backupPath);
    if (browser) await browser.close().catch(() => {});
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
    console.log(`Output directory: ${outDir}`);
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
    await seedSidecar({ scenario, scenarioPath, workspacePath });
    console.log('Demo data seeded.');

    browser = await connectToTauri();
    const page = await firstPage(browser);
    await primePage(page, { scenario, workspacePath });

    const captures = buildDemoScreenshotManifest()
      .filter((capture) => !only || only.has(capture.id) || only.has(capture.group));
    const results = [];

    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      const fileName = screenshotFileName(index, capture.id);
      const target = path.join(outDir, fileName);
      const result = await captureOne(page, {
        capture,
        target,
        fullPage,
      });
      results.push({
        ...result,
        file: fileName,
        path: target,
      });
      const marker = result.ok ? 'OK' : 'WARN';
      console.log(`${marker} ${fileName} - ${capture.title}`);
    }

    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      scenario: scenario.project,
      workspacePath,
      viewport: await page.viewportSize(),
      captures: results,
    }, null, 2), 'utf8');

    console.log(`Done. Screenshots written to ${outDir}`);
    if (results.some((item) => !item.ok)) {
      console.log('Some captures have warnings. See manifest.json for details.');
    }

    await stopDemoRuntimes(scenario);
  } finally {
    await cleanup();
  }
}

async function captureOne(page, { capture, target, fullPage }) {
  const warnings = [];
  await applyTweaks(page, capture.tweaks);
  await navigateToScreen(page, capture).catch((err) => {
    warnings.push(`screen navigation failed (${capture.screen}): ${err.message}`);
  });
  await waitForAny(page, capture.waitFor, 10_000).catch((err) => {
    warnings.push(`initial wait failed: ${err.message}`);
  });

  for (const action of capture.actions || []) {
    try {
      await runAction(page, action);
      await sleep(action.settleMs || 450);
    } catch (err) {
      const message = `action failed (${action.type}): ${err.message}`;
      // BR8/D: a REQUIRED action failing means the screenshot would capture
      // a broken UI state — fail loudly instead of silently degrading it to
      // a warning (the old code pushed a warning in BOTH branches). Optional
      // actions stay best-effort.
      if (action.optional) warnings.push(message);
      else throw new Error(message);
    }
  }

  if (capture.waitForAfterActions) {
    await waitForAny(page, capture.waitForAfterActions, 8_000).catch((err) => {
      warnings.push(`post-action wait failed: ${err.message}`);
    });
  }

  await page.bringToFront().catch(() => {});
  await sleep(700);
  await page.screenshot({
    path: target,
    fullPage,
    animations: 'disabled',
  });

  return {
    ok: warnings.length === 0,
    id: capture.id,
    title: capture.title,
    group: capture.group,
    description: capture.description,
    warnings,
  };
}

async function navigateToScreen(page, capture) {
  const screen = capture.screen;
  const nav = {
    cockpit: {
      selector: '.side-item:has-text("Cockpit")',
      waitFor: capture.tweaks?.developerMode === true
        ? '.cockpit-with, text=TERMINAL'
        : '.cockpit-for, text=Your team is working',
    },
    foundry: {
      selector: '.side-item:has-text("Foundry")',
      waitFor: '.foundry-screen',
    },
    code: {
      selector: '.side-item:has-text("Code")',
      waitFor: '.code-screen',
    },
    tasks: {
      selector: '.side-item:has-text("Tasks")',
      waitFor: 'main:has-text("Tasks"), .tasks-screen',
    },
    drift: {
      selector: '.side-item:has-text("Drift")',
      waitFor: 'text=Drift Monitor',
    },
    costs: {
      selector: '.side-item:has-text("Costs")',
      waitFor: 'text=Cost dashboard',
    },
    audit: {
      command: 'Go to Audit log',
      waitFor: 'text=Audit log',
    },
    settings: {
      selector: '.side-item:has-text("Settings")',
      waitFor: 'main.settings-screen',
    },
    picker: {
      selector: '.project-pill',
      waitFor: '.picker, text=Where shall we work today?',
    },
  }[screen];

  if (!nav) return;
  if (nav.command) {
    await runCommand(page, nav.command, nav.waitFor);
    return;
  }
  if (screen === 'cockpit') {
    await waitForAny(page, nav.waitFor, 10_000);
    return;
  }
  const locator = page.locator(nav.selector).first();
  await locator.waitFor({ state: 'visible', timeout: 8000 });
  await locator.click({ timeout: 8000 });
  await sleep(650);
  await waitForAny(page, nav.waitFor, 10_000);
}

async function runCommand(page, query, waitFor) {
  await page.keyboard.press('Control+K');
  await waitForAny(page, '.cmdk-backdrop, [role="dialog"]', 5000);
  await page.keyboard.type(query, { delay: 5 });
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(650);
  await waitForAny(page, waitFor, 10_000);
}

async function applyTweaks(page, tweaks) {
  await page.evaluate((nextTweaks) => {
    const tweakKey = 'toad.tweaks';
    const current = (() => {
      try { return JSON.parse(window.localStorage.getItem(tweakKey) || '{}'); }
      catch { return {}; }
    })();
    window.localStorage.setItem(tweakKey, JSON.stringify({
      ...current,
      ...nextTweaks,
      firstRunComplete: true,
    }));
  }, tweaks);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await sleep(700);
}

async function runAction(page, action) {
  if (action.type === 'keyboard') {
    await page.keyboard.press(action.key);
    return;
  }
  if (action.type === 'clickSelector') {
    const locator = page.locator(action.selector).first();
    await locator.waitFor({ state: 'visible', timeout: action.timeoutMs || 5000 });
    await locator.click({ timeout: action.timeoutMs || 5000 });
    return;
  }
  if (action.type === 'clickText') {
    const locator = page.getByText(action.text, { exact: action.exact === true }).first();
    await locator.waitFor({ state: 'visible', timeout: action.timeoutMs || 5000 });
    await locator.click({ timeout: action.timeoutMs || 5000 });
    return;
  }
  throw new Error(`unsupported action type: ${action.type}`);
}

async function waitForAny(page, selectorList, timeoutMs = 8000) {
  if (!selectorList) return;
  const selectors = String(selectorList)
    .split(',')
    .map((selector) => selector.trim())
    .filter(Boolean);
  if (selectors.length === 0) return;
  const errors = [];
  const deadline = Date.now() + timeoutMs;
  for (const selector of selectors) {
    const remaining = Math.max(500, deadline - Date.now());
    try {
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: remaining });
      return;
    } catch (err) {
      errors.push(`${selector}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function primePage(page, { scenario, workspacePath }) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.warn(`[ui] ${msg.text()}`);
  });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await page.evaluate(({ projectName, workspace }) => {
    window.localStorage.setItem('toad.projects', JSON.stringify({
      projects: [{
        id: 'demo-family-meal-planner',
        name: projectName,
        path: workspace,
        lastOpenedAt: new Date().toISOString(),
      }],
      activeId: 'demo-family-meal-planner',
    }));
    window.localStorage.setItem('toad.tweaks', JSON.stringify({
      theme: 'dark',
      density: 'comfy',
      layout: 'org',
      cardVariant: 'detail',
      screen: 'cockpit',
      agentInbox: '',
      showProviders: false,
      showNotifs: false,
      showApprovals: false,
      showRuntimes: false,
      showDiagnostics: false,
      showTweaks: false,
      showSidebar: true,
      showBottomPanel: true,
      showRightPanel: false,
      bottomPanelTab: 'terminal',
      rightPanelAgent: null,
      tasksGroupBy: 'status',
      tasksFilter: 'all',
      developerMode: false,
      firstRunComplete: true,
    }));
  }, { projectName: scenario.project.slug, workspace: workspacePath });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await waitForAny(page, 'text=Symphony, .titlebar', 30_000).catch(() => {});
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
      }, `demo-review-${task.taskId}`).catch(() => {});
    }
    if (task.validation) {
      await api('validation_run', {
        taskId: task.taskId,
        kind: task.validation.kind || 'test',
        command: task.validation.command,
        cwd: workspacePath,
      }, `demo-validation-${task.taskId}`).catch(() => {});
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

  await api('drift_run', { teamId, trigger: 'demo' }, `demo-drift-${teamId}`).catch(() => {});
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
      await apiCall({ actor: ACTOR, method: 'team_list', args: {} });
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
    throw new Error(`Playwright is required to capture Tauri screenshots: ${err.message}`);
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
  throw new Error(`Could not connect to Tauri WebView2 CDP at ${CDP_URL}: ${lastErr?.message || 'none'}`);
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

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function stringArg(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
