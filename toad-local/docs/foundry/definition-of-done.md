# ProcReaper — Definition of Done

## Code
- [ ] `dotnet format --verify-no-changes` passes.
- [ ] `dotnet build -c Release /warnaserror` passes with zero warnings.
- [ ] `dotnet test -c Release` passes; coverage on `ProcReaper.Core` ≥ 80%.
- [ ] No new `[DllImport]` outside a `Native/` folder.
- [ ] No direct `Process.Kill()` calls outside `KillService` (grep-verified by reviewer).
- [ ] No `catch { }` or `catch (Exception) { }` with empty body anywhere in the diff.

## Documentation
- [ ] If an architectural choice was made (new dependency, new persistence layer, new privileged code path) a new ADR is appended to `design_decisions.md`.
- [ ] If the protected-process list changed, the change is reflected in an ADR addendum AND in `KillService` AND in its tests.
- [ ] Public API changes in `ProcReaper.Core` are reflected in `tests/Coverage.md`.

## Verification
- [ ] Every EARS requirement the task covers has at least one named test that fails if the behavior is broken.
- [ ] Manual smoke check noted in the task comments: app launches, lists processes within 2 s, a spawned `notepad.exe` is visible, and Kill removes it.
- [ ] Action log shows an entry for every kill attempt made during the smoke check.
- [ ] If the change touches the scan loop or rule engine, a 5-minute soak run is recorded with average background CPU% noted.

## Hygiene
- [ ] No `settings.json`, `actionlog.sqlite`, or `bin/`/`obj/` content committed.
- [ ] No `Debug.WriteLine` / `Console.WriteLine` left in shipping code paths.
- [ ] No commented-out code blocks in the diff.
- [ ] PR description names the task ID(s), the EARS requirement numbers covered, and the validation commands run.