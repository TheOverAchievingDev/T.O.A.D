# ChorePoints — Roadmap
## Phase 1 — MVP (Core loops)
- Android app skeleton: navigation, family setup, invite code join
- Roles & sessions: parent login + kid profiles with PIN; parent mode password lock
- Chore templates (specific days-of-week) + instance generation for upcoming 2–4 weeks
- Kid queue view (today + upcoming) + submit flow
- Parent inbox for pending approvals + approve/reject with optional note
- Points balance computed from approvals (ledger-backed internally)
- Store catalog + kid request redemption + parent approve/deny + deduct points
- Weekly payout screen: compute + display Friday payout per kid; payout history
- Basic offline outbox + background sync; handle “no network” gracefully

## Phase 2 — Sync hardening & usability
- Robust sync cursoring, idempotency, and conflict UX (especially for approvals)
- Multi-parent support polish: activity feed/audit (“approved by Mom/Dad”)
- Expiration job: auto-mark instances expired; cleanup logic
- Better scheduling UX (calendar picker for days-of-week; timezone clarity)
- Fulfillment step for store redemptions + history filtering
- Settings: conversion rate per kid, rotate invite code, manage devices

## Phase 3 — Production hardening
- Security review: PIN/password storage, session handling, role enforcement
- Observability: crash reporting, basic analytics, server logs/alerts
- Data export (CSV for payouts/ledger) for parents
- Performance: pagination for instances/ledger, startup time optimizations
- QA pass across multiple devices and offline/online transitions
- Play Store readiness: privacy policy, data handling disclosures