# ProcReaper — Product Brief

## Problem
Windows users routinely accumulate runaway, hung, or "stale" processes — browsers that ghost, IDEs that wedge, installers that never exit, GPU helpers that pin a core at 100% after the host app is closed. Task Manager surfaces them but offers no rules, no history, and no automation. Power users want a focused tool that watches for stale processes, applies user-defined criteria, and can either prompt-and-kill or auto-kill — without ever touching critical OS processes.

## Users
1. **Power user / developer** — runs many heavy apps simultaneously, wants one-click cleanup of frozen tooling and an at-a-glance view of what's eating CPU/RAM.
2. **Workstation operator** — leaves machine running for long batch jobs; wants background auto-kill of well-known offenders (e.g. `setup.tmp`, orphaned `node.exe` after a build).
3. **IT-savvy household admin** — installs on a family PC to keep it responsive without learning Task Manager; wants safe defaults and a clear action log.

## Scope
- Windows 10 (1809+) and Windows 11 desktop app, x64.
- Live process list with CPU %, working set, handle count, thread count, "not responding" flag, user, start time.
- Rule engine: per-process-name rules over CPU%, RAM, idle time, "not responding" duration, age.
- Kill modes: **Manual** (user picks from list), **Prompted Auto** (rule matches → toast → confirm), **Silent Auto** (rule matches → kill → log).
- Dry-run mode that logs what *would* be killed.
- Hard-coded safety: protected list (System, csrss, smss, winlogon, services, lsass, wininit, dwm, ProcReaper itself) is **never** killable.
- Per-user whitelist (always preserved) and blacklist (always candidate).
- Action log (SQLite) with filter/search.
- Minimize-to-tray; background scanning continues.
- Auto-elevation prompt when kill is blocked by ACL.
- Settings persisted as JSON next to the executable (portable-friendly).

## Requirements (EARS)

### Process inspection
1. WHEN the user opens the main window THE SYSTEM SHALL display every visible process with PID, name, CPU%, working-set MB, handle count, thread count, not-responding flag, owning user, and start time within 2 seconds.
2. WHILE the main window is visible THE SYSTEM SHALL refresh process metrics at a user-configurable interval between 1 and 30 seconds (default 2 seconds).
3. WHEN a process becomes unresponsive to window messages for at least 5 seconds THE SYSTEM SHALL mark it as "Not Responding" in the list.

### Rule engine
4. THE SYSTEM SHALL allow the user to create, edit, enable, disable, and delete kill rules.
5. WHEN a rule is created THE SYSTEM SHALL require: a unique name, at least one trigger condition (cpuPercent ≥ X for Y seconds | workingSetMB ≥ X for Y seconds | notRespondingSeconds ≥ X | nameMatches glob | ageMinutes ≥ X), an action (log | notify | kill), and a scope (any process | named process glob).
6. WHILE a rule is enabled and the application is running THE SYSTEM SHALL evaluate it against every scan tick and trigger its action when all conditions are met continuously for the rule's dwell time.
7. WHERE Silent Auto mode is enabled for a rule THE SYSTEM SHALL execute the rule's kill action without user confirmation.
8. WHERE Prompted Auto mode is enabled for a rule THE SYSTEM SHALL surface a Windows toast notification with Kill / Skip / Always-Skip-This-Process actions and SHALL not terminate the process until the user chooses Kill.

### Safety
9. THE SYSTEM SHALL maintain a hard-coded protected-process list (System, Idle, csrss, smss, winlogon, services, lsass, wininit, dwm, fontdrvhost, and the ProcReaper process itself) that cannot be killed by any code path.
10. IF a kill is attempted against a protected process THEN THE SYSTEM SHALL refuse the operation, log the attempt with reason "PROTECTED", and surface an inline error in the UI.
11. THE SYSTEM SHALL allow the user to maintain a whitelist of additional process names that are never killable by rules or the manual Kill button without an explicit "override whitelist" toggle for that one action.
12. WHILE Dry-Run mode is on THE SYSTEM SHALL log every action a rule *would* take but SHALL NOT terminate any process.

### Termination
13. WHEN the user clicks Kill on a selected process THE SYSTEM SHALL request termination via TerminateProcess, wait up to 3 seconds for exit, and report success or the Win32 error code.
14. IF termination fails with ERROR_ACCESS_DENIED THEN THE SYSTEM SHALL offer the user a one-click "Relaunch as administrator" action that restarts the app elevated and restores the previous window state.
15. WHEN a process is terminated by any path THE SYSTEM SHALL write an ActionLog row containing timestamp, PID, name, user, ruleId (or "manual"), outcome, and Win32 error code if any.

### Action log
16. THE SYSTEM SHALL persist every kill attempt, rule trigger, and dry-run decision to a local SQLite database stored next to the executable.
17. WHEN the user opens the Action Log view THE SYSTEM SHALL display entries newest-first with filters for date range, process name, rule, and outcome.

### Tray & background
18. WHEN the user clicks the window close button THE SYSTEM SHALL minimize the app to the system tray and continue scanning if any rule is enabled.
19. WHILE the app is minimized to tray and a Silent Auto rule fires THE SYSTEM SHALL show a Windows toast with the process name and rule name.
20. WHEN the user right-clicks the tray icon and selects Exit THE SYSTEM SHALL fully terminate the app and stop all background scanning.

### Settings
21. THE SYSTEM SHALL persist user settings (scan interval, rules, whitelist, blacklist, dry-run flag, tray-on-close flag) to `settings.json` next to the executable on every change.
22. IF `settings.json` is missing or fails to parse THEN THE SYSTEM SHALL log the error, back up the corrupt file as `settings.json.bak.<timestamp>`, and recreate it from defaults without crashing.

## Success Criteria
- Cold start to first populated process list ≤ 2 seconds on a typical i5/16GB machine.
- Background scan CPU cost ≤ 1% on a 6-core CPU at the 2-second interval.
- Zero successful kills of any process on the protected list across the full test suite.
- Auto-rule from trigger to terminated process ≤ scan-interval + 500 ms.
- Action log queryable on 100,000 rows under 200 ms for any single-field filter.
- Crash-free session rate ≥ 99.5% across 30-day internal dogfooding.

## Non-Goals
- No remote/networked control or telemetry.
- No cross-platform support (no macOS, no Linux).
- No kernel driver; no anti-malware behavior; we are not an EDR.
- No process *suspension* or *priority* changes in v1 (kill-only).
- No service installation in v1 — app must be running (foreground or tray) to act.
- No automatic updates in v1.