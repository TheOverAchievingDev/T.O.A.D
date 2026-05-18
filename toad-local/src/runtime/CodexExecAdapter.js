import { spawn as defaultSpawn } from 'node:child_process';
import { RuntimeAdapter, RuntimeAdapterError } from './RuntimeAdapter.js';
import { resolveCli as defaultResolveCli } from '../foundry/providers/resolveCli.js';
import { normalizeCodexExecLine } from './codex/normalizeCodexExecLine.js';

const UNKNOWN_SESSION_RE = /unknown session|session not found|no (such )?session|session id .* not found|invalid session/i;

/**
 * SP1a Stage 1 — minimal FIRST-TURN Codex team adapter. Same
 * RuntimeAdapter surface as ClaudeStreamJsonAdapter; per-turn internal
 * lifecycle (no held child). Stage 2 adds resume/session continuity,
 * the wake-on-message inbox, and the session-aware stuck path. A
 * second sendTurn in Stage 1 starts a fresh `codex exec` (no resume
 * yet) — acceptable for the end-to-end proof.
 */
export class CodexExecAdapter extends RuntimeAdapter {
  constructor({ runtimeId, teamId, agentId, cwd, systemPrompt = '', spawnImpl, resolveCliImpl, sessionStore, turnTimeoutMs } = {}) {
    super('openai');
    this.runtimeId = requireString(runtimeId, 'runtimeId');
    this.teamId = requireString(teamId, 'teamId');
    this.agentId = requireString(agentId, 'agentId');
    this.cwd = requireString(cwd, 'cwd');
    this.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn;
    this.resolveCliImpl = typeof resolveCliImpl === 'function' ? resolveCliImpl : defaultResolveCli;
    this.sessionStore = sessionStore && typeof sessionStore.get === 'function' ? sessionStore : null;
    this.turnTimeoutMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0
      ? turnTimeoutMs
      : 30 * 60_000; // 30 min — team turns are long autonomous runs (spec §8)
    this.child = null;
    this._queue = [];
    this._waiters = [];
    this._ended = false;
    this._chain = Promise.resolve();   // FIFO per-agent turn serializer (Task 5)
    this._pendingTexts = [];           // coalesced messages awaiting the next turn (Task 5)
    this._turnStartedAt = null;        // ISO while a turn is in-flight (Task 11)
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
    // Spec §4/§5: turns serialized FIFO per-agent (one in-flight #runTurn per
    // runtime); messages that arrive while a turn is in-flight coalesce into
    // ONE batched follow-up turn. Pure _chain serializer — every call chains a
    // drain slot; the first slot to run drains whatever is pending into one
    // #runTurn, later slots that find nothing pending resolve as `coalesced`.
    // A synchronous burst therefore batches into a single turn (spec §5,
    // intentional). No _turnInFlight fast-path: it would let a call in the
    // gap between turn-completion and the next drain overwrite _chain and
    // double-spawn (overlap → session corruption, spec §4).
    this._pendingTexts.push(text);
    const run = this._chain.then(async () => {
      const batch = this._pendingTexts;
      if (batch.length === 0) return { accepted: true, responseState: 'coalesced', receipt: { written: true, runtimeId: this.runtimeId } };
      this._pendingTexts = [];
      try {
        return await this.#runTurn(batch.join('\n\n'));
      } catch (err) {
        // #runTurn only THROWS on a pre-spawn failure (synchronous spawnImpl
        // throw) — nothing was delivered. Restore the batch at the front so
        // the next chained slot re-drains it; otherwise later coalesced
        // callers would report a false `coalesced` success for lost messages.
        // (All post-spawn failures resolve {accepted:false}, never throw.)
        this._pendingTexts = batch.concat(this._pendingTexts);
        throw err;
      }
    });
    // Keep the chain alive even if a turn rejects (#runTurn resolves
    // {accepted:false} rather than throwing — but be safe).
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async #runTurn(text) {
    const resumeId = this.sessionStore ? this.sessionStore.get(this.runtimeId) : null;
    const isResume = typeof resumeId === 'string' && resumeId.length > 0;
    // First turn: prepend systemPrompt (codex exec has no append-system-prompt
    // flag; conventions live in AGENTS.md). Resume: prior convo + instructions
    // are on disk — send the message only (grounding §10).
    const prompt = isResume
      ? text
      : (this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text);
    // RATIFIED argv: first-turn keeps the Stage-1 sandbox argv. Resume
    // (grounding §10, real codex 0.130) rejects -C/--sandbox (session-stored
    // cwd is authoritative; process is spawned with cwd=this.cwd) but accepts
    // --skip-git-repo-check (worktrees may not be git repos); `-` reads the
    // prompt from stdin (accepted on resume in 0.130).
    const args = isResume
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', resumeId, '-']
      : ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd,
        '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-'];

    const attempt = (argv, stdinPrompt) => {
      const resolved = this.resolveCliImpl('codex');
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(resolved));
      this._turnStartedAt = new Date().toISOString();
      let child;
      try {
        child = this.spawnImpl(resolved, argv, {
          stdio: ['pipe', 'pipe', 'pipe'], shell: needsShell, windowsHide: true, cwd: this.cwd,
        });
      } catch (spawnErr) {
        this._turnStartedAt = null; // no stale in-flight marker if spawn throws synchronously
        throw spawnErr;             // preserve existing throw-propagation for this edge
      }
      this.child = child;

      return new Promise((resolve) => {
        let settled = false;
        let lineBuf = '';
        let stderrBuf = '';
        const STDERR_CAP = 8 * 1024;
        const ctx = { runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId };

        let timedOut = false;
        const timeoutTimer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          try { if (child && typeof child.kill === 'function' && !child.killed) child.kill('SIGTERM'); } catch { /* ignore */ }
        }, this.turnTimeoutMs);

        const onData = (chunk) => {
          lineBuf += Buffer.from(chunk).toString('utf8');
          let nl;
          while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl);
            lineBuf = lineBuf.slice(nl + 1);
            for (const ev of normalizeCodexExecLine(line, ctx)) {
              this.#push(ev);
              if (ev.type === 'session_started' && typeof ev.sessionId === 'string'
                  && ev.sessionId.length > 0 && this.sessionStore) {
                this.sessionStore.set(this.runtimeId, ev.sessionId);
              }
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
          resolve({ accepted: false, responseState: 'turn_failed', receipt: { written: true, runtimeId: this.runtimeId }, __stderr: stderrBuf, __failError: timedOut
            ? `codex exec turn timeout after ${this.turnTimeoutMs}ms`
            : `codex exec exited (code=${code})${stderrBuf ? ` — ${stderrBuf.trim()}` : ''}` });
        };
        const onErr = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ accepted: false, responseState: 'turn_failed', receipt: { written: false, runtimeId: this.runtimeId }, __stderr: String(err && err.message || err), __failError: timedOut
            ? `codex exec turn timeout after ${this.turnTimeoutMs}ms`
            : (err && err.message ? err.message : String(err)) });
        };
        const cleanup = () => {
          clearTimeout(timeoutTimer);
          this._turnStartedAt = null;
          child.stdout && child.stdout.removeListener && child.stdout.removeListener('data', onData);
          child.stderr && child.stderr.removeListener && child.stderr.removeListener('data', onStderr);
          child.removeListener && child.removeListener('close', onClose);
          child.removeListener && child.removeListener('error', onErr);
        };

        child.stdout && child.stdout.on('data', onData);
        child.stderr && child.stderr.on('data', onStderr);
        child.on('close', onClose);
        child.on('error', onErr);
        try { child.stdin.write(stdinPrompt); child.stdin.end(); } catch { /* onClose/onErr surface it */ }
      });
    };

    let result = await attempt(args, prompt);
    if (result.accepted !== true && isResume && UNKNOWN_SESSION_RE.test(result.__stderr || '')) {
      if (this.sessionStore) this.sessionStore.clear(this.runtimeId);
      this.#push({ runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId,
        type: 'runtime_event', note: 'codex_session_reset',
        detail: 'codex resume session unknown — restarting as a fresh session' });
      const firstTurnArgs = ['exec', '--json', '--skip-git-repo-check', '-C', this.cwd,
        '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-'];
      const firstTurnPrompt = this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text;
      result = await attempt(firstTurnArgs, firstTurnPrompt);
    }
    if (result.accepted !== true && typeof result.__failError === 'string') {
      this.#push({ runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId,
        type: 'turn_failed', error: result.__failError });
    }
    return result;
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

  get turnStartedAt() { return this._turnStartedAt; }
  isTurnInFlight() { return typeof this._turnStartedAt === 'string'; }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeAdapterError(`${label} must be a non-empty string`, { providerId: 'openai' });
  }
  return value.trim();
}
