# Task Schema / Risk Contract

Date: 2026-05-01

## Goal

Add the first task schema hardening slice: creation-time fields that let TOAD describe intended file scope, acceptance criteria, and risk before later slices enforce policy.

This slice is schema-only. It records and projects the contract; it does not yet block review, merge, or agent launch based on these fields.

## Contract

`task_create` accepts:

- `allowedFiles: string[]`
- `forbiddenFiles: string[]`
- `acceptanceCriteria: string[]`
- `riskLevel: 'low' | 'medium' | 'high' | 'critical'`
- `requiresHumanApproval: boolean`

Projection defaults for old tasks:

- `allowedFiles: []`
- `forbiddenFiles: []`
- `acceptanceCriteria: []`
- `riskLevel: null`
- `requiresHumanApproval: false`

## Implementation Steps

- [x] Add failing projection tests for the new creation-time fields and defaults.
- [x] Add failing facade tests proving `task_create` accepts the fields and rejects unknown `riskLevel` values.
- [x] Add failing MCP schema test for the new `task_create` fields.
- [x] Implement projection defaults and normalization in `src/task/inMemoryTaskBoard.js`.
- [x] Implement facade payload normalization and `riskLevel` validation in `src/tools/localToolFacade.js`.
- [x] Expose the fields in `src/mcp/localToolDefinitions.js`.
- [x] Run targeted tests.
- [x] Run full backend regression.

## Follow-Ups

- Enforce `forbiddenFiles` and optionally `allowedFiles` during `review_request` once real diff/files are present.
- Promote scope drift into a blocking policy when a task has explicit file constraints.
- Add risk-policy config that can auto-set `requiresHumanApproval` for high-risk paths or commands.
- Add human-approval gates around high/critical risk transitions once policy semantics are agreed.
