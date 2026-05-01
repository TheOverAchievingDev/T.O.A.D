import { join } from 'node:path';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

const projectCwd = process.cwd();
const dbPath = process.env.TOAD_DB_PATH || join(projectCwd, '.toad', 'toad.db');
const runtime = new LocalToadRuntime({ projectCwd, dbPath });

await runtime.start();

const port = process.env.TOAD_API_PORT || '3001';
console.log(`TOAD API listening on http://127.0.0.1:${port}`);
console.log(`TOAD database at ${dbPath}`);

async function shutdown() {
  await runtime.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.stdin.resume();
