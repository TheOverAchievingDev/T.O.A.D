#!/usr/bin/env node
// SP1a Stage-2 proof stand-in. Honours `codex exec` (first turn) vs
// `codex exec resume <id>` (resume) and emits the real 0.130 --json
// vocabulary. First turn writes turn1.txt + emits thread.started(sess);
// resume appends to it + re-emits thread.started with the SAME id.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const isResume = argv[0] === 'exec' && argv[1] === 'resume';
const cIdx = argv.indexOf('-C');
const cwd = cIdx !== -1 ? argv[cIdx + 1] : process.cwd();
const SESSION = 'stage2-sess-1';
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'thread.started', thread_id: SESSION }); // resume re-emits SAME id
  emit({ type: 'turn.started' });
  try {
    if (isResume) { appendFileSync(join(cwd, 'turn1.txt'), '\nBETA'); }
    else { writeFileSync(join(cwd, 'turn1.txt'), 'ALPHA'); }
  } catch { /* ignore */ }
  emit({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'turn1.txt', kind: isResume ? 'update' : 'add' }] } });
  emit({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: isResume ? 'appended' : 'created \u27E6TOAD_MCP_OK\u27E7' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
  process.exit(0);
});
