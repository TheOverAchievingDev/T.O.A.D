import * as pty from '@lydell/node-pty';

const ANSI_STYLE_RE = /\x1b\[[0-9;]*m/g;
const ANSI_OTHER_RE = /\x1b\[[0-9;?]*[ -/]*[@-l-~A-Z]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_STYLE_RE, '')
    .replace(ANSI_OTHER_RE, ' ')
    .replace(/[ \t\xa0]+/g, ' ');
}

function parseUsagePanel(rawText) {
  const text = stripAnsi(rawText)
    .replace(/[│┃┆╎├┤└┘┐┌─━┄┅━╭╮╯╰╲╱█▌▐▀▄░▒▓]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const out = { raw: text, parsedAt: new Date().toISOString() };

  const contextMatch = text.match(/Context\s+window:\s*(\d{1,3})\s*%\s*left/i);
  if (contextMatch) {
    const left = Number(contextMatch[1]);
    out.context = { label: 'Context window', pctUsed: 100 - left, resetIn: `${left}% left` };
  }

  const sessionMatch = text.match(/5h\s+limit:.*?(\d{1,3})\s*%\s*left(?:\s*\(resets\s+([^)]+)\))?/i);
  if (sessionMatch) {
    const left = Number(sessionMatch[1]);
    const resets = sessionMatch[2] ? sessionMatch[2].trim() : '';
    out.session = { label: 'Session (5h)', pctUsed: 100 - left, resetIn: resets ? `${left}% left (resets ${resets})` : `${left}% left` };
  }

  const weeklyMatch = text.match(/Weekly\s+limit:.*?(\d{1,3})\s*%\s*left(?:\s*\(resets\s+([^)]+)\))?/i);
  if (weeklyMatch) {
    const left = Number(weeklyMatch[1]);
    const resets = weeklyMatch[2] ? weeklyMatch[2].trim() : '';
    out.weekly = { label: 'Weekly limit', pctUsed: 100 - left, resetIn: resets ? `${left}% left (resets ${resets})` : `${left}% left` };
  }

  // Fallback: If Codex just printed a top-level error/limit message
  if (!out.session && !out.weekly && !out.context) {
    const ltext = text.toLowerCase();
    if (ltext.includes('limit reached') || ltext.includes('100% used') || ltext.includes('0% left') || ltext.includes('out of usage')) {
      const resetMatch = text.match(/until\s+(.+?)(?:\.|$)/i) || text.match(/resets?\s+(.+?)(?:\.|$)/i);
      const resetIn = resetMatch ? resetMatch[1].trim() : null;
      out.session = { label: 'Usage limit reached', pctUsed: 100, resetIn };
    }
  }

  return out;
}

export async function probeCodexUsage() {
  const isWin = process.platform === 'win32';
  const spawnCmd = isWin ? 'powershell.exe' : 'codex';
  const spawnArgs = isWin ? ['-NoProfile', '-Command', 'codex'] : [];

  return new Promise((resolve) => {
    let buffer = '';
    let proc;
    try {
      proc = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols: 120, rows: 32,
        cwd: process.cwd(), env: process.env,
      });
    } catch { resolve(null); return; }

    let resolved = false;
    let intervalId;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      clearInterval(intervalId);
      proc.kill();
      resolve(null);
    }, 20000); // Max 20s

    proc.onData((data) => {
      buffer += data;
      if (buffer.includes('Weekly limit:') && buffer.includes('% left')) {
        const result = parseUsagePanel(buffer);
        if (result.session && result.weekly) {
          resolved = true;
          clearTimeout(timer);
          clearInterval(intervalId);
          proc.write('/quit\r\n');
          setTimeout(() => { proc.kill(); resolve(result); }, 1000);
        }
      }
    });

    setTimeout(() => {
      if (resolved) return;
      proc.write('/status\r\n');
      intervalId = setInterval(() => {
        if (resolved) return;
        proc.write('/status\r\n');
      }, 4000);
    }, 6000);
  });
}
