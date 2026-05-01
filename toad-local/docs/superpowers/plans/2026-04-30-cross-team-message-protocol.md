# Cross-Team Message Protocol

Slice: 2026-04-30
Status: complete

## Goal

Port the cross-team message prefix protocol from the legacy `crossTeam.ts`
shared constants module. This establishes the wire format that allows agents in
one team to send messages to agents in another team.

## Legacy Finding

Cross-team messages use an XML-like metadata prefix prepended to the message
body:

```
<cross-team from="team-a.lead" depth="0" conversationId="abc" replyToConversationId="def" />
Hello from team-a.
```

Key attributes:
- `from` — source agent identifier (`teamId.agentId`)
- `depth` — chain depth for forwarded messages (prevents infinite loops)
- `conversationId` — correlation for the cross-team conversation
- `replyToConversationId` — reference to the conversation being replied to

Source discriminators:
- `cross_team` — incoming cross-team message (written to target team's inbox)
- `cross_team_sent` — outgoing copy (written to sender team's inbox)

## Changes

### New files

- `src/protocol/crossTeam.js` — cross-team message prefix format, parse, strip,
  and source discriminator constants. Direct port from the legacy TypeScript.

### New test files

- `test/crossTeam.test.js` — 12 tests covering: prefix formatting with all
  attribute combinations, escaping/unescaping, text formatting, prefix parsing,
  null handling for non-cross-team text, prefix stripping, and source constants.

## Test command

```powershell
npm.cmd test
```

All 22 test files pass.
