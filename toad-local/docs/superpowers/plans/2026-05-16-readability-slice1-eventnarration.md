# Readability Layer Slice 1 — `eventNarration` + `locCount` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the three divergent normalized-event→prose sites into one pure `src/runtime/eventNarration/` module, wire the two real incumbents (`agentStream.eventToStreamEntry`, `useToadData.deriveAgentActivity`) through it, and add a sibling `src/runtime/locCount/` activity-volume counter rendered in the agent rail.

**Architecture:** One pure browser-safe ESM module `narrate(event,options?)→{line,kind,tokens}` with a sealed `NARRATION_KINDS`. The cockpit-feed path (`agentStream.ts`) and agent-card path (`useToadData.ts`) call `narrate()`; each maps `NarrationKind` to its own view taxonomy via a tiny pinned exhaustive adapter living in the consumer. `timelineProjection.tsx` is an unchanged-logic consumer. A golden-snapshot agreement test (committed pre-consolidation snapshots vs adapted `narrate()`, signature-keyed, recoverable soft-cap) makes the consolidation's behavior deltas explicit. `locCount` is a separate pure module; `.gitignore`/`locIgnorePaths` matching is pure (rules passed in by caller).

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict` (root suite, same pattern as `src/runtime/contextUsage/`), React/TS UI (`tsc -b`/`vite build`). Repo root `/c/Project-TOAD`; project `toad-local/`; commit to `main` via `git -C /c/Project-TOAD …`, `toad-local/`-prefixed paths, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Authoritative spec:** `docs/superpowers/specs/2026-05-16-readability-slice1-eventnarration-design.md` (`c1250b1`).

**Suite baseline:** root `npm test` `fail 0`; UI `tsc -b`/`vite build` green.

**Out of scope (post-C, banked `notes/deferred-decisions.md`):** persistence of narrated lines, server-side ingestor consumer, span-grouped/expandable feed UX, Layer-2 summarizer, composition extraction.

---

## Grounded facts (verified in code — the plan is built on these)

- **Normalized event shape** (`src/runtime/ClaudeStreamJsonAdapter.js`): `event.type ∈ {tool_use, assistant_text, turn_completed, turn_failed, compact_boundary, api_retry, approval_request, runtime_event}`; `event.toolName`, `event.input` (Edit `{file_path,old_string,new_string}`, MultiEdit `{file_path,edits[]}`, Write `{file_path,content}`, Bash `{command}`, Read `{file_path}`, Grep `{pattern}`, Glob `{pattern}`), `event.raw` = original frame (carries `usage`, `subtype`, `result`, `duration_ms`, `message.content[]`), `event.createdAt`. No `tool_result`.
- **Incumbent A (feed): `ui/src/utils/agentStream.ts`** — node-importable (type-only `RuntimeEvent` import). `summarizeToolInput(toolName,input)` + `eventToStreamEntry(event,idx)→StreamEntry|null` (`StreamEntry.kind ∈ thought|tool|output|system`). Verbatim source captured in Task 6.
- **Incumbent B (card): `ui/src/hooks/useToadData.ts`** — React hook (NOT node-importable). `summarizeToolCall(toolName,input)` + `deriveAgentActivity(event)→AgentActivity|null` (`AgentActivity{kind:AgentActivityKind,label,tool?,at}`, `AgentActivityKind='text'|'tool'|'thinking'|'idle'`, `ui/src/types/index.ts:20-30`). Verbatim source captured in Task 6.
- **Consumer: `ui/src/components/cockpit/timelineProjection.tsx`** — `bodyForStream(name,entry)` re-verbs a `StreamEntry`; `dotForStream` switches on `StreamEntry.kind`. Logic unchanged by this slice (verified transitively via the feed golden).
- **Test wiring**: root `package.json` `test` script chains `node --no-warnings --test test/<file>.js`; new tests follow the `test/contextUsage.*.test.js` precedent. `ui/test/*.mjs` and `ui/src/**/*.test.ts` are NOT in the root chain (do not rely on them).
- **`src/runtime/contextUsage/` precedent**: pure `.js` ESM modules, `index.js` re-export, frozen constants, `num()` finite-or-null helper — mirror this style.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/eventNarration/narrate.js` *(create)* | `narrate(event,options?)→{line,kind,tokens}`; sealed `NARRATION_KINDS`; pure, browser-safe |
| `src/runtime/eventNarration/index.js` *(create)* | Re-export `narrate`, `NARRATION_KINDS` |
| `test/eventNarration.narrate.test.js` *(create)* | Per-event unit + `tokens` per-type + degraded-safe |
| `test/eventNarration.purity.test.js` *(create)* | No `node:*` builtin in transitive imports |
| `test/eventNarration.fixtureCoverage.test.js` *(create)* | Fixture ≥1 of each type + ≥1 `mcp__` |
| `test/eventNarration.agreement.test.js` *(create)* | Golden vs adapted `narrate()`, signature-keyed, ⊆, soft-cap |
| `test/fixtures/eventNarration.events.json` *(create)* | Representative fixture (all event types) |
| `test/fixtures/eventNarration.feedGolden.json` *(create, generated)* | Pre-consolidation feed-path `{line,kind}` per event |
| `test/fixtures/eventNarration.cardGolden.json` *(create, generated)* | Pre-consolidation card-path `{line,kind}` per event |
| `test/fixtures/eventNarration.behaviorTable.json` *(create)* | `{entries:{},}` reconciliation manifest |
| `scripts/captureEventNarrationGoldens.mjs` *(create)* | One-time golden capture (verbatim incumbent copies) |
| `ui/src/utils/agentStream.ts` *(modify)* | `eventToStreamEntry` calls `narrate()` + `NarrationKind→StreamEntry.kind` adapter; delete `summarizeToolInput` |
| `ui/src/hooks/useToadData.ts` *(modify)* | `deriveAgentActivity` calls `narrate()` + `NarrationKind→AgentActivityKind` adapter; delete `summarizeToolCall` |
| `src/runtime/locCount/locCount.js` *(create)* | Pure LoC formulas + aggregation; pure `isIgnored` |
| `src/runtime/locCount/index.js` *(create)* | Re-export |
| `test/locCount.test.js` *(create)* | Formulas, filtering, attribution, aggregate |
| `ui/src/hooks/useToadData.ts` / agent-rail component *(modify, Commit 2)* | Surface per-agent `{added,removed,removedUnknown,filesTouched}` + rail render |
| `package.json` *(modify)* | Wire 5 new `test/` files into the chain |

**Commit policy:** Tasks 1–9 = **Commit 1** (`eventNarration` consolidation), made at Task 9 after gates. If the behavior table exceeds 20 entries, the rulings move to **Commit 1b** (Task 9 note). Tasks 10–13 = **Commit 2** (`locCount` + rail), made at Task 13. No commits before Task 9.

---

## Task 1: Sealed `NARRATION_KINDS` + degraded-safe `narrate()` skeleton

**Files:** Create `src/runtime/eventNarration/narrate.js`, `test/eventNarration.narrate.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/eventNarration.narrate.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { narrate, NARRATION_KINDS } from '../src/runtime/eventNarration/index.js';

test('NARRATION_KINDS is the frozen sealed set', () => {
  assert.deepEqual([...NARRATION_KINDS].sort(), ['system', 'text', 'tool']);
  assert.throws(() => { NARRATION_KINDS.add('x'); });
});

test('unknown / malformed event → degraded, never throws', () => {
  for (const e of [null, undefined, {}, { type: 'who' }, 5, 'x']) {
    const r = narrate(e);
    assert.equal(typeof r.line, 'string');
    assert.ok(NARRATION_KINDS.has(r.kind));
    assert.equal(r.tokens, null);
  }
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.narrate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skeleton**

Create `src/runtime/eventNarration/narrate.js`:

```javascript
// Pure, browser-safe (NO node:* / fs / path / process / env imports).
// One normalized runtime event -> one operator-readable line + kind + tokens.
// The exact unified wording is reconciled via the golden agreement test
// (spec §5); this module is the single source of truth (spec §8c/§8d).

// Controller ratification (T1): Object.freeze(new Set(...)) does NOT make
// .add() throw on Node v22 (freeze guards own props, not Set internal slot).
// Seal via own throwing mutators so `NARRATION_KINDS.add('x')` throws while
// .has()/iteration/spread keep working. Version-robust.
export const NARRATION_KINDS = (() => {
  const s = new Set(['tool', 'text', 'system']);
  const seal = () => { throw new TypeError('NARRATION_KINDS is sealed'); };
  s.add = seal;
  s.delete = seal;
  s.clear = seal;
  return Object.freeze(s);
})();

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function degraded() {
  return { line: '', kind: 'system', tokens: null };
}

export function narrate(event, _options) {
  try {
    if (!event || typeof event !== 'object') return degraded();
    const tokens = num(event.raw && event.raw.usage && event.raw.usage.output_tokens);
    // Filled in Task 2.
    return { line: '', kind: 'system', tokens };
  } catch {
    return degraded();
  }
}
```

Create `src/runtime/eventNarration/index.js`:

```javascript
export { narrate, NARRATION_KINDS } from './narrate.js';
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.narrate.test.js`
Expected: PASS (2/2).

---

## Task 2: Unified per-event wording + kind

**Files:** Modify `src/runtime/eventNarration/narrate.js`; `test/eventNarration.narrate.test.js`

> The seed wording below is ported from the two incumbents (the friendlier `summarizeToolCall` base + cases only `summarizeToolInput` had). It is the **starting point**; Task 7's agreement test surfaces every place it diverges from each golden and the implementer rules each (spec §5/§10). Do not pre-tune it to "match" a golden here — implement exactly this, then reconcile in Task 7.

- [ ] **Step 1: Write failing tests** — append to `test/eventNarration.narrate.test.js`:

```javascript
const ev = (type, extra) => ({ type, createdAt: '2026-05-16T00:00:00.000Z', ...extra });
const tool = (toolName, input) => ev('tool_use', { toolName, input, raw: { message: { content: [{ name: toolName, input }] } } });

test('tool_use wording + kind', () => {
  assert.deepEqual(
    { line: narrate(tool('Read', { file_path: '/a/b/recorder.ts' })).line, kind: narrate(tool('Read', {})).kind },
    { line: 'Reading recorder.ts', kind: 'tool' });
  assert.equal(narrate(tool('Bash', { command: 'cargo test --all' })).line, 'Bash: cargo test --all');
  assert.equal(narrate(tool('Edit', { file_path: '/x/foo.rs' })).line, 'Edit foo.rs');
  assert.equal(narrate(tool('Write', { file_path: '/x/bar.rs' })).line, 'Write bar.rs');
  assert.equal(narrate(tool('Grep', { pattern: 'auth' })).line, 'Grep: auth');
  assert.equal(narrate(tool('Glob', { pattern: '**/*.ts' })).line, 'Glob: **/*.ts');
  assert.equal(narrate(tool('task_create', { taskId: 'T-1', subject: 'do it' })).line, 'Created task T-1 — do it');
  assert.equal(narrate(tool('message_send', { to: { agentId: 'qa' } })).line, 'Sent message → qa');
  assert.equal(narrate(tool('TodoWrite', {})).line, 'Updated todos');
  assert.equal(narrate(tool('mcp__server__do_thing', {})).line, 'Tool: do_thing');
  assert.equal(narrate(tool('mcp__server__do_thing', {})).kind, 'tool');
});

test('assistant_text → one-line truncated, kind text', () => {
  const r = narrate(ev('assistant_text', { text: 'hello\n  world  ' }));
  assert.equal(r.line, 'hello world');
  assert.equal(r.kind, 'text');
  assert.equal(narrate(ev('assistant_text', { text: '' })).line, '');
});

test('system-family events → kind system', () => {
  for (const t of ['turn_completed', 'turn_failed', 'compact_boundary', 'api_retry', 'approval_request']) {
    assert.equal(narrate(ev(t, { toolName: 'Bash', raw: {} })).kind, 'system');
  }
  assert.equal(narrate(ev('turn_completed', { raw: { result: 'ok', duration_ms: 6000 } })).line, 'Turn complete (6s)');
  assert.equal(narrate(ev('approval_request', { toolName: 'Bash' })).line, 'Awaiting approval: Bash');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.narrate.test.js`
Expected: FAIL (lines empty / kinds wrong).

- [ ] **Step 3: Implement** — replace the `narrate` body's `// Filled in Task 2.` return with:

```javascript
    if (event.type === 'assistant_text') {
      const t = typeof event.text === 'string' && event.text
        ? event.text
        : (event.raw && event.raw.message && Array.isArray(event.raw.message.content)
            ? (event.raw.message.content.find((c) => c && c.type === 'text') || {}).text
            : '');
      const one = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
      const line = one.length > 120 ? `${one.slice(0, 117)}…` : one;
      return { line, kind: 'text', tokens };
    }
    if (event.type === 'tool_use') {
      const rawName = typeof event.toolName === 'string' && event.toolName
        ? event.toolName
        : (event.raw && event.raw.message && Array.isArray(event.raw.message.content)
            ? (event.raw.message.content[0] || {}).name : '') || 'tool';
      const input = (event.input && typeof event.input === 'object') ? event.input
        : (event.raw && event.raw.message && Array.isArray(event.raw.message.content)
            ? (event.raw.message.content[0] || {}).input : {}) || {};
      return { line: narrateTool(String(rawName), input), kind: 'tool', tokens };
    }
    if (event.type === 'turn_completed') {
      const r = event.raw || {};
      const dur = typeof r.duration_ms === 'number' ? ` (${Math.round(r.duration_ms / 1000)}s)` : '';
      return { line: `Turn complete${dur}`, kind: 'system', tokens };
    }
    if (event.type === 'turn_failed') return { line: 'Turn failed', kind: 'system', tokens };
    if (event.type === 'compact_boundary') return { line: 'Context compacted', kind: 'system', tokens };
    if (event.type === 'api_retry') return { line: 'Retrying (API)', kind: 'system', tokens };
    if (event.type === 'approval_request') {
      const tn = typeof event.toolName === 'string' && event.toolName ? event.toolName : 'tool';
      return { line: `Awaiting approval: ${tn}`, kind: 'system', tokens };
    }
    if (event.type === 'runtime_event') {
      const st = event.raw && event.raw.subtype;
      const d = event.raw && (event.raw.status_detail || event.raw.status_category || event.raw.description);
      if (typeof d === 'string' && d) return { line: d, kind: 'system', tokens };
      return { line: st ? String(st) : 'system', kind: 'system', tokens };
    }
    return { line: '', kind: 'system', tokens };
```

And add, above `export function narrate`:

```javascript
function basename(p) {
  const s = typeof p === 'string' ? p : '';
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}
function str(v) { return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v); }

function narrateTool(toolName, input) {
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'Read') return `Reading ${basename(str(input && input.file_path)) || 'file'}`;
  if (short === 'Bash') { const c = str(input && input.command); return `Bash: ${c.slice(0, 60)}${c.length > 60 ? '…' : ''}`; }
  if (short === 'Edit' || short === 'Write') return `${short} ${basename(str(input && input.file_path)) || 'file'}`;
  if (short === 'MultiEdit') return `MultiEdit ${basename(str(input && input.file_path)) || 'file'}`;
  if (short === 'Grep') return `Grep: ${str(input && input.pattern).slice(0, 60)}`;
  if (short === 'Glob') return `Glob: ${str(input && input.pattern)}`;
  if (short === 'task_create') {
    const id = str(input && input.taskId); const sj = str(input && input.subject);
    return `Created task ${id}${sj ? ` — ${sj.slice(0, 60)}` : ''}`;
  }
  if (short === 'message_send') {
    const to = input && input.to && typeof input.to === 'object' ? input.to.agentId : undefined;
    return `Sent message → ${to || 'team'}`;
  }
  if (short === 'task_update') return `Updated task ${str(input && input.taskId)}`.trim();
  if (short === 'task_plan_propose') return `Proposed plan for ${str(input && input.taskId) || 'task'}`;
  if (short === 'review_decide') return `Review decided: ${str(input && input.decision)}`;
  if (short === 'validation_run') return `Running validation: ${str(input && input.kind)}`;
  if (short === 'TodoWrite') return 'Updated todos';
  return `Tool: ${short}`;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.narrate.test.js`
Expected: PASS.

---

## Task 3: `tokens` per-type assertions

**Files:** `test/eventNarration.narrate.test.js`

- [ ] **Step 1: Write failing test** — append:

```javascript
test('tokens: num(raw.usage.output_tokens) ?? null, strict, per-type', () => {
  assert.equal(narrate({ type: 'turn_completed', raw: { usage: { output_tokens: 222 } } }).tokens, 222);
  assert.equal(narrate({ type: 'turn_failed', raw: { usage: { output_tokens: 5 } } }).tokens, 5);
  assert.equal(narrate({ type: 'turn_failed', raw: {} }).tokens, null);
  assert.equal(narrate(tool('Read', { file_path: 'a' })).tokens, null);
  assert.equal(narrate(ev('assistant_text', { text: 'hi' })).tokens, null);
  assert.equal(narrate({ type: 'turn_completed', raw: { usage: { output_tokens: '222' } } }).tokens, null); // strict
});
```

- [ ] **Step 2: Run — verify** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.narrate.test.js` — Expected: PASS (Task 2's `num()` already satisfies this; if any case fails, fix `narrate`, not the test).

---

## Task 4: `index.js` purity guard

**Files:** Create `test/eventNarration.purity.test.js`

- [ ] **Step 1: Write the test**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'eventNarration');

test('eventNarration module imports no node:* builtin / fs / path / process', () => {
  for (const f of ['narrate.js', 'index.js']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports a node: builtin`);
    assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), `${f} imports a node core module`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
  }
});
```

- [ ] **Step 2: Run — verify pass** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.purity.test.js` — Expected: PASS (Task 1/2 used no such imports). If it fails, remove the offending import from the module — never weaken the test.

---

## Task 5: Representative fixture + coverage test

**Files:** Create `test/fixtures/eventNarration.events.json`, `test/eventNarration.fixtureCoverage.test.js`

- [ ] **Step 1: Create the fixture** — `test/fixtures/eventNarration.events.json` (hand-built representative; one per event type + an `mcp__` tool + a no-text assistant + a no-result turn):

```json
[
  { "type": "tool_use", "toolName": "Read", "input": { "file_path": "/repo/src/recorder.ts" }, "createdAt": "2026-05-16T00:00:01.000Z", "raw": { "message": { "content": [{ "name": "Read", "input": { "file_path": "/repo/src/recorder.ts" } }] } } },
  { "type": "tool_use", "toolName": "Bash", "input": { "command": "cargo test --all --features integration -- --nocapture extra" }, "createdAt": "2026-05-16T00:00:02.000Z", "raw": { "message": { "content": [{ "name": "Bash", "input": { "command": "cargo test --all --features integration -- --nocapture extra" } }] } } },
  { "type": "tool_use", "toolName": "Edit", "input": { "file_path": "/repo/src/foo.rs", "old_string": "a\nb", "new_string": "a\nb\nc" }, "createdAt": "2026-05-16T00:00:03.000Z", "raw": { "message": { "content": [{ "name": "Edit", "input": { "file_path": "/repo/src/foo.rs" } }] } } },
  { "type": "tool_use", "toolName": "mcp__toad__task_create", "input": { "taskId": "T-9", "subject": "wire it" }, "createdAt": "2026-05-16T00:00:04.000Z", "raw": { "message": { "content": [{ "name": "mcp__toad__task_create", "input": { "taskId": "T-9", "subject": "wire it" } }] } } },
  { "type": "assistant_text", "text": "Investigating the auth path now.", "createdAt": "2026-05-16T00:00:05.000Z", "raw": { "message": { "content": [{ "type": "text", "text": "Investigating the auth path now." }] } } },
  { "type": "assistant_text", "createdAt": "2026-05-16T00:00:06.000Z", "raw": { "message": { "content": [] } } },
  { "type": "turn_completed", "createdAt": "2026-05-16T00:00:07.000Z", "raw": { "result": "done", "duration_ms": 6000, "usage": { "output_tokens": 222 } } },
  { "type": "turn_completed", "createdAt": "2026-05-16T00:00:08.000Z", "raw": {} },
  { "type": "turn_failed", "createdAt": "2026-05-16T00:00:09.000Z", "raw": { "usage": { "output_tokens": 4 } } },
  { "type": "compact_boundary", "createdAt": "2026-05-16T00:00:10.000Z", "raw": { "subtype": "compact_boundary" } },
  { "type": "api_retry", "createdAt": "2026-05-16T00:00:11.000Z", "raw": { "subtype": "api_retry" } },
  { "type": "approval_request", "toolName": "Bash", "createdAt": "2026-05-16T00:00:12.000Z", "raw": { "request": { "subtype": "can_use_tool", "tool_name": "Bash" } } },
  { "type": "runtime_event", "createdAt": "2026-05-16T00:00:13.000Z", "raw": { "subtype": "post_turn_summary", "status_detail": "compiling" } }
]
```

- [ ] **Step 2: Write the coverage test** — `test/eventNarration.fixtureCoverage.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fx = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eventNarration.events.json'), 'utf8'));

test('fixture covers every normalized event type + an mcp__ tool', () => {
  const types = new Set(fx.map((e) => e.type));
  for (const t of ['tool_use', 'assistant_text', 'turn_completed', 'turn_failed', 'compact_boundary', 'api_retry', 'approval_request', 'runtime_event']) {
    assert.ok(types.has(t), `fixture missing event type: ${t}`);
  }
  assert.ok(fx.some((e) => e.type === 'tool_use' && typeof e.toolName === 'string' && e.toolName.startsWith('mcp__')),
    'fixture missing an mcp__-prefixed tool_use');
});
```

- [ ] **Step 3: Run — verify pass** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.fixtureCoverage.test.js` — Expected: PASS.

---

## Task 6: Golden-capture harness + committed goldens

**Files:** Create `scripts/captureEventNarrationGoldens.mjs`, `test/fixtures/eventNarration.feedGolden.json`, `test/fixtures/eventNarration.cardGolden.json`

> The harness embeds **verbatim copies** of the *current* incumbent logic (so the golden is a faithful pre-consolidation snapshot, independent of the refactor that follows). The copies below are exact transcriptions of `agentStream.ts` (`summarizeToolInput`, `eventToStreamEntry`), `useToadData.ts` (`summarizeToolCall`, `deriveAgentActivity`), and `timelineProjection.tsx` (`bodyForStream` verb map). Copy them as-is — do not "improve" them; their bugs ARE the baseline.

- [ ] **Step 1: Create `scripts/captureEventNarrationGoldens.mjs`**

```javascript
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fxPath = join(here, '..', 'test', 'fixtures', 'eventNarration.events.json');
const events = JSON.parse(readFileSync(fxPath, 'utf8'));

/* ---- VERBATIM from ui/src/utils/agentStream.ts (do not edit) ---- */
function aSafeString(v) { return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v); }
function summarizeToolInput(toolName, input) {
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'Read') return aSafeString(input?.file_path);
  if (short === 'Bash') return aSafeString(input?.command);
  if (short === 'Edit' || short === 'Write') return aSafeString(input?.file_path);
  if (short === 'Grep') return `pattern: ${aSafeString(input?.pattern)}`;
  if (short === 'Glob') return aSafeString(input?.pattern);
  if (short === 'task_create') return `${aSafeString(input?.taskId)} — ${aSafeString(input?.subject)}`;
  if (short === 'message_send') { const to = input?.to?.agentId; const text = aSafeString(input?.text); return `→ ${to || 'team'}: ${text.slice(0, 120)}`; }
  if (short === 'task_update') return `${aSafeString(input?.taskId)}`;
  if (short === 'task_plan_propose') return `Plan for ${aSafeString(input?.taskId) || 'task'}`;
  if (short === 'review_decide') return `Decision: ${aSafeString(input?.decision) || ''}`;
  if (short === 'validation_run') return `Kind: ${aSafeString(input?.kind) || ''}`;
  if (short === 'TodoWrite') { const todos = input?.todos; if (Array.isArray(todos)) return todos.map((t) => `${t.status === 'completed' ? '✓' : '·'} ${t.content}`).join(' / '); return ''; }
  return JSON.stringify(input ?? {}).slice(0, 200);
}
function eventToStreamEntry(event) {
  if (event.type === 'assistant_text') {
    const text = (typeof event.text === 'string' && event.text) || event.raw?.message?.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    return { kind: 'output', body: text };
  }
  if (event.type === 'tool_use') {
    const toolName = (typeof event.toolName === 'string' && event.toolName) || event.raw?.message?.content?.[0]?.name || 'tool';
    const input = event.raw?.message?.content?.[0]?.input || event.input;
    return { kind: 'tool', tool: String(toolName).replace(/^mcp__[^_]+__/, ''), body: summarizeToolInput(String(toolName), input) };
  }
  if (event.type === 'runtime_event') {
    const subtype = event.raw?.subtype; const description = event.raw?.description;
    if (subtype === 'task_started' && description) return { kind: 'system', body: description };
    if (subtype === 'post_turn_summary') { const status = event.raw?.status_detail || event.raw?.status_category; if (status) return { kind: 'thought', body: status }; }
    return null;
  }
  if (event.type === 'turn_completed') {
    const r = event.raw; if (r?.result) { const dur = r.duration_ms ? ` (${Math.round(r.duration_ms / 1000)}s)` : ''; return { kind: 'system', body: `Turn complete${dur}` }; }
    return null;
  }
  if (event.type === 'approval_request') return { kind: 'system', body: 'Approval requested' };
  return null;
}
/* ---- VERBATIM from timelineProjection.tsx bodyForStream verb map ---- */
function bodyForStreamText(entry) {
  if (!entry) return null;
  const verb = entry.kind === 'tool'
    ? (entry.tool === 'Edit' || entry.tool === 'Write' ? 'edited'
        : entry.tool === 'Read' ? 'opened'
        : entry.tool === 'Bash' ? 'ran'
        : entry.tool === 'Grep' || entry.tool === 'Glob' ? 'searched for' : 'used')
    : entry.kind === 'output' ? 'reported'
    : entry.kind === 'thought' ? 'thinking:' : 'system:';
  const toolLabel = entry.tool ?? entry.kind;
  // Plain-text rendering of the JSX <agent> <verb> [<tool>] [— body]; agent name omitted (constant per-row, not part of the narration decision).
  return `${verb}${entry.kind === 'tool' && entry.tool ? ` ${toolLabel}` : ''}${entry.body ? ` — ${entry.body}` : ''}`;
}
/* ---- VERBATIM from ui/src/hooks/useToadData.ts ---- */
function uSafe(v) { return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v); }
function summarizeToolCall(toolName, input) {
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'task_create') { const tid = uSafe(input?.taskId) || ''; const subj = uSafe(input?.subject) || ''; return `Created task ${tid}${subj ? ` — ${subj.slice(0, 60)}` : ''}`; }
  if (short === 'message_send') { const to = input?.to?.agentId; return `Sent message → ${to || 'team'}`; }
  if (short === 'task_update') return `Updated task ${uSafe(input?.taskId) || ''}`.trim();
  if (short === 'task_plan_propose') return `Proposed plan for ${uSafe(input?.taskId) || 'task'}`;
  if (short === 'review_decide') return `Review decided: ${uSafe(input?.decision) || ''}`;
  if (short === 'validation_run') return `Running validation: ${uSafe(input?.kind) || ''}`;
  if (short === 'Read') { const fp = uSafe(input?.file_path); const base = fp ? fp.split(/[/\\]/).pop() : ''; return `Reading ${base || 'file'}`; }
  if (short === 'Bash') { const cmd = uSafe(input?.command); return `Bash: ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`; }
  if (short === 'Edit' || short === 'Write') { const fp = uSafe(input?.file_path); const base = fp ? fp.split(/[/\\]/).pop() : ''; return `${short} ${base || 'file'}`; }
  if (short === 'Grep') return `Grep: ${uSafe(input?.pattern)?.slice(0, 60) || ''}`;
  if (short === 'Glob') return `Glob: ${uSafe(input?.pattern) || ''}`;
  if (short === 'TodoWrite') return 'Updated todos';
  return `Tool: ${short}`;
}
function deriveAgentActivity(event) {
  if (event.type === 'tool_use') {
    const toolName = (typeof event.toolName === 'string' && event.toolName) || event.raw?.message?.content?.[0]?.name || 'tool';
    const input = event.raw?.message?.content?.[0]?.input || event.input;
    const tool = String(toolName);
    return { kind: 'tool', label: summarizeToolCall(tool, input) };
  }
  if (event.type === 'assistant_text') {
    const text = (typeof event.text === 'string' && event.text) || event.raw?.message?.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    const one = text.replace(/\s+/g, ' ').trim();
    return { kind: 'text', label: one.length > 120 ? `${one.slice(0, 117)}…` : one };
  }
  if (event.type === 'runtime_event') {
    const subtype = event.raw?.subtype;
    if (subtype === 'task_started') return { kind: 'thinking', label: 'Working…' };
  }
  return null;
}

const feed = events.map((e) => { const se = eventToStreamEntry(e); return se === null ? null : { line: bodyForStreamText(se), kind: se.kind }; });
const card = events.map((e) => { const a = deriveAgentActivity(e); return a === null ? null : { line: a.label, kind: a.kind }; });
writeFileSync(join(here, '..', 'test', 'fixtures', 'eventNarration.feedGolden.json'), JSON.stringify(feed, null, 2) + '\n');
writeFileSync(join(here, '..', 'test', 'fixtures', 'eventNarration.cardGolden.json'), JSON.stringify(card, null, 2) + '\n');
console.log(`wrote goldens: ${feed.length} feed, ${card.length} card`);
```

- [ ] **Step 2: Generate the goldens**

Run: `cd /c/Project-TOAD/toad-local && node scripts/captureEventNarrationGoldens.mjs`
Expected: `wrote goldens: 13 feed, 13 card` and two new committed JSON files. **Do not hand-edit the goldens** — they are the frozen baseline.

- [ ] **Step 3: Create the empty behavior table** — `test/fixtures/eventNarration.behaviorTable.json`:

```json
{ "entries": {} }
```

---

## Task 7: Golden-snapshot agreement test + reconciliation loop

**Files:** Create `test/eventNarration.agreement.test.js`

- [ ] **Step 1: Write the agreement test**

```javascript
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

// Pinned view-taxonomy adapters (mirrors the consumers wired in Task 8).
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

test('agreement: adapted narrate() vs committed goldens (ruled divergences only)', () => {
  const divergences = [];
  events.forEach((e, i) => {
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
```

- [ ] **Step 2: Run — observe divergences**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.agreement.test.js`
Expected: FAIL listing unaccounted divergences (the two incumbents and the unified `narrate()` genuinely differ — e.g. feed `Read` golden `"opened — /repo/src/recorder.ts"` vs new `"opened — Reading recorder.ts"`; card `Read` golden `"Reading recorder.ts"`). This is the reconciliation surfacing, exactly as designed.

- [ ] **Step 3: Reconcile (the §5 loop)**

For each divergence written to `test/fixtures/.eventNarration.divergences.out`, decide the correct unified behavior and add an entry to `test/fixtures/eventNarration.behaviorTable.json` under `entries[<signature>]`:

```json
{
  "entries": {
    "<signature>": {
      "eventType": "tool_use",
      "salient": { "toolName": "Read", "file_path": "/repo/src/recorder.ts", "command": null, "subtype": null },
      "feedOld": "opened — /repo/src/recorder.ts",
      "cardOld": "Reading recorder.ts",
      "new": "Reading recorder.ts",
      "ruling": "card-was-right",
      "rationale": "Basename is more legible than the raw path; the feed's raw path was noise."
    }
  }
}
```

If a ruling implies `narrate()` should produce *different* wording than Task 2's seed, change `narrate()` (not the golden, not the test) and re-run. Iterate Step 2↔3 until the only remaining divergences are the ones you have deliberately ruled. If `> 20` distinct divergences appear, STOP, surface to the human (the test message says so), and only after a deliberate decision set `softCapAcknowledged: true` + `acknowledgmentRationale` in the table.

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.agreement.test.js`
Expected: PASS. Delete the scratch file: `rm -f test/fixtures/.eventNarration.divergences.out` and add it to `.gitignore` if not already ignored (it is a scratch artifact, never committed).

---

## Task 8: Wire the two incumbents through `narrate()`; delete the twins

**Files:** Modify `ui/src/utils/agentStream.ts`, `ui/src/hooks/useToadData.ts`

- [ ] **Step 1: Rewire `agentStream.ts`**

In `ui/src/utils/agentStream.ts`: add import `import { narrate, NARRATION_KINDS } from '@/../../src/runtime/eventNarration/index.js';` **— first verify the correct relative/alias path** by checking an existing `ui/src` → `src/runtime` import; if none exists, use a relative path from `ui/src/utils/` to `src/runtime/eventNarration/index.js` (`../../../src/runtime/eventNarration/index.js`) and confirm `tsc`/`vite` resolve it (Vite allows importing outside `ui/` only if the path resolves; if the build rejects it, copy the resolution approach the repo already uses for any `ui → src` import, or add the module to a shared location the build already includes — do NOT duplicate `narrate`). Delete `summarizeToolInput` entirely. Replace the `assistant_text`/`tool_use`/`turn_completed`/`approval_request` branches of `eventToStreamEntry` so the `body`+`kind` come from `narrate()`:

```typescript
const NK_TO_STREAM: Record<'tool' | 'text' | 'system', StreamEntry['kind']> = { tool: 'tool', text: 'output', system: 'system' };
function streamKind(k: 'tool' | 'text' | 'system'): StreamEntry['kind'] {
  const v = NK_TO_STREAM[k];
  // Exhaustiveness: a new NarrationKind must extend this map (compile error otherwise).
  return v;
}
```

In `eventToStreamEntry`, keep the `null`-drop conditions (assistant_text with no text, runtime_event lifecycle, turn_completed without `raw.result`) but source displayed text/kind from `narrate(event)`:
- `assistant_text`: if no text → `return null` (unchanged); else `const n = narrate(event); return { id, time, kind: streamKind(n.kind), body: n.line };`
- `tool_use`: `const n = narrate(event); return { id, time, kind: streamKind(n.kind), tool: String(toolName).replace(/^mcp__[^_]+__/, ''), body: n.line };`
- `turn_completed`: if `!event.raw?.result` → `return null` (unchanged); else `const n = narrate(event); return { id, time, kind: streamKind(n.kind), body: n.line };`
- `approval_request`: `const n = narrate(event); return { id, time, kind: streamKind(n.kind), body: n.line };`
- `runtime_event`: unchanged (its `task_started`/`post_turn_summary` selection is drop/selection logic, not wording — leave as-is; `narrate()` covering `runtime_event` is exercised only via the card path).

- [ ] **Step 2: Rewire `useToadData.ts`**

In `ui/src/hooks/useToadData.ts`: import `narrate` (same path approach as Step 1). Delete `summarizeToolCall` entirely. In `deriveAgentActivity`, replace the `tool_use` and `assistant_text` branches' label derivation with `narrate()`, and map kind via a pinned exhaustive adapter:

```typescript
function cardKind(k: 'tool' | 'text' | 'system'): AgentActivity['kind'] {
  switch (k) {
    case 'tool': return 'tool';
    case 'text': return 'text';
    case 'system': return 'thinking';
    default: { const _x: never = k; return _x; } // exhaustive: new NarrationKind = compile error
  }
}
```
- `tool_use`: `const n = narrate(event); return { kind: cardKind(n.kind), label: n.line, tool: String(toolName).replace(/^mcp__[^_]+__/, ''), at };`
- `assistant_text`: if no text → `return null` (unchanged); else `const n = narrate(event); return { kind: cardKind(n.kind), label: n.line, at };`
- `runtime_event`/`task_started` → `{ kind: 'thinking', label: 'Working…', at }` unchanged (selection state, not wording).

- [ ] **Step 3: Typecheck + build**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN`
Expected: `CLEAN`. Run: `cd /c/Project-TOAD/toad-local/ui && npm run build 2>&1 | tail -2`
Expected: `✓ built`. If the `ui → src` import fails resolution, fix the import path (Step 1 note) — never duplicate `narrate`.

- [ ] **Step 4: Confirm the goldens still describe reality**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/eventNarration.agreement.test.js`
Expected: PASS (the adapters in the test mirror Step 1/2's adapters; the committed rulings now describe the live consumers). If a *new* divergence appears, the consumer wiring deviates from the test's adapter — reconcile (fix the wiring or rule it), do not edit the golden.

---

## Task 9: Wire tests into the suite; gates; Commit 1

**Files:** Modify `package.json`

- [ ] **Step 1: Wire the 4 new node tests** into `toad-local/package.json`'s `test` script, appended after the last `contextUsage` entry:

`&& node --no-warnings --test test/eventNarration.narrate.test.js && node --no-warnings --test test/eventNarration.purity.test.js && node --no-warnings --test test/eventNarration.fixtureCoverage.test.js && node --no-warnings --test test/eventNarration.agreement.test.js`

Verify each path exists; confirm `package.json` is valid JSON: `cd /c/Project-TOAD/toad-local && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'));console.log('ok')"`.

- [ ] **Step 2: Full root suite**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`; the 4 eventNarration suites visibly executed. Fix code (never weaken a test) on any regression.

- [ ] **Step 3: UI gates**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN` → `CLEAN`; `npm run build 2>&1 | tail -2` → `✓ built`.

- [ ] **Step 4: Commit 1 (and 1b only if behavior table > 20 entries)**

If `Object.keys(behaviorTable.entries).length > 20`: stage the spec/test code as Commit 1 and the `behaviorTable.json` rulings as a follow-up **Commit 1b** (`readability: eventNarration consolidation rulings`). Otherwise one commit:

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/eventNarration toad-local/test/eventNarration.narrate.test.js toad-local/test/eventNarration.purity.test.js toad-local/test/eventNarration.fixtureCoverage.test.js toad-local/test/eventNarration.agreement.test.js toad-local/test/fixtures/eventNarration.events.json toad-local/test/fixtures/eventNarration.feedGolden.json toad-local/test/fixtures/eventNarration.cardGolden.json toad-local/test/fixtures/eventNarration.behaviorTable.json toad-local/scripts/captureEventNarrationGoldens.mjs toad-local/ui/src/utils/agentStream.ts toad-local/ui/src/hooks/useToadData.ts toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(readability): consolidate event→prose into pure eventNarration (Slice 1 · Commit 1)

Collapses the three divergent normalized-event→prose sites into one
pure browser-safe src/runtime/eventNarration/ (narrate()→{line,kind,
tokens}; sealed NARRATION_KINDS). agentStream.eventToStreamEntry and
useToadData.deriveAgentActivity now call narrate() via pinned
exhaustive NarrationKind→view-taxonomy adapters; summarizeToolInput +
summarizeToolCall deleted. timelineProjection is an unchanged consumer.
Golden-snapshot agreement test (committed pre-consolidation feed/card
goldens vs adapted narrate, signature-keyed, recoverable >20 soft-cap)
makes every reconciled behavior delta explicit in behaviorTable.json.
Root suite fail 0; UI tsc/build green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -2
```

---

## Task 10: `locCount` formulas

**Files:** Create `src/runtime/locCount/locCount.js`, `src/runtime/locCount/index.js`, `test/locCount.test.js`

- [ ] **Step 1: Write failing tests** — `test/locCount.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineCount, locForEvent } from '../src/runtime/locCount/index.js';

test('lineCount predicate', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount('a\nb\n'), 2);
});

test('Edit = added/removed line counts; no-op = 0/0', () => {
  const e = { type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\ny\nz' } };
  assert.deepEqual(locForEvent(e), { file: 'a.ts', added: 3, removed: 2, removedKnown: true });
  const noop = { type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 's', new_string: 's' } };
  assert.deepEqual(locForEvent(noop), { file: 'a.ts', added: 0, removed: 0, removedKnown: true });
});

test('MultiEdit sums; Write removed unknown; non-file tools null', () => {
  const m = { type: 'tool_use', toolName: 'MultiEdit', input: { file_path: 'm.ts', edits: [{ old_string: 'a', new_string: 'a\nb' }, { old_string: '', new_string: 'c' }] } };
  assert.deepEqual(locForEvent(m), { file: 'm.ts', added: 3, removed: 1, removedKnown: true });
  const w = { type: 'tool_use', toolName: 'Write', input: { file_path: 'w.ts', content: 'a\nb\nc' } };
  assert.deepEqual(locForEvent(w), { file: 'w.ts', added: 3, removed: 0, removedKnown: false });
  assert.equal(locForEvent({ type: 'tool_use', toolName: 'Bash', input: { command: 'rm x' } }), null);
  assert.equal(locForEvent({ type: 'assistant_text' }), null);
});
```

- [ ] **Step 2: Run — verify fail** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/locCount.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/runtime/locCount/locCount.js`:

```javascript
// Pure, browser-safe. LoC = REQUESTED Edit/Write activity (no tool_result
// exists). Write removed is unknowable → removedKnown:false (never guessed).
export function lineCount(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') n += 1;
  return s[s.length - 1] === '\n' ? n : n + 1;
}

export function locForEvent(event) {
  if (!event || event.type !== 'tool_use') return null;
  const name = typeof event.toolName === 'string' ? event.toolName.replace(/^mcp__[^_]+__/, '') : '';
  const input = (event.input && typeof event.input === 'object') ? event.input : {};
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  if (name === 'Edit') {
    return { file, added: lineCount(input.new_string), removed: lineCount(input.old_string), removedKnown: true };
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let a = 0; let r = 0;
    for (const ed of edits) { a += lineCount(ed && ed.new_string); r += lineCount(ed && ed.old_string); }
    return { file, added: a, removed: r, removedKnown: true };
  }
  if (name === 'Write') {
    return { file, added: lineCount(input.content), removed: 0, removedKnown: false };
  }
  return null;
}
```

`src/runtime/locCount/index.js`:

```javascript
export { lineCount, locForEvent, isIgnored, accumulateLoc } from './locCount.js';
```

- [ ] **Step 4: Run — verify pass** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/locCount.test.js` — Expected: the implemented cases PASS (the `isIgnored`/`accumulateLoc` export will error until Task 11/12 — proceed; those are added next).

---

## Task 11: Pure `.gitignore`-subset matcher (edit-time, `locIgnorePaths` augments)

**Files:** Modify `src/runtime/locCount/locCount.js`; `test/locCount.test.js`

- [ ] **Step 1: Write failing tests** — append to `test/locCount.test.js`:

```javascript
import { isIgnored } from '../src/runtime/locCount/index.js';
test('isIgnored: gitignore-subset glob, locIgnorePaths augments (not replaces)', () => {
  const git = ['node_modules/', '*.lock', 'dist/'];
  assert.equal(isIgnored('node_modules/x/y.js', git, []), true);
  assert.equal(isIgnored('pnpm.lock', git, []), true);
  assert.equal(isIgnored('src/app.ts', git, []), false);
  // augment: extra pattern adds, original still applies
  assert.equal(isIgnored('src/generated/big.ts', git, ['src/generated/']), true);
  assert.equal(isIgnored('pnpm.lock', git, ['src/generated/']), true);
});
```

- [ ] **Step 2: Run — verify fail** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/locCount.test.js` — Expected: FAIL on the `isIgnored` cases.

- [ ] **Step 3: Implement** — add to `src/runtime/locCount/locCount.js`:

```javascript
// Minimal gitignore-subset: trailing-slash dir prefix, leading-slash anchor,
// and '*' (no slash) wildcard. Sufficient for LoC filtering; NOT a full
// gitignore engine (documented limitation). Rules are passed in (pure):
// the caller reads .gitignore + settings.runtime.locIgnorePaths at edit
// time and supplies them; locIgnorePaths AUGMENTS gitRules.
function matchOne(path, pat) {
  if (!pat) return false;
  let p = pat.trim();
  if (p.length === 0 || p.startsWith('#')) return false;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) {
    const dir = p.slice(0, -1);
    return anchored ? path === dir || path.startsWith(`${dir}/`)
      : path === dir || path.includes(`${dir}/`) || path.startsWith(`${dir}/`);
  }
  const rx = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  const base = path.split('/').pop();
  return anchored ? rx.test(path) : rx.test(path) || rx.test(base);
}
export function isIgnored(path, gitRules, locIgnorePaths) {
  const norm = String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
  const rules = [...(Array.isArray(gitRules) ? gitRules : []), ...(Array.isArray(locIgnorePaths) ? locIgnorePaths : [])];
  return rules.some((r) => matchOne(norm, r));
}
```

- [ ] **Step 4: Run — verify pass** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/locCount.test.js` — Expected: `isIgnored` cases PASS.

---

## Task 12: `accumulateLoc` aggregation

**Files:** Modify `src/runtime/locCount/locCount.js`; `test/locCount.test.js`

- [ ] **Step 1: Write failing test** — append:

```javascript
import { accumulateLoc } from '../src/runtime/locCount/index.js';
test('accumulateLoc: per-agent {added,removed,removedUnknown,filesTouched}, ignore-filtered, deleter not penalised', () => {
  const events = [
    { agentId: 'dev', type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'x\ny' } },
    { agentId: 'dev', type: 'tool_use', toolName: 'Write', input: { file_path: 'b.ts', content: 'p\nq' } },
    { agentId: 'dev', type: 'tool_use', toolName: 'Edit', input: { file_path: 'pnpm.lock', old_string: 'a', new_string: 'a\nb' } },
    { agentId: 'qa', type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'x\ny', new_string: '' } },
  ];
  const out = accumulateLoc(events, { gitRules: ['*.lock'], locIgnorePaths: [] });
  assert.deepEqual(out.dev, { added: 1 + 1 + 2, removed: 1 + 0 + 0, removedUnknown: true, filesTouched: 2 });
  assert.deepEqual(out.qa, { added: 1, removed: 2, removedUnknown: false, filesTouched: 1 });
});
```

(`a.ts` Edit added: `lineCount('x\ny')=2 removed lineCount('x')=1`; Write `b.ts` added 2 removedKnown false; `pnpm.lock` ignored; qa `a.ts` added `lineCount('')=0`? — note: qa Edit new_string `''` → added 0, removed `lineCount('x\ny')=2`. Adjust expected: `out.qa = { added: 0, removed: 2, removedUnknown: false, filesTouched: 1 }`. Fix the assertion to `added: 0` before running.)

- [ ] **Step 2: Run — verify fail** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/locCount.test.js` — Expected: FAIL (`accumulateLoc` not a function).

- [ ] **Step 3: Implement** — add to `locCount.js`:

```javascript
export function accumulateLoc(events, { gitRules = [], locIgnorePaths = [] } = {}) {
  const acc = {};
  for (const e of (Array.isArray(events) ? events : [])) {
    const loc = locForEvent(e);
    if (!loc) continue;
    if (isIgnored(loc.file, gitRules, locIgnorePaths)) continue;
    const id = e && typeof e.agentId === 'string' ? e.agentId : 'unknown';
    const a = acc[id] || (acc[id] = { added: 0, removed: 0, removedUnknown: false, _files: new Set() });
    a.added += loc.added;
    a.removed += loc.removed;
    if (!loc.removedKnown) a.removedUnknown = true;
    if (loc.file) a._files.add(loc.file);
  }
  for (const id of Object.keys(acc)) {
    acc[id].filesTouched = acc[id]._files.size;
    delete acc[id]._files;
  }
  return acc;
}
```

- [ ] **Step 4: Run — verify pass** — Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/locCount.test.js` — Expected: PASS (all locCount cases). Then full root suite (`npm test … fail 0`).

---

## Task 13: Agent-rail render + wire data; Commit 2

**Files:** Modify `ui/src/hooks/useToadData.ts` (or the established read-model assembly point) + the agent-rail component; `package.json`

- [ ] **Step 1: Locate the rail + data assembly**

Run: `cd /c/Project-TOAD/toad-local && grep -rln "agent.tokens\|agent.tokenLimit\|members.map" ui/src/components | head` and identify the agent-rail row component (the per-agent list in the TEAM column). Identify where `useToadData` assembles per-agent data and where the SSE event stream per agent is available (the same source `deriveAgentActivity` consumes).

- [ ] **Step 2: Compute per-agent LoC** in the read-model assembly: import `accumulateLoc` (same `ui → src` path approach as Task 8); call it over the per-agent event stream the hook already holds, supplying `gitRules` = the project `.gitignore` lines the UI can read via the existing settings/project API (if no such API is wired, supply `[]` and a code comment that gitignore wiring is a follow-up — the *matcher* is done and pure; default no-filter is honest). Resolve `locIgnorePaths` from effective settings `settings.runtime.locIgnorePaths` if present. Extend the per-agent view type with `loc?: { added: number; removed: number; removedUnknown: boolean; filesTouched: number }`.

- [ ] **Step 3: Render** in the rail row: show `+{added} / {removedUnknown ? '—' : '−'+removed}` (or `+a / −r` when known), as a small muted indicator, **labelled activity volume** (tooltip text: `"Activity volume — requested edits; the runtime emits no applied-diff signal, so failed/denied edits are included. Overwrite-write removals are unknowable (—)."`). Tooltip body = **per-file** breakdown (`{file}: +a / −r` list). Never the word "productivity".

- [ ] **Step 4: Wire `test/locCount.test.js` into `package.json`** (`&& node --no-warnings --test test/locCount.test.js`); validate JSON.

- [ ] **Step 5: Gates + Commit 2**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'` → `fail 0`. `cd ui && npm run typecheck … || echo CLEAN` → `CLEAN`; `npm run build … | tail -2` → `✓ built`.

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/locCount toad-local/test/locCount.test.js toad-local/ui/src/hooks/useToadData.ts toad-local/package.json <the agent-rail component path>
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(readability): per-agent LoC activity-volume counter (Slice 1 · Commit 2)

Pure src/runtime/locCount/ (Edit/MultiEdit added/removed line counts;
Write removed unknowable→removedUnknown; no-op=0; deleter not penalised;
gitignore-subset isIgnored with locIgnorePaths augment, edit-time).
Agent rail shows +added/−removed as activity volume (NOT productivity),
per-file tooltip, requested-not-applied + overwrite-unknown footnote.
Root suite fail 0; UI tsc/build green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

---

## Self-Review (plan author)

**1. Spec coverage:** §1 (single source) → T1–2,8. §2 grounded incumbents → Grounded-facts + T6/T8. §3 Option-1 module → T1,4,8. §4.1 signature/`tokens`/`event.raw` shape → T1–3. §4.2 narration↔composition (composition stays in caller) → T8 (timelineProjection unchanged). §4.3 sealed `NarrationKind` → T1. §4.4 three-site wiring + exhaustive adapters → T8. §5 golden agreement test + behaviorTable schema + recoverable >20 soft-cap + signature key + divergence-output → T6,7. §6 locCount formulas/`removed:null`/no-op/filesTouched/Bash-excluded/attribution → T10; `.gitignore` edit-time + `locIgnorePaths` augment → T11; aggregate + per-file tooltip + activity-volume label + requested-not-applied footnote → T12,13. §7 two/three commits in sequence → T9 (1/1b) + T13 (2). §8 tests + gates + suite wiring → T4,5,7,9,12,13. §10 pins all map to T1–13; open NarrationKind/ruling items resolved by T7 not pre-invented. No spec section unmapped.

**2. Placeholder scan:** All code steps contain complete code. The two execution-time judgement points are bounded, not placeholders: T7's reconciliation is a *defined loop with concrete file formats* (the spec mandates rulings be made during implementation, §10), and T8 Step-1's `ui→src` import-path note is a "verify the resolution the repo already uses" instruction with an explicit fallback and a hard "do not duplicate narrate" — both are real instructions, not "TBD". T13 Step-2's gitignore-source note has an explicit honest default ("supply `[]`") so it cannot block.

**3. Type consistency:** `narrate(event,options?)→{line,kind,tokens}` and `NARRATION_KINDS={'tool','text','system'}` consistent T1↔2↔7↔8. Adapters `NK→StreamEntry.kind` (`tool→tool,text→output,system→system`) and `NK→AgentActivityKind` (`tool→tool,text→text,system→thinking`) identical in T7 test and T8 wiring (the agreement test mirrors the consumers — Task 8 Step 4 enforces it). `locForEvent→{file,added,removed,removedKnown}` consistent T10↔12; `accumulateLoc→{added,removed,removedUnknown,filesTouched}` consistent T12↔13. `isIgnored(path,gitRules,locIgnorePaths)` consistent T11↔12. Fixed inline: T12 Step-1 expected `qa.added` corrected to `0` (new_string `''`).
