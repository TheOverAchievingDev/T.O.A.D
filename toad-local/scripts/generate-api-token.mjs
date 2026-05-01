import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';

const projectCwd = process.cwd();
const tokenDir = join(projectCwd, '.toad');
const tokenPath = join(tokenDir, 'api-token');
const token = randomBytes(32).toString('hex');

mkdirSync(tokenDir, { recursive: true });
writeFileSync(tokenPath, token + '\n', 'utf8');

if (platform() !== 'win32') {
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // best effort; on filesystems that don't support POSIX mode we just continue
  }
}

console.log(`API token written to ${tokenPath}`);
console.log('');
console.log('The orchestrator picks this up automatically when projectCwd is set.');
console.log('The dashboard\'s Vite build still needs the token at build time:');
console.log('');
console.log('  PowerShell:  $env:VITE_TOAD_API_TOKEN=' + JSON.stringify(token));
console.log('  bash:        export VITE_TOAD_API_TOKEN=' + JSON.stringify(token));
console.log('');
console.log('Token (copy if you need it): ' + token);
