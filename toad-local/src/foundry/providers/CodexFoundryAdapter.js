import { spawn as defaultSpawn } from 'node:child_process';
import { readFileSync as defaultReadFileSync } from 'node:fs';
import { FoundryProviderAdapter } from './FoundryProviderAdapter.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per turn

/**
 * CodexFoundryAdapter — drives Codex CLI in 'codex exec' mode for
 * Foundry planning sessions. Each send() spawns a fresh `codex` process
 * for ONE turn, then exits. Codex preserves session state on disk
 * (~/.codex/sessions/<id>/) between calls; subsequent turns use
 * 'codex exec resume <session_id>' which loads the prior conversation
 * from disk without us replaying tokens.
 *
 * JSON event shape grounded in upstream agent-teams-ai's Phase 0 spec
 * (codex-cli 0.117.0, observed 2026-04-19): thread.started → store
 * thread_id, item.completed with item.type='agent_message' → accumulate
 * text, turn.completed → resolve.
 *
 * Stateless between turns. isAttached() always false; close()/closeAll()
 * are no-ops. Crash recovery is automatic — next send() with stored
 * cliSessionId resumes the conversation.
 */
export class CodexFoundryAdapter extends FoundryProviderAdapter {
  constructor({
    spawnImpl = defaultSpawn,
    readFileImpl = (path) => defaultReadFileSync(path, 'utf8'),
    instructionsPath,
    projectCwdResolver,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    super('openai');
    if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
      throw new TypeError('CodexFoundryAdapter: instructionsPath is required');
    }
    if (typeof projectCwdResolver !== 'function') {
      throw new TypeError('CodexFoundryAdapter: projectCwdResolver function is required');
    }
    this.spawnImpl = spawnImpl;
    this.readFileImpl = readFileImpl;
    this.instructionsPath = instructionsPath;
    this.projectCwdResolver = projectCwdResolver;
    this.timeoutMs = timeoutMs;
  }

  async send({ foundrySessionId, text, cliSessionId = null } = {}) {
    if (typeof foundrySessionId !== 'string' || foundrySessionId.length === 0) {
      throw new TypeError('CodexFoundryAdapter.send: foundrySessionId required');
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('CodexFoundryAdapter.send: text required');
    }

    const cwd = this.projectCwdResolver() || process.cwd();

    // Build argv. First turn: prepend system prompt to user message
    // because `codex exec` has no --append-system-prompt-file flag.
    // Resume turn: send only the new user message; Codex has the prior
    // conversation (including original instructions) on disk.
    let prompt;
    let args;
    if (cliSessionId) {
      prompt = text;
      args = ['exec', 'resume', cliSessionId, '--json', '--skip-git-repo-check', '-C', cwd, prompt];
    } else {
      const systemPrompt = this.readFileImpl(this.instructionsPath);
      prompt = `${systemPrompt}\n\n${text}`;
      args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, prompt];
    }

    const child = this.spawnImpl('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    return this.#consumeStream({ child });
  }

  // Stateless — no in-memory cross-turn state to attach/detach.
  isAttached() { return false; }
  async close() { /* no-op */ }
  async closeAll() { /* no-op */ }

  #consumeStream({ child }) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let lineBuffer = '';
      let assistantText = '';
      let threadId = null;
      let eventCount = 0;

      const dataHandler = (chunk) => {
        lineBuffer += chunk.toString('utf8');
        let nl;
        while ((nl = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, nl).trim();
          lineBuffer = lineBuffer.slice(nl + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { continue; } // non-JSON warning lines are dropped silently
          eventCount += 1;

          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            threadId = event.thread_id;
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
            assistantText += event.item.text;
          }
          if (event.type === 'turn.completed') {
            if (resolved) return;
            resolved = true;
            cleanup();
            if (assistantText.length === 0) {
              reject(new Error('CodexFoundryAdapter: turn.completed with no agent_message'));
              return;
            }
            resolve({
              text: assistantText,
              sessionUuid: threadId,
              model: null,
              eventCount,
            });
          }
        }
      };

      const closeHandler = (code) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error(`CodexFoundryAdapter: codex exited (code=${code}) before turn.completed`));
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
        reject(new Error(`CodexFoundryAdapter: turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        if (child.stdout?.off) child.stdout.off('data', dataHandler);
        else if (child.stdout?.removeListener) child.stdout.removeListener('data', dataHandler);
        child.off?.('close', closeHandler);
        child.off?.('error', errorHandler);
      }

      // Drain stderr (warnings) so the pipe never blocks.
      child.stderr?.on('data', () => { /* drain */ });
      child.stdout.on('data', dataHandler);
      child.on('close', closeHandler);
      child.on('error', errorHandler);
    });
  }
}
