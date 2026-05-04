import { join } from 'node:path';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

// Project resolution:
//   - TOAD_PROJECT_CWD env (set by the Tauri shell when the user picks a
//     folder) wins. An empty string is meaningful — it means "the user
//     hasn't picked a project yet" and we start in degraded "no project
//     loaded" mode.
//   - When the env var is *unset* (e.g. running `npm run api:dev` directly
//     from a development checkout), fall back to process.cwd() so
//     contributors can keep working without the Tauri shell.
const envCwd = process.env.TOAD_PROJECT_CWD;
const projectCwd =
  typeof envCwd === 'string'
    ? (envCwd.length > 0 ? envCwd : null)
    : process.cwd();
const dbPath =
  process.env.TOAD_DB_PATH ||
  (projectCwd ? join(projectCwd, '.toad', 'toad.db') : ':memory:');
const runtime = new LocalToadRuntime({ projectCwd, dbPath });

await runtime.start();

const port = process.env.TOAD_API_PORT || '3001';
console.log(`Symphony AI API listening on http://127.0.0.1:${port}`);
if (projectCwd) {
  console.log(`Symphony AI project at ${projectCwd}`);
} else {
  console.log('Symphony AI running with no project loaded — pick a folder in the UI to begin.');
}
console.log(`Symphony AI database at ${dbPath}`);

async function shutdown() {
  await runtime.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.stdin.resume();
