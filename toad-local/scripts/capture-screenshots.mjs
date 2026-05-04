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
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const UI_DIR = join(REPO_ROOT, 'ui');
const OUT_DIR = join(REPO_ROOT, 'docs', 'screenshots');

const VIEWPORT = { width: 1440, height: 900 };
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

async function captureScreens(playwright, { headed = false } = {}) {
  const browser = await playwright.chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

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
      console.log('Booting sidecar API (unauthenticated mode for screenshots)...');
      sidecar = spawnBackground('node', ['--no-warnings', 'scripts/dev-api-server.mjs'], {
        cwd: REPO_ROOT,
        silent: true,
        // Force unauthenticated mode so the UI's tokenless requests don't 401.
        // The user's shell may have TOAD_API_TOKEN exported globally; clearing
        // it for THIS spawn is the simplest way to avoid the token mismatch
        // between the sidecar (with token) and Vite (no VITE_TOAD_API_TOKEN).
        // Note: per src/transport/apiServer.js, if TOAD_API_TOKEN is empty,
        // ALL requests are accepted — fine for local screenshot capture but
        // do NOT use this script against a sidecar exposed beyond localhost.
        env: { TOAD_API_TOKEN: '' },
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

    console.log('\nCapturing screens...\n');
    const headed = process.env.HEADED === '1';
    if (headed) console.log('(HEADED=1 — Chromium will open visibly)');
    const ok = await captureScreens(playwright, { headed });
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
