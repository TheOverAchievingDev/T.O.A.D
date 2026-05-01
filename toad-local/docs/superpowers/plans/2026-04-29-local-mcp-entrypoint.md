# Local MCP Entrypoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free MCP-style request handler and stdio entrypoint that instantiate `LocalToadRuntime` and expose local tools.

**Architecture:** `src/mcp/localMcpServer.js` handles JSON-RPC-shaped requests for `initialize`, `tools/list`, and `tools/call`. `src/mcp/stdioServer.js` wires that handler to newline-delimited JSON over stdin/stdout for local smoke testing, leaving SDK adoption as a later transport-hardening step.

**Tech Stack:** Node.js ESM, `node:test`, existing `LocalToadRuntime`, local MCP tool definitions.

---

### Task 1: MCP Handler And Stdio Entrypoint

**Files:**
- Create: `src/mcp/localMcpServer.js`
- Create: `src/mcp/stdioServer.js`
- Create: `test/localMcpServer.test.js`
- Modify: `package.json`

- [x] **Step 1: Write failing tests**

Write tests proving `createLocalMcpHandler()` returns initialize metadata, lists local tools, calls `task_create` through `LocalToadRuntime`, and returns JSON-RPC errors for unknown methods.

- [x] **Step 2: Run tests to verify they fail**

Run: `node --no-warnings test/localMcpServer.test.js`

Expected: FAIL with missing module `src/mcp/localMcpServer.js`.

- [x] **Step 3: Implement handler and stdio entrypoint**

Implement `createLocalMcpHandler({ runtime, actor })`, `handleLocalMcpRequest(request, context)`, and a stdio script that reads newline-delimited JSON, calls the handler, and writes JSON responses.

- [x] **Step 4: Run targeted tests**

Run: `node --no-warnings test/localMcpServer.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
