import { useEffect } from 'react';
import { Icon } from './Icon';

interface ShortcutEntry {
  keys: string[];
  description: string;
  context?: string;
}

interface ShortcutGroup {
  label: string;
  entries: ShortcutEntry[];
}

const GROUPS: ShortcutGroup[] = [
  {
    label: 'Navigation',
    entries: [
      { keys: ['⌘', 'K'], description: 'Open the command palette' },
      { keys: ['Ctrl', 'K'], description: 'Open the command palette (Windows/Linux)' },
      { keys: ['Ctrl', '/'], description: 'Open the command palette (alt — for terminals that swallow Ctrl+K)' },
      { keys: ['?'], description: 'Show this shortcuts panel', context: 'When no input is focused' },
    ],
  },
  {
    label: 'Screens',
    entries: [
      { keys: ['⌘', '1'], description: 'Cockpit' },
      { keys: ['⌘', '2'], description: 'Foundry' },
      { keys: ['⌘', '3'], description: 'Code' },
      { keys: ['⌘', '4'], description: 'Tasks' },
      { keys: ['⌘', '5'], description: 'Drift' },
      { keys: ['⌘', '6'], description: 'Costs' },
      { keys: ['⌘', '7'], description: 'Audit' },
      { keys: ['⌘', ','], description: 'Settings' },
    ],
  },
  {
    label: 'Panels',
    entries: [
      { keys: ['⌘', 'B'], description: 'Toggle sidebar' },
      { keys: ['⌘', 'J'], description: 'Toggle bottom panel' },
      { keys: ['⌘', '⌥', 'I'], description: 'Toggle agent inbox (right panel)' },
    ],
  },
  {
    label: 'Team',
    entries: [
      { keys: ['F5'], description: 'Start / Resume team' },
      { keys: ['⇧', 'F5'], description: 'Pause team (stop all agents)' },
      { keys: ['⌘', '⇧', 'D'], description: 'Run drift check' },
      { keys: ['⌘', '⇧', 'V'], description: 'Run validations on active task' },
      { keys: ['⌘', '⇧', 'A'], description: 'Open approvals' },
    ],
  },
  {
    label: 'Modals & drawers',
    entries: [
      { keys: ['Esc'], description: 'Close the current modal, drawer, or palette' },
      { keys: ['↑', '↓'], description: 'Navigate the command palette / select rows', context: 'In palette' },
      { keys: ['↵'], description: 'Select the active palette result or commit input' },
      { keys: ['⌘', '↵'], description: 'Send a comment from the task-detail composer' },
    ],
  },
  {
    label: 'Editing',
    entries: [
      { keys: ['↵'], description: 'Add a new chip in chip-list editors (or use comma)', context: 'Inside chip lists' },
      { keys: [','], description: 'Add a new chip (alternative)', context: 'Inside chip lists' },
      { keys: ['Backspace'], description: 'Remove the last chip when the input is empty', context: 'Inside chip lists' },
    ],
  },
  {
    label: 'Browser-native',
    entries: [
      { keys: ['F12'], description: 'Open browser dev tools (debug Symphony UI state)' },
      { keys: ['⌘', 'R'], description: 'Reload the page (re-fetches projection from API)' },
    ],
  },
];

interface ShortcutsModalProps {
  onClose: () => void;
}

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 600, maxHeight: 'min(80vh, 720px)' }}
      >
        <div className="modal-head">
          <div>
            <h2>Keyboard shortcuts</h2>
            <div className="sub">
              Quick reference. Custom rebinding lands in a future slice — for now, these are the built-ins.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: 18 }}>
              <div className="section-label" style={{ marginBottom: 8 }}>{group.label}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {group.entries.map((entry, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '160px 1fr',
                      alignItems: 'baseline',
                      gap: 12,
                      padding: '6px 4px',
                      borderBottom: '1px solid var(--border-soft, rgba(255,255,255,0.04))',
                    }}
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {entry.keys.map((k, j) => (
                        <span
                          key={j}
                          className="kbd mono"
                          style={{
                            display: 'inline-block',
                            padding: '2px 6px',
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid var(--border-soft, rgba(255,255,255,0.10))',
                            borderRadius: 4,
                            fontSize: 11,
                            color: 'var(--fg, #fff)',
                            minWidth: 18,
                            textAlign: 'center',
                          }}
                        >
                          {k}
                        </span>
                      ))}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--fg)' }}>
                        {entry.description}
                      </div>
                      {entry.context && (
                        <div className="dim" style={{ fontSize: 10.5, marginTop: 2 }}>
                          {entry.context}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="modal-foot">
          <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
            <span className="kbd">Esc</span> to close
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
