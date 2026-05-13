import { useEffect, useMemo, useState } from 'react';
import type { Team, Runtime, Agent } from '@/types';
import { ROLES, roleStyle } from '@/data/roles';
import { providerBrand } from '@/data/providerLabels';
import { Icon } from './Icon';
import { useToadEvents, type RuntimeEvent } from '@/api/events';

type MemberStatus = 'queued' | 'launching' | 'live' | 'error' | 'unknown';

interface TeamLaunchingScreenProps {
  team: Team;
  runtimes: Runtime[];
  /** Team ID being launched. Determines which runtimes to track. */
  launchingTeamId?: string;
  onContinue: () => void;
  onCancel?: () => void;
  /** When set, the screen auto-advances after this many ms once everything's live. Default 1500ms. */
  autoContinueDelayMs?: number;
}

interface MemberState {
  member: Agent;
  status: MemberStatus;
  runtimeId: string | null;
  detail?: string;
}

function memberStatusFromRuntime(rt: Runtime | null): MemberStatus {
  if (!rt) return 'queued';
  if (rt.status === 'live') return 'live';
  if (rt.status === 'launching') return 'launching';
  if (rt.status === 'error') return 'error';
  if (rt.status === 'idle' || rt.status === 'stopped') return 'queued';
  return 'unknown';
}

function statusLabel(s: MemberStatus): string {
  switch (s) {
    case 'queued': return 'Queued';
    case 'launching': return 'Launching…';
    case 'live': return 'Live';
    case 'error': return 'Error';
    case 'unknown': return 'Unknown';
  }
}

function statusColor(s: MemberStatus): string {
  switch (s) {
    case 'live': return 'oklch(0.72 0.15 145)';
    case 'launching': return 'oklch(0.78 0.14 80)';
    case 'queued': return 'var(--fg-dim, rgba(255,255,255,0.4))';
    case 'error': return 'var(--err, #e5484d)';
    case 'unknown': return 'var(--fg-muted, rgba(255,255,255,0.55))';
  }
}

export function TeamLaunchingScreen({
  team, runtimes, launchingTeamId, onContinue, onCancel, autoContinueDelayMs = 1500,
}: TeamLaunchingScreenProps) {
  const [eventOverrides, setEventOverrides] = useState<Record<string, MemberStatus>>({});
  // Tracks runtime IDs that have emitted ANY event after spawn — proves the
  // agent process is actually responsive, not just running. Without this,
  // a freshly-spawned process shows "live" the instant `child_process.spawn`
  // returns, even though the agent CLI hasn't said anything yet. The
  // progress bar would jump to 100% before any work has begun.
  const [runtimesAcknowledged, setRuntimesAcknowledged] = useState<Set<string>>(() => new Set());

  // Listen to live runtime events so the screen advances as each agent comes
  // online, even if the polled runtimes list hasn't refreshed yet.
  useToadEvents({
    onEvent: (event: RuntimeEvent) => {
      if (!event?.type || !event.runtimeId) return;
      if (!event.type.startsWith('runtime')) return;
      // Any event from this runtime proves it's responsive.
      const rid = String(event.runtimeId);
      setRuntimesAcknowledged((prev) => {
        if (prev.has(rid)) return prev;
        const next = new Set(prev);
        next.add(rid);
        return next;
      });
      const status = (event.payload as { status?: string } | undefined)?.status;
      if (!status) return;
      if (status === 'live' || status === 'launching' || status === 'error' || status === 'queued') {
        setEventOverrides((prev) => ({ ...prev, [rid]: status as MemberStatus }));
      }
    },
  });

  const memberStates: MemberState[] = useMemo(() => {
    const teamId = launchingTeamId ?? '';
    return team.members.map((m) => {
      const expectedRuntimeId = teamId ? `runtime-${teamId}-${m.id}` : null;
      const rt = expectedRuntimeId
        ? runtimes.find((r) => r.id === expectedRuntimeId) ?? null
        : runtimes.find((r) => r.agent === m.id) ?? null;
      const baseStatus = memberStatusFromRuntime(rt);
      const override = expectedRuntimeId ? eventOverrides[expectedRuntimeId] : undefined;
      let status = override ?? baseStatus;
      // If the supervisor reports the process as live but we haven't seen
      // any output from it yet, downgrade to "launching" — the CLI is
      // booting + reading the launch prompt, not actually working yet.
      const rid = rt?.id ?? expectedRuntimeId;
      if (status === 'live' && rid && !runtimesAcknowledged.has(rid)) {
        status = 'launching';
      }
      return {
        member: m,
        status,
        runtimeId: rid ?? null,
        detail: rt ? `pid ${rt.pid}` : undefined,
      };
    });
  }, [team, runtimes, launchingTeamId, eventOverrides, runtimesAcknowledged]);

  const liveCount = memberStates.filter((s) => s.status === 'live').length;
  const totalCount = memberStates.length;
  const errorCount = memberStates.filter((s) => s.status === 'error').length;
  const allLive = totalCount > 0 && liveCount === totalCount;

  // Auto-advance once everything is live.
  useEffect(() => {
    if (!allLive) return;
    const t = setTimeout(onContinue, autoContinueDelayMs);
    return () => clearTimeout(t);
  }, [allLive, onContinue, autoContinueDelayMs]);

  const progressPct = totalCount === 0 ? 0 : Math.round((liveCount / totalCount) * 100);

  return (
    <main className="ws-main" style={{ overflow: 'auto' }}>
      <div
        style={{
          maxWidth: 720,
          margin: '40px auto',
          padding: '0 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <div>
          <div className="section-label" style={{ marginBottom: 4 }}>Launching</div>
          <h1 style={{ fontSize: 24, margin: 0 }}>{team.name}</h1>
          <div className="dim" style={{ fontSize: 13, marginTop: 6 }}>
            {team.description}
          </div>
        </div>

        <div
          style={{
            padding: '14px 16px',
            background: 'var(--bg-panel, #1a1916)',
            border: '1px solid var(--border-soft, rgba(255,255,255,0.08))',
            borderRadius: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="section-label">
              {allLive
                ? 'Team is up'
                : `Booting ${providerBrand(team.members[0]?.provider)} agents · ${liveCount}/${totalCount}`}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              {progressPct}% ready
              {errorCount > 0 && (
                <span style={{ color: 'var(--err)', marginLeft: 8 }}>· {errorCount} error{errorCount > 1 ? 's' : ''}</span>
              )}
            </div>
          </div>

          <div
            style={{
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.06)',
              overflow: 'hidden',
              marginBottom: 14,
            }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: '100%',
                background: allLive ? 'var(--ok, oklch(0.72 0.15 145))' : 'var(--clay, #d97757)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {memberStates.map(({ member, status, runtimeId, detail }) => {
              const role = ROLES[member.role];
              const color = statusColor(status);
              return (
                <div
                  key={member.id}
                  style={{
                    ...roleStyle(member.role),
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    background: 'rgba(255,255,255,0.02)',
                    borderRadius: 6,
                    border: '1px solid var(--border-soft, rgba(255,255,255,0.05))',
                  }}
                >
                  <span
                    className="agent-avatar"
                    style={{ width: 26, height: 26, fontSize: 11 }}
                  >
                    {member.avatar}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>
                        {member.name}
                      </span>
                      <span className="dim" style={{ fontSize: 11 }}>
                        {role.short} · {providerBrand(member.provider)} · {member.model}
                      </span>
                    </div>
                    {detail && (
                      <div className="mono dim" style={{ fontSize: 10.5, marginTop: 2 }}>
                        {runtimeId ?? '—'} · {detail}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color }}>
                    {status === 'launching' && (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: color,
                          boxShadow: `0 0 8px ${color}`,
                          animation: 'pulse 1s ease-in-out infinite',
                        }}
                      />
                    )}
                    {status === 'live' && <Icon name="check" size={12} />}
                    {status === 'error' && <Icon name="x" size={12} />}
                    {(status === 'queued' || status === 'unknown') && (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: color,
                          opacity: 0.6,
                        }}
                      />
                    )}
                    <span style={{ fontSize: 11, fontWeight: 500 }}>{statusLabel(status)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel launch
            </button>
          )}
          <span className="dim" style={{ fontSize: 11.5, flex: 1 }}>
            {allLive
              ? 'All agents are live. Switching to workspace…'
              : 'You can continue to the workspace at any time; agents will keep coming up in the background.'}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onContinue}
          >
            <Icon name="layers" size={11} /> Open workspace
          </button>
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </main>
  );
}
