// SP1b Task-6 — GROUNDED FRONT-LOADED END-TO-END PROOF.
//
// Mirrors the codex e2e precedent (test/codex/codexEndToEndProof.test.js +
// test/codex/codexStage2.e2e.test.js) for gemini-cli 0.42.0: a scripted
// stand-in (test/fixtures/fake-gemini-grounded.mjs) is driven through the
// REAL GeminiExecAdapter via the production spawn path (injected spawnImpl
// pointing node at the fixture, exactly as production spawns `gemini`). The
// fixture emits the EXACT grounding-doc §8 `--output-format stream-json`
// vocabulary (two non-JSON notices then init/message/result NDJSON), echoes
// back the adapter-generated `--session-id` UUID in `init.session_id`, and
// makes one real on-disk side effect.
//
// The unit under test is NOT mocked: real GeminiExecAdapter + real
// normalizeGeminiStreamLine + real RuntimeEventIngestor + real
// InMemoryBroker. This proves the full seam adapter -> normalizer ->
// ingestor: the grounded `assistant_text` becomes a real broker reply
// message (the message-delivery proof at the codex precedent's level —
// the codex fixture emits an mcp/message vocabulary item; gemini's real
// §8 turn has no tool/mcp events, so the honest equivalent is the
// ingestor turning assistant_text into a delivered broker reply).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GeminiExecAdapter } from '../../src/runtime/GeminiExecAdapter.js';
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

test('GROUNDED E2E PROOF: gemini 0.42.0 §8 turn boots, echoes --session-id, side-effects a file, and the grounded assistant_text becomes a real broker reply through the real ingestor', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'gemini-grounded-'));
  const fake = path.resolve('test/fixtures/fake-gemini-grounded.mjs');
  let child;
  const GENERATED_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const m = new Map();
  const sessionStore = {
    get: (id) => (m.has(id) ? m.get(id) : null),
    set: (id, v) => m.set(id, v),
    clear: (id) => m.set(id, null),
  };
  const adapter = new GeminiExecAdapter({
    runtimeId: 'r1', teamId: 'team-a', agentId: 'dev-1', cwd: work,
    systemPrompt: 'You are dev-1.',
    // Drive the stand-in via real spawn, exactly as production spawns
    // `gemini`, but pointing node at the fixture. Keep a handle on the
    // child so we can await its exit before cleanup (Windows holds a
    // handle on the temp dir, racing rm() into intermittent EBUSY).
    spawnImpl: (_cmd, args, opts) => { child = spawn(process.execPath, [fake, ...args], opts); return child; },
    resolveCliImpl: (n) => n,
    sessionStore,
    uuidImpl: () => GENERATED_UUID,
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

    // sendTurn resolved accepted (resolved on the grounded result:success
    // -> turn_completed terminal event).
    assert.equal(res.accepted, true);
    assert.equal(res.responseState, 'accepted_by_runtime');

    // The grounded §8 vocabulary surfaced through the real normalizer, in
    // order: session_started -> assistant_text -> turn_completed.
    const types = seen.map((e) => e.type);
    const iSession = types.indexOf('session_started');
    const iText = types.indexOf('assistant_text');
    const iDone = types.indexOf('turn_completed');
    assert.ok(iSession !== -1, 'session_started must be surfaced from the §8 init event');
    assert.ok(iText !== -1, 'assistant_text must be surfaced from the §8 assistant message');
    assert.ok(iDone !== -1, 'turn_completed must be surfaced from the §8 result:success');
    assert.ok(iSession < iText && iText < iDone,
      `grounded events must be ordered session_started < assistant_text < turn_completed (got ${types.join(',')})`);

    // session_started carries the adapter-generated UUID, echoed back by
    // the fixture in init.session_id (grounding §10 Option 3).
    const sessionEv = seen[iSession];
    assert.equal(sessionEv.sessionId, GENERATED_UUID,
      'init.session_id must echo the adapter-generated --session-id UUID');
    assert.equal(sessionStore.get('r1'), GENERATED_UUID,
      'the echoed session id must be captured into the sessionStore as confirmation');

    // assistant_text carries the grounded reply text.
    assert.ok(seen[iText].text.includes('grounded gemini ok'));

    // Real on-disk side effect performed by the stand-in (codex-precedent
    // fixture depth).
    assert.equal(
      (await readFile(path.join(work, 'gemini-proof.txt'), 'utf8')).startsWith('prompt:'),
      true,
    );

    // THE SEAM PROOF: the grounded assistant_text, fed through the REAL
    // RuntimeEventIngestor, became a real delivered broker reply (the
    // message-delivery proof at the codex precedent's level).
    const inbox = broker.listInbox({ teamId: 'team-a', recipient: { kind: 'user' } });
    assert.equal(inbox.length, 1, 'exactly one broker reply must be delivered from the grounded turn');
    assert.equal(inbox[0].kind, 'reply');
    assert.equal(inbox[0].from.id, 'dev-1');
    assert.ok(inbox[0].text.includes('grounded gemini ok'));
    assert.equal(inbox[0].metadata.runtimeId, 'r1');

    // The ingestor audit-logged every surfaced grounded event.
    assert.equal(eventLog.events.length, seen.length);
    assert.ok(eventLog.events.some((e) => e.eventType === 'turn_completed'));
  } finally {
    if (child && child.exitCode === null && !child.killed) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
