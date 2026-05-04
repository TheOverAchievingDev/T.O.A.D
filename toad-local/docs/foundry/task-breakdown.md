# ChorePoints — Task Breakdown
## Task 1 — Define MVP requirements & UX flows
- Deliverable: Finalized PRD-lite + key user flows (family setup, kid PIN, parent mode, chore lifecycle, store redemption, payout)
- Acceptance: Reviewer can trace every requirement to a screen/flow; open questions resolved (timezone/week window definition explicitly chosen)
- Suggested role: architect

## Task 2 — Data model + backend scaffold (family tenant + invite join)
- Deliverable: Backend project with core entities (Family, Users, InviteCode) and role enforcement
- Acceptance: Create family, rotate invite code, join from second device/user; parent-only routes blocked for kids
- Suggested role: developer

## Task 3 — Offline-first local persistence & sync outbox
- Deliverable: Room schema for core entities + pending mutations outbox + WorkManager sync loop
- Acceptance: With airplane mode on, user can submit chores/request redemptions; actions sync correctly once online without duplicates
- Suggested role: developer

## Task 4 — Chore templates + instance generation service
- Deliverable: Create/edit chore templates and generate ChoreInstances per scheduled day; expiration behavior implemented
- Acceptance: For a template scheduled on selected weekdays, instances appear for those dates; instances expire after day end; cannot be submitted after expiry (per spec)
- Suggested role: developer

## Task 5 — Kid experience: queue + submit
- Deliverable: Kid home showing today’s chores + upcoming; submit completion creates SUBMITTED state
- Acceptance: Kid sees correct instances for their profile; submit works offline and later syncs; status updates visible after parent approval
- Suggested role: developer

## Task 6 — Parent experience: approvals (chores + store)
- Deliverable: Parent inbox for submitted chores and requested redemptions; approve/deny with notes; audit “reviewed by”
- Acceptance: Parent can approve/reject; kid views updated statuses; unauthorized actions blocked for kid role
- Suggested role: developer

## Task 7 — Points ledger + wallet balance rules
- Deliverable: Ledger-backed balance calculations; prevent negative balance; ledger entries created on chore approval and redemption approval
- Acceptance: Balance equals sum of ledger entries; approving redemption with insufficient points is rejected; concurrency doesn’t double-award points
- Suggested role: developer

## Task 8 — Store catalog + redemption lifecycle
- Deliverable: Parent manages one-time store items; kid requests; parent approves/denies; optional fulfillment step
- Acceptance: End-to-end redemption updates status correctly and deducts points only on approval (or at defined point—documented and consistent)
- Suggested role: developer

## Task 9 — Friday payout computation + payout history UI
- Deliverable: Payout computation for a given Friday; per-kid conversion rate; payout history list
- Acceptance: For a known set of approved instances in a week, payout matches expected cash; conversion rate snapshot stored; history persists across devices
- Suggested role: developer

## Task 10 — QA, security, and release readiness
- Deliverable: Test plan + automated tests (unit/integration), security checklist (Keystore usage), crash reporting, Play Store prep artifacts
- Acceptance: Passes multi-device offline/online test matrix; no critical crashes in smoke tests; privacy/data handling documented
- Suggested role: tester