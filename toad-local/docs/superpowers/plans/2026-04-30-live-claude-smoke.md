# Live Claude CLI Smoke

Slice: 2026-04-30
Status: complete

## Goal

Until this slice, `test/claudeCliSmoke.test.js` had been verified only up to the CLI boundary — every prior run hit `authentication_failed` and skipped cleanly. With the user's local Claude CLI now authenticated, run the smoke against a real authenticated turn and confirm the stream-json adapter handles a complete request → response cycle end-to-end.

## Diagnosis

The harness was using `--bare`. That flag puts the CLI into a stripped-down headless mode whose auth path requires an Anthropic API key (or non-subscription OAuth). It does **not** consume the Claude Code subscription OAuth that the interactive `claude` session uses on this machine.

Direct manual call without `--bare` returns the assistant text correctly using the same subscription auth that the interactive CLI already has. None of TOAD's production code uses `--bare` — it was a holdover that the smoke inherited from the legacy reference app.

## Change

`test/claudeCliSmoke.test.js`:

- Drop `--bare` from the spawned CLI args.
- Add a one-line comment explaining the rationale so a future agent doesn't reintroduce it without thinking.
- The auth-failure skip heuristics stay as-is — they still correctly detect a real "Not logged in" response if the user's standalone CLI auth lapses.

## Quota note

Without `--bare`, the spawned CLI loads the full plugin / skill / hook system prompt. Each smoke run consumes around **334k cache-creation tokens** against the user's account.

The CLI prints `total_cost_usd: 2.09` in the `result` event — that figure is an API-equivalent estimate, **not** a charge against a subscription user. On a Claude Pro / Max / Team plan, the smoke run consumes quota (rate-limit / context budget) rather than dollars; the dollar number is informational and applies only when calling via the Anthropic API directly.

Either way the run is non-trivial usage, so the smoke should be triggered intentionally — when validating the adapter against a new CLI version, after material adapter changes, or after long pauses in development. The harness only runs when `TOAD_CLAUDE_SMOKE=1` is explicitly set, so accidental triggers are unlikely.

## Verification

Manual command before the slice change reproduced the auth-skip path:

```powershell
$env:TOAD_CLAUDE_SMOKE='1'
$env:CLAUDE_BIN='C:\Users\Nova_\.local\bin\claude.exe'
node --no-warnings test\claudeCliSmoke.test.js
# Output: ok 1 ... # SKIP Claude CLI is not authenticated locally
```

After dropping `--bare`, the same command produces a real `assistant_text` event whose `text` is exactly `TOAD-SMOKE`, the smoke prompt's required reply.

## Out Of Scope

- Caching the smoke result so subsequent CI-style runs do not re-pay the cache-creation token cost.
- A cheaper `--bare`-and-API-key variant of the smoke for users who do have an Anthropic API key. Could be added with a guard like `if (process.env.ANTHROPIC_API_KEY) { /* use --bare */ }`.
- Asserting on the `result` summary event in addition to `assistant_text`. Current assertion is sufficient.
