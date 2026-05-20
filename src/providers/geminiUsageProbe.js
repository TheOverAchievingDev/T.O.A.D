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

/**
 * Parse Gemini's model quota table.
 * It looks for patterns like:
 *   gemini-1.5-flash   32% used (Limit resets in 14:30)
 *   gemini-1.5-pro     10% used
 */
function parseGeminiDetailedQuotas(rawText) {
  const text = stripAnsi(rawText)
    .replace(/[│┃┆╎├┤└┘┐┌─━┄┅━╭╮╯╰╲╱█▌▐▀▄░▒▓]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const out = { raw: text, parsedAt: new Date().toISOString(), models: [] };

  // Improved regex to capture model name, percentage, and optional reset time
  // Example: "gemini-1.5-flash 32% used (Limit resets in 14:30)"
  const modelRegex = /([a-z0-9.-]+(?:-flash|-pro)(?:-preview)?)\s+(\d{1,3})%\s+used(?:\s+\(Limit\s+resets\s+in\s+([^)]+)\))?/gi;
  
  const matches = text.matchAll(modelRegex);
  for (const match of matches) {
    const modelId = match[1].trim();
    const pctUsed = Number(match[2]);
    const resetIn = match[3] ? match[3].trim() : null;
    
    // De-duplicate by modelId
    if (!out.models.find(m => m.label === modelId)) {
      out.models.push({
        label: modelId,
        pctUsed,
        resetIn: resetIn ? `${pctUsed}% Used (resets ${resetIn})` : `${pctUsed}% Used`,
      });
    }
  }

  // Fallback to the status bar if no detailed models found
  if (out.models.length === 0) {
    const statusBarRegex = /(Auto\s*\([^)]+\)|Gemini\s*\d+(?:\.\d+)?(?:\s*[^ ]+)?)\s+(\d{1,3})%\s+used/gi;
    const sbMatches = text.matchAll(statusBarRegex);
    for (const match of sbMatches) {
       const label = match[1].trim();
       const pctUsed = Number(match[2]);
       if (!out.models.find(m => m.label === label)) {
         out.models.push({
           label,
           pctUsed,
           resetIn: `${pctUsed}% Used`,
         });
       }
    }
  }

  if (out.models.length > 0) {
    out.session = out.models[0];
  }

  return out;
}

export async function probeGeminiUsage() {
  const isWin = process.platform === 'win32';
  const spawnCmd = isWin ? 'powershell.exe' : 'gemini';
  const spawnArgs = isWin ? ['-NoProfile', '-Command', 'gemini'] : [];

  return new Promise((resolve) => {
    let buffer = '';
    let proc;
    try {
      proc = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols: 150, rows: 40,
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
    }, 30000);

    proc.onData((data) => {
      buffer += data;
      // We look for the "used" string which is universal across all quota slots
      if (buffer.includes('% used')) {
        const result = parseGeminiDetailedQuotas(buffer);
        if (result.models.length > 0) {
          // If we found at least one model, we might want to wait a bit more
          // to see if others appear, but usually they come together.
          resolved = true;
          clearTimeout(timer);
          clearInterval(intervalId);
          proc.write('/quit\r\n');
          setTimeout(() => { proc.kill(); resolve(result); }, 1500);
        }
      }
    });

    // Boot and send /model to trigger the detailed breakdown
    setTimeout(() => {
      if (resolved) return;
      proc.write('/model\r\n');
      intervalId = setInterval(() => {
        if (resolved) return;
        proc.write('/model\r\n');
      }, 8000);
    }, 10000);
  });
}
