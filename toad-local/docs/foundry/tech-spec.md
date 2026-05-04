# ChorePoints — Technical Spec
## Architecture
- **Client:** Android-only app (recommended: Kotlin + Jetpack Compose).
- **Backend:** Cloud sync service with:
  - Auth + family membership via **invite code**
  - Data storage for family, users, chores, instances, wallet, store, payouts
  - Sync endpoints supporting offline queued writes and conflict handling
- **Offline-first approach**
  - Local persistent store on device (recommended: Room/SQLite).
  - All user actions create local “pending mutations” (outbox).
  - Background sync worker:
    - Push queued mutations when network is available
    - Pull latest server changes
- **Identity & access**
  - **Family** is the top-level tenant.
  - Users are either **PARENT** or **KID**.
  - Parent mode protected via a **parent password** (stored securely; validate locally for “mode unlock”, while server enforces role for privileged actions).
  - Kids authenticate via profile + PIN (PIN verification local; server sees session/user identity).
- **Conflict strategy (pragmatic MVP)**
  - Server is source of truth; each record has `updatedAt` + `version`.
  - Mutations include `baseVersion`; server rejects if stale with a conflict response.
  - Client resolves by refetch + prompting parent (for parent-facing conflicts) or auto-retry (for safe merges).
  - For append-only events (submissions, approvals), prefer immutable event records to reduce conflicts.

## Data Model
Entities (fields are indicative; keep minimal and auditable):

- **Family**
  - `familyId`
  - `name`
  - `inviteCode` (rotatable)
  - `createdAt`

- **User**
  - `userId`
  - `familyId`
  - `role` = PARENT | KID
  - `displayName`
  - Parent auth fields (e.g., email/credential handle) as needed
  - Kid PIN metadata (do not store raw PIN; store salted hash locally; server can store a hash if server-side login is needed)
  - `createdAt`, `updatedAt`

- **ChoreTemplate**
  - `templateId`
  - `familyId`
  - `assignedKidUserId`
  - `title`, `description?`
  - `points`
  - `scheduleDaysOfWeek` (set of 0–6 or 1–7)
  - `active` (bool)
  - `createdByParentUserId`
  - `createdAt`, `updatedAt`

- **ChoreInstance**
  - `instanceId`
  - `familyId`
  - `templateId`
  - `assignedKidUserId`
  - `scheduledDate` (local date in family timezone)
  - `status` = OPEN | SUBMITTED | APPROVED | REJECTED | EXPIRED
  - `submittedAt?`, `submittedByKidUserId?`
  - `reviewedAt?`, `reviewedByParentUserId?`
  - `reviewNote?`
  - `pointsAwarded` (typically equals template points; allows future overrides)
  - `expiresAt` (end of scheduled day)
  - `createdAt`, `updatedAt`, `version`

- **PointsLedgerEntry** (recommended even if UI shows “one balance”; simplifies correctness)
  - `entryId`
  - `familyId`
  - `kidUserId`
  - `type` = EARNED | SPENT | ADJUSTMENT
  - `sourceType` = CHORE_INSTANCE | STORE_REDEMPTION | MANUAL
  - `sourceId`
  - `pointsDelta` (positive for earned, negative for spent)
  - `createdAt`

- **StoreItem**
  - `itemId`
  - `familyId`
  - `title`
  - `costPoints`
  - `active`
  - `createdAt`, `updatedAt`

- **StoreRedemption**
  - `redemptionId`
  - `familyId`
  - `kidUserId`
  - `itemId`
  - `status` = REQUESTED | APPROVED | DENIED | FULFILLED | CANCELED
  - `requestedAt`
  - `reviewedAt?`, `reviewedByParentUserId?`, `reviewNote?`
  - `fulfilledAt?`, `fulfilledByParentUserId?`
  - `createdAt`, `updatedAt`, `version`

- **WeeklyPayout**
  - `payoutId`
  - `familyId`
  - `kidUserId`
  - `weekStartDate` (Mon or configurable; define explicitly)
  - `weekEndDate` (Fri boundary for payout; define explicitly)
  - `approvedPointsTotal`
  - `conversionRate` (per kid at time of payout)
  - `cashAmount`
  - `computedAt`

- **KidConversionRate**
  - `familyId`
  - `kidUserId`
  - `rateMoneyPerPoint` (e.g., 0.25)
  - `currencyCode` (optional; default USD)
  - `updatedAt`

## API / Tool Surface
Backend API surface (REST or GraphQL; shown as REST-ish for clarity):

### Family & device linking
- `POST /families` → create family, returns `familyId`, `inviteCode`
- `POST /families/join` (inviteCode, user credential) → joins device/user to family
- `POST /families/invite/rotate` (parent-only) → new invite code

### Users & auth
- `POST /auth/login` / `POST /auth/refresh` (implementation-specific)
- `GET /me`
- `POST /kids` (parent-only) create kid profile
- `POST /parents` (parent-only) invite/add second parent (if supported in MVP)

### Chores
- `POST /chores/templates` (parent-only)
- `GET /chores/templates`
- `PATCH /chores/templates/{id}` (parent-only)
- `POST /chores/instances/generate` (server job or on-demand) ensure instances exist for date range
- `GET /chores/instances?kidUserId&from&to`
- `POST /chores/instances/{id}/submit` (kid)
- `POST /chores/instances/{id}/review` (parent; approve/reject + note)

### Store
- `GET /store/items`
- `POST /store/items` (parent-only)
- `PATCH /store/items/{id}` (parent-only)
- `POST /store/redemptions` (kid requests)
- `GET /store/redemptions?kidUserId&status`
- `POST /store/redemptions/{id}/review` (parent approve/deny)
- `POST /store/redemptions/{id}/fulfill` (parent)

### Wallet & payouts
- `GET /wallet/balance?kidUserId`
- `GET /wallet/ledger?kidUserId&from&to` (optional but recommended for debugging/support)
- `GET /payouts?kidUserId`
- `POST /payouts/compute?weekEnd=YYYY-MM-DD` (parent-only or scheduled job)

### Sync (offline-first)
Option A: Domain APIs + client outbox is sufficient.
Option B (more robust): add a generic sync endpoint:
- `POST /sync/push` (list of mutations with ids, baseVersion)
- `GET /sync/pull?since=cursor`

## External Dependencies
- Android: Jetpack Compose, Room, WorkManager, Android Keystore (secure storage), Kotlin serialization.
- Backend (suggested): Firebase (Auth + Firestore) or Supabase (Auth + Postgres) or custom Node/Go + Postgres.
  - Must support: multi-device auth, realtime-ish updates (nice-to-have), and conflict/versioning.
- Date/time handling: define and persist **family timezone** to correctly compute “scheduled day” and “Friday payout”.

## Validation
- **Business rules**
  - Only assigned kid can submit their own chore instance.
  - Only parents can approve/reject chores and redemptions, edit templates/items, rotate invite code, change conversion rates.
  - Chore instances expire at end of scheduled day; expired cannot be submitted (or can be submitted but flagged—pick one and enforce consistently; MVP: cannot submit after expiry).
  - Wallet balance = sum of ledger entries; prevent negative balance on redemption approval.
  - Friday payout calculation uses approved chore instances within the defined weekly window; store the conversion rate snapshot used.
- **Offline sync**
  - All actions work without network and reconcile without data loss.
  - Idempotency keys for mutations to prevent duplicates on retry.
- **Testing**
  - Unit tests: payout calculation, scheduling instance generation, ledger arithmetic.
  - Integration tests: sync push/pull, conflict responses, role enforcement.
  - UX validation: parent mode lock + kid PIN flows.