import { spawn as defaultSpawn } from 'node:child_process';
import { RuntimeAdapter, RuntimeAdapterError } from './RuntimeAdapter.js';
import { resolveCli as defaultResolveCli } from '../foundry/providers/resolveCli.js';
import { normalizeCodexExecLine } from './codex/normalizeCodexExecLine.js';

/**
 * SP1a Stage 1 — minimal FIRST-TURN Codex team adapter. Same
 * RuntimeAdapter surface as ClaudeStreamJsonAdapter; per-turn internal
 * lifecycle (no held child). Stage 2 adds resume/session continuity,
 * the wake-on-message inbox, and the session-aware stuck path. A
 * second sendTurn in Stage 1 starts a fresh `codex exec` (no resume
 * yet) — acceptable for the end-to-end proof.
 */
export class CodexExecAdapter extends RuntimeAdapter {
  constructor({ runtimeId, teamId, agentId, cwd, systemPrompt = '', spawnImpl, resolveCliImpl } = {}) {
    super('openai');
    this.runtimeId = requireString(runtimeId, 'runtimeId');
    this.teamId = requireString(teamId, 'teamId');
    this.agentId = requireString(agentId, 'agentId');
    this.cwd = requireString(cwd, 'cwd');
    this.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn;
    this.resolveCliImpl = typeof resolveCliImpl === 'function' ? resolveCliImpl : defaultResolveCli;
    this.child = null;
    this._queue = [];
    this._waiters = [];
    this._ended = false;
  }

  #push(event) {
    const w = this._waiters.shift();
    if (w) w({ value: event, done: false });
    else this._queue.push(event);
  }

  events() {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this._queue.length) return Promise.resolve({ value: this._queue.shift(), done: false });
          if (this._ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => this._waiters.push(resolve));
        },
      }),
    };
  }

  async sendTurn(input) {
    const text = requireString(input && input.message && input.message.text, 'message.text');
    const prompt = this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text;
    // RATIFIED (codex-cli 0.130.0, grounding d1e58e1): `--ask-for-approval`
    // is NOT a `codex exec` flag (→ exit 2). `approval_policy="never"` via
    // `-c` keeps the workspace-write sandbox AND runs non-interactively.
    // NOT `--dangerously-bypass-approvals-and-sandbox` (strips the sandbox).
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd,
      '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-'];
    const resolved = this.resolveCliImpl('codex');
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(resolved));
    const child = this.spawnImpl(resolved, args, {
      stdio: ['pipe', 'pipe', 'pipe'], shell: needsShell, windowsHide: true, cwd: this.cwd,
    });
    this.child = child;

    return await new Promise((resolve) => {
      let settled = false;
      let lineBuf = '';
      let stderrBuf = '';
      const STDERR_CAP = 8 * 1024;
      const ctx = { runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId };

      const onData = (chunk) => {
        lineBuf += Buffer.from(chunk).toString('utf8');
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          for (const ev of normalizeCodexExecLine(line, ctx)) {
            this.#push(ev);
            if (ev.type === 'turn_completed' && !settled) {
              settled = true;
              cleanup();
              resolve({ accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: this.runtimeId } });
            }
          }
        }
      };
      const onStderr = (c) => {
        if (stderrBuf.length < STDERR_CAP) stderrBuf += Buffer.from(c).toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
      };
      const onClose = (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#push({ ...ctx, type: 'turn_failed', error: `codex exec exited (code=${code})${stderrBuf ? ` — ${stderrBuf.trim()}` : ''}` });
        resolve({ accepted: false, responseState: 'turn_failed', receipt: { written: true, runtimeId: this.runtimeId } });
      };
      const onErr = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#push({ ...ctx, type: 'turn_failed', error: err && err.message ? err.message : String(err) });
        resolve({ accepted: false, responseState: 'turn_failed', receipt: { written: false, runtimeId: this.runtimeId } });
      };
      const cleanup = () => {
        child.stdout && child.stdout.removeListener && child.stdout.removeListener('data', onData);
        child.stderr && child.stderr.removeListener && child.stderr.removeListener('data', onStderr);
        child.removeListener && child.removeListener('close', onClose);
        child.removeListener && child.removeListener('error', onErr);
      };

      child.stdout && child.stdout.on('data', onData);
      child.stderr && child.stderr.on('data', onStderr);
      child.on('close', onClose);
      child.on('error', onErr);
      try { child.stdin.write(prompt); child.stdin.end(); } catch { /* onClose/onErr surface it */ }
    });
  }

  async sendToolResult() {
    return { accepted: true, responseState: 'not_applicable_codex_mcp_direct', receipt: { runtimeId: this.runtimeId } };
  }

  async approve() {
    return {
      accepted: false,
      responseState: 'approval_not_applicable_codex',
      reason: 'Codex team agents are gate-governed (review/drift/risk + sandbox), not per-tool approved',
      receipt: { runtimeId: this.runtimeId },
    };
  }

  async stop() {
    if (this.child && typeof this.child.kill === 'function' && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this._ended = true;
    while (this._waiters.length) this._waiters.shift()({ value: undefined, done: true });
    return { stopped: true, runtimeId: this.runtimeId };
  }

  async health() {
    return { runtimeId: this.runtimeId, status: this._ended ? 'stopped' : 'idle', healthy: !this._ended };
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeAdapterError(`${label} must be a non-empty string`, { providerId: 'openai' });
  }
  return value.trim();
}
