# UI Cross-Team Chat Design

## Goal

Add a compact cross-team inbox/chat panel to the dashboard so an operator can inspect cross-team message history and send a cross-team message without leaving the local UI.

## Approach

Use the existing broker/read-model/facade pattern. Add a read-only `cross_team_messages` command that projects cross-team rows from `LocalReadModel.listTeamChat()`. Keep the existing mutating `cross_team_send` command as the send path.

## Backend Scope

- Add `LocalReadModel.listCrossTeamMessages({ teamId, limit })`.
- Filter rows where `metadata.source` is `cross_team` or `cross_team_sent`.
- Parse and strip the cross-team metadata prefix for display.
- Return UI-ready rows with `direction`, `sourceTeamId`, `targetTeamId`, `targetAgentId`, `conversationId`, `replyToConversationId`, `text`, `createdAt`, and raw message metadata.
- Add read-only `COMMANDS.CROSS_TEAM_MESSAGES` and MCP tool definition.
- Route `LocalToolFacade` to the new read model method.

## UI Scope

- Add a Cross-Team panel to the dashboard.
- Fetch `cross_team_messages` with the main dashboard data.
- Show a conversation list grouped by conversation id.
- Show the selected conversation thread.
- Add a compose form for target team, target agent, conversation id, and text.
- Sending calls `cross_team_send` with a stable UI idempotency key, then refreshes the panel.

## Non-Goals

- No team directory, autocomplete, auth, or remote transport hardening.
- No rich message editor.
- No separate route/page.

## Testing

- Read-model tests cover projection, prefix stripping, direction, and filtering out ordinary chat rows.
- Facade/MCP tests cover read-only command exposure and call adaptation.
- UI verification uses existing Vite lint/build checks.
- Full backend regression remains `npm.cmd test`.
