import { LocalToadRuntime } from '../app/LocalToadRuntime.js';

export function createMcpActorFromEnv(env = process.env) {
  const actor = {
    teamId: envString(env.TOAD_TEAM_ID, 'local'),
    agentId: envString(env.TOAD_AGENT_ID, 'operator'),
  };
  const role = envString(env.TOAD_AGENT_ROLE, null);
  if (role) actor.role = role;
  return actor;
}

export function createMcpRuntimeFromEnv(env = process.env) {
  return new LocalToadRuntime({
    dbPath: envString(env.TOAD_DB_PATH, ':memory:'),
    projectCwd: envString(env.TOAD_PROJECT_CWD, null),
    port: 0,
  });
}

function envString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
