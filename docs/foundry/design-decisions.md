# ProcReaper — Design Decisions

## ADR-001 — Runtime & UI framework: .NET 8 + WPF
- **Decision**: Build the app on .NET 8 with WPF using the MVVM pattern.
- **Rationale**: WPF is the most mature Windows-native desktop stack, ships with .NET, has excellent DataGrid support, and integrates trivially with Win32 P/Invoke for process introspection and termination. AI-agent code generation is well-supported. Single-file self-contained publishing eliminates runtime install friction.
- **Alternatives considered**:
  - *WinUI 3 / WindowsAppSDK*: more modern visuals, but more deployment friction (packaging, signing, MSIX-only happy path) and less mature DataGrid story.
  - *Electron + Node*: cross-platform irrelevance penalized binary size and memory; Win32-process work would need a native helper anyway.
  - *Python + PySide6*: viable, but worse Win32 ergonomics and harder to ship a clean single-file Windows binary.
- **Consequences**: We ship Windows-only on purpose. The team must know C#/XAML. UI looks "Win32-classic" out of the box; design polish in Phase 3 adds custom styles.

## ADR-002 — Termination strategy: P/Invoke OpenProcess + TerminateProcess (never Process.Kill from UI)
- **Decision**: All kills go through a single `IKillService` that uses `OpenProcess(PROCESS_TERMINATE)` + `TerminateProcess` + `WaitForSingleObject` and returns a typed `KillOutcome`. UI/rule code never invokes `Process.Kill()` directly.
- **Rationale**: One choke point makes the protected-process list enforceable, makes the Win32 error code available for the elevation prompt, lets every code path be tested at one seam, and avoids `Process.Kill()`'s lossy exception model.
- **Alternatives considered**:
  - *`Process.Kill()` everywhere*: simple but scatters the safety check, hides Win32 error codes, and forces exception-based flow control.
  - *Powershell `Stop-Process` shell-out*: adds a process boundary, latency, and arbitrary-input surface.
  - *Kernel driver*: massively out of scope and crosses into AV/EDR territory.
- **Consequences**: Steering rule "never call `Process.Kill()` directly" is enforceable by code review and grep. KillService becomes the most safety-critical file in the codebase and gets the densest test coverage.

## ADR-003 — Persistence split: JSON settings + SQLite action log
- **Decision**: Configuration (rules, whitelist, scan interval, flags) lives in `settings.json` next to the executable; the append-mostly action log lives in a SQLite file (`actionlog.sqlite`) next to the executable.
- **Rationale**: Settings are small, human-editable, diffable, and rarely written — JSON wins. Action log is append-heavy and filter-queried; SQLite gives indexed queries, transactional writes, and 100k+ rows under 200 ms without rolling our own format. Keeping both side-by-side preserves portability (no registry, no AppData hunt).
- **Alternatives considered**:
  - *Everything in SQLite*: rules become harder to hand-edit and version-control; no clear win.
  - *Everything in JSON*: action log scales poorly past a few thousand rows; filter queries become O(n) reads on every UI interaction.
  - *Registry / AppData*: hostile to portable use and complicates backup/restore.
- **Consequences**: Two persistence layers, two backup paths, two corruption recovery flows. Both are routed through `ISettingsStore` and `IActionLog` so the UI doesn't know the difference.

## ADR-004 — Auth & permission model: per-user, elevation on demand
- **Decision**: Run unelevated by default; detect elevation state; offer one-click "Relaunch as administrator" only when a kill fails with ERROR_ACCESS_DENIED.
- **Rationale**: Forcing admin at launch is hostile and trains users to dismiss UAC. Most kills (the user's own processes) succeed unelevated. The on-demand handoff with state restore keeps the principle-of-least-privilege win without sacrificing capability.
- **Alternatives considered**:
  - *Always elevated*: UAC fatigue, broader attack surface, slower iteration.
  - *Never elevated*: silently fails on common targets (services, other-user processes), defeating the product.
  - *Install a Windows service helper*: out of scope for v1; revisit if elevation handoff proves clunky.
- **Consequences**: The elevation handoff state-file format becomes a stable internal contract (covered by T-007). Tests must run in both elevated and unelevated configurations.

## ADR-005 — Hard-coded protected-process list (no user override)
- **Decision**: System / Idle / csrss / smss / winlogon / services / lsass / wininit / dwm / fontdrvhost / ProcReaper itself are baked into `ProcReaper.Core` and cannot be killed from any UI path. The user *whitelist* is additive (extra protected names) but the user cannot remove items from the hard list.
- **Rationale**: Killing these processes blue-screens or destabilizes Windows. A user-facing override invites support nightmares and accidental self-destruction. Treating the list as design surface (versioned via ADR addenda) keeps it auditable.
- **Alternatives considered**:
  - *User-editable*: too dangerous, even with warnings.
  - *No protection at all*: violates Success-Criteria item 3 and the entire safety story.
- **Consequences**: Adding a name to the protected list requires a code change + a new ADR addendum. The list is tested as a unit — every name in it must be refused by `KillService` in test.