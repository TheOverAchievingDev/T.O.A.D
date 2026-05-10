import { spawn as defaultSpawn } from 'node:child_process';
import { readFileSync as defaultReadFileSync } from 'node:fs';
import { FoundryProviderAdapter } from './FoundryProviderAdapter.js';
import { resolveCli } from './resolveCli.js';

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
    resolveCliImpl = resolveCli,
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
    this.resolveCliImpl = resolveCliImpl;
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

    // Build prompt + argv. Transport differs between first-turn and
    // resume-turn:
    //
    //  - First turn: prompt = foundryInstructions.txt (~10KB) + user
    //    message. That exceeds Windows cmd.exe's ~8KB command-line cap,
    //    so we use Codex's `-` stdin sentinel and write the prompt to
    //    stdin.
    //  - Resume turn: prompt = just the user message (short). The `-`
    //    stdin sentinel is documented for `codex exec` but appears NOT
    //    to be supported by `codex exec resume` — empirical observation
    //    during F.2 smoke showed Codex exiting code=2 when resume was
    //    invoked with `-`. The user message stays short here, so passing
    //    it positionally is safe (no cmd.exe length concern) and avoids
    //    the resume+`-` incompatibility.
    //
    // First-turn `codex exec` has no --append-system-prompt-file flag so
    // we prepend the system prompt to the user message. Resume turns
    // don't need to re-send the system prompt — Codex has the prior
    // conversation (including original instructions) on disk.
    let prompt;
    let args;
    let useStdin;
    if (cliSessionId) {
      prompt = text;
      args = ['exec', 'resume', cliSessionId, '--json', '--skip-git-repo-check', '-C', cwd, prompt];
      useStdin = false;
    } else {
      const systemPrompt = this.readFileImpl(this.instructionsPath);
      prompt = `${systemPrompt}\n\n${text}`;
      args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-'];
      useStdin = true;
    }

    // resolveCli walks PATH for codex.cmd / codex.exe / codex.bat on
    // Windows because Node's spawn doesn't honor PATHEXT. Returns the
    // bare name as-is on Unix and as a fallback when nothing is found
    // (so ENOENT still surfaces normally for the "not installed" path).
    // Tests inject identity to keep assertions platform-independent.
    const resolved = this.resolveCliImpl('codex');
    // Node 16+ no longer auto-shells .cmd/.bat files on Windows (CVE-2024-
    // 27980). spawn() returns EINVAL on direct .cmd invocation; we must
    // opt into shell:true explicitly. cmd.exe's command-line length cap
    // isn't a concern here because the prompt goes via stdin — args stay
    // short (just flags + `-` sentinel).
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    const child = this.spawnImpl(resolved, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
      windowsHide: true,
    });

    // For first-turn (`codex exec -`), write the full prompt to stdin
    // and close it so Codex sees EOF and starts processing. For resume
    // turns the prompt is positional, so close stdin immediately so
    // Codex doesn't wait on it.
    try {
      if (useStdin) {
        child.stdin?.write(prompt);
      }
      child.stdin?.end();
    } catch (err) {
      // Defensive — if stdin write fails (process already exited, etc.),
      // the stream consumer's errorHandler/closeHandler will surface
      // the real failure. Swallow here so we don't double-throw.
    }

    return this.#consumeStream({ child });
  }

  // Stateless — no in-memory cross-turn state to attach/detach.
  isAttached(_args) { return false; }
  async close() { /* no-op */ }
  async closeAll() { /* no-op */ }

  #consumeStream({ child }) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let lineBuffer = '';
      let assistantText = '';
      let threadId = null;
      let eventCount = 0;
      // Capture stderr so non-zero exits self-diagnose. Without this,
      // codex's own error messages (auth failures, invalid session ids,
      // protocol errors, etc.) are lost and the operator sees only the
      // exit code. Cap at 8KB to avoid runaway memory if codex spams
      // warnings on stderr.
      let stderrBuf = '';
      const STDERR_CAP = 8 * 1024;
      const stderrHandler = (chunk) => {
        if (stderrBuf.length < STDERR_CAP) {
          stderrBuf += chunk.toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
        }
      };

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
        const stderrSuffix = stderrBuf.length > 0
          ? `\n--- codex stderr ---\n${stderrBuf.trim()}\n---`
          : ' (no stderr output)';
        reject(new Error(`CodexFoundryAdapter: codex exited (code=${code}) before turn.completed.${stderrSuffix}`));
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
        if (child.stderr?.off) child.stderr.off('data', stderrHandler);
        else if (child.stderr?.removeListener) child.stderr.removeListener('data', stderrHandler);
        child.off?.('close', closeHandler);
        child.off?.('error', errorHandler);
      }

      // Capture stderr (instead of draining) so non-zero exits self-diagnose.
      child.stderr?.on('data', stderrHandler);
      child.stdout.on('data', dataHandler);
      child.on('close', closeHandler);
      child.on('error', errorHandler);
    });
  }
}
