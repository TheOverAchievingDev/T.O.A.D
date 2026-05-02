import { Icon, type IconName } from './Icon';

/**
 * The 10-state task lifecycle straight from
 * `toad-local/src/task/taskLifecycle.js` (§3 of the hardening checklist).
 * The UI's `TaskStatus` type uses a friendlier 6-value subset; this
 * visualizer also tolerates the legacy 4-value enum (`pending` / `in_progress`
 * / `completed` / `deleted`) by aliasing to the closest 10-state node.
 */
export type LifecycleState =
  | 'backlog'
  | 'ready'
  | 'planned'
  | 'in_progress'
  | 'review'
  | 'testing'
  | 'merge_ready'
  | 'done'
  | 'blocked'
  | 'rejected';

const HAPPY_PATH: LifecycleState[] = [
  'backlog', 'ready', 'planned', 'in_progress', 'review', 'testing', 'merge_ready', 'done',
];

const SIDE_STATES: LifecycleState[] = ['blocked', 'rejected'];

const STATE_LABELS: Record<LifecycleState, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  planned: 'Planned',
  in_progress: 'In progress',
  review: 'Review',
  testing: 'Testing',
  merge_ready: 'Merge ready',
  done: 'Done',
  blocked: 'Blocked',
  rejected: 'Rejected',
};

const STATE_ICONS: Record<LifecycleState, IconName> = {
  backlog: 'inbox',
  ready: 'list',
  planned: 'workflow',
  in_progress: 'play',
  review: 'eye',
  testing: 'check',
  merge_ready: 'git',
  done: 'check',
  blocked: 'pause',
  rejected: 'x',
};

const STATE_DESCRIPTIONS: Record<LifecycleState, string> = {
  backlog: 'Created. Not yet picked up.',
  ready: 'Dependencies cleared. Available for an agent to claim.',
  planned: 'Plan proposed and approved.',
  in_progress: 'Agent is actively working on it.',
  review: 'Review requested; reviewer evaluating.',
  testing: 'Validation commands running.',
  merge_ready: 'Tests pass; awaiting integration.',
  done: 'Merged into the base branch.',
  blocked: 'Stalled — needs human intervention.',
  rejected: 'Reviewer rejected; back to backlog.',
};

/**
 * Normalize an arbitrary status string to a LifecycleState. Returns null
 * when the input is unrecognized.
 */
function normalize(status: string | undefined | null): LifecycleState | null {
  if (!status) return null;
  const v = status.toLowerCase().replace(/-/g, '_');
  // Legacy 4-state aliases.
  if (v === 'pending' || v === 'todo') return 'backlog';
  if (v === 'completed') return 'done';
  if (v === 'deleted') return 'rejected';
  if (HAPPY_PATH.includes(v as LifecycleState) || SIDE_STATES.includes(v as LifecycleState)) {
    return v as LifecycleState;
  }
  return null;
}

interface TaskLifecycleProps {
  /** The task's current status. Accepts UI-friendly aliases. */
  status: string | undefined | null;
  /** States the task has previously been in. Used to render the trail of
   * completed nodes. Order doesn't matter; presence does. */
  visited?: string[];
  /** Compact = single-row inline pill string; full = laid out node graph. */
  variant?: 'compact' | 'full';
  /** When the user clicks a node — caller may use this to filter or jump. */
  onSelect?: (state: LifecycleState) => void;
}

export function TaskLifecycle({ status, visited = [], variant = 'full', onSelect }: TaskLifecycleProps) {
  const current = normalize(status);
  const visitedSet = new Set<LifecycleState>();
  for (const v of visited) {
    const n = normalize(v);
    if (n) visitedSet.add(n);
  }
  if (current) visitedSet.add(current);

  // The "trail" is everything in HAPPY_PATH up to and including the current
  // happy-path step (so future steps are dimmed). Side states (blocked /
  // rejected) flag separately when current is one of them.
  const currentIsSide = current && SIDE_STATES.includes(current);
  const happyIndex = !currentIsSide && current ? HAPPY_PATH.indexOf(current) : -1;
  const trailIndex = happyIndex >= 0 ? happyIndex : -1;

  if (variant === 'compact') {
    return (
      <CompactRow
        states={HAPPY_PATH}
        current={current}
        trailIndex={trailIndex}
        visitedSet={visitedSet}
        currentIsSide={currentIsSide ?? false}
        onSelect={onSelect}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <CompactRow
        states={HAPPY_PATH}
        current={current}
        trailIndex={trailIndex}
        visitedSet={visitedSet}
        currentIsSide={currentIsSide ?? false}
        onSelect={onSelect}
      />

      {(currentIsSide || visitedSet.has('blocked') || visitedSet.has('rejected')) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {SIDE_STATES.map((s) => (
            <SideStateChip
              key={s}
              state={s}
              isCurrent={current === s}
              isVisited={visitedSet.has(s)}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {current && (
        <div
          style={{
            marginTop: 6,
            padding: '8px 10px',
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
            borderRadius: 6,
            fontSize: 11.5,
            color: 'var(--fg-muted)',
          }}
        >
          <strong style={{ color: 'var(--fg)' }}>{STATE_LABELS[current]}</strong>
          {' · '}{STATE_DESCRIPTIONS[current]}
        </div>
      )}
    </div>
  );
}

interface CompactRowProps {
  states: LifecycleState[];
  current: LifecycleState | null;
  trailIndex: number;
  visitedSet: Set<LifecycleState>;
  currentIsSide: boolean;
  onSelect?: (state: LifecycleState) => void;
}

function CompactRow({ states, current, trailIndex, visitedSet, currentIsSide, onSelect }: CompactRowProps) {
  return (
    <div
      role="list"
      aria-label="Task lifecycle"
      style={{
        display: 'grid',
        gridAutoFlow: 'column',
        gridAutoColumns: '1fr',
        alignItems: 'center',
        gap: 0,
      }}
    >
      {states.map((state, i) => {
        const isCurrent = state === current;
        const isPast = i < trailIndex;
        const isFuture = i > trailIndex && !currentIsSide;
        const isVisited = visitedSet.has(state);
        const showAsDone = isPast || (isVisited && !isCurrent);
        const dim = (isFuture && !isVisited) || (currentIsSide && state !== current);

        const color = isCurrent
          ? 'var(--clay, #d97757)'
          : showAsDone
          ? 'oklch(0.72 0.15 145)'
          : 'var(--fg-dim, rgba(255,255,255,0.4))';

        const ringColor = isCurrent
          ? 'var(--clay, #d97757)'
          : showAsDone
          ? 'oklch(0.55 0.15 145 / 0.5)'
          : 'var(--border-soft, rgba(255,255,255,0.10))';

        const bg = isCurrent
          ? 'oklch(0.30 0.10 60 / 0.4)'
          : showAsDone
          ? 'oklch(0.30 0.06 145 / 0.25)'
          : 'transparent';

        const Tag: 'button' | 'div' = onSelect ? 'button' : 'div';

        return (
          <div
            role="listitem"
            key={state}
            style={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              opacity: dim ? 0.55 : 1,
            }}
          >
            <Tag
              type={onSelect ? 'button' : undefined}
              onClick={onSelect ? () => onSelect(state) : undefined}
              title={STATE_DESCRIPTIONS[state]}
              style={{
                appearance: 'none',
                background: bg,
                border: `1px solid ${ringColor}`,
                borderRadius: 6,
                color,
                cursor: onSelect ? 'pointer' : 'default',
                padding: '4px 6px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                width: '100%',
                minWidth: 0,
                fontSize: 9.5,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                fontFamily: 'inherit',
                transition: 'background 0.12s, color 0.12s, border-color 0.12s',
              }}
            >
              <Icon name={STATE_ICONS[state]} size={11} />
              <span
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: '100%',
                }}
              >
                {STATE_LABELS[state]}
              </span>
            </Tag>
            {i < states.length - 1 && (
              <span
                style={{
                  flex: 0,
                  width: 8,
                  borderTop: `2px ${showAsDone ? 'solid' : 'dashed'} ${ringColor}`,
                  margin: '0 -1px',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SideStateChip({
  state, isCurrent, isVisited, onSelect,
}: {
  state: LifecycleState;
  isCurrent: boolean;
  isVisited: boolean;
  onSelect?: (state: LifecycleState) => void;
}) {
  const meta = state === 'blocked'
    ? { color: 'oklch(0.85 0.14 80)', bg: 'oklch(0.30 0.06 80 / 0.4)', bd: 'oklch(0.55 0.10 80 / 0.4)' }
    : { color: 'oklch(0.85 0.20 25)', bg: 'oklch(0.30 0.10 25 / 0.4)', bd: 'oklch(0.55 0.18 25 / 0.4)' };
  const Tag: 'button' | 'div' = onSelect ? 'button' : 'div';
  return (
    <Tag
      type={onSelect ? 'button' : undefined}
      onClick={onSelect ? () => onSelect(state) : undefined}
      title={STATE_DESCRIPTIONS[state]}
      style={{
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${isCurrent ? meta.bd : 'transparent'}`,
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        cursor: onSelect ? 'pointer' : 'default',
        opacity: isCurrent || isVisited ? 1 : 0.45,
      }}
    >
      <Icon name={STATE_ICONS[state]} size={10} />
      {STATE_LABELS[state]}
      {isCurrent && <span style={{ marginLeft: 4, fontSize: 9 }}>● now</span>}
    </Tag>
  );
}
