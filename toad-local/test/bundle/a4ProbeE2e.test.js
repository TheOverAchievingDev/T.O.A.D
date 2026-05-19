/**
 * A4 Task 5 — Scripted broken/healthy-rail e2e for all 3 session adapters.
 *
 * For each adapter, uses the real adapter + normalizer + ingestor + broker
 * seam, driven through the existing grounded fixtures with an A4_MODE env var:
 *   - A4_MODE=healthy  → fixture emits sentinel → turn_completed accepted
 *   - A4_MODE=broken   → fixture omits sentinel → turn_failed loud
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';
import { GeminiExecAdapter } from '../../src/runtime/GeminiExecAdapter.js';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';
import { RuntimeEventIngestor } from '../../src/runtime/RuntimeEventIngestor.js';
import { InMemoryBroker } from '../../src/broker/inMemoryBroker.js';

const DETERMINISTIC_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

async function withTempDir(fn) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'a4probe-'));
  try { await fn(work); }
  finally { await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

async function driveAdapter(AdapterClass, fixturePath, extraArgs, mode, work, opts = {}) {
  const m = new Map();
  const sessionStore = { get: (id) => (m.has(id) ? m.get(id) : null), set: (id, v) => m.set(id, v), clear: (id) => m.set(id, null) };
  const adapter = new AdapterClass({
    runtimeId: 'r1', teamId: 'team-a', agentId: 'dev-1', cwd: work,
    systemPrompt: 'You are dev-1.',
    spawnImpl: (_cmd, args, spawnOpts) => {
      const child = spawn(process.execPath, [fixturePath, ...args], {
        ...spawnOpts,
        env: { ...process.env, A4_MODE: mode },
      });
      return child;
    },
    resolveCliImpl: (n) => n,
    sessionStore,
    uuidImpl: () => DETERMINISTIC_UUID,
    ...opts,
  });

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

  const res = await adapter.sendTurn({ message: { text: 'do the task' } });
  await adapter.stop();
  await pump;

  return { res, seen, broker };
}

// ── CODEX broken + healthy ──

test('A4 e2e: Codex broken rail → turn_failed(loud)', async () => {
  await withTempDir(async (work) => {
    const fixture = path.resolve('test/fixtures/fake-codex.mjs');
    const { res, seen } = await driveAdapter(CodexExecAdapter, fixture, [], 'broken', work);
    assert.equal(res.accepted, false);
    const failed = seen.find((e) => e.type === 'turn_failed');
    assert.ok(failed, 'turn_failed event was pushed');
    assert.match(failed.error, /TOAD tools unavailable/);
  });
});

test('A4 e2e: Codex healthy rail → accepted', async () => {
  await withTempDir(async (work) => {
    const fixture = path.resolve('test/fixtures/fake-codex.mjs');
    const { res, seen } = await driveAdapter(CodexExecAdapter, fixture, [], 'healthy', work);
    assert.equal(res.accepted, true);
    assert.ok(seen.some((e) => e.type === 'assistant_text'), 'assistant_text surfaced');
    assert.ok(seen.some((e) => e.type === 'turn_completed'), 'turn_completed surfaced');
  });
});

// ── GEMINI broken + healthy ──

test('A4 e2e: Gemini broken rail → turn_failed(loud)', async () => {
  await withTempDir(async (work) => {
    const fixture = path.resolve('test/fixtures/fake-gemini-grounded.mjs');
    const { res, seen } = await driveAdapter(GeminiExecAdapter, fixture, [], 'broken', work, { uuidImpl: () => DETERMINISTIC_UUID });
    assert.equal(res.accepted, false);
    const failed = seen.find((e) => e.type === 'turn_failed');
    assert.ok(failed, 'turn_failed event was pushed');
    assert.match(failed.error, /TOAD tools unavailable/);
  });
});

test('A4 e2e: Gemini healthy rail → accepted', async () => {
  await withTempDir(async (work) => {
    const fixture = path.resolve('test/fixtures/fake-gemini-grounded.mjs');
    const { res, seen } = await driveAdapter(GeminiExecAdapter, fixture, [], 'healthy', work, { uuidImpl: () => DETERMINISTIC_UUID });
    assert.equal(res.accepted, true);
    assert.ok(seen.some((e) => e.type === 'assistant_text'), 'assistant_text surfaced');
    assert.ok(seen.some((e) => e.type === 'turn_completed'), 'turn_completed surfaced');
  });
});

// ── OPENCODE broken + healthy ──

test('A4 e2e: OpenCode broken rail → turn_failed(loud)', async () => {
  await withTempDir(async (work) => {
    const fixture = path.resolve('test/fixtures/fake-opencode-grounded.mjs');
    const { res, seen } = await driveAdapter(OpencodeExecAdapter, fixture, [], 'broken', work);
    assert.equal(res.accepted, false);
    const failed = seen.find((e) => e.type === 'turn_failed');
    assert.ok(failed, 'turn_failed event was pushed');
    assert.match(failed.error, /TOAD tools unavailable/);
  });
});

test('A4 e2e: OpenCode healthy rail → accepted', async () => {
  await withTempDir(async (work) => {
    const fixture = path.resolve('test/fixtures/fake-opencode-grounded.mjs');
    const { res, seen } = await driveAdapter(OpencodeExecAdapter, fixture, [], 'healthy', work);
    assert.equal(res.accepted, true);
    assert.ok(seen.some((e) => e.type === 'assistant_text'), 'assistant_text surfaced');
    assert.ok(seen.some((e) => e.type === 'turn_completed'), 'turn_completed surfaced');
  });
});
