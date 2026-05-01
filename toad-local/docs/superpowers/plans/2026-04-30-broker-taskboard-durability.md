# Broker and TaskBoard Durability

Slice: 2026-04-30
Status: complete

## Goal

The previous slice gave the orchestrator a real `dbPath` for `runtimeRegistry`, `eventLog`, and `approvalBroker`. But `LocalToadRuntime` still defaults `broker` and `taskBoard` to `InMemoryBroker` and `InMemoryTaskBoard` — so messages between agents and task-board state still vanish across restarts. SQLite-backed alternatives (`SqliteBroker`, `SqliteTaskBoard`) already exist, are tested, and have method parity with their in-memory counterparts. This slice swaps the defaults so the durability story is consistent across all five storage surfaces.

## Design

`LocalToadRuntime` constructs `broker` and `taskBoard` defaults the same way it now constructs the other SQLite components — passing `filePath: dbPath`. When `dbPath` is `:memory:` (the constructor default that tests use), the SQLite versions still work identically to the in-memory ones for the test surface; when `dbPath` is a real file, messages and tasks persist across restarts.

API parity verification:

- `InMemoryBroker` / `SqliteBroker`: both expose `appendMessage`, `listInbox`, `listMessages`, `markRead`. `SqliteBroker` also has `close()`.
- `InMemoryTaskBoard` / `SqliteTaskBoard`: both expose `appendEvent`, `listEvents`, `getTask`, `listTasks`. `SqliteTaskBoard` also has `close()`.

`LocalToadRuntime.close()` already iterates these via `closeIfSupported` — no change needed.

## Changes

- `src/app/LocalToadRuntime.js` — defaults for `broker` and `taskBoard` now use the SQLite-backed versions and accept `filePath: dbPath`.
- `test/localToadRuntime.test.js` — new persistence test: writes a message and a task event through one runtime against a temp `dbPath`, closes, opens a second runtime, asserts both survive.
- `README.md` — note the expanded durability surface.

## Verification

```powershell
npm.cmd test
```

All 26 backend test files pass. The default swap is exercised transitively by every existing test that constructs a default `LocalToadRuntime` — they continue to pass because the SQLite versions of broker and taskBoard match the in-memory APIs.

## Out Of Scope

- Migration of any actual message/task data from prior `:memory:` runs (there is none — the data was already vanishing on restart, this slice just stops that from happening going forward).
- VACUUM / disk reclamation. Now relevant since all five stores write to the file, but a separate slice.
- A general "swap any in-memory store for SQLite via env var" plumbing. Not needed; the constructor default IS the operator-facing knob.
