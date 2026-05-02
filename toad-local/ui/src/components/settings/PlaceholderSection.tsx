import { Icon, type IconName } from '../Icon';
import { SettingsSectionHeader } from './SettingsLayout';

interface PlaceholderSectionProps {
  title: string;
  description: string;
  comingIn?: string;
  icon?: IconName;
  bullets?: string[];
}

export function PlaceholderSection({
  title, description, comingIn, icon = 'workflow', bullets,
}: PlaceholderSectionProps) {
  return (
    <div>
      <SettingsSectionHeader
        title={title}
        description={description}
        badge={comingIn ? `Phase ${comingIn}` : undefined}
      />

      <div
        style={{
          padding: '40px 32px',
          background: 'var(--bg-panel, rgba(255,255,255,0.02))',
          border: '1px dashed var(--border-soft, rgba(255,255,255,0.10))',
          borderRadius: 10,
          textAlign: 'center',
          color: 'var(--fg-muted, rgba(255,255,255,0.55))',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            margin: '0 auto 12px',
            borderRadius: '50%',
            background: 'rgba(217, 119, 87, 0.10)',
            color: 'var(--clay, #d97757)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size={22} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>
          Coming soon
        </div>
        <div style={{ fontSize: 12.5, maxWidth: 480, margin: '0 auto', lineHeight: 1.5 }}>
          {comingIn
            ? `This section lands in Phase ${comingIn}. The shell is wired so the navigation, persistence, and routing all work — only the editor UI is left.`
            : `This section is on the roadmap.`}
        </div>
        {bullets && bullets.length > 0 && (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: '20px auto 0',
              maxWidth: 480,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12,
              textAlign: 'left',
              color: 'var(--fg-muted, rgba(255,255,255,0.55))',
            }}
          >
            {bullets.map((b, i) => (
              <li
                key={i}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}
              >
                <Icon name="check" size={11} style={{ marginTop: 3, color: 'var(--clay, #d97757)', flexShrink: 0 }} />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
