import * as pty from '@lydell/node-pty';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a bare command name to an absolute path on Windows by walking
 * PATH × PATHEXT (mirrors RuntimeSupervisor.resolveWindowsCommand).
 * node-pty's spawn doesn't apply PATHEXT the way Node's child_process
 * does, so a bare "claude" misses the .cmd shim and the spawn fails
 * silently inside the sidecar (where PATH is set differently than a
 * developer shell).
 */
function resolveCommandPath(command) {
  if (process.platform !== 'win32') return command;
  if (typeof command !== 'string' || command.length === 0) return command;
  if (command.includes('\\') || command.includes('/')) return command;
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
  const pathext = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.toLowerCase());
  for (const dir of dirs) {
    const cleanDir = dir.replace(/^"|"$/g, '');
    for (const ext of pathext) {
      const candidate = path.join(cleanDir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Probe claude's interactive `/usage` slash command via a pty session.
 *
 * Why a pty: claude's slash-command resolver only fires when stdout is a
 * TTY (we verified — `--print "/usage"` and stream-json + "/usage" both
 * treat the slash as plain text). Spawning under a pseudo-terminal makes
 * claude render its usage panel; we then scrape it.
 *
 * Returns a parsed plan-quota object or null when the probe couldn't get
 * a usable response (claude not installed, not signed in, prompt hang, etc).
 *
 * Output shape (best-effort — fields that didn't parse are omitted):
 *   {
 *     session: { pctUsed, resetIn, label }     // "5h limit"
 *     weekly:  { pctUsed, resetIn, label }     // "weekly limit"
 *     opusWeekly: { pctUsed, resetIn, label }  // optional, depends on plan
 *     raw: string                               // ansi-stripped panel text
 *     parsedAt: ISO timestamp
 *   }
 */

// Color/style codes — m terminator. Stripped to empty (purely visual).
const ANSI_STYLE_RE = /\x1b\[[0-9;]*m/g;
// All other CSI sequences (cursor movement, erase, etc.). Replace with
// a single space so words separated only by cursor jumps don't collapse
// into "Currentsession" or "23%used" — claude's TUI uses ridiculous
// amounts of cursor positioning instead of ASCII spaces between words.
const ANSI_OTHER_RE = /\x1b\[[0-9;?]*[ -/]*[@-l-~A-Z]/g;
// OSC sequences (window title etc.) — strip entirely.
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DEFAULT_TIMEOUT_MS = 25_000;
const PROMPT_SETTLE_MS = 4000;
// Claude's /usage panel does an async "Scanning local sessions..." step
// after the bars render, so we capture for ~10s to make sure we catch
// the final state. Sidecar-spawned claude renders noticeably slower than
// shell-spawned (probably pty init differences) so we err generous.
// Cached for 90s upstream so this only happens occasionally.
const POST_SLASH_CAPTURE_MS = 10000;

function stripAnsi(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_STYLE_RE, '')
    // Cursor moves, erase-line, erase-display, etc. → space so words separate.
    .replace(ANSI_OTHER_RE, ' ')
    // Collapse whitespace runs but preserve newlines.
    .replace(/[ \t\xa0]+/g, ' ');
}

/**
 * Parse claude's /usage panel. Real output (terminal-rendered) looks like:
 *
 *   Session
 *   Total cost: $0.0000
 *   ...
 *   Current session
 *   ████████████░░░░░  22% used
 *   Resets 12:50am (America/Denver)
 *
 *   Current week (all models)
 *   ████████████████████░  65% used
 *   Resets May 7, 3pm (America/Denver)
 *
 *   Current week (Sonnet only)
 *   ░░░░░░░░░░░░░░░░░░░░  0% used
 *
 *   Extra usage
 *   Unlimited
 *
 * The label lines and the `XX% used` lines are NOT always on the same
 * row — claude renders labels as headings with the bar/percent below.
 * So we identify candidate labels (lines that match known patterns)
 * and pair each with the next "% used" we see.
 *
 * We accept slight whitespace/Unicode variations because pty rendering
 * inserts non-breaking-spaces and weird padding.
 */
// LEGACY (kept exported but unused — kept to avoid breaking any
// hypothetical importer; SECTION_REGEXES below is the live path).
// eslint-disable-next-line no-unused-vars
const LEGACY_LABEL_PATTERNS = [
  // ordered: more specific before less specific so we match the right bucket
  { kind: 'opusWeekly', re: /current\s+week\s*\(.*?opus.*?\)/i, label: 'Weekly · Opus' },
  { kind: 'sonnetWeekly', re: /current\s+week\s*\(.*?sonnet.*?\)/i, label: 'Weekly · Sonnet' },
  { kind: 'weekly', re: /current\s+week(?!\s*\(.*?(opus|sonnet))/i, label: 'Weekly · all models' },
  { kind: 'session', re: /current\s+session/i, label: 'Session (5h)' },
  // Older / variant phrasings — keep as fallbacks.
  { kind: 'opusWeekly', re: /weekly.*opus/i, label: 'Weekly · Opus' },
  { kind: 'weekly', re: /weekly\s*limit/i, label: 'Weekly limit' },
  { kind: 'session', re: /\b5h\s*limit\b/i, label: '5h limit' },
];

// eslint-disable-next-line no-unused-vars
function legacyClassifyLabel(line) {
  for (const p of LEGACY_LABEL_PATTERNS) {
    if (p.re.test(line)) return { kind: p.kind, label: p.label };
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
function legacyFindPercent(line) {
  // Claude inserts pt-1-spaced glyphs ("22%[1Cused") in some renderings;
  // also handle "22% used" and "22 % used" variants.
  const m = line.match(/(\d{1,3})\s*%[\s \xa0]*used/i);
  if (!m) return null;
  return Math.min(100, Math.max(0, Number(m[1])));
}

// eslint-disable-next-line no-unused-vars
function legacyFindReset(line) {
  // Two formats observed:
  //   "Resets 12:50am (America/Denver)"
  //   "Resets May 7, 3pm (America/Denver)"
  // Capture from "Resets" to the closing paren or end-of-line.
  const m = line.match(/resets?\s+([^()]*?)(?:\s*\([^)]*\))?\s*$/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw || raw.length > 80) return null;
  return raw;
}

/**
 * Section header detector — used to split the inlined panel into
 * per-section chunks. Each match becomes a section "Current session" /
 * "Current week (all models)" / etc. with its own slice of text we
 * can parse for pct + reset.
 */
const SECTION_HEADER_RE = /(Current\s+session(?!\s*\()|Current\s+week\s*\([^)]+\)|Extra\s+usage|What's\s+contributing|Last\s+24h|Skills,)/gi;

function classifyHeader(header) {
  const h = header.toLowerCase();
  if (h.includes('current session')) return { kind: 'session', label: 'Session (5h)' };
  if (h.includes('current week')) {
    if (h.includes('opus')) return { kind: 'opusWeekly', label: 'Weekly · Opus' };
    if (h.includes('sonnet')) return { kind: 'sonnetWeekly', label: 'Weekly · Sonnet' };
    return { kind: 'weekly', label: 'Weekly · all models' };
  }
  return null;
}

function cleanResetString(s) {
  if (!s) return null;
  // Trim, collapse whitespace, drop trailing junk.
  let cleaned = s.replace(/\s+/g, ' ').trim();
  // Cap absurd lengths — mismatches sometimes capture whole paragraphs.
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 80);
  return cleaned || null;
}

function parseUsagePanel(rawText) {
  const text = stripAnsi(rawText)
    // Drop box-drawing / structural glyphs, replace with space.
    .replace(/[│┃┆╎├┤└┘┐┌─━┄┅━╭╮╯╰╲╱█▌▐▀▄░▒▓]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const out = { raw: text, parsedAt: new Date().toISOString() };

  // Split into sections by header. Each chunk runs from one header to
  // the next (or end of text). This isolates each percent + reset pair
  // to its own header instead of letting a lazy regex run across the
  // whole inlined panel and capture the wrong section's percent.
  SECTION_HEADER_RE.lastIndex = 0;
  const matches = [];
  let m;
  while ((m = SECTION_HEADER_RE.exec(text)) !== null) {
    matches.push({ header: m[0], start: m.index });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].start;
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const chunk = text.slice(start, end);
    const cls = classifyHeader(matches[i].header);
    if (!cls || out[cls.kind]) continue; // skip already-filled sections
    // First "NN% used" inside this chunk.
    const pctMatch = chunk.match(/(\d{1,3})\s*%\s*used/i);
    if (!pctMatch) continue;
    const pctUsed = Math.min(100, Math.max(0, Number(pctMatch[1])));
    if (!Number.isFinite(pctUsed)) continue;
    // Reset capture: take everything from "Resets " to end-of-chunk.
    // The chunk is already sliced to a single section, so we don't
    // need to defend against bleed-into the next header.
    const resetMatch = chunk.match(/Resets?\s+(.+?)$/i);
    const resetIn = cleanResetString(resetMatch ? resetMatch[1] : null);
    out[cls.kind] = { label: cls.label, pctUsed, resetIn };
  }
  return out;
}

/**
 * Run the probe. Resolves with the parsed object, or null on any failure.
 * Always cleans up the pty.
 *
 * @param {object} options
 * @param {string} [options.command='claude'] - Path to claude executable.
 * @param {number} [options.timeoutMs=12000]
 * @param {object} [options.ptyImpl] - Override pty for tests.
 */
export async function probeClaudeUsage({
  command = 'claude',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  promptSettleMs = PROMPT_SETTLE_MS,
  postSlashCaptureMs = POST_SLASH_CAPTURE_MS,
  ptyImpl,
} = {}) {
  const lib = ptyImpl || pty;
  let proc = null;
  let buffer = '';
  let timer = null;
  let resolvedCommand;
  try {
    resolvedCommand = resolveCommandPath(command);
    if (process.env.TOAD_USAGE_PROBE_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[usage-probe] resolved "${command}" → "${resolvedCommand}"`);
    }
    proc = lib.spawn(resolvedCommand, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[usage-probe] spawn failed: ${err?.message || err} (resolved=${resolvedCommand})`);
    return null;
  }

  const result = await new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      try { if (timer) clearTimeout(timer); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      resolve(value);
    };

    timer = setTimeout(() => finish(null), timeoutMs);

    proc.onData((chunk) => {
      buffer += chunk;
    });
    proc.onExit(() => {
      // claude exited (e.g. on /quit) — parse what we have and resolve.
      finish(parseUsagePanel(buffer));
    });

    // Wait for the prompt to settle, then type /usage.
    setTimeout(() => {
      try {
        proc.write('/usage\r');
      } catch {
        finish(null);
        return;
      }
      // Capture the rendered output, then exit cleanly.
      setTimeout(() => {
        const parsed = parseUsagePanel(buffer);
        try { proc.write('/quit\r'); } catch { /* ignore */ }
        // Give /quit a moment, then force-finish.
        setTimeout(() => finish(parsed), 400);
      }, postSlashCaptureMs);
    }, promptSettleMs);
  });

  // Don't return a successful-shaped object when nothing parsed — caller
  // can degrade to "unknown" cleanly.
  if (!result || (!result.session && !result.weekly && !result.opusWeekly)) {
    // eslint-disable-next-line no-console
    console.warn(`[usage-probe] no usable parse from claude (buffer ${buffer.length} chars)`);
    return null;
  }
  return result;
}
