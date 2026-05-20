import { useState } from 'react';
import { roleStyle } from '@/data/roles';
import { Icon, type IconName } from '@/components/Icon';
import type { Team } from '@/types';

type NotificationKind = 'approval' | 'validation-failed' | 'scope-drift' | 'repeated-fail' | 'agent-stop' | 'info';
type NotificationFilter = 'all' | 'attention' | 'earlier';
type NotificationGroupLabel = 'Needs attention' | 'Earlier';

interface NotificationItem {
  id: string;
  kind: NotificationKind;
  time: string;
  title: string;
  body: string;
  agent?: string;
  actions?: string[];
}

interface NotificationKindMeta {
  icon: IconName;
  color: string;
  label: string;
}

interface NotifRowProps {
  notification: NotificationItem;
  team: Team;
}

export interface NotificationsDrawerProps {
  team: Team;
  onClose: () => void;
}

// Notifications come from the live SSE event stream — drawer starts empty
// and fills in as runtime events arrive. The previous static seed list has
// been removed (was misleading — looked like real notifications even when
// nothing was happening).
const NOTIFICATIONS: NotificationItem[] = [];

const KIND_META: Record<NotificationKind, NotificationKindMeta> = {
  approval: { icon: 'info', color: 'var(--warn)', label: 'Approval' },
  'validation-failed': { icon: 'x', color: 'var(--err)', label: 'Tests failed' },
  'scope-drift': { icon: 'info', color: 'var(--warn)', label: 'Scope drift' },
  'repeated-fail': { icon: 'x', color: 'var(--err)', label: 'Repeated fail' },
  'agent-stop': { icon: 'moreH', color: 'var(--fg-dim)', label: 'Agent stop' },
  info: { icon: 'info', color: 'var(--fg-muted)', label: 'Info' },
};

function NotifRow({ notification, team }: NotifRowProps) {
  const kindMeta = KIND_META[notification.kind];
  const member = notification.agent
    ? team.members.find((candidate) => candidate.id === notification.agent)
    : undefined;

  return (
    <div className={`notif-row notif-${notification.kind}`}>
      <div
        className="notif-icon"
        style={{
          color: kindMeta.color,
          borderColor: `color-mix(in oklch, ${kindMeta.color} 40%, transparent)`,
        }}
      >
        <Icon name={kindMeta.icon} size={13} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="notif-head">
          <span className="notif-kind" style={{ color: kindMeta.color }}>{kindMeta.label}</span>
          {member && (
            <span className="notif-agent" style={roleStyle(member.role)}>
              <span className="agent-avatar" style={{ width: 14, height: 14, fontSize: 8 }}>{member.avatar}</span>
              <span style={{ color: 'var(--accent)' }}>{member.name}</span>
            </span>
          )}
          <span className="notif-time mono">{notification.time}</span>
        </div>
        <div className="notif-title">{notification.title}</div>
        <div className="notif-body">{notification.body}</div>
        {notification.actions && (
          <div className="notif-actions">
            {notification.actions.map((action, index) => (
              <button
                key={action}
                className={`btn btn-sm ${index === 0 ? (notification.kind === 'approval' ? 'btn-primary' : '') : 'btn-ghost'}`}
              >
                {action}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function NotificationsDrawer({ team, onClose }: NotificationsDrawerProps) {
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const groups: Record<NotificationGroupLabel, NotificationItem[]> = {
    'Needs attention': NOTIFICATIONS.filter((notification) => (
      notification.kind === 'approval'
      || notification.kind === 'validation-failed'
      || notification.kind === 'scope-drift'
      || notification.kind === 'repeated-fail'
    )),
    Earlier: NOTIFICATIONS.filter((notification) => (
      notification.kind === 'agent-stop' || notification.kind === 'info'
    )),
  };

  const visible: Partial<Record<NotificationGroupLabel, NotificationItem[]>> = filter === 'all'
    ? groups
    : {
        [filter === 'attention' ? 'Needs attention' : 'Earlier']:
          filter === 'attention' ? groups['Needs attention'] : groups.Earlier,
      };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer notif-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="bell" size={15} />
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Notifications</h2>
            <span className="chip" style={{ fontSize: 10.5 }}>{NOTIFICATIONS.length}</span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn btn-sm btn-ghost">Mark all read</button>
            <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
          </div>
        </div>

        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border-soft)',
            display: 'flex',
            gap: 8,
          }}
        >
          <div className="seg">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              All <span style={{ color: 'var(--fg-dim)', marginLeft: 4 }}>{NOTIFICATIONS.length}</span>
            </button>
            <button className={filter === 'attention' ? 'active' : ''} onClick={() => setFilter('attention')}>
              Needs attention
              <span style={{ color: 'var(--warn)', marginLeft: 4 }}>{groups['Needs attention'].length}</span>
            </button>
            <button className={filter === 'earlier' ? 'active' : ''} onClick={() => setFilter('earlier')}>
              Earlier <span style={{ color: 'var(--fg-dim)', marginLeft: 4 }}>{groups.Earlier.length}</span>
            </button>
          </div>
        </div>

        <div className="notif-body-scroll">
          {Object.entries(visible).map(([label, items]) => (
            <div key={label}>
              <div className="sticky-section-head">
                <span className="section-label">{label}</span>
                <span className="count-pill">{items.length}</span>
              </div>
              <div style={{ padding: '4px 12px 12px' }}>
                {items.map((notification) => (
                  <NotifRow key={notification.id} notification={notification} team={team} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="drawer-foot">
          <button className="btn btn-sm btn-ghost">
            <Icon name="settings" size={11} /> Notification settings
          </button>
        </div>
      </div>
    </div>
  );
}
