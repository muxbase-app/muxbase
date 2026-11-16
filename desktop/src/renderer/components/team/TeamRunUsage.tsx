import { useEffect, useState } from 'react';
import type { TeamRun } from '../../../shared/team-types';
import { useAgentSessionStore } from '../../stores';
import { isRunLive } from './teamViewModel';

const COMPACT_TOKENS = new Intl.NumberFormat('en', { maximumFractionDigits: 1, notation: 'compact' });
const WHOLE_MINUTES = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const LOG_TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const CLOCK_TICK_MS = 15_000;
const HIGH_USAGE_RATIO = 0.8;
const MINUTE_MS = 60_000;
const TOKEN_TITLE = 'Observed tokens. Reporting can lag; this is a soft limit, not a hard spending cap.';

function formatTokens(value: number): string {
  return COMPACT_TOKENS.format(value);
}

function useLiveNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

function useRunTokens(run: TeamRun): number {
  const sessions = useAgentSessionStore((s) => s.sessions);
  const liveTokens = run.members.reduce((sum, member) => sum + (sessions[member.paneId]?.metrics.totalTokens ?? 0), 0);
  return run.tokenUsage ?? liveTokens;
}

function usageRatio(used: number, limit: number | undefined): number {
  return limit ? Math.min(used / limit, 1) : 0;
}

function UsageBar({ ratio }: Readonly<{ ratio: number }>) {
  return <span aria-hidden="true" className="team-meter-bar"><i style={{ width: `${ratio * 100}%` }} /></span>;
}

export function TeamTokenMeter({ onOpen, run }: Readonly<{ onOpen: () => void; run: TeamRun }>) {
  const tokens = useRunTokens(run);
  const limit = run.limits?.maxTokens;
  const ratio = usageRatio(tokens, limit);
  return (
    <button
      className="team-token-meter"
      data-level={ratio >= HIGH_USAGE_RATIO ? 'high' : 'normal'}
      data-testid="team-tokens"
      onClick={onOpen}
      title={TOKEN_TITLE}
      type="button"
    >
      <span className="team-meter-label">Tokens</span>
      {limit !== undefined && <UsageBar ratio={ratio} />}
      <b>{formatTokens(tokens)}</b>
      {limit !== undefined && <span>/ {formatTokens(limit)}</span>}
    </button>
  );
}

function UsageRow({ format, label, limit, title, used }: Readonly<{
  format: (value: number) => string; label: string; limit?: number; title: string; used: number;
}>) {
  const ratio = usageRatio(used, limit);
  return (
    <div className="team-usage-row" data-level={ratio >= HIGH_USAGE_RATIO ? 'high' : 'normal'} title={title}>
      <span>{label}</span>
      <b>{format(used)}{limit ? ` / ${format(limit)}` : ''}</b>
      {limit !== undefined && <UsageBar ratio={ratio} />}
    </div>
  );
}

export function TeamRunUsage({ run }: Readonly<{ run: TeamRun }>) {
  const live = isRunLive(run);
  const now = useLiveNow(live);
  const tokens = useRunTokens(run);
  const elapsedMinutes = Math.max(0, (live ? now : run.updatedAt) - run.createdAt) / MINUTE_MS;
  const sourceTime = run.usageSourceUpdatedAt === undefined ? undefined : new Date(run.usageSourceUpdatedAt);
  return (
    <div className="team-usage" data-testid="team-usage">
      <UsageRow format={formatTokens} label="Tokens" limit={run.limits?.maxTokens} title={TOKEN_TITLE} used={tokens} />
      <UsageRow
        format={(value) => `${WHOLE_MINUTES.format(Math.floor(value))}m`}
        label="Time"
        limit={run.limits ? run.limits.maxDurationMs / MINUTE_MS : undefined}
        title="Elapsed run time. At the limit, the run pauses for your decision."
        used={elapsedMinutes}
      />
      <small title={sourceTime
        ? `Most recent agent log update: ${sourceTime.toLocaleString()}. Token reports can still lag.`
        : 'Agent log update time is unavailable. Observed token reports can lag; this is not a hard spending cap.'}>
        logs {sourceTime ? <time dateTime={sourceTime.toISOString()}>{LOG_TIME.format(sourceTime)}</time> : 'unknown'}
      </small>
    </div>
  );
}
