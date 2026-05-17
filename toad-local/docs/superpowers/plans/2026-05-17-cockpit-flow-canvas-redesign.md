# Cockpit Flow-Canvas Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the stalled For-Me "Flow" cockpit redesign by rebuilding `CockpitFlowCanvas` to the operator's mockup (per-agent pivot, ticker bar, tasks-underneath, lead/done/warning cards, light connectors), adapted responsively to real data on the other agent's stalled shell, resolving the "flow looks broken" CSS/markup mismatch.

**Architecture:** A rewritten pure model `flowCanvasModel.ts` (`buildFlowCanvas`, agent-pivot, deterministic/total) feeds a rewritten presentational `CockpitFlowCanvas.tsx` (unchanged inbound props) rendered inside the existing `.cockpit-flow-main` shell; all flow-canvas CSS is authored fresh in `cockpit.css` with project tokens and the now-orphaned old rules surgically removed from `app-shell.css`.

**Tech Stack:** React + TypeScript (Vite), `node:test` `.mjs` ui tests (compiled via `tsc` to a tmp dir then dynamically imported), the project's existing design tokens.

**Spec:** `docs/superpowers/specs/2026-05-17-cockpit-flow-canvas-redesign-design.md` (committed `4886a3a`).

**Commit model:** 2 commits (pure-core-first). Tasks 1–2 → **Commit 1** (pure models). Tasks 3–6 → **Commit 2** (components + styling). Tasks within a commit accumulate UNCOMMITTED; only Tasks 2 and 6 commit.

**Session conventions:** Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, `git -c commit.gpgsign=false`, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. All `npm`/`node --test` commands run from `C:\Project-TOAD\toad-local\ui` (`cd /c/Project-TOAD/toad-local/ui && …`).

**Local reference (NEVER commit):** `toad-local/.mockup-symphony-flow/` (operator's mockup — screenshots + jsx). Implementers may read it for visual reference. It is deleted in Task 6 and excluded from every commit by the hygiene gate.

---

## File Structure

| File | Responsibility |
|---|---|
| `ui/src/components/flowCanvasModel.ts` | **Rewrite.** Pure `buildFlowCanvas()` — agent-pivot model. No React, no IO, total. |
| `ui/test/flowCanvasModel.test.mjs` | **Rewrite.** TDD suite for `buildFlowCanvas` (same `tsc`→import harness as today). |
| `ui/src/components/cockpit/forMeViewMode.ts` | **Unchanged.** Staged in Commit 1 (flow depends on it). Do NOT edit. |
| `ui/test/forMeViewMode.test.mjs` | **Unchanged.** Staged in Commit 1. Do NOT edit. |
| `ui/src/components/cockpit/forMeFlowPanels.ts` | **Unchanged.** Staged in Commit 1. Do NOT edit. |
| `ui/test/forMeFlowPanels.test.mjs` | **Unchanged.** Staged in Commit 1. Do NOT edit. |
| `ui/src/components/CockpitFlowCanvas.tsx` | **Rewrite.** Presentational; consumes `buildFlowCanvas`; inbound props byte-identical. |
| `ui/src/components/cockpit/CockpitForMe.tsx` | **Unchanged.** Staged in Commit 2 (stalled shell the flow needs). Do NOT edit. |
| `ui/src/components/cockpit/CockpitScreenV2.tsx` | **Unchanged.** Staged in Commit 2 (stalled 1-line). Do NOT edit. |
| `ui/src/styles/cockpit.css` | **Modify (append).** Add the complete fresh flow-canvas rule set. |
| `ui/src/styles/app-shell.css` | **Modify (surgical delete).** Remove ONLY the now-orphaned old `.flow-*` rules, per-selector, grep-verified. |

**Grounded facts (verified against shipped code):**
- `@/types` (`ui/src/types/index.ts`): `RoleId='lead'|'developer'|'reviewer'|'researcher'|'debugger'|'qa'|'architect'|'designer'`; `TaskStatus='todo'|'in-progress'|'review'|'done'|'blocked'|'rejected'`; `AgentStatus='thinking'|'live'|'idle'|'launching'|'error'`; `RuntimeStatus='live'|'idle'|'launching'|'stopped'|'error'`; `Agent{id,name,role,avatar,status,task,activity?}`; `UiTask{id,title,status,assignee,type,riskLevel?,requiresHumanApproval?,humanApproved?,matchedRules?}`; `Team{name,status,members:Agent[]}`; `Runtime{id,agent,provider,model,status}`. `DriftRunResult` (`@/hooks/useDrift`): `{teamScore:number, status:'healthy'|'watch'|'warning'|'critical', perTaskScores:Record<string,number>, history:[...]}`.
- `roleStyle(role)` (`@/data/roles`) returns `{'--accent':'var(--role-X)','--accent-bg':'var(--role-X-bg)'}`.
- `DriftBadge` treats `score >= 66` as red/elevated — the grounded `isDriftElevated` the component injects is `(s) => s >= 66`.
- The current `<CockpitFlowCanvas .../>` invocation (`CockpitForMe.tsx:478-510`) passes exactly: `team, tasks, runtimes, messages, agentStreams, selectedTaskId, selectedAgentId, driftData={drift}, onSelectTask, onSelectAgent, onOpenTask, onOpenLogs, onCreateTask`. The rewrite MUST keep this exact `CockpitFlowCanvasProps` interface so `CockpitForMe.tsx` needs no change.
- `app-shell.css` `.flow-*` rules are **interleaved** with non-flow rules (`.flow-canvas`@753 then `.cockpit-review-pane`@766 …). Removal is **per-selector surgical**, never a line-range delete.
- ui `.mjs` tests cannot import `.ts`; the existing `flowCanvasModel.test.mjs` compiles the source via `node_modules/typescript/bin/tsc` to a tmpdir then dynamically imports the `.js`. Reuse that harness verbatim.

---

## Task 1: Rewrite the pure model `flowCanvasModel.ts` + its test (TDD — Commit-1 epicenter)

**Files:**
- Rewrite: `ui/src/components/flowCanvasModel.ts`
- Rewrite: `ui/test/flowCanvasModel.test.mjs`

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `ui/test/flowCanvasModel.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function load() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-flow-canvas-model-'));
  const source = path.resolve('src/components/flowCanvasModel.ts');
  const outDir = path.join(tmp, 'out');
  const tsc = spawnSync(
    process.execPath,
    [
      path.resolve('node_modules/typescript/bin/tsc'),
      source,
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--outDir', outDir,
      '--skipLibCheck',
      '--strict',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  const mod = await import(pathToFileURL(path.join(outDir, 'flowCanvasModel.js')).href);
  return { mod, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

const M = (id, role, extra = {}) => ({ id, name: id.toUpperCase(), role, avatar: id[0], status: 'idle', task: null, ...extra });
const T = (id, status, assignee, extra = {}) => ({ id, title: `title ${id}`, status, assignee, type: 'feature', ...extra });

test('buildFlowCanvas: lead pick, pipeline order, tasks-underneath, ticker, doneBucket, warnings', async () => {
  const { mod, cleanup } = await load();
  try {
    const team = { members: [
      M('dev1', 'developer'),
      M('lead1', 'lead'),
      M('arch1', 'architect'),
      M('rev1', 'reviewer'),
      M('weird1', 'designer'),
    ] };
    const tasks = [
      T('T-1', 'todo', 'dev1'),
      T('T-2', 'in-progress', 'dev1'),
      T('T-3', 'done', 'dev1'),
      T('T-4', 'rejected', 'dev1'),
      T('T-5', 'review', 'rev1', { requiresHumanApproval: true, humanApproved: false }),
      T('T-6', 'blocked', 'arch1'),
      T('T-7', 'done', 'arch1'),
      T('T-8', 'todo', 'ghost'),
    ];
    const runtimes = [
      { agent: 'dev1', status: 'live' },
      { agent: 'lead1', status: 'launching' },
      { agent: 'rev1', status: 'idle' },
    ];
    const drift = { teamScore: 42, perTaskScores: { 'T-2': 80, 'T-6': 10 } };

    const r = mod.buildFlowCanvas({ team, tasks, runtimes, drift, isDriftElevated: (s) => s >= 66 });

    // lead = first role==='lead'
    assert.equal(r.lead.member.id, 'lead1');
    assert.equal(r.lead.coordinating, 4);
    // pipeline order: architect(0) -> developer(2) -> reviewer(4) -> designer(6); lead excluded
    assert.deepEqual(r.agents.map((a) => a.member.id), ['arch1', 'dev1', 'rev1', 'weird1']);
    // tasks-underneath dev1: active only (todo,in-progress) — excludes done/rejected, stable order
    const dev = r.agents.find((a) => a.member.id === 'dev1');
    assert.deepEqual(dev.tasks.map((t) => t.id), ['T-1', 'T-2']);
    assert.equal(dev.taskCount, 2);
    assert.equal(dev.runtimeStatus, 'live');
    // unassigned task T-8 (assignee 'ghost') under no agent
    assert.ok(r.agents.every((a) => !a.tasks.some((t) => t.id === 'T-8')));
    // ticker
    assert.deepEqual(r.ticker, {
      live: 2,          // dev1 live + lead1 launching
      open: 5,          // T-1,T-2,T-5,T-6,T-8 (not done/rejected)
      inReview: 1,      // T-5
      blocked: 1,       // T-6
      done: 2,          // T-3,T-7
      driftPct: 42,
    });
    // doneBucket: count + recent (<=5, input order)
    assert.equal(r.doneBucket.count, 2);
    assert.deepEqual(r.doneBucket.recent.map((t) => t.id), ['T-3', 'T-7']);
    // warnings: approval (T-5) + drift (T-2 score 80 >= 66; T-6 score 10 excluded)
    const kinds = r.warnings.map((w) => `${w.kind}:${w.taskId}`).sort();
    assert.deepEqual(kinds, ['approval:T-5', 'drift:T-2']);
    assert.equal(r.lead.runtimeStatus, 'launching');
  } finally {
    await cleanup();
  }
});

test('buildFlowCanvas: unmapped role -> rank 99, stable same-role order', async () => {
  const { mod, cleanup } = await load();
  try {
    const team = { members: [
      M('a', 'developer'), M('b', 'developer'), M('c', 'qa'),
      M('d', 'lead'), M('z', 'researcher'),
    ] };
    const r = mod.buildFlowCanvas({ team, tasks: [], runtimes: [], drift: null });
    // researcher(1) -> developer(2) a,b stable -> qa(5); lead excluded
    assert.deepEqual(r.agents.map((x) => x.member.id), ['z', 'a', 'b', 'c']);
  } finally {
    await cleanup();
  }
});

test('buildFlowCanvas: edge cases — empty team, lead-only, no drift, no runtimes, never throws', async () => {
  const { mod, cleanup } = await load();
  try {
    const empty = mod.buildFlowCanvas({ team: { members: [] }, tasks: [], runtimes: [], drift: null });
    assert.equal(empty.lead, null);
    assert.deepEqual(empty.agents, []);
    assert.deepEqual(empty.doneBucket, { count: 0, recent: [] });
    assert.deepEqual(empty.warnings, []);
    assert.deepEqual(empty.ticker, { live: 0, open: 0, inReview: 0, blocked: 0, done: 0, driftPct: null });

    const leadOnly = mod.buildFlowCanvas({ team: { members: [M('L', 'lead')] }, tasks: [T('T-1', 'todo', 'L')], runtimes: [], drift: null });
    assert.equal(leadOnly.lead.member.id, 'L');
    assert.deepEqual(leadOnly.agents, []);
    assert.equal(leadOnly.lead.runtimeStatus, 'idle'); // falls back to member.status

    // no lead role -> first member is lead; default isDriftElevated -> no drift warnings
    const noLead = mod.buildFlowCanvas({
      team: { members: [M('x', 'developer')] },
      tasks: [], runtimes: [], drift: { teamScore: 99, perTaskScores: { 'T-9': 100 } },
    });
    assert.equal(noLead.lead.member.id, 'x');
    assert.deepEqual(noLead.agents, []);
    assert.deepEqual(noLead.warnings, []); // default isDriftElevated = () => false

    // totally malformed input must not throw
    assert.doesNotThrow(() => mod.buildFlowCanvas({}));
    const junk = mod.buildFlowCanvas({});
    assert.equal(junk.lead, null);
    assert.deepEqual(junk.agents, []);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /c/Project-TOAD/toad-local/ui && node --test test/flowCanvasModel.test.mjs`
Expected: FAIL — `tsc` compiles the OLD `flowCanvasModel.ts` (which exports `buildFlowStages`, not `buildFlowCanvas`), so `mod.buildFlowCanvas` is `undefined` → assertions throw. Confirm the failure is "buildFlowCanvas is not a function" (the right reason), not a harness error.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `ui/src/components/flowCanvasModel.ts` with:

```ts
// Readability/cockpit — pure model for the For-Me Flow canvas.
// Agent-pivot: lead + members in pipeline order, each with its assigned
// active tasks. Deterministic, React-free, total (never throws). The
// drift-elevation predicate is INJECTED so the model stays pure and the
// threshold stays consistent with the rest of the UI (DriftBadge).

export type FlowStatus = 'todo' | 'in-progress' | 'review' | 'done' | 'blocked' | 'rejected';

export interface FlowMember {
  id: string;
  name: string;
  role: string;
  avatar: string;
  status: string;
  activity?: { label?: string } | null;
}
export interface FlowTask {
  id: string;
  title: string;
  status: FlowStatus;
  assignee: string;
  type?: string;
  riskLevel?: string | null;
  requiresHumanApproval?: boolean;
  humanApproved?: boolean;
  matchedRules?: unknown;
}
export interface FlowRuntimeLite { agent: string; status: string }
export interface FlowDrift { teamScore: number; perTaskScores: Record<string, number> }
export interface FlowTeam { members?: FlowMember[] }

export interface FlowTicker {
  live: number; open: number; inReview: number;
  blocked: number; done: number; driftPct: number | null;
}
export interface FlowLead {
  member: FlowMember; runtimeStatus: string; activity: string; coordinating: number;
}
export interface FlowAgent {
  member: FlowMember; runtimeStatus: string; statusLabel: string;
  activity: string; tasks: FlowTask[]; taskCount: number;
}
export interface FlowWarning {
  id: string; kind: 'approval' | 'drift';
  title: string; sub: string; desc: string; taskId?: string;
}
export interface FlowCanvasModel {
  ticker: FlowTicker;
  lead: FlowLead | null;
  agents: FlowAgent[];
  doneBucket: { count: number; recent: FlowTask[] };
  warnings: FlowWarning[];
}

const PIPELINE_RANK: Record<string, number> = {
  architect: 0, researcher: 1, developer: 2, debugger: 3,
  reviewer: 4, qa: 5, designer: 6,
};

function activityLabel(m: FlowMember | null | undefined): string {
  return m && m.activity && typeof m.activity.label === 'string' ? m.activity.label : '';
}
function isActive(status: string): boolean {
  return status !== 'done' && status !== 'rejected';
}

export function buildFlowCanvas(input: {
  team?: FlowTeam;
  tasks?: FlowTask[];
  runtimes?: FlowRuntimeLite[];
  drift?: FlowDrift | null;
  isDriftElevated?: (score: number) => boolean;
} = {}): FlowCanvasModel {
  const members: FlowMember[] = Array.isArray(input?.team?.members) ? input.team!.members! : [];
  const tasks: FlowTask[] = Array.isArray(input?.tasks) ? input.tasks! : [];
  const runtimes: FlowRuntimeLite[] = Array.isArray(input?.runtimes) ? input.runtimes! : [];
  const drift: FlowDrift | null = input?.drift && typeof input.drift === 'object' ? input.drift : null;
  const isDriftElevated = typeof input?.isDriftElevated === 'function' ? input.isDriftElevated : () => false;

  const runtimeByAgent = new Map<string, string>();
  for (const r of runtimes) {
    if (r && typeof r.agent === 'string') runtimeByAgent.set(r.agent, r.status);
  }

  const lead: FlowMember | null =
    members.find((m) => m && m.role === 'lead') ?? members[0] ?? null;
  const nonLead = members.filter((m) => m && m !== lead);

  const ordered = nonLead
    .map((m, i) => ({ m, i, rank: PIPELINE_RANK[m.role] ?? 99 }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.m);

  const agents: FlowAgent[] = ordered.map((m) => {
    const myTasks = tasks.filter((t) => t && t.assignee === m.id && isActive(t.status));
    const rs = runtimeByAgent.get(m.id) ?? m.status;
    return {
      member: m,
      runtimeStatus: rs,
      statusLabel: String(rs),
      activity: activityLabel(m),
      tasks: myTasks,
      taskCount: myTasks.length,
    };
  });

  const doneTasks = tasks.filter((t) => t && t.status === 'done');
  const ticker: FlowTicker = {
    live: runtimes.filter((r) => r && (r.status === 'live' || r.status === 'launching')).length,
    open: tasks.filter((t) => t && isActive(t.status)).length,
    inReview: tasks.filter((t) => t && t.status === 'review').length,
    blocked: tasks.filter((t) => t && t.status === 'blocked').length,
    done: doneTasks.length,
    driftPct: drift && typeof drift.teamScore === 'number' ? drift.teamScore : null,
  };

  const warnings: FlowWarning[] = [];
  for (const t of tasks) {
    if (t && t.requiresHumanApproval && !t.humanApproved) {
      warnings.push({
        id: `approval-${t.id}`, kind: 'approval',
        title: 'Approval needed', sub: t.id, desc: t.title, taskId: t.id,
      });
    }
  }
  if (drift && drift.perTaskScores && typeof drift.perTaskScores === 'object') {
    for (const [id, score] of Object.entries(drift.perTaskScores)) {
      if (typeof score === 'number' && isDriftElevated(score)) {
        warnings.push({
          id: `drift-${id}`, kind: 'drift',
          title: `Drift on ${id}`, sub: 'spec ≠ build',
          desc: 'Build approach diverged; review suggested.', taskId: id,
        });
      }
    }
  }

  return {
    ticker,
    lead: lead
      ? {
          member: lead,
          runtimeStatus: runtimeByAgent.get(lead.id) ?? lead.status,
          activity: activityLabel(lead),
          coordinating: nonLead.length,
        }
      : null,
    agents,
    doneBucket: { count: doneTasks.length, recent: doneTasks.slice(-5) },
    warnings,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /c/Project-TOAD/toad-local/ui && node --test test/flowCanvasModel.test.mjs`
Expected: PASS — `# pass 3`, `# fail 0`.

---

## Task 2: Verify foundation models green + Commit 1

**Files:** none changed (verification + commit only).

- [ ] **Step 1: Verify the unchanged foundation pure models still pass**

Run: `cd /c/Project-TOAD/toad-local/ui && node --test test/forMeViewMode.test.mjs test/forMeFlowPanels.test.mjs test/flowCanvasModel.test.mjs`
Expected: all green, `# fail 0`. (`forMeViewMode.test.mjs`/`forMeFlowPanels.test.mjs` are unchanged and must still pass; `flowCanvasModel.test.mjs` is the Task-1 rewrite.)

- [ ] **Step 2: Confirm `forMeViewMode.ts` / `forMeFlowPanels.ts` were NOT modified**

Run: `git -C /c/Project-TOAD diff --stat -- toad-local/ui/src/components/cockpit/forMeViewMode.ts toad-local/ui/src/components/cockpit/forMeFlowPanels.ts`
Expected: EMPTY (these foundation models are committed as-is, not edited).

- [ ] **Step 3: Commit-hygiene gate (controller-verified)**

Run: `git -C /c/Project-TOAD add toad-local/ui/src/components/flowCanvasModel.ts toad-local/ui/test/flowCanvasModel.test.mjs toad-local/ui/src/components/cockpit/forMeViewMode.ts toad-local/ui/test/forMeViewMode.test.mjs toad-local/ui/src/components/cockpit/forMeFlowPanels.ts toad-local/ui/test/forMeFlowPanels.test.mjs`
Then: `git -C /c/Project-TOAD diff --cached --name-only`
Expected: EXACTLY those 6 paths — no `src-tauri/`, no backend, no `.mockup-symphony-flow/`, no `CockpitForMe.tsx`/`CockpitFlowCanvas.tsx`.
Then: `git -C /c/Project-TOAD diff --cached -- toad-local/ui/src/components/cockpit/forMeViewMode.ts | grep -ci grid` → expected `0` (no grid-view leakage; `forMeViewMode` stays `'timeline'|'flow'`).

- [ ] **Step 4: Commit 1**

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(cockpit): agent-pivot flow-canvas pure model (flow redesign, Commit 1)

Rewrite flowCanvasModel.ts from status-grouping to the agent-pivot
buildFlowCanvas(): lead + members in pipeline role order, each with
its assigned active tasks; ticker counts; doneBucket; approval/drift
warnings via an INJECTED isDriftElevated predicate (default false so
absence never fabricates). Deterministic, total, never throws. Commits
the unchanged stalled foundation pure models (forMeViewMode/
forMeFlowPanels + tests) the flow depends on.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Post-commit verify**

Run: `git -C /c/Project-TOAD show --stat HEAD | tail -n 9`
Expected: EXACTLY 6 files (flowCanvasModel.ts/.test.mjs, forMeViewMode.ts/.test.mjs, forMeFlowPanels.ts/.test.mjs). No stray.
Run: `git -C /c/Project-TOAD diff --stat 4886a3a HEAD -- toad-local/src` → EXPECT EMPTY (backend untouched).

---

## Task 3: Rewrite `CockpitFlowCanvas.tsx` (Commit-2 epicenter)

**Files:**
- Rewrite: `ui/src/components/CockpitFlowCanvas.tsx`

- [ ] **Step 1: Replace the component**

Replace the entire contents of `ui/src/components/CockpitFlowCanvas.tsx` with:

```tsx
import { useMemo } from 'react';
import type { Message, Runtime, Team, UiTask } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { TaskRiskBadge } from './TaskRiskBadge';
import { DriftBadge } from './DriftBadge';
import type { DriftRunResult } from '@/hooks/useDrift';
import type { StreamEntry } from '@/utils/agentStream';
import { buildFlowCanvas } from './flowCanvasModel';

interface CockpitFlowCanvasProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  agentStreams: Record<string, StreamEntry[]>;
  selectedTaskId: string | null;
  selectedAgentId: string | null;
  driftData: DriftRunResult | null;
  onSelectTask: (taskId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenLogs: (runtimeId: string) => void;
  onCreateTask: () => void;
}

// DriftBadge treats >= 66 as red/elevated; keep the flow warning in lockstep.
const isDriftElevated = (score: number) => score >= 66;

function runtimeStatusClass(status: string): string {
  if (status === 'live') return 'live active';
  if (status === 'launching' || status === 'thinking') return 'thinking active';
  if (status === 'error') return 'err active';
  return 'idle';
}

export function CockpitFlowCanvas({
  team,
  tasks,
  runtimes,
  messages,
  agentStreams,
  selectedTaskId,
  selectedAgentId,
  driftData,
  onSelectTask,
  onSelectAgent,
  onOpenTask,
  onOpenLogs,
  onCreateTask,
}: CockpitFlowCanvasProps) {
  const model = useMemo(
    () => buildFlowCanvas({ team, tasks, runtimes, drift: driftData, isDriftElevated }),
    [team, tasks, runtimes, driftData],
  );

  const runtimeByAgent = useMemo(
    () => new Map(runtimes.map((r) => [r.agent, r])),
    [runtimes],
  );

  // Latest visible activity blurb per member (newest stream entry, else
  // newest message). O(messages + members). Component concern — the pure
  // model is deliberately not given messages/agentStreams.
  const latestByAgent = useMemo(() => {
    const map = new Map<string, string>();
    const memberIds = new Set(team.members.map((m) => m.id));
    for (const id of memberIds) {
      const entries = agentStreams[id];
      if (entries) {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const body = entries[i].body.trim();
          if (body) { map.set(id, body); break; }
        }
      }
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (map.size === memberIds.size) break;
      const m = messages[i];
      const peer = memberIds.has(m.from) ? m.from : memberIds.has(m.to) ? m.to : null;
      if (peer && !map.has(peer)) map.set(peer, m.body);
    }
    return map;
  }, [team.members, messages, agentStreams]);

  const activityFor = (id: string, modelActivity: string, fallback: string) =>
    latestByAgent.get(id) || modelActivity || fallback;

  const activeTaskCount = model.ticker.open;
  if (team.members.length === 0 && activeTaskCount === 0) {
    return (
      <div className="flowx-canvas empty" aria-label="Team flow canvas">
        <div className="flowx-empty">
          <Icon name="workflow" size={28} />
          <h2>No active team graph</h2>
          <p>Create or launch a team to see agents, tasks, ownership, and review flow here.</p>
          <button className="btn btn-primary" type="button" onClick={onCreateTask}>
            <Icon name="plus" size={13} />
            Create task
          </button>
        </div>
      </div>
    );
  }

  const { ticker, lead, agents, doneBucket, warnings } = model;

  return (
    <div className="flowx-canvas" aria-label="Team flow canvas">
      <div className="flowx-ticker" aria-label="Team flow stats">
        <span className="flowx-tick live"><i className="status-dot live active" />{ticker.live} live</span>
        <span className="flowx-tick">{ticker.open} open</span>
        <span className="flowx-tick">{ticker.inReview} in review</span>
        <span className={`flowx-tick ${ticker.blocked > 0 ? 'warn' : ''}`}>{ticker.blocked} blocked</span>
        <span className="flowx-tick">{ticker.done} done</span>
        <span className="flowx-drift">
          DRIFT
          <span className="flowx-drift-bar" aria-hidden="true">
            <span style={{ width: `${ticker.driftPct == null ? 0 : Math.max(0, Math.min(100, ticker.driftPct))}%` }} />
          </span>
          {ticker.driftPct == null ? '-' : `${ticker.driftPct}%`}
        </span>
      </div>

      <div className="flowx-pipeline">
        <div className="flowx-col flowx-col-lead">
          {lead && (
            <button
              type="button"
              className={`flowx-lead ${selectedAgentId === lead.member.id ? 'active' : ''}`}
              style={roleStyle('lead')}
              onClick={() => onSelectAgent(lead.member.id)}
              onDoubleClick={() => {
                const rt = runtimeByAgent.get(lead.member.id);
                if (rt) onOpenLogs(rt.id);
              }}
            >
              <span className="flowx-card-top">
                <span className={`status-dot ${runtimeStatusClass(lead.runtimeStatus)}`} />
                <span className="agent-avatar">{lead.member.avatar}</span>
                <span className="flowx-card-id">
                  <em>Lead Agent</em>
                  <strong>{lead.member.name}</strong>
                </span>
              </span>
              <span className="flowx-card-activity">
                {activityFor(lead.member.id, lead.activity, `Coordinating ${lead.coordinating} agents`)}
              </span>
              <span className="flowx-card-foot">
                <span><strong>{lead.coordinating}</strong> agents</span>
              </span>
            </button>
          )}
          {warnings.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`flowx-warn ${w.kind}`}
              onClick={() => { if (w.taskId) onSelectTask(w.taskId); }}
            >
              <span className="flowx-warn-head">
                <Icon name="alertTriangle" size={13} />
                <span>
                  <strong>{w.title}</strong>
                  <em>{w.sub}</em>
                </span>
              </span>
              <span className="flowx-warn-desc">{w.desc}</span>
              <span className="flowx-warn-cta">
                {w.kind === 'approval' ? 'Review now' : 'Investigate'}
                <Icon name="chevronRight" size={11} />
              </span>
            </button>
          ))}
        </div>

        {agents.map((a) => (
          <div className="flowx-col" key={a.member.id}>
            <button
              type="button"
              className={`flowx-agent ${selectedAgentId === a.member.id ? 'active' : ''}`}
              style={roleStyle(a.member.role as Parameters<typeof roleStyle>[0])}
              onClick={() => onSelectAgent(a.member.id)}
              onDoubleClick={() => {
                const rt = runtimeByAgent.get(a.member.id);
                if (rt) onOpenLogs(rt.id);
              }}
            >
              <span className="flowx-card-top">
                <span className={`status-dot ${runtimeStatusClass(a.runtimeStatus)}`} />
                <span className="agent-avatar">{a.member.avatar}</span>
                <span className="flowx-card-id">
                  <em>{a.member.role}</em>
                  <strong>{a.member.name}</strong>
                </span>
              </span>
              <span className="flowx-card-activity">
                {activityFor(a.member.id, a.activity, a.statusLabel)}
              </span>
              <span className="flowx-card-foot">
                <span><strong>{a.taskCount}</strong> tasks</span>
                <span className={`flowx-status ${runtimeStatusClass(a.runtimeStatus)}`}>{a.statusLabel}</span>
              </span>
            </button>
            <div className="flowx-spine" aria-hidden="true" />
            <div className="flowx-tasks">
              {a.tasks.length === 0 ? (
                <div className="flowx-task-empty">No tasks</div>
              ) : a.tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`flowx-task ${selectedTaskId === t.id ? 'active' : ''}`}
                  onClick={() => onSelectTask(t.id)}
                  onDoubleClick={() => onOpenTask(t.id)}
                >
                  <span className="flowx-task-top">
                    <span className="task-id">{t.id}</span>
                    <span className={`cockpit-status ${t.status}`}>{t.status}</span>
                  </span>
                  <strong>{t.title}</strong>
                  <span className="flowx-task-meta">
                    {t.type === 'bug' && <span className="task-bug-badge">Bug</span>}
                    {t.riskLevel && (
                      <TaskRiskBadge
                        level={t.riskLevel}
                        requiresHumanApproval={t.requiresHumanApproval}
                        humanApproved={t.humanApproved}
                        matchedRules={t.matchedRules}
                      />
                    )}
                    <DriftBadge score={driftData?.perTaskScores?.[t.id]} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="flowx-col flowx-col-done">
          <div className="flowx-done">
            <span className="flowx-done-head">
              <Icon name="check" size={12} />
              <span>Ready</span>
              <strong>{doneBucket.count}</strong>
            </span>
            <div className="flowx-done-list">
              {doneBucket.recent.length === 0 ? (
                <div className="flowx-task-empty">Nothing shipped yet</div>
              ) : doneBucket.recent.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flowx-done-line"
                  onClick={() => onSelectTask(t.id)}
                  onDoubleClick={() => onOpenTask(t.id)}
                >
                  <span className="task-id">{t.id}</span>
                  <span className="flowx-done-title">{t.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

(Notes for the implementer: this preserves the exact `CockpitFlowCanvasProps` interface so `CockpitForMe.tsx` is unchanged. New class prefix `flowx-` avoids ALL collision with the old `app-shell.css` `.flow-*` rules — the redesign owns a clean namespace; the old rules become provably orphaned. `Icon` names used: `workflow`, `plus`, `alertTriangle`, `chevronRight`, `check` — if any name does not exist in `./Icon`, substitute the closest existing one by reading `ui/src/components/Icon.tsx` first; do NOT invent icons. Reused as-is: `status-dot`/`agent-avatar`/`task-id`/`cockpit-status`/`task-bug-badge` classes, `TaskRiskBadge`/`DriftBadge`, `roleStyle`.)

- [ ] **Step 2: Typecheck the component compiles**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: clean (zero TS errors). If an `Icon name=` does not typecheck, read `ui/src/components/Icon.tsx`, pick the nearest existing icon, fix, re-run. Do not proceed until typecheck is clean.

---

## Task 4: Author the fresh flow-canvas CSS in `cockpit.css` + surgically remove the orphaned old rules from `app-shell.css`

**Files:**
- Modify (append a new section): `ui/src/styles/cockpit.css`
- Modify (per-selector surgical delete): `ui/src/styles/app-shell.css`

- [ ] **Step 1: Append the fresh flow-canvas rules to `cockpit.css`**

Append this complete block to the END of `ui/src/styles/cockpit.css` (uses ONLY existing project tokens — `--bg-0..4`, `--fg-0..3`, `--clay-soft`, `--clay-line`, `--font-display`, `--border`/`--border-soft`, `--accent`/`--accent-bg` from `roleStyle`; NO raw oklch literals, NO mockup palette; scoped for the nested scrollable `.cockpit-flow-main` cell):

```css
/* ============================================================
   For-Me Flow canvas (redesign, 2026-05-17). Owns the `flowx-`
   namespace. Authored for the nested .cockpit-flow-main grid cell
   (scrolls within the cell, not the viewport).
   ============================================================ */
.flowx-canvas {
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background:
    linear-gradient(var(--clay-soft) 1px, transparent 1px),
    linear-gradient(90deg, var(--clay-soft) 1px, transparent 1px),
    var(--bg-1);
  background-size: 36px 36px;
  padding: 16px 18px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.flowx-canvas.empty { display: grid; place-items: center; }
.flowx-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  color: var(--fg-2); text-align: center; max-width: 360px;
}
.flowx-empty h2 { margin: 4px 0 0; font-family: var(--font-display); font-size: 18px; color: var(--fg-0); }
.flowx-empty p { margin: 0; font-size: 13px; }

.flowx-ticker {
  display: flex; align-items: center; gap: 18px;
  flex-wrap: wrap; flex: 0 0 auto;
  font-size: 12px; color: var(--fg-1);
}
.flowx-tick { display: inline-flex; align-items: center; gap: 6px; }
.flowx-tick .status-dot { width: 7px; height: 7px; }
.flowx-tick.warn { color: var(--clay-line); }
.flowx-drift {
  display: inline-flex; align-items: center; gap: 8px;
  margin-left: auto; color: var(--fg-2);
  font-size: 11px; letter-spacing: 0.08em;
}
.flowx-drift-bar {
  width: 96px; height: 5px; border-radius: 3px;
  background: var(--bg-3); overflow: hidden;
}
.flowx-drift-bar > span { display: block; height: 100%; background: var(--clay-line); }

.flowx-pipeline {
  display: flex; align-items: flex-start; gap: 22px;
  flex: 1 1 auto; min-height: 0;
  overflow-x: auto; overflow-y: visible;
  padding-bottom: 8px;
}
.flowx-col {
  display: flex; flex-direction: column; align-items: stretch;
  gap: 0; flex: 0 0 200px; min-width: 200px;
}
.flowx-col-lead { flex-basis: 208px; min-width: 208px; gap: 12px; }
.flowx-col-done { flex-basis: 200px; min-width: 200px; }

.flowx-lead, .flowx-agent {
  text-align: left; cursor: pointer;
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; border-radius: 10px;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-top: 2px solid var(--accent, var(--clay-line));
  color: var(--fg-1);
  transition: background 0.12s ease, border-color 0.12s ease;
}
.flowx-lead { background: var(--bg-3); }
.flowx-agent:hover, .flowx-lead:hover { background: var(--bg-3); }
.flowx-agent.active, .flowx-lead.active {
  background: var(--bg-4);
  border-color: var(--accent, var(--clay-line));
}
.flowx-card-top { display: flex; align-items: center; gap: 8px; }
.flowx-card-top .agent-avatar {
  width: 24px; height: 24px; border-radius: 6px;
  display: grid; place-items: center;
  background: var(--accent-bg, var(--bg-4)); color: var(--fg-0);
  font-size: 11px; font-weight: 700;
}
.flowx-card-id { display: flex; flex-direction: column; min-width: 0; }
.flowx-card-id em {
  font-style: normal; font-size: 10px; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--fg-3);
}
.flowx-card-id strong {
  font-family: var(--font-display); font-size: 13px; color: var(--fg-0);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.flowx-card-activity {
  font-size: 11.5px; color: var(--fg-2); line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden;
}
.flowx-card-foot {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: var(--fg-2); padding-top: 6px;
  border-top: 1px solid var(--border-soft);
}
.flowx-card-foot strong { color: var(--fg-0); }
.flowx-status { text-transform: capitalize; color: var(--fg-3); }
.flowx-status.live { color: var(--fg-1); }

.flowx-spine {
  width: 1px; align-self: center;
  height: 14px; margin: 4px 0;
  background: var(--accent, var(--border-strong)); opacity: 0.5;
}
.flowx-tasks { display: flex; flex-direction: column; gap: 8px; }
.flowx-task-empty {
  font-size: 11px; color: var(--fg-3); padding: 8px;
  border: 1px dashed var(--border-soft); border-radius: 8px; text-align: center;
}
.flowx-task {
  text-align: left; cursor: pointer;
  display: flex; flex-direction: column; gap: 5px;
  padding: 9px 10px; border-radius: 8px;
  background: var(--bg-2); border: 1px solid var(--border-soft);
  color: var(--fg-1);
  transition: background 0.12s ease, border-color 0.12s ease;
}
.flowx-task:hover { background: var(--bg-3); }
.flowx-task.active { background: var(--bg-4); border-color: var(--clay-line); }
.flowx-task-top {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 10px;
}
.flowx-task-top .task-id { color: var(--fg-3); font-family: var(--font-display); }
.flowx-task > strong {
  font-size: 12px; color: var(--fg-0); line-height: 1.35;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.flowx-task-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.flowx-warn {
  text-align: left; cursor: pointer;
  display: flex; flex-direction: column; gap: 7px;
  padding: 11px; border-radius: 10px;
  background: var(--bg-2);
  border: 1px solid var(--clay-line);
  border-left: 2px solid var(--clay-line);
  color: var(--fg-1);
}
.flowx-warn:hover { background: var(--bg-3); }
.flowx-warn-head { display: flex; align-items: flex-start; gap: 7px; color: var(--clay-line); }
.flowx-warn-head strong { display: block; font-size: 12px; color: var(--fg-0); }
.flowx-warn-head em { font-style: normal; font-size: 10px; color: var(--fg-3); }
.flowx-warn-desc { font-size: 11px; color: var(--fg-2); line-height: 1.4; }
.flowx-warn-cta {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 11px; font-weight: 600; color: var(--clay-line);
}

.flowx-done {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; border-radius: 10px;
  background: var(--bg-2); border: 1px solid var(--border-soft);
}
.flowx-done-head {
  display: flex; align-items: center; gap: 7px;
  font-family: var(--font-display); color: var(--fg-0); font-size: 13px;
}
.flowx-done-head strong { margin-left: auto; color: var(--fg-1); }
.flowx-done-list { display: flex; flex-direction: column; gap: 4px; }
.flowx-done-line {
  display: flex; gap: 8px; align-items: baseline;
  text-align: left; cursor: pointer; background: none; border: none;
  padding: 4px 2px; font-size: 11px; color: var(--fg-2);
}
.flowx-done-line:hover { color: var(--fg-0); }
.flowx-done-line .task-id { color: var(--fg-3); font-family: var(--font-display); flex: 0 0 auto; }
.flowx-done-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 2: Grep-verify the old `.flow-*` selectors are now orphaned, then surgically remove them from `app-shell.css`**

The rewritten component emits ONLY `flowx-`/reused-shared classes — it no longer emits any old `.flow-*` canvas class. For EACH selector in this list, run the usage check, and ONLY if it returns no component consumer, delete that selector's rule block (the lines from its selector through its matching closing `}`) from `ui/src/styles/app-shell.css`. NEVER delete by a fixed line range (the rules are interleaved with non-flow rules like `.cockpit-review-pane`).

Selectors to remove (old CockpitFlowCanvas rules, all in `app-shell.css`): `.flow-canvas`, `.flow-canvas.empty`, `.flow-empty`, `.flow-empty h2`, `.flow-empty p`, `.flow-hero`, `.flow-hero h2`, `.flow-hero p`, `.flow-stats`, `.flow-stats-primary`, `.flow-stats-secondary`, `.flow-stat`, `.flow-stat span`, `.flow-stat strong`, `.flow-stats-secondary .flow-stat`, `.flow-stats-secondary .flow-stat span`, `.flow-stats-secondary .flow-stat strong`, `.flow-stat.warn`, `.flow-map`, `.flow-source`, `.flow-source-node`, `.flow-source-node .agent-avatar`, `.flow-source-node strong`, `.flow-source-node em`, `.flow-source-kicker`, `.flow-source-connector`, `.flow-pipeline`, `.flow-stage`, `.flow-stage.blocked`, `.flow-stage-head`, `.flow-stage-head strong`, `.flow-stage-track`, `.flow-stage-empty`, `.flow-stage-arrow`, `.flow-stage-arrow::after`, `.flow-work-node`, `.flow-work-node.active`, `.flow-work-node:hover`, `.flow-work-top`, `.flow-work-owner`, `.flow-work-meta`, `.flow-work-node > strong`, `.flow-work-owner .agent-avatar`, `.flow-work-owner > span:last-child`, `.flow-agent-strip`, `.flow-agent-chip`, `.flow-selected-task-pill`, `.flow-selected-agent-note`, and any remaining `.flow-*` rule whose class is not emitted by ANY component (confirm with the grep below), PLUS the `@media` overrides of those same selectors (e.g. `.flow-stage-arrow` inside the media query near the end of the flow region).

Per-selector verification (run for the class name, e.g. `flow-pipeline`):
Run: `cd /c/Project-TOAD/toad-local/ui && grep -rnE "flow-pipeline" src --include=*.tsx --include=*.ts`
Expected: NO result (no `.tsx`/`.ts` emits it → safe to delete its CSS). If ANY component still references a class, KEEP that rule and report it.

Do NOT touch: `.eyebrow` (line ~193 — shared, used elsewhere; verify with `grep -rnE "eyebrow" src --include=*.tsx` showing other consumers and leave it), `.cockpit-review-*`, `.cockpit-flow-*`, `.flow-hero-card`/`.flow-hero-eyebrow`/`.flow-hero-title`/`.flow-hero-subline`/`.flow-timeline-*` (these live in `cockpit.css`, are the kept shell/timeline rules, and are NOT old canvas rules). `app-shell.css` must remain byte-identical except for the surgically removed orphaned old-canvas `.flow-*` rule blocks.

- [ ] **Step 3: Verify the CSS bundle still builds**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run build`
Expected: build succeeds (Vite compiles CSS+TS). If it fails, fix only the introduced rules / removed-rule fallout; do not modify out-of-scope CSS.

---

## Task 5: Full verification

**Files:** none changed (verification only).

- [ ] **Step 1: Typecheck clean**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: zero TS errors (clean exit).

- [ ] **Step 2: Build passes**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run build`
Expected: success.

- [ ] **Step 3: All ui pure-model tests green**

Run: `cd /c/Project-TOAD/toad-local/ui && node --test test/flowCanvasModel.test.mjs test/forMeViewMode.test.mjs test/forMeFlowPanels.test.mjs`
Expected: `# fail 0` (3 model suites pass).

- [ ] **Step 4: Backend regression guard (no backend change expected)**

Run: `cd /c/Project-TOAD/toad-local && node scripts/run-test-suites.mjs`
Expected: runner exit 0, fail 0 (UI-only change — backend suite unaffected; this is the cheap safety check).

---

## Task 6: Whole-impl review + Commit 2 + post-commit verify + cleanup

**Files:** none changed (review + commit + cleanup).

- [ ] **Step 1: Dispatch the mandatory whole-implementation subagent review**

Review the entire flow surface (the Task-1 model + Task-3 component + Task-4 CSS) for: model purity/totality + exact agent-pivot/ticker/warnings rules; component keeps the exact `CockpitFlowCanvasProps` and all interactions (single-click select, double-click open/logs, empty state) and consumes `buildFlowCanvas`; no new IO/backend/handler; `app-shell.css` only dropped provably-orphaned old `.flow-*` rules (every removed selector has zero `.tsx` consumers); `cockpit.css` uses only project tokens (no raw oklch / mockup palette); `CockpitForMe.tsx` still renders `<CockpitFlowCanvas>` in the `viewMode==='flow'` branch (the flow is genuinely wired, not inert). Resolve any Critical/Important via a fix-loop before Step 2.

- [ ] **Step 2: Commit-hygiene gate (controller-verified)**

Run: `git -C /c/Project-TOAD add toad-local/ui/src/components/CockpitFlowCanvas.tsx toad-local/ui/src/components/cockpit/CockpitForMe.tsx toad-local/ui/src/components/cockpit/CockpitScreenV2.tsx toad-local/ui/src/styles/cockpit.css toad-local/ui/src/styles/app-shell.css`
Then: `git -C /c/Project-TOAD diff --cached --name-only`
Expected: EXACTLY those 5 paths. Confirm NONE of: `ui/src-tauri/src/main.rs`, `ui/src-tauri/tauri.conf.json`, any `toad-local/src/**` backend file, `toad-local/.mockup-symphony-flow/**`.
Then: `git -C /c/Project-TOAD diff --cached -- toad-local/ui/src/components/cockpit/CockpitForMe.tsx | grep -ciE "grid-?view|gridView|'grid'|\"grid\""` → expected `0` (no operator grid-view track leakage in the shared file).

- [ ] **Step 3: Commit 2**

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(cockpit): rebuild Flow canvas to the mockup (flow redesign, Commit 2)

Rewrite CockpitFlowCanvas as a responsive agent-pivot canvas consuming
buildFlowCanvas: ticker bar + lead column with approval/drift warning
cards + per-agent columns each with its assigned tasks stacked
underneath + Ready bucket + light spine connectors. Inbound props
byte-unchanged; all interactions + empty state + activity-blurb memo
preserved. Fresh flowx- CSS namespace authored in cockpit.css with
project tokens for the nested .cockpit-flow-main shell; the orphaned
old .flow-* canvas rules surgically removed from app-shell.css. Fixes
the 'flow renders but looks broken' mismatch. Commits the stalled
shell foundation (CockpitForMe flow branch + CockpitScreenV2). UI
only; no backend/grid-view/Sub-project-C change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Post-commit verify**

```bash
git -C /c/Project-TOAD show --stat HEAD | tail -n 8        # EXACTLY 5 files
git -C /c/Project-TOAD diff --stat 4886a3a HEAD -- toad-local/src toad-local/ui/src-tauri   # EXPECT EMPTY (no backend / no Tauri / no Sub-project C)
git -C /c/Project-TOAD log --oneline -3                     # HEAD=Commit2, HEAD~1=Commit1, HEAD~2=4886a3a (spec)
```
Expected: HEAD stat exactly the 5 files; the out-of-scope diff EMPTY; log chain correct.

- [ ] **Step 5: Delete the local mockup reference (never committed)**

Run: `git -C /c/Project-TOAD status --porcelain | grep -c "\.mockup-symphony-flow"` → if non-zero, it is untracked (correct — never staged). Then remove it:
PowerShell: `Remove-Item -Recurse -Force C:\Project-TOAD\toad-local\.mockup-symphony-flow`
Verify: `Test-Path C:\Project-TOAD\toad-local\.mockup-symphony-flow` → `False`. Confirm `git -C /c/Project-TOAD status --porcelain | grep -c "mockup-symphony-flow"` → `0`.

---

## Self-Review

**1. Spec coverage:**
- §5 pure model (agent-pivot, lead pick, pipeline rank, tasks-under, ticker, doneBucket≤5, injected `isDriftElevated`, edge cases, total) → Task 1 (full model + full TDD test). ✓
- §6 component (ticker / lead+warnings / per-agent cards with tasks underneath / Done bucket / light connectors / unchanged props / interactions / latestByAgent compose) → Task 3 (full component). ✓
- §7 styling (fresh CSS in cockpit.css, project tokens only, nested shell, dead app-shell.css rules removed) → Task 4 (full CSS + surgical grep-verified removal). ✓
- §8 testing (TDD model, typecheck clean, build, foundation tests green, backend regression) → Tasks 1,5. ✓
- §9 commit decomposition + hygiene gate → Tasks 2,6 (explicit paths, `--cached --name-only`, grid grep, Sub-project-C/mockup exclusion, post-commit stat + backend-empty). ✓
- §10 grid coordination → Task 6 Step 2 grep + the final hand-off note below. ✓
- §3/§4 mockup adoption set + out-of-scope (no backend, no legend/toolbar, no bezier/oklch, mockup never committed) → Task 3/4 scope notes + Task 6 Step 5. ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases/similar to". Every code step has complete copy-paste content; every run step has exact command + expected output. The only conditional ("if an `Icon name` doesn't exist, read Icon.tsx and substitute the nearest") is a concrete, bounded grounding instruction, not a placeholder.

**3. Type consistency:** `buildFlowCanvas` input/output names identical across Task 1 model, Task 1 test, Task 3 component (`ticker.{live,open,inReview,blocked,done,driftPct}`, `lead.{member,runtimeStatus,activity,coordinating}`, `agents[].{member,runtimeStatus,statusLabel,activity,tasks,taskCount}`, `doneBucket.{count,recent}`, `warnings[].{id,kind,title,sub,desc,taskId}`). `CockpitFlowCanvasProps` in Task 3 == the grounded `CockpitForMe.tsx:478-510` invocation. `isDriftElevated = (s)=>s>=66` consistent (Task 3 component) with the model default `()=>false` (Task 1). Class namespace `flowx-` consistent between Task 3 (emitted) and Task 4 (styled); old `.flow-*` (Task 4 removal list) is disjoint from `flowx-`.

No gaps found.

---

## Post-ship hand-off (spec §10)

After Commit 2, report to the operator the exact committed file set so the grid-view track can rebase/coordinate: Commit 1 = `flowCanvasModel.ts`+`.test.mjs`, `forMeViewMode.ts`+`.test.mjs`, `forMeFlowPanels.ts`+`.test.mjs`; Commit 2 = `CockpitFlowCanvas.tsx`, `CockpitForMe.tsx`, `CockpitScreenV2.tsx`, `cockpit.css`, `app-shell.css`. `forMeViewMode` remains `'timeline'|'flow'` (no `'grid'`) — grid is the operator's separate addition.
