export class RuntimeIdentityValidator {
  constructor({ runtimeRegistry = null } = {}) {
    this.runtimeRegistry = runtimeRegistry;
  }

  assertCanWrite(event) {
    if (!this.runtimeRegistry || typeof this.runtimeRegistry.getRuntime !== 'function') {
      return;
    }

    const runtime = this.runtimeRegistry.getRuntime(requireString(event.runtimeId, 'event.runtimeId'));
    if (!runtime) {
      throw new Error(`unknown runtime identity: ${event.runtimeId}`);
    }
    if (runtime.teamId !== event.teamId || runtime.agentId !== event.agentId) {
      throw new Error(`runtime identity mismatch: ${event.runtimeId}`);
    }
    if (runtime.status !== 'running') {
      throw new Error(`runtime is not running: ${event.runtimeId}`);
    }
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
