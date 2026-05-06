# IDE Phase 2 Slice F: Drift & Agent Overlays

This implementation plan outlines the architecture for delivering **Slice F** of the Orchestrator IDE. We will integrate the Orchestrator's intelligence—specifically the Drift Engine findings and Agent Runtime statuses—directly into the `CodeScreen` editing surface. 

This bridges the gap between the task state and the code editor, allowing human reviewers to see exactly where drift occurs in the code and whether an agent is actively mutating the worktree they are viewing.

## User Review Required

> [!IMPORTANT]  
> Please review the approach below for the Drift Gutter Markers and Agent Overlays. If this aligns with your vision for Slice F, please approve so I can begin execution!
> Note: Full terminal integration (xterm.js) and LSP diagnostics are deferred to future phases (as noted in the North Star doc), so this slice focuses purely on Orchestrator-native intelligence (Drift + Agents).

## Proposed Changes

---

### [MODIFY] `ui/src/App.tsx`
- Update the `<CodeScreen />` instantiation to pass down `drift.data` and `runtimes`. This gives the IDE access to the live system drift state and agent lifecycles.

### [MODIFY] `ui/src/components/CodeScreen.tsx`
- **Drift Gutter Markers & Squigglies**:
  - Accept the new `driftData` and `runtimes` props.
  - Implement an effect that watches the `activeTab.path` and `driftData.findings`. 
  - Parse the `evidence` arrays of all findings to match the current file and extract line numbers (e.g., matching `src/utils.js:45`).
  - Use `monaco.editor.IStandaloneCodeEditor.deltaDecorations` to inject visual squigglies (`className: 'drift-squiggly'`) and gutter glyphs (`glyphMarginClassName: 'drift-glyph'`) directly onto the editor lines.
  - Include Hover Messages in the decoration payload so developers can hover over the squiggly to read the drift `title`, `actual` state, and `severity`.
- **Agent Activity Overlay**:
  - Detect when the user is viewing a task worktree (`sourceKey.startsWith('task:')`).
  - Check the `runtimes` array to see if any agent is currently `running` on that specific task.
  - If an agent is active, render a subtle, non-blocking floating banner at the top of the editor pane (e.g., "🤖 Lead Agent is currently active in this worktree") to alert the human that files might change underneath them.

### [MODIFY] `ui/src/styles/app-shell.css`
- Add CSS classes for the Monaco decorations:
  - `.drift-squiggly`: A customized underline (e.g., red wavy/dashed border) to highlight problematic code.
  - `.drift-glyph`: A warning/error indicator positioned in the Monaco editor margin.

## Verification Plan

### Automated Tests
- Run `npm run typecheck` and `npm run build` to ensure the new props and Monaco decorator interfaces compile correctly.

### Manual Verification
- View a task worktree that has active Drift findings. Open the offending file and verify the squiggly line and hover tooltip appear correctly.
- Launch an agent on a task and view that task's worktree in the IDE to verify the active agent banner appears.
