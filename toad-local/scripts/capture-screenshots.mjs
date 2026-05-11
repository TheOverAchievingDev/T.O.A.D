#!/usr/bin/env node
/**
 * Symphony AI — automated screenshot capture
 *
 * Boots the sidecar API + Vite dev server, then drives a headless
 * Chromium through every major screen and saves PNGs to docs/screenshots/.
 *
 * Usage:
 *   npm run screenshots
 *
 * Requirements:
 *   - playwright (auto-checked at startup; the script bails with a helpful
 *     message if it's missing rather than failing deep inside an import).
 *   - The Vite UI must run in a regular browser (no Tauri-only APIs gating
 *     the screens we capture). The UI talks to the sidecar over HTTP so
 *     this works headlessly.
 *
 * Re-run as the UI evolves — the PNGs are committed to docs/screenshots/.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const UI_DIR = join(REPO_ROOT, 'ui');
const OUT_DIR = join(REPO_ROOT, 'docs', 'screenshots');

const VIEWPORT = { width: 1440, height: 900 };
// 2x device pixel ratio for retina-quality screenshots. Quadruples the
// pixel count of each PNG (file sizes ~4x) but produces crisp output
// on Retina/4K displays — required for marketing surfaces.
const DEVICE_SCALE_FACTOR = 2;
const SIDECAR_HOST = '127.0.0.1';
const SIDECAR_PORT = 3001;
// Vite binds to "localhost" by default. On Windows, IPv4 vs IPv6 resolution
// for `localhost` is system-dependent — using the literal hostname avoids
// the 127.0.0.1 vs ::1 mismatch that bites our probe.
const VITE_HOST = 'localhost';
const VITE_PORT = 5173;

const SIDECAR_HEALTH_URL = `http://${SIDECAR_HOST}:${SIDECAR_PORT}/api/teams`;
const VITE_URL = `http://${VITE_HOST}:${VITE_PORT}/`;

// Each entry is { name, navigate, waitFor }. `navigate` is a function that
// runs in the browser context to click the right sidebar item / open the
// right modal. `waitFor` is a CSS selector or function to wait for before
// the screenshot is taken.
const SCREENS = [
  // Sidebar nav buttons all set a `title` attribute matching their label
  // (see SidebarNav.tsx renderItem). title-attribute selectors are far more
  // reliable than :has-text() matching, which can miss when the visible
  // text is wrapped in spans.
  {
    name: 'workspace',
    description: 'Workspace overview (hero shot)',
    navigate: async (page) => {
      await page.click('button[title="Workspace"]').catch(() => {});
    },
    waitFor: '.titlebar',
  },
  {
    name: 'drift-screen',
    description: 'Drift Monitor dashboard',
    navigate: async (page) => {
      await page.click('button[title="Drift"]').catch(() => {});
    },
    waitFor: 'text=Drift Monitor',
  },
  {
    name: 'tasks',
    description: 'Tasks board with drift badges',
    navigate: async (page) => {
      await page.click('button[title="Tasks"]').catch(() => {});
    },
    waitFor: '.titlebar',
  },
  {
    name: 'foundry',
    description: 'Foundry kiro-style spec docs',
    navigate: async (page) => {
      await page.click('button[title="Foundry"]').catch(() => {});
    },
    waitFor: '.titlebar',
  },
  {
    name: 'settings-providers',
    description: 'Settings → Providers (plan-quota panel visible)',
    navigate: async (page) => {
      await page.click('button[title="Settings"]').catch(() => {});
      await sleep(400);
      await page.click('text=Providers').catch(() => {});
    },
    waitFor: '.titlebar',
  },
  {
    name: 'settings-foundry',
    description: 'Settings → Foundry (default-provider radio, F.2)',
    navigate: async (page) => {
      await page.click('button[title="Settings"]').catch(() => {});
      await sleep(400);
      // The Foundry section was added to the Settings sidebar in F.2's
      // Task 10 (commit 49abcf5). The label text in the sidebar is
      // "Foundry" alongside other section labels.
      await page.click('text=Foundry').catch(() => {});
    },
    waitFor: '.titlebar',
  },
  {
    name: 'create-team-modal',
    description: 'New-team modal (includes plan-usage panel)',
    navigate: async (page) => {
      await page.click('[title="New team"]').catch(() => {});
    },
    waitFor: '.modal',
  },
  {
    name: 'commands-palette',
    description: 'Command palette (Cmd+K / Ctrl+K)',
    navigate: async (page) => {
      await page.keyboard.press('Control+K');
    },
    waitFor: '.modal, [role="dialog"]',
  },
];

async function ensurePlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    console.error(`
ERROR: 'playwright' is not installed.

Install it as a dev dependency, then re-run:

  npm install --save-dev playwright
  npx playwright install chromium
  npm run screenshots

(Original error: ${err?.message ?? err})
`);
    process.exit(1);
  }
}

async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
}

/**
 * Resolve the bearer token the sidecar will accept. Mirrors
 * src/runtime/resolveApiToken.js's precedence so we authenticate the
 * same way the production sidecar will:
 *
 *   1. process.env.TOAD_API_TOKEN
 *   2. <projectCwd>/.toad/api-token (the persistent on-disk token)
 *   3. null  (sidecar runs unauthenticated)
 *
 * If we find a token, both seed calls and Playwright's page-level
 * fetches send it as Authorization: Bearer. If we don't, requests go
 * tokenless and the sidecar accepts everything.
 */
async function resolveSidecarToken() {
  const envToken = process.env.TOAD_API_TOKEN;
  if (typeof envToken === 'string' && envToken.trim().length > 0) {
    return envToken.trim();
  }
  // dev-api-server.mjs uses TOAD_PROJECT_CWD || process.cwd(). We're
  // launched from REPO_ROOT, so use the same default.
  const projectCwd = process.env.TOAD_PROJECT_CWD || REPO_ROOT;
  const tokenPath = join(projectCwd, '.toad', 'api-token');
  if (existsSync(tokenPath)) {
    try {
      const raw = (await readFile(tokenPath, 'utf8')).trim();
      if (raw.length > 0) return raw;
    } catch { /* ignore */ }
  }
  return null;
}

async function alreadyListening(host, port, timeoutMs = 1500) {
  // Quick TCP probe to see if a service is already bound. We don't want
  // to double-spawn if the user has the dev stack already running.
  return new Promise((resolveProbe) => {
    const sock = createConnection({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.end(); resolveProbe(true); });
    sock.once('error', () => { resolveProbe(false); });
    sock.once('timeout', () => { sock.destroy(); resolveProbe(false); });
  });
}

async function waitForUrl(url, timeoutMs = 30_000, label = url) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || res.status === 401 || res.status === 404) {
        // 401/404 is fine — server is up but the path may be auth-gated
        // or unmatched; we just need a TCP-listening process.
        return;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label} (${url}). Last error: ${lastErr?.message ?? '(none)'}`);
}

function spawnBackground(cmd, args, opts, label) {
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.silent ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ...opts.env },
  });
  proc.label = label;
  if (!opts.silent) {
    proc.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
    proc.stderr?.on('data', (chunk) => process.stderr.write(`[${label}!] ${chunk}`));
  }
  proc.on('exit', (code) => {
    if (code != null && code !== 0) {
      console.warn(`[${label}] exited with code ${code}`);
    }
  });
  return proc;
}

function killTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      // Windows: spawn a synchronous taskkill so child Vite/node processes
      // don't get orphaned when this script exits.
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2000).unref();
    }
  } catch {
    // best-effort
  }
}

/**
 * Push some demo data into the sidecar so screenshots show populated
 * dashboards instead of empty states. Idempotent — safe to re-run.
 *
 * Seeds: one team (`symphony-demo`), 5 tasks across the lifecycle, and
 * triggers a drift_run so the dashboard has findings + history.
 */
async function seedDemoData(token) {
  const TEAM_ID = 'symphony-demo';
  const ACTOR = { teamId: TEAM_ID, agentId: 'screenshot-bot', role: 'human' };
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const apiCall = async (method, args, idempotencyKey) => {
    const body = { actor: ACTOR, method, args };
    if (idempotencyKey) body.idempotencyKey = idempotencyKey;
    const res = await fetch(`http://${SIDECAR_HOST}:${SIDECAR_PORT}/api/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`  seed ${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return res.json();
  };

  // 1. Team — idempotent: team_create errors on dup, we ignore.
  await apiCall('team_create', {
    teamId: TEAM_ID,
    lead: { agentId: 'lead', providerId: 'anthropic', model: 'sonnet-4', cwd: '.' },
    teammates: [
      { agentId: 'dev-1', role: 'developer', providerId: 'anthropic', model: 'sonnet-4' },
      { agentId: 'reviewer-1', role: 'reviewer', providerId: 'openai', model: 'gpt-5' },
      { agentId: 'tester-1', role: 'tester', providerId: 'gemini', model: 'gemini-2.5-pro' },
    ],
  }, `seed-team-${TEAM_ID}`);

  // 2. Tasks across the lifecycle — gives the kanban actual cards.
  const tasks = [
    { id: 't_demo_1', subject: 'Wire OAuth Device Flow into Settings', status: 'in_progress', ownerId: 'dev-1' },
    { id: 't_demo_2', subject: 'Risk policy: forbid edits to .env files', status: 'review', ownerId: 'reviewer-1' },
    { id: 't_demo_3', subject: 'Add per-task drift score badge', status: 'testing', ownerId: 'tester-1' },
    { id: 't_demo_4', subject: 'Document the §-numbered hardening checklist', status: 'merge_ready', ownerId: 'dev-1' },
    { id: 't_demo_5', subject: 'Refactor RuntimeSupervisor for stuck-runtime detection', status: 'done', ownerId: 'dev-1' },
  ];
  for (const t of tasks) {
    await apiCall('task_create', {
      taskId: t.id, subject: t.subject, ownerId: t.ownerId,
      // Status is set in the create event — orchestrator accepts it.
      status: t.status,
    }, `seed-task-${t.id}`);
  }

  // 3. Trigger drift run so the dashboard has findings + a history row.
  await apiCall('drift_run', { teamId: TEAM_ID, trigger: 'manual' });
  // Run twice so the sparkline has at least 2 points.
  await sleep(200);
  await apiCall('drift_run', { teamId: TEAM_ID, trigger: 'periodic' });

  // 4. Foundry sessions — seed one Claude session and one Codex session
  // so the FoundryScreen sidebar shows the F.2 provider chip variety.
  // Idempotent via deterministic sessionId.
  await apiCall('foundry_session_create', {
    sessionId: 'fnd_demo_claude',
    title: 'Habit tracker (Claude)',
    provider: 'anthropic',
  }, 'seed-foundry-claude');
  await apiCall('foundry_session_create', {
    sessionId: 'fnd_demo_codex',
    title: 'Meal planner (Codex)',
    provider: 'openai',
  }, 'seed-foundry-codex');
}

async function captureScreens(playwright, { headed = false, token = null } = {}) {
  const browser = await playwright.chromium.launch({ headless: !headed });
  const contextOpts = {
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  };
  // If the sidecar has auth on (TOAD_API_TOKEN env or persisted
  // .toad/api-token), Playwright stamps the same Bearer header on every
  // fetch the page makes — so the UI's tokenless XHRs become
  // authenticated and stop 401-ing.
  if (token) {
    contextOpts.extraHTTPHeaders = { authorization: `Bearer ${token}` };
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Inject localStorage BEFORE the page loads so useProjects + useTweaks
  // see a configured project on first render. Without this, the welcome
  // screen takes over and we can't reach the populated views.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('toad.projects', JSON.stringify({
        projects: [{ id: 'p_demo', name: 'symphony-demo', path: 'C:/symphony-demo' }],
        activeId: 'p_demo',
      }));
      localStorage.setItem('toad.tweaks', JSON.stringify({
        screen: 'workspace',
        theme: 'dark',
        layout: 'kanban',
      }));
    } catch { /* ignore */ }
  });

  // Capture every kind of failure signal Playwright exposes.
  page.on('pageerror', (err) => console.warn('[ui] pageerror:', err.message));
  page.on('crash', () => console.warn('[ui] page CRASHED'));
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') console.warn(`[ui] console.${t}:`, msg.text());
  });
  page.on('requestfailed', (req) => {
    console.warn('[ui] request failed:', req.url(), '-', req.failure()?.errorText);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) console.warn(`[ui] HTTP ${res.status()} ${res.url()}`);
  });

  console.log(`Loading ${VITE_URL}...`);
  await page.goto(VITE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // domcontentloaded is enough to know HTML/JS reached the browser. After
  // that we wait for React to paint by polling the DOM. The titlebar is
  // the first thing the App component renders so it's a good "ready" mark.
  console.log('Waiting for React to paint (polling for .titlebar)...');
  await page.waitForSelector('.titlebar, .empty-state, [role="dialog"], .modal', {
    timeout: 15_000,
  }).catch(() => {
    console.warn('  (no anchor selector found within 15s — UI may not be rendering)');
  });

  // Sanity check: does the page have non-trivial content? If it's blank,
  // dump the HTML so we can debug instead of writing junk PNGs.
  const bodyText = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
  const bodyHtmlLength = await page.evaluate(() => document.body?.outerHTML?.length ?? 0).catch(() => 0);
  console.log(`Body innerText length: ${bodyText}, outerHTML length: ${bodyHtmlLength}`);
  if (bodyText < 20) {
    const html = await page.content();
    const dumpPath = join(OUT_DIR, '_blank-page-dump.html');
    await (await import('node:fs/promises')).writeFile(dumpPath, html, 'utf8');
    console.warn(`\n⚠️  Body has almost no text — UI is not rendering.`);
    console.warn(`   Dumped current HTML to ${dumpPath} for inspection.`);
    console.warn(`   Tip: re-run with HEADED=1 npm run screenshots to see the page live.`);
    console.warn(`   Bailing out before writing junk PNGs.\n`);
    await browser.close();
    return false;
  }

  await sleep(1500); // settle in animations / async state

  for (const screen of SCREENS) {
    const target = join(OUT_DIR, `${screen.name}.png`);
    try {
      console.log(`→ capturing: ${screen.name} (${screen.description})`);
      await screen.navigate(page);
      if (screen.waitFor) {
        await page.waitForSelector(screen.waitFor, { timeout: 5000 }).catch(() => {
          console.warn(`  (waitFor "${screen.waitFor}" timed out — capturing whatever is rendered)`);
        });
      }
      await sleep(600);
      await page.screenshot({ path: target, fullPage: false });
      console.log(`  saved → docs/screenshots/${screen.name}.png`);

      // Reset to a clean state between captures (close any modals).
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
    } catch (err) {
      console.warn(`  FAILED: ${screen.name} — ${err.message}`);
    }
  }

  await browser.close();
  return true;
}

async function main() {
  console.log('Symphony AI screenshot capture');
  console.log('==============================\n');

  await ensureOutDir();
  const playwright = await ensurePlaywright();
  const token = await resolveSidecarToken();
  if (token) {
    console.log(`Detected sidecar token (length=${token.length}) — stamping auth on all requests.`);
  } else {
    console.log('No sidecar token configured — running unauthenticated.');
  }

  let sidecar = null;
  let vite = null;

  const cleanup = () => {
    console.log('\nCleaning up...');
    killTree(vite);
    killTree(sidecar);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  try {
    if (await alreadyListening(SIDECAR_HOST, SIDECAR_PORT)) {
      console.log(`Sidecar already running on ${SIDECAR_HOST}:${SIDECAR_PORT} (using as-is — make sure auth matches the UI)`);
    } else {
      console.log('Booting sidecar API...');
      sidecar = spawnBackground('node', ['--no-warnings', 'scripts/dev-api-server.mjs'], {
        cwd: REPO_ROOT,
        silent: true,
        // Inherit env. The token (env OR persisted .toad/api-token file)
        // is resolved by resolveSidecarToken() and stamped onto both seed
        // calls and Playwright's request headers, so we don't need to
        // disable auth — both ends just speak the same token.
      }, 'sidecar');
      await waitForUrl(SIDECAR_HEALTH_URL, 30_000, 'sidecar API');
      console.log(`Sidecar API ready at http://${SIDECAR_HOST}:${SIDECAR_PORT}`);
    }

    if (await alreadyListening(VITE_HOST, VITE_PORT)) {
      console.log(`Vite already running on ${VITE_HOST}:${VITE_PORT}`);
    } else {
      console.log('Booting Vite UI dev server...');
      // NOT silent — Vite's first-run dependency optimization can take 30–
      // 60 seconds and we want the user to see progress. Vite prints
      // "Local: http://localhost:5173/" when ready.
      vite = spawnBackground('npm', ['run', 'dev'], {
        cwd: UI_DIR,
        silent: false,
      }, 'vite');
      // Vite first-run can spend a while pre-bundling deps, so we give it
      // a generous window. The waitForUrl probe re-tries every 500ms.
      await waitForUrl(VITE_URL, 120_000, 'Vite UI');
      console.log(`Vite UI ready at ${VITE_URL}`);
    }

    console.log('\nSeeding demo data (team + tasks + drift findings)...');
    await seedDemoData(token);
    console.log('Seed complete.');

    console.log('\nCapturing screens...\n');
    const headed = process.env.HEADED === '1';
    if (headed) console.log('(HEADED=1 — Chromium will open visibly)');
    const ok = await captureScreens(playwright, { headed, token });
    if (!ok) {
      console.error('\nCapture aborted because the UI did not render.');
      console.error('Inspect the HTML dump or re-run with HEADED=1.');
      process.exitCode = 1;
    } else {
      console.log(`\nDone. PNGs in ${OUT_DIR}`);
    }
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main();
