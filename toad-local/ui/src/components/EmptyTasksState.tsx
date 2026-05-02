import { Icon, type IconName } from './Icon';

interface EmptyTasksStateProps {
  /** Headline shown to the user. */
  title?: string;
  /** Sub-copy under the headline. */
  body?: string;
  /** Optional CTA. Hidden when omitted. */
  ctaLabel?: string;
  ctaIcon?: IconName;
  onCta?: () => void;
  /** Compact = small inline pad (right-rail style). Block = full-bleed (main view). */
  variant?: 'block' | 'compact';
}

export function EmptyTasksState({
  title = 'No tasks yet',
  body = 'Create the first task and the team can start picking it up.',
  ctaLabel = 'Create a task',
  ctaIcon = 'plus',
  onCta,
  variant = 'block',
}: EmptyTasksStateProps) {
  const isCompact = variant === 'compact';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: isCompact ? '20px 14px' : '60px 20px',
        gap: 8,
        color: 'var(--fg-muted)',
        border: isCompact
          ? '1px dashed var(--border-soft, rgba(255,255,255,0.08))'
          : 'none',
        borderRadius: isCompact ? 8 : 0,
      }}
    >
      <div
        style={{
          width: isCompact ? 28 : 44,
          height: isCompact ? 28 : 44,
          borderRadius: '50%',
          background: 'rgba(217, 119, 87, 0.10)',
          color: 'var(--clay, #d97757)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: isCompact ? 2 : 4,
        }}
      >
        <Icon name="kanban" size={isCompact ? 14 : 22} />
      </div>
      <div
        style={{
          fontSize: isCompact ? 12.5 : 15,
          fontWeight: 600,
          color: 'var(--fg, #fff)',
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: isCompact ? 11 : 13,
          maxWidth: 360,
          lineHeight: 1.4,
          color: 'var(--fg-muted, rgba(255,255,255,0.55))',
        }}
      >
        {body}
      </div>
      {onCta && ctaLabel && (
        <button
          type="button"
          className={`btn ${isCompact ? 'btn-sm' : 'btn-primary'}`}
          onClick={onCta}
          style={{ marginTop: isCompact ? 4 : 8 }}
        >
          <Icon name={ctaIcon} size={isCompact ? 11 : 12} /> {ctaLabel}
        </button>
      )}
    </div>
  );
}
