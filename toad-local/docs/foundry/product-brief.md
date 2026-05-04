# ChorePoints — Product Brief
## Problem
Families need a simple, consistent way to assign recurring chores, verify completion, and translate effort into weekly allowance—while also letting kids spend earned points on parent-approved rewards. Existing tools are either too manual, not kid-friendly, or don’t support offline-first multi-device use.

## Users
- **Parents/Guardians (2+)**
  - Create/assign chores with schedules and point values
  - Review/approve/reject completed chores
  - Approve/deny store redemptions
  - Configure payout rules (per kid conversion rate) and manage “parent mode”
- **Kids (each has their own profile + PIN)**
  - See their chore queue by day
  - Mark chores done (submit for approval)
  - View points balance and request store purchases (one-time items)
  - View weekly payout amount (history)

## Scope
### In-scope (MVP)
- **Android app** (single family) with **multi-device sync via invite code**
- **Authentication model**
  - Family created on first device
  - Additional devices join via **invite code**
  - **Role-based accounts** (Parent vs Kid)
  - **Parent mode** protected by a **password**
  - Kids have **their own PIN** (for quick unlock / kid session)
- **Chores**
  - Parent creates chore templates: title, description (optional), points, assigned kid, schedule on **specific days of week**
  - System generates a **chore instance per occurrence** with lifecycle:
    - Open → Submitted → Approved/Rejected
  - Kids submit completion; parents approve/reject
  - Instances **expire** after the day ends if not submitted/approved (per requirement)
- **Wallet / Points**
  - One points balance per kid (earned by approved chores)
  - Points can be spent in store (same balance) via parent-approved requests
- **Store**
  - Catalog of one-time items (e.g., “30 min PS5”, “Screen time”, “Day off”)
  - Kid requests redemption → parent approves/denies → (optionally) mark fulfilled
- **Payout**
  - Weekly **Friday payout**: compute weekly total (based on approved chores in the period)
  - Show **weekly payout amount** (history); points remain tracked normally (no separate “cash ledger” required beyond payout history display)
  - **Conversion rate configurable per kid** (points → cash)
- **Offline-first**
  - App usable offline: actions queued and synced when online (chores submission, approvals, store requests)

## Success Criteria
- Parent can set up family, add 2 parents + multiple kids, and link a second device via invite code in <5 minutes.
- Kids can reliably see daily queue and submit chores offline; sync resolves when online.
- Parent approval workflow works end-to-end with clear statuses and auditability.
- Friday payout amount is correct for each kid and visible in payout history.
- Store redemption flow (request/approve/deny/fulfill) reduces points balance correctly and is consistent across devices.

## Non-Goals
- Real money transfers or integrations (Stripe/PayPal/etc.). Payments happen offline.
- iOS, web, or multi-family support in MVP.
- Advanced gamification (badges, streaks, leaderboards) beyond points.
- Complex scheduling beyond specific days-of-week (e.g., every N days, rotating assignments) for MVP.
- Photo proof, timers, geofencing, or chat/messaging in MVP.