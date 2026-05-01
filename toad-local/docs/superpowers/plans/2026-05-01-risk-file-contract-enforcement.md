# Risk/File Contract Enforcement

Date: 2026-05-01

## Goal

Use the task contract fields added in the prior slice to block review requests that include changed files outside the task's declared file scope.

## Behavior

- `forbiddenFiles` is always enforced when `review_request` has a concrete file list.
- `allowedFiles` is enforced only when the task has a non-empty allowlist.
- Enforcement runs after caller-supplied files or orchestrator-computed diff files are available.
- Violations throw before `task.review_requested` is appended, so the task projection does not show a misleading active review.
- Existing tasks with empty `allowedFiles` / `forbiddenFiles` remain backward compatible.

## Implementation Steps

- [x] Add failing tests for forbidden file rejection.
- [x] Add failing tests for allowed-file rejection.
- [x] Add passing test for compliant files.
- [x] Add regression test for orchestrator-computed diff files.
- [x] Enforce the contract in `LocalToolFacade.#reviewRequest`.
- [x] Run focused facade tests.
- [x] Run full backend regression.

## Follow-Ups

- Add configurable risk-policy classification that can auto-set `requiresHumanApproval`.
- Add explicit human-approval gates for high/critical risk tasks.
- Consider adding structured blocked-task events for file-contract violations if operators want failed review attempts to appear in task history.
