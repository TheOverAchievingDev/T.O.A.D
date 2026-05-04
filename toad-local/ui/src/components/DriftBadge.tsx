interface DriftBadgeProps {
  score: number | undefined;
  onClick?: () => void;
}

/**
 * Tiny color-coded chip on a task card showing its drift %. Hides when
 * score is undefined (drift hasn't been computed for this task yet, or
 * the task is in a non-active status).
 */
export function DriftBadge({ score, onClick }: DriftBadgeProps) {
  if (typeof score !== 'number') return null;
  const color = score >= 66 ? 'var(--err, #f87171)'
    : score >= 41 ? 'var(--warn, #ffcd66)'
    : score >= 21 ? 'var(--warn, #ffcd66)'
    : 'var(--ok, #4ade80)';
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      title="Drift score — click to view in Drift screen"
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '1px 5px',
        borderRadius: 3,
        background: color,
        color: '#000',
        cursor: onClick ? 'pointer' : 'default',
        letterSpacing: '0.04em',
      }}
    >
      {score}%
    </span>
  );
}
