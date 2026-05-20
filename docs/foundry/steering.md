# ProcReaper — Team Steering

## Coding Standards
- .NET 8, C# 12, nullable reference types **on** project-wide, `TreatWarningsAsErrors=true` in every csproj.
- File-scoped namespaces; `var` only when the type is obvious from the right-hand side.
- Async-first for any I/O or scan work; `async void` is forbidden outside event handlers.
- 4-space indent, LF line endings, UTF-8 no BOM, `.editorconfig` is authoritative.
- MVVM in the WPF project — no business logic in code-behind. Views bind to ViewModels; ViewModels depend on interfaces from `ProcReaper.Core`.
- Public APIs in `ProcReaper.Core` get XML doc comments only when the WHY is non-obvious (per global docs guidance). Prefer good names over comments.
- Discriminated-union-style outcomes (`KillOutcome.Success | Protected | AccessDenied | …`) instead of throwing for expected failure modes.

## Tooling Required
Run before claiming any task done:
```
dotnet format --verify-no-changes
dotnet build -c Release /warnaserror
dotnet test  -c Release
```
Phase-3 tasks also run the FlaUI smoke project. Reviewers verify the EARS coverage matrix in `tests/Coverage.md` is current.

## Architecture Constraints
- **Every** process termination MUST go through `IKillService.TerminateAsync`. UI, RuleEngine, and tests never call `Process.Kill()` directly.
- The protected-process list is a `static readonly` constant in `ProcReaper.Core` and MUST be enforced inside `KillService` itself — UI-level checks are not sufficient.
- `ProcReaper.Core` has zero references to `PresentationFramework`, `WindowsBase`, or any WPF assembly. UI code lives only in `ProcReaper.App`.
- All persistence goes through `ISettingsStore` or `IActionLog` — never `File.WriteAllText` from a ViewModel.
- All Win32 P/Invokes are isolated in a single `Native/` folder per assembly; no inline `[DllImport]` scattered across business code.
- The scan loop owns the `PeriodicTimer`; ViewModels subscribe via events. There is exactly **one** scan loop running per app instance.

## Never Do
- **Never** call `Process.Kill()` directly from UI, ViewModels, or rule code. Always go through `IKillService`.
- **Never** hardcode-bypass the protected-process list, even "for testing" — tests assert the *refusal*, they don't disable it.
- **Never** swallow exceptions silently (`catch { }` or `catch (Exception) { /* nothing */ }`). Either rethrow, return a typed outcome, or log via `IActionLog`.
- **Never** commit `settings.json`, `actionlog.sqlite`, `*.user`, or `bin/` / `obj/` directories.
- **Never** disable a failing test to make CI green — fix the test or the code.
- **Never** introduce a new NuGet dependency without an ADR entry in `design_decisions.md`.
- **Never** block the UI thread on a scan, kill, or log query — use async dispatch.
- **Never** request admin elevation at startup; elevate only on demand via the documented `IElevationService` flow.

## Communication
- Report task completion to the lead with: task ID, the EARS requirement numbers it satisfied, the validation commands run, and any deviations from the brief.
- If blocked for more than 5 minutes on a single sub-step, send a status update naming the blocker before continuing.
- If a kill-path edge case is discovered during work (a new "should be protected" name, an unexpected Win32 error), open a tasks.md addendum entry before patching — the protected list is design surface, not implementation detail.