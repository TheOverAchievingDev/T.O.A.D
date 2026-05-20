# Developer Mode Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `toad-local/docs/specs/2026-05-09-developer-mode-slice-1-design.md`

**Goal:** Ship Developer Mode toggle infrastructure plus the first two power-user surfaces (Tier 1) — restore the cockpit terminal/test bar gated behind the toggle, and flip the cockpit center-tab default to `code` when on.

**Architecture:** UI-only. New `developerMode: boolean` field on the existing `Tweaks` type; persisted via localStorage (existing `useTweaks` hook). The flag is **prop-drilled from App.tsx** to `CockpitScreen` and to `AdvancedSettings` (via `SettingsScreen`) — matches the existing pattern; `useTweaks` is called once in `App.tsx` so a duplicate hook would create duplicate state. The terminal/test bar removed in `b1ae19d` is restored from parent commit `e885afe` and conditionally rendered. CSS for the bar is restored under a `.cockpit-screen.dev-mode` class so the 2-row grid only kicks in when dev mode is on.

**Tech Stack:** React 18 + TypeScript (UI), no new runtime deps, no backend changes.

**Test discipline:** No automated UI tests today (matches existing project pattern). Verification is `cd ui && npx tsc --noEmit` after each task plus a manual smoke at the end. Backend `npm test` should remain unchanged throughout (no backend code is touched).

---

## Plan-vs-spec adjustment

The spec proposed a `useDeveloperMode.ts` hook over `useTweaks`. **The plan drops the hook** and prop-drills `developerMode: boolean` instead. Reason: `useTweaks` is called exactly once in `App.tsx:68` (the existing pattern); calling it again from `useDeveloperMode` would create a second isolated `useState` instance and dev mode would silently desync between mounted components. Prop-drilling matches how `tweaks.theme`, `tweaks.density`, etc. flow today.

---

## File structure

```
ui/src/types/index.ts                                    Task 1 — add developerMode field
ui/src/hooks/useTweaks.ts                                Task 1 — add to TWEAK_DEFAULTS
ui/src/components/settings/SettingsScreen.tsx            Task 2 — pass tweaks/setTweak to AdvancedSettings
ui/src/components/settings/AdvancedSettings.tsx          Tasks 2-3 — accept props + render toggle
ui/src/App.tsx                                            Task 4 — pass developerMode prop to CockpitScreen
ui/src/components/CockpitScreen.tsx                      Tasks 4-7 — accept prop, restore bar (gated), flip tab default
ui/src/styles/app-shell.css                              Task 6 — restore cockpit-bottom rules under .dev-mode
```

8 tasks total across 4 phases.

---

## Phase 1 — Type + default

### Task 1: Add `developerMode` to Tweaks type + defaults

**Files:**
- Modify: `ui/src/types/index.ts:169` (Tweaks interface)
- Modify: `ui/src/hooks/useTweaks.ts:7` (TWEAK_DEFAULTS const)

- [ ] **Step 1: Add the field to the Tweaks interface**

In `ui/src/types/index.ts`, find the `Tweaks` interface around line 169 and append the new field after `showTweaks: boolean;`:

```ts
export interface Tweaks {
  theme: 'dark' | 'light';
  density: 'comfy' | 'compact';
  layout: 'org' | 'chat' | 'kanban';
  cardVariant: 'detail' | 'compact' | 'terminal';
  screen:
    | 'cockpit'
    | 'workspace'
    | 'tasks'
    | 'settings'
    | 'foundry'
    | 'code'
    | 'costs'
    | 'audit'
    | 'drift'
    | 'picker'
    | 'empty'
    | 'onboarding'
    | 'create'
    | 'launching'
    | 'task';
  agentInbox: string;
  showProviders: boolean;
  showNotifs: boolean;
  showApprovals: boolean;
  showRuntimes: boolean;
  showDiagnostics: boolean;
  showTweaks: boolean;
  /** Developer mode opt-in — reveals power-user surfaces. Default false. */
  developerMode: boolean;
}
```

(Required field, not optional. Default-handling lives in `TWEAK_DEFAULTS`. The reader `tweaks.developerMode === true` still works when the persisted localStorage object lacks the key — `Partial<Tweaks>` merges with defaults at hook init.)

- [ ] **Step 2: Add the field to TWEAK_DEFAULTS**

In `ui/src/hooks/useTweaks.ts`, find the `TWEAK_DEFAULTS` const (around line 7) and append:

```ts
export const TWEAK_DEFAULTS: Tweaks = {
  theme: 'dark',
  density: 'comfy',
  layout: 'org',
  cardVariant: 'detail',
  screen: 'cockpit',
  agentInbox: '',
  showProviders: false,
  showNotifs: false,
  showApprovals: false,
  showRuntimes: false,
  showDiagnostics: false,
  showTweaks: false,
  developerMode: false,
};
```

- [ ] **Step 3: Type-check**

Run from the worktree:
```
cd ui && npx tsc --noEmit
```
Expected: clean (zero errors). The type extension is additive; nothing else needs to change yet.

- [ ] **Step 4: Commit**

```
git add ui/src/types/index.ts ui/src/hooks/useTweaks.ts
git commit -m "$(cat <<'EOF'
feat(ui): tweaks gain developerMode boolean (default false)

Foundation for the Developer Mode opt-in. UI-only toggle persisted
via localStorage (the existing useTweaks pipeline). No consumers
gate on it yet — that lands in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Settings toggle UI

### Task 2: Wire `tweaks` + `setTweak` through `SettingsScreen` → `AdvancedSettings`

**Files:**
- Modify: `ui/src/components/settings/SettingsScreen.tsx:35` (pass props)
- Modify: `ui/src/components/settings/AdvancedSettings.tsx` (accept props)

- [ ] **Step 1: Update SettingsScreen to pass props to AdvancedSettings**

In `ui/src/components/settings/SettingsScreen.tsx`, find line 35:
```tsx
{active === 'advanced' && <AdvancedSettings />}
```

Change to:
```tsx
{active === 'advanced' && <AdvancedSettings tweaks={tweaks} setTweak={setTweak} />}
```

- [ ] **Step 2: Update AdvancedSettings to accept the props**

In `ui/src/components/settings/AdvancedSettings.tsx`, find the `export function AdvancedSettings()` line (around line 35). Above it, add an interface, then update the function signature.

Add the imports at the top (alongside existing imports):
```tsx
import type { Tweaks } from '@/types';
import type { SetTweak } from '../TweaksPanel';
```

Replace `export function AdvancedSettings() {` with:
```tsx
interface AdvancedSettingsProps {
  tweaks: Tweaks;
  setTweak: SetTweak;
}

export function AdvancedSettings({ tweaks, setTweak }: AdvancedSettingsProps) {
```

(The function body is unchanged for now — we just plumb the props in. They get used in Task 3.)

- [ ] **Step 3: Type-check**

```
cd ui && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```
git add ui/src/components/settings/SettingsScreen.tsx ui/src/components/settings/AdvancedSettings.tsx
git commit -m "$(cat <<'EOF'
chore(ui): plumb tweaks + setTweak through to AdvancedSettings

Sets up Developer Mode toggle wiring. AdvancedSettings will use these
props in the next task to render the toggle row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Render the Developer Mode toggle in AdvancedSettings

**Files:**
- Modify: `ui/src/components/settings/AdvancedSettings.tsx` (add toggle card to the rendered JSX)

- [ ] **Step 1: Add the Developer Mode card**

In `ui/src/components/settings/AdvancedSettings.tsx`, find the `return (` block (around line 82) — specifically, find the `<SettingsSectionHeader` line and add a new `<SettingsCard>` block immediately AFTER `<SectionMeta draft={draft} />` and BEFORE the existing `"DB path override"` card:

```tsx
      <SettingsCard
        title="Developer mode"
        description="Reveals power-user surfaces: integrated terminal/test runner in cockpit, code-first cockpit default. More controls as future slices ship."
      >
        <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            id="developer-mode-toggle"
            type="checkbox"
            checked={tweaks.developerMode === true}
            onChange={(e) => setTweak('developerMode', e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          <label htmlFor="developer-mode-toggle" style={{ fontSize: 12 }}>
            {tweaks.developerMode ? 'Developer mode is ON' : 'Developer mode is OFF'}
          </label>
        </div>
      </SettingsCard>
```

The exact JSX is `<input type="checkbox">` styled inline rather than a custom toggle — matches `WorkspaceSettings.tsx`'s minimal pattern (no custom Switch component exists in this codebase).

- [ ] **Step 2: Type-check**

```
cd ui && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Manual smoke (optional but cheap)**

Boot the desktop app (`cd ui && npm run tauri:dev` from a separate shell), open Settings → Advanced, verify:
- The new "Developer mode" card renders at the top of the Advanced tab
- Toggling the checkbox updates the label text immediately
- Closing and reopening Settings preserves the toggle state (localStorage persistence)

- [ ] **Step 4: Commit**

```
git add ui/src/components/settings/AdvancedSettings.tsx
git commit -m "$(cat <<'EOF'
feat(ui): Settings → Advanced gets Developer Mode toggle row

Default off. State persists via the existing useTweaks localStorage
pipeline. No consumers yet — gated surfaces land in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Cockpit gating + bar restoration

### Task 4: Pass `developerMode` prop from App.tsx to CockpitScreen

**Files:**
- Modify: `ui/src/App.tsx` (around line 554-583, the `<CockpitScreen ... />` block)
- Modify: `ui/src/components/CockpitScreen.tsx` (accept the prop)

- [ ] **Step 1: Pass the prop in App.tsx**

In `ui/src/App.tsx`, find the `<CockpitScreen` JSX (around line 554) and add a new prop alongside the existing ones:

```tsx
<CockpitScreen
  team={team}
  tasks={tasks}
  runtimes={runtimes}
  // ... existing props ...
  developerMode={tweaks.developerMode === true}
  // ... rest of existing props ...
/>
```

Place the new prop near the top of the prop list for visibility (somewhere after `teamId` and before `actor` is fine).

- [ ] **Step 2: Accept the prop in CockpitScreen**

In `ui/src/components/CockpitScreen.tsx`, find the `interface CockpitScreenProps` (search for `interface CockpitScreenProps` — should be near the top of the file). Add:

```ts
  developerMode: boolean;
```

Then find the `export function CockpitScreen({ ... })` signature and destructure the new prop:

```tsx
export function CockpitScreen({
  // ... existing destructured props ...
  developerMode,
  // ... rest ...
}: CockpitScreenProps) {
```

(The exact placement in the destructure list doesn't matter; just keep it consistent — alphabetical or grouped with other booleans is fine.)

- [ ] **Step 3: Type-check**

```
cd ui && npx tsc --noEmit
```
Expected: clean. (You'll see no behavior change yet because nothing reads `developerMode` yet — that's the next task.)

- [ ] **Step 4: Commit**

```
git add ui/src/App.tsx ui/src/components/CockpitScreen.tsx
git commit -m "$(cat <<'EOF'
chore(ui): plumb developerMode prop into CockpitScreen

No behavior change — sets up the gating point for the terminal/test
bar restoration and center-tab flip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Restore the terminal/test bar in CockpitScreen (gated)

**Files:**
- Modify: `ui/src/components/CockpitScreen.tsx` (restore imports, state, handler, JSX — all gated on `developerMode`)

- [ ] **Step 1: Restore imports**

At the top of `ui/src/components/CockpitScreen.tsx`, find the imports. Update the `@/types` import to include `ValidationKind`:

```tsx
import type { Message, Runtime, Team, UiTask, ValidationKind, UiValidationRun } from '@/types';
```

Update the `cockpitValidation` import to include the bar's helpers:
```tsx
import {
  VALIDATION_KINDS,
  formatValidationDuration,
  formatValidationTime,
  sortValidationRuns,
  validationOutputLines,
  validationSummary,
} from './cockpitValidation';
```

(`formatValidationTime`, `sortValidationRuns`, `validationSummary` may already be there from existing code; just ensure all six are present.)

- [ ] **Step 2: Restore state hooks**

Find the `useState` block where `testRunning` is declared. Add three new state hooks alongside it:

```tsx
const [testRunning, setTestRunning] = useState(false);
const [terminalExpanded, setTerminalExpanded] = useState(false);
const [testMessage, setTestMessage] = useState<string | null>(null);
const [validationKind, setValidationKind] = useState<ValidationKind>('test');
```

- [ ] **Step 3: Restore derived values**

Find the `validationRuns` `useMemo` (it stays). Below it, before `reviewSummary`, add:

```tsx
const validationRuns = useMemo(
  () => sortValidationRuns(selectedTask?.validations ?? []),
  [selectedTask?.validations],
);
const latestValidation = validationRuns[0] ?? null;
const latestValidationOutput = validationOutputLines(latestValidation);
const selectedKindLatestValidation = selectedTask?.latestValidation?.[validationKind] ?? null;
```

(`validationRuns` is unchanged. `latestValidation`, `latestValidationOutput`, `selectedKindLatestValidation` are restored.)

- [ ] **Step 4: Restore the validation handler**

Find the existing simplified `runSelectedTaskValidation` function. Replace its body to use `validationKind` (instead of the hardcoded `'test'`) and re-add the inline status messages:

```tsx
async function runSelectedTaskValidation() {
  if (!selectedTask || testRunning) return;
  setTestRunning(true);
  setTestMessage(null);
  try {
    const result = await callTool<UiValidationRun>({
      actor,
      method: 'validation_run',
      idempotencyKey: `cockpit-validation-${selectedTask.id}-${validationKind}-${Date.now()}`,
      args: { taskId: selectedTask.id, kind: validationKind },
    });
    setTestMessage(`${validationKind} ${result.verdict ?? 'recorded'}${typeof result.exitCode === 'number' ? `, exit ${result.exitCode}` : ''}`);
    onRefreshData();
  } catch (err) {
    setTestMessage(err instanceof Error ? err.message : String(err));
  } finally {
    setTestRunning(false);
  }
}
```

- [ ] **Step 5: Wrap `<main>` with the dev-mode class**

Find the line:
```tsx
<main className="cockpit-screen">
```

Replace with:
```tsx
<main className={`cockpit-screen ${developerMode ? 'dev-mode' : ''} ${terminalExpanded ? 'terminal-expanded' : ''}`}>
```

- [ ] **Step 6: Restore the bar JSX (gated on `developerMode`)**

Find the closing `</aside>` of the right pane (the cockpit-right block). Immediately AFTER it and BEFORE the final `</main>`, add:

```tsx
{developerMode && (
  <section
    className={`cockpit-bottom ${terminalExpanded ? 'expanded' : 'collapsed'}`}
    aria-label="Integrated terminal and test runner"
  >
    <div className="cockpit-bottom-title">
      <Icon name="terminal" size={14} />
      <div>
        <strong>Terminal / Test Runner</strong>
        <span className="dim">
          {selectedTask ? `${selectedTask.id} · ${validationSummary(validationRuns)}` : 'No task selected'}
        </span>
      </div>
      <button
        className="btn btn-sm cockpit-terminal-toggle"
        type="button"
        onClick={() => setTerminalExpanded((expanded) => !expanded)}
      >
        <Icon name={terminalExpanded ? 'chevronDown' : 'chevronUp'} size={12} />
        {terminalExpanded ? 'Collapse' : 'Expand'}
      </button>
    </div>
    <div className="cockpit-terminal">
      <div className="cockpit-validation-bar">
        <select
          className="field-input mono cockpit-validation-kind"
          value={validationKind}
          onChange={(event) => setValidationKind(event.target.value as ValidationKind)}
          aria-label="Validation kind"
        >
          {VALIDATION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => void runSelectedTaskValidation()}
          disabled={!selectedTask || testRunning}
        >
          <Icon name="play" size={12} />
          {testRunning ? 'Running' : selectedKindLatestValidation ? 'Re-run' : 'Run'}
        </button>
        {testMessage && <span className="mono cockpit-test-message">{testMessage}</span>}
      </div>
      <div className="cockpit-validation-history" aria-label="Validation history">
        {validationRuns.length === 0 ? (
          <span className="dim">No validation runs yet.</span>
        ) : validationRuns.slice(0, 4).map((run) => (
          <span
            key={`${run.kind}-${run.createdAt ?? run.command ?? 'run'}`}
            className={`cockpit-validation-chip ${run.verdict}`}
          >
            {run.kind}
            <strong>{run.verdict}</strong>
            {formatValidationDuration(run.durationMs) && <em>{formatValidationDuration(run.durationMs)}</em>}
          </span>
        ))}
      </div>
      <pre className="cockpit-terminal-output">
        {latestValidation
          ? [
              `$ ${latestValidation.command ?? `${latestValidation.kind} command not configured`}`,
              `verdict=${latestValidation.verdict}${latestValidation.exitCode !== null ? ` exit=${latestValidation.exitCode}` : ''}${formatValidationTime(latestValidation.createdAt) ? ` at ${formatValidationTime(latestValidation.createdAt)}` : ''}`,
              ...latestValidationOutput.slice(0, 12),
              latestValidationOutput.length > 12 ? `... ${latestValidationOutput.length - 12} more lines` : '',
            ].filter(Boolean).join('\n')
          : 'Select a task and run a validation to see command output here.'}
      </pre>
    </div>
  </section>
)}
```

- [ ] **Step 7: Type-check**

```
cd ui && npx tsc --noEmit
```
Expected: clean. The bar JSX references state and helpers that are all imported/declared above; types should resolve.

(Note: the bar will look unstyled until Task 6 lands. That's fine — the JSX is correct; the CSS rules are separate.)

- [ ] **Step 8: Commit**

```
git add ui/src/components/CockpitScreen.tsx
git commit -m "$(cat <<'EOF'
feat(ui): restore cockpit terminal/test bar gated on developerMode

Recovers state, derived values, handler, and JSX from parent commit
e885afe. The whole bar is wrapped in {developerMode && (...)} so it's
hidden by default and revealed when the operator opts into Developer
Mode in Settings → Advanced.

The <main> className picks up a `dev-mode` class when on; CSS in the
next task uses that class to switch cockpit-screen from a 1-row to
2-row grid.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Restore CSS for the bar under `.cockpit-screen.dev-mode`

**Files:**
- Modify: `ui/src/styles/app-shell.css` (restore bar rules + scope grid changes to dev-mode class)

- [ ] **Step 1: Update `.cockpit-screen` to use the dev-mode class for the 2-row grid**

In `ui/src/styles/app-shell.css`, find the existing `.cockpit-screen` rule (around line 495). It currently has a single-row implicit grid. Add new rules immediately after it that re-introduce the 2-row layout ONLY when `.dev-mode` is also present:

```css
.cockpit-screen {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(420px, 1fr) minmax(280px, 360px);
  background: var(--bg);
  overflow: hidden;
}

.cockpit-screen.dev-mode {
  grid-template-rows: minmax(0, 1fr) 68px;
}

.cockpit-screen.dev-mode.terminal-expanded {
  grid-template-rows: minmax(0, 1fr) minmax(180px, 24vh);
}

.cockpit-screen.dev-mode .cockpit-left {
  grid-row: 1 / 3;
}

.cockpit-screen.dev-mode .cockpit-right {
  grid-row: 1;
}
```

The default (no `.dev-mode`) layout is the post-`b1ae19d` single-row grid that already works. The `.dev-mode` class additively introduces the 2-row layout.

- [ ] **Step 2: Restore the bar-specific CSS rules**

Locate the `.cockpit-validation-chip` rule (it stayed in the file because ReviewPane uses it). Insert the following BEFORE it (the rules are restored verbatim from `e885afe`, scoped via the new `.cockpit-screen.dev-mode` class so they don't cost anything when dev mode is off):

```css
.cockpit-screen.dev-mode .cockpit-bottom {
  grid-column: 2 / 4;
  grid-row: 2;
  border-top: 1px solid var(--border-soft);
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  align-items: stretch;
  gap: 12px;
  padding: 6px 14px;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
  background: var(--bg-panel);
  border-color: var(--border-soft);
}

.cockpit-screen.dev-mode .cockpit-bottom.collapsed {
  align-items: center;
}

.cockpit-screen.dev-mode .cockpit-bottom.collapsed .cockpit-terminal {
  grid-template-rows: 32px;
}

.cockpit-screen.dev-mode .cockpit-bottom.collapsed .cockpit-validation-history,
.cockpit-screen.dev-mode .cockpit-bottom.collapsed .cockpit-terminal-output {
  display: none;
}

.cockpit-screen.dev-mode .cockpit-bottom-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cockpit-screen.dev-mode .cockpit-bottom-title > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cockpit-screen.dev-mode .cockpit-bottom-title strong,
.cockpit-screen.dev-mode .cockpit-bottom-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cockpit-screen.dev-mode .cockpit-terminal-toggle {
  margin-left: auto;
  flex: 0 0 auto;
}

.cockpit-screen.dev-mode .cockpit-test-message {
  color: var(--fg-muted);
  font-size: 11px;
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cockpit-screen.dev-mode .cockpit-terminal {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 34%) minmax(0, 1fr);
  grid-template-rows: 32px minmax(0, 1fr);
  gap: 8px 10px;
}

.cockpit-screen.dev-mode .cockpit-validation-bar {
  grid-column: 1 / 3;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cockpit-screen.dev-mode .cockpit-validation-kind {
  width: 132px;
  height: 28px;
  font-size: 11px;
}

.cockpit-screen.dev-mode .cockpit-validation-history {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cockpit-screen.dev-mode .cockpit-terminal-output {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  margin: 0;
  border: 1px solid var(--border-soft);
  border-radius: 7px;
  background: var(--bg-canvas);
  color: var(--fg-muted);
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
}
```

- [ ] **Step 3: Restore the responsive override**

Find the existing `@media (max-width: 1180px)` block (the one that hides `.cockpit-right`). Update it to also handle the bar in dev mode:

```css
@media (max-width: 1180px) {
  .cockpit-screen {
    grid-template-columns: minmax(230px, 280px) minmax(420px, 1fr);
  }

  .cockpit-right {
    display: none;
  }

  .cockpit-screen.dev-mode .cockpit-bottom {
    grid-column: 2;
    grid-template-columns: 1fr;
  }

  .cockpit-screen.dev-mode .cockpit-bottom-title {
    display: none;
  }
}
```

- [ ] **Step 4: Type-check**

```
cd ui && npx tsc --noEmit
```
Expected: clean (CSS doesn't run through tsc, but the import paths in JSX should still resolve).

- [ ] **Step 5: Manual smoke**

Boot the app, open Settings → Advanced, toggle Developer Mode on. Open Cockpit. Verify:
- The Terminal / Test Runner bar appears at the bottom
- It has the correct visual treatment (border, padding, kind dropdown, Run button, output panel)
- Toggling Expand/Collapse on the bar works
- Toggling Developer Mode off in Settings → Advanced makes the bar disappear and the cockpit reflows to a single-row grid (no clipping, no empty space at the bottom)

- [ ] **Step 6: Commit**

```
git add ui/src/styles/app-shell.css
git commit -m "$(cat <<'EOF'
feat(ui): restore cockpit-bottom CSS scoped under .dev-mode

All cockpit-bottom*, cockpit-terminal*, cockpit-validation-bar/kind/
history, cockpit-terminal-output, and cockpit-test-message rules are
restored from e885afe, prefixed with .cockpit-screen.dev-mode so they
only take effect when Developer Mode is on. The 2-row grid on
.cockpit-screen also kicks in only under .dev-mode.

The default cockpit layout (single-row grid, no bottom bar) is
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Flip Cockpit center-tab default based on `developerMode`

**Files:**
- Modify: `ui/src/components/CockpitScreen.tsx` (change the `centerTab` initial value)

- [ ] **Step 1: Update the centerTab initializer**

In `ui/src/components/CockpitScreen.tsx`, find the line:
```tsx
const [centerTab, setCenterTab] = useState<CenterTab>('flow');
```

(It's around line 96 in the post-`b1ae19d` file.)

Change to:
```tsx
const [centerTab, setCenterTab] = useState<CenterTab>(developerMode ? 'code' : 'flow');
```

This is the entire change. `useState`'s initializer runs once at mount, so the flip applies on first mount and any future remount. Mid-session toggling does NOT change an already-mounted CockpitScreen's `centerTab` — that's intentional per the spec (§7 hot-swap semantics).

- [ ] **Step 2: Type-check**

```
cd ui && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Manual smoke**

Boot the app:
- Toggle Developer Mode OFF in Settings → Advanced. Close and reopen Cockpit (e.g., navigate to Tasks then back). Confirm the center pane lands on **Flow**.
- Toggle Developer Mode ON. Close and reopen Cockpit. Confirm the center pane lands on **Code**.
- Mid-session toggle test: start with Developer Mode off and Cockpit on Flow. Toggle Developer Mode on without leaving Cockpit. The bar should appear (Surface 1), but the center tab should remain on Flow until next remount. This is the expected behavior.

- [ ] **Step 4: Commit**

```
git add ui/src/components/CockpitScreen.tsx
git commit -m "$(cat <<'EOF'
feat(ui): cockpit center-tab default flips to 'code' in developer mode

Captured at mount via the useState initializer — flipping Developer
Mode mid-session does not retroactively change the active tab. That
duality is intentional: the bar appears/disappears in real time
because it's pure JSX gating, while the default-tab is a "what should
I land on" decision only meaningful at landing time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Verification

### Task 8: Final smoke + ship-note commit

**Files:** none modified; this is a verification + housekeeping task.

- [ ] **Step 1: Confirm full UI typecheck and backend tests**

```
cd ui && npx tsc --noEmit
```
Expected: clean.

```
cd .. && npm test 2>&1 | tail -10
```
Expected: same green pass count as before this slice (no backend changes, so no regressions). If anything fails, investigate before proceeding.

- [ ] **Step 2: Full manual end-to-end**

Boot the desktop app fresh (`cd ui && npm run tauri:dev`). Walk through:

1. **Default off:** App starts with Developer Mode off. Cockpit defaults to Flow tab. No bottom terminal bar. Single-row grid layout.
2. **Toggle on:** Settings → Advanced → Developer Mode toggle to ON. Confirm:
   - The toggle's label updates to "Developer mode is ON"
   - Switch back to Cockpit (via SidebarNav or whatever)
   - **First-mount behavior:** if you navigated AWAY from Cockpit and back, the center tab is now Code by default
   - **Same-mount behavior:** if you stayed on Cockpit, the center tab is whatever it was, but the bottom bar has appeared
3. **Bar interaction:** Click the Expand/Collapse toggle on the bar — it should grow/shrink. Hit Run with no task selected — button is disabled. Select a task, hit Run — validation fires (or fails gracefully if no command configured). Output panel updates.
4. **Toggle off:** Toggle Developer Mode OFF. The bar disappears, Cockpit reflows to single-row grid (no clipping at bottom). On next Cockpit mount, center tab defaults to Flow.
5. **Persistence:** Close and reopen the app. The Developer Mode toggle state is preserved (localStorage at key `toad.tweaks`).

If any of these fail, investigate.

- [ ] **Step 3: Empty ship-note commit**

```
git commit --allow-empty -m "$(cat <<'EOF'
ship(ui): developer mode slice 1 — toggle + cockpit terminal bar + tab flip

Vision 1 of FUTURE-IDEAS.md's developer-mode framing.

8 tasks across 4 phases:
- Phase 1 (type): Tweaks gains developerMode boolean
- Phase 2 (settings): toggle in Settings → Advanced
- Phase 3 (cockpit): restore terminal/test bar gated on developerMode,
  restore CSS scoped under .cockpit-screen.dev-mode, flip center-tab
  default based on developerMode
- Phase 4 (verify): full smoke + commit

UI-only. Zero backend changes. Zero regressions in npm test (no
backend code touched). Recovered terminal/test bar verbatim from
parent commit e885afe; cockpit base layout (post-b1ae19d single-row
grid) is unchanged when dev mode is off.

Tier 2 surfaces (raw tool input toggle, per-role model picker) and
Tier 3 surfaces (hunk-level diffs, raw event log, cost-per-call,
keybindings, prompt override, Foundry raw editor) deferred to
follow-up slices, gated as they ship.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**1. Spec coverage:**

| Spec section | Implemented in task |
|---|---|
| §1 architecture | Task 1 (type), Task 2 (settings wiring), Task 4 (cockpit wiring), Tasks 5-7 (cockpit gating) |
| §2 the hook | **Replaced with prop-drilling** — see plan-vs-spec adjustment at top |
| §3 Tweaks type extension | Task 1 |
| §4 Settings toggle | Tasks 2-3 |
| §5 Surface 1 (terminal bar restoration) | Tasks 5-6 |
| §6 Surface 2 (center-tab flip) | Task 7 |
| §7 Hot-swap semantics | Honored: bar gating is real-time JSX (Task 5); centerTab is mount-time only (Task 7); CSS is real-time (Task 6) |
| §8 UI changes summary | Tasks 1-7 cover all listed files |
| §9 Testing | Task 8 |
| §10 Risks | Mitigations live in Task 8 smoke |
| §11 Module layout | Tasks map 1:1 to listed files |

All spec requirements have a task. The hook (§2) is consciously dropped per plan-vs-spec adjustment.

**2. Placeholder scan:** None. All tasks include actual code blocks where they change code; no "TBD" / "implement appropriate behavior" / "similar to X" placeholders.

**3. Type consistency:**
- `developerMode: boolean` — same name, same type, same defaults (`false`) across `Tweaks` interface (Task 1), `TWEAK_DEFAULTS` (Task 1), `CockpitScreenProps` (Task 4), App.tsx prop pass (Task 4), and `tweaks.developerMode === true` reads (Tasks 3, 4).
- `setTweak('developerMode', value)` signature uses the existing `<K extends keyof Tweaks>` generic — type-safe.
- The CSS `.dev-mode` class name is consistent across Tasks 5 (className application) and 6 (CSS rules).
- The `.cockpit-screen.terminal-expanded` modifier remains spelled identically in JSX (Task 5) and CSS (Task 6).

No issues. Ready for execution.
