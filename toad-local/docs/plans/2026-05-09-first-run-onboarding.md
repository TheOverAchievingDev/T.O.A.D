# First-Run Onboarding (Zero-Config Dive-In) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a brand-new Symphony user land directly in a Foundry chat with a welcome banner — no wizard, no provider modal, no folder picker. Banner dismisses on first message sent OR explicit "Dismiss" click. Returning users keep their existing experience.

**Architecture:** UI-only slice. Add `firstRunComplete: boolean` to the `Tweaks` type, gate the existing first-run redirect on it (route to Foundry instead of picker), add a welcome banner to `FoundryScreen` that auto-creates a session on first message, and delete the dead 4-step `OnboardingScreen`. Backend, SQLite, and Foundry session APIs are unchanged.

**Tech Stack:** TypeScript, React 18, Vite. UI tier has no test framework — typecheck + lint + manual smoke is the safety net.

**Spec:** `docs/specs/2026-05-09-first-run-onboarding-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `ui/src/types/index.ts` | Modify | Add `firstRunComplete: boolean` to `Tweaks`; remove `'onboarding'` from `screen` union |
| `ui/src/hooks/useTweaks.ts` | Modify | Add `firstRunComplete: false` to `TWEAK_DEFAULTS` |
| `ui/src/App.tsx` | Modify | First-run redirect: route to `'foundry'` when `!firstRunComplete`; remove `OnboardingScreen` import + render block + screen-select option |
| `ui/src/components/FoundryScreen.tsx` | Modify | Add `firstRun` + `onFirstRunDismiss` props; render welcome banner; auto-create session in `sendChatTurn` |
| `ui/src/components/OnboardingScreen.tsx` | Delete | 321 LOC dead-code 4-step wizard targeting wrong audience |
| `ui/src/components/TweaksPanel.tsx` | Modify | Remove `'onboarding'` option from screen `<TweakSelect>` |
| `ui/src/hooks/useCommandActions.ts` | Modify | Remove command palette action that routes to `'onboarding'` |

---

## Pre-flight: Verify clean baseline

- [ ] **Step P.1: Run typecheck on the UI**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: PASS (no TS errors). If errors exist before this slice, stop and surface them — don't bake them into the work.

- [ ] **Step P.2: Run lint on the UI**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run lint`
Expected: PASS. If lint warnings exist before this slice, snapshot the count so we can compare after.

- [ ] **Step P.3: Confirm git is clean**

Run: `git -C C:/Project-TOAD/toad-local status --short`
Expected: Clean (or only the spec we just committed; no other tracked changes).

---

## Task 1: Add `firstRunComplete` to the Tweaks type and defaults

**Files:**
- Modify: `ui/src/types/index.ts:169-199`
- Modify: `ui/src/hooks/useTweaks.ts:6-20`

- [ ] **Step 1.1: Add `firstRunComplete` field to the `Tweaks` interface**

Edit `ui/src/types/index.ts`. After the `developerMode: boolean;` line (~line 198), add:

```ts
  /** First-run flag — false until the user sends their first Foundry
   *  message or dismisses the welcome banner. Persisted in localStorage
   *  via useTweaks. Used by App.tsx to route brand-new users directly
   *  to Foundry chat instead of the project picker. */
  firstRunComplete: boolean;
```

- [ ] **Step 1.2: Remove `'onboarding'` from the screen union in `types/index.ts`**

In the same file, the `screen` union (~lines 174-189) currently contains `| 'onboarding'`. Delete that line. The dead `OnboardingScreen` component is going away in Task 5; this lets the compiler flag any remaining references.

- [ ] **Step 1.3: Add `firstRunComplete` default to `TWEAK_DEFAULTS`**

Edit `ui/src/hooks/useTweaks.ts:6-20`. After `developerMode: false,` add:

```ts
  firstRunComplete: false,
```

- [ ] **Step 1.4: Run typecheck**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: TypeScript errors at every site that referenced `screen === 'onboarding'` or routed to `'onboarding'`. This is intentional — the compiler is showing us the work for Task 5. Do not fix these errors yet.

- [ ] **Step 1.5: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/types/index.ts ui/src/hooks/useTweaks.ts
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(onboarding): add firstRunComplete tweak; drop 'onboarding' screen

Adds the first-run gate to the Tweaks contract. Default false so brand-
new installs trigger the welcome flow. Removing 'onboarding' from the
screen union surfaces every remaining reference to the dead screen via
the typechecker — those get cleaned up in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: First-run routing in App.tsx

**Files:**
- Modify: `ui/src/App.tsx:254-261` (the existing first-run useEffect)

- [ ] **Step 2.1: Replace the existing first-run effect**

Find the block in `ui/src/App.tsx` that currently looks like:

```ts
  // First-run UX: when no project has been opened yet, force the picker
  // screen. Without this the user lands on the workspace with no real
  // data and no obvious "where do I start" affordance.
  useEffect(() => {
    if (projectRegistry.projects.length === 0 && tweaks.screen !== 'picker' && tweaks.screen !== 'create' && tweaks.screen !== 'settings' && tweaks.screen !== 'foundry' && tweaks.screen !== 'code' && tweaks.screen !== 'drift') {
      setTweak('screen', 'picker');
    }
  }, [projectRegistry.projects.length, tweaks.screen, setTweak]);
```

Replace with:

```ts
  // First-run UX: brand-new users (firstRunComplete === false) land
  // directly in Foundry chat with a welcome banner — no project picker,
  // no wizard. Once they engage (send a message OR dismiss the banner),
  // firstRunComplete flips and the existing picker redirect takes over
  // for users who delete all their projects later.
  useEffect(() => {
    if (!tweaks.firstRunComplete && projectRegistry.projects.length === 0) {
      // Settings is an allowed escape hatch so a first-run user who
      // opens settings doesn't get yanked back to Foundry on every render.
      if (tweaks.screen !== 'foundry' && tweaks.screen !== 'settings') {
        setTweak('screen', 'foundry');
      }
      return;
    }
    if (projectRegistry.projects.length === 0 && tweaks.screen !== 'picker' && tweaks.screen !== 'create' && tweaks.screen !== 'settings' && tweaks.screen !== 'foundry' && tweaks.screen !== 'code' && tweaks.screen !== 'drift') {
      setTweak('screen', 'picker');
    }
  }, [projectRegistry.projects.length, tweaks.screen, tweaks.firstRunComplete, setTweak]);
```

Note the `tweaks.firstRunComplete` added to the dependency array.

- [ ] **Step 2.2: Run typecheck**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: Same errors as before (still about removed `'onboarding'`). No new errors.

- [ ] **Step 2.3: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/App.tsx
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(onboarding): route first-run users to Foundry instead of picker

When firstRunComplete is false and no projects exist, redirect to the
Foundry screen so the welcome banner can render. Settings stays an
allowed target so users hitting settings before completing first-run
don't get bounced. Returning users with empty registries fall through
to the existing picker redirect unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add welcome banner + auto-session to FoundryScreen

**Files:**
- Modify: `ui/src/components/FoundryScreen.tsx:75-94` (props interface)
- Modify: `ui/src/components/FoundryScreen.tsx:102-114` (component signature + destructure)
- Modify: `ui/src/components/FoundryScreen.tsx:225-242` (`sendChatTurn`)
- Modify: `ui/src/components/FoundryScreen.tsx:420-433` (the `foundry-thread` empty state)

- [ ] **Step 3.1: Add new props to `FoundryScreenProps`**

Find the `FoundryScreenProps` interface (~line 75). After the `onMaterialized?: (teamId: string) => void;` line, add:

```ts
  /** When true, the Foundry chat shows a first-run welcome banner
   *  above the thread. Flips off after the user dismisses or sends
   *  their first message. */
  firstRun?: boolean;
  /** Called when the user dismisses the welcome banner OR sends
   *  their first chat turn successfully. Parent flips
   *  tweaks.firstRunComplete in response. */
  onFirstRunDismiss?: () => void;
```

- [ ] **Step 3.2: Destructure new props in the component**

Find the component signature (~line 102). Update the destructure block:

```ts
export function FoundryScreen({
  teamId,
  hasActiveProject = true,
  onPickProjectFolder,
  onMaterializePlan,
  onMaterialized,
  firstRun = false,
  onFirstRunDismiss,
}: FoundryScreenProps) {
```

- [ ] **Step 3.3: Update `sendChatTurn` to auto-create session and signal first-run dismiss**

Replace the existing `sendChatTurn` function (~line 225) with:

```ts
  async function sendChatTurn() {
    if (!message.trim()) return;

    // First-run auto-session: when the user is sending a message but
    // no session exists yet (brand-new install), create one inline so
    // the welcome banner doesn't need to nag the user to click "New".
    let sessionId = activeSessionId;
    if (!sessionId) {
      const created = await runAction('create', () =>
        callTool<FoundrySessionSummary>({
          actor,
          method: 'foundry_session_create',
          idempotencyKey: makeId('foundry-session'),
          args: { title: 'My first project' },
        })
      );
      if (!created) return;
      sessionId = created.sessionId;
      setActiveSessionId(sessionId);
      await loadSessions();
    }

    const added = await runAction('message', () =>
      callTool<{ assistant: FoundryMessage }>({
        actor,
        method: 'foundry_chat_turn',
        idempotencyKey: makeId('foundry-chat'),
        args: { sessionId, text: message.trim() },
      })
    );
    if (!added) return;
    setMessage('');
    await loadSessions();
    await loadDetail(sessionId);
    // First message landed — the user has clearly engaged. Flip the
    // first-run flag so the welcome banner stays gone going forward.
    onFirstRunDismiss?.();
  }
```

- [ ] **Step 3.4: Render the welcome banner above the empty thread**

Find the existing `foundry-thread` empty state (~line 420):

```tsx
        <div className="foundry-thread">
          {!detail && (
            <div className="foundry-empty">
              <Icon name="sparkle" size={22} />
              <h3>Select or create a plan</h3>
            </div>
          )}
          {detail?.messages.map(...)}
        </div>
```

Replace with:

```tsx
        <div className="foundry-thread">
          {firstRun && (!detail || detail.messages.length === 0) && (
            <div className="foundry-welcome">
              <h3>Welcome to Symphony.</h3>
              <p>
                Tell me what you want to build, and a team of AI agents will plan,
                code, and ship it. Start with one sentence — "a meal planner for
                picky eaters," "a habit tracker for my partner," whatever. I'll
                ask follow-ups.
              </p>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onFirstRunDismiss?.()}
              >
                Dismiss
              </button>
            </div>
          )}
          {!firstRun && !detail && (
            <div className="foundry-empty">
              <Icon name="sparkle" size={22} />
              <h3>Select or create a plan</h3>
            </div>
          )}
          {detail?.messages.map((item) => (
            <div key={item.messageId} className={`foundry-message ${item.role}`}>
              <div className="foundry-message-meta">{item.role}</div>
              <FoundryMessageBody text={item.text} />
            </div>
          ))}
        </div>
```

- [ ] **Step 3.5: Add `.foundry-welcome` styles**

The Foundry styles live in `ui/src/styles/app-shell.css`. The `.foundry-empty` selector is around line 258. Add the new selector immediately after the existing `.foundry-empty` rules:

```css
.foundry-welcome {
  margin: 24px;
  padding: 20px 24px;
  border: 1px solid var(--border, oklch(0.25 0.02 240));
  border-radius: 10px;
  background: var(--bg-elev, oklch(0.18 0.02 240));
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 640px;
}

.foundry-welcome h3 {
  margin: 0;
  font-size: 16px;
  color: var(--fg, oklch(0.92 0.02 240));
}

.foundry-welcome p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg-dim, oklch(0.72 0.02 240));
}

.foundry-welcome .btn {
  align-self: flex-start;
}
```

(Adjust the CSS variable names to match the project's existing tokens — confirm by reading 5-10 lines around an existing `var(--bg-elev)` or similar reference in the same file.)

- [ ] **Step 3.6: Wire props in App.tsx**

In `ui/src/App.tsx`, find the `<FoundryScreen ... />` JSX block (~line 502). Add two props:

```tsx
          {tweaks.screen === 'foundry' && (
            <FoundryScreen
              teamId={team.name || activeTeamId || 'foundry'}
              hasActiveProject={projectRegistry.activeId !== null}
              firstRun={!tweaks.firstRunComplete}
              onFirstRunDismiss={() => setTweak('firstRunComplete', true)}
              onPickProjectFolder={async () => {
                // ... existing handler unchanged
```

- [ ] **Step 3.7: Run typecheck**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: Same `'onboarding'` errors as before, no new errors. The new props are optional with defaults, so consumers that don't pass them still typecheck.

- [ ] **Step 3.8: Commit**

```bash
git -C C:/Project-TOAD/toad-local add ui/src/components/FoundryScreen.tsx ui/src/App.tsx ui/src/styles/
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
feat(onboarding): welcome banner + auto-session in FoundryScreen

Adds firstRun + onFirstRunDismiss props. When firstRun is true and the
thread is empty, shows a welcome card above the message list. The card
dismisses on Dismiss click or after the first chat turn lands. Also
auto-creates a 'My first project' session if the user hits Send before
clicking 'New' — eliminates the friction of forcing brand-new users to
discover the sidebar before they can start.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Delete `OnboardingScreen.tsx` and clean up references

**Files:**
- Delete: `ui/src/components/OnboardingScreen.tsx`
- Modify: `ui/src/App.tsx` (import + render block + isOverlayScreen + TweaksPanel screen options)
- Modify: `ui/src/components/TweaksPanel.tsx` (screen `<TweakSelect>` options)
- Modify: `ui/src/hooks/useCommandActions.ts` (command palette action)

- [ ] **Step 4.1: Delete the OnboardingScreen file**

```bash
rm "C:/Project-TOAD/toad-local/ui/src/components/OnboardingScreen.tsx"
```

- [ ] **Step 4.2: Remove the import in App.tsx**

In `ui/src/App.tsx`, delete the line:

```ts
import { OnboardingScreen } from '@/components/OnboardingScreen';
```

- [ ] **Step 4.3: Remove the render block in App.tsx**

In `ui/src/App.tsx`, find and delete:

```tsx
          {tweaks.screen === 'onboarding' && (
            <OnboardingScreen onDone={() => setTweak('screen', 'cockpit')} />
          )}
```

- [ ] **Step 4.4: Remove `'onboarding'` from `isOverlayScreen` in App.tsx**

Find the `isOverlayScreen` expression (~line 411):

```ts
  const isOverlayScreen =
    tweaks.screen === 'empty' ||
    tweaks.screen === 'onboarding' ||
    tweaks.screen === 'picker';
```

Replace with:

```ts
  const isOverlayScreen =
    tweaks.screen === 'empty' ||
    tweaks.screen === 'picker';
```

- [ ] **Step 4.5: Remove `'onboarding'` from the App.tsx TweaksPanel screen options**

Find the TweaksPanel `<TweakSelect label="Screen">` block in `ui/src/App.tsx` (~lines 904-924). Delete the line:

```tsx
                { value: 'onboarding', label: 'Onboarding' },
```

- [ ] **Step 4.6: Remove `'onboarding'` from TweaksPanel.tsx**

In `ui/src/components/TweaksPanel.tsx`, search for `onboarding`. Remove any `{ value: 'onboarding', label: ... }` entry from the screen-select options array.

- [ ] **Step 4.7: Remove the `'onboarding'` command-palette action**

In `ui/src/hooks/useCommandActions.ts`, search for `'onboarding'`. Remove the action that routes to it (the `setTweak('screen', 'onboarding')` line and its surrounding object literal).

- [ ] **Step 4.8: Run typecheck**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: PASS. Every reference to `'onboarding'` has been removed.

- [ ] **Step 4.9: Run lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run lint`
Expected: PASS, with no new warnings vs. the pre-flight baseline. (Likely fewer — we deleted unused imports.)

- [ ] **Step 4.10: Commit**

```bash
git -C C:/Project-TOAD/toad-local add -A ui/src/
git -C C:/Project-TOAD/toad-local commit -m "$(cat <<'EOF'
refactor(onboarding): delete dead OnboardingScreen wizard

The 4-step Vision-1 wizard targeted the wrong audience (asks the user
to configure providers, workspace, team templates upfront — the
opposite of zero-config dive-in). Reachable only via dev tools, never
auto-triggered. Removing it cleans up 321 LOC and the 'onboarding'
screen union member.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Manual smoke tests

The UI tier has no test framework — these are the gates before declaring done.

- [ ] **Step 5.1: Build the dev sidecar + UI**

Run: `cd C:/Project-TOAD/toad-local && npm run dev` (or whatever the project's dev command is — confirm by reading `toad-local/package.json` scripts).

Open the app in a browser at the dev URL.

- [ ] **Step 5.2: Smoke test — fresh install path**

In DevTools console: `localStorage.removeItem('toad.tweaks')` then reload.

Expected:
- App lands on the Foundry screen (not picker, not cockpit).
- A welcome card is visible above the chat input with the "Welcome to Symphony" copy.
- The right-side artifacts panel shows "0 files."

Type `a recipe app for picky kids` in the message textarea. Click Send.

Expected:
- A new session titled "My first project" appears in the left sidebar and becomes active.
- The user message + assistant reply appear in the thread.
- The welcome banner disappears.
- DevTools: `JSON.parse(localStorage.getItem('toad.tweaks'))` shows `firstRunComplete: true`.

- [ ] **Step 5.3: Smoke test — banner-dismiss path**

`localStorage.removeItem('toad.tweaks')` then reload.

Expected: Banner visible.

Click "Dismiss" on the banner without typing anything.

Expected:
- Banner disappears.
- No session is created (left sidebar still shows "No plans yet").
- `localStorage` shows `firstRunComplete: true`.
- Reloading the page does NOT bring the banner back.

- [ ] **Step 5.4: Smoke test — returning user with no projects**

In DevTools console:
```js
const tweaks = JSON.parse(localStorage.getItem('toad.tweaks') || '{}');
tweaks.firstRunComplete = true;
tweaks.screen = 'cockpit';
localStorage.setItem('toad.tweaks', JSON.stringify(tweaks));
localStorage.removeItem('toad.projects'); // or whatever the project registry key is
```
Reload.

Expected: Lands on the project picker (existing behavior preserved). Welcome banner is NOT shown if the user navigates to Foundry from the picker.

- [ ] **Step 5.5: Smoke test — settings escape hatch**

`localStorage.removeItem('toad.tweaks')` then reload (lands on Foundry, banner visible). Click the gear/Settings nav item.

Expected: Lands on Settings. The first-run effect does NOT bounce the user back to Foundry.

- [ ] **Step 5.6: Smoke test — provider failure path**

Without a Claude provider configured (verify via Settings → Providers), wipe localStorage, reload, type a message, click Send.

Expected:
- An error banner shows the API failure (existing behavior).
- `firstRunComplete` does NOT flip to true (the message didn't succeed; the dismiss-on-success path was bypassed).
- Welcome banner still visible.

- [ ] **Step 5.7: Document smoke test results**

If all six smoke tests pass, the slice is done. If any fail, file the failure as a concrete fix and re-run the relevant test.

---

## Task 6: Final verification + ship

- [ ] **Step 6.1: Run typecheck once more from clean state**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: PASS.

- [ ] **Step 6.2: Run lint**

Run: `cd C:/Project-TOAD/toad-local/ui && npm run lint`
Expected: PASS, no new warnings vs. pre-flight baseline.

- [ ] **Step 6.3: Confirm git is clean and all commits landed on main**

Run: `git -C C:/Project-TOAD/toad-local log --oneline -10`
Expected: 4-5 new commits (Task 1, 2, 3, 4 commits) above `e30c267 docs(onboarding): spec...`.

- [ ] **Step 6.4: Update FUTURE-IDEAS.md if needed**

If smoke tests surfaced any "we should improve this later" items, append them to the appropriate section of `docs/FUTURE-IDEAS.md` (e.g., suggestion chips, polished JIT auth modal, vitest setup). Skip if nothing came up.

- [ ] **Step 6.5: Optional ship marker commit**

If desired, add a single ship-marker commit summarizing the slice (mirrors the F.1 pattern with `6acecc1 ship(foundry): ...`):

```bash
git -C C:/Project-TOAD/toad-local commit --allow-empty -m "$(cat <<'EOF'
ship(onboarding): first-run zero-config dive-in landed

Brand-new Symphony users now land directly in Foundry chat with a
welcome banner — no wizard, no provider modal, no folder picker.
Banner dismisses on first message sent OR explicit click. The dead
4-step OnboardingScreen wizard is deleted (321 LOC). Bouncer-givers-up
audience is now the path of least resistance.

Closes Item #3 of the post-Foundry-F.1 roadmap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist (run before declaring plan done)

- [x] Spec coverage: every architecture component (1-6 in spec) has a corresponding task or explicit out-of-scope note.
- [x] No placeholders: every step shows the actual code/command, not "implement X."
- [x] Type consistency: `firstRunComplete` is the same name across spec, types, defaults, props, and effect deps. `onFirstRunDismiss` is the same name in props and JSX.
- [x] Order is correct: types/defaults first, routing second, banner third, deletion last (compiler-driven cleanup).
- [x] Manual smoke is documented because UI has no test framework — explicit and not hand-waved.
- [x] Each task ends with a commit so the history is granular and revertible.
