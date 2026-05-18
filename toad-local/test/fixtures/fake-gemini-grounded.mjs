#!/usr/bin/env node
// SP1b Task-6 grounded e2e proof stand-in for `gemini`. Not a real model —
// it emits the EXACT gemini-cli 0.42.0 `--output-format stream-json`
// vocabulary captured verbatim in the grounding doc §8
// (docs/superpowers/grounding/2026-05-18-gemini-cli.md): two NON-JSON
// notice lines on stdout, then NDJSON `init` / user-echo `message` /
// assistant `message` / `result` success. It echoes back the
// `--session-id <uuid>` it was spawned with in the `init.session_id`
// field (grounding §10 RATIFIED Option 3: the adapter controls the UUID
// and gemini echoes it), and — mirroring fake-codex.mjs / fake-codex-
// stage2.mjs depth (no more, no less) — performs ONE real on-disk side
// effect (writes the prompt it received to a proof file under cwd) so the
// adapter -> normalizer -> ingestor seam is proven without a real gemini
// binary, network, or model usage. Argv shape mirrors the Task-4 RATIFIED
// first-turn array (it is invoked as:
//   node fake-gemini-grounded.mjs --output-format stream-json
//        --approval-mode yolo --skip-trust
//        --allowed-mcp-server-names toad-local --session-id <uuid>
//        -p 'Follow the instructions above.').
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const sidIdx = argv.indexOf('--session-id');
// §10: the first turn passes a caller-generated UUID via --session-id and
// the real gemini `init` event echoes it back in `session_id`. A resume
// turn passes `--resume latest` instead (no --session-id); in that case
// gemini assigns/continues its own session id — emit a stable stand-in.
const sessionId =
  sidIdx !== -1 && typeof argv[sidIdx + 1] === 'string'
    ? argv[sidIdx + 1]
    : 'd7108a26-61db-4261-9865-549ab9d788e6';

let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const prompt = stdin.trim();
  // Real on-disk side effect (mirrors fake-codex.mjs writeFileSync depth).
  try { writeFileSync(join(process.cwd(), 'gemini-proof.txt'), `prompt:${prompt}\n`); } catch { /* ignore */ }

  const iso = () => new Date().toISOString();
  // §8 verbatim: two NON-JSON notice lines on stdout BEFORE the NDJSON.
  process.stdout.write(
    'Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.\n',
  );
  process.stdout.write('Ripgrep is not available. Falling back to GrepTool.\n');

  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  // §8 NDJSON, in order: init (echoes --session-id uuid) -> user echo
  // message -> assistant message (delta:true) -> result success w/ stats.
  emit({ type: 'init', timestamp: iso(), session_id: sessionId, model: 'auto-gemini-3' });
  emit({ type: 'message', timestamp: iso(), role: 'user', content: prompt });
  emit({
    type: 'message',
    timestamp: iso(),
    role: 'assistant',
    content: 'grounded gemini ok',
    delta: true,
  });
  emit({
    type: 'result',
    timestamp: iso(),
    status: 'success',
    stats: {
      total_tokens: 10400,
      input_tokens: 10284,
      output_tokens: 1,
      cached: 0,
      input: 10284,
      duration_ms: 3759,
      tool_calls: 0,
      models: {
        'gemini-3.1-pro-preview': {
          total_tokens: 10400,
          input_tokens: 10284,
          output_tokens: 1,
          cached: 0,
          input: 10284,
        },
      },
    },
  });
  process.exit(0);
});
