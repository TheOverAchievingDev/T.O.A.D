import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

export interface CommandAction {
  id: string;
  label: string;
  group: 'Navigate' | 'Tasks' | 'Agents' | 'Actions' | 'Settings' | string;
  icon?: IconName;
  hint?: string;
  /** Extra keywords that should match the search but aren't shown. */
  keywords?: string[];
  run: () => void;
}

interface CommandPaletteProps {
  actions: CommandAction[];
  onClose: () => void;
}

interface ScoredAction {
  action: CommandAction;
  score: number;
}

const MAX_RESULTS = 50;

/** Tiny, dependency-free fuzzy score. Higher is better. */
function scoreMatch(query: string, action: CommandAction): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const haystack = [
    action.label,
    action.group,
    action.hint ?? '',
    ...(action.keywords ?? []),
  ].join(' ').toLowerCase();

  if (haystack.includes(q)) {
    // Strong boost for label-prefix matches.
    if (action.label.toLowerCase().startsWith(q)) return 100;
    // Word-boundary boost.
    if (haystack.includes(` ${q}`)) return 70;
    return 50;
  }

  // Subsequence match — every char of q appears in order.
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < q.length; i++) {
    if (haystack[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 10;
  return 0;
}

export function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo<ScoredAction[]>(() => {
    const scored: ScoredAction[] = [];
    for (const action of actions) {
      const score = scoreMatch(query, action);
      if (score > 0) scored.push({ action, score });
    }
    scored.sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label));
    return scored.slice(0, MAX_RESULTS);
  }, [actions, query]);

  // Reset highlight whenever the list changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [query, results.length]);

  // Group results in display order while keeping the flat ranked list for keyboard nav.
  const grouped = useMemo(() => {
    const groups = new Map<string, ScoredAction[]>();
    results.forEach((r) => {
      const arr = groups.get(r.action.group) ?? [];
      arr.push(r);
      groups.set(r.action.group, arr);
    });
    return Array.from(groups.entries());
  }, [results]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[activeIdx];
      if (target) {
        target.action.run();
        onClose();
      }
      return;
    }
  }

  // Keep the active item in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-cmd-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  let runningIndex = 0;

  return (
    <div className="cmdk-backdrop" onClick={onClose} role="dialog" aria-label="Command palette">
      <div className="cmdk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-wrap">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Type a command, task, or agent…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="cmdk-esc">esc</span>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 && (
            <div className="cmdk-empty">No matches.</div>
          )}
          {grouped.map(([group, items]) => (
            <div key={group} className="cmdk-group">
              <div className="cmdk-group-label">{group}</div>
              {items.map(({ action }) => {
                const idx = runningIndex++;
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={action.id}
                    type="button"
                    data-cmd-idx={idx}
                    className={`cmdk-row ${isActive ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      action.run();
                      onClose();
                    }}
                  >
                    <span className="cmdk-row-icon">
                      {action.icon && <Icon name={action.icon} size={13} />}
                    </span>
                    <span className="cmdk-row-label">{action.label}</span>
                    {action.hint && (
                      <span className="cmdk-row-hint">{action.hint}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="cmdk-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
