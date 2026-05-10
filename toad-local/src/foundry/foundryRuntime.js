import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per turn

/**
 * FoundryRuntime — manages persistent Claude CLI subprocesses for Foundry
 * planning sessions. Mirrors RuntimeSupervisor's pattern at the runtime
 * tier: one child process per Foundry session, held alive across chat
 * turns, killed on session close or sidecar shutdown.
 *
 * Per-turn flow:
 *   - First call for a session: spawn `claude` with --session-id <uuid> +
 *     stream-json IO. Process held in registry.
 *   - Subsequent calls: reuse the existing process, write the new user
 *     message to stdin, await the assistant_message event.
 *   - Crash recovery: if registry has no live process but a cliSessionId
 *     was passed, spawn fresh with --resume <cliSessionId>.
 *
 * Stream-json line parser is inlined (~20 LOC). The runtime tier's
 * ClaudeStreamJsonAdapter is agent-runtime-shaped (RuntimeAdapter base
 * class, turn tracking, tool calls); Foundry's needs are simpler.
 */
export class FoundryRuntime {
  #processes = new Map(); // foundrySessionId -> { child, sessionUuid, lineBuffer }

  constructor({
    spawnImpl = defaultSpawn,
    instructionsPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onCrash = null,
  } = {}) {
    if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
      throw new TypeError('FoundryRuntime: instructionsPath is required');
    }
    this.spawnImpl = spawnImpl;
    this.instructionsPath = instructionsPath;
    this.timeoutMs = timeoutMs;
    this.onCrash = typeof onCrash === 'function' ? onCrash : null;
  }

  isLive({ foundrySessionId }) {
    return this.#processes.has(foundrySessionId);
  }

  async send({ foundrySessionId, text, cliSessionId = null } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
      throw new TypeError('FoundryRuntime.send: foundrySessionId required');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('FoundryRuntime.send: text required');
    }

    let entry = this.#processes.get(foundrySessionId);
    if (!entry) {
      entry = this.#spawn({ cliSessionId });
      this.#processes.set(foundrySessionId, entry);
    }

    return this.#runTurn({ entry, text });
  }

  async close({ foundrySessionId } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
      return;
    }
    const entry = this.#processes.get(foundrySessionId);
    if (!entry) return;
    entry._intentionalClose = true;
    this.#processes.delete(foundrySessionId);
    try { entry.child.kill('SIGTERM'); } catch { /* already dead */ }
  }

  async closeAll() {
    const sessionIds = Array.from(this.#processes.keys());
    for (const id of sessionIds) {
      await this.close({ foundrySessionId: id });
    }
  }

  #spawn({ cliSessionId }) {
    const sessionUuid = cliSessionId || randomUUID();
    const args = [
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--append-system-prompt-file', this.instructionsPath,
      '--disallowedTools', '*',
      '--session-id', sessionUuid,
    ];
    if (cliSessionId) {
      args.push('--resume', cliSessionId);
    }
    const child = this.spawnImpl('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, sessionUuid, lineBuffer: '' };

    // Purge registry entry on subprocess close. The per-turn dataHandler/
    // closeHandler in #runTurn handles promise resolution; THIS handler
    // is the cross-turn cleanup so a crashed-between-turns subprocess
    // doesn't leak in the registry forever.
    child.on('close', (code) => {
      for (const [id, e] of this.#processes.entries()) {
        if (e === entry) {
          this.#processes.delete(id);
          if (this.onCrash && code !== 0 && !e._intentionalClose) {
            try { this.onCrash({ foundrySessionId: id, exitCode: code }); } catch { /* ignore */ }
          }
          break;
        }
      }
    });

    return entry;
  }

  async #runTurn({ entry, text }) {
    const { child } = entry;

    const userPayload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      child.stdin.write(JSON.stringify(userPayload) + '\n');
    } catch (err) {
      throw new Error(`FoundryRuntime: stdin write failed: ${err && err.message ? err.message : err}`);
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      let assistantText = null;
      let model = null;
      let eventCount = 0;

      const dataHandler = (chunk) => {
        entry.lineBuffer += chunk.toString('utf8');
        let nl;
        while ((nl = entry.lineBuffer.indexOf('\n')) !== -1) {
          const line = entry.lineBuffer.slice(0, nl).trim();
          entry.lineBuffer = entry.lineBuffer.slice(nl + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { continue; }
          eventCount += 1;

          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            entry.sessionUuid = event.session_id;
          }
          if (event.type === 'assistant' && event.message?.content) {
            const textPart = (event.message.content || [])
              .filter((p) => p && p.type === 'text')
              .map((p) => p.text)
              .join('');
            if (textPart) assistantText = textPart;
            if (event.message.model) model = event.message.model;
          }
          if (event.type === 'result') {
            if (resolved) return;
            resolved = true;
            cleanup();
            if (assistantText === null) {
              reject(new Error('FoundryRuntime: result event before any assistant_message'));
              return;
            }
            resolve({
              text: assistantText,
              sessionUuid: entry.sessionUuid,
              model,
              eventCount,
            });
          }
        }
      };

      const closeHandler = (code) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`FoundryRuntime: subprocess closed (exit=${code}) before result event`));
      };

      const errorHandler = (err) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        cleanup();
        reject(new Error(`FoundryRuntime: turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        if (child.stdout?.off) child.stdout.off('data', dataHandler);
        else if (child.stdout?.removeListener) child.stdout.removeListener('data', dataHandler);
        child.off?.('close', closeHandler);
        child.off?.('error', errorHandler);
      }

      child.stdout.on('data', dataHandler);
      child.on('close', closeHandler);
      child.on('error', errorHandler);
    });
  }
}
