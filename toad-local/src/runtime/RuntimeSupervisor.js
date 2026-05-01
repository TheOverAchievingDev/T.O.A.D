import { spawn } from 'node:child_process';
import { ClaudeStreamJsonAdapter } from './ClaudeStreamJsonAdapter.js';

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
    if (this.#runtimes.has(runtimeId)) {
      throw new Error(`runtime already launched: ${runtimeId}`);
    }

    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const stdio = input.stdio || ['pipe', 'pipe', 'pipe'];
    const child = this.spawnProcess(command, args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env || {}) },
      stdio,
    });
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
