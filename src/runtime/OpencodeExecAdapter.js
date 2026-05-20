import { spawn as defaultSpawn } from 'node:child_process';
import { RuntimeAdapter, RuntimeAdapterError } from './RuntimeAdapter.js';
import { resolveCli as defaultResolveCli } from '../foundry/providers/resolveCli.js';
import { normalizeOpencodeStreamLine } from './opencode/normalizeOpencodeStreamLine.js';
import { buildProbeInstruction, evaluateFirstTurnProbe } from './firstTurnMcpProbe.js';

const UNKNOWN_SESSION_RE = /unknown session|session not found|no (such )?session|session id .* not found|invalid session/i;

export class OpencodeExecAdapter extends RuntimeAdapter {
  constructor({ runtimeId, teamId, agentId, cwd, systemPrompt = '', args = [], spawnImpl, resolveCliImpl, sessionStore, turnTimeoutMs } = {}) {
    super('opencode');
    this.runtimeId = requireString(runtimeId, 'runtimeId');
    this.teamId = requireString(teamId, 'teamId');
    this.agentId = requireString(agentId, 'agentId');
    this.cwd = requireString(cwd, 'cwd');
    this.systemPrompt = typeof systemPrompt === 'string' ? systemPrompt : '';
    this.args = normalizeOpencodeArgs(args);
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn;
    this.resolveCliImpl = typeof resolveCliImpl === 'function' ? resolveCliImpl : defaultResolveCli;
    this.sessionStore = sessionStore && typeof sessionStore.get === 'function' ? sessionStore : null;
    this.turnTimeoutMs = Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0 ? turnTimeoutMs : 30 * 60_000;
    this.child = null;
    this._queue = [];
    this._waiters = [];
    this._ended = false;
    this._chain = Promise.resolve();
    this._pendingTexts = [];
    this._turnStartedAt = null;
  }

  #push(event) {
    const waiter = this._waiters.shift();
    if (waiter) waiter({ value: event, done: false });
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
    this._pendingTexts.push(text);
    const run = this._chain.then(async () => {
      const batch = this._pendingTexts;
      if (batch.length === 0) {
        return { accepted: true, responseState: 'coalesced', receipt: { written: true, runtimeId: this.runtimeId } };
      }
      this._pendingTexts = [];
      try {
        return await this.#runTurn(batch.join('\n\n'));
      } catch (err) {
        // A pre-spawn failure (synchronous spawnImpl throw) delivered
        // nothing — restore the batch so the next chained slot re-drains it;
        // otherwise later coalesced callers report a false `coalesced`
        // success for lost messages. Mirrors CodexExecAdapter W5.
        this._pendingTexts = batch.concat(this._pendingTexts);
        throw err;
      }
    });
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async #runTurn(text) {
    const resumeId = this.sessionStore ? this.sessionStore.get(this.runtimeId) : null;
    const isResume = typeof resumeId === 'string' && resumeId.length > 0;
    let needsProbe = !isResume;
    // GROUNDED (opencode 1.15.4 §7/§10): the message is a CONFIRMED-working
    // POSITIONAL argv arg, NOT stdin. First turn prefixes the systemPrompt;
    // resume sends only the follow-up text (the prior session is on disk).
    let message = isResume
      ? text
      : (this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text);
    if (needsProbe) message += `\n\n${buildProbeInstruction()}`;
    let result = await this.#attemptTurn({ resumeId: isResume ? resumeId : null, message, needsProbe });
    if (result.accepted !== true && isResume && UNKNOWN_SESSION_RE.test(result.__failError || '')) {
      if (this.sessionStore) this.sessionStore.clear(this.runtimeId);
      this.#push({
        runtimeId: this.runtimeId,
        teamId: this.teamId,
        agentId: this.agentId,
        type: 'runtime_event',
        note: 'opencode_session_reset',
        detail: 'opencode resume session unknown - restarting as a fresh session',
      });
      let firstTurnMessage = this.systemPrompt.trim().length > 0 ? `${this.systemPrompt}\n\n${text}` : text;
      needsProbe = true;
      firstTurnMessage += `\n\n${buildProbeInstruction()}`;
      result = await this.#attemptTurn({ resumeId: null, message: firstTurnMessage, needsProbe: true });
    }
    if (result.accepted !== true && typeof result.__failError === 'string' && result.__pushedFailure !== true) {
      this.#push({ runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId, type: 'turn_failed', error: result.__failError });
    }
    return result;
  }

  async #attemptTurn({ resumeId, message, needsProbe }) {
    // §7/§10 RATIFIED argv. First turn:
    //   run --format json --dangerously-skip-permissions ...modelArgs <message>
    // Resume adds ['--session', '<captured ses_* id>'] before the message.
    // The message is the FINAL POSITIONAL arg (CONFIRMED working), never stdin.
    const args = [
      'run',
      '--format', 'json',
      '--dangerously-skip-permissions',
      ...(resumeId ? ['--session', resumeId] : []),
      ...this.args,
      message,
    ];
    const resolved = this.resolveCliImpl('opencode');
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(resolved));
    this._turnStartedAt = new Date().toISOString();
    let child;
    try {
      child = this.spawnImpl(resolved, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: needsShell,
        windowsHide: true,
        cwd: this.cwd,
      });
    } catch (spawnErr) {
      this._turnStartedAt = null;
      throw spawnErr;
    }
    this.child = child;

    return new Promise((resolve) => {
      let settled = false;
      let lineBuf = '';
      let stderrBuf = '';
      const STDERR_CAP = 8 * 1024;
      const ctx = { runtimeId: this.runtimeId, teamId: this.teamId, agentId: this.agentId };
      const turnEvents = [];
      let timedOut = false;

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try { if (child && typeof child.kill === 'function' && !child.killed) child.kill('SIGTERM'); } catch { /* ignore */ }
      }, this.turnTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        this._turnStartedAt = null;
        child.stdout && child.stdout.removeListener && child.stdout.removeListener('data', onData);
        child.stderr && child.stderr.removeListener && child.stderr.removeListener('data', onStderr);
        child.removeListener && child.removeListener('close', onClose);
        child.removeListener && child.removeListener('error', onErr);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onData = (chunk) => {
        lineBuf += Buffer.from(chunk).toString('utf8');
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          for (const ev of normalizeOpencodeStreamLine(line, ctx)) {
            turnEvents.push(ev);
            this.#push(ev);
            if (ev.type === 'session_started' && typeof ev.sessionId === 'string'
                && ev.sessionId.length > 0 && this.sessionStore) {
              this.sessionStore.set(this.runtimeId, ev.sessionId);
            }
            if (ev.type === 'turn_failed') {
              finish({ accepted: false, responseState: 'turn_failed', receipt: { written: true, runtimeId: this.runtimeId }, __failError: ev.error, __pushedFailure: true });
            }
            if (ev.type === 'turn_completed') {
              if (needsProbe && !evaluateFirstTurnProbe(turnEvents).satisfied) {
                finish({ accepted: false, responseState: 'turn_failed', receipt: { written: true, runtimeId: this.runtimeId }, __failError: 'TOAD tools unavailable: opencode agent could not confirm the toad MCP rail on the first turn' });
              } else {
                finish({ accepted: true, responseState: 'accepted_by_runtime', receipt: { written: true, runtimeId: this.runtimeId } });
              }
            }
          }
        }
      };
      const onStderr = (chunk) => {
        if (stderrBuf.length < STDERR_CAP) {
          stderrBuf += Buffer.from(chunk).toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
        }
      };
      const onClose = (code) => {
        finish({ accepted: false, responseState: 'turn_failed', receipt: { written: true, runtimeId: this.runtimeId }, __failError: timedOut
          ? `opencode turn timeout after ${this.turnTimeoutMs}ms`
          : `opencode exited (code=${code})${stderrBuf ? ` - ${stderrBuf.trim()}` : ''}` });
      };
      const onErr = (err) => {
        finish({ accepted: false, responseState: 'turn_failed', receipt: { written: false, runtimeId: this.runtimeId }, __failError: timedOut
          ? `opencode turn timeout after ${this.turnTimeoutMs}ms`
          : (err && err.message ? err.message : String(err)) });
      };

      child.stdout && child.stdout.on('data', onData);
      child.stderr && child.stderr.on('data', onStderr);
      child.on('close', onClose);
      child.on('error', onErr);
      // GROUNDED: the prompt is delivered as a positional argv arg (above),
      // NOT via stdin. Close stdin with nothing so opencode doesn't block
      // waiting on an interactive stdin stream.
      try { child.stdin && child.stdin.end(); } catch { /* close/error path reports it */ }
    });
  }

  async sendToolResult() {
    return { accepted: true, responseState: 'not_applicable_opencode_mcp_direct', receipt: { runtimeId: this.runtimeId } };
  }

  async approve() {
    return {
      accepted: false,
      responseState: 'approval_not_applicable_opencode',
      reason: 'OpenCode team agents are gate-governed (review/drift/risk + dangerously-skip-permissions), not per-tool approved',
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

// BR5/A6: model/agent/variant values reach a `shell:true` spawn on Windows
// .cmd resolution. Only plain provider/model identifiers are allowed through
// — anything with a shell metacharacter (space, quote, &|;<>$`(), etc.) is
// dropped before it can become an argument-injection vector (CVE-2024-27980).
const SAFE_OPENCODE_ARG_VALUE = /^[\w./:@-]+$/;

function normalizeOpencodeArgs(args) {
  const input = Array.isArray(args) ? args.map((entry) => String(entry)) : [];
  const out = [];
  for (let i = 0; i < input.length; i += 1) {
    const current = input[i];
    if (current === '--model' || current === '-m' || current === '--agent' || current === '--variant') {
      const value = input[i + 1];
      if (typeof value === 'string' && value.length > 0) {
        i += 1; // consume the value regardless (so a dropped value can't strand it)
        if (SAFE_OPENCODE_ARG_VALUE.test(value)) out.push(current, value);
      }
    } else if (/^--(model|agent|variant)=.+/.test(current)) {
      const value = current.slice(current.indexOf('=') + 1);
      if (SAFE_OPENCODE_ARG_VALUE.test(value)) out.push(current);
    } else if (current === '--thinking') {
      out.push(current);
    }
  }
  return out;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeAdapterError(`${label} must be a non-empty string`, { providerId: 'opencode' });
  }
  return value.trim();
}
