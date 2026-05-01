# Hardening Idempotent Approval Response Delivery

Slice: 2026-04-30
Status: complete

## Goal

Ensure that approval responses are delivered exactly once to the runtime adapter, even if the runtime restarts or receives duplicate incoming messages. This requires transitioning from an in-memory `previousApproval.status === 'pending'` guard to a durable delivery receipt stored in the database.

## Changes

### Schema

- Added the `approval_deliveries` table to `src/storage/schema.sql` to record delivery receipts (with `delivery_id`, `approval_id`, `runtime_id`, and `delivered_at`).

### Data Access

- Updated `SqliteApprovalBroker`:
  - `getApproval` and `listApprovals` now `LEFT JOIN` on `approval_deliveries` to populate an `approval.delivery` object if the approval was delivered.
  - Added `markApprovalDelivered({ approvalId, runtimeId })` to insert the delivery receipt (using `ON CONFLICT DO NOTHING` for idempotency).
- Added test coverage in `test/sqliteApprovalBroker.test.js`.

### Business Logic

- Updated `LocalToolFacade.#sendApprovalResponseToRuntime`:
  - Replaced the in-memory `shouldSend: !previousApproval || previousApproval.status === 'pending'` condition with `shouldSend: !approval.delivery`.
  - Added a call to `this.approvalBroker.markApprovalDelivered` immediately after successfully calling `adapter.approve()`.

## Test command

```powershell
npm.cmd test
```

All 25 test files pass.
