#!/usr/bin/env node
// SP1a Stage-1 proof stand-in for `codex exec`. Not a real model — it
// emits the exact codex --json vocabulary CodexExecAdapter parses,
// makes a real file change, and reports an MCP tool call, so the
// adapter → normalized-event chain can be proven without a real codex
// binary, network, or model usage. Argv shape mirrors the adapter's
// (it is invoked as: node fake-codex.mjs exec --json ... -C <cwd> ... -).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cwdIdx = process.argv.indexOf('-C');
const cwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : process.cwd();
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'thread.started', thread_id: 'proof-session-1' });
  try { writeFileSync(join(cwd, 'proof.txt'), `prompt:${stdin.trim()}\n`); } catch { /* ignore */ }
  emit({ type: 'item.completed', item: { type: 'file_change', path: 'proof.txt' } });
  emit({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'toad', tool: 'message_send' } });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: process.env.A4_MODE === 'broken' ? 'task done' : 'task done \u27E6TOAD_MCP_OK\u27E7' } });
  emit({ type: 'turn.completed' });
  process.exit(0);
});
