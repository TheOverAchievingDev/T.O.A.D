// Canonical root test runner.
//
// WHY THIS EXISTS (§8d ratification, Readability Layer-2 P3a): the root
// suite is a fail-fast sequential chain of ~141 `node … test/*.test.js`
// invocations. It used to live verbatim in package.json `scripts.test`
// as a single `cmd1 && cmd2 && … && cmdN` string. On Windows, npm runs
// that string through cmd.exe, whose command-line hard limit is ~8191
// chars. At P2b the chain was 8006 chars (97.7% of the ceiling); P3a's
// additions pushed it to 8193 — over the limit — and `npm test` failed
// with `The command line is too long.` (NOT a test failure).
//
// Fix: the verbatim ordered chain now lives in scripts/test-suites.txt
// (plain text — no command-line-length ceiling). This runner splits it
// on ` && ` and runs each command sequentially with the SAME shell,
// preserving the EXACT prior semantics: same commands, same flags, same
// order, fail-fast on the first non-zero exit, overall exit code = the
// first failing command's (or 0 if all pass). Future suites are appended
// to test-suites.txt with ` && node …` exactly as before.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chain = readFileSync(join(here, 'test-suites.txt'), 'utf8').trim();
const commands = chain
  .split(' && ')
  .map((c) => c.trim())
  .filter(Boolean);

for (const cmd of commands) {
  const res = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(typeof res.status === 'number' ? res.status : 1);
  }
}
process.exit(0);
