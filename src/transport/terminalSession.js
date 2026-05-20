/**
 * TerminalSession — spawns a shell via node-pty and bridges
 * WebSocket ↔ PTY stdin/stdout. One instance per open terminal tab.
 *
 * Architecture:
 *   Browser xterm.js ↔ WebSocket ↔ TerminalSession ↔ node-pty ↔ OS shell
 *
 * This is the backend half of the Phase 3 embedded terminal (Cursor-style).
 */

import * as pty from '@lydell/node-pty';

function shellCommand() {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe';
  }
  return process.env.SHELL || 'bash';
}

export class TerminalSession {
  #pty = null;
  #ws = null;
  #id = null;
  #cwd = null;
  #onExit = null;

  /**
   * @param {string}   id           unique session identifier (UUID)
   * @param {string}   cwd          working directory for the shell
   * @param {object}   ws           WebSocket bridge with on()/send()/close()
   * @param {function} [onExit]     called when the session terminates (PTY exit or WS close)
   */
  constructor({ id, cwd, ws, onExit }) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('id required');
    if (typeof ws !== 'object' || !ws) throw new TypeError('ws required');
    this.#id = id;
    this.#cwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
    this.#ws = ws;
    this.#onExit = typeof onExit === 'function' ? onExit : null;
    this.#ws.on('message', (data) => this.#onMessage(data));
    this.#ws.on('close', () => this.kill());
    this.#spawn();
  }

  get id() { return this.#id; }
  get alive() { return this.#pty !== null; }

  #spawn() {
    const shell = shellCommand();
    const args = process.platform === 'win32' ? [] : [];
    this.#pty = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 24,
      cwd: this.#cwd,
      env: { ...process.env },
    });
    this.#pty.onData((data) => {
      if (this.#ws && this.#ws.readyState === 1) {
        this.#ws.send(data);
      }
    });
    this.#pty.onExit(({ exitCode, signal }) => {
      if (this.#ws && this.#ws.readyState === 1) {
        try { this.#ws.send(`\r\n[Process exited with code ${exitCode ?? signal}]\r\n`); } catch { /* ignore */ }
        try { this.#ws.close(); } catch { /* ignore */ }
      }
      this.#pty = null;
      if (this.#onExit) this.#onExit();
    });
  }

  #onMessage(data) {
    if (!this.#pty) return;
    const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf-8') : '';
    try {
      // xterm.js sends resize requests as JSON { cols, rows }
      const msg = JSON.parse(raw);
      if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        this.#pty.resize(msg.cols, msg.rows);
        return;
      }
    } catch {
      // Not JSON — pass through as terminal input.
    }
    this.#pty.write(raw);
  }

  kill() {
    if (this.#pty) {
      try { this.#pty.kill(); } catch { /* ignore */ }
      this.#pty = null;
      if (this.#onExit) this.#onExit();
    }
  }
}
