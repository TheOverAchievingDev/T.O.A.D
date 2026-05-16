import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { narrate } from '../src/runtime/eventNarration/index.js';

const fxDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const events = JSON.parse(readFileSync(join(fxDir, 'eventNarration.events.json'), 'utf8'));
const feedGolden = JSON.parse(readFileSync(join(fxDir, 'eventNarration.feedGolden.json'), 'utf8'));
const cardGolden = JSON.parse(readFileSync(join(fxDir, 'eventNarration.cardGolden.json'), 'utf8'));
const table = JSON.parse(readFileSync(join(fxDir, 'eventNarration.behaviorTable.json'), 'utf8'));

const toStreamKind = (k) => ({ tool: 'tool', text: 'output', system: 'system' }[k]);
const toCardKind = (k) => ({ tool: 'tool', text: 'text', system: 'thinking' }[k]);

function salient(e) {
  return {
    toolName: (e && e.toolName) ?? null,
    file_path: (e && e.input && e.input.file_path) ?? null,
    command: (e && e.input && e.input.command) ?? null,
    subtype: (e && e.raw && e.raw.subtype) ?? null,
  };
}
function sig(e) {
  return createHash('sha1').update(`${e && e.type} ${JSON.stringify(salient(e))}`).digest('hex');
}

// Comparison scope (spec §5, whole-impl-review ratification): only the
// event types the wired consumers actually source from narrate(). Both
// consumers keep their own runtime_event handling (§4.4), so narrate's
// runtime_event output is never live in Slice 1 — comparing it would
// assert a behavior the UI does not have. Excluded (golden kept for
// provenance/coverage, not a ruled divergence).
const NARRATED_TYPES = new Set(['tool_use', 'assistant_text', 'turn_completed', 'approval_request']);

test('agreement: adapted narrate() vs committed goldens (ruled divergences only)', () => {
  const divergences = [];
  events.forEach((e, i) => {
    if (!(e && NARRATED_TYPES.has(e.type))) return;
    const n = narrate(e);
    const newFeed = feedGolden[i] === null ? null : { line: n.line, kind: toStreamKind(n.kind) };
    const newCard = cardGolden[i] === null ? null : { line: n.line, kind: toCardKind(n.kind) };
    const feedDiff = JSON.stringify(newFeed) !== JSON.stringify(feedGolden[i]);
    const cardDiff = JSON.stringify(newCard) !== JSON.stringify(cardGolden[i]);
    if (feedDiff || cardDiff) {
      divergences.push({
        signature: sig(e), eventType: e && e.type, salient: salient(e),
        feed: { old: feedGolden[i], new: newFeed }, card: { old: cardGolden[i], new: newCard },
      });
    }
  });

  const ruled = new Set(Object.keys(table.entries || {}));
  const unaccounted = divergences.filter((d) => {
    const en = table.entries[d.signature];
    return !(en && typeof en.ruling === 'string' && en.ruling && typeof en.rationale === 'string' && en.rationale);
  });

  if (divergences.length > 20 && !(table.softCapAcknowledged === true && typeof table.acknowledgmentRationale === 'string' && table.acknowledgmentRationale)) {
    writeFileSync(join(fxDir, '.eventNarration.divergences.out'), JSON.stringify(divergences, null, 2) + '\n');
    assert.fail(`SOFT CAP: ${divergences.length} divergences (>20). Pause and reconvene; then set behaviorTable.softCapAcknowledged=true + acknowledgmentRationale. Wrote .eventNarration.divergences.out`);
  }
  if (unaccounted.length > 0) {
    writeFileSync(join(fxDir, '.eventNarration.divergences.out'), JSON.stringify(unaccounted, null, 2) + '\n');
    assert.fail(`${unaccounted.length} unaccounted divergence(s). Rule each in eventNarration.behaviorTable.json (ruling + rationale). Wrote .eventNarration.divergences.out`);
  }
});
