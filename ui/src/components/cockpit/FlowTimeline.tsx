import type { ReactNode } from 'react';

/**
 * Phase 2 FlowTimeline — the calm, plain-English center column of the
 * FOR-me Cockpit. Renders a "what's happening" hero header above a
 * vertical timeline of recent team activity.
 *
 * The timeline is presentational; the data prep lives in
 * `timelineProjection.tsx` so it can be unit-tested and reused.
 *
 * Each event has a colored dot on the central rail, a relative-time
 * stamp on the left, and a body on the right. The first event renders
 * "expanded" — slightly elevated card with more breathing room — so
 * the operator's eye lands on the most recent action.
 *
 * Events with a `meta` array render compact key/value chips below the
 * body (file path, line counts, risk level, etc.) — used when the
 * projection captures a tool call's structured input.
 */

export type TimelineDot = 'clay' | 'green' | 'blue' | 'amber' | 'violet';

export interface TimelineMeta {
  tag: string;
  value: ReactNode;
  /** Optional class — 'ok' / 'num' / etc. — for color treatment. */
  tone?: 'tag' | 'ok' | 'num';
}

export interface TimelineEvent {
  id: string;
  /** Relative-time string like "just now", "2 min", "1h ago". */
  when: string;
  dot: TimelineDot;
  /** First event in the list renders expanded by default; others can
   *  also opt in to expanded styling. */
  expanded?: boolean;
  body: ReactNode;
  /** Optional structured meta rendered as compact chips. */
  meta?: TimelineMeta[];
}

export interface FlowTimelineProps {
  events: TimelineEvent[];
  /** Optional hero header — bold "what's happening" line above the
   *  timeline. Communicates the active task at a glance. */
  hero?: {
    title: ReactNode;
    subline?: ReactNode;
  };
  /** Empty state shown when events.length === 0. */
  emptyHint?: string;
}

export function FlowTimeline({ events, hero, emptyHint = 'Team is idle — no recent activity.' }: FlowTimelineProps) {
  return (
    <div className="flow-timeline-wrap">
      {hero && (
        <div className="flow-hero-card">
          <div className="flow-hero-eyebrow">What's happening</div>
          <div className="flow-hero-title">{hero.title}</div>
          {hero.subline && <div className="flow-hero-subline">{hero.subline}</div>}
        </div>
      )}
      {events.length === 0 ? (
        <div className="flow-timeline-empty">{emptyHint}</div>
      ) : (
        <div className="timeline">
          {events.map((e, idx) => (
            <div
              key={e.id}
              className={`tl-event${e.expanded || idx === 0 ? ' expanded' : ''}`}
            >
              <div className="when mono">{e.when}</div>
              <div className="marker">
                <div className={`dot ${e.dot}`} />
              </div>
              <div className="body">
                {e.body}
                {e.meta && e.meta.length > 0 && (
                  <div className="meta">
                    {e.meta.map((m, i) => (
                      <span key={i} className={m.tone ?? 'tag'}>
                        <span className="tag">{m.tag}</span>{' '}
                        <span className="num">{m.value}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
