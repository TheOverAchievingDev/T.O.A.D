# First-Run Onboarding (Zero-Config Dive-In) — Design

**Date:** 2026-05-09
**Slice:** Item #3 of post-Foundry-F.1 roadmap
**Audience:** "Bouncer-givers-up" — non-developers who've been burned by AI tools (Claude Code, Cursor) bouncing off complexity. They need a different on-ramp than the hooked-strugglers Symphony serves today.

---

## Goal

The first time a user opens Symphony, they land directly in a Foundry chat with a welcoming empty-state banner — no wizard, no welcome screen, no provider picker, no folder picker. Setup gates trigger just-in-time, only when the user's action requires them.

Returning users see whatever screen they last had open (existing behavior preserved).

## Non-goals

- Not redesigning the Foundry chat UI itself.
- Not changing how Foundry generates docs or materializes teams.
- Not changing the existing project-picker flow for users who *do* have projects.
- Not building a separate "tutorial" or "tour" — the empty-state banner is the entire onboarding surface.

---

## Architecture

Three coordinated changes across the existing screen-routing layer:

1. **A new persisted `firstRunComplete: boolean` tweak** (defaults `false`) tracks whether the user has engaged with Symphony at all.
2. **First-run users land on Foundry** instead of the project-picker, bypassing the existing "no projects → picker" redirect.
3. **The Foundry empty state grows a welcome banner** that explains Symphony in two sentences and prompts the user to start describing what they want to build. The banner dismisses on either: sending the first message, or clicking "Dismiss." Either action flips `firstRunComplete` to `true`.

The existing `OnboardingScreen.tsx` (321 LOC, 4-step wizard targeting the wrong audience) is deleted along with the `'onboarding'` value of the `screen` tweak. JIT provider-auth and folder-pick gates are deferred to a follow-up slice — the existing folder-pick-on-materialize flow already covers folder JIT, and provider auth is gated by the existing ProvidersModal which the user can hit naturally.

## Components

### 1. `Tweaks` type + defaults — `ui/src/types/index.ts` and `ui/src/hooks/useTweaks.ts`

Add a new boolean field to the `Tweaks` interface:

```ts
/** First-run flag — false until the user sends their first Foundry
 *  message or dismisses the welcome banner. Used to route first-run
 *  users directly to Foundry instead of the project picker. */
firstRunComplete: boolean;
```

Default in `TWEAK_DEFAULTS`:

```ts
firstRunComplete: false,
```

The existing `'onboarding'` value is removed from the `screen` union since `OnboardingScreen` is going away. (See Component 5 below.)

### 2. First-run routing — `ui/src/App.tsx`

The existing first-run redirect (lines 257-261) routes empty-registry users to `'picker'`. New logic intercepts that for first-run users and routes them to `'foundry'` instead:

```ts
// First-run UX: brand-new users land directly in Foundry chat, not
// the project picker. The empty-state banner inside Foundry handles
// the welcome. Once firstRunComplete flips, the existing picker-
// redirect takes over for users who delete all their projects.
useEffect(() => {
  if (!tweaks.firstRunComplete && projectRegistry.projects.length === 0) {
    if (tweaks.screen !== 'foundry' && tweaks.screen !== 'settings') {
      setTweak('screen', 'foundry');
    }
    return;
  }
  // Existing picker redirect — only fires for returning users with
  // an empty registry (e.g. they deleted all their projects).
  if (projectRegistry.projects.length === 0 && tweaks.screen !== 'picker' && tweaks.screen !== 'create' && tweaks.screen !== 'settings' && tweaks.screen !== 'foundry' && tweaks.screen !== 'code' && tweaks.screen !== 'drift') {
    setTweak('screen', 'picker');
  }
}, [projectRegistry.projects.length, tweaks.screen, tweaks.firstRunComplete, setTweak]);
```

Settings stays an allowed escape hatch so a first-run user who hits ⌘, can still see settings without bouncing back to Foundry on every render.

### 3. Welcome banner — `ui/src/components/FoundryScreen.tsx`

When `firstRunComplete === false`, the Foundry chat pane renders a dismissible welcome card *above* the existing message thread. The card replaces (or sits above) the current `<div className="foundry-empty">Select or create a plan</div>` placeholder.

Card content (literal copy):

> **Welcome to Symphony.**
> Tell me what you want to build, and a team of AI agents will plan, code, and ship it. Start with one sentence — "a meal planner for picky eaters," "a habit tracker for my partner," whatever. I'll ask follow-ups.
>
> [Dismiss]

The card is rendered conditionally: visible iff `!firstRunComplete && (no active session OR no messages yet)`. Once a session exists with at least one message, the banner stays hidden even if `firstRunComplete` is still false (the user has clearly engaged).

The component takes two new props:

```ts
interface FoundryScreenProps {
  // ... existing props
  /** When false, renders a welcome banner above the chat thread.
   *  Flips to true on banner dismiss or first message sent. */
  firstRun?: boolean;
  /** Called when the user dismisses the banner OR sends their first
   *  message. Parent flips tweaks.firstRunComplete in response. */
  onFirstRunDismiss?: () => void;
}
```

`App.tsx` passes `firstRun={!tweaks.firstRunComplete}` and `onFirstRunDismiss={() => setTweak('firstRunComplete', true)}`.

The component calls `onFirstRunDismiss?.()` in two places:
- The Dismiss button's onClick.
- Inside `sendChatTurn()` *after* a successful `foundry_chat_turn` call returns (so the flag flips after the first message succeeds).

If a session needs to be auto-created when the user types their first message into a brand-new install (no `activeSessionId`), we synthesize one by calling `foundry_session_create` with title `'My first project'` before sending the message. This is necessary because the existing flow requires the user to click "New" in the sidebar — which a first-run user wouldn't know to do. (See Section "Auto-session-on-first-message" below.)

### 4. Auto-session-on-first-message — `ui/src/components/FoundryScreen.tsx`

Currently, `sendChatTurn()` early-returns if `!activeSessionId`. For first-run users, we need to auto-create a session when they type their first message and click Send.

Modified `sendChatTurn()`:

```ts
async function sendChatTurn() {
  if (!message.trim()) return;

  let sessionId = activeSessionId;
  // First-run auto-session: if the user is sending a message but no
  // session exists yet, create one inline. This keeps the empty-state
  // banner free of "click New first" friction.
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
  // First successful message — bouncer is past the bounce.
  onFirstRunDismiss?.();
}
```

### 5. Delete `OnboardingScreen.tsx` and the `'onboarding'` screen value

The existing 4-step wizard targets the wrong audience and is unreachable except via the dev Tweaks panel. We delete:
- `ui/src/components/OnboardingScreen.tsx` (file)
- The `'onboarding'` value from the `Tweaks.screen` union in `types/index.ts`
- The `import { OnboardingScreen }` line in `App.tsx`
- The `{tweaks.screen === 'onboarding' && <OnboardingScreen ... />}` block in `App.tsx`
- The `tweaks.screen === 'onboarding'` term in the `isOverlayScreen` expression in `App.tsx`
- The `'onboarding'` option in `App.tsx`'s TweaksPanel `<TweakSelect label="Screen">` options array
- The `'onboarding'` option in `TweaksPanel.tsx`'s screen `<TweakSelect>` options array
- The `useCommandActions.ts` action that routes to `'onboarding'`

If anything else references the `'onboarding'` value, the TypeScript compiler will flag it during the type narrowing — that's the safety net.

### 6. JIT gates — out of scope for this slice

**Provider auth:** Already implicitly JIT — the `foundry_chat_turn` call fails server-side if no Claude provider is configured, surfacing an error in the existing error banner. The user can click into Settings → Providers from there. A polished inline-modal version of this is a future improvement, not blocking this slice.

**Folder pick:** Already JIT in `FoundryScreen.materializeProject()` — when `!hasActiveProject`, the folder picker pops before materialize runs. No changes needed.

---

## Data flow

```
First open
  └─> App.tsx mounts
        └─> useTweaks() reads localStorage; firstRunComplete = false (default)
              └─> first-run effect fires: setTweak('screen', 'foundry')
                    └─> FoundryScreen renders with firstRun={true}
                          └─> No sessions yet; banner shows above empty thread

User types "a recipe app for picky kids" + Send
  └─> sendChatTurn() with !activeSessionId
        └─> auto-creates "My first project" session
              └─> sends chat turn
                    └─> success → onFirstRunDismiss() → setTweak('firstRunComplete', true)
                          └─> banner hides on next render

Returning user (firstRunComplete = true)
  └─> useTweaks reads localStorage; firstRunComplete = true
        └─> first-run effect skips Foundry redirect
              └─> existing screen-routing takes over (last-stored screen)
                    └─> banner hidden in FoundryScreen even when visited
```

## Error handling

- **Provider not configured:** `foundry_chat_turn` fails with an API error. Existing `formatError` + error banner already handle this; the user sees "no provider configured" or similar and can navigate to Settings → Providers.
- **localStorage write fails:** Existing `useTweaks` swallows quota errors. `firstRunComplete` would stay false; the user would see the welcome banner on every reload until storage works again. Acceptable — the worst case is a slightly noisy welcome.
- **Sidecar offline on first run:** Existing error banner shows "API not reachable." User can wait/retry. The welcome card stays visible (correctly — they haven't engaged yet).

## Testing

The UI codebase does not have a test framework configured (no vitest, no jest, no @testing-library — see `ui/package.json`). Backend has full TDD coverage; UI ships with `npm run typecheck` + `npm run lint` + manual smoke tests. This slice follows the existing UI convention rather than expanding scope to set up vitest.

**TypeScript safety net** — Removing the `'onboarding'` value from the `Tweaks.screen` union forces the compiler to flag every reference. The build will fail if any cleanup is missed.

**Lint safety net** — `npm run lint` catches unused imports (e.g., the removed `OnboardingScreen` import) and unused variables.

**Manual smoke tests** (documented as plan steps):

1. **Fresh-install path:** wipe localStorage, reload, verify the app lands on Foundry with the welcome banner visible. Type "a recipe app for picky kids" + click Send. Verify: a session is auto-created, the message sends, the banner disappears, and `localStorage['toad.tweaks']` contains `firstRunComplete: true`.

2. **Banner-dismiss path:** wipe localStorage, reload, click Dismiss without sending a message. Verify the banner disappears, no session is created, `firstRunComplete: true` is persisted, and reloading does not bring the banner back.

3. **Returning-user path:** with `firstRunComplete: true` and an empty project registry, reload. Verify the existing picker redirect fires (lands on `'picker'`).

4. **Settings escape hatch:** with `firstRunComplete: false`, navigate to settings. Verify the first-run effect doesn't yank the user back to Foundry.

5. **Provider-failure path:** with no Claude provider configured, send the first message. Verify the existing error banner shows the API failure and `firstRunComplete` does NOT flip (since the message didn't actually succeed).

**Future work:** A separate slice can introduce vitest + @testing-library/react for the UI tier. That's a project-wide infrastructure decision, not blocking on this slice.

---

## What this slice does NOT change

- Backend (Node sidecar) — zero changes. Foundry session/message APIs unchanged.
- SQLite schema — zero changes.
- Existing Foundry doc-generation, materialization, team-launch flows — unchanged.
- Existing project-picker for returning users with empty registries — unchanged.
- Sidebar/titlebar/command-palette navigation — unchanged.
- Provider auth flow — unchanged (deferred to a future "polished JIT gates" slice).

## Future work this slice unblocks

- **Polished JIT provider modal** — when first message fails with "no provider," show an inline auth modal instead of a generic error.
- **Banner copy A/B** — once we have telemetry, test alternate welcome copy for engagement.
- **Empty-state suggestion chips** — "Try: 'a meal planner for picky kids' · 'a habit tracker' · 'a recipe collection'" pre-fill on click.
- **Returning-user empty-state** — different copy for users who *have* completed first-run but happen to land in Foundry with no active session.
