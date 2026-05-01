# MCP Tool Definitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing local command facade as MCP-style tool metadata and a small call adapter.

**Architecture:** Add `src/mcp/localToolDefinitions.js` with tool definitions shaped as `{ name, title, description, inputSchema, annotations }`, following the MCP tool fields documented in the 2025-06-18 server/tools spec. Keep execution separate from transport by adapting MCP `arguments` into the existing `LocalToolFacade.execute()` command shape.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema-shaped input schemas, existing `LocalToolFacade`.

---

### Task 1: Tool Metadata And Call Adapter

**Files:**
- Create: `src/mcp/localToolDefinitions.js`
- Create: `test/localMcpToolDefinitions.test.js`
- Modify: `package.json`

- [x] **Step 1: Write failing tests**

Write tests proving that the exported tools include `message_send`, `task_create`, `task_update`, `task_comment`, and `task_list`; every tool has an object `inputSchema`; mutating tools require `idempotencyKey`; and `callLocalTool()` passes commands to the local facade and returns MCP text content.

- [x] **Step 2: Run tests to verify they fail**

Run: `node test/localMcpToolDefinitions.test.js`

Expected: FAIL with missing module `src/mcp/localToolDefinitions.js`.

- [x] **Step 3: Implement metadata and call adapter**

Create `LOCAL_MCP_TOOLS`, `listLocalMcpTools()`, `getLocalMcpTool(name)`, and `callLocalMcpTool({ toolFacade, actor, name, arguments: args })`. The call adapter should require `idempotencyKey` in arguments for mutating commands, pass the remaining fields as command args, and return `{ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }`.

- [x] **Step 4: Run targeted tests**

Run: `node test/localMcpToolDefinitions.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
