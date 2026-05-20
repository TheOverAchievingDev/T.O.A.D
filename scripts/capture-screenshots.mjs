#!/usr/bin/env node
/**
 * Capture the README screenshot set from the current app.
 *
 * This script intentionally builds its own isolated demo project and sidecar
 * database on each run. It does not reuse the older walkthrough script, and it
 * does not write to the operator's real Symphony project state.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SqliteRuntimeRegistry } from '../src/runtime/sqliteRuntimeRegistry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(REPO_ROOT, 'ui');
const OUT_DIR = join(REPO_ROOT, 'docs', 'screenshots');
const WORK_ROOT = join(REPO_ROOT, '.toad', 'screenshot-workspace');
const PROJECT_DIR = join(WORK_ROOT, 'readme-demo-project');
const DB_PATH = join(PROJECT_DIR, '.toad', 'toad.db');
const FOUNDRY_DB_PATH = join(PROJECT_DIR, '.toad', 'foundry.db');
const API_TOKEN = 'readme-screenshot-token';
const TEAM_ID = 'release-readiness';
const VIEWPORT = { width: 1440, height: 900 };

const CAPTURES = [
  { name: 'cockpit-for-me', label: 'Cockpit FORme overview' },
  { name: 'cockpit-with-me', label: 'Cockpit WITHme code editor' },
  { name: 'menu-file', label: 'File menu' },
  { name: 'menu-view', label: 'View menu' },
  { name: 'menu-run', label: 'Run menu' },
  { name: 'menu-terminal', label: 'Terminal menu' },
  { name: 'settings-general', label: 'Settings general' },
  { name: 'settings-providers', label: 'Settings providers' },
  { name: 'settings-github', label: 'Settings GitHub' },
];

const demoFiles = new Map([
  ['README.md', '# Symphony demo project\n\nA small workspace used for documentation screenshots.\n'],
  ['package.json', JSON.stringify({
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'node --test',
      build: 'vite build',
    },
    dependencies: {
      '@symphony/local': '0.1.4',
    },
  }, null, 2)],
  ['src/app.ts', [
    'export function bootWorkspace() {',
    "  return { mode: 'local-first', surface: 'WITHme' };",
    '}',
    '',
  ].join('\n')],
  ['src/editor/diff.ts', [
    'export function diffLabel(path: string, changed: boolean) {',
    "  return changed ? `${path} has local edits` : `${path} is clean`;",
    '}',
    '',
  ].join('\n')],
  ['src/team/orchestrator.ts', [
    'export const releaseTeam = [',
    "  'lead',",
    "  'builder',",
    "  'reviewer',",
    "  'qa',",
    '];',
    '',
  ].join('\n')],
  ['docs/foundry/product-brief.md', [
    '# Product brief',
    '',
    'Symphony coordinates local agent teams, keeps the human in control, and ships through GitHub releases.',
    '',
  ].join('\n')],
  ['docs/foundry/release-plan.md', [
    '# Release plan',
    '',
    '- Refresh README screenshots',
    '- Keep changelog entries tied to tags',
    '- Validate FORme and WITHme flows before publishing',
    '',
  ].join('\n')],
]);

async function main() {
  await prepareWorkspace();
  await seedProjectFiles();
  await initGitRepository();

  const apiPort = await findFreePort(4301);
  const uiPort = await findFreePort(5174);
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const uiUrl = `http://127.0.0.1:${uiPort}`;

  const processes = [];
  const api = spawnNode(join(REPO_ROOT, 'scripts', 'dev-api-server.mjs'), [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TOAD_PROJECT_CWD: PROJECT_DIR,
      TOAD_DB_PATH: DB_PATH,
      TOAD_FOUNDRY_DB_PATH: FOUNDRY_DB_PATH,
      SYMPHONY_FOUNDRY_DB_PATH: FOUNDRY_DB_PATH,
      TOAD_SETTINGS_PATH: join(PROJECT_DIR, '.toad', 'global-settings.json'),
      TOAD_API_PORT: String(apiPort),
      TOAD_API_TOKEN: API_TOKEN,
      TOAD_API_ALLOWED_ORIGINS: '*',
      TOAD_STUCK_MONITOR_INTERVAL_MS: '3600000',
      TOAD_STUCK_MONITOR_THRESHOLD_MS: '3600000',
      APPDATA: join(WORK_ROOT, 'appdata'),
      XDG_CONFIG_HOME: join(WORK_ROOT, 'xdg-config'),
      HOME: join(WORK_ROOT, 'home'),
      USERPROFILE: join(WORK_ROOT, 'home'),
    },
    name: 'api',
  });
  processes.push(api);

  const viteBin = join(UI_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {
    throw new Error('Vite is not installed under ui/node_modules. Run npm install first.');
  }
  const vite = spawnNode(viteBin, ['--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
    cwd: UI_DIR,
    env: {
      ...process.env,
      VITE_TOAD_API_BASE_URL: apiBaseUrl,
      VITE_TOAD_API_TOKEN: API_TOKEN,
    },
    name: 'vite',
  });
  processes.push(vite);

  const cleanup = async () => {
    for (const child of processes.reverse()) {
      await stopProcess(child);
    }
  };
  process.once('SIGINT', () => {
    cleanup().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    cleanup().finally(() => process.exit(143));
  });

  try {
    await waitForApi(apiBaseUrl);
    await seedApplicationData(apiBaseUrl);
    await waitForHttp(uiUrl);
    await captureScreenshots(uiUrl, apiBaseUrl);
    await writeGalleryReadme();
  } finally {
    await cleanup();
  }
}

async function prepareWorkspace() {
  await mkdir(OUT_DIR, { recursive: true });
  await safeRemoveInside(join(REPO_ROOT, '.toad'), WORK_ROOT);
  await mkdir(PROJECT_DIR, { recursive: true });
  await mkdir(join(PROJECT_DIR, '.toad'), { recursive: true });
}

async function seedProjectFiles() {
  for (const [file, content] of demoFiles) {
    const target = join(PROJECT_DIR, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function initGitRepository() {
  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.email', 'screenshots@symphony.local']);
  runGit(['config', 'user.name', 'Symphony Screenshots']);
  runGit(['add', '.']);
  runGit(['commit', '-m', 'Initial screenshot workspace']);
  await writeFile(
    join(PROJECT_DIR, 'src', 'app.ts'),
    [
      'export function bootWorkspace() {',
      "  return { mode: 'local-first', surface: 'FORme + WITHme', releaseReady: true };",
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

async function seedApplicationData(apiBaseUrl) {
  const actor = { teamId: TEAM_ID, agentId: 'operator', agentName: 'Operator', role: 'human' };
  const call = (method, args = {}, suffix = method) =>
    apiCall(apiBaseUrl, { actor, method, args, idempotencyKey: `screenshots:${suffix}` });

  await call('team_create', {
    teamId: TEAM_ID,
    lead: {
      agentId: 'lead',
      role: 'lead',
      providerId: 'anthropic',
      model: 'claude-sonnet-4.5',
      cwd: PROJECT_DIR,
    },
    teammates: [
      { agentId: 'builder', role: 'developer', providerId: 'openai', model: 'gpt-5.2-codex', cwd: PROJECT_DIR },
      { agentId: 'reviewer', role: 'reviewer', providerId: 'anthropic', model: 'claude-sonnet-4.5', cwd: PROJECT_DIR },
      { agentId: 'qa', role: 'tester', providerId: 'gemini', model: 'gemini-3-pro', cwd: PROJECT_DIR },
    ],
    validation: {
      typecheckCommand: 'node -e "console.log(\'typecheck passed\')"',
      testCommand: 'node -e "console.log(\'tests passed\')"',
      buildCommand: 'node -e "console.log(\'build passed\')"',
    },
  }, 'team');

  const tasks = [
    {
      taskId: 'T-101',
      subject: 'Refresh README release narrative',
      description: 'Update repository layout, screenshots, and release workflow documentation.',
      ownerId: 'lead',
      assignedRole: 'lead',
      status: 'in_progress',
      priority: 'high',
      riskLevel: 'low',
      allowedFiles: ['README.md', 'docs/**'],
      acceptanceCriteria: ['Root layout is accurate', 'Screenshots match current UI'],
    },
    {
      taskId: 'T-102',
      subject: 'Verify WITHme diff and terminal surfaces',
      description: 'Exercise code editor panels, terminal, and local diff handling in the cockpit.',
      ownerId: 'builder',
      assignedRole: 'developer',
      status: 'review',
      priority: 'high',
      riskLevel: 'medium',
      allowedFiles: ['ui/src/**', 'src/ide/**'],
      acceptanceCriteria: ['Diff opens without HEAD failures', 'Terminal connects from the cockpit'],
    },
    {
      taskId: 'T-103',
      subject: 'Run release validation pass',
      description: 'Confirm test, typecheck, and screenshot capture paths before publishing.',
      ownerId: 'qa',
      assignedRole: 'tester',
      status: 'pending',
      priority: 'medium',
      riskLevel: 'low',
      acceptanceCriteria: ['Validation history is recorded', 'Release notes link to changelog'],
    },
    {
      taskId: 'T-104',
      subject: 'Archive stale wrapper documentation',
      description: 'Remove references to the old toad-local wrapper layout from public docs.',
      ownerId: 'reviewer',
      assignedRole: 'reviewer',
      status: 'completed',
      priority: 'medium',
      riskLevel: 'low',
      acceptanceCriteria: ['No public docs point at toad-local as the repo root'],
    },
  ];

  for (const task of tasks) {
    await call('task_create', task, `task:${task.taskId}`);
  }

  await call('review_request', {
    taskId: 'T-102',
    reviewerId: 'reviewer',
    summary: 'Diff fallback and terminal wiring are ready for release review.',
    diff: 'M ui/src/components/cockpit/CockpitWithMe.tsx\nM src/ide/diffComputer.js',
    files: ['ui/src/components/cockpit/CockpitWithMe.tsx', 'src/ide/diffComputer.js'],
  }, 'review:T-102');

  await call('validation_run', {
    taskId: 'T-101',
    kind: 'typecheck',
    command: 'node -e "console.log(\'typecheck passed\')"',
    cwd: PROJECT_DIR,
  }, 'validation:T-101:typecheck');
  await call('validation_run', {
    taskId: 'T-103',
    kind: 'test',
    command: 'node -e "console.log(\'tests passed\')"',
    cwd: PROJECT_DIR,
  }, 'validation:T-103:test');

  await call('message_send', {
    to: { kind: 'agent', agentId: 'builder' },
    text: 'Open the WITHme cockpit and verify file tree, diff, and terminal controls against the release branch.',
    taskRefs: ['T-102'],
  }, 'message:builder');
  await call('message_send', {
    to: { kind: 'agent', agentId: 'qa' },
    text: 'Run the release validation checklist and keep failures visible in the bottom panel.',
    taskRefs: ['T-103'],
  }, 'message:qa');

  await call('foundry_session_create', {
    sessionId: 'foundry-release-readiness',
    title: 'Release readiness plan',
    projectPath: PROJECT_DIR,
    provider: 'anthropic',
    metadata: { source: 'readme-screenshots' },
  }, 'foundry:session');
  await call('foundry_message_add', {
    sessionId: 'foundry-release-readiness',
    role: 'user',
    text: 'Prepare Symphony for a GitHub release with accurate docs, screenshots, and changelog proof.',
  }, 'foundry:user');
  await call('foundry_message_add', {
    sessionId: 'foundry-release-readiness',
    role: 'assistant',
    text: 'Plan captured: verify the root layout, keep release notes in CHANGELOG.md, and refresh the FORme/WITHme screenshots from the current app.',
  }, 'foundry:assistant');
  await call('foundry_artifact_upsert', {
    artifactId: 'release-readiness-roadmap',
    sessionId: 'foundry-release-readiness',
    kind: 'roadmap',
    title: 'Release readiness roadmap',
    targetPath: 'docs/foundry/release-plan.md',
    status: 'draft',
    content: '# Release readiness roadmap\n\n1. Confirm the root project layout.\n2. Refresh screenshots from the current UI.\n3. Publish through GitHub tags and changelog entries.\n',
  }, 'foundry:artifact');

  const registry = new SqliteRuntimeRegistry({ filePath: DB_PATH });
  try {
    const now = Date.now();
    const rows = [
      ['lead', 'anthropic', 'claude', 'running', 'T-101', 7111, now - 1000 * 60 * 47],
      ['builder', 'openai', 'codex', 'running', 'T-102', 7112, now - 1000 * 60 * 39],
      ['reviewer', 'anthropic', 'claude', 'running', 'T-102', 7113, now - 1000 * 60 * 23],
      ['qa', 'gemini', 'gemini', 'running', 'T-103', 7114, now - 1000 * 60 * 12],
    ];
    for (const [agentId, providerId, command, status, taskId, pid, started] of rows) {
      registry.upsertRuntime({
        runtimeId: `rt-${agentId}`,
        teamId: TEAM_ID,
        agentId,
        providerId,
        command,
        deliveryMode: 'stdio',
        status,
        cwd: PROJECT_DIR,
        pid,
        taskId,
        startedAt: new Date(started).toISOString(),
      });
    }
  } finally {
    registry.close();
  }
}

async function captureScreenshots(uiUrl, apiBaseUrl) {
  const browser = await chromium.launch({
    headless: process.env.HEADED === '1' ? false : true,
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

  try {
    await page.addInitScript(({ projectDir, apiBaseUrl, token }) => {
      const now = new Date().toISOString();
      window.localStorage.setItem('toad.projects', JSON.stringify({
        activeId: 'readme-demo',
        projects: [{
          id: 'readme-demo',
          name: 'release-readiness',
          path: projectDir,
          apiBaseUrl,
          apiToken: token,
          lastOpenedAt: now,
        }],
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
        showRightPanel: true,
        bottomPanelTab: 'terminal',
        rightPanelAgent: 'builder',
        tasksGroupBy: 'status',
        tasksFilter: 'all',
        developerMode: false,
        firstRunComplete: true,
      }));
      window.localStorage.setItem('cockpit.forMe.viewMode', 'flow');
    }, { projectDir: PROJECT_DIR, apiBaseUrl, token: API_TOKEN });

    await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
    await waitForStableScreen(page, '.cockpit-for');
    await screenshot(page, 'cockpit-for-me');

    await page.getByRole('button', { name: 'WITH me' }).click();
    await waitForStableScreen(page, '.cockpit-with');
    await page.waitForTimeout(1200);
    await screenshot(page, 'cockpit-with-me');

    for (const menu of ['File', 'View', 'Run', 'Terminal']) {
      await openMenu(page, menu);
      await screenshot(page, `menu-${menu.toLowerCase()}`);
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.side-item[title="Settings"]').click();
    await waitForStableScreen(page, '.settings-screen');
    await screenshot(page, 'settings-general');
    await page.getByRole('button', { name: 'Providers' }).click();
    await page.waitForTimeout(350);
    await screenshot(page, 'settings-providers');
    await page.getByRole('button', { name: 'GitHub' }).click();
    await page.waitForTimeout(350);
    await screenshot(page, 'settings-github');
  } finally {
    await browser.close();
  }
}

async function openMenu(page, name) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('.menubar-item', { hasText: name }).click();
  await page.locator('.menu-pop').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(250);
}

async function screenshot(page, name) {
  const file = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`saved docs/screenshots/${name}.png`);
}

async function setTweaks(page, patch) {
  await page.evaluate((next) => {
    const raw = window.localStorage.getItem('toad.tweaks');
    const current = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem('toad.tweaks', JSON.stringify({ ...current, ...next }));
  }, patch);
}

async function waitForStableScreen(page, selector) {
  try {
    await page.locator(selector).waitFor({ state: 'visible', timeout: 30000 });
  } catch (err) {
    const body = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    throw new Error(`Timed out waiting for ${selector}. Body text starts with: ${body.slice(0, 600)}`);
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(750);
}

async function apiCall(apiBaseUrl, payload) {
  const response = await fetch(`${apiBaseUrl}/api/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${payload.method} failed (${response.status}): ${body.error || response.statusText}`);
  }
  return body.result;
}

async function waitForApi(apiBaseUrl) {
  const started = Date.now();
  const actor = { teamId: 'system', agentId: 'screenshots', role: 'human' };
  while (Date.now() - started < 30000) {
    try {
      await apiCall(apiBaseUrl, { actor, method: 'team_list', args: {} });
      return;
    } catch {
      await delay(300);
    }
  }
  throw new Error(`API did not become ready at ${apiBaseUrl}`);
}

async function waitForHttp(url) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await delay(300);
  }
  throw new Error(`HTTP server did not become ready at ${url}`);
}

function spawnNode(script, args, { cwd, env, name }) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal == null) {
      process.stderr.write(`[${name}] exited with code ${code}\n`);
    }
  });
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2500).then(() => false),
  ]);
  if (exited === false && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(1000),
    ]);
  }
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free port found starting at ${start}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function safeRemoveInside(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '' || rel.startsWith('..') || resolve(resolvedRoot, rel) !== resolvedTarget) {
    throw new Error(`Refusing to remove path outside ${resolvedRoot}: ${resolvedTarget}`);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

async function writeGalleryReadme() {
  const rows = CAPTURES
    .map((capture) => `- \`${capture.name}.png\` - ${capture.label}`)
    .join('\n');
  await writeFile(
    join(OUT_DIR, 'README.md'),
    [
      '# Screenshots',
      '',
      'These PNGs are captured from the live local Symphony UI by `scripts/capture-screenshots.mjs` and embedded in the root README and docs gallery.',
      '',
      '## Regenerate',
      '',
      '```bash',
      'npm run screenshots',
      '```',
      '',
      'The script creates an isolated demo workspace under `.toad/screenshot-workspace`, starts the API and Vite UI on temporary local ports, seeds a representative team, captures Chromium screenshots, and stops the servers on exit.',
      '',
      '## Current Set',
      '',
      rows,
      '',
      'The PNGs are committed so GitHub renders the docs without requiring a local capture run.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
