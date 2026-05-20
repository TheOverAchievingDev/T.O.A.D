# ProcReaper — Roadmap

## Phase 1 — Reaper Core (MVP)
- Scaffold solution, CI, and code-style gates.
- `ProcessScanner` with live CPU%, RAM, handles, threads, NotResponding.
- `KillService` with hard-coded protected list and ActionLog writes.
- Minimal WPF MainWindow: sortable DataGrid + Refresh + Kill button + protected-process banner.
- `SettingsStore` (load/save + corruption recovery).
- `ActionLog` SQLite store + simple Log view.
- Elevation detection + "Relaunch as administrator" path on AccessDenied.
- Validation commands wired: `dotnet format`, `dotnet build /warnaserror`, `dotnet test`.

**Exit gate:** user can manually kill a hung `notepad.exe` from the UI, protected processes are refused, and every action shows up in the log.

## Phase 2 — Rules & Automation
- Rule schema + JSON persistence + RulesView CRUD.
- `StaleDetector` dwell-time engine.
- `RuleEngine` background tick with Log / Notify / PromptedKill / SilentKill modes.
- Tray icon + minimize-to-tray + toast notifications with Kill/Skip actions.
- Dry-run global toggle.
- Whitelist / blacklist editor.
- Performance pass: ≤ 1% background CPU at 2 s interval.

**Exit gate:** a "kill any process named `setup.tmp` that's been NotResponding for 30 s" rule reliably fires end-to-end and the kill is logged.

## Phase 3 — Hardening & Polish
- Action Log filters (date / name / rule / outcome) + CSV export.
- Per-rule statistics view (last fired, total kills, last failure).
- Settings backup/restore.
- Crash reporter (local file, opt-in upload deferred).
- Installer (MSIX) + signed binary.
- Keyboard shortcuts and accessibility pass (screen-reader labels, high-contrast theme).
- Deferred to v2: process *suspend* and priority change, Windows Service mode, remote management, cross-machine sync, kernel-level visibility.