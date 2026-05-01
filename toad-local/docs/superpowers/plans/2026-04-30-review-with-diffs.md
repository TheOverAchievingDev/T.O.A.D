# Code Review With Diffs

Slice: 2026-04-30
Status: complete

## Goal

Bring TOAD's review surface up to legacy parity for the **content** half of code review: when an agent finishes a task, the `review_request` should carry the diff text and the list of changed files, and the reviewer (a person or another agent) should be able to read that content back when listing open reviews. The reviewer's `review_decide` should be able to attach per-file feedback comments.

This slice does **not** attempt the legacy app's full review machinery — file-system watchers, hunk-level reject, conflict detection, file content read/write, save-edited-file, and apply-decisions are 18+ separate IPC handlers tied to git worktrees. Those are stage-shift in scope and explicitly deferred. The current slice is the minimum viable "review with diff content" that lets the existing approve / changes-requested decision flow work against real diffs.

## Design

### Storage

No schema change. The existing `task_events` table holds `payload_json` per event. The diff text and file list go into the `REVIEW_REQUESTED` event's payload; the feedback array goes into the `REVIEW_DECIDED` event's payload. SQLite's TEXT column comfortably holds large diffs (hundreds of KB), and we already store-and-replay everything from the event log, so this is the path of least resistance.

### Projection shape

`projectTask` (in `inMemoryTaskBoard.js`) gains a new `task.review` sub-object. Currently the projection scatters review state across `task.reviewState` only; this slice cohesively groups everything review-related under a single field:

```js
task.review = null
// On REVIEW_REQUESTED:
task.review = {
  state:        'requested',
  reviewerId:   string | null,
  summary:      string | null,
  diff:         string | null,
  files:        string[],
  requestedBy:  string,           // event.actorId
  requestedAt:  string,           // event.createdAt
}
// On REVIEW_DECIDED (merges into the existing review):
task.review = {
  ...task.review,
  state:        'decided',
  decision:     'approved' | 'changes_requested',
  reason:       string | null,
  feedback:     Array<{ file: string, comment: string }>,
  decidedBy:    string,
  decidedAt:    string,
}
```

`task.reviewState` (the existing `none` / `review` / `needs_fix` / `approved` enum) is kept unchanged for backward compatibility. New consumers should prefer `task.review`.

### Facade behavior

- `review_request` payload extended:
  - existing optional `reviewerId` (string)
  - new optional `summary` (string) — short description of what changed
  - new optional `diff` (string) — the unified diff text
  - new optional `files` (string[]) — paths of files touched
- `review_decide` payload extended:
  - existing optional `reason` (string)
  - new optional `feedback` (array of `{ file: string, comment: string }`) — per-file comments

All new fields are optional to preserve backward compatibility with existing callers. Empty/missing values mean "no diff content attached" — the current "approve a task by ID" flow keeps working unchanged.

### New MCP tool: `review_list`

A read-only `review_list` tool returns tasks with active reviews (`task.review.state === 'requested'`). Bound to the actor's `teamId`.

Implementation: `LocalReadModel.listOpenReviews({ teamId })` walks the task board's `listTasks` output, filters for tasks where `task.review?.state === 'requested'`, and returns the projection — including the diff content. The facade routes `COMMANDS.REVIEW_LIST` to it.

## Changes

- `src/task/inMemoryTaskBoard.js` — `projectTask` populates `task.review` sub-object from `REVIEW_REQUESTED` and `REVIEW_DECIDED` payloads. Backward-compatible default `task.review = null`.
- `src/commands/command-contract.js` — new `REVIEW_LIST = 'review_list'` (read-only, NOT in `MUTATING_COMMANDS`).
- `src/mcp/localToolDefinitions.js` — extended `review_request` schema (`summary`, `diff`, `files`); extended `review_decide` schema (`feedback`); new `review_list` tool def.
- `src/tools/localToolFacade.js` — `#reviewRequest` propagates the new fields into the event payload; `#reviewDecide` does the same for `feedback`; new `#reviewList` handler.
- `src/read/LocalReadModel.js` — new `listOpenReviews({ teamId })` method.
- `test/taskBoard.test.js` — new tests for the extended projection.
- `test/localToolFacade.test.js` — new tests for `review_list` and the extended review payload fields.
- `test/localMcpToolDefinitions.test.js` — `review_list` added to expected names; review_request/review_decide schemas unchanged structurally (additions are optional).

## Verification

```powershell
node test/taskBoard.test.js
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

All 28 backend test files pass.

## Out Of Scope (Big Follow-up Slices)

- **File-level / hunk-level decisions.** Legacy supports rejecting individual files or hunks. This needs a richer event vocabulary plus state machine and is its own slice.
- **Git integration.** Auto-generating the diff from a worktree, applying decisions back to the working tree, conflict checking. The current slice expects the caller to pass the diff text in.
- **File watching and content read/write.** Legacy `REVIEW_GET_FILE_CONTENT`, `REVIEW_SAVE_EDITED_FILE`, `REVIEW_WATCH_FILES`. Out of scope; TOAD's MCP tool surface should stay narrow.
- **Conflict detection** (`REVIEW_CHECK_CONFLICT`, `REVIEW_PREVIEW_REJECT`). Out of scope.
- **Decision invalidation / re-review.** When code drifts, legacy invalidates summaries (`REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES`). Out of scope.
