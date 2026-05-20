# Phase 3 — Embedded Terminal (Cursor-style)

**Status**: In progress  
**Started**: 2026-05-19

## Summary

Replace the non-functional terminal stubs (menu items, bottom panel tab) with a real embedded terminal like Cursor/VS Code. Uses xterm.js in the React UI + WebSocket bridge to a node-pty shell process in the Node sidecar.

## Architecture

```
┌─ Browser (React UI) ─────────────────────────────────────┐
│  TerminalPane.tsx                                         │
│    └── xterm.js Terminal (renders output, captures input) │
│         └── WebSocket ws://127.0.0.1:3001/terminal        │
└───────────────────────────────────────────────────────────┘
                           │ WebSocket
                           ▼
┌─ Node Sidecar ───────────────────────────────────────────┐
│  apiServer.js → /terminal upgrade handler                │
│    └── TerminalSession                                   │
│         └── node-pty spawns shell (cmd/pwsh/bash/zsh)    │
│              stdin ← WebSocket messages (input)          │
│              stdout → WebSocket messages (output)        │
└──────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|---|---|
| `ui/package.json` | Add `@xterm/xterm` + `@xterm/addon-fit` |
| `ui/src/components/cockpit/TerminalPane.tsx` | xterm.js React wrapper |
| `src/transport/terminalSession.js` | node-pty bridge (spawns shell, bridges WS↔PTY) |
| `src/transport/apiServer.js` | Add `/terminal` WebSocket upgrade route |
| `ui/src/components/cockpit/BottomPanel.tsx` | Wire `terminalSlot` |
| `ui/src/components/cockpit/CockpitWithMe.tsx` | Pass `terminalSlot` |
| `ui/src/components/Menubar.tsx` | Add `terminal:new` action |
| `ui/src/App.tsx` | Handle `terminal:new` action |

## Implementation Steps

1. Install xterm.js packages
2. Create `TerminalSession` backend (node-pty bridge)
3. Add WebSocket `/terminal` endpoint to API server
4. Create `TerminalPane` React component
5. Wire into BottomPanel / CockpitWithMe
6. Wire menu actions (new terminal, kill terminal)
7. Wire bottom panel toolbar buttons
8. Test

