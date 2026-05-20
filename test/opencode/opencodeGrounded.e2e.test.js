// SP1c Task-6 — GROUNDED FRONT-LOADED END-TO-END PROOF.
//
// Mirrors the SP1b gemini e2e precedent (test/gemini/geminiGrounded.e2e.test.js)
// for opencode-cli 1.15.4: a scripted stand-in
// (test/fixtures/fake-opencode-grounded.mjs) is driven through the REAL
// OpencodeExecAdapter via the production spawn path (injected spawnImpl
// pointing node at the fixture, exactly as production spawns `opencode`). The
// fixture emits the EXACT grounding-doc §8 `opencode run --format json`
// vocabulary (step_start / text / step_finish, top-level envelope
// {type,timestamp,sessionID,part}) with **CRLF `\r\n` line endings** (real
// opencode 1.15.4 output is `\r\n`-terminated), carries the `ses_*` id in the
// top-level `sessionID` of every event from line 1, echoes back a passed
// `--session <id>` on resume, and makes one real on-disk side effect.
//
// The unit under test is NOT mocked: real OpencodeExecAdapter + real
// normalizeOpencodeStreamLine + real RuntimeEventIngestor + real
// InMemoryBroker. This proves the full seam adapter -> normalizer ->
// ingestor: the grounded `assistant_text` becomes a real broker reply
// message (the message-delivery proof at the gemini precedent's level — the
// gemini fixture's honest equivalent is the ingestor turning assistant_text
// into a delivered broker reply; opencode's real §8 turn likewise has no
// tool/mcp events, so the same honest equivalent applies). Additionally
// proves the grounded defect fix: the prompt is delivered as a POSITIONAL
// argv arg, NOT stdin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';
import { RuntimeEventIngestor } from '../../src/runtime/RuntimeEventIngestor.js';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';

class MemoryEventLog {
  constructor() { this.events = []; }
  appendEvent(input) {
    const existing = this.events.find((e) => e.idempotencyKey === input.idempotencyKey);
    if (existing) return { inserted: false, event: existing };
    const event = { eventId: `event-${this.events.length + 1}`, ...input };
    this.events.push(event);
    return { inserted: true, event };
  }
}

test('GROUNDED E2E PROOF: opencode 1.15.4 §8 turn boots, carries the ses_* sessionID from line 1, side-effects a file, delivers the prompt as a POSITIONAL argv arg, and the grounded assistant_text becomes a real broker reply through the real ingestor', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'opencode-grounded-'));
  const fake = path.resolve('test/fixtures/fake-opencode-grounded.mjs');
  let child;
  let spawnArgs = null;
  let spawnStdinWrites = '';
  const m = new Map();
  const sessionStore = {
    get: (id) => (m.has(id) ? m.get(id) : null),
    set: (id, v) => m.set(id, v),
    clear: (id) => m.set(id, null),
  };
  const adapter = new OpencodeExecAdapter({
    runtimeId: 'r1', teamId: 'team-a', agentId: 'dev-1', cwd: work,
    systemPrompt: 'You are dev-1.',
    args: ['--model', 'deepseek/deepseek-chat'],
    // Drive the stand-in via real spawn, exactly as production spawns
    // `opencode`, but pointing node at the fixture. Keep a handle on the
    // child so we can await its exit before cleanup (Windows holds a handle
    // on the temp dir, racing rm() into intermittent EBUSY). Capture the
    // production argv so we can prove the message is a POSITIONAL arg, and
    // tap stdin writes to prove the prompt was NOT delivered via stdin.
    spawnImpl: (_cmd, args, opts) => {
      spawnArgs = args;
      child = spawn(process.execPath, [fake, ...args], opts);
      const origEnd = child.stdin && child.stdin.end ? child.stdin.end.bind(child.stdin) : null;
      const origWrite = child.stdin && child.stdin.write ? child.stdin.write.bind(child.stdin) : null;
      if (child.stdin) {
        child.stdin.write = (chunk, ...rest) => {
          if (chunk != null) spawnStdinWrites += Buffer.from(chunk).toString('utf8');
          return origWrite ? origWrite(chunk, ...rest) : true;
        };
        child.stdin.end = (chunk, ...rest) => {
          if (chunk != null && typeof chunk !== 'function') spawnStdinWrites += Buffer.from(chunk).toString('utf8');
          return origEnd ? origEnd(chunk, ...rest) : undefined;
        };
      }
      return child;
    },
    resolveCliImpl: (n) => n,
    sessionStore,
  });

  try {
    // Real ingestor + real broker — no mocks on the unit under test.
    const broker = new InMemoryBroker();
    const eventLog = new MemoryEventLog();
    const ingestor = new RuntimeEventIngestor({ broker, eventLog });

    const seen = [];
    const it = adapter.events()[Symbol.asyncIterator]();
    const pump = (async () => {
      for (;;) {
        const n = await it.next();
        if (n.done) break;
        seen.push(n.value);
        await ingestor.ingest(n.value);
      }
    })();

    const res = await adapter.sendTurn({ message: { text: 'do the grounded task' } });
    await adapter.stop();
    await pump;
    if (child && child.exitCode === null && !child.killed) {
      await new Promise((r) => { child.once('exit', r); child.once('close', r); setTimeout(r, 2000); });
    }

    // sendTurn resolved accepted (resolved on the grounded step_finish ->
    // turn_completed terminal event).
    assert.equal(res.accepted, true);
    assert.equal(res.responseState, 'accepted_by_runtime');

    // The grounded §8 vocabulary surfaced through the real normalizer, in
    // order: session_started -> assistant_text -> turn_completed.
    const types = seen.map((e) => e.type);
    const iSession = types.indexOf('session_started');
    const iText = types.indexOf('assistant_text');
    const iDone = types.indexOf('turn_completed');
    assert.ok(iSession !== -1, 'session_started must be surfaced from the §8 step_start event');
    assert.ok(iText !== -1, 'assistant_text must be surfaced from the §8 text event');
    assert.ok(iDone !== -1, 'turn_completed must be surfaced from the §8 step_finish event');
    assert.ok(iSession < iText && iText < iDone,
      `grounded events must be ordered session_started < assistant_text < turn_completed (got ${types.join(',')})`);

    // session_started carries the §8 top-level `sessionID` (ses_* format),
    // present on line 1, captured into the sessionStore for --session resume.
    const sessionEv = seen[iSession];
    assert.equal(sessionEv.sessionId, 'ses_1c2b157c3ffesws2xivZl0UA5M',
      'session_started.sessionId must be the §8 top-level sessionID (ses_* format)');
    assert.equal(sessionStore.get('r1'), 'ses_1c2b157c3ffesws2xivZl0UA5M',
      'the line-1 top-level sessionID must be captured into the sessionStore for --session resume');

    // assistant_text carries the grounded reply text, which echoes the
    // prompt — proving the prompt reached the fixture (positional arg path).
    assert.ok(seen[iText].text.includes('grounded opencode ok'));

    // GROUNDED DEFECT-FIX PROOF: the message is the FINAL POSITIONAL argv
    // element (§7/§10 CONFIRMED), NOT delivered via stdin.
    assert.ok(Array.isArray(spawnArgs), 'production spawn argv must have been captured');
    assert.ok(spawnArgs.includes('--model'), 'args must include --model');
    assert.ok(spawnArgs.includes('deepseek/deepseek-chat'), 'args must include model value');
    assert.ok(spawnArgs[spawnArgs.length - 1].startsWith('You are dev-1.'),
      'the prompt (with probe instruction) must be the final POSITIONAL argv element');
    assert.equal(spawnStdinWrites, '',
      'the prompt must NOT be written to child.stdin (grounded stdin->positional defect fix)');

    // Real on-disk side effect performed by the stand-in (gemini-precedent
    // fixture depth — exactly one writeFileSync, no more no less).
    assert.ok(
      (await readFile(path.join(work, 'opencode-proof.txt'), 'utf8')).startsWith('prompt:You are dev-1.'),
    );

    // THE SEAM PROOF: the grounded assistant_text, fed through the REAL
    // RuntimeEventIngestor, became a real delivered broker reply (the
    // message-delivery proof at the gemini precedent's level).
    const inbox = broker.listInbox({ teamId: 'team-a', recipient: { kind: 'user' } });
    assert.equal(inbox.length, 1, 'exactly one broker reply must be delivered from the grounded turn');
    assert.equal(inbox[0].kind, 'reply');
    assert.equal(inbox[0].from.id, 'dev-1');
    assert.ok(inbox[0].text.includes('grounded opencode ok'));
    assert.equal(inbox[0].metadata.runtimeId, 'r1');

    // The ingestor audit-logged every surfaced grounded event.
    assert.equal(eventLog.events.length, seen.length);
    assert.ok(eventLog.events.some((e) => e.eventType === 'turn_completed'));
  } finally {
    if (child && child.exitCode === null && !child.killed) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
