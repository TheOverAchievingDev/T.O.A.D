import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ClaudeStreamJsonAdapter } from './ClaudeStreamJsonAdapter.js';

/**
 * Resolve a bare command name (e.g. `claude`) to an absolute path on
 * Windows by walking PATH and trying each PATHEXT extension. Lets us
 * spawn the resolved binary DIRECTLY without `shell: true`, which on
 * Windows wraps the call in `cmd.exe /d /s /c …` — that wrapper
 * terminates as soon as the inner command finishes and breaks stdin
 * piping for long-running agent processes.
 *
 * Returns the original command unchanged if:
 *   - we're not on Windows
 *   - the command already contains a path separator
 *   - nothing matched (let the OS produce a real ENOENT)
 */
function resolveWindowsCommand(command) {
  if (process.platform !== 'win32') return command;
  if (typeof command !== 'string' || command.length === 0) return command;
  if (command.includes('\\') || command.includes('/')) return command;
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
  const pathext = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase());
  for (const dir of dirs) {
    // Some dev installs leak quotes into PATH entries; strip them.
    const cleanDir = dir.replace(/^"|"$/g, '');
    for (const ext of pathext) {
      const candidate = path.join(cleanDir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export class RuntimeSupervisor {
  #runtimes = new Map();

  constructor({
    runtimeDirectory,
    runtimeRegistry = null,
    spawnProcess = spawn,
    createAdapter = createClaudeAdapter,
  } = {}) {
    if (!runtimeDirectory) throw new TypeError('runtimeDirectory is required');
    this.runtimeDirectory = runtimeDirectory;
    this.runtimeRegistry = runtimeRegistry;
    this.spawnProcess = spawnProcess;
    this.createAdapter = createAdapter;
  }

  async launchAgent(input) {
    const teamId = requireString(input.teamId, 'teamId');
    const agentId = requireString(input.agentId, 'agentId');
    const runtimeId = requireString(input.runtimeId, 'runtimeId');
    const command = requireString(input.command, 'command');
    // Block re-launch only while the previous process is still alive.
    // After unexpected exit (e.g. claude hit usage limit and the child
    // died) or explicit stop, #markExited / stopAgent leave the record
    // in #runtimes with status 'exited'/'stopped' so callers can still
    // inspect history. But that record must NOT block a re-launch of
    // the same runtimeId — Resume Team relies on relaunching with the
    // exact same id so prior runtime_events and messages stay attached.
    //
    // The old guard ("throw if #runtimes.has") meant every Resume after
    // a crashed agent silently failed with "runtime already launched":
    // team_launch caught it, recorded `status: 'failed'` for the
    // member, and the UI showed the agent as idle because no new
    // runtime ever registered. The 2026-05-14 user report ("ran out of
    // usage, hit Resume, lead and all teammates show idle") was this.
    const existing = this.#runtimes.get(runtimeId);
    if (existing) {
      if (existing.status === 'running') {
        throw new Error(`runtime already launched: ${runtimeId}`);
      }
      // Drop the stale record so the new spawn can register cleanly.
      // The persistent registry row already reflects the prior exit
      // (markRuntimeStopped fired from #markExited / stopAgent), and
      // the runtimeDirectory was unregistered too — so no one outside
      // this map still depends on the dead record.
      this.#runtimes.delete(runtimeId);
    }

    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const stdio = input.stdio || ['pipe', 'pipe', 'pipe'];
    // Windows: npm-installed CLI shims like `claude.cmd` aren't found by
    // Node's bare spawn (which doesn't apply PATHEXT). Earlier we used
    // `shell: true` to route through cmd.exe — but cmd /d /s /c
    // terminates as soon as the wrapped command finishes its stdin
    // pipe lifetime, breaking the stream-json adapter for long-running
    // agents. Instead, resolve the .cmd path explicitly via PATH +
    // PATHEXT and spawn it DIRECTLY. Node can spawn .cmd / .bat files
    // directly — it just doesn't auto-search for them.
    const resolvedCommand = resolveWindowsCommand(command);
    // eslint-disable-next-line no-console
    console.log(`[supervisor] spawn ${runtimeId}: ${resolvedCommand} ${args.join(' ')}`);
    const child = this.spawnProcess(resolvedCommand, args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env || {}) },
      stdio,
      // Hide the cmd.exe console flash that .cmd shims pop on Windows.
      windowsHide: true,
      // .bat/.cmd shims need windowsVerbatimArguments=false (default) so
      // Node escapes args properly. Setting nothing here uses Node's
      // safe default. We deliberately do NOT use shell:true.
    });
    // Pipe stderr to the sidecar log so we can see Claude's startup errors,
    // auth failures, missing-flag complaints, etc. Without this they just
    // accumulate in the unread pipe buffer and the agent looks "idle"
    // when it's actually crashing.
    if (child && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const trimmed = String(chunk).trimEnd();
        if (trimmed.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`[${runtimeId}] stderr: ${trimmed}`);
        }
      });
    }
    // NOTE: don't add a 'data' listener on child.stdout — that would put
    // the stream in flowing mode and starve the adapter's async iterator
    // (which is what consumes stream-json events). The adapter handles
    // stdout exclusively.
    // Catch spawn-time errors (ENOENT for "CLI not on PATH", EACCES, etc.)
    // BEFORE they bubble up as an unhandled 'error' event and crash the
    // sidecar. Surface a clean record with status: 'error' so the UI can
    // render a friendly message and the user can install the CLI.
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => {
        const record = this.#runtimes.get(runtimeId);
        if (!record) return;
        record.status = 'error';
        record.exitCode = null;
        record.signal = null;
        record.stoppedAt = new Date().toISOString();
        record.lastError = {
          code: err && typeof err.code === 'string' ? err.code : null,
          message: err && err.message ? err.message : String(err),
        };
        if (this.runtimeRegistry) {
          try {
            this.runtimeRegistry.markRuntimeStopped({
              runtimeId: record.runtimeId,
              status: 'error',
              exitCode: null,
              signal: null,
              stoppedAt: record.stoppedAt,
            });
          } catch { /* best effort */ }
        }
      });
    }
    const adapter = this.createAdapter({ runtimeId, teamId, agentId, child });
    const record = {
      runtimeId,
      teamId,
      agentId,
      command,
      args,
      cwd: input.cwd || null,
      env: input.env && typeof input.env === 'object' ? { ...input.env } : {},
      stdio,
      deliveryMode: input.deliveryMode || 'runtime_stdin',
      // §11 slice 1: pin runtime to its task when caller supplies it. Persists
      // through the registry so audit/diagnostics can answer "which task is
      // this runtime working on?" and "show me everything for task X".
      taskId: typeof input.taskId === 'string' && input.taskId.length > 0 ? input.taskId : null,
      child,
      adapter,
      status: 'running',
      pid: typeof child.pid === 'number' ? child.pid : null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      exitCode: null,
      signal: null,
      stopRequested: false,
      restartPolicy: normalizeRestartPolicy(input.restartPolicy),
      restartCount: 0,
    };
    this.#runtimes.set(runtimeId, record);
    this.#registerRunningRuntime(record);
    this.#attachExitListener(record);

    return this.#snapshot(record);
  }

  getAdapter(runtimeId) {
    return this.#runtimes.get(runtimeId)?.adapter || null;
  }

  getRuntime(runtimeId) {
    const record = this.#runtimes.get(runtimeId);
    return record ? this.#snapshot(record) : null;
  }

  listRuntimes() {
    return Array.from(this.#runtimes.values()).map((record) => this.#snapshot(record));
  }

  async stopAgent(runtimeId, { signal = 'SIGTERM' } = {}) {
    const record = this.#requireRuntime(runtimeId);
    if (record.status === 'running' && record.child && typeof record.child.kill === 'function') {
      record.stopRequested = true;
      record.status = 'stopping';
      record.child.kill(signal);
    }
    record.status = 'stopped';
    record.signal = record.signal || signal;
    record.stoppedAt = record.stoppedAt || new Date().toISOString();
    this.runtimeDirectory.unregisterAgent({ teamId: record.teamId, agentId: record.agentId });
    if (this.runtimeRegistry) {
      this.runtimeRegistry.markRuntimeStopped({
        runtimeId: record.runtimeId,
        status: record.status,
        exitCode: record.exitCode,
        signal: record.signal,
        stoppedAt: record.stoppedAt,
      });
    }
    return this.#snapshot(record);
  }

  async health(runtimeId) {
    const record = this.#requireRuntime(runtimeId);
    return {
      runtimeId: record.runtimeId,
      status: record.status,
      healthy: record.status === 'running',
      pid: record.pid,
      exitCode: record.exitCode,
      signal: record.signal,
    };
  }

  #markExited(runtimeId, code, signal) {
    const record = this.#runtimes.get(runtimeId);
    if (!record || record.status === 'stopped') return;
    if (record.stopRequested) {
      record.exitCode = typeof code === 'number' ? code : null;
      record.signal = typeof signal === 'string' ? signal : record.signal;
      record.stoppedAt = new Date().toISOString();
      return;
    }
    if (record.restartCount < record.restartPolicy.maxRestarts) {
      this.#restartRuntime(record);
      return;
    }
    record.status = 'exited';
    record.exitCode = typeof code === 'number' ? code : null;
    record.signal = typeof signal === 'string' ? signal : null;
    record.stoppedAt = new Date().toISOString();
    this.runtimeDirectory.unregisterAgent({ teamId: record.teamId, agentId: record.agentId });
    if (this.runtimeRegistry) {
      this.runtimeRegistry.markRuntimeStopped({
        runtimeId: record.runtimeId,
        status: record.status,
        exitCode: record.exitCode,
        signal: record.signal,
        stoppedAt: record.stoppedAt,
      });
    }
  }

  #restartRuntime(record) {
    record.restartCount += 1;
    const child = this.spawnProcess(record.command, record.args, {
      cwd: record.cwd || undefined,
      env: { ...process.env, ...record.env },
      stdio: record.stdio,
    });
    const adapter = this.createAdapter({
      runtimeId: record.runtimeId,
      teamId: record.teamId,
      agentId: record.agentId,
      child,
    });
    record.child = child;
    record.adapter = adapter;
    record.status = 'running';
    record.pid = typeof child.pid === 'number' ? child.pid : null;
    record.startedAt = new Date().toISOString();
    record.stoppedAt = null;
    record.exitCode = null;
    record.signal = null;
    record.stopRequested = false;
    this.#registerRunningRuntime(record);
    this.#attachExitListener(record);
  }

  #registerRunningRuntime(record) {
    const providerId = record.adapter.providerId || 'unknown';
    if (this.runtimeRegistry) {
      this.runtimeRegistry.upsertRuntime({
        runtimeId: record.runtimeId,
        teamId: record.teamId,
        agentId: record.agentId,
        providerId,
        command: record.command,
        args: record.args,
        cwd: record.cwd,
        env: record.env,
        deliveryMode: record.deliveryMode,
        pid: record.pid,
        status: record.status,
        startedAt: record.startedAt,
        taskId: record.taskId,
      });
      this.runtimeRegistry.registerDeliveryMode({
        teamId: record.teamId,
        agentId: record.agentId,
        runtimeId: record.runtimeId,
        deliveryMode: record.deliveryMode,
        metadata: { pid: record.pid, providerId },
      });
    }
    this.runtimeDirectory.registerAgent({
      teamId: record.teamId,
      agentId: record.agentId,
      runtimeId: record.runtimeId,
      deliveryMode: record.deliveryMode,
      metadata: { pid: record.pid, providerId },
    });
  }

  #attachExitListener(record) {
    if (record.child && typeof record.child.once === 'function') {
      record.child.once('exit', (code, signal) => this.#markExited(record.runtimeId, code, signal));
    }
  }

  #requireRuntime(runtimeId) {
    const id = requireString(runtimeId, 'runtimeId');
    const record = this.#runtimes.get(id);
    if (!record) throw new Error(`unknown runtime: ${id}`);
    return record;
  }

  #snapshot(record) {
    return {
      runtimeId: record.runtimeId,
      teamId: record.teamId,
      agentId: record.agentId,
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      deliveryMode: record.deliveryMode,
      status: record.status,
      pid: record.pid,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      restartCount: record.restartCount,
    };
  }
}

function createClaudeAdapter({ runtimeId, teamId, agentId, child }) {
  return new ClaudeStreamJsonAdapter({ runtimeId, teamId, agentId, child });
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeRestartPolicy(policy) {
  const maxRestarts = Number.isInteger(policy?.maxRestarts) ? policy.maxRestarts : 0;
  return {
    maxRestarts: Math.max(0, maxRestarts),
  };
}
