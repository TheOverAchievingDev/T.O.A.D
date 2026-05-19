# TOAD Future Features & Enhancements

This document outlines four high-impact features that would elevate TOAD from a powerful orchestration engine into a true, autonomous, and bulletproof "software factory." 

For each feature, this document details the conceptual gap it fills, along with a concrete strategy for how we would spec, implement, and test it in the TOAD architecture.

---

## 1. True Sandboxed Execution (Docker / Firecracker)

### Concept
Currently, TOAD agents execute terminal commands (`validations:run`, `npm install`, test scripts) directly on the host OS via the local tool facade. Even with `allowedFiles`/`forbiddenFiles` and the Secret Redactor, a rogue or hallucinating agent could run destructive commands or leak workspace environment variables. True sandboxing ensures 100% containment.

### Plan & Spec
*   **Architecture Decision Record (ADR):** Evaluate containerization options. Docker CLI wrappers are easiest to start with, but WebContainers (for Node-centric projects) or Firecracker microVMs provide tighter isolation.
*   **Data Flow Spec:** Define how the workspace is mounted (e.g., volume mounts vs. rsyncing to an ephemeral container), how stdout/stderr is streamed back to the `RuntimeEventBus`, and how we handle networking/port-forwarding if an agent starts a dev server.

### Implementation Approach
1.  **Sandbox Adapter:** Introduce an `IsolatedToolFacade` that implements the same interface as `LocalToolFacade`.
2.  **Container Lifecycle:** Hook into `team_launch` and `team:pause` to spin up/down an ephemeral Docker container for the team.
3.  **Path Translation:** Ensure file paths sent in tool requests (e.g., `view_file`, `replace_file_content`) are safely mapped between the host OS workspace and the container's isolated mount path.
4.  **Graceful Degradation:** Allow a "local mode" fallback in the UI Settings for users who don't have Docker installed.

### Testing Strategy
*   **Unit/Integration:** Mock the Docker CLI interface; test that commands sent to the `IsolatedToolFacade` correctly formulate `docker exec` commands.
*   **Security Bounds Testing:** Create a "malicious agent" test fixture that attempts to `cd /` or `cat /etc/passwd` or `rm -rf` outside the mounted project directory, asserting that the host file system remains untouched.
*   **E2E:** Run a full Drift / UI test via the Sandbox Adapter to ensure real-time terminal streaming isn't buffered or delayed by the container layer.

---

## 2. Proactive Codebase Indexing (Semantic RAG)

### Concept
Agents currently discover code by running `grep` or iterating through directories, which is slow, context-heavy, and prone to hallucination. A built-in semantic index would allow TOAD to proactively inject relevant architecture context, type definitions, and file references into an agent's prompt *before* they even start working on a task.

### Plan & Spec
*   **Vector Store Spec:** Choose a lightweight local vector store (e.g., `sqlite-vss` or a simple in-memory FAISS equivalent in JS) to avoid external database dependencies.
*   **Chunking Strategy:** Spec how we parse ASTs (using Tree-sitter) to chunk code by functions/classes rather than arbitrary line counts, ensuring semantic meaning is preserved.
*   **Index Lifecycle:** Define when the index updates (e.g., synchronously on `replace_file_content` vs. a background sweep on file save).

### Implementation Approach
1.  **Local Indexer:** Build an ingest pipeline that walks the `allowedFiles` contract, hashes files to detect changes, chunks the code, and generates embeddings (using a local lightweight embedding model or via provider APIs).
2.  **RAG Injector:** Modify the orchestrator's task assignment step. When an agent picks up a task, the system automatically performs a vector search against the task description and appends a `<context>` block to their `systemPrompt`.
3.  **UI Exposure:** Add an "Indexing..." status indicator to the TOAD UI (perhaps in the Titlebar or Settings panel) so the human knows when the semantic map is up to date.

### Testing Strategy
*   **Unit Tests:** Verify the chunking logic correctly splits complex TypeScript and React files without breaking AST nodes.
*   **Recall Tests:** Feed the indexer a known repository, run 10 sample task descriptions through the semantic search, and assert that the top 3 results contain the required files.
*   **Performance Profiling:** Ensure the background indexing thread does not block the main Node.js event loop or cause UI stutter during rapid agent file modifications.

---

## 3. Automated Rollbacks on Validation Failure (Self-Healing)

### Concept
When `validations:run` fails, the agent is left in a broken workspace state and forced to manually untangle their own mess. An automated "Checkpoint & Revert" mechanism would automatically restore the codebase to the last known good state upon catastrophic failure, providing the agent with the failed diff as a learning mechanism rather than a persisting obstacle.

### Plan & Spec
*   **Checkpoint Trigger:** Spec exactly *when* to checkpoint (e.g., immediately before an agent executes a multi-file `replace_file_content` batch).
*   **Rollback Threshold:** Define what constitutes a "catastrophic" failure (e.g., compile errors vs. a single failing test) and when the automatic rollback should fire (e.g., after 2 `consecutiveTestFailures`).

### Implementation Approach
1.  **Hidden Git Branches:** Utilize Git. Before agent modifications, execute `git commit -m "toad-auto-checkpoint" --allow-empty`.
2.  **Validation Middleware:** Intercept the `VALIDATION_RUN` event. If the verdict is `failed` and the threshold is met, trigger a `git reset --hard HEAD` and `git clean -fd`.
3.  **Feedback Loop:** Synthesize a new task comment back to the agent: "Your last change failed validation with the following errors. The workspace has been rolled back. Review the diff you attempted and try a new approach."

### Testing Strategy
*   **Integration Tests:** Set up a temporary Git repo. Have a mock agent make a syntax error, trigger a validation, and assert that the file contents revert to their original state.
*   **State Machine Verification:** Ensure that the task state correctly reflects the rollback (e.g., no orphaned `diff` data is shown in the UI if the rollback occurred).

---

## 4. Interactive TTY / Prompt Forwarding

### Concept
Agent shell commands frequently fail or hang indefinitely if a script unexpectedly asks for human input (e.g., "Do you want to continue? [Y/n]"). TOAD needs a pseudo-terminal (PTY) bridge to surface these interactive prompts directly to the human operator or the Lead Agent.

### Plan & Spec
*   **PTY Engine:** Spec the replacement of Node's standard `child_process.spawn` with `node-pty` to trick commands into believing they are running in an interactive terminal.
*   **Stall Detection:** Define heuristics for detecting a blocked process (e.g., no stdout for 10 seconds while the process is still running, ending with a question mark or bracketed prompt).

### Implementation Approach
1.  **PTY Integration:** Swap out the execution layer in the `localToolFacade` to use `node-pty`.
2.  **UI Event Streaming:** When a process hangs on an interactive prompt, emit an `INTERACTIVE_PROMPT_WAITING` event to the `RuntimeEventBus`.
3.  **UI Input Field:** Surface a temporary input field in the TaskDetailModal or Terminal overlay that allows the user to type "Y" or "N", which is then piped directly into the PTY's `stdin`.

### Testing Strategy
*   **Mock Interactive Scripts:** Write a simple Node script that uses `readline` to ask a question. Have an agent execute it.
*   **Stall Detection Tests:** Assert that the facade correctly emits the waiting event after the specified heuristic timeout.
*   **Stdin Piping:** Programmatically feed a response into the simulated `stdin` and assert that the script completes successfully and the final exit code is captured by the task history.
