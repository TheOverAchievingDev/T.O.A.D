# ProcReaper — Task Breakdown

## Task 1 — Solution scaffold and CI
- ID: T-001
- Deliverable: `ProcReaper.sln` with `ProcReaper.Core`, `ProcReaper.App` (WPF), `ProcReaper.Tests`; `.editorconfig`; GitHub Actions workflow running `format --verify-no-changes`, `build /warnaserror`, `test`.
- Covers requirements: foundation for all
- Acceptance: `dotnet build` and `dotnet test` succeed on a clean checkout; CI green on a no-op PR; `WarningsAsErrors` set in every project.
- Suggested role: developer
- Depends on: none

## Task 2 — ProcessScanner
- ID: T-002
- Deliverable: `IProcessScanner` + `ProcessScanner` returning `ProcessSnapshot[]` (PID, name, path, user, CPU%, RAM, handles, threads, NotResponding, StartTime).
- Covers requirements: 1, 2, 3
- Acceptance: unit test scans the current process and asserts PID match + CPU% ≥ 0 + Name non-empty; spawning a `notepad.exe` test fixture appears in the result; "NotResponding" verified by spawning a process that ignores `WM_NULL`.
- Suggested role: developer
- Depends on: T-001

## Task 3 — KillService with safety guards
- ID: T-003
- Deliverable: `IKillService` + `KillService` using `OpenProcess`/`TerminateProcess`/`WaitForSingleObject`; protected-list constant; whitelist consulting; typed `KillOutcome`.
- Covers requirements: 9, 10, 11, 13, 15
- Acceptance: test "spawn `notepad.exe` → terminate → assert process gone within 3 s"; test "TerminateAsync('System') returns `Protected` and process is still alive"; test "AccessDenied path returns typed outcome, does not throw".
- Suggested role: developer
- Depends on: T-001

## Task 4 — ActionLog (SQLite)
- ID: T-004
- Deliverable: `IActionLog` + `ActionLog` with append + filtered query; schema migration via `PRAGMA user_version`; fallback file on write failure.
- Covers requirements: 15, 16, 17
- Acceptance: append 100k synthetic rows; filter by name+date returns expected subset in < 200 ms; corrupting the DB file triggers graceful fallback log and a startup warning.
- Suggested role: developer
- Depends on: T-001

## Task 5 — SettingsStore with recovery
- ID: T-005
- Deliverable: `ISettingsStore` + `SettingsStore` reading/writing `settings.json`; corruption → timestamped `.bak` + defaults.
- Covers requirements: 21, 22
- Acceptance: round-trip test (write, reload, deep-equal); test feeds malformed JSON, asserts `.bak.*` file is created and a defaults file is loaded without exception.
- Suggested role: developer
- Depends on: T-001

## Task 6 — MainWindow & ProcessListView (manual kill)
- ID: T-006
- Deliverable: WPF MainWindow with DataGrid bound via MVVM; columns sortable; Refresh & Kill buttons; confirmation dialog; inline "Access denied — relaunch as admin" banner; cold start ≤ 2 s.
- Covers requirements: 1, 2, 13, 14
- Acceptance: FlaUI smoke test launches app and finds a row for the test process within 2 s; clicking Kill on a spawned `notepad.exe` removes it from the grid within one scan tick.
- Suggested role: developer
- Depends on: T-002, T-003, T-005

## Task 7 — Elevation handoff
- ID: T-007
- Deliverable: `IElevationService` + restart-elevated flow with state file (`--restore-state`); banner-button wiring in MainWindow.
- Covers requirements: 14
- Acceptance: when running unelevated and a privileged kill returns AccessDenied, clicking the banner relaunches the app elevated and restores the window position from the state file.
- Suggested role: developer
- Depends on: T-006

## Task 8 — Rule schema, RuleStore, RulesView
- ID: T-008
- Deliverable: `Rule` record + `RuleCondition` discriminated union; `IRuleStore` backed by `SettingsStore`; CRUD UI with validation.
- Covers requirements: 4, 5, 11
- Acceptance: create / edit / disable / delete a rule from the UI; reopening the app preserves all rules; saving a rule with zero conditions is blocked by inline validation; whitelist editor round-trips.
- Suggested role: developer
- Depends on: T-005

## Task 9 — StaleDetector dwell-time engine
- ID: T-009
- Deliverable: `IStaleDetector` + `StaleDetector` tracking per-(pid,ruleId) first-satisfied timestamps; returns `RuleMatch[]`.
- Covers requirements: 6, 12
- Acceptance: unit test feeds a fake clock and synthetic snapshots; rule with `dwell=10s` fires exactly once at t=10, suppresses re-fire on next tick because PID disappears, and resets state when conditions go false mid-dwell.
- Suggested role: developer
- Depends on: T-002, T-008

## Task 10 — RuleEngine, NotificationService, Tray
- ID: T-010
- Deliverable: `IRuleEngine` background loop; toast notifications (Kill/Skip/Always-Skip); tray icon with show/hide/exit; minimize-to-tray on close.
- Covers requirements: 6, 7, 8, 12, 18, 19, 20
- Acceptance: integration test (windowed) — enable a SilentKill rule for a spawned `notepad.exe` with `dwell=2s`; within 5 s the process is gone and the action log shows the rule-triggered kill; in Dry-Run mode the same scenario leaves the process alive but writes a `WOULD_KILL` log row; close button hides to tray and toast appears on subsequent rule fire.
- Suggested role: developer
- Depends on: T-003, T-004, T-009

## Task 11 — Action Log view with filters
- ID: T-011
- Deliverable: `ActionLogView` with date-range / name / rule / outcome filters; newest-first paging.
- Covers requirements: 17
- Acceptance: seed 10k rows; each filter produces correct subset; UI stays responsive (no UI-thread block > 50 ms during query).
- Suggested role: developer
- Depends on: T-004

## Task 12 — Performance & memory pass
- ID: T-012
- Deliverable: profiling report + fixes ensuring background scan ≤ 1% CPU on 6-core at 2 s interval, working set steady over a 24 h soak.
- Covers requirements: success-criteria (not a numbered EARS)
- Acceptance: tracked measurement before/after; 24 h soak run shows no monotonic memory growth and stable scan latency.
- Suggested role: tester
- Depends on: T-010

## Task 13 — Packaging & release artifact
- ID: T-013
- Deliverable: single-file self-contained `win-x64` `.exe` build; signing pipeline placeholder; README with install/run instructions.
- Covers requirements: foundation for distribution
- Acceptance: artifact runs on a clean Windows 11 VM with no .NET preinstalled; first-run with no `settings.json` succeeds; subsequent runs persist state.
- Suggested role: developer
- Depends on: T-011, T-012

## Task 14 — End-to-end smoke + EARS coverage matrix
- ID: T-014
- Deliverable: `tests/Coverage.md` mapping every EARS requirement (1–22) to at least one named test; a FlaUI scenario test that exercises manual kill, rule kill, dry-run, and tray.
- Covers requirements: 1–22 (verification mapping)
- Acceptance: matrix has no empty cells; running the scenario test in CI passes consistently; reviewer can trace any EARS requirement to its enforcing test in one hop.
- Suggested role: reviewer
- Depends on: T-013