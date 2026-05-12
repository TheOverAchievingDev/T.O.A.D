import type { ReactNode } from 'react';
import { Icon } from '../Icon';

/**
 * Phase 2 BottomPanel — Cursor-style tabbed panel at the bottom of
 * the WITH-me Cockpit. Replaces the cramped strip the user flagged.
 *
 * Tabs (top-aligned, 30px row):
 *   - Terminal      (default; shell sessions when wired in Phase 3)
 *   - Problems      (lint / typecheck diagnostics from the editor)
 *   - Output        (recent agent tool-call streams)
 *   - Validations   (test / lint / build runners)
 *
 * The tabs row also carries quick-action icons on the right (new
 * terminal, split, clear, close) and the close button that flips
 * tweaks.showBottomPanel to false. Resize is owned by the parent
 * PaneSplitter — this component just renders its content within the
 * height it's given.
 *
 * Each tab's content arrives via a slot prop so the parent can wire
 * any rendering (a real Terminal, the existing validation runner,
 * etc.) without this component knowing what's inside. Slots default
 * to a small empty-state when undefined so Phase 2 ships even when
 * Phase 3 hasn't wired Terminal etc. yet.
 *
 * `View → Toggle Bottom Panel` (Ctrl+J) flips the parent's
 * tweaks.showBottomPanel; that boolean controls whether this
 * component is rendered at all. There's no "collapsed-but-rendered"
 * state — Phase 2 keeps the model simple (rendered or not).
 */

export type BottomPanelTab = 'terminal' | 'problems' | 'output' | 'validations';

export interface BottomPanelProps {
  activeTab: BottomPanelTab;
  onChangeTab: (tab: BottomPanelTab) => void;
  onClose: () => void;

  /** Optional counts rendered next to each tab name. e.g. Problems "2". */
  problemCount?: number;
  outputCount?: number;

  /** Tab-content slots. Undefined falls back to empty-state. */
  terminalSlot?: ReactNode;
  problemsSlot?: ReactNode;
  outputSlot?: ReactNode;
  validationsSlot?: ReactNode;

  /** Optional action handlers in the tabs-row toolbar. */
  onNewTerminal?: () => void;
  onSplitTerminal?: () => void;
  onClear?: () => void;
}

interface TabSpec {
  id: BottomPanelTab;
  label: string;
  count?: number;
}

export function BottomPanel({
  activeTab,
  onChangeTab,
  onClose,
  problemCount,
  outputCount,
  terminalSlot,
  problemsSlot,
  outputSlot,
  validationsSlot,
  onNewTerminal,
  onSplitTerminal,
  onClear,
}: BottomPanelProps) {
  const tabs: TabSpec[] = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'problems', label: 'Problems', count: problemCount },
    { id: 'output', label: 'Output', count: outputCount },
    { id: 'validations', label: 'Validations' },
  ];

  const renderTabBody = (): ReactNode => {
    switch (activeTab) {
      case 'terminal':
        return terminalSlot ?? <EmptyState label="Terminal" hint="No active terminal session." />;
      case 'problems':
        return problemsSlot ?? <EmptyState label="Problems" hint="No diagnostics from the active editor." />;
      case 'output':
        return outputSlot ?? <EmptyState label="Output" hint="No recent agent tool calls." />;
      case 'validations':
        return validationsSlot ?? <EmptyState label="Validations" hint="Run a validation from Run → Run Validations on Active Task." />;
    }
  };

  return (
    <div className="bottom-panel" role="region" aria-label="Bottom panel">
      <div className="bp-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="bp-tab"
            data-active={tab.id === activeTab || undefined}
            onClick={() => onChangeTab(tab.id)}
          >
            <span>{tab.label}</span>
            {typeof tab.count === 'number' && tab.count > 0 && (
              <span className="count">{tab.count}</span>
            )}
          </button>
        ))}
        <div className="bp-tools">
          {onNewTerminal && (
            <button
              type="button"
              className="icon-btn"
              title="New terminal"
              onClick={onNewTerminal}
            >
              <Icon name="plus" size={13} />
            </button>
          )}
          {onSplitTerminal && (
            <button
              type="button"
              className="icon-btn"
              title="Split terminal"
              onClick={onSplitTerminal}
            >
              <Icon name="drag" size={13} />
            </button>
          )}
          {onClear && (
            <button
              type="button"
              className="icon-btn"
              title="Clear"
              onClick={onClear}
            >
              <Icon name="refresh" size={13} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Close panel (Ctrl+J)"
            onClick={onClose}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      <div className="bp-body">
        {renderTabBody()}
      </div>
    </div>
  );
}

function EmptyState({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="bp-empty">
      <div className="bp-empty-label">{label}</div>
      <div className="bp-empty-hint">{hint}</div>
    </div>
  );
}
