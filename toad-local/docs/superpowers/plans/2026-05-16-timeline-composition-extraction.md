# Timeline Composition Extraction (Readability Layer-2 P2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `projectTimeline`'s pure data-composition into a new zero-import server-importable `src/runtime/timelineComposition/` core, with the rendered cockpit timeline proven byte-identical (pure preservation refactor).

**Architecture:** Capture a frozen golden from the *pristine* `projectTimeline` first (throwaway-but-committed script + a deterministic no-React element serializer — `react`/`react-dom` are NOT resolvable from the root, so the root `node:test` agreement path imports only the pure module, never the `.tsx`, exactly like the `eventNarration` Slice-1 precedent). Then introduce `composeTimeline` (the exact current algorithm, JSX-free `ComposedRow[]`) and reduce `timelineProjection.tsx` to a thin adapter + renderer over it, `projectTimeline`'s public contract unchanged. Strict zero-divergence (no behaviorTable — it is a refactor).

**Tech Stack:** Node ESM, `node:test`+`node:assert/strict`, the UI `tsc -b`/`vite build` gate. No new deps. No `react`/`react-dom` in any root-run test or `src/`.

---

## Grounded facts (verified in code 2026-05-16 — the plan is built on these; §8d)

- **`react`/`react-dom` do NOT resolve from the toad-local root** (`require.resolve` → `MODULE_NOT_FOUND`). Therefore the root `node:test` agreement path **cannot** use `renderToStaticMarkup` and **cannot import `timelineProjection.tsx`** (`.tsx` + `@/` aliases + React). The golden body is serialized by a tiny deterministic element walker (below), used **identically** capture-side and agreement-side. This is the spec §5 fallback, now confirmed as the path.
- **`eventNarration` precedent (mirror exactly):** `scripts/captureEventNarrationGoldens.mjs` is a *committed* script containing logic **copied verbatim** from the `.tsx`/`.ts` consumers under `/* ---- VERBATIM from <file> (do not edit) ---- */` banners; it reads `test/fixtures/eventNarration.events.json` and writes committed `*Golden.json`. `test/eventNarration.agreement.test.js` imports ONLY the pure `src/runtime/eventNarration/index.js`, reads the committed fixture+goldens, and asserts agreement. P2a replicates this division: the `.tsx` renderer's correctness is the **UI build gate's** job; the **agreement test** proves the composition+body-text *logic* is byte-identical to the frozen pristine baseline.
- **`ui/src/components/cockpit/timelineProjection.tsx`** (full content read; ~278 lines):
  - `projectTimeline(input: TimelineProjectionInput): TimelineEvent[]` — `now = input.now ?? Date.now()`, `limit = input.limit ?? 8`, `agentName = Map(agents.id→name)`. Stream: for each `[agentId, entries]` of `input.agentStreams`, `entries.slice(-4)` → `candidates.push({agentId, entry, ts: parseStreamTimestamp(entry, now)})`; `candidates.sort((a,b)=>b.ts-a.ts)`; `head = candidates.slice(0, limit)`. Drift: `(input.driftHistory ?? []).slice().sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).slice(-4)`; `for (i=1; i<driftHist.length && driftEvents.length<2; i++)` skip if `Math.abs(curr.teamScore-prev.teamScore)<3`, `ts=Date.parse(curr.createdAt)` skip if `NaN`; push `{id:\`drift-${curr.runId}\`, when:formatRelative(ts,now), dot:dotForDrift(prev.teamScore,curr.teamScore), body:<>…</>}`. `streamEvents = head.map(({agentId,entry,ts},idx)=>({id:\`stream-${entry.id}-${idx}\`, when:formatRelative(ts,now), dot:dotForStream(entry), expanded: idx===0 ? true : expanded /*always undefined from bodyForStream*/, body, _ts:ts}))`. `lifecycleEvents = (input.taskTransitions ?? []).map(t=>({id:\`task-${t.taskId}-${t.at}\`, when:formatRelative(t.at,now), dot:lifecycleDot(t), body:lifecycleBody(t,agentLabel), _ts:t.at}))` where `agentLabel = t.agentId ? (agentName.get(t.agentId) ?? t.agentId) : null`. `driftWithTs = driftEvents.map((e,i)=>({...e,_ts:(input.driftHistory?.length ?? 0)*1000 - i}))`. `merged=[...streamEvents,...lifecycleEvents,...driftWithTs]; merged.sort((a,b)=>b._ts-a._ts); return merged.slice(0,limit).map(({_ts:_,...rest})=>rest)`.
  - `parseStreamTimestamp(entry, now)`: `parts = entry.time.split(':').map(Number)`; if `parts.length!==3 || parts.some(Number.isNaN)` return `now`; `[hh,mm,ss]`; `candidate=new Date(now); candidate.setHours(hh,mm,ss,0); ts=candidate.getTime(); if (ts>now) ts-=86400000; return ts`. **STAYS client-side (adapter).**
  - `formatRelative(ts, now)`: `diff=Math.max(0,now-ts); sec=floor(diff/1000)`; `<30→'just now'`; `<60→\`${sec}s\``; `min=floor(sec/60)`; `<60→\`${min} min\``; `hr=floor(min/60)`; `<24→\`${hr}h ago\``; `day=floor(hr/24)`; `\`${day}d ago\``. **PURE → core (verbatim).**
  - `dotForStream(entry)`: switch `entry.kind`: `'tool'→'clay'`, `'output'→'green'`, `'thought'→'blue'`, `'system'→'amber'`, default `'clay'`. **PURE → core (keyed on `entryKind`).**
  - `dotForDrift(prev,next)`: `next>prev→'amber'`, `next<prev→'green'`, else `'clay'`. **PURE → core.**
  - `lifecycleDot(t)`: `t.fromStatus===null→'blue'`; `t.toStatus==='done'→'green'`; `t.toStatus==='blocked'||'rejected'→'amber'`; `t.toStatus==='review'→'violet'`; else `'clay'`. **PURE → core (keyed on `fromStatus`/`toStatus`).**
  - `bodyForStream(agentName, entry)` → `{body: ReactNode}` (never sets `expanded`). `verb`: `entry.kind==='tool'` ? (`tool==='Edit'||'Write'→'edited'`; `'Read'→'opened'`; `'Bash'→'ran'`; `'Grep'||'Glob'→'searched for'`; else `'used'`) : `kind==='output'→'reported'` : `kind==='thought'→'thinking:'` : `'system:'`. `toolLabel = entry.tool ?? entry.kind`. JSX: `<><span className="agent">{agentName}</span>{' '}{verb}{' '}{entry.kind==='tool' && entry.tool ? <span className="file">{toolLabel}</span> : null}{entry.body ? <> — {entry.body}</> : null}</>`. **Uses exactly: `agentName, entry.kind, entry.tool, entry.body`. Stays client-side; relocated to consume a `ComposedRow.stream` payload.**
  - drift body JSX: `<>Drift run completed — score moved from <b>{prev.teamScore}%</b> → <b>{curr.teamScore}%</b>.</>`. **Uses: `prevScore, nextScore`.**
  - `lifecycleBody(t, agentLabel)`: `fromStatus===null` → `<>{agentLabel ? <span className="agent">{agentLabel}</span> : 'lead'}{' '}created task <span className="file">{t.taskId}</span> — {t.title}.</>`; `toStatus==='done'` → `<><span className="file">{t.taskId}</span> done{agentLabel ? <> · finished by <span className="agent">{agentLabel}</span></> : null}.</>`; else → `<><span className="file">{t.taskId}</span>{' '}moved <b>{t.fromStatus}</b> → <b>{t.toStatus}</b>{agentLabel ? <> by <span className="agent">{agentLabel}</span></> : null}.</>`. **Uses: `fromStatus, toStatus, taskId, title, agentLabel`.**
- **`StreamEntry`** (`ui/src/utils/agentStream.ts` L4-13): `{ id:string, time:string /*HH:MM:SS*/, kind:'thought'|'tool'|'output'|'system', tool?:string, body:string }`. `agentStream.ts` imports the pure module via `import { narrate } from '../../../src/runtime/eventNarration/index.js';` (3 levels — `ui/src/utils/`).
- **`FlowTimeline.tsx`**: `export type TimelineDot = 'clay'|'green'|'blue'|'amber'|'violet';` `export interface TimelineEvent { id:string; when:string; dot:TimelineDot; expanded?:boolean; body:ReactNode; }` (FlowTimeline renders `{e.when}`,`{e.dot}`,`{e.body}`).
- **`CockpitForMe.tsx`** L10 `import { projectTimeline, type TaskTransition } from './timelineProjection';`, L254 `projectTimeline({...})`, L397 `<FlowTimeline events={timelineEvents} …/>`. **Untouched** — `projectTimeline`'s public signature/return is preserved.
- **Import path (computed):** `timelineProjection.tsx` is `ui/src/components/cockpit/` (4 levels) → the new core import is **`../../../../src/runtime/timelineComposition/index.js`**.
- **`captureEventNarrationGoldens.mjs` shape to mirror:** ESM `.mjs`; `import {readFileSync,writeFileSync} from 'node:fs'`; reads `test/fixtures/<name>.json`; `/* ---- VERBATIM from <file> (do not edit) ---- */` blocks (JSX rewritten to plain JS — that script flattened `bodyForStream` to **text** via a `bodyForStreamText`); `events.map(...)` → `writeFileSync(golden, JSON.stringify(x,null,2)+'\n')`. It is **committed** in `scripts/` (not deleted).

## Deterministic element serializer (the load-bearing primitive — used IDENTICALLY by the capture script AND the agreement test)

Because there is no React at the root, the verbatim body builders are reproduced with a hyperscript `h()` returning plain objects, serialized by `ser()`. **Both** the capture script and the agreement test embed this **identical** block verbatim:

```javascript
// h(): plain-object stand-in for React.createElement / JSX.
// ser(): deterministic, react-free serialization of an element tree.
//   text/number → String;  null/false/undefined → '';  array → concat;
//   element → className ? `<tag.cls>children</tag.cls>` : (Fragment ? children : `<tag>children</tag>`)
function h(type, props, ...children) { return { type, props: { ...(props || {}), children } }; }
const FRAG = 'FRAG';
function ser(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(ser).join('');
  const t = node.type, c = ser(node.props ? node.props.children : '');
  const cls = node.props && node.props.className;
  if (t === FRAG) return c;
  return cls ? `<${t}.${cls}>${c}</${t}>` : `<${t}>${c}</${t}>`;
}
```

The verbatim `bodyForStream`/drift-body/`lifecycleBody` are reproduced with `h(...)`/`FRAG` instead of JSX, e.g. `bodyForStream`'s JSX `<><span className="agent">{n}</span>{' '}{verb}{' '}{tool?...:null}{body?<> — {body}</>:null}</>` becomes `h(FRAG,null, h('span',{className:'agent'},n), ' ', verb, ' ', (kind==='tool'&&tool? h('span',{className:'file'},toolLabel):null), (body? h(FRAG,null,' — ',body):null))`. `ser()` of that yields exactly `"<span.agent>n</span> verb <span.file>tool</span> — body"` — a stable, react-free, byte-comparable string preserving the markup the golden must freeze.

## File Structure

| File | Responsibility |
|---|---|
| `test/fixtures/timelineComposition.input.json` *(create, Commit 1)* | Hand-built `TimelineProjectionInput` fixtures (≥1 per kind; see Task 1). Committed, frozen. |
| `scripts/captureTimelineCompositionGolden.mjs` *(create, Commit 1; committed, not deleted)* | VERBATIM-copied pristine `projectTimeline`+helpers+`h`/`ser`+body builders; exports `computeRows(input)`; CLI writes the golden. |
| `test/fixtures/timelineComposition.golden.json` *(create, Commit 1; generated by the script)* | Serialized pristine `projectTimeline` over the fixture: `[{id,when,dot,expanded,bodyText}]`. Frozen baseline. |
| `test/timelineComposition.baseline.test.js` *(create, Commit 1)* | Imports `computeRows` from the capture script; asserts `computeRows(input)` deep-equals the committed golden (baseline locked / capture deterministic). |
| `src/runtime/timelineComposition/composeTimeline.js` *(create, Commit 2)* | Pure `composeTimeline(input)→ComposedRow[]` (exact current algorithm; JSX-free) + sealed `DOT` set + `formatRelative`/`dotFor*` verbatim. Zero imports. |
| `src/runtime/timelineComposition/index.js` *(create, Commit 2)* | `export { composeTimeline, DOT } from './composeTimeline.js';` |
| `test/timelineComposition.compose.test.js` *(create, Commit 2)* | Pure-core unit tests over the normalized contract. |
| `test/timelineComposition.purity.test.js` *(create, Commit 2)* | No `node:`/`fs`/`react`/JSX/`process` imports + `DOT` set == `FlowTimeline` `TimelineDot` union (guard-by-test, no import coupling). |
| `test/timelineComposition.agreement.test.js` *(create, Commit 2)* | Imports pure `composeTimeline` + the verbatim body builders + `h`/`ser`; serializes identically; asserts **byte-identical** to the Commit-1 golden. STRICT. |
| `ui/src/components/cockpit/timelineProjection.tsx` *(modify, Commit 2)* | Reduced to: adapter (StreamEntry/drift/transition→normalized input; `ts` via kept `parseStreamTimestamp`) + `composeTimeline` call + renderer (`ComposedRow`→`TimelineEvent` via the verbatim JSX `bodyForStream`/`lifecycleBody`/drift-body). `projectTimeline` signature/return UNCHANGED. |
| `package.json` *(modify, Commit 1 & 2)* | Wire new suites into `scripts.test`. |

**Commit policy:** **Commit 1 = Tasks 1–3** (frozen baseline from pristine code; nothing refactored). **Commit 2 = Tasks 4–8** (the pure core + refactor + agreement byte-identical + gates). Tasks accumulate **uncommitted**; only Task 3 (Commit 1) and Task 8 (Commit 2) commit. `git -C /c/Project-TOAD`, `toad-local/` paths, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 1: Fixture + verbatim capture script

**Files:** Create `test/fixtures/timelineComposition.input.json`; Create `scripts/captureTimelineCompositionGolden.mjs`

- [ ] **Step 1: Create the fixture** — `test/fixtures/timelineComposition.input.json` (one object = one `projectTimeline` input case; the script iterates cases):

```json
[
  {
    "name": "multi-agent + window + cap + drift>=3 + drift<3 + lifecycle create/done/move + empty",
    "input": {
      "now": 1747353600000,
      "limit": 8,
      "agents": [{ "id": "a1", "name": "dev-1" }, { "id": "a2", "name": "lead" }],
      "agentStreams": {
        "a1": [
          { "id": "e1", "time": "09:00:00", "kind": "tool", "tool": "Read",  "body": "foo.ts" },
          { "id": "e2", "time": "09:00:05", "kind": "tool", "tool": "Edit",  "body": "foo.ts" },
          { "id": "e3", "time": "09:00:10", "kind": "tool", "tool": "Bash",  "body": "npm test" },
          { "id": "e4", "time": "09:00:15", "kind": "output", "body": "done" },
          { "id": "e5", "time": "09:00:20", "kind": "tool", "tool": "Grep",  "body": "TODO" }
        ],
        "a2": [
          { "id": "e6", "time": "09:00:02", "kind": "thought", "body": "planning" },
          { "id": "e7", "time": "09:00:08", "kind": "system",  "body": "compacted" }
        ],
        "a3-unknown": [
          { "id": "e8", "time": "09:00:30", "kind": "tool", "tool": "Glob", "body": "*.ts" }
        ]
      },
      "driftHistory": [
        { "runId": "d1", "teamScore": 50, "createdAt": "2026-05-16T09:00:00.000Z" },
        { "runId": "d2", "teamScore": 51, "createdAt": "2026-05-16T09:01:00.000Z" },
        { "runId": "d3", "teamScore": 60, "createdAt": "2026-05-16T09:02:00.000Z" }
      ],
      "taskTransitions": [
        { "taskId": "t1", "title": "first task", "fromStatus": null,         "toStatus": "in_progress", "agentId": "a1", "at": 1747353500000 },
        { "taskId": "t2", "title": "second",     "fromStatus": "review",     "toStatus": "done",        "agentId": "a2", "at": 1747353550000 },
        { "taskId": "t3", "title": "third",      "fromStatus": "in_progress","toStatus": "review",      "agentId": null, "at": 1747353560000 }
      ]
    }
  },
  { "name": "empty streams + no drift + no transitions", "input": { "now": 1747353600000, "agents": [], "agentStreams": {}, "driftHistory": [], "taskTransitions": [] } },
  { "name": "limit smaller than candidates", "input": { "now": 1747353600000, "limit": 2, "agents": [{ "id": "a1", "name": "dev-1" }], "agentStreams": { "a1": [ { "id": "x1", "time": "09:00:00", "kind": "tool", "tool": "Read", "body": "a" }, { "id": "x2", "time": "09:00:01", "kind": "tool", "tool": "Read", "body": "b" }, { "id": "x3", "time": "09:00:02", "kind": "tool", "tool": "Read", "body": "c" } ] }, "driftHistory": [], "taskTransitions": [] } }
]
```

- [ ] **Step 2: Create the capture script** — `scripts/captureTimelineCompositionGolden.mjs`. It contains the `h`/`ser` block (verbatim from the "Deterministic element serializer" section above), then a `/* ---- VERBATIM from ui/src/components/cockpit/timelineProjection.tsx (JSX→h, do not edit logic) ---- */` block reproducing **exactly** (per the Grounded-facts transcription): `parseStreamTimestamp`, `formatRelative`, `dotForStream` (switch on `entry.kind`), `dotForDrift`, `lifecycleDot`, and the three element builders **named exactly `bodyForStreamEl(payload)` / `driftEl(payload)` / `lifecycleEl(payload, agentLabel)`** (these exact names are re-used byte-for-byte by Task 7's agreement test): `bodyForStreamEl` = `bodyForStream`'s JSX→`h`/`FRAG` (reads `agentName,entryKind,tool,body`), `driftEl` = the drift body `h(FRAG,null,'Drift run completed — score moved from ', h('b',null, prev+'%'), ' → ', h('b',null, next+'%'), '.')` (reads `prevScore,nextScore`), `lifecycleEl` = `lifecycleBody`'s 3 branches JSX→`h` (reads `taskId,title,fromStatus,toStatus,agentLabel`); and `projectTimeline` (the full algorithm from Grounded-facts, building each event with `bodyText = ser(bodyForStreamEl|driftEl|lifecycleEl(...))` instead of a React `body`). Export `computeRows(input)` returning `input`-cases→`projectTimeline`-equivalent rows serialized as `{ id, when, dot, expanded: expanded === true ? true : undefined, bodyText }` (drop `_ts`; omit `expanded` when not `true` exactly as `TimelineEvent` would). CLI tail:

```javascript
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', 'timelineComposition.input.json'), 'utf8'));
export function computeRows(allCases) {
  return allCases.map((c) => ({ name: c.name, rows: projectTimelineGolden(c.input) }));
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('captureTimelineCompositionGolden.mjs')) {
  const out = computeRows(cases);
  writeFileSync(join(here, '..', 'test', 'fixtures', 'timelineComposition.golden.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote golden: ${out.length} cases, ${out.reduce((n, c) => n + c.rows.length, 0)} rows`);
}
```

(`projectTimelineGolden` = the verbatim `projectTimeline` re-expressed to emit `{id,when,dot,expanded,bodyText}` rows. The implementer transcribes it from the Grounded-facts block — JSX bodies become `ser(h(...))`. No logic changes; this is the *pristine* behavior captured.)

- [ ] **Step 3: Verify the script runs (no golden yet — generated in Task 2)**

Run: `cd /c/Project-TOAD/toad-local && node -e "import('./scripts/captureTimelineCompositionGolden.mjs').then(m=>console.log('cases:', m.computeRows(JSON.parse(require('node:fs').readFileSync('test/fixtures/timelineComposition.input.json','utf8'))).length))"`
Expected: `cases: 3` (no throw — the verbatim transcription is syntactically valid).

---

## Task 2: Generate + freeze the golden

**Files:** Create `test/fixtures/timelineComposition.golden.json`

- [ ] **Step 1: Generate the golden from the pristine capture script**

Run: `cd /c/Project-TOAD/toad-local && node scripts/captureTimelineCompositionGolden.mjs`
Expected: prints `wrote golden: 3 cases, N rows`; creates `test/fixtures/timelineComposition.golden.json`.

- [ ] **Step 2: Sanity-inspect the golden**

Run: `cd /c/Project-TOAD/toad-local && node -e "const g=require('./test/fixtures/timelineComposition.golden.json'); const r=g[0].rows; console.log('case0 rows:', r.length); console.log('sample:', JSON.stringify(r[0])); console.log('has stream/drift/task ids:', r.some(x=>x.id.startsWith('stream-')), r.some(x=>x.id.startsWith('drift-')), r.some(x=>x.id.startsWith('task-')))"`
Expected: `case0 rows:` a small number (≤ limit 8); `sample:` an object with `id/when/dot/bodyText` (and `expanded:true` only on the first stream row); `has stream/drift/task ids: true true true`. If a body looks wrong (e.g. missing markup), the verbatim transcription in Task 1 is off — fix the transcription, regenerate, never hand-edit the golden.

---

## Task 3: Strict baseline test + wire + **Commit 1**

**Files:** Create `test/timelineComposition.baseline.test.js`; Modify `package.json`

- [ ] **Step 1: Write the baseline-locked test**

Create `test/timelineComposition.baseline.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeRows } from '../scripts/captureTimelineCompositionGolden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.input.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.golden.json'), 'utf8'));

test('baseline locked: pristine capture is deterministic and equals the committed golden', () => {
  assert.deepEqual(computeRows(cases), golden);
});
```

- [ ] **Step 2: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/timelineComposition.baseline.test.js`
Expected: PASS (1/1) — the committed golden is exactly what the committed pristine capture produces (frozen, reproducible).

- [ ] **Step 3: Wire into `scripts.test`** — append to the end of the `scripts.test` string in `package.json` (leading space):

```
 && node --no-warnings --test test/timelineComposition.baseline.test.js
```

Validate: `cd /c/Project-TOAD/toad-local && node -e "console.log(require('./package.json').scripts.test.includes('test/timelineComposition.baseline.test.js'))"` → `true`.

- [ ] **Step 4: Full root suite — fail 0, new suite executed**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (pass|fail)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'` → `fail 0`.
Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -c "baseline locked: pristine capture is deterministic"` → ≥ `1` (un-wired-test trap).

- [ ] **Step 5: Commit 1**

```bash
git -C /c/Project-TOAD add toad-local/test/fixtures/timelineComposition.input.json toad-local/scripts/captureTimelineCompositionGolden.mjs toad-local/test/fixtures/timelineComposition.golden.json toad-local/test/timelineComposition.baseline.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
test(timeline): freeze pristine projectTimeline golden baseline (Readability Layer-2 P2a, Commit 1)

One-time committed capture: scripts/captureTimelineCompositionGolden.mjs
copies the CURRENT VERBATIM projectTimeline + helpers + body builders
(JSX→deterministic react-free h()/ser() serializer — react/react-dom do
NOT resolve at the root) over a committed hand-built fixture, emitting
the frozen golden test/fixtures/timelineComposition.golden.json. The
baseline test asserts the pristine capture is deterministic and equals
the committed golden. NOTHING is refactored yet — this locks the
"before" so P2a's extraction can be proven byte-identical against it.
Root fail 0; suite wired. Mirrors the eventNarration Slice-1 precedent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pure `composeTimeline` core + sealed `DOT`

**Files:** Create `src/runtime/timelineComposition/composeTimeline.js`; Create `src/runtime/timelineComposition/index.js`; Create `test/timelineComposition.compose.test.js`

- [ ] **Step 1: Write the failing pure-core test**

Create `test/timelineComposition.compose.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeTimeline, DOT } from '../src/runtime/timelineComposition/index.js';

const NOW = 1747353600000;
const baseInput = () => ({
  now: NOW, limit: 8,
  agents: [{ id: 'a1', name: 'dev-1' }],
  agentStreams: { a1: [
    { entryId: 's1', kind: 'tool', tool: 'Read', body: 'a', ts: NOW - 5000 },
    { entryId: 's2', kind: 'tool', tool: 'Edit', body: 'b', ts: NOW - 4000 },
  ] },
  driftHistory: [
    { runId: 'd1', teamScore: 50, createdAt: '2026-05-16T09:00:00.000Z' },
    { runId: 'd2', teamScore: 60, createdAt: '2026-05-16T09:01:00.000Z' },
  ],
  taskTransitions: [{ taskId: 't1', title: 'x', fromStatus: null, toStatus: 'in_progress', agentId: 'a1', at: NOW - 1000 }],
});

test('DOT is the sealed FlowTimeline union', () => {
  assert.deepEqual([...DOT].sort(), ['amber', 'blue', 'clay', 'green', 'violet']);
});

test('per-agent slice(-4) window + sort desc + limit cap', () => {
  const i = baseInput();
  i.agentStreams.a1 = Array.from({ length: 6 }, (_, k) => ({ entryId: `s${k}`, kind: 'tool', tool: 'Read', body: `${k}`, ts: NOW - (10 - k) * 1000 }));
  i.driftHistory = []; i.taskTransitions = []; i.limit = 3;
  const rows = composeTimeline(i);
  assert.equal(rows.length, 3);
  // window keeps last 4 (s2..s5); sort desc by ts; cap 3 → s5,s4,s3
  assert.deepEqual(rows.map((r) => r.stream.body), ['5', '4', '3']);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[1].expanded, undefined);
});

test('stream row shape: id/when/dot/kind/payload', () => {
  const i = baseInput(); i.driftHistory = []; i.taskTransitions = [];
  const r = composeTimeline(i)[0];
  assert.equal(r.kind, 'stream');
  assert.match(r.id, /^stream-s2-0$/);
  assert.equal(r.dot, 'clay');
  assert.equal(typeof r.when, 'string');
  assert.deepEqual(r.stream, { agentName: 'dev-1', entryKind: 'tool', tool: 'Edit', body: 'b' });
});

test('drift fold: |Δ|>=3 emits, <3 skips, cap 2, NaN-date skip', () => {
  const i = baseInput(); i.agentStreams = {}; i.taskTransitions = [];
  i.driftHistory = [
    { runId: 'd1', teamScore: 50, createdAt: '2026-05-16T09:00:00.000Z' },
    { runId: 'd2', teamScore: 51, createdAt: '2026-05-16T09:01:00.000Z' }, // Δ1 skip
    { runId: 'd3', teamScore: 60, createdAt: '2026-05-16T09:02:00.000Z' }, // Δ9 emit
  ];
  const rows = composeTimeline(i);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'drift');
  assert.deepEqual(rows[0].drift, { prevScore: 51, nextScore: 60 });
  assert.equal(rows[0].dot, 'amber'); // next>prev
});

test('lifecycle fold: create/done/move payload + agentLabel resolution + dot', () => {
  const i = baseInput(); i.agentStreams = {}; i.driftHistory = [];
  i.taskTransitions = [
    { taskId: 't1', title: 'c', fromStatus: null, toStatus: 'in_progress', agentId: 'a1', at: NOW - 3000 },
    { taskId: 't2', title: 'd', fromStatus: 'review', toStatus: 'done', agentId: 'zz', at: NOW - 2000 },
    { taskId: 't3', title: 'm', fromStatus: 'in_progress', toStatus: 'review', agentId: null, at: NOW - 1000 },
  ];
  const rows = composeTimeline(i);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId['task-t1-' + (NOW - 3000)].lifecycle, { taskId: 't1', title: 'c', fromStatus: null, toStatus: 'in_progress', agentLabel: 'dev-1' });
  assert.equal(byId['task-t1-' + (NOW - 3000)].dot, 'blue');
  assert.equal(byId['task-t2-' + (NOW - 2000)].lifecycle.agentLabel, 'zz'); // unknown id → id fallback
  assert.equal(byId['task-t2-' + (NOW - 2000)].dot, 'green');
  assert.equal(byId['task-t3-' + (NOW - 1000)].lifecycle.agentLabel, null);
  assert.equal(byId['task-t3-' + (NOW - 1000)].dot, 'violet');
});

test('merge ordering by _ts desc + final cap; empty input → []', () => {
  assert.deepEqual(composeTimeline({ now: NOW, agents: [], agentStreams: {} }), []);
  const i = baseInput();
  const rows = composeTimeline(i);
  // lifecycle at NOW-1000 is newest vs stream NOW-4000/-5000 and drift synthetic _ts
  assert.ok(rows.length <= (i.limit ?? 8));
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/timelineComposition.compose.test.js`
Expected: FAIL — `Cannot find module '.../timelineComposition/index.js'`.

- [ ] **Step 3: Implement the core**

Create `src/runtime/timelineComposition/composeTimeline.js`:

```javascript
// Pure timeline composition (Readability Layer-2 P2a). Zero imports,
// JSX-free, server-importable — the eventNarration pure-core discipline.
// Replicates the EXACT pre-refactor projectTimeline algorithm; emits
// structured ComposedRow[] (no ReactNode). The client renderer maps
// ComposedRow → TimelineEvent via the (kept-client) JSX body builders.

// Sealed dot set — kept EQUAL to FlowTimeline.tsx's TimelineDot union
// by a guard assertion in the purity test (no import coupling).
export const DOT = Object.freeze(new Set(['clay', 'green', 'blue', 'amber', 'violet']));

function formatRelative(ts, now) {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
function dotForStreamKind(kind) {
  switch (kind) {
    case 'tool': return 'clay';
    case 'output': return 'green';
    case 'thought': return 'blue';
    case 'system': return 'amber';
    default: return 'clay';
  }
}
function dotForDrift(prev, next) {
  if (next > prev) return 'amber';
  if (next < prev) return 'green';
  return 'clay';
}
function lifecycleDot(t) {
  if (t.fromStatus === null) return 'blue';
  if (t.toStatus === 'done') return 'green';
  if (t.toStatus === 'blocked' || t.toStatus === 'rejected') return 'amber';
  if (t.toStatus === 'review') return 'violet';
  return 'clay';
}

/**
 * @param {{ agentStreams:Record<string,Array<{entryId:string,kind:string,tool?:string,body:string,ts:number}>>,
 *           agents:Array<{id:string,name:string}>,
 *           driftHistory?:Array<{runId:string,teamScore:number,createdAt:string}>,
 *           taskTransitions?:Array<{taskId:string,title:string,fromStatus:string|null,toStatus:string,agentId:string|null,at:number}>,
 *           now:number, limit?:number }} input
 * @returns {Array<{id:string,when:string,dot:string,expanded?:boolean,kind:'stream'|'drift'|'lifecycle',
 *                   stream?:object, drift?:object, lifecycle?:object}>}
 */
export function composeTimeline(input) {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const limit = input.limit ?? 8;
  const agentName = new Map();
  for (const a of input.agents ?? []) agentName.set(a.id, a.name);

  const candidates = [];
  for (const [agentId, entries] of Object.entries(input.agentStreams ?? {})) {
    const recent = (entries ?? []).slice(-4);
    for (const entry of recent) candidates.push({ agentId, entry, ts: entry.ts });
  }
  candidates.sort((a, b) => b.ts - a.ts);
  const head = candidates.slice(0, limit);

  const driftRows = [];
  const driftHist = (input.driftHistory ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-4);
  for (let i = 1; i < driftHist.length && driftRows.length < 2; i++) {
    const prev = driftHist[i - 1];
    const curr = driftHist[i];
    if (Math.abs(curr.teamScore - prev.teamScore) < 3) continue;
    const ts = Date.parse(curr.createdAt);
    if (Number.isNaN(ts)) continue;
    driftRows.push({
      id: `drift-${curr.runId}`,
      when: formatRelative(ts, now),
      dot: dotForDrift(prev.teamScore, curr.teamScore),
      kind: 'drift',
      drift: { prevScore: prev.teamScore, nextScore: curr.teamScore },
      _ts: 0, // assigned below to match the verbatim driftWithTs formula
    });
  }
  const driftWithTs = driftRows.map((e, i) => ({ ...e, _ts: (input.driftHistory?.length ?? 0) * 1000 - i }));

  const streamRows = head.map(({ agentId, entry, ts }, idx) => ({
    id: `stream-${entry.entryId}-${idx}`,
    when: formatRelative(ts, now),
    dot: dotForStreamKind(entry.kind),
    expanded: idx === 0 ? true : undefined,
    kind: 'stream',
    stream: { agentName: agentName.get(agentId) ?? agentId, entryKind: entry.kind, tool: entry.tool, body: entry.body },
    _ts: ts,
  }));

  const lifecycleRows = (input.taskTransitions ?? []).map((t) => ({
    id: `task-${t.taskId}-${t.at}`,
    when: formatRelative(t.at, now),
    dot: lifecycleDot(t),
    kind: 'lifecycle',
    lifecycle: {
      taskId: t.taskId,
      title: t.title,
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      agentLabel: t.agentId ? (agentName.get(t.agentId) ?? t.agentId) : null,
    },
    _ts: t.at,
  }));

  const merged = [...streamRows, ...lifecycleRows, ...driftWithTs];
  merged.sort((a, b) => b._ts - a._ts);
  return merged.slice(0, limit).map(({ _ts: _omit, ...rest }) => rest);
}
```

Create `src/runtime/timelineComposition/index.js`:

```javascript
export { composeTimeline, DOT } from './composeTimeline.js';
```

> Note (`expanded`): the verbatim `streamEvents` sets `expanded: idx===0 ? true : <undefined from bodyForStream>`. A `ComposedRow` with `expanded: undefined` serializes/spreads exactly as the original `TimelineEvent` (the key is present-but-undefined in both; the golden captures `expanded:true` only, omitting it otherwise — see Task 1 Step 2's `expanded: expanded === true ? true : undefined`). The agreement test (Task 7) applies the SAME `expanded===true?true:undefined` normalization on both sides, so this is byte-consistent.

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/timelineComposition.compose.test.js`
Expected: PASS (all tests).

---

## Task 5: Purity guard + dot-set parity

**Files:** Create `test/timelineComposition.purity.test.js`

- [ ] **Step 1: Write the test**

Create `test/timelineComposition.purity.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOT } from '../src/runtime/timelineComposition/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'timelineComposition');

test('timelineComposition module imports no node:/fs/path/os/child_process/react and never touches process', () => {
  for (const f of ['composeTimeline.js', 'index.js']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports node:`);
    assert.ok(!/from\s+['"](fs|path|os|child_process|react|react-dom)['"]/.test(src), `${f} imports a forbidden module`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
    assert.ok(!/<[A-Za-z]/.test(src) || f === 'index.js', `${f} contains JSX-like markup`);
  }
});

test('DOT set EQUALS FlowTimeline.tsx TimelineDot union (guard-by-test, no import coupling)', () => {
  const fl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'src', 'components', 'cockpit', 'FlowTimeline.tsx'), 'utf8');
  const m = fl.match(/export type TimelineDot\s*=\s*([^;]+);/);
  assert.ok(m, 'TimelineDot union not found in FlowTimeline.tsx');
  const union = new Set(m[1].split('|').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
  assert.deepEqual([...DOT].sort(), [...union].sort());
});
```

- [ ] **Step 2: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/timelineComposition.purity.test.js`
Expected: PASS (2/2). If the dot-parity test fails, the `FlowTimeline` union changed — reconcile `DOT` to match (never weaken the test).

---

## Task 6: Refactor `timelineProjection.tsx` to adapter + renderer

**Files:** Modify `ui/src/components/cockpit/timelineProjection.tsx`

- [ ] **Step 1: Refactor (no behavior change)**

Rewrite `timelineProjection.tsx` so that:
- It imports the core: `import { composeTimeline } from '../../../../src/runtime/timelineComposition/index.js';` (grounded path; mirrors `agentStream.ts`'s `../../../src/runtime/eventNarration/index.js`, +1 level deeper).
- `parseStreamTimestamp` stays **verbatim** (client adapter).
- `bodyForStream(agentName, payload)`, `lifecycleBody(payload, agentLabel)`, and the drift body **stay verbatim** as JSX builders, but now take a `ComposedRow` payload instead of a raw `StreamEntry`/`TaskTransition`: `bodyForStream` reads `payload.agentName/entryKind/tool/body`; drift body reads `payload.prevScore/nextScore`; `lifecycleBody` reads `payload.taskId/title/fromStatus/toStatus/agentLabel`. The JSX is unchanged (same elements, same text, same className) — only the field source object changes (e.g. `entry.kind`→`row.stream.entryKind`, `entry.tool`→`row.stream.tool`, `entry.body`→`row.stream.body`, `agentName` arg→`row.stream.agentName`).
- `formatRelative`/`dotForStream`/`dotForDrift`/`lifecycleDot` are **deleted** from the `.tsx` (now owned by the core; the core already set `when`/`dot` on each `ComposedRow`).
- `projectTimeline(input: TimelineProjectionInput): TimelineEvent[]` becomes: build `agentStreams` for the core as `Record<agentId, Array<{entryId,kind,tool?,body,ts}>>` by mapping each `StreamEntry` → `{ entryId: e.id, kind: e.kind, tool: e.tool, body: e.body, ts: parseStreamTimestamp(e, now) }` preserving per-agent order; pass `agents`, `driftHistory`, `taskTransitions`, `now`, `limit` straight through; `const rows = composeTimeline({...})`; then `return rows.map(row => ({ id: row.id, when: row.when, dot: row.dot as TimelineDot, ...(row.expanded === true ? { expanded: true } : {}), body: renderBody(row) }))` where `renderBody(row)` switches `row.kind`: `'stream'`→`bodyForStream(row.stream)`'s `.body`; `'drift'`→the drift JSX from `row.drift`; `'lifecycle'`→`lifecycleBody(row.lifecycle, row.lifecycle.agentLabel)`. `TimelineProjectionInput`/`TaskTransition` exported types and `projectTimeline`'s signature/return are **unchanged**; `CockpitForMe`/`FlowTimeline` are not touched.

> The implementer transcribes the JSX builders **verbatim** from the current file (Grounded-facts has them); only the field-access object is repointed. The agreement test (Task 7) is the proof this preserved behavior exactly — do not eyeball it.

- [ ] **Step 2: UI typecheck + build**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN` → `CLEAN`.
Run: `cd /c/Project-TOAD/toad-local/ui && npm run build 2>&1 | tail -2` → ends with a successful build. (Proves the thin adapter+renderer typechecks against the new core and the cockpit still compiles.)

---

## Task 7: Strict agreement test (post-refactor == frozen golden)

**Files:** Create `test/timelineComposition.agreement.test.js`

- [ ] **Step 1: Write the strict agreement test**

Create `test/timelineComposition.agreement.test.js`. It embeds the **identical** `h`/`ser` block (verbatim from the serializer section) + the **identical** verbatim body builders (`bodyForStreamEl`/`driftEl`/`lifecycleEl`, JSX→`h`, byte-copied from `scripts/captureTimelineCompositionGolden.mjs`'s versions — same logic, same text, same classNames), imports the pure `composeTimeline`, and asserts byte-identical to the Commit-1 golden:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { composeTimeline } from '../src/runtime/timelineComposition/index.js';

// === IDENTICAL to scripts/captureTimelineCompositionGolden.mjs ===
function h(type, props, ...children) { return { type, props: { ...(props || {}), children } }; }
const FRAG = 'FRAG';
function ser(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(ser).join('');
  const t = node.type, c = ser(node.props ? node.props.children : '');
  const cls = node.props && node.props.className;
  if (t === FRAG) return c;
  return cls ? `<${t}.${cls}>${c}</${t}>` : `<${t}>${c}</${t}>`;
}
// bodyForStreamEl/driftEl/lifecycleEl: byte-copied from the capture script.
// (Implementer pastes the exact same three functions used there.)
function renderBodyText(row) {
  if (row.kind === 'stream') return ser(bodyForStreamEl(row.stream));
  if (row.kind === 'drift') return ser(driftEl(row.drift));
  return ser(lifecycleEl(row.lifecycle));
}
// =================================================================

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.input.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.golden.json'), 'utf8'));

function adaptInput(input) {
  // The client adapter's job, reproduced here over the fixture's raw
  // StreamEntry-shaped rows. The fixture's stream entries carry `time`
  // (HH:MM:SS); reproduce parseStreamTimestamp VERBATIM so `ts` matches
  // what the .tsx adapter computes.
  const now = typeof input.now === 'number' ? input.now : Date.now();
  function parseStreamTimestamp(entry) {
    const parts = String(entry.time).split(':').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return now;
    const [hh, mm, ss] = parts;
    const c = new Date(now); c.setHours(hh, mm, ss, 0);
    let ts = c.getTime(); if (ts > now) ts -= 24 * 60 * 60 * 1000;
    return ts;
  }
  const agentStreams = {};
  for (const [aid, entries] of Object.entries(input.agentStreams ?? {})) {
    agentStreams[aid] = (entries ?? []).map((e) => ({ entryId: e.id, kind: e.kind, tool: e.tool, body: e.body, ts: parseStreamTimestamp(e) }));
  }
  return { ...input, agentStreams };
}

test('agreement: post-refactor composeTimeline path is BYTE-IDENTICAL to the frozen pristine golden', () => {
  const out = cases.map((c) => ({
    name: c.name,
    rows: composeTimeline(adaptInput(c.input)).map((row) => ({
      id: row.id,
      when: row.when,
      dot: row.dot,
      ...(row.expanded === true ? { expanded: true } : {}),
      bodyText: renderBodyText(row),
    })),
  }));
  assert.deepEqual(out, golden);   // STRICT — any divergence fails. No behaviorTable (it is a refactor).
});
```

> The `bodyForStreamEl`/`driftEl`/`lifecycleEl` pasted here MUST be byte-identical to the capture script's (which were transcribed verbatim from the pristine `.tsx`). The golden was produced by `verbatim projectTimeline → these element builders → ser`; this test produces `composeTimeline → these element builders → ser`. Byte-equality ⟺ `composeTimeline` reproduced the pristine composition exactly. (`parseStreamTimestamp` is reproduced in `adaptInput` to mirror the client adapter; it is the SAME function the capture script's verbatim `projectTimeline` used internally, so `ts` is identical on both sides.)

- [ ] **Step 2: Run — verify pass (byte-identical)**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/timelineComposition.agreement.test.js`
Expected: PASS (1/1). A FAIL = the extraction changed behavior — fix `composeTimeline`/the builders until byte-identical; **never** edit the golden, never add a behaviorTable.

---

## Task 8: Wire Commit-2 suites + full gates + **Commit 2**

**Files:** Modify `package.json`

- [ ] **Step 1: Wire the 3 Commit-2 suites** — append to `scripts.test` (leading space):

```
 && node --no-warnings --test test/timelineComposition.compose.test.js && node --no-warnings --test test/timelineComposition.purity.test.js && node --no-warnings --test test/timelineComposition.agreement.test.js
```

Validate: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log(['timelineComposition.compose','timelineComposition.purity','timelineComposition.agreement'].every(s=>t.includes(s)))"` → `true`.

- [ ] **Step 2: Full root suite — fail 0, all 4 P2a suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (pass|fail)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'` → `fail 0`.
Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -cE "baseline locked: pristine|per-agent slice\\(-4\\) window|module imports no node:|post-refactor composeTimeline path is BYTE-IDENTICAL"` → ≥ `4` (un-wired-test trap; the 4 P2a suites genuinely ran).

- [ ] **Step 3: UI gate**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN` → `CLEAN`.
Run: `cd /c/Project-TOAD/toad-local/ui && npm run build 2>&1 | tail -2` → successful build.

- [ ] **Step 4: Whole-implementation review (pre-commit gate)**

Review the whole Commit-2 surface as one unit (the gate that caught the auth Critical): `composeTimeline` replicates the EXACT pristine algorithm (window/cap/drift-fold/lifecycle-fold/merge/sort/`_ts` keys/`id`/`when`/`dot`/`expanded`); the `.tsx` JSX builders are verbatim, only repointed to `ComposedRow` payloads; `projectTimeline`'s public signature/return unchanged (CockpitForMe/FlowTimeline untouched — `git diff` confirms zero changes there); the agreement test's `h`/`ser`/builders are byte-identical to the capture script's; the agreement is STRICT (no behaviorTable); purity holds + `DOT`==`FlowTimeline` union; no `react` in `src/`; the 4 suites genuinely execute under `npm test`. Resolve any finding before committing.

- [ ] **Step 5: Commit 2**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/timelineComposition/composeTimeline.js toad-local/src/runtime/timelineComposition/index.js toad-local/test/timelineComposition.compose.test.js toad-local/test/timelineComposition.purity.test.js toad-local/test/timelineComposition.agreement.test.js toad-local/ui/src/components/cockpit/timelineProjection.tsx toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
refactor(timeline): extract pure composeTimeline core; client byte-identical (Readability Layer-2 P2a, Commit 2)

New zero-import server-importable src/runtime/timelineComposition/
replicating the EXACT pre-refactor projectTimeline algorithm as
JSX-free ComposedRow[] (per-agent slice(-4) window, sort/cap,
drift-pair fold |Δ|≥3/cap-2/NaN-skip, lifecycle fold, merge, _ts-keyed
sort, id/when/dot/expanded). timelineProjection.tsx reduced to a thin
adapter (StreamEntry→normalized, ts via the kept-client
parseStreamTimestamp) + renderer (ComposedRow → TimelineEvent via the
VERBATIM JSX bodyForStream/lifecycleBody/drift-body, only repointed to
the payload); projectTimeline's public signature/return unchanged →
CockpitForMe/FlowTimeline byte-untouched. STRICT agreement test:
post-refactor composeTimeline path is byte-identical to the frozen
pristine golden (Commit 1) — no behaviorTable (it is a refactor).
Purity-guarded; DOT==FlowTimeline union by guard-test not coupling.
Root fail 0; UI tsc/build green; whole-impl reviewed. No behavior
change. Out: P2b spans, P3 LLM, historical-view UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 6: Post-commit verify**

`git -C /c/Project-TOAD show --stat HEAD` — exactly the 7 listed files, no stray (esp. NOT `CockpitForMe.tsx`/`FlowTimeline.tsx`). `git -C /c/Project-TOAD status --porcelain` — clean of all P2a feature/plan files. HEAD~1 = Commit 1.

---

## Notes for the executor (grounded pins — confirm against code, do not pre-invent)

- **No `react`/`react-dom` at the root.** Never `import 'react'`/`renderToStaticMarkup` in any root-run test or `src/`. The `h`/`ser` element serializer IS the body comparator; it must be **character-identical** in `scripts/captureTimelineCompositionGolden.mjs` and `test/timelineComposition.agreement.test.js` (copy-paste, do not paraphrase). Same for `bodyForStreamEl`/`driftEl`/`lifecycleEl`.
- **The golden is captured ONCE from pristine code (Commit 1) and never auto-rewritten.** If the agreement test fails in Commit 2, the bug is in `composeTimeline`/the relocated builders — fix code, never the golden, never add a behaviorTable (it is a refactor; the spec mandates zero divergence).
- **`projectTimeline` public contract is frozen.** `git diff` `CockpitForMe.tsx`/`FlowTimeline.tsx` must be empty after Commit 2. The exported `TimelineProjectionInput`/`TaskTransition` types and `projectTimeline(input):TimelineEvent[]` signature/return are unchanged.
- **Import path** `../../../../src/runtime/timelineComposition/index.js` from `timelineProjection.tsx` (4 levels — confirmed; `agentStream.ts` at 3 levels uses `../../../src/runtime/eventNarration/index.js`).
- **`expanded` semantics** (subtle): pristine `streamEvents` set `expanded: idx===0 ? true : undefined`; `TimelineEvent` then carries the key present-or-true. Golden + agreement both normalize via `row.expanded === true ? { expanded:true } : {}` so the key is omitted unless true — applied IDENTICALLY both sides. Do not "fix" this asymmetry; preserving it is the point.
- **§8d:** if any grounded fact (the algorithm transcription, the builder field-sets, the import path, react-absence) is wrong at implementation time, STOP and surface it (controller pre-emptive ratification), as in the auth/compaction/narration cycles — do not code around a wrong plan.
