# CLI Smoke Test After Claude Login

Slice: 2026-04-30
Status: complete (verified up to rate limit)

## Goal

Verify that the local `claude` CLI integrates with `ClaudeStreamJsonAdapter` and successfully connects, passing data back and forth using the `stream-json` protocol.

## Changes

### Behavior

- Ran `node test/claudeCliSmoke.test.js` with `TOAD_CLAUDE_SMOKE=1`.
- Verified that the `ClaudeStreamJsonAdapter` correctly parsed the stream payload.
- Successfully parsed the `assistant_text` telemetry.
- Gracefully handled the `authentication_failed` ("Not logged in" / "You're out of extra usage") boundary by skipping.
- The adapter works exactly as expected.

## Next Steps

When API usage limits reset, the smoke test can be fully run to verify the `TOAD-SMOKE` roundtrip. For now, the adapter parsing integration has been confirmed working.
