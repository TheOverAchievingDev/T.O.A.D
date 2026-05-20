import { Icon } from './Icon';

/**
 * Phase 1 Statusbar — persistent thin bar at the bottom of the window.
 *
 * Closes the "where do I see ambient state?" gap captured in
 * FUTURE-IDEAS.md. Per spec §7, the four segments answer the four
 * questions an operator asks every minute:
 *
 *   1. "Is drift OK?"         — score % + healthy/watch/breach status
 *   2. "Is my team running?"  — live runtimes / total
 *   3. "Am I burning money?"  — cost today (vs budget when set)
 *   4. "Where am I in git?"   — branch + clean indicator
 *
 * A fifth segment appears in WITH-me developer mode showing
 * provider-quota burn rates (claude / codex / gemini).
 *
 * Right-side segments:
 *   - Approvals chip — when pending > 0
 *   - Cursor position (Code screen only — passes through editor state)
 *   - File encoding + language (Code screen only)
 *
 * Every left-side segment is clickable: drift → Drift screen,
 * runtimes → RuntimesDrawer, costs → Costs screen, approvals →
 * ApprovalsDrawer. Git segment opens a hypothetical Git drawer in
 * Phase 2; Phase 1 it's display-only.
 *
 * Cost and git state come from upstream hooks that don't exist yet —
 * Phase 1 accepts the data as props (or omits the segments when null)
 * so the bar renders cleanly today and gets richer when Phase 3 polish
 * adds the missing hooks.
 */

export interface StatusbarProps {
  /** 0..100 drift score; null hides the segment. */
  driftScore: number | null;
  driftStatus?: 'healthy' | 'watch' | 'breach';
  onOpenDrift: () => void;

  liveRuntimes: number;
  totalRuntimes: number;
  onOpenRuntimes: () => void;

  /** Today's spend in dollars; null hides the dollar text but keeps
   *  the segment as a click-target. */
  costToday?: number | null;
  /** Budget delta — "18% under" / "12% over" — rendered after $today. */
  costBudgetSummary?: string | null;
  onOpenCosts: () => void;

  /** Git branch name; defaults to 'main' when null. */
  gitBranch?: string | null;
  gitClean?: boolean;
  /** Ahead / behind counts shown only in developer mode. */
  gitAhead?: number;
  gitBehind?: number;

  developerMode: boolean;

  /** Provider-quota burn rates rendered in developer mode only.
   *  Format: {{ claude: 42, codex: 18, gemini: null }} — values are
   *  percentages of the 5h window consumed. null entries are skipped. */
  providerQuota?: Partial<Record<'claude' | 'codex' | 'gemini', number | null>>;

  /** Right-side: approvals chip. */
  pendingApprovals: number;
  onOpenApprovals: () => void;

  /** P3c-2 — honest span-summary monitor state; null hides the segment. */
  summaryState?: 'idle' | 'summarizing' | 'rate-limited' | 'degraded' | 'unavailable' | null;
  /** Reasons surfaced in the tooltip when degraded; [] when none. */
  summaryReasons?: string[];

  /** Right-side: Code screen passes these when active so the bar shows
   *  cursor position / file metadata; null on other screens. */
  cursorPos?: { line: number; col: number } | null;
  fileEncoding?: string | null;
  fileLanguage?: string | null;
}

function statusbarTone(status: 'healthy' | 'watch' | 'breach'): string {
  if (status === 'breach') return 'bad';
  if (status === 'watch') return 'warn';
  return '';
}

function summaryTone(state: NonNullable<StatusbarProps['summaryState']>): string {
  if (state === 'degraded' || state === 'unavailable') return 'bad';
  if (state === 'rate-limited') return 'warn';
  return ''; // idle / summarizing → quiet (green dot)
}

export function Statusbar({
  driftScore,
  driftStatus = 'healthy',
  onOpenDrift,
  liveRuntimes,
  totalRuntimes,
  onOpenRuntimes,
  costToday,
  costBudgetSummary,
  onOpenCosts,
  gitBranch,
  gitClean = true,
  gitAhead = 0,
  gitBehind = 0,
  developerMode,
  providerQuota,
  pendingApprovals,
  onOpenApprovals,
  summaryState = null,
  summaryReasons = [],
  cursorPos,
  fileEncoding,
  fileLanguage,
}: StatusbarProps) {
  const driftTone = statusbarTone(driftStatus);
  const driftStatusLabel = driftStatus === 'breach'
    ? 'breach'
    : driftStatus === 'watch'
      ? 'watch'
      : 'healthy';

  const branchLabel = gitBranch ?? 'main';

  const providerEntries = developerMode && providerQuota
    ? (Object.entries(providerQuota) as Array<[
        'claude' | 'codex' | 'gemini',
        number | null | undefined,
      ]>).filter(([, v]) => typeof v === 'number')
    : [];

  return (
    <div className="statusbar" role="status">
      {/* Drift — pulses when not healthy. */}
      <button
        type="button"
        className={`status-seg${driftTone ? ` ${driftTone}` : ''}`}
        onClick={onOpenDrift}
        title={`Drift score: ${driftScore ?? '--'}% (${driftStatusLabel})`}
      >
        <span
          className={`dot${driftTone ? ' pulse' : ''}`}
          style={driftTone ? undefined : { background: 'var(--signal-green)' }}
        />
        <span>drift</span>
        <span className="num">{driftScore == null ? '--' : `${Math.round(driftScore)}%`}</span>
        <span className="muted">{driftStatusLabel}</span>
      </button>

      {/* Span summaries — honest monitor state; null hides. Non-clickable
          (no dedicated screen), mirrors the git/provider-quota seg shape. */}
      {summaryState != null && (() => {
        const t = summaryTone(summaryState);
        const reasons = Array.isArray(summaryReasons) ? summaryReasons : [];
        return (
          <div
            className={`status-seg${t ? ` ${t}` : ''}`}
            title={`Span summaries: ${summaryState}${reasons.length ? ` — ${reasons.join(', ')}` : ''}`}
          >
            <span
              className={`dot${t ? ' pulse' : ''}`}
              style={t ? undefined : { background: 'var(--signal-green)' }}
            />
            <span>summaries</span>
            <span className="num">{summaryState}</span>
          </div>
        );
      })()}

      {/* Runtimes — live/total. */}
      <button
        type="button"
        className="status-seg"
        onClick={onOpenRuntimes}
        title={`${liveRuntimes} live · ${totalRuntimes} total runtimes`}
      >
        <span className="dot" />
        <span className="num">{liveRuntimes}/{totalRuntimes}</span>
        <span>runtimes</span>
      </button>

      {/* Costs — today's spend + budget delta. */}
      <button
        type="button"
        className="status-seg"
        onClick={onOpenCosts}
        title="Open costs screen"
      >
        <Icon name="workflow" size={11} />
        <span className="num">
          {typeof costToday === 'number' ? `$${costToday.toFixed(2)}` : '--'}
        </span>
        {costBudgetSummary && <span className="muted">{costBudgetSummary}</span>}
        {!costBudgetSummary && typeof costToday === 'number' && <span className="muted">total</span>}
      </button>

      {/* Git — branch + clean. */}
      <div className="status-seg" title={`Branch: ${branchLabel} · ${gitClean ? 'clean' : 'dirty'}`}>
        <Icon name="git" size={11} />
        <span className="num">{branchLabel}</span>
        {gitClean ? (
          <Icon name="check" size={11} style={{ color: 'var(--signal-green)' }} />
        ) : (
          <Icon name="x" size={11} style={{ color: 'var(--signal-amber)' }} />
        )}
        {developerMode && (gitAhead > 0 || gitBehind > 0) && (
          <span className="num muted">↑{gitAhead} ↓{gitBehind}</span>
        )}
      </div>

      {/* Dev-mode: provider quota burn rates. */}
      {providerEntries.length > 0 && (
        <div className="status-seg" title="Provider quota burn (5h windows)">
          <Icon name="cpu" size={11} />
          {providerEntries.map(([name, pct], i) => (
            <span key={name} className={`num${i > 0 ? ' muted' : ''}`}>
              {i > 0 && '· '}{name} {pct}%
            </span>
          ))}
        </div>
      )}

      <div className="status-spacer" />

      <div className="status-right">
        {pendingApprovals > 0 && (
          <button
            type="button"
            className="status-seg"
            onClick={onOpenApprovals}
            title="Open approvals"
          >
            <Icon name="check" size={11} style={{ color: 'var(--clay)' }} />
            <span>
              {pendingApprovals} approval{pendingApprovals === 1 ? '' : 's'} pending
            </span>
          </button>
        )}
        {cursorPos && (
          <div className="status-seg">
            <span className="num">Ln {cursorPos.line}, Col {cursorPos.col}</span>
          </div>
        )}
        {fileEncoding && (
          <div className="status-seg">
            <span>{fileEncoding}</span>
          </div>
        )}
        {fileLanguage && (
          <div className="status-seg">
            <span>{fileLanguage}</span>
          </div>
        )}
      </div>
    </div>
  );
}
