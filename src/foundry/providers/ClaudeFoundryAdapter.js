import { spawn as defaultSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FoundryProviderAdapter } from './FoundryProviderAdapter.js';
import { resolveCli } from './resolveCli.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per turn

/**
 * ClaudeFoundryAdapter — manages persistent Claude CLI subprocesses for
 * Foundry planning sessions. Mirrors RuntimeSupervisor's pattern at the
 * runtime tier: one child process per Foundry session, held alive across
 * chat turns, killed on session close or sidecar shutdown.
 *
 * F.2: extracted from src/foundry/foundryRuntime.js with no behavior change.
 *
 * Per-turn flow:
 *   - First call for a session: spawn `claude` with --session-id <uuid> +
 *     stream-json IO. Process held in registry.
 *   - Subsequent calls: reuse the existing process, write the new user
 *     message to stdin, await the assistant_message event.
 *   - Crash recovery: if registry has no live process but a cliSessionId
 *     was passed, spawn fresh with --resume <cliSessionId>.
 */
export class ClaudeFoundryAdapter extends FoundryProviderAdapter {
  #processes = new Map(); // foundrySessionId -> { child, sessionUuid, lineBuffer }

  constructor({
    spawnImpl = defaultSpawn,
    resolveCliImpl = resolveCli,
    instructionsPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onCrash = null,
  } = {}) {
    super('anthropic');
    if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
      throw new TypeError('ClaudeFoundryAdapter: instructionsPath is required');
    }
    this.spawnImpl = spawnImpl;
    this.resolveCliImpl = resolveCliImpl;
    this.instructionsPath = instructionsPath;
    this.timeoutMs = timeoutMs;
    this.onCrash = typeof onCrash === 'function' ? onCrash : null;
  }

  isAttached({ foundrySessionId } = {}) {
    return this.#processes.has(foundrySessionId);
  }

  async send({ foundrySessionId, text, cliSessionId = null } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
      throw new TypeError('ClaudeFoundryAdapter.send: foundrySessionId required');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('ClaudeFoundryAdapter.send: text required');
    }

    let entry = this.#processes.get(foundrySessionId);
    if (!entry) {
      entry = this.#spawn({ cliSessionId });
      this.#processes.set(foundrySessionId, entry);
    }

    return this.#runTurn({ entry, text });
  }

  async close({ foundrySessionId } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) return;
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
    // resolveCli walks PATH for claude.cmd / claude.exe / claude.bat on
    // Windows so npm-installed Claude wrappers resolve. On Unix and when
    // claude.exe is the canonical install (typical), this is a passthrough.
    // Tests inject identity to keep assertions platform-independent.
    const resolved = this.resolveCliImpl('claude');
    // Node 16+ no longer auto-shells .cmd/.bat files on Windows (CVE-2024-
    // 27980). spawn() returns EINVAL on direct .cmd invocation; we must
    // opt into shell:true explicitly. For typical claude.exe installs this
    // is a passthrough.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    const child = this.spawnImpl(resolved, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      windowsHide: true,
    });
    const entry = { child, sessionUuid, lineBuffer: '' };

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
      throw new Error(`ClaudeFoundryAdapter: stdin write failed: ${err && err.message ? err.message : err}`);
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
              reject(new Error('ClaudeFoundryAdapter: result event before any assistant_message'));
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
        reject(new Error(`ClaudeFoundryAdapter: subprocess closed (exit=${code}) before result event`));
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
        reject(new Error(`ClaudeFoundryAdapter: turn timed out after ${this.timeoutMs}ms`));
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
