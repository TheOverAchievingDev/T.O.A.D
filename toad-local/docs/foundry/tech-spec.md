# ProcReaper — Technical Spec

## Architecture
Single-process Windows desktop app on .NET 8, WPF MVVM. Three assemblies plus tests. UI thread renders an observable process collection that is updated from a background scan loop via the dispatcher. All process-touching code lives behind interfaces so it can be mocked in tests.

```
┌────────────────────────────────────────────────────────────┐
│  ProcReaper.App  (WPF, MVVM, Tray, Toasts)                 │
│    Views ── ViewModels ── DispatcherTimer                  │
└──────────────────┬─────────────────────────────────────────┘
                   │  IProcessScanner, IRuleEngine,
                   │  IKillService, IActionLog, ISettings
┌──────────────────▼─────────────────────────────────────────┐
│  ProcReaper.Core                                           │
│   ProcessScanner ── StaleDetector ── RuleEngine            │
│   KillService ── ActionLog (SQLite) ── SettingsStore       │
└──────────────────┬─────────────────────────────────────────┘
                   │
            Win32 / WMI / PerfCounters / Microsoft.Data.Sqlite
```

Deployment shape: self-contained single-file `.exe` (win-x64, ReadyToRun, trimmed where safe). MSIX optional for v2. Side-by-side `settings.json` and `actionlog.sqlite`.

## Component Design

**ProcessScanner** (`Core/Scanning/ProcessScanner.cs`)
- Responsibility: enumerate processes and produce `ProcessSnapshot[]` once per call.
- Public interface: `Task<IReadOnlyList<ProcessSnapshot>> ScanAsync(CancellationToken)`.
- Owns: cached PerformanceCounter handles per PID; "not responding" detector via `SendMessageTimeout(WM_NULL)` on main window handle.
- Does NOT know about rules or UI.

**StaleDetector** (`Core/Rules/StaleDetector.cs`)
- Responsibility: hold dwell-time state per (pid, ruleId), report which (pid, ruleId) pairs are currently satisfied.
- Public interface: `IReadOnlyList<RuleMatch> Evaluate(IReadOnlyList<ProcessSnapshot> snapshots, IReadOnlyList<Rule> rules, DateTimeOffset now)`.
- Owns: per-(pid,rule) "first-seen-satisfied" timestamps. Reset when condition fails or PID disappears.
- Does NOT terminate anything.

**RuleEngine** (`Core/Rules/RuleEngine.cs`)
- Responsibility: orchestrate scan → detect → dispatch action per rule mode.
- Public interface: `Task<RuleTickResult> TickAsync(CancellationToken)`.
- Calls IProcessScanner, IStaleDetector, IKillService, IActionLog, INotificationService.
- Branches on `RuleMode { Log, Notify, PromptedKill, SilentKill }` and on global `dryRun` flag.

**KillService** (`Core/Killing/KillService.cs`)
- Responsibility: terminate a single PID safely.
- Public interface: `Task<KillOutcome> TerminateAsync(int pid, KillReason reason, CancellationToken)`.
- Owns: protected-name set (hard-coded constant). **Every** kill path goes through this method; UI never calls `Process.Kill()` directly.
- Returns `KillOutcome { Success | Protected | AccessDenied(int win32) | NotFound | Timeout | Error(msg) }`.

**ActionLog** (`Core/Logging/ActionLog.cs`)
- Responsibility: append-only history of every decision (manual kill, rule trigger, dry-run, protected refusal).
- Public interface: `Task AppendAsync(ActionLogEntry); Task<IReadOnlyList<ActionLogEntry>> QueryAsync(LogFilter)`.
- Owns: a SQLite connection; schema versioned via `PRAGMA user_version`.

**SettingsStore** (`Core/Config/SettingsStore.cs`)
- Responsibility: load/save `settings.json`; emit `Changed` event on save.
- Owns: file path, JSON serializer options, corruption-recovery logic.

**NotificationService** (`App/Notifications/NotificationService.cs`)
- Responsibility: Windows toast (Microsoft.Toolkit.Uwp.Notifications) with Kill / Skip / Always-Skip actions; replies routed back to RuleEngine via in-process channel.

**TrayController** (`App/Tray/TrayController.cs`)
- Responsibility: NotifyIcon, context menu, show/hide main window.

**Views/ViewModels** (`App/Views`, `App/ViewModels`)
- MainWindow / ProcessListView (DataGrid bound to `ObservableCollection<ProcessRow>`).
- RulesView (CRUD for rules).
- ActionLogView (filtered DataGrid).
- SettingsView.

## Data Model

**ProcessSnapshot** — `Pid (int), Name (string), ExecutablePath (string?), User (string?), CpuPercent (double), WorkingSetMB (double), Handles (int), Threads (int), NotResponding (bool), StartTime (DateTimeOffset)`. In-memory only; not persisted.

**Rule** — `Id (Guid), Name (string), Enabled (bool), Scope (NameGlob | AnyProcess), Conditions (List<RuleCondition>), DwellSeconds (int), Action (Log|Notify|PromptedKill|SilentKill), CreatedUtc, UpdatedUtc`. Persisted in `settings.json`.

**RuleCondition** — discriminated union: `CpuAtLeast(percent)`, `WorkingSetAtLeast(mb)`, `NotRespondingAtLeast(seconds)`, `AgeAtLeast(minutes)`, `NameMatches(glob)`. All conditions in a rule are ANDed.

**ActionLogEntry** — `Id (long PK), TimestampUtc, Pid, Name, User, RuleId (Guid?), RuleName (string?), Action (string), Outcome (string), Win32Error (int?), Notes (string?)`. Persisted in SQLite.

**Settings** — `ScanIntervalSeconds, DryRun, MinimizeToTrayOnClose, StartMinimized, Whitelist (string[]), Blacklist (string[]), Rules (Rule[])`. Persisted in `settings.json`.

No tenancy/scoping fields — this is single-user, single-machine.

## Sequence / Data Flow

### Flow 1 — Manual kill (happy path)
1. User opens MainWindow → `MainViewModel.OnLoaded` starts a `DispatcherTimer` at scan interval.
2. Tick → `ProcessScanner.ScanAsync` → returns `ProcessSnapshot[]`.
3. ViewModel diffs against `ObservableCollection<ProcessRow>` (add/remove/update by PID).
4. User selects row → clicks Kill → confirmation dialog.
5. ViewModel calls `KillService.TerminateAsync(pid, KillReason.Manual)`.
6. KillService checks protected-list and whitelist (unless override checked) → `OpenProcess(PROCESS_TERMINATE)` → `TerminateProcess` → `WaitForSingleObject(3000)` → `CloseHandle`.
7. KillService writes `ActionLogEntry` via `ActionLog.AppendAsync` regardless of outcome.
8. ViewModel removes row on next scan tick (or immediately on Success).

### Flow 2 — Silent Auto rule (happy path)
1. RuleEngine `TickAsync` fires (background `PeriodicTimer`).
2. `ProcessScanner.ScanAsync` → snapshots.
3. `StaleDetector.Evaluate(snapshots, enabledRules, now)` returns `RuleMatch[]` whose dwell time is satisfied.
4. For each match where rule.Action == SilentKill: if `Settings.DryRun` → log "WOULD_KILL"; else → `KillService.TerminateAsync(pid, KillReason.Rule(ruleId))`.
5. KillService logs outcome. NotificationService shows toast "Killed `chrome.exe` (PID 1234) — rule 'Hung Browser'".

### Flow 3 — Kill denied by ACL (unhappy path)
1. User clicks Kill on a service hosted as SYSTEM.
2. KillService → `OpenProcess` returns NULL → `Marshal.GetLastWin32Error()` == 5 (ERROR_ACCESS_DENIED).
3. KillService returns `KillOutcome.AccessDenied(5)` and logs.
4. ViewModel surfaces an inline banner: "Access denied. Relaunch as administrator?" with a button.
5. On click → `ElevationService.RestartElevated()` → starts a new instance with `runas` verb and `--restore-state <path>`; current instance exits cleanly.
6. New elevated instance reads state file, restores window geometry and selection.

### Flow 4 — Corrupt settings recovery
1. App start → `SettingsStore.Load()` → `JsonException`.
2. SettingsStore renames the file to `settings.json.bak.20260514T120000Z`, writes defaults, raises a non-fatal warning toast, and continues startup.
3. Action log records `SETTINGS_RECOVERED` entry.

## API / Tool Surface
Desktop app — no HTTP/RPC surface. Internal service contracts (covers EARS req #s):

| Contract | Method | Covers |
|---|---|---|
| `IProcessScanner` | `ScanAsync(ct) → IReadOnlyList<ProcessSnapshot>` | 1, 2, 3 |
| `IRuleStore` | `Get/Add/Update/Remove/Enable/Disable` | 4, 5 |
| `IRuleEngine` | `TickAsync(ct)`, `Start()`, `Stop()` | 6, 7, 8, 12 |
| `IKillService` | `TerminateAsync(pid, reason, ct) → KillOutcome` | 9, 10, 11, 13, 15 |
| `INotificationService` | `ShowKillPromptAsync(snapshot, rule) → PromptResult` | 8, 19 |
| `IActionLog` | `AppendAsync(entry)`, `QueryAsync(filter)` | 15, 16, 17 |
| `ISettingsStore` | `Load()`, `Save(settings)`, `OnChanged` | 21, 22 |
| `IElevationService` | `IsElevated`, `RestartElevatedAsync(stateFile)` | 14 |
| `ITrayController` | `MinimizeToTray()`, `RestoreWindow()`, `Exit()` | 18, 20 |

CLI args:
- `--minimized` — start hidden in tray.
- `--restore-state <path>` — internal, used after elevation handoff.
- `--dry-run` — overrides settings flag for this session.

## Error Handling
- **Validation errors** (rule create with no conditions, threshold negative): surfaced inline in the rule editor; Save button stays disabled.
- **Win32 failures** (`OpenProcess`/`TerminateProcess`): captured as `KillOutcome.AccessDenied|NotFound|Error(code)`; surfaced in UI banner + ActionLog. No exception bubbles to UI thread.
- **PerformanceCounter NaN/disposed**: caught in scanner; CPU% reported as `0.0` with a one-time warning log per PID; counter recreated on next tick.
- **SQLite write failure**: retry once after 100 ms; on second failure, log to stderr and a fallback file `actionlog.fallback.txt`. Never block the kill itself on log success.
- **Corrupt settings**: see Flow 4.
- **Idempotency**: kill operations are naturally idempotent on PID; rule re-trigger after kill is suppressed because PID disappears in the next scan.
- **No silent catches**: every `catch` either re-throws, returns a typed outcome, or writes a log entry. See steering.md.

## Testing Strategy

| Layer | Tool | What |
|---|---|---|
| Unit | xUnit + FluentAssertions + NSubstitute | RuleEngine, StaleDetector (dwell-time math), KillService (protected list, whitelist override), SettingsStore (corruption recovery), ActionLog (filter SQL). |
| Integration | xUnit, real SQLite, spawn `notepad.exe` / `timeout.exe` as test fixtures | KillService against a real spawned process; ActionLog query performance with 100k rows seeded; ProcessScanner against current process; ProtectedList enforcement against `services.exe` (expect refusal, no actual kill attempt). |
| UI smoke | WPF UI test via FlaUI | Launch app → assert MainWindow lists ≥1 process within 2 s; click Kill on a spawned `notepad.exe` and assert it disappears. |
| Static | `dotnet format`, `dotnet build /warnaserror`, Roslyn analyzers, `dotnet-coverage` ≥ 80% on `ProcReaper.Core`. |

Validation commands the team runs before claiming done:
```
dotnet format --verify-no-changes
dotnet build -c Release /warnaserror
dotnet test -c Release
```

Requirement-to-test mapping is captured in `tests/Coverage.md` — every EARS requirement gets at least one named test.

## External Dependencies
- .NET 8 SDK
- WPF (in-box)
- `Microsoft.Data.Sqlite` 8.x
- `Microsoft.Toolkit.Uwp.Notifications` (toast)
- `Hardcodet.NotifyIcon.Wpf` (tray)
- `System.Diagnostics.PerformanceCounter` 8.x
- Test: `xunit`, `FluentAssertions`, `NSubstitute`, `FlaUI.Core` + `FlaUI.UIA3`
- Build: GitHub Actions windows-latest runner; output: single-file self-contained `win-x64` `.exe`.