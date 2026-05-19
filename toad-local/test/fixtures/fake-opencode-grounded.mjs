#!/usr/bin/env node
// SP1c Task-6 grounded e2e proof stand-in for `opencode`. Not a real model —
// it emits the EXACT opencode-cli 1.15.4 `opencode run --format json`
// vocabulary captured verbatim in the grounding doc §8/§10
// (docs/superpowers/grounding/2026-05-18-opencode-cli.md): NDJSON on stdout,
// **CRLF (`\r\n`) line endings**, the 3-event top-level envelope
// `{type,timestamp,sessionID,part}` for one turn — `step_start` / `text` /
// `step_finish`. Per §7/§10 the message is a CONFIRMED-working POSITIONAL
// argv arg (NOT stdin), so this fixture reads the prompt from the FINAL
// positional argv element (the Task-4 RATIFIED argv shape) — never stdin.
//
// Session model (grounding §9/§10): the `ses_*` id is carried in the
// TOP-LEVEL `sessionID` field of EVERY event, starting with line-1
// `step_start`, and that exact id is what `--session <id>` accepts on resume.
// First turn: emit a deterministic `ses_*` id. Resume turn: if the Task-4
// resume argv passed `--session <ses_* id>`, echo THAT id back in every
// event's top-level `sessionID` (models opencode continuing the session).
//
// Mirrors fake-gemini-grounded.mjs depth (no more, no less): exactly ONE
// real on-disk side effect (writes the received prompt to a proof file under
// cwd) so the real adapter -> normalizer -> ingestor seam is proven without a
// real opencode binary, network, or model tokens. Argv shape mirrors the
// Task-4 RATIFIED first-turn / resume arrays (it is invoked as:
//   node fake-opencode-grounded.mjs run --format json
//        --dangerously-skip-permissions [--session <ses_*>] ...modelArgs
//        '<message-positional>').
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);

// §7/§10: the prompt is the FINAL POSITIONAL argv element (the Task-4
// adapter appends `message` last after run/--format/--session/model flags).
// It is NOT delivered via stdin. The final argv element is the message.
const message = argv.length > 0 ? String(argv[argv.length - 1]) : '';

// §9/§10: resume passes `--session <ses_* id>`; opencode then continues that
// session and every stream event carries that same top-level `sessionID`.
// First turn assigns/uses a new id — emit a deterministic stand-in.
const sIdx = argv.indexOf('--session');
const sessionId =
  sIdx !== -1 && typeof argv[sIdx + 1] === 'string'
    ? argv[sIdx + 1]
    : 'ses_1c2b157c3ffesws2xivZl0UA5M';

// Real on-disk side effect (mirrors fake-gemini-grounded.mjs writeFileSync
// depth — no more, no less): proves the spawn delivered the positional
// message to this process and the seam ran a real turn.
try {
  writeFileSync(join(process.cwd(), 'opencode-proof.txt'), `prompt:${message}\n`);
} catch { /* ignore */ }

// The grounded §8 reply echoes the positional message so the e2e can prove
// the prompt was delivered as a POSITIONAL arg (not stdin) all the way
// through the real normalizer into a real broker reply.
const replyText = `grounded opencode ok \u27E6TOAD_MCP_OK\u27E7: ${message}`;

const ms = () => Date.now();
// §8 verbatim NDJSON, in order, with CRLF (`\r\n`) line endings (real
// opencode 1.15.4 output is `\r\n`-terminated): step_start (carries the
// top-level ses_* sessionID from line 1) -> text (assistant content in
// part.text) -> step_finish (terminal; usage in part.tokens, cost part.cost).
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\r\n`);

emit({
  type: 'step_start',
  timestamp: ms(),
  sessionID: sessionId,
  part: {
    id: 'prt_e3d4eaeee001NYz21Z2zReMg4L',
    messageID: 'msg_e3d4ea990001B5s6x35rDX65dV',
    sessionID: sessionId,
    snapshot: '41ef9149af1a23d082407235a255f95d2ce5055f',
    type: 'step-start',
  },
});
emit({
  type: 'text',
  timestamp: ms(),
  sessionID: sessionId,
  part: {
    id: 'prt_e3d4eb12e001rt368WFpUuD0F6',
    messageID: 'msg_e3d4ea990001B5s6x35rDX65dV',
    sessionID: sessionId,
    type: 'text',
    text: replyText,
    time: { start: ms(), end: ms() },
  },
});
emit({
  type: 'step_finish',
  timestamp: ms(),
  sessionID: sessionId,
  part: {
    id: 'prt_e3d4eb54e001H0z1go82mXiheA',
    reason: 'stop',
    snapshot: '41ef9149af1a23d082407235a255f95d2ce5055f',
    messageID: 'msg_e3d4ea990001B5s6x35rDX65dV',
    sessionID: sessionId,
    type: 'step-finish',
    tokens: { total: 7505, input: 7504, output: 1, reasoning: 0, cache: { write: 0, read: 0 } },
    cost: 0.00105084,
  },
});
process.exit(0);
