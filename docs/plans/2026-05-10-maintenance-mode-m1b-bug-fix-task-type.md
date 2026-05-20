# Maintenance Mode M.1b Implementation Plan — Bug-Fix Task Type

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `type` field to tasks (`'feature' | 'bug'`, default `'feature'`) so bug-fix tasks bypass the plan-propose-approve cycle and agents go straight to investigation. Surface the type in the task creation modal, on kanban cards (as a "Bug" badge), and in the task detail header.

**Architecture:** No schema migration — the type field rides in the existing `task.created` event payload. Task projection (`inMemoryTaskBoard.js`) reads it and defaults to `'feature'` when absent. `task_create` MCP tool gains an optional `type` arg. Lead / developer / debugger system-prompt guidance grows task-type conditional language. UI changes touch TaskCreationModal, kanban card renderer, TaskDetailModal, and one CSS selector.

**Tech Stack:** Node 20+ ESM, SQLite (event log), TypeScript / React 18 / Vite for UI.

**Spec:** `docs/specs/2026-05-10-maintenance-mode-m1b-bug-fix-task-type-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/task/inMemoryTaskBoard.js` | Modify | Add `TASK_TYPES` constant; task projection picks up `type` from CREATED payload with `'feature'` default |
| `src/team/teamSystemPrompts.js` | Modify | Add task-type-aware paragraphs to lead, developer, debugger `ROLE_GUIDANCE` entries |
| `src/tools/localToolFacade.js` | Modify | `#taskCreate` (or equivalent handler) passes `type` to the event payload |
| `src/mcp/localToolDefinitions.js` | Modify | `task_create` schema adds optional `type` enum property |
| `test/inMemoryTaskBoard.test.js` (or `taskBoard.test.js`) | Modify | TDD coverage for type projection + default + invalid value |
| `test/localToolFacade.test.js` | Modify | TDD coverage for `task_create` type arg passthrough |
| `test/localMcpToolDefinitions.test.js` | Modify | Schema includes type |
| `test/teamSystemPrompts.test.js` | Modify | Guidance includes task-type conditional language |
| `ui/src/components/TaskCreationModal.tsx` | Modify | Type radio (Feature default, Bug option), pass to mutation |
| `ui/src/types/index.ts` | Modify | Add `type?: 'feature' \| 'bug'` to Task interface |
| `ui/src/components/TasksScreen.tsx` (or wherever kanban cards live) | Modify | Bug badge rendering when `task.type === 'bug'` |
| `ui/src/components/TaskDetailModal.tsx` | Modify | Display type in header |
| `ui/src/styles/app-shell.css` | Modify | `.task-bug-badge` selector |

---

## Pre-flight

- [ ] **Step P.1: Backend tests pass**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: all suites pass.

- [ ] **Step P.2: UI typecheck + lint clean**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: zero errors.

- [ ] **Step P.3: Git clean**

Run: `git -C C:/Project-TOAD/toad-local status --short`
Expected: only the recent M.1b spec commit visible above the M.1a ship marker.

---

## Task 1: Task projection picks up `type` field

**Files:**
- Modify: `src/task/inMemoryTaskBoard.js`
- Modify: `test/inMemoryTaskBoard.test.js` (or `taskBoard.test.js` — check which exists)

- [ ] **Step 1.1: Find the test file**

Run: `ls C:/Project-TOAD/toad-local/test/ | grep -i task`

Note which task-board test file exists. The tests live there.

- [ ] **Step 1.2: Write failing tests (TDD)**

Add four new tests to the matching test file:

```js
test('task projection picks up type from CREATED event payload', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't',
    taskId: 't_1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'u',
    payload: { subject: 'Fix login crash', type: 'bug' },
  });
  const task = board.projectTask({ teamId: 't', taskId: 't_1' }) ?? board.getTask?.({ teamId: 't', taskId: 't_1' });
  assert.equal(task.type, 'bug');
});

test('task projection defaults type to feature when CREATED event has no type', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't',
    taskId: 't_1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'u',
    payload: { subject: 'Add a button' },
  });
  const task = board.projectTask({ teamId: 't', taskId: 't_1' }) ?? board.getTask?.({ teamId: 't', taskId: 't_1' });
  assert.equal(task.type, 'feature');
});

test('task projection defaults type to feature when CREATED event has invalid type', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't',
    taskId: 't_1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'u',
    payload: { subject: 'Whatever', type: 'banana' },
  });
  const task = board.projectTask({ teamId: 't', taskId: 't_1' }) ?? board.getTask?.({ teamId: 't', taskId: 't_1' });
  assert.equal(task.type, 'feature', 'invalid types should fall back to feature default');
});

test('task projection accepts type=feature explicitly', () => {
  const board = new InMemoryTaskBoard();
  board.appendEvent({
    teamId: 't',
    taskId: 't_1',
    eventType: TASK_EVENT_TYPES.CREATED,
    actorId: 'u',
    payload: { subject: 'Build dashboard', type: 'feature' },
  });
  const task = board.projectTask({ teamId: 't', taskId: 't_1' }) ?? board.getTask?.({ teamId: 't', taskId: 't_1' });
  assert.equal(task.type, 'feature');
});
```

Use whichever method exists on the board: `projectTask` or `getTask`. Look at neighboring tests in the file to find the right one.

- [ ] **Step 1.3: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node test/inMemoryTaskBoard.test.js 2>&1 | tail -15` (substitute the actual filename).
Expected: 4 new failures with messages like `task.type is undefined`.

- [ ] **Step 1.4: Add `TASK_TYPES` constant + projection logic**

In `src/task/inMemoryTaskBoard.js`, near the existing `TASK_RISK_LEVELS` and `TASK_STATUS` exports, add:

```js
export const TASK_TYPES = Object.freeze(['feature', 'bug']);
```

Find the initial task shape (the object that exists before any events are folded — search for `requiresHumanApproval: false` to locate it). Add a default:

```js
{
  // ... existing initial fields
  type: 'feature',
}
```

Find the CREATED event handler (search for `event.eventType === TASK_EVENT_TYPES.CREATED`). Add the type projection inside the handler:

```js
if (event.eventType === TASK_EVENT_TYPES.CREATED) {
  // ... existing field projections (subject, description, ownerId, etc.)
  const rawType = event.payload?.type;
  task.type = TASK_TYPES.includes(rawType) ? rawType : 'feature';
}
```

- [ ] **Step 1.5: Run — verify passing**

Run: `cd C:/Project-TOAD/toad-local && node test/inMemoryTaskBoard.test.js 2>&1 | tail -10`
Expected: all four new tests pass.

- [ ] **Step 1.6: Run full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 1.7: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/task/inMemoryTaskBoard.js test/inMemoryTaskBoard.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): task projection picks up type field with feature default

Adds TASK_TYPES = ['feature', 'bug'] constant. Task projection reads
event.payload.type on CREATED events and defaults to 'feature' when
absent OR when the value isn't in the enum (defensive — legacy events
created before this slice all project as 'feature' so back-compat is
automatic).

4 new tests cover: explicit 'bug', no type (default), invalid value
(default), explicit 'feature'.

No schema migration — type rides in the existing payload_json column.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(If the actual test file is `test/taskBoard.test.js` instead of `inMemoryTaskBoard.test.js`, substitute in the `git add` line.)

---

## Task 2: `task_create` MCP handler accepts `type`

**Files:**
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localMcpToolDefinitions.test.js`

- [ ] **Step 2.1: Find the `task_create` handler**

Run: `grep -n "#taskCreate\|TASK_CREATE\|task_create" C:/Project-TOAD/toad-local/src/tools/localToolFacade.js | head -10`

Read the handler to understand its current arg processing.

- [ ] **Step 2.2: Write failing tests**

In `test/localToolFacade.test.js`, add (near existing task-related tests):

```js
test('task_create with type=bug stores type in the CREATED event payload', async () => {
  const { facade, taskBoard } = makeTaskFacade(); // or whatever helper exists
  await facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    actor: { teamId: 'demo', agentId: 'u', role: 'human' },
    args: { taskId: 't_bug1', subject: 'Login crashes', type: 'bug' },
    idempotencyKey: 'tk1',
  });
  const events = taskBoard.listEvents({ teamId: 'demo', taskId: 't_bug1' });
  const created = events.find((e) => e.eventType === TASK_EVENT_TYPES.CREATED);
  assert.equal(created.payload.type, 'bug');
});

test('task_create without type defaults to feature in projection', async () => {
  const { facade, taskBoard } = makeTaskFacade();
  await facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    actor: { teamId: 'demo', agentId: 'u', role: 'human' },
    args: { taskId: 't_feat1', subject: 'Add a button' },
    idempotencyKey: 'tk2',
  });
  const task = taskBoard.projectTask({ teamId: 'demo', taskId: 't_feat1' }) ?? taskBoard.getTask?.({ teamId: 'demo', taskId: 't_feat1' });
  assert.equal(task.type, 'feature');
});

test('task_create rejects invalid type values', async () => {
  const { facade } = makeTaskFacade();
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.TASK_CREATE,
      actor: { teamId: 'demo', agentId: 'u', role: 'human' },
      args: { taskId: 't_bad', subject: 'X', type: 'banana' },
      idempotencyKey: 'tk3',
    }),
    /type|enum/i,
  );
});
```

(Adapt `makeTaskFacade` to whatever helper exists. If the facade-test file uses inline construction, mirror that pattern.)

In `test/localMcpToolDefinitions.test.js`, add a single test:

```js
test('task_create schema includes optional type enum', () => {
  const def = getLocalMcpTool('task_create');
  assert.ok(def, 'task_create should be registered');
  assert.deepEqual(def.inputSchema.properties.type.enum, ['feature', 'bug']);
  assert.ok(!(def.inputSchema.required ?? []).includes('type'), 'type should be optional');
});
```

- [ ] **Step 2.3: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node test/localToolFacade.test.js 2>&1 | tail -10` and `node test/localMcpToolDefinitions.test.js 2>&1 | tail -10`
Expected: new tests fail.

- [ ] **Step 2.4: Update the `task_create` MCP schema**

In `src/mcp/localToolDefinitions.js`, find the `TASK_CREATE` makeTool entry. Add to its `properties`:

```js
type: {
  type: 'string',
  enum: ['feature', 'bug'],
  description: 'Task type. "feature" (default) triggers plan-propose-approve workflow. "bug" tells agents to skip planning and go straight to investigation + fix.',
},
```

Do NOT add to `required` — type is optional with `'feature'` default.

- [ ] **Step 2.5: Update the `#taskCreate` handler**

In `src/tools/localToolFacade.js`, find the handler. Add type passthrough:

```js
const type = typeof args?.type === 'string' && args.type.length > 0 ? args.type : undefined;
// ... existing logic; pass type into the CREATED event payload alongside subject etc.
const payload = {
  ...existingFields,
  ...(type ? { type } : {}),
};
```

Validation: rely on the MCP schema enum check for client-side rejection. For defense-in-depth, also reject invalid types at the handler level if the existing handler pattern does similar checks on other enum args. Throw an error with a clear message.

(Adapt to whatever the current handler structure is — read it before editing.)

- [ ] **Step 2.6: Run — verify passing**

Run: both test files. All new tests should pass.

- [ ] **Step 2.7: Run full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 2.8: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/tools/localToolFacade.js src/mcp/localToolDefinitions.js test/localToolFacade.test.js test/localMcpToolDefinitions.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): task_create MCP tool accepts optional type arg

Adds 'type' to task_create's schema as an optional string enum
('feature' | 'bug'). Handler passes it through to the CREATED event
payload when present. Omitting type preserves back-compat — projection
defaults to 'feature' (Task 1).

3 facade tests + 1 schema test cover: explicit 'bug', omitted type
defaulting to feature, invalid type rejected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: System-prompt guidance grows task-type conditional language

**Files:**
- Modify: `src/team/teamSystemPrompts.js`
- Modify: `test/teamSystemPrompts.test.js`

- [ ] **Step 3.1: Read existing role guidance**

Open `src/team/teamSystemPrompts.js` and read the `ROLE_GUIDANCE` entries for `lead`, `developer`, `debugger` (lines ~13-48). Note the array-of-strings-joined-with-space pattern.

- [ ] **Step 3.2: Write failing tests**

In `test/teamSystemPrompts.test.js`, add three new tests:

```js
test('lead guidance includes task-type conditional language for bug vs feature', () => {
  const guidance = ROLE_GUIDANCE.lead;
  // Some signal of task-type-awareness in the lead's instructions.
  assert.match(guidance, /\btype\b.*(feature|bug)|bug.*task|feature.*task/i);
  assert.match(guidance, /skip planning|investigation|reproduce/i, 'lead should know to direct bug tasks to investigation');
});

test('developer guidance directs bug tasks to skip plan_propose and reproduce first', () => {
  const guidance = ROLE_GUIDANCE.developer;
  assert.match(guidance, /type/i);
  assert.match(guidance, /bug|reproduce/i);
  assert.match(guidance, /plan_propose|planning/i, 'should still mention plan_propose for feature tasks');
});

test('debugger guidance distinguishes bug tasks from feature work', () => {
  const guidance = ROLE_GUIDANCE.debugger;
  assert.match(guidance, /bug|reproduce|root.cause/i);
});
```

- [ ] **Step 3.3: Run — verify failing**

Run: `cd C:/Project-TOAD/toad-local && node test/teamSystemPrompts.test.js 2>&1 | tail -10`
Expected: 3 new failures (or whichever specific regex assertions don't match).

- [ ] **Step 3.4: Update `ROLE_GUIDANCE`**

In `src/team/teamSystemPrompts.js`, append one new line to each of the three role arrays (lead / developer / debugger). Use the exact text from spec section 3:

**Lead** — add this line to the `ROLE_GUIDANCE.lead` array:

```js
'Tasks have a type field: "feature" (default) or "bug". For "feature" tasks, ensure the assignee proposes a plan via task_plan_propose before code work begins — feature work benefits from up-front design. For "bug" tasks, instruct the assignee to skip planning and go straight to investigation: reproduce → root-cause → minimal fix → verify. Set type: "bug" on task_create when the work is fixing existing broken behavior.',
```

**Developer** — add this line to the `ROLE_GUIDANCE.developer` array:

```js
'When you receive a task assignment, read the task type field. If type === "feature": propose a plan via task_plan_propose before writing code, wait for approval, then implement. If type === "bug": skip planning — first reproduce the issue, then identify the root cause, then implement the minimal fix, then run validation_run to confirm. Either way, follow the steering rules and the Definition of Done.',
```

**Debugger** — add this line to the `ROLE_GUIDANCE.debugger` array:

```js
'When the lead hands you a bug task (type === "bug"), skip planning — reproduce the failure, identify the root cause, and report your findings via message_send. The developer handles the actual fix unless the lead routes the fix back to you specifically.',
```

- [ ] **Step 3.5: Run — verify passing**

Run: `cd C:/Project-TOAD/toad-local && node test/teamSystemPrompts.test.js 2>&1 | tail -10`
Expected: all tests pass.

- [ ] **Step 3.6: Run full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 3.7: Commit**

```bash
git -C C:/Project-TOAD/toad-local add src/team/teamSystemPrompts.js test/teamSystemPrompts.test.js
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): system-prompt guidance directs bug tasks to skip planning

Adds task-type-aware paragraphs to lead, developer, and debugger
ROLE_GUIDANCE entries in teamSystemPrompts.js. Agents now read each
assigned task's type field and adapt:

- Lead: directs assignees per type. Sets type:bug on task_create for
  fix work.
- Developer: branches on type. Feature → propose plan, await approval,
  implement. Bug → reproduce, root-cause, fix, validate.
- Debugger: focuses on the reproduce/root-cause phase for bug tasks.

Guidance is prompt engineering, not hard gates — agents retain
judgment for edge cases (e.g., complex bugs that legitimately want
a plan). 3 regex tests assert the conditional language is present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: UI — TaskCreationModal Type radio

**Files:**
- Modify: `ui/src/types/index.ts`
- Modify: `ui/src/components/TaskCreationModal.tsx`

- [ ] **Step 4.1: Add `type` to the Task TS interface**

In `ui/src/types/index.ts`, find the `Task` interface (or whichever interface represents a task on the UI side — there might be multiple). Add:

```ts
/** Task type: 'feature' (default) or 'bug'. Bug tasks bypass the
 *  plan-propose-approve cycle in agent behavior. */
type?: 'feature' | 'bug';
```

(Mark optional for back-compat; legacy tasks without the field render as feature.)

- [ ] **Step 4.2: Read existing TaskCreationModal**

Open `ui/src/components/TaskCreationModal.tsx`. Look at how other form fields (assignedRole, priority) are rendered — the patterns determine the right shape for the Type field.

- [ ] **Step 4.3: Add Type state**

Near other useState calls in TaskCreationModal:

```ts
const [type, setType] = useState<'feature' | 'bug'>('feature');
```

- [ ] **Step 4.4: Render the Type control**

Add a segmented control or radio group near the existing role / priority controls. Match whatever pattern exists. Example pattern (adapt to the actual component's structure):

```tsx
<div className="form-row">
  <label>Type</label>
  <div className="seg" role="radiogroup" aria-label="Task type">
    <button
      type="button"
      role="radio"
      aria-checked={type === 'feature'}
      className={`seg-btn ${type === 'feature' ? 'active' : ''}`}
      onClick={() => setType('feature')}
    >
      Feature
    </button>
    <button
      type="button"
      role="radio"
      aria-checked={type === 'bug'}
      className={`seg-btn ${type === 'bug' ? 'active' : ''}`}
      onClick={() => setType('bug')}
    >
      Bug
    </button>
  </div>
</div>
```

Use the project's existing seg-btn / form-row classes (search `.seg-btn` in the CSS). If the modal uses a different field pattern (e.g., native `<select>`), match that.

- [ ] **Step 4.5: Pass type to the task_create call**

In the create-task handler in the modal, add `type` to the args object:

```ts
await callToadApi({
  actor,
  method: 'task_create',
  args: { ..., type },
  idempotencyKey: ...,
});
```

- [ ] **Step 4.6: Reset type on modal open**

If the modal has a reset/initial-state useEffect, include `setType('feature')` so each new task starts as Feature.

- [ ] **Step 4.7: Typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 4.8: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/types/index.ts ui/src/components/TaskCreationModal.tsx
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): TaskCreationModal Type radio (Feature / Bug)

TaskCreationModal grows a Type segmented control near the existing
role / priority fields. Defaults to Feature; toggling to Bug passes
type='bug' into the task_create MCP call args.

Task TS interface gains an optional 'type' field for legacy/back-compat
tasks that have no type and render as Feature.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: UI — kanban Bug badge

**Files:**
- Modify: whichever component renders kanban task cards (find via `grep`)

- [ ] **Step 5.1: Find the kanban card renderer**

Run: `grep -rn "task.subject\|task.status" "C:/Project-TOAD/toad-local/ui/src/components/" | head -10`

Look at the matches — the card body component is the one that pulls task fields. Likely candidates: `TasksScreen.tsx`, `Workspace.tsx`, a shared `TaskCard.tsx`, or per-screen inlined cards.

- [ ] **Step 5.2: Add the bug badge**

Inside the card's header (where status / priority chips already render), add:

```tsx
{task.type === 'bug' && (
  <span className="task-bug-badge" title="Bug fix">
    Bug
  </span>
)}
```

Place it near the existing status pill. Default (`type === 'feature'` or undefined) renders nothing — no badge clutter for the common case.

If the kanban renders cards in two places (Workspace + TasksScreen), update both for consistency.

- [ ] **Step 5.3: Typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 5.4: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/components/
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): kanban cards show Bug badge when task.type === 'bug'

Small chip rendered in card header alongside existing status / risk
pills. No badge for feature tasks (the default) so visual noise stays
low on the common case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: UI — TaskDetailModal header shows type

**Files:**
- Modify: `ui/src/components/TaskDetailModal.tsx`

- [ ] **Step 6.1: Find the meta header in TaskDetailModal**

Open the file. Find where task status / risk / assignee are rendered in the header / meta block.

- [ ] **Step 6.2: Add Type alongside other meta fields**

```tsx
<span>Type: {task.type === 'bug' ? 'Bug' : 'Feature'}</span>
```

Match the existing meta-field rendering pattern (className / layout).

- [ ] **Step 6.3: Typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6.4: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/components/TaskDetailModal.tsx
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): TaskDetailModal header surfaces task type

Type renders alongside the existing status / risk / assignee fields.
Falls back to 'Feature' for legacy tasks without a type field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CSS — `.task-bug-badge` styles

**Files:**
- Modify: `ui/src/styles/app-shell.css`

- [ ] **Step 7.1: Find a sensible insertion point**

Run: `grep -n "\.task-\|kanban\|card.*badge" C:/Project-TOAD/toad-local/ui/src/styles/app-shell.css | head -10`

Pick a section near other task-card styles.

- [ ] **Step 7.2: Append the bug badge styles**

```css
.task-bug-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--clay, #d97757);
  border: 1px solid var(--clay-border, rgba(217, 119, 87, 0.4));
}
```

Verify `--clay` and `--clay-border` tokens exist (run `grep "\-\-clay" ui/src/styles/styles.css`). If `--clay-border` isn't defined, the fallback `rgba(...)` handles it.

- [ ] **Step 7.3: Lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run lint`
Expected: clean.

- [ ] **Step 7.4: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/styles/app-shell.css
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(maintenance): .task-bug-badge styles — small clay-accent pill

Pill style using the existing --clay accent token. Subtle enough not
to dominate task cards but clear enough to spot bug tasks at a glance
on the kanban.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Manual smoke (USER-DRIVEN)

The UI has no test framework — manual smoke before ship marker.

- [ ] **Step 8.1: Restart sidecar**

Backend changes (handler, projection, system prompt) need a fresh sidecar. Run `C:/Project-TOAD/restart-dev.bat`.

- [ ] **Step 8.2: Smoke — Feature task (regression)**

In Symphony, click "+ Task" on the Cockpit's Tasks tab.
- Verify "Type" defaults to Feature.
- Fill in subject "Test feature task".
- Click Create.
- Expected: task appears on the kanban without a Bug badge.

- [ ] **Step 8.3: Smoke — Bug task (the new path)**

Click "+ Task" again.
- Toggle Type to Bug.
- Fill in subject "Test bug task".
- Click Create.
- Expected: task appears on the kanban WITH a small "Bug" pill in the card header.

- [ ] **Step 8.4: Smoke — Task detail**

Click the Bug task card to open its detail modal.
- Expected: header shows "Type: Bug" alongside status / risk / assignee.

Click a Feature task.
- Expected: header shows "Type: Feature".

- [ ] **Step 8.5: Smoke — Legacy task**

Look at the demo-seeded tasks from earlier (the `symphony-demo` team's tasks from screenshot capture).
- Expected: they render without a Bug badge (legacy = type defaults to Feature).
- Open one's detail — Type shows "Feature".

- [ ] **Step 8.6: Smoke — Agent system prompt (optional, requires live team)**

If you have a live agent team running (post Resume team from M.1a):
- Watch the sidecar terminal during team launch.
- The lead / developer's system prompt should include the new type-aware paragraphs.
- Send a Bug task and watch the lead's delegation message via the inspector.
- Expected: delegation mentions skipping planning + investigation-first language.

(Skip if not currently running a team — backend tests already prove the system prompt contains the right guidance text.)

- [ ] **Step 8.7: Document results**

If all six pass, the slice is ready to ship. Paste anything off back to the controller.

---

## Task 9: Final verification + ship marker

- [ ] **Step 9.1: Full backend suite**

Run: `cd C:/Project-TOAD/toad-local && npm test 2>&1 | tail -10`
Expected: green.

- [ ] **Step 9.2: UI typecheck + lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 9.3: Commit chain check**

Run: `git -C C:/Project-TOAD/toad-local log --oneline -15`
Expected: 7 task commits above the M.1b spec commit.

- [ ] **Step 9.4: Ship marker**

```bash
git -C C:/Project-TOAD/toad-local commit --allow-empty -m "$(cat <<'EOF'
ship(maintenance): slice M.1b — bug-fix task type

Tasks now carry a 'type' field ('feature' | 'bug', default 'feature').
Lead / developer / debugger agents read each assigned task's type and
adapt their behavior: feature tasks go through the existing
plan-propose-approve cycle; bug tasks skip planning and go straight to
reproduce → root-cause → minimal fix → verify.

Implementation:
- task projection (inMemoryTaskBoard) picks up type from CREATED event
  payload with 'feature' default. No schema migration; type rides in
  the existing payload_json column.
- task_create MCP tool accepts optional type enum arg.
- ROLE_GUIDANCE in teamSystemPrompts gains task-type-aware paragraphs
  for lead, developer, debugger.
- UI: TaskCreationModal Type segmented control, kanban card Bug badge,
  TaskDetailModal header shows type.

Existing risk classifier, review cycle, validation gates, and merge
integration all stay intact — only upfront planning is bypassed for
bug tasks.

Sets up M.1c (drift retargeting against current state for maintenance
work).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

- [x] Spec coverage: every architecture component (1-7 in spec) has a corresponding task.
- [x] No placeholders: every step shows concrete code or commands.
- [x] Type consistency: `type` field name, `'feature' | 'bug'` enum used identically across backend / MCP schema / UI props / tests.
- [x] Order is correct: backend (projection → MCP handler → system prompt) before UI (modal → kanban → detail → CSS). Smoke and ship last.
- [x] TDD on backend: each task has explicit failing-test verification before implementation.
- [x] UI follows existing typecheck + lint + manual smoke convention (no UI test framework yet).
- [x] Each task ends with a commit so reverts are granular.
- [x] Manual smoke is explicit (Task 8) — 6 scenarios cover Feature default, Bug badge, detail header, legacy back-compat, optional agent prompt.
