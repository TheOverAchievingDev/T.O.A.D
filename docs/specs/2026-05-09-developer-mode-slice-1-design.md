# Developer Mode — Slice 1 Design

**Status:** brainstormed 2026-05-09. Closes the loop on `FUTURE-IDEAS.md`'s "AI builds it WITH me vs FOR me" framing — Slice 1 ships the gating infrastructure plus the first two power-user surfaces (Tier 1).

**Cross-references:**
- `toad-local/docs/FUTURE-IDEAS.md` — the philosophical framing this slice realizes
- Cockpit terminal/test bar (removed in `b1ae19d`) is recovered from parent commit `e885afe` for restoration

## The pitch

Symphony's default audience is the bouncer-givers-up vibe coder — non-developers who need an AI-first IDE that hides 80% of the controls. The hooked-struggler graduates from that audience want more depth: a place to manually run validations, a code-first cockpit landing, eventually a raw event log and per-call cost telemetry. Developer Mode is the opt-in for them. Vision 1 of the three FUTURE-IDEAS visions: same product, more visible controls. Same audience, more depth — not a different audience.

## Decisions log

| # | Question | Decision |
|---|----------|----------|
| Q1 | Vision (advanced UI skin / different relationship / escape hatch) | **Vision 1: Advanced UI skin.** Same product, more visible controls. Future-Vision-2 ("AI builds it WITH me" pair-programming) is a separate later round. |
| Q2 | Surfaces in Slice 1 (Tier 1 / Tier 2 / Tier 3) | **Tier 1 only.** (a) Restore terminal/test bar gated on `developerMode`, (b) Cockpit default tab flips to `code` when on. Tier 2/3 surfaces (raw tool input toggle, per-role model picker, hunk-level diffs, raw event log, cost-per-call, keybindings, prompt override, Foundry raw editor) gate themselves as they ship. |
| Q3 | Toggle persistence | Global scope (user-level settings). Persisted via the existing `tweaks` system. Default `false`. |
| Q4 | Toggle location | Settings → Advanced tab. Single toggle row with short description. |
| Q5 | Visual indicator when active | None. The presence of dev surfaces is the indicator. No "DEVELOPER MODE" banner. |
| Q6 | Activation behavior | Hot-swap. Toggling triggers React re-render; surfaces appear/disappear immediately. The Cockpit center-tab default is captured at mount, so a mid-session toggle leaves the current tab as-is — affects the next mount. |
| Q7 | Discoverability | Low. Buried in Settings → Advanced. The audience for dev mode is the hooked-struggler graduate, not the new user. They go looking when they're ready. |

## 1. Architecture

```
ui/src/types/index.ts                 — Tweaks interface gains `developerMode: boolean`
ui/src/hooks/useDeveloperMode.ts      — NEW. One-line hook over useTweaks().
ui/src/components/settings/AdvancedSettings.tsx — adds the toggle row
ui/src/components/CockpitScreen.tsx   — restores terminal/test bar (gated)
                                        + flips center-tab default (gated)
ui/src/styles/app-shell.css           — restores cockpit-bottom + cockpit-terminal
                                        rules; the .dev-mode class on cockpit-screen
                                        re-enables the 2-row grid
```

No backend changes. The toggle is UI-only.

## 2. The hook

```ts
// ui/src/hooks/useDeveloperMode.ts
import { useTweaks } from './useTweaks';

/**
 * Returns true when the operator has enabled Developer Mode in
 * Settings → Advanced. Components gate dev-only surfaces on this.
 *
 * Hot-swappable: toggling triggers React re-render through the
 * existing tweaks store; consumers re-evaluate immediately.
 */
export function useDeveloperMode(): boolean {
  const { tweaks } = useTweaks();
  return tweaks.developerMode === true;
}
```

That's the entire shared abstraction. No prop drilling, no context provider, no backend round-trip.

## 3. The Tweaks type extension

In `ui/src/types/index.ts:169`, the existing `Tweaks` interface gets one new optional field at the bottom (after `showTweaks`):

```ts
export interface Tweaks {
  // ...existing fields unchanged...
  showTweaks: boolean;
  /** Developer mode opt-in — reveals power-user surfaces. Default false. */
  developerMode?: boolean;
}
```

Optional `?` so existing settings.json files without the field default to `false` cleanly via the `=== true` check in the hook.

## 4. The Settings toggle

`ui/src/components/settings/AdvancedSettings.tsx` adds a toggle row matching whatever style the file already uses (read it first; mirror existing patterns). Conceptually:

```tsx
<SettingsCard title="Developer mode">
  <ToggleRow
    label="Developer mode"
    description="Reveals power-user surfaces: integrated terminal/test runner in cockpit, code-first cockpit default. More controls as future slices ship."
    checked={tweaks.developerMode === true}
    onChange={(value) => setTweak('developerMode', value)}
  />
</SettingsCard>
```

(If `AdvancedSettings.tsx` doesn't have a `ToggleRow` helper, mirror whatever pattern other toggles use — likely an inline `<input type="checkbox">` with the same styling as `WorkspaceSettings.tsx` or similar.)

## 5. Surface 1 — Terminal / Test Runner restoration

The full implementation removed in `b1ae19d` is recoverable from parent commit `e885afe`. Restoration touches:

**`CockpitScreen.tsx`:**
- Re-import `VALIDATION_KINDS`, `ValidationKind`, `formatValidationDuration`, `validationOutputLines` from `./cockpitValidation` and `@/types`
- Re-add the four state hooks: `terminalExpanded`, `validationKind`, `testMessage` (with their setters), and the existing `testRunning` keeps its current behavior
- Re-add the three derived values: `latestValidation`, `latestValidationOutput`, `selectedKindLatestValidation`
- Restore the full `runSelectedTaskValidation` body (with kind selector + verdict message + setTestMessage)
- Add `useDeveloperMode()` call near the top
- Wrap `<main>` className with the dev-mode class:
  ```tsx
  <main className={`cockpit-screen ${developerMode ? 'dev-mode' : ''} ${terminalExpanded ? 'terminal-expanded' : ''}`}>
  ```
- Restore the entire `<section className="cockpit-bottom">` JSX block, but wrap it in `{developerMode && (<section ...>...</section>)}`

**`app-shell.css`:**
- Restore all bar-only rules: `.cockpit-bottom`, `.cockpit-bottom-title`, `.cockpit-bottom-actions`, `.cockpit-terminal-toggle`, `.cockpit-test-message`, `.cockpit-terminal`, `.cockpit-validation-bar`, `.cockpit-validation-kind`, `.cockpit-validation-history`, `.cockpit-terminal-output`
- Modify `.cockpit-screen` to use a single-row grid by default, switching to two rows ONLY when `.dev-mode` class is present:
  ```css
  .cockpit-screen {
    display: grid;
    grid-template-columns: minmax(260px, 320px) minmax(420px, 1fr) minmax(280px, 360px);
    /* Default: single row. cockpit-left and cockpit-right span the
       full grid implicitly. */
  }
  .cockpit-screen.dev-mode {
    grid-template-rows: minmax(0, 1fr) 68px;
  }
  .cockpit-screen.dev-mode.terminal-expanded {
    grid-template-rows: minmax(0, 1fr) minmax(180px, 24vh);
  }
  /* These selectors only apply when dev-mode is on; otherwise the
     cockpit-bottom never renders so its grid-row reservation is moot. */
  .cockpit-screen.dev-mode .cockpit-left {
    grid-row: 1 / 3;
  }
  .cockpit-screen.dev-mode .cockpit-right {
    grid-row: 1;
  }
  ```
- Restore the responsive `@media (max-width: 1180px)` overrides for the bar, gated under `.cockpit-screen.dev-mode`

## 6. Surface 2 — Cockpit center-tab flip

In `CockpitScreen.tsx`, change the existing `useState<CenterTab>('flow')` initializer to depend on dev mode:

```ts
const developerMode = useDeveloperMode();
const [centerTab, setCenterTab] = useState<CenterTab>(developerMode ? 'code' : 'flow');
```

`useState`'s initializer only runs on first mount, so this captures the dev-mode state at mount time. Toggling dev mode mid-session does NOT change an already-mounted CockpitScreen's `centerTab` — that's intentional. The user can click the Code tab if they want it now. The flip only applies to the next time Cockpit mounts, which is the natural moment to re-evaluate "what should I land on by default."

## 7. Hot-swap semantics

| Surface | Hot-swap effect |
|---|---|
| Terminal/test bar | Appears/disappears immediately when toggled (the JSX is gated on `developerMode`, the hook re-evaluates on every render) |
| Cockpit grid layout | Switches between 1-row and 2-row layout immediately (CSS class flips on `<main>`) |
| Cockpit center-tab default | Captured at mount only. Mid-session toggle does not retroactively flip the active tab. |

This duality is deliberate — the bar-visibility wants to track real-time, the default-tab is a "what do I land on" decision that's only meaningful at landing time.

## 8. UI changes summary

- One new file: `ui/src/hooks/useDeveloperMode.ts`
- One type extension: `ui/src/types/index.ts`
- One settings toggle row: `ui/src/components/settings/AdvancedSettings.tsx`
- One CockpitScreen edit (state + hook + JSX gate + class)
- One CSS file edit: restore `cockpit-bottom*` rules under `.dev-mode` class

## 9. Testing

- **Backend:** No changes. `npm test` should pass unchanged.
- **UI typecheck:** `cd ui && npx tsc --noEmit` — clean.
- **Manual smoke:**
  1. Settings → Advanced shows the new toggle, default off
  2. Toggle on → cockpit-bottom bar appears, cockpit-screen has 2-row grid, terminal-expanded toggle works as before
  3. Reload app → toggle state persists
  4. Open Cockpit fresh with dev mode on → center-tab is `code`
  5. Toggle off → bar vanishes, grid collapses to single row, no clipping, next Cockpit mount lands on `flow`

No automated UI tests today; matches existing pattern.

## 10. Risks / non-goals

**Non-goals (Slice 1):**
- Vision 2 ("AI builds it WITH me" — different agent relationship)
- Tier 2 surfaces (raw tool input toggle, per-role model picker)
- Tier 3 surfaces (hunk-level diffs, raw event log, cost-per-call, keybindings, prompt override, Foundry raw editor)
- A "DEVELOPER MODE" banner / visual indicator
- Discoverability nudges ("you might want to enable dev mode")
- ASPE plain-English summarizer (FUTURE-IDEAS.md item, but it's a default-mode feature, not dev-mode)

**Risks:**
- *User toggles dev mode, doesn't see anything change at first.* Cockpit needs to be remounted for the tab flip to apply. The terminal bar appears immediately so they have signal that something changed; the tab default is the surprise. Mitigation: keep the toggle's description honest ("More controls as future slices ship") so expectation is "small set of additions," not "whole new product."
- *Tweaks store doesn't persist `developerMode` correctly.* The existing tweaks system handles arbitrary keys; adding a new boolean field shouldn't surprise it. Verify by reload-test.
- *Cockpit grid layout breaks because the `.dev-mode` class isn't applied somewhere.* Mitigation: the default (no `.dev-mode` class) is the post-`b1ae19d` single-row layout that already works. The `.dev-mode` class only adds the bottom row, doesn't change the columns.

## 11. Module layout

```
ui/src/types/index.ts                        ← MODIFY (add developerMode field)
ui/src/hooks/useDeveloperMode.ts             ← NEW
ui/src/components/settings/AdvancedSettings.tsx ← MODIFY (toggle row)
ui/src/components/CockpitScreen.tsx          ← MODIFY (restore bar + tab flip)
ui/src/styles/app-shell.css                  ← MODIFY (restore + gate bar styles)
```

## 12. Estimated scope

- ~8-10 tasks in the implementation plan
- ~150-200 LOC restored from `e885afe` (terminal/test bar JSX + state)
- ~30 LOC new (hook, gating, Settings toggle)
- ~80 LOC of CSS restored
- ~1 day of subagent-driven execution

## 13. Self-review

- **Placeholders:** None. All sections concrete; method signatures shown.
- **Internal consistency:** Decisions log Q1-Q7 ↔ architecture diagram ↔ surface specs all line up. The hot-swap dual semantic (bar realtime, tab on mount) is called out explicitly.
- **Scope:** Focused on a single coherent feature (Developer Mode infrastructure + 2 surfaces). Tier 2/3 surfaces explicitly deferred.
- **Ambiguity:** "Hot-swap" is explicit (it's defined per surface in §7). "Visual indicator" is explicit (none). "Default" is explicit (`false`).
