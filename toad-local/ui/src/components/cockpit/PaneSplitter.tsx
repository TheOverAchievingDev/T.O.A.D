import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Phase 2 PaneSplitter — generic horizontal/vertical resizable split
 * pane primitive used by every Phase 2 layout (FOR-me three-column,
 * WITH-me code-first, BottomPanel resize).
 *
 * Usage:
 *
 *   <PaneSplitter
 *     orientation="horizontal"
 *     defaultSize={240}
 *     minSize={180}
 *     maxSize={400}
 *     storageKey="cockpit.forMe.leftCol"
 *   >
 *     <AgentColumn />
 *     <CenterColumn />
 *   </PaneSplitter>
 *
 * - The FIRST child gets a fixed pixel size; the SECOND child takes the
 *   remaining flex space.
 * - Dragging the divider updates the first child's size. The size is
 *   clamped to [minSize, maxSize] when provided.
 * - `storageKey` opts into localStorage persistence — read on mount,
 *   written on drag end (avoids thrashing localStorage during the drag).
 * - Double-click the divider to reset to defaultSize.
 *
 * Phase 1 explicit non-goals (Phase 2c+ polish):
 *   - Touch-event support (mouse only).
 *   - Container-resize observation (sizes stored as absolute px; a
 *     shrunken window may make a pane too big; the clamp + parent
 *     overflow:hidden absorb this until a ResizeObserver is wired).
 *   - More than two children. Splitter is a 1:1 binary split.
 */

export type SplitOrientation = 'horizontal' | 'vertical';

export interface PaneSplitterProps {
  orientation: SplitOrientation;
  /** Initial size of the FIRST pane in px. */
  defaultSize: number;
  /** Optional clamp — drag never shrinks the first pane below this. */
  minSize?: number;
  /** Optional clamp — drag never grows the first pane beyond this. */
  maxSize?: number;
  /** localStorage key for persistence. When omitted, sizes are
   *  in-memory only and reset on remount. */
  storageKey?: string;
  /** Two children — first is the fixed-size pane, second is flex. */
  children: [ReactNode, ReactNode];
  /** Optional CSS class on the outer container. */
  className?: string;
}

function readStoredSize(key: string | undefined, fallback: number): number {
  if (!key || typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredSize(key: string | undefined, size: number): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(Math.round(size)));
  } catch {
    // Storage may be full or disabled — silently ignore.
  }
}

export function PaneSplitter({
  orientation,
  defaultSize,
  minSize,
  maxSize,
  storageKey,
  children,
  className,
}: PaneSplitterProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ active: boolean }>({ active: false });
  const [size, setSize] = useState<number>(() => readStoredSize(storageKey, defaultSize));

  const clamp = useCallback(
    (raw: number): number => {
      let next = raw;
      if (typeof minSize === 'number') next = Math.max(minSize, next);
      if (typeof maxSize === 'number') next = Math.min(maxSize, next);
      return next;
    },
    [minSize, maxSize],
  );

  // Track the drag globally so the user can drag outside the splitter
  // bounds without losing the cursor.
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const raw = orientation === 'horizontal'
        ? e.clientX - rect.left
        : e.clientY - rect.top;
      setSize(clamp(raw));
    };
    const onMouseUp = () => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist on drag end so we don't thrash localStorage every frame.
      // Reads `size` via a state-getter to avoid stale-closure issues.
      setSize((current) => {
        writeStoredSize(storageKey, current);
        return current;
      });
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [orientation, clamp, storageKey]);

  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current.active = true;
    document.body.style.cursor = orientation === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const onDividerDoubleClick = () => {
    setSize(defaultSize);
    writeStoredSize(storageKey, defaultSize);
  };

  // Style for the first pane — fixed in the split dimension, flex auto
  // in the cross dimension.
  const firstPaneStyle =
    orientation === 'horizontal'
      ? { flex: `0 0 ${size}px`, width: size, minWidth: 0 }
      : { flex: `0 0 ${size}px`, height: size, minHeight: 0 };

  return (
    <div
      ref={containerRef}
      className={`pane-splitter pane-splitter-${orientation}${className ? ` ${className}` : ''}`}
    >
      <div className="pane-splitter-first" style={firstPaneStyle}>
        {children[0]}
      </div>
      <div
        className="pane-splitter-divider"
        role="separator"
        aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(size)}
        onMouseDown={onDividerMouseDown}
        onDoubleClick={onDividerDoubleClick}
        title="Drag to resize · double-click to reset"
      />
      <div className="pane-splitter-second">
        {children[1]}
      </div>
    </div>
  );
}
